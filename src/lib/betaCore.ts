/**
 * Atlas Core in the Beta style — the reading behind its body
 * (`Atlas Core Beta.dc.html`, everything under the hero).
 *
 * Pure on purpose. The screen keeps the hooks it already had
 * (`useAtlasHealth`, `useAtlasKnowledge`, `useAtlasResearch`,
 * `useAtlasErrorLog`) and passes what they read in here; this file only
 * decides what the tab strip, the overview tiles and the rows say. Nothing in
 * it can invent a number: every figure it returns is one it was handed.
 */
import type { IconName } from '@/components/atlas/icons';

/** The keys of AtlasCoreScreen's `TABS`. Kept as strings: that array owns them. */
export type CoreTabKey = string;

interface TabMeta {
  icon: IconName;
  /** One line under the hero's title while the tab is open. */
  intro?: string;
  /** Operator instrumentation (the design marks these "Admin" on the strip). */
  admin?: boolean;
}

/**
 * The design's icon and intro per tab. The admin tabs carry no intro here:
 * this module is on the consumer graph, and the copy for tabs a consumer never
 * sees should not ship to one either. The screen supplies those three intros
 * from behind the edition literal (see `ADMIN_TAB_INTROS` there).
 */
const TAB_META: Readonly<Record<CoreTabKey, TabMeta>> = {
  overview: { icon: 'activity', intro: 'What Atlas knows, what it is researching, and how healthy the brain is right now.' },
  search: { icon: 'search', intro: 'Search everything Atlas knows, by exact words, by meaning, or both.' },
  knowledge: { icon: 'document', intro: 'Every domain Atlas has learned about, and what it indexed most recently.' },
  research: { icon: 'teach', intro: 'Background research Atlas is running for you, and the reports it has filed.' },
  memory: { icon: 'memory', intro: 'What Atlas remembers about you. Manage or erase it in Settings.' },
  live: { icon: 'loading', admin: true },
  agent: { icon: 'control', admin: true },
  learning: { icon: 'energy', admin: true },
};

const FALLBACK_INTRO = TAB_META.overview.intro ?? '';

export interface CoreTabLike {
  key: CoreTabKey;
  label: string;
  live?: boolean;
}

export interface CoreStripItem {
  key: CoreTabKey;
  label: string;
  icon: IconName;
  current: boolean;
  /** The red pulse on Live: the tab streams. */
  live: boolean;
  /** Show the "Admin" note — only while the tab is not the open one, as in the design. */
  adminNote: boolean;
}

/** The strip, in the order the screen's (edition-filtered) tab list gives it. */
export function coreTabStrip(tabs: readonly CoreTabLike[], current: CoreTabKey): CoreStripItem[] {
  return tabs.map((t) => {
    const meta = TAB_META[t.key];
    const on = t.key === current;
    return {
      key: t.key,
      label: t.label,
      icon: meta?.icon ?? 'info',
      current: on,
      live: !!t.live,
      adminNote: !!meta?.admin && !on,
    };
  });
}

/** The hero's intro for the open tab; admin tabs read theirs from `adminIntros`. */
export function coreTabIntro(key: CoreTabKey, adminIntros: Readonly<Record<string, string>> = {}): string {
  return TAB_META[key]?.intro ?? adminIntros[key] ?? FALLBACK_INTRO;
}

/**
 * Which tab a URL hash opens (`/atlas-core#memory`), if the strip has it.
 * A hash naming a tab this edition hides opens nothing: it is not a back door.
 */
