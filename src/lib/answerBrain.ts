/**
 * The Beta Answer and Voice screens' calls to the local brain sidecar beyond
 * the chat itself: the comparison table, the person lookup and the earlier
 * conversations (services/atlas-brain/src/answerShapes.ts, conversations.ts).
 *
 * Same endpoint, headers and tokens as askAtlas.ts. The brain listens on
 * 127.0.0.1 only; of these four, only the comparison reaches a model provider,
 * and it sends just the question and the answer Atlas already gave.
 * Everything a route returns is validated by the caller's parser
 * (betaAnswer.ts, earlierConversations.ts) before it reaches the screen.
 */
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';

async function brainPost(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const token = getToken();
  if (!token) throw new Error('Sign in to talk to Atlas.');
  const brain = await getBrainEndpoint();
  if (!brain) throw new Error('Atlas is only here in the desktop app.');
  const res = await fetch(`${brain.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-sidecar-token': brain.token,
    },
    body: JSON.stringify(body),
    signal,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : '';
    throw new Error(msg || `The brain did not answer (HTTP ${res.status}).`);
  }
  return data;
}

/** The raw comparison object, or null when the brain declined; parse it with `parseComparison`. */
export async function fetchComparison(question: string, answer: string, signal?: AbortSignal): Promise<unknown> {
  const data = await brainPost('/answer/compare', { question, answer }, signal);
  return typeof data === 'object' && data !== null ? (data as { comparison?: unknown }).comparison ?? null : null;
}

/** The raw person card; parse it with `parsePersonCard`. Local SQL only. */
export function fetchPerson(name: string, signal?: AbortSignal): Promise<unknown> {
  return brainPost('/answer/person', { name }, signal);
}

/** Parse with `parseConversationList`. */
export function fetchConversations(limit = 12): Promise<unknown> {
  return brainPost('/conversations/list', { limit });
}

/** Parse with `parseConversation`. */
export function fetchConversation(id: string): Promise<unknown> {
  return brainPost('/conversations/get', { id });
}
