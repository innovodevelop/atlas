/**
 * Teach in the Beta style — the reading behind its body
 * (`Atlas Teach Beta.dc.html`: the conversation, "What Atlas knows about
 * you", the learned list and the guidance card).
 *
 * Pure. AtlasTeach keeps its own voice pipeline, its `ai_memory` query and its
 * realtime subscription exactly as they were; this file turns what those
 * already hold into tiles, prompts, rows and labels.
 *
 * What the design shows and this does not, on purpose:
 *  - "Forget" on each learned row. Forgetting lives in Settings → Memory &
 *    Privacy, behind its typed confirmation (see useAtlasMemory's note); a
 *    second copy of a GDPR-relevant destructive control on this screen would
 *    be a second place to keep right. The list links there instead.
 *  - "Teach it from something you've written". Atlas has no document-reading
 *    path that proposes memories, and a drop zone that does nothing is the
 *    one thing the handoff forbids outright.
 */

/** The categories the teaching prompt asks the brain to file under, in the design's order. */
export const TEACH_CATEGORIES = [
  'identity', 'personality', 'values', 'beliefs', 'feelings', 'fears',
  'dreams', 'joys', 'relationships', 'work', 'memories',
] as const;
export type TeachCategory = (typeof TEACH_CATEGORIES)[number];

/**
 * The model sometimes files a singular or a near-synonym ("relationship",
 * "social"). Folded into the category the prompt named, so the tile counts
 * what a person would count.
 */
const ALIASES: Readonly<Record<string, string>> = {
  relationship: 'relationships', social: 'relationships', value: 'values', belief: 'beliefs',
  feeling: 'feelings', fear: 'fears', dream: 'dreams', joy: 'joys', memory: 'memories',
};

/** One question per category, for the prompt chips under the conversation. */
export const TEACH_PROMPTS: Readonly<Record<TeachCategory, string>> = {
  identity: 'Where do you feel most at home?',
  personality: 'What would a close friend say you’re like?',
  values: 'What would you never compromise on?',
  beliefs: 'What’s something you believe that most people don’t?',
  feelings: 'How have you been feeling this week?',
  fears: 'What’s been worrying you lately?',
  dreams: 'What have you always wanted to do?',
  joys: 'What reliably makes your day better?',
  relationships: 'Who do you call when something good happens?',
  work: 'What part of your work do you love most?',
  memories: 'What’s a moment that shaped you?',
};

/** The `ai_memory` query on the page reads at most this many rows. */
export const TEACH_MEMORY_LIMIT = 50;

export interface TeachMemoryLike {
  id: string;
  key: string;
  value: unknown;
  category: string | null;
  created_at?: string | null;
}

/** The normalised category key of one stored row. */
export function teachCategoryOf(raw: string | null | undefined): string {
  const k = (raw ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!k) return 'general';
  return ALIASES[k] ?? k;
}

export function isTeachCategory(k: string): k is TeachCategory {
  return (TEACH_CATEGORIES as readonly string[]).includes(k);
}

/** "relationships" → "Relationships", "life_events" → "Life events". */
export function categoryLabel(key: string): string {
  const s = key.replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'General';
}

function countByCategory(memories: readonly TeachMemoryLike[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const m of memories) {
    const k = teachCategoryOf(m.category);
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return n;
}

export interface TeachTile {
  key: string;
  label: string;
  count: number;
  /** Filled pips, 0–5: one per memory, capped. */
  pips: number;
  selected: boolean;
}

/**
 * The tiles: the eleven teaching categories always (an empty one is the
 * invitation), then any other category the brain actually filed under, most
 * used first — so nothing Atlas keeps is missing from the grid.
 */
export function teachTiles(memories: readonly TeachMemoryLike[], selected: string): TeachTile[] {
  const counts = countByCategory(memories);
  const extras = [...counts.entries()]
    .filter(([k]) => !isTeachCategory(k))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
  return [...TEACH_CATEGORIES, ...extras].map((k) => {
    const count = counts.get(k) ?? 0;
    return { key: k, label: categoryLabel(k), count, pips: Math.min(5, count), selected: k === selected };
  });
}

/** Teaching categories with nothing in them yet, in the design's order. */
export function teachGaps(memories: readonly TeachMemoryLike[]): TeachCategory[] {
  const counts = countByCategory(memories);
  return TEACH_CATEGORIES.filter((c) => !counts.get(c));
}

/** The line under the tiles. */
export function teachGapLine(gaps: readonly TeachCategory[]): string {
  if (!gaps.length) return 'Atlas has heard about every part of you. Keep going: depth beats breadth.';
  const named = gaps.slice(0, 3).map((g) => g.toLowerCase());
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : named[0];
  return `Atlas hasn’t heard about your ${list} yet. The suggestions under the conversation start there.`;
}

export interface TeachPrompt {
  category: TeachCategory;
  label: string;
  question: string;
}

/** Three prompt chips: the picked category first, then the gaps, then the rest. */
export function teachPrompts(memories: readonly TeachMemoryLike[], selected: string, n = 3): TeachPrompt[] {
  const first = isTeachCategory(selected) ? [selected] : [];
  const order = [...first, ...teachGaps(memories), ...TEACH_CATEGORIES];
  const seen = new Set<TeachCategory>();
  const out: TeachPrompt[] = [];
  for (const c of order) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push({ category: c, label: categoryLabel(c), question: TEACH_PROMPTS[c] });
    if (out.length >= n) break;
  }
  return out;
}

