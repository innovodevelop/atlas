/**
 * The Browser's three calls to the local brain (services/atlas-brain/src/
 * browserRoutes.ts): fetch a page on this Mac, ask about it, and ask what is
 * worth noticing on it. Same endpoint, token and sidecar header as every other
 * brain call (askAtlas.ts, useAtlasMail's brainPost).
 *
 * Every call resolves to a result the screen can show — never a throw — so
 * the page has one place to turn a failure into a sentence.
 */
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { parseCopy, parseNotes, type PageCopy, type PageNotes } from './betaBrowser';

export type Failure = { ok: false; reason: string | null; message: string };
type Result<T> = ({ ok: true } & T) | Failure;

/** Narrows a result to its failure (the app's tsconfig is not strict, so `!r.ok` alone does not). */
export function failed<T>(r: Result<T>): r is Failure {
  return r.ok === false;
}

const NO_APP = 'The Browser works through Atlas on this Mac, which only runs in the desktop app.';
const NO_SIGN_IN = 'Sign in to Atlas to use the Browser.';

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; data: Record<string, unknown> } | Failure> {
  const token = getToken();
  if (!token) return { ok: false, reason: 'signed-out', message: NO_SIGN_IN };
  const brain = await getBrainEndpoint();
  if (!brain) return { ok: false, reason: 'no-brain', message: NO_APP };
  let res: Response;
  try {
    res = await fetch(`${brain.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-sidecar-token': brain.token },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return { ok: false, reason: 'aborted', message: 'Stopped.' };
    return { ok: false, reason: 'no-brain', message: `Atlas on this Mac didn’t answer (${e instanceof Error ? e.message : 'no connection'}).` };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'signed-out', message: NO_SIGN_IN };
  return { status: res.status, data };
}

const text = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);

/** POST /browser/fetch — the page as reader copy, or the guard's refusal. */
export async function fetchPageCopy(url: string, signal?: AbortSignal): Promise<Result<{ page: PageCopy }>> {
  const r = await post('/browser/fetch', { url }, signal);
  if ('ok' in r) return r;
  if (r.data.ok === true) {
    const page = parseCopy(r.data.page);
    if (page) return { ok: true, page };
    return { ok: false, reason: 'unreadable', message: 'Atlas fetched the page but couldn’t read what came back.' };
  }
  return {
    ok: false,
    reason: typeof r.data.reason === 'string' ? r.data.reason : null,
    message: text(r.data.message ?? r.data.error, `Atlas couldn’t fetch the page (HTTP ${r.status}).`),
  };
}

export interface PageQuestion {
  url: string;
  title: string;
  text: string;
}

/** POST /browser/ask — one answer from the page's text. */
export async function askAboutPage(page: PageQuestion, question: string, signal?: AbortSignal): Promise<Result<{ answer: string; provider: string | null; partial: boolean }>> {
  const r = await post('/browser/ask', { ...page, question }, signal);
  if ('ok' in r) return r;
  if (r.status === 200 && typeof r.data.answer === 'string') {
    return { ok: true, answer: r.data.answer, provider: typeof r.data.provider === 'string' ? r.data.provider : null, partial: r.data.partial === true };
  }
  return { ok: false, reason: typeof r.data.reason === 'string' ? r.data.reason : null, message: text(r.data.error, `Atlas didn’t answer (HTTP ${r.status}).`) };
}

/** POST /browser/notice — what is worth noticing on the page. */
export async function noticeOnPage(page: PageQuestion, now: Date, signal?: AbortSignal): Promise<Result<{ notes: PageNotes }>> {
  const r = await post('/browser/notice', page, signal);
  if ('ok' in r) return r;
  if (r.status === 200) {
    const notes = parseNotes({ ...r.data, at: now.toISOString() });
    if (notes) return { ok: true, notes };
    return { ok: false, reason: 'empty', message: 'Atlas read the page and found nothing it could stand behind.' };
  }
  return { ok: false, reason: typeof r.data.reason === 'string' ? r.data.reason : null, message: text(r.data.error, `Atlas didn’t answer (HTTP ${r.status}).`) };
}
