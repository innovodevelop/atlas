import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Message, Citation, AIState } from '@/types';
import { CARD_KEYWORDS } from '@/types';

const CHAT_WITH_MEMORY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat-with-memory`;
const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`;

// Response cache for repeated queries
const responseCache = new Map<string, { response: string; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface UseUnifiedChatOptions {
  /** Whether to use the chat-with-memory backend function */
  enableMemory?: boolean;
  /** Whether to cache responses for repeated queries */
  enableCaching?: boolean;
  /** Callback when cards should be focused based on message content */
  onCardFocus?: (cardIds: string[] | null) => void;
  /** Source identifier for analytics */
  source?: 'text_chat' | 'voice_chat';
  /** Callback to speak the response (for voice mode) */
  onSpeakResponse?: (text: string) => void;
  /**
   * Low-latency voice: called with each COMPLETED sentence while the LLM is
   * still streaming, so TTS can start after the first sentence. When set,
   * onSpeakResponse is NOT called at the end (the text was already spoken).
   */
  onSpeakSentence?: (sentence: string) => void;
}

// Sentence chunking for streaming TTS: split on sentence-ending punctuation
// followed by whitespace, but don't emit tiny fragments (choppy audio).
const MIN_SPOKEN_CHUNK = 40;

const splitCompletedSentences = (buffer: string): { sentences: string[]; rest: string } => {
  const sentences: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = rest.match(/[.!?…][)"'”’]*\s/);
    if (!match || match.index === undefined) break;
    const end = match.index + match[0].length;
    const candidate = rest.slice(0, end);
    if (candidate.trim().length < MIN_SPOKEN_CHUNK) {
      // Too short on its own — try to extend to the next boundary
      const next = rest.slice(end).match(/[.!?…][)"'”’]*\s/);
      if (!next || next.index === undefined) break;
      const extendedEnd = end + next.index + next[0].length;
      sentences.push(rest.slice(0, extendedEnd));
      rest = rest.slice(extendedEnd);
    } else {
      sentences.push(candidate);
      rest = rest.slice(end);
    }
  }
  return { sentences, rest };
};

// Markdown reads badly aloud — strip the common syntax before speaking
const stripForSpeech = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/[*_#`>]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s{2,}/g, " ");

/** Extract URLs from text and convert to citations */
const extractUrlsAsCitations = (text: string): Citation[] => {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  const matches = text.match(urlRegex) || [];
  const uniqueUrls = [...new Set(matches)];
  
  return uniqueUrls.map(url => ({
    url,
    domain: (() => {
      try {
        return new URL(url).hostname.replace('www.', '');
      } catch {
        return url;
      }
    })()
  }));
};

export const useUnifiedChat = ({
  enableMemory = true,
  enableCaching = false,
  onCardFocus,
  source = 'text_chat',
  onSpeakResponse,
  onSpeakSentence,
}: UseUnifiedChatOptions = {}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [aiState, setAiState] = useState<AIState>('idle');
  const [isLoading, setIsLoading] = useState(false);
  const [lastResponse, setLastResponse] = useState<string>('');

  // Refs for values that don't need to trigger re-renders
  const abortControllerRef = useRef<AbortController | null>(null);
  const messageBufferRef = useRef<string>('');
  // Stable id for this conversation — the backend scopes learning/research
  // sessions to it. Reset when the chat is cleared.
  const conversationIdRef = useRef<string>(crypto.randomUUID());

  // Abort any in-flight SSE stream on unmount — otherwise navigating away
  // mid-response leaves the streamed body buffered in the Networking process.
  useEffect(() => () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  // Detect multiple card focuses from message content
  const detectCardFocus = useCallback((content: string) => {
    if (!onCardFocus) return;
    
    const lowerContent = content.toLowerCase();
    const matchedCards: string[] = [];

    Object.entries(CARD_KEYWORDS).forEach(([cardId, keywords]) => {
      if (keywords.some(keyword => lowerContent.includes(keyword))) {
        matchedCards.push(cardId);
      }
    });

    if (matchedCards.length > 0) {
      onCardFocus(matchedCards);
    }
  }, [onCardFocus]);

  const sendMessage = useCallback(async (content: string): Promise<string | null> => {
    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    messageBufferRef.current = '';

    // Check cache if enabled
    if (enableCaching) {
      const cacheKey = content.toLowerCase().trim();
      const cached = responseCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        const userMessage: Message = {
          id: `user-${Date.now()}`,
          role: 'user',
          content,
          timestamp: new Date(),
        };
        
        setMessages((prev) => [
          ...prev,
          userMessage,
          {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: cached.response,
            timestamp: new Date(),
          },
        ]);
        
        if (onSpeakSentence) {
          onSpeakSentence(stripForSpeech(cached.response).trim());
        } else {
          onSpeakResponse?.(cached.response);
        }
        return cached.response;
      }
    }

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setAiState('thinking');
    setIsLoading(true);

    // Detect relevant cards
    detectCardFocus(content);

    let assistantContent = '';
    let collectedCitations: Citation[] = [];

    const updateAssistantMessage = (chunk: string, citations?: Citation[]) => {
      assistantContent += chunk;
      messageBufferRef.current = assistantContent;
      
      // Extract URLs from content as fallback citations
      const extractedCitations = extractUrlsAsCitations(assistantContent);
      const allCitations = citations?.length ? citations : extractedCitations;
      
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return prev.map((m, i) =>
            i === prev.length - 1 
              ? { ...m, content: assistantContent, citations: allCitations.length > 0 ? allCitations : undefined } 
              : m
          );
        }
        return [
          ...prev,
          {
            id: `assistant-${Date.now()}`,
            role: 'assistant' as const,
            content: assistantContent,
            timestamp: new Date(),
            citations: allCitations.length > 0 ? allCitations : undefined,
          },
        ];
      });
    };

    try {
      // Get URL based on memory mode
      const url = enableMemory ? CHAT_WITH_MEMORY_URL : CHAT_URL;
      
      // WS-A: identity travels in the JWT, never in the body. Raw fetch is
      // kept (functions.invoke can't stream SSE) with the session token.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Not authenticated');
      }

      const chatMessages = [...messages, userMessage].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const body = enableMemory
        ? { messages: chatMessages, source, enableTools: true, conversationId: conversationIdRef.current }
        : { messages: chatMessages };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify(body),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        if (response.status === 429) {
          toast.error('Rate limit exceeded. Please try again later.');
          throw new Error('Rate limit exceeded');
        }
        if (response.status === 402) {
          toast.error('Usage limit reached. Please add credits.');
          throw new Error('Payment required');
        }
        throw new Error('Failed to get response');
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      setAiState('speaking');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Buffer of not-yet-spoken text for sentence-streamed TTS
      let speechBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.startsWith(':') || line.trim() === '') continue;
          if (!line.startsWith('data: ')) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') break;

          try {
            const parsed = JSON.parse(jsonStr);
            
            // Handle custom citations event (sent first by backend)
            if (parsed.citations) {
              collectedCitations = parsed.citations.map((c: string | Citation) => 
                typeof c === 'string' ? { url: c } : c
              );
              continue;
            }
            
            // Handle regular content
            const chunkContent = parsed.choices?.[0]?.delta?.content;
            if (chunkContent) {
              updateAssistantMessage(chunkContent, collectedCitations);

              // Emit completed sentences to TTS while still streaming
              if (onSpeakSentence) {
                speechBuffer += chunkContent;
                const { sentences, rest } = splitCompletedSentences(speechBuffer);
                speechBuffer = rest;
                for (const sentence of sentences) {
                  const spoken = stripForSpeech(sentence).trim();
                  if (spoken) onSpeakSentence(spoken);
                }
              }
            }
          } catch {
            // Put incomplete JSON back in buffer
            buffer = line + '\n' + buffer;
            break;
          }
        }
      }

      // Final update with extracted citations if no explicit citations received
      if (collectedCitations.length === 0 && assistantContent) {
        const extractedCitations = extractUrlsAsCitations(assistantContent);
        if (extractedCitations.length > 0) {
          setMessages((prev) => {
            const lastIdx = prev.length - 1;
            if (prev[lastIdx]?.role === 'assistant') {
              return prev.map((m, i) =>
                i === lastIdx ? { ...m, citations: extractedCitations } : m
              );
            }
            return prev;
          });
        }
      }

      // Clear card focus after response
      if (onCardFocus) {
        setTimeout(() => onCardFocus(null), 3000);
      }

      // Cache successful response if enabled
      if (enableCaching && assistantContent) {
        const cacheKey = content.toLowerCase().trim();
        responseCache.set(cacheKey, {
          response: assistantContent,
          timestamp: Date.now(),
        });
      }

      // Store the last response
      setLastResponse(assistantContent);

      // Speak: flush the tail of the sentence buffer (streamed mode), or the
      // whole response at once (legacy mode)
      if (onSpeakSentence) {
        const tail = stripForSpeech(speechBuffer).trim();
        if (tail) onSpeakSentence(tail);
      } else if (onSpeakResponse && assistantContent) {
        onSpeakResponse(assistantContent);
      }

      // Return content or a fallback
      if (assistantContent && assistantContent.trim()) {
        return assistantContent;
      }
      
      return 'I\'m sorry, I couldn\'t process that request. Please try again.';
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return null;
      }
      
      console.error('[UnifiedChat] Error:', error);
      toast.error('Failed to get response. Please try again.');
      setMessages((prev) => {
        if (prev[prev.length - 1]?.role === 'assistant' && !prev[prev.length - 1]?.content) {
          return prev.slice(0, -1);
        }
        return prev;
      });
      onCardFocus?.(null);
      return null;
    } finally {
      setAiState('idle');
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  }, [messages, detectCardFocus, onCardFocus, source, enableMemory, enableCaching, onSpeakResponse, onSpeakSentence]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    messageBufferRef.current = '';
    conversationIdRef.current = crypto.randomUUID();
  }, []);

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  return {
    messages,
    aiState,
    setAiState,
    isLoading,
    sendMessage,
    clearMessages,
    lastResponse,
    cancel,
  };
};