/** A stored value as text, the way the Workshop sidebar printed it. */
export function teachValueText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
}

function dayStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", or "12 Oct" — the date under a learned row. */
export function teachDateLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export interface TeachRow {
  id: string;
  title: string;
  value: string;
  meta: string;
  /** Arrived in the last few seconds (the page's own "recently learned" ticker). */
  fresh: boolean;
}

/**
 * The learned list: newest first (the query sorts by importance, the list
 * says "recently"), filtered to the picked tile, eight rows unfiltered and
 * twenty in a category.
 */
export function teachRows(
  memories: readonly TeachMemoryLike[],
  opts: { selected: string; freshIds?: ReadonlySet<string>; now: number },
): TeachRow[] {
  const limit = opts.selected ? 20 : 8;
  const time = (m: TeachMemoryLike) => {
    const t = m.created_at ? new Date(m.created_at).getTime() : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return memories
    .filter((m) => !opts.selected || teachCategoryOf(m.category) === opts.selected)
    .slice()
    .sort((a, b) => time(b) - time(a))
    .slice(0, limit)
    .map((m) => {
      const date = teachDateLabel(m.created_at, opts.now);
      return {
        id: m.id,
        title: m.key,
        value: teachValueText(m.value),
        meta: date ? `${categoryLabel(teachCategoryOf(m.category))} · ${date}` : categoryLabel(teachCategoryOf(m.category)),
        fresh: !!opts.freshIds?.has(m.id),
      };
    });
}

/** "12", or "50+" once the query's own limit is reached (there may be more). */
export function teachCountLabel(n: number, cap = TEACH_MEMORY_LIMIT): string {
  return n >= cap ? `${cap}+` : String(Math.max(0, n));
}

/** The hero's eyebrow. */
export function teachEyebrow(count: number, listening: boolean): string {
  const things = count === 1 ? 'thing' : 'things';
  return `Teach · ${teachCountLabel(count)} ${things} kept${listening ? ' · listening' : ''}`;
}

export type TeachVoiceStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type TeachListening = 'passive' | 'active';

/** The sphere-as-microphone's label, and the composer microphone's name. */
export function teachMicLabel(s: { isConnected: boolean; isProcessing: boolean; listeningMode: TeachListening }): string {
  if (!s.isConnected) return 'Tap to talk';
  if (s.isProcessing) return 'Thinking…';
  return s.listeningMode === 'active' ? 'Listening · tap to stop' : 'Say “Atlas” to start';
}

export interface TeachVoiceChip {
  label: string;
  tone: 'idle' | 'live' | 'busy' | 'error';
  /** The one control the chip carries: connect when off, retry after an error. */
  action: 'connect' | 'retry' | null;
}

/** The chip at the top of the conversation: the same four states the Workshop pill showed. */
export function teachVoiceChip(s: {
  voiceStatus: TeachVoiceStatus;
  listeningMode: TeachListening;
  retryCount: number;
  maxRetries: number;
}): TeachVoiceChip {
  switch (s.voiceStatus) {
    case 'connecting':
      return { label: s.retryCount > 0 ? `Retry ${s.retryCount}/${s.maxRetries}…` : 'Connecting…', tone: 'busy', action: null };
    case 'error':
      return { label: 'Voice error', tone: 'error', action: 'retry' };
    case 'disconnected':
      return { label: 'Voice off', tone: 'idle', action: 'connect' };
    case 'connected':
    default:
      return s.listeningMode === 'active'
        ? { label: 'Listening', tone: 'live', action: null }
        : { label: 'Waiting for “Atlas”', tone: 'idle', action: null };
  }
}

/** Send is live when there is something to send and no turn is in flight. */
export function canSendDraft(draft: string, isProcessing: boolean): boolean {
  return draft.trim().length > 0 && !isProcessing;
}
