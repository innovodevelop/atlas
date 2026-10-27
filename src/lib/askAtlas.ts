/**
 * One question to the brain, for Talk to Atlas.
 *
 * `useUnifiedChat` owns the conversation surface (message list, citations,
 * TTS). The Talk panel needs something smaller: send one line, stream the
 * answer back, and say what state Atlas is in while it happens. Same endpoint
 * (`/chat-with-memory` on the local brain sidecar), same headers, same SSE
 * shape — the reader is shared here so the two cannot drift.
 */
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { parseBrainLine, type BrainCitation } from '@/lib/brainSse';

export interface AskHandlers {
  /** Called with the WHOLE answer so far on every chunk. */
  onText?: (text: string) => void;
  signal?: AbortSignal;
  /** Where the question was asked, for the brain's context. */
  screen?: string;
}

export interface AskResult {
  text: string;
  citations: BrainCitation[];
}

const SESSION_KEY = 'atlas:talk-session';
function sessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = `talk_${Date.now().toString(36)}`;
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return `talk_${Date.now().toString(36)}`;
  }
}

export async function askAtlas(question: string, handlers: AskHandlers = {}): Promise<AskResult> {
  const token = getToken();
  if (!token) throw new Error('Sign in to talk to Atlas.');
  const brain = await getBrainEndpoint();
  if (!brain) throw new Error('Atlas is only here in the desktop app.');

  const response = await fetch(`${brain.baseUrl}/chat-with-memory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-sidecar-token': brain.token,
      'x-session-id': sessionId(),
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      source: handlers.screen ? `talk:${handlers.screen}` : 'talk',
      enableTools: true,
      conversationId: sessionId(),
    }),
    signal: handlers.signal,
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error('Atlas is rate-limited right now. Try again in a moment.');
    if (response.status === 402) throw new Error('Usage limit reached.');
    throw new Error(`Atlas did not answer (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error('Atlas sent an empty reply.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let citations: AskResult['citations'] = [];
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const ev = parseBrainLine(line);
      if (!ev) continue;
      if (ev.kind === 'done') break outer;
      if (ev.kind === 'citations') { citations = ev.citations; continue; }
      text += ev.delta;
      handlers.onText?.(text);
    }
  }
  return { text, citations };
}
