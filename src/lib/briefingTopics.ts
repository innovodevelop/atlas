/**
 * The Briefing's topics — what the user wants the headlines to be about
 * (Beta row 8). Chosen on the Briefing screen, kept on this Mac in local
 * storage 'atlas:briefing_topics', read by `useNews` everywhere it fetches.
 *
 * What the provider supports decides the shape. NewsAPI's `top-headlines`
 * takes one of seven categories, or a keyword query, per request — not a
 * list — so each topic is its own request (src-tauri/src/datafetch.rs
 * `fetch_topics`), merged round-robin. A topic is therefore either one of the
 * seven categories or a short keyword, at most four of them, and the poll
 * stretches its interval by the number of topics so the key's daily quota is
 * spent at the rate a single topic always spent it.
 *
 * What leaves the Mac: the topics themselves, sent to NewsAPI with the key.
 */
import { useSyncExternalStore } from 'react';

export const NEWS_CATEGORIES = ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];
export const MAX_TOPICS = 4;
export const TOPICS_KEY = 'atlas:briefing_topics';

/** The categories as the screen names them. */
export const CATEGORY_LABEL: Record<NewsCategory, string> = {
  business: 'Business', entertainment: 'Entertainment', general: 'General', health: 'Health',
  science: 'Science', sports: 'Sports', technology: 'Technology',
};

export const isCategory = (t: string): t is NewsCategory => (NEWS_CATEGORIES as readonly string[]).includes(t.toLowerCase());

/**
 * A topic as the Rust side accepts it (`parse_topic`): a category, or a
 * keyword of 2–40 letters, digits, spaces and - & . '. Returns the topic in
 * its stored spelling (categories lower-case), or null.
 */
export function normalizeTopic(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (isCategory(t)) return t.toLowerCase();
  const n = [...t].length;
  return n >= 2 && n <= 40 && /^[\p{L}\p{N} &.'-]+$/u.test(t) ? t : null;
}

/** The label a topic carries on a headline and a chip. */
export function topicLabel(t: string): string {
  return isCategory(t) ? CATEGORY_LABEL[t.toLowerCase() as NewsCategory] : t;
}

export function parseTopics(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const t of v) {
      const n = typeof t === 'string' ? normalizeTopic(t) : null;
      if (n && !out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
    }
    return out.slice(0, MAX_TOPICS);
  } catch {
    return [];
  }
}

export type TopicCheck = { ok: true; topic: string } | { ok: false; reason: string };

export function checkTopic(raw: string, topics: readonly string[]): TopicCheck {
  const t = normalizeTopic(raw);
  if (!t) return { ok: false, reason: 'A topic is a word or two: letters, digits, spaces, “-”, “&”.' };
  if (topics.some((o) => o.toLowerCase() === t.toLowerCase())) return { ok: false, reason: `${topicLabel(t)} is already a topic.` };
  if (topics.length >= MAX_TOPICS) return { ok: false, reason: `Up to ${MAX_TOPICS} topics. Remove one first.` };
  return { ok: true, topic: t };
}

/** The topic list with `t` switched on or off (a category chip). */
export function toggleTopic(topics: readonly string[], t: string): string[] {
  const has = topics.some((o) => o.toLowerCase() === t.toLowerCase());
  if (has) return topics.filter((o) => o.toLowerCase() !== t.toLowerCase());
  return topics.length >= MAX_TOPICS ? [...topics] : [...topics, t];
}

/** The news poll's interval: one topic's worth of requests per base interval. */
export function newsIntervalMs(topics: readonly string[], baseMs: number): number {
  return baseMs * Math.max(1, topics.length);
}

// --- The store ----------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let topics: string[] = (() => {
  try { return parseTopics(typeof window === 'undefined' ? null : window.localStorage.getItem(TOPICS_KEY)); } catch { return []; }
})();

export function setBriefingTopics(next: readonly string[]): void {
  topics = parseTopics(JSON.stringify(next));
  try { window.localStorage.setItem(TOPICS_KEY, JSON.stringify(topics)); } catch { /* private window: this session keeps them */ }
  listeners.forEach((l) => l());
}

const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getTopics = () => topics;

export function useBriefingTopics(): string[] {
  return useSyncExternalStore(subscribe, getTopics, getTopics);
}
