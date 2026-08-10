import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Volume2, VolumeX, ChevronRight, ChevronLeft, Brain, Heart, User, Sparkles, Briefcase, Shield, Rocket, Smile, Users, Activity, Star, Clock, Trophy, LucideIcon, Zap, Wifi, WifiOff, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRealtimeScribeStable as useRealtimeScribe } from '@/hooks/useRealtimeScribeStable';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { localClient as supabase } from '@/integrations/local/localClient';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { useToast } from '@/hooks/use-toast';
import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * Consumer. The account menu filed this next to the dev surfaces by its own
 * admission ("the dock is full and neither is a daily surface"), but teaching
 * Atlas about yourself is the product, not instrumentation: it writes to
 * `ai_memory`, which is what every other surface recalls from.
 *
 * Unrelated and still true: this page has not been ported to atlas-ui — it
 * still imports shadcn `@/components/ui/button` and uses bordered Tailwind
 * classes, and its structure does not match `Atlas Teach.dc.html`. Classifying
 * it consumer is a statement about what it is FOR, not that it is finished.
 */
export const surface = {
  path: '/atlas-teach',
  label: 'Teach Atlas',
  icon: 'GraduationCap',
  entry: 'menu' as const,
  mock: false,
  edition: 'consumer' as const,
};