export function coreTabFromHash(hash: string, visible: readonly CoreTabKey[]): CoreTabKey | null {
  const key = decodeURIComponent((hash || '').replace(/^#/, '')).trim().toLowerCase();
  return key && visible.includes(key) ? key : null;
}

/** Esc steps out one level: a tab back to Overview, Overview back to Home. */
export function coreEscapeStep(tab: CoreTabKey): 'overview' | 'home' {
  return tab === 'overview' ? 'home' : 'overview';
}

/** The ink card's sentence under the knowledge count. */
export function coreHeroLine(activeResearch: number): string {
  if (activeResearch <= 0) return 'Nothing is running in the background right now.';
  return `Atlas is researching ${activeResearch} ${activeResearch === 1 ? 'topic' : 'topics'} in the background.`;
}

export type CoreTone = 'ink' | 'good' | 'bad';

/**
 * Health is `100 − unresolved errors in the last 24 h` (useAtlasHealth), so
 * the colour can only say what that number says: green when the log is
 * nearly clean, red when it is not.
 */
export function healthTone(score: number): CoreTone {
  if (score >= 90) return 'good';
  if (score < 70) return 'bad';
  return 'ink';
}

export interface CoreTile {
  key: string;
  label: string;
  value: string;
  detail: string;
  icon: IconName;
  tone: CoreTone;
}

export interface CoreTileInput {
  activeResearch: number;
  /** Topics with status `queued`, from the research hook the overview already reads. */
  queued: number;
  errorRate: number;
  healthScore: number;
}

/**
 * The four tiles beside the knowledge card. The design's "Memories" tile is
 * not here: the overview reads no memory count, and the Memory tab is one tap
 * away with the real list. Queued research takes the slot because the same
 * research hook already holds it.
 *
 * `null` is the first paint, before useAtlasHealth has answered: dashes, not
 * a red "0% health" that was never measured.
 */
export function coreOverviewTiles(s: CoreTileInput | null): CoreTile[] {
  if (!s) {
    return coreOverviewTiles({ activeResearch: 0, queued: 0, errorRate: 0, healthScore: 100 })
      .map((t) => ({ ...t, value: '—', tone: 'ink' as const }));
  }
  const errs = Math.max(0, s.errorRate);
  return [
    { key: 'research', label: 'Research', value: String(Math.max(0, s.activeResearch)), detail: 'researching now', icon: 'teach', tone: 'ink' },
    { key: 'queued', label: 'Queued', value: String(Math.max(0, s.queued)), detail: s.queued === 1 ? 'topic waiting to start' : 'topics waiting to start', icon: 'history', tone: 'ink' },
    { key: 'errors', label: 'Error rate', value: `${errs.toFixed(1)}%`, detail: 'unresolved, last 24 hours', icon: 'warning', tone: errs > 0 ? 'bad' : 'ink' },
    { key: 'health', label: 'Health', value: `${Math.round(s.healthScore)}%`, detail: 'from the last 24 hours of errors', icon: 'activity', tone: healthTone(s.healthScore) },
  ];
}

export type TagTone = 'blue' | 'neutral' | 'muted';

/** The status tag on a research row. Unknown statuses read as themselves. */
export function researchTag(status: string): { label: string; tone: TagTone } {
  switch (status) {
    case 'researching': return { label: 'Researching', tone: 'blue' };
    case 'processing': return { label: 'Processing', tone: 'blue' };
    case 'queued': return { label: 'Queued', tone: 'neutral' };
    case 'paused': return { label: 'Paused', tone: 'muted' };
    default: return { label: status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown', tone: 'neutral' };
  }
}

/** A research row is "running" (pausable) unless it is only waiting in line. */
export function researchRunning(status: string): boolean {
  return status === 'researching' || status === 'processing';
}

/** Statuses the overview's queue card shows, in the Workshop's own filter. */
export const QUEUE_STATUSES: readonly string[] = ['queued', 'researching', 'processing'];

/** "just now", "12 min ago", "3 h ago", "Yesterday", "4 days ago". Empty for no date. */
export function agoLabel(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

/** The indexing card's one real row: the count, and when the newest entry landed. */
export function indexingRow(count: number, newestIso: string | null | undefined, now: number): { title: string; sub: string } {
  const title = `${count.toLocaleString('en-US')} ${count === 1 ? 'entry' : 'entries'}`;
  const ago = agoLabel(newestIso, now);
  return { title, sub: ago ? `Last indexed ${ago}` : count > 0 ? 'Indexed' : 'Nothing indexed yet' };
}