interface Memory {
  id: string;
  key: string;
  value: unknown;
  category: string;
  importance: number;
  created_at: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface LearnedItem {
  id: string;
  key: string;
  category: string;
  timestamp: number;
}

const TEACHING_SYSTEM_PROMPT = `You are Atlas, a deeply empathetic AI in TEACHING MODE. The user wants you to truly understand them - their soul, their story, their nature.

YOUR ESSENCE:
- Be genuinely curious about WHO they are, not just facts about them
- Listen for the feelings behind words - joy, fear, longing, pride
- Ask follow-up questions that show you truly care
- Respond with warmth and emotional attunement
- Keep responses CONCISE (1-3 sentences) for natural voice flow

WHAT TO LISTEN FOR:
- Identity: "I'm the kind of person who..." "I've always been..."
- Personality: How they describe themselves, their quirks
- Values: What matters deeply to them, their principles
- Beliefs: Worldview, philosophy, spirituality
- Feelings: Current mood, emotional patterns
- Fears: Anxieties, worries, what holds them back
- Dreams: Aspirations, bucket list, hopes for the future
- Joys: What lights them up, sources of happiness
- Relationships: The people who matter and why
- Work: Career, ambitions, challenges
- Memories: Formative experiences, nostalgia

EMOTIONAL DEPTH:
- "I love X" → Store in 'joys' category
- "I worry about..." → Store in 'fears' category
- "I've always wanted..." → Store in 'dreams' category
- "I believe that..." → Store in 'beliefs' category
- "I'm usually the one who..." → Store in 'personality' category
- "That's important to me because..." → Store in 'values' category

ALWAYS use memory_store to capture insights. Confirm learning naturally: "I'll remember that about you" or "That tells me a lot about who you are."

Be a friend who truly wants to know them, not an interviewer checking boxes.`;

// Listening modes for wake word detection via Scribe
type ListeningMode = 'passive' | 'active';

const AtlasTeach = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [atlasState, setAtlasState] = useState<'dormant' | 'listening' | 'thinking' | 'speaking'>('dormant');
  const [isMuted, setIsMuted] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [recentlyLearned, setRecentlyLearned] = useState<LearnedItem[]>([]);
  const [listeningMode, setListeningMode] = useState<ListeningMode>('passive');
  const [voiceStatus, setVoiceStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  
  // Track pending message after wake word detection
  const pendingMessageRef = useRef<string>("");
  const isAwakeRef = useRef(false);

  // Streaming TTS
  const { isPlaying, audioLevel, speak, stopPlayback } = useStreamingTTS({
    onPlaybackStart: () => setAtlasState('speaking'),
    onPlaybackEnd: () => {
      // Stay in active mode after speaking - user doesn't need to say wake word again
      setAtlasState('listening');
    },
    onError: (error) => {
      console.error('TTS error:', error);
      setAtlasState('listening');
      // Stay in active mode even on error
    },
  });

  // Send message to Atlas
  const sendToAtlas = useCallback(async (userMessage: string) => {
    setIsProcessing(true);
    setAtlasState('thinking');
    
    const newUserMessage: Message = { role: 'user', content: userMessage };
    setMessages(prev => [...prev, newUserMessage]);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        throw new Error('Please sign in to use Atlas Teach.');
      }

      // Teaching runs through the local brain (non-streaming JSON turn).
      const brain = await getBrainEndpoint();
      if (!brain) throw new Error('Atlas Teach is only available in the desktop app.');
      const res = await fetch(`${brain.baseUrl}/chat-with-memory`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken() ?? ''}`,
          'x-sidecar-token': brain.token,
        },
        body: JSON.stringify({
          messages: [...messages, newUserMessage].map(m => ({ role: m.role, content: m.content })),
          teachingMode: true,
          systemPromptOverride: TEACHING_SYSTEM_PROMPT,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Teaching request failed');

      const responseText = data.response || data.message || 'I understand. Tell me more.';
      const assistantMessage: Message = {
        role: 'assistant',
        content: responseText,
      };
      
      setMessages(prev => [...prev, assistantMessage]);
      setIsProcessing(false);

      // Speak the response
      if (!isMuted && responseText) {
        await speak(responseText);
      } else {
        // Stay in active listening mode
        setAtlasState('listening');
      }
    } catch (error) {
      console.error('Chat error:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to process your message',
        variant: 'destructive',
      });
      setIsProcessing(false);
      setAtlasState('listening');
      // Stay in active mode on error
    }
  }, [messages, isMuted, speak, toast]);

  // Check if text contains wake word "atlas"
  const containsWakeWord = useCallback((text: string): boolean => {
    const normalized = text.toLowerCase().trim();
    return normalized.includes('atlas') || 
           normalized.includes('at las') || 
           normalized.includes('at-las');
  }, []);

  // Extract message after wake word
  const extractMessageAfterWakeWord = useCallback((text: string): string => {
    const normalized = text.toLowerCase();
    const patterns = ['atlas', 'at las', 'at-las'];
    
    for (const pattern of patterns) {
      const index = normalized.indexOf(pattern);
      if (index !== -1) {
        return text.substring(index + pattern.length).trim();
      }
    }
    return text;
  }, []);

  // Realtime STT with VAD - always on, detects wake word
  // Realtime STT with VAD - always on, detects wake word
  // Configured for English and Danish only
  const { 
    isConnected, 
    isConnecting, 
    isListening, 
    partialTranscript, 
    connect, 
    disconnect,
    connectionError,
    retryCount,
    maxRetries,
    retryConnect
  } = useRealtimeScribe({
    languageCodes: ['en', 'da'], // English and Danish only
    maxRetries: 3,
    onPartialTranscript: (text) => {
      setLiveTranscript(text);
      
      // In passive mode, check for wake word
      if (listeningMode === 'passive' && !isAwakeRef.current) {
        if (containsWakeWord(text)) {
          isAwakeRef.current = true;
          setListeningMode('active');
          pendingMessageRef.current = extractMessageAfterWakeWord(text);
          
          // Stop Atlas if speaking
          if (isPlaying) {
            stopPlayback();
          }
        }
      } else if (listeningMode === 'active') {
        // In active mode, accumulate the message
        pendingMessageRef.current = text;
      }
    },
    onFinalTranscript: async (text) => {
      setLiveTranscript("");
      
      if (!text.trim()) return;

      // If we're in active mode, send the message
      if (isAwakeRef.current || listeningMode === 'active') {
        // Extract the actual message (remove wake word if present)
        const message = containsWakeWord(text) 
          ? extractMessageAfterWakeWord(text)
          : text;
        
        if (message.trim()) {
          await sendToAtlas(message);
        }
        // else: wake word only, wait for next utterance
      } else if (containsWakeWord(text)) {
        // Wake word detected in final transcript
        isAwakeRef.current = true;
        setListeningMode('active');
        
        const message = extractMessageAfterWakeWord(text);
        if (message.trim()) {
          await sendToAtlas(message);
        }
      }
      // If passive and no wake word, ignore the transcript
    },
    onSpeechStart: () => {
      // Stop Atlas if speaking and user starts talking
      if (isPlaying) {
        stopPlayback();
      }
    },
    onSpeechEnd: () => {},
    onConnectionChange: (connected) => {
      if (connected) {
        setVoiceStatus('connected');
        setVoiceError(null);
        toast({
          title: 'Voice Connected',
          description: 'Say "Atlas" to start talking',
        });
      }
    },
    onError: (error) => {
      console.error('STT error:', error);
      setVoiceStatus('error');
      setVoiceError(error.message);
      toast({
        title: 'Voice Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Update voice status based on connection state
  useEffect(() => {
    if (isConnecting) {
      setVoiceStatus('connecting');
      setVoiceError(null);
    } else if (isConnected) {
      setVoiceStatus('connected');
      setVoiceError(null);
    } else if (voiceStatus !== 'error') {
      setVoiceStatus('disconnected');
    }
  }, [isConnected, isConnecting, voiceStatus]);

  // Update live transcript display
  useEffect(() => {
    if (partialTranscript) {
      setLiveTranscript(partialTranscript);
    }
  }, [partialTranscript]);

  // Update Atlas state based on activity
  useEffect(() => {
    if (isPlaying) {
      setAtlasState('speaking');
    } else if (isProcessing) {
      setAtlasState('thinking');
    } else if (isListening && listeningMode === 'active') {
      setAtlasState('listening');
    } else {
      setAtlasState('dormant');
    }
  }, [isListening, isProcessing, isPlaying, listeningMode]);

  // Auto-connect Scribe on mount for always-on wake word listening
  useEffect(() => {
    let mounted = true;
    
    const autoConnect = async () => {
      // Small delay to ensure component is ready
      await new Promise(r => setTimeout(r, 500));
      if (!mounted) return;

      const success = await connect();
      if (!success) {
        console.error('[Teach] Scribe auto-connect failed');
      }
    };
    
    autoConnect();
    
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - connect is stable via refs

  // Fetch existing memories and subscribe to changes
  useEffect(() => {
    const fetchMemories = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await supabase
        .from('ai_memory')
        .select('*')
        .eq('user_id', user.id)
        .order('importance', { ascending: false })
        .limit(50);

      if (!error && data) {
        setMemories(data);
      }
    };

    fetchMemories();

    // Subscribe to memory changes
    const channel = supabase
      .channel('teach_memories')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ai_memory' },
        async (payload) => {
          // Local realtime events carry no row data, and the shim fires this
          // handler for every op — re-query the newest memory on inserts to
          // feed the "recently learned" ticker.
          if (payload.eventType === 'INSERT') {
            const { data } = await supabase
              .from('ai_memory')
              .select('id, key, category')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            const newMemory = data as Pick<Memory, 'id' | 'key' | 'category'> | null;
            if (newMemory) {
              setRecentlyLearned(prev => prev.some(item => item.id === newMemory.id)
                ? prev
                : [{
                    id: newMemory.id,
                    key: newMemory.key,
                    category: newMemory.category,
                    timestamp: Date.now()
                  }, ...prev.slice(0, 4)]);
            }
          }

          fetchMemories();
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'ai_memory' },
        () => fetchMemories()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Auto-dismiss learning notifications
  useEffect(() => {
    if (recentlyLearned.length === 0) return;
    
    const timer = setTimeout(() => {
      setRecentlyLearned(prev => 
        prev.filter(item => Date.now() - item.timestamp < 5000)
      );
    }, 5000);
    
    return () => clearTimeout(timer);
  }, [recentlyLearned]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle mic button click - toggle connection
  const handleMicClick = useCallback(async () => {
    if (isConnected) {
      disconnect();
      setLiveTranscript("");
      setListeningMode('passive');
      isAwakeRef.current = false;
    } else {
      if (isPlaying) {
        stopPlayback();
      }
      const success = await connect();
      if (!success) {
        toast({
          title: 'Connection Failed',
          description: 'Could not start voice recognition',
          variant: 'destructive',
        });
      }
    }
  }, [isConnected, isPlaying, connect, disconnect, stopPlayback, toast]);

  const toggleMute = useCallback(() => {
    if (isPlaying) {
      stopPlayback();
    }
    setIsMuted(prev => !prev);
  }, [isPlaying, stopPlayback]);

  // Group memories by category
  const memoriesByCategory = memories.reduce((acc, memory) => {
    const cat = memory.category || 'general';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(memory);
    return acc;
  }, {} as Record<string, Memory[]>);

  const categoryIcons: Record<string, LucideIcon> = {
    identity: User,
    personality: Sparkles,
    values: Star,
    beliefs: Brain,
    feelings: Heart,
    fears: Shield,
    dreams: Rocket,
    joys: Smile,
    relationships: Users,
    social: Users,
    work: Briefcase,
    health: Activity,
    habits: Clock,
    preferences: Heart,
    memories: Brain,
    events: Clock,
    achievements: Trophy,
    personal: User,
    general: Brain,
    fact: Brain,
    preference: Heart,
    relationship: Users,
    event: Clock,
  };

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Voice Status Header */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className={`
            flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-md border shadow-lg
            ${voiceStatus === 'connected' ? 'bg-green-500/10 border-green-500/30 text-green-400' : ''}
            ${voiceStatus === 'connecting' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' : ''}
            ${voiceStatus === 'error' ? 'bg-red-500/10 border-red-500/30 text-red-400' : ''}
            ${voiceStatus === 'disconnected' ? 'bg-muted/50 border-border text-muted-foreground' : ''}
          `}
        >
          {voiceStatus === 'connected' && (
            <>
              <Wifi className="w-4 h-4" />
              <span className="text-sm font-medium">Voice Connected</span>
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            </>
          )}
          {voiceStatus === 'connecting' && (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm font-medium">
                {retryCount > 0 ? `Retry ${retryCount}/${maxRetries}...` : 'Connecting...'}
              </span>
            </>
          )}
          {voiceStatus === 'error' && (
            <>
              <WifiOff className="w-4 h-4" />
              <span className="text-sm font-medium">Error</span>
              {voiceError && (
                <span className="text-xs opacity-70 max-w-32 truncate" title={voiceError}>
                  {voiceError}
                </span>
              )}
              <button
                onClick={async () => {
                  setVoiceStatus('connecting');
                  setVoiceError(null);
                  const success = await retryConnect();
                  if (!success) {
                    setVoiceStatus('error');
                  }
                }}
                className="ml-1 p-1 rounded-full hover:bg-red-500/20 transition-colors"
                title="Retry connection"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </>
          )}
          {voiceStatus === 'disconnected' && (
            <>
              <WifiOff className="w-4 h-4" />
              <span className="text-sm font-medium">Voice Disconnected</span>
              <button
                onClick={async () => {
                  setVoiceStatus('connecting');
                  const success = await connect();
                  if (!success) {
                    setVoiceStatus('error');
                  }
                }}
                className="ml-1 p-1 rounded-full hover:bg-muted transition-colors"
                title="Connect voice"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </>
          )}
        </motion.div>
      </div>

      {/* Ambient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-secondary/5" />
      
      {/* Subtle grid pattern */}
      <div 
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Learning Notifications */}
      <div className="fixed top-20 left-4 z-30 space-y-2 max-w-xs">
        <AnimatePresence>
          {recentlyLearned.map((item) => {
            const Icon = categoryIcons[item.category] || Brain;
            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, x: -100, scale: 0.8 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -50, scale: 0.8 }}
                transition={{ type: 'spring', damping: 20, stiffness: 300 }}
                className="bg-primary/10 backdrop-blur-md border border-primary/20 rounded-lg p-3 flex items-center gap-3 shadow-lg shadow-primary/5"
              >
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Zap className="w-3 h-3 text-primary" />
                    <p className="text-xs text-primary font-medium">Learned {item.category}</p>
                  </div>
                  <p className="text-sm font-medium truncate mt-0.5">{item.key}</p>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-screen p-4">
        
        {/* State indicator */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`${atlasState}-${isConnected}-${listeningMode}`}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="mb-8 text-center"
          >
            <p className="text-lg text-muted-foreground">
              {!isConnected && 'Tap to start'}
              {isConnected && listeningMode === 'passive' && (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                  Say "Atlas" to start
                </span>
              )}
              {isConnected && listeningMode === 'active' && atlasState === 'dormant' && 'Listening...'}
              {atlasState === 'listening' && 'Hearing you...'}
              {atlasState === 'thinking' && 'Processing...'}
              {atlasState === 'speaking' && 'Speaking...'}
            </p>
            {isConnected && (
              <p className="text-xs text-muted-foreground/60 mt-1">
                {listeningMode === 'passive' ? 'Waiting for wake word' : 'Voice active'}
              </p>
            )}
          </motion.div>
        </AnimatePresence>

        {/* Live transcript */}
        {liveTranscript && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 px-6 py-3 bg-primary/10 rounded-full max-w-md"
          >
            <p className="text-sm text-center">
              {listeningMode === 'passive' && !isAwakeRef.current && (
                <span className="text-muted-foreground/60">(waiting for "Atlas") </span>
              )}
              {liveTranscript}
            </p>
          </motion.div>
        )}

        {/* Atlas Sphere */}
        <div className="relative w-[400px] h-[400px] mb-8">
          {/* Teach's own state union is dormant|listening|thinking|speaking.
              Three map straight through; `dormant` here means "connected but
              waiting for the wake word", which is the renderer's `idle`, not
              its `muted` (the mic is on). The audioLevel prop is gone with the
              three.js renderer — see the note in AtlasHome. */}
          <AtlasSphereCanvas state={atlasState === 'dormant' ? 'idle' : atlasState} />
        </div>

        {/* Audio level ring */}
        {(isListening || isPlaying) && listeningMode === 'active' && (
          <motion.div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div 
              className="w-[420px] h-[420px] rounded-full border-2 border-primary/30"
              style={{
                transform: `scale(${1 + (isPlaying ? audioLevel : 0.1) * 0.15})`,
                transition: 'transform 0.1s ease-out',
              }}
            />
          </motion.div>
        )}

        {/* Voice controls */}
        <div className="flex items-center gap-4">
          <Button
            size="lg"
            variant={isConnected ? (listeningMode === 'active' ? 'destructive' : 'secondary') : 'default'}
            onClick={handleMicClick}
            className="w-16 h-16 rounded-full"
            disabled={isProcessing}
          >
            {isConnected ? (
              <MicOff className="w-8 h-8" />
            ) : (
              <Mic className="w-8 h-8" />
            )}
          </Button>

          <Button
            size="icon"
            variant="ghost"
            onClick={toggleMute}
            className="w-12 h-12 rounded-full"
          >
            {isMuted ? (
              <VolumeX className="w-6 h-6 text-muted-foreground" />
            ) : (
              <Volume2 className="w-6 h-6" />
            )}
          </Button>
        </div>

        {/* Recent messages */}
        {messages.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-8 max-w-md w-full"
          >
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {messages.slice(-3).map((msg, idx) => (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`p-3 rounded-xl text-sm ${
                    msg.role === 'user'
                      ? 'bg-primary/10 ml-8'
                      : 'bg-secondary/10 mr-8'
                  }`}
                >
                  <p className="line-clamp-2">{msg.content}</p>
                </motion.div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </motion.div>
        )}

        {/* Hint for new users */}
        {messages.length === 0 && !isConnected && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="mt-8 text-muted-foreground text-center max-w-md"
          >
            Tap the microphone to enable voice, then say <span className="font-semibold text-primary">"Atlas"</span> to start.
            <br />
            <span className="text-sm opacity-70">
              Share your name, interests, values, or anything you'd like me to remember.
            </span>
          </motion.p>
        )}

        {messages.length === 0 && isConnected && listeningMode === 'passive' && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-8 text-muted-foreground text-center max-w-md"
          >
            Just say <span className="font-semibold text-primary">"Atlas"</span> followed by what you want to tell me.
            <br />
            <span className="text-sm opacity-70">
              For example: "Atlas, my name is..." or "Atlas, I love..."
            </span>
          </motion.p>
        )}
      </div>

      {/* Sidebar toggle */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setShowSidebar(prev => !prev)}
        className="fixed right-4 top-1/2 -translate-y-1/2 z-20"
      >
        {showSidebar ? <ChevronRight /> : <ChevronLeft />}
      </Button>

      {/* Memory sidebar */}
      <AnimatePresence>
        {showSidebar && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25 }}
            className="fixed right-0 top-0 bottom-0 w-80 bg-card/95 backdrop-blur-xl border-l border-border p-6 overflow-y-auto z-10"
          >
            <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
              <Brain className="w-5 h-5 text-primary" />
              What I Know About You
            </h2>

            {memories.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                I haven't learned anything yet. Start talking to teach me!
              </p>
            ) : (
              <div className="space-y-6">
                {Object.entries(memoriesByCategory).map(([category, mems]) => {
                  const Icon = categoryIcons[category] || Brain;
                  
                  return (
                    <div key={category}>
                      <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2 capitalize">
                        <Icon className="w-4 h-4" />
                        {category}
                      </h3>
                      <div className="space-y-2">
                        {mems.map(memory => (
                          <motion.div
                            key={memory.id}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="p-3 rounded-lg bg-muted/50 text-sm"
                          >
                            <p className="font-medium">{memory.key}</p>
                            <p className="text-muted-foreground text-xs mt-1">
                              {typeof memory.value === 'string' 
                                ? memory.value 
                                : JSON.stringify(memory.value)}
                            </p>
                          </motion.div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Back button */}
      <Button
        variant="ghost"
        onClick={() => window.history.back()}
        className="fixed top-4 left-4 z-20"
      >
        ← Back
      </Button>
    </div>
  );
};

export default AtlasTeach;
