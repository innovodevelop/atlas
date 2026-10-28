/**
 * The Beta widget catalog and widget sheet — what they show and how they lay
 * it out. Pure, so the plan, the copy and the attention rules are tested
 * without a DOM.
 *
 * From `Atlas Widgets Beta.dc.html` (design/current/design_handoff_atlas_beta):
 * the Catalog tab draws every widget at its sizes, on paper and ink, on a
 * 12 / 6 / 3 column grid; the States tab draws six widgets across loading,
 * default, attention, empty and offline. The design's widget list is mock
 * (fifty-odd cards Atlas does not have), so the catalog's list is Home's own
 * (`WIDGETS` in betaHome.ts) and the faces are Home's own adapters reading
 * live hooks. What this file adds is the shape of the page around them and
 * the copy the four forced states need.
 *
 * The attention rules below are the ones the attention preview actually
 * evaluates against live data. When a rule does not hold right now the
 * preview still shows where the row lands, in a muted tone that says so,
 * rather than inventing an alert.
 */
import { SPANS, WIDGETS, type WidgetDef, type WidgetGroup, type WidgetSize, type WidgetSource } from './betaHome';
import { focusIn, focusPhase, joinUrl } from './stageFocus';
import type { CalendarEvent } from '@/hooks/useCalendarEvents';
import type { StatusKey } from '@/lib/mocks/widgetSheet';

// --- Choices on the page ------------------------------------------------------------

export type SizeChoice = 'all' | WidgetSize;
export type DesignChoice = 'both' | 'paper' | 'ink';
export type CatalogTone = 'paper' | 'ink';
export type CatalogMode = 'live' | 'empty';
/** The states a face can be forced into; "default" is the live face itself. */
export type PreviewState = 'loading' | 'attention' | 'empty' | 'offline';
export type SheetStateId = 'loading' | 'default' | 'attention' | 'empty' | 'offline';

export const SIZE_ORDER: readonly WidgetSize[] = ['S', 'M', 'L', 'XL'];

/** "2×1" for S — read from the grid spans, so the label cannot drift from the layout. */
export const sizeDim = (s: WidgetSize): string => `${SPANS[s][0]}×${SPANS[s][1]}`;

export const SIZE_CHOICES: readonly { id: SizeChoice; label: string; dim?: string }[] = [
  { id: 'all', label: 'All' },
  ...SIZE_ORDER.map((s) => ({ id: s, label: s, dim: sizeDim(s) })),
];

export const DESIGN_CHOICES: readonly { id: DesignChoice; label: string }[] = [
  { id: 'both', label: 'Both' },
  { id: 'paper', label: 'Paper' },
  { id: 'ink', label: 'Ink' },
];

export const MODE_CHOICES: readonly { id: CatalogMode; label: string }[] = [
  { id: 'live', label: 'With data' },
  { id: 'empty', label: 'Empty' },
];

export const SOURCE_LABEL: Record<WidgetSource, string> = { live: 'Live', sample: 'Sample', unwired: 'Soon' };

/** The sizes a widget is drawn at: all it offers, or the one picked if it offers it. */
export function sizesFor(def: Pick<WidgetDef, 'sizes'>, choice: SizeChoice): WidgetSize[] {
  const own = SIZE_ORDER.filter((s) => def.sizes.includes(s));
  return choice === 'all' ? own : own.filter((s) => s === choice);
}

export function tonesFor(choice: DesignChoice): CatalogTone[] {
  return choice === 'both' ? ['paper', 'ink'] : [choice];
}

export function sizeLabel(choice: SizeChoice): string {
  return choice === 'all' ? 'all sizes' : `${choice} · ${sizeDim(choice)}`;
}

export function designLabel(choice: DesignChoice): string {
  return choice === 'both' ? 'paper and ink' : choice;
}

// --- The grid plan ------------------------------------------------------------------

/** The design's breakpoints: twelve columns on a wide window, six on a narrow one, three on a phone. */
export function gridColumnsFor(width: number): number {
  return width >= 1280 ? 12 : width >= 760 ? 6 : 3;
}

export interface CatalogCell {
  key: string;
  id: string;
  size: WidgetSize;
  tone: CatalogTone;
  /** Columns spanned on this grid: the size's span, clamped to the columns there are. */
  cols: number;
  rows: number;
}

/** One cell per widget × size × tone, in catalog order, paper before ink. */
export function cellsFor(defs: readonly WidgetDef[], size: SizeChoice, design: DesignChoice, gridCols: number): CatalogCell[] {
  const tones = tonesFor(design);
  const out: CatalogCell[] = [];
  for (const def of defs) {
    for (const s of sizesFor(def, size)) {
      const [c, r] = SPANS[s];
      for (const tone of tones) out.push({ key: `${def.id}-${s}-${tone}`, id: def.id, size: s, tone, cols: Math.min(c, Math.max(1, gridCols)), rows: r });
    }
  }
  return out;
}

/** The groups in the order their first widget appears in the catalog. */
export function groupOrder(defs: readonly WidgetDef[] = WIDGETS): WidgetGroup[] {
  const seen: WidgetGroup[] = [];
  for (const d of defs) if (!seen.includes(d.group)) seen.push(d.group);
  return seen;
}

export function groupChips(defs: readonly WidgetDef[] = WIDGETS): { id: WidgetGroup | 'all'; label: string; n: number }[] {
  return [
    { id: 'all', label: 'All', n: defs.length },
    ...groupOrder(defs).map((g) => ({ id: g, label: g, n: defs.filter((d) => d.group === g).length })),
  ];
}

export interface CatalogSection {
  group: WidgetGroup;
  /** The group's widgets that have at least one cell at this size. */
  widgets: WidgetDef[];
  cells: CatalogCell[];
}

/** The catalog page: one section per group that has something to draw. */
export function catalogPlan(
  opts: { group: WidgetGroup | 'all'; size: SizeChoice; design: DesignChoice; gridCols: number },
  defs: readonly WidgetDef[] = WIDGETS,
): CatalogSection[] {
  return groupOrder(defs)
    .filter((g) => opts.group === 'all' || g === opts.group)
    .map((group) => {
      const widgets = defs.filter((d) => d.group === group && sizesFor(d, opts.size).length > 0);
      return { group, widgets, cells: cellsFor(widgets, opts.size, opts.design, opts.gridCols) };
    })
    .filter((s) => s.cells.length > 0);
}

/** Skeleton bars for the loading face: width in %, height in px. Two rows get a body. */
export function skeletonBars(size: WidgetSize): { w: number; h: number }[] {
  return SPANS[size][1] >= 2
    ? [{ w: 46, h: 10 }, { w: 56, h: 26 }, { w: 40, h: 10 }, { w: 88, h: 10 }, { w: 72, h: 10 }]
    : [{ w: 46, h: 10 }, { w: 40, h: 22 }, { w: 64, h: 8 }];
}

// --- The sheet ----------------------------------------------------------------------

/** The six widgets the sheet draws in every state (the handoff's "core" set). */
export const CORE_WIDGETS = ['weather', 'today', 'tasks', 'inbox', 'watch', 'briefing'] as const;
export type CoreWidgetId = (typeof CORE_WIDGETS)[number];
export const isCoreWidget = (id: string): id is CoreWidgetId => (CORE_WIDGETS as readonly string[]).includes(id);

export const SHEET_STATES: readonly { id: SheetStateId; label: string; preview?: PreviewState }[] = [
  { id: 'loading', label: 'Loading', preview: 'loading' },
  { id: 'default', label: 'Default' },
  { id: 'attention', label: 'Attention', preview: 'attention' },
  { id: 'empty', label: 'Empty', preview: 'empty' },
  { id: 'offline', label: 'Offline', preview: 'offline' },
];

/** The four rules above the sheet. The last one says "when Atlas knows" because no hook records when its reading arrived. */
export const STATE_RULES: readonly { t: string; d: string }[] = [
  { t: 'Loading shimmers', d: 'Skeletons in the panel tone. Never a spinner.' },
  { t: 'Attention adds one row', d: 'A blue-tinted alert and a filled icon. The rest of the card stays put.' },
  { t: 'Empty says what’s next', d: 'What Atlas will do once it has data, plus one action where there is one to take.' },
  { t: 'Offline shows its age', d: 'Cached content dims to half and says how old it is when Atlas knows. Local data stays at full strength.' },
];

/** When each core widget asks for attention — the rule the attention preview evaluates. */
export const ATTENTION_RULE: Record<CoreWidgetId, string> = {
  weather: 'Attention when the hours on the card bring rain, snow or a storm.',
  today: 'Attention ten minutes before an event and while it is on, with Join when the event carries a link.',
  tasks: 'Attention when a task is past its due date. The alert turns red.',
  inbox: 'Attention when Atlas raises a mail alert that nobody has acknowledged.',
  watch: 'Attention when a ticker on the watchlist moves past ±3% today.',
  briefing: 'Attention when a headline is trending.',
};

/** The attention row while its rule does not hold: it shows where the alert lands, and says nothing is due. */
export const ATTENTION_IDLE: Record<CoreWidgetId, string> = {
  weather: 'Nothing to flag now · rain in the coming hours shows here',
  today: 'Nothing to flag now · an event ten minutes out shows here',
  tasks: 'Nothing overdue · a task past its date shows here, in red',
  inbox: 'No mail alerts · an urgent message shows here',
  watch: 'No big moves · a ticker past ±3% shows here',
  briefing: 'Nothing trending · a breaking headline shows here',
};

/**
 * What the offline face says after "Offline ·". `dim: false` for sources that
 * live on this Mac: they do not go stale without a network, so their face
 * stays at full strength and the row says why.
 */
export const OFFLINE_COPY: Record<CoreWidgetId, { text: string; dim: boolean }> = {
  weather: { text: 'weather service unreachable · last reading kept', dim: true },
  today: { text: 'your calendar is on this Mac · still current', dim: false },
  tasks: { text: 'tasks are on this Mac · edits still save', dim: false },
  inbox: { text: 'mail sync paused', dim: true },
  watch: { text: 'market feed unreachable · last quotes kept', dim: true },
  briefing: { text: 'news feed unreachable · last headlines kept', dim: true },
};

export type EmptyAction = { label: string; route: string } | { label: string; ask: string };
export interface EmptySpec { title: string; hint: string; action?: EmptyAction }

/**
 * The empty face for every widget: what Atlas does once it has data, and one
 * action where a real one exists. A route action is only offered when the
 * build ships that route (the page checks); an ask goes to the Talk panel.
 */
export const EMPTY_COPY: Record<string, EmptySpec> = {
  weather: { title: 'No forecast yet', hint: 'The forecast comes through the weather key on this Mac. Until then, Atlas can look it up.', action: { label: 'Ask Atlas', ask: 'What is the weather today?' } },
  today: { title: 'Nothing scheduled', hint: 'A clear day. Ask Atlas to block focus time and it adds the event to your calendar.', action: { label: 'Block focus time', ask: 'Block an hour of focus time in my calendar this afternoon.' } },
  tasks: { title: 'All clear', hint: 'Nothing open. Add one on the card, or tell Atlas and it files the task.' },
  inbox: { title: 'Inbox zero', hint: 'Nothing needs you. Atlas keeps triaging in the background.' },
  watch: { title: 'No holdings yet', hint: 'The watchlist is fixed for now. Connect a brokerage and your portfolio leads the card.', action: { label: 'Connect brokerage', route: '/money' } },
  briefing: { title: 'No headlines yet', hint: 'Headlines come through the news key on this Mac, refreshed every fifteen minutes.', action: { label: 'Ask Atlas', ask: 'What are the top headlines this morning?' } },
  air: { title: 'No air reading', hint: 'Air quality arrives with the forecast wherever the provider measures it.' },
  clock: { title: 'No cities yet', hint: 'The cities are fixed in this build; choosing your own arrives with the Clock screen.' },
  music: { title: 'Nothing playing', hint: 'Connect Spotify through Atlas and what plays shows here, with its controls.' },
  activity: { title: 'No activity yet', hint: 'Import a Health export and the move, exercise and stand rings fill in.', action: { label: 'Open Health', route: '/health' } },
  steps: { title: 'No steps yet', hint: 'Import a Health export and today’s steps and distance show here.', action: { label: 'Open Health', route: '/health' } },
  sleep: { title: 'No sleep yet', hint: 'Import a Health export and last night shows here, stage by stage.', action: { label: 'Open Health', route: '/health' } },
  home: { title: 'No home hub', hint: 'Connect Home Assistant and your rooms, temperatures and the front door show here.', action: { label: 'Open Smart Home', route: '/smart-home' } },
  energy: { title: 'Not wired yet', hint: 'No energy meter is connected yet; this widget arrives with one.' },
  podcast: { title: 'No episode started', hint: 'Follow a show on Spotify and play an episode through Atlas; where you stopped shows here.' },
  focus: { title: 'Not wired yet', hint: 'Focus sessions arrive with the Focus screen.' },
};

export function emptyCopy(id: string): EmptySpec {
  return EMPTY_COPY[id] ?? { title: 'No data yet', hint: 'Connect a source to begin.' };
}

// --- Attention, read from live data -------------------------------------------------

/** Icon names from the Precision set the attention row uses (all present in icons.ts). */
export type AttentionIcon = 'rain' | 'calendar' | 'warning' | 'sparkle' | 'markets' | 'news' | 'info';

export interface AttentionCopy {
  text: string;
  tone: 'blue' | 'red';
  icon: AttentionIcon;
  /** A meeting link the row can offer to join. */
  join?: string;
}

const WET = /rain|drizzle|shower|storm|thunder|snow|sleet/i;

/** The first wet hour among the ones the card shows. */
export function weatherAttention(hourly: readonly { time: string; icon: string }[]): AttentionCopy | null {
  const h = hourly.find((x) => WET.test(x.icon));
  if (!h) return null;
  const kind = /snow|sleet/i.test(h.icon) ? 'Snow' : /storm|thunder/i.test(h.icon) ? 'Storms' : 'Rain';
  return { text: /^now$/i.test(h.time) ? `${kind} now` : `${kind} around ${h.time}`, tone: 'blue', icon: 'rain' };
}

/** The focus event, when it is ten minutes out or on now. */
export function todayAttention(focus: CalendarEvent | null, now: number, leadMs = 10 * 60000): AttentionCopy | null {
  if (!focus) return null;
  const phase = focusPhase(focus, now);
  if (phase === 'done') return null;
  if (phase === 'ahead' && Date.parse(focus.start_time) - now > leadMs) return null;
  const join = joinUrl(focus) ?? undefined;
  return { text: phase === 'now' ? `${focus.title} is on now` : `${focus.title} starts ${focusIn(focus, now)}`, tone: 'blue', icon: 'calendar', join };
}

/**
 * A due date as a moment. A bare date (`2026-10-27`) is that LOCAL day's
 * midnight — `Date.parse` would read it as UTC midnight, which west of
 * Greenwich is the evening before and would call today's tasks overdue.
 */
export function dueAt(due: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(due);
}

/** Open tasks past their date: a bare date is overdue from the next day, a timed one from its time. */
export function overdueTasks<T extends { completed: boolean; due_date: string | null }>(tasks: readonly T[], now: number): T[] {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return tasks.filter((t) => {
    if (t.completed || !t.due_date) return false;
    const at = dueAt(t.due_date);
    if (!Number.isFinite(at)) return false;
    return /^\d{4}-\d{2}-\d{2}$/.test(t.due_date) ? at < today.getTime() : at < now;
  });
}

export function tasksAttention(tasks: readonly { title: string; completed: boolean; due_date: string | null }[], now: number): AttentionCopy | null {
  const late = overdueTasks(tasks, now);
  if (!late.length) return null;
  return { text: late.length === 1 ? `${late[0].title} is overdue` : `${late.length} tasks overdue`, tone: 'red', icon: 'warning' };
}

export function inboxAttention(alerts: readonly { title: string; acknowledged: boolean }[]): AttentionCopy | null {
  const a = alerts.find((x) => !x.acknowledged);
  return a ? { text: a.title, tone: 'blue', icon: 'sparkle' } : null;
}

const signedPct = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

/** The biggest mover past the threshold, either way. */
export function watchAttention(stocks: readonly { symbol: string; changePercent: number }[], threshold = 3): AttentionCopy | null {
  const movers = stocks.filter((s) => Math.abs(s.changePercent) >= threshold);
  if (!movers.length) return null;
  const top = movers.reduce((a, b) => (Math.abs(b.changePercent) > Math.abs(a.changePercent) ? b : a));
  return { text: `${top.symbol} ${signedPct(top.changePercent)}, past ±${threshold}%`, tone: 'blue', icon: 'markets' };
}

export function briefingAttention(news: readonly { title: string; trending: boolean }[]): AttentionCopy | null {
  const n = news.find((x) => x.trending);
  return n ? { text: `Trending: ${n.title}`, tone: 'blue', icon: 'news' } : null;
}

// --- Offline, read from live data ---------------------------------------------------

/** "just now" · "4 min ago" · "3 h ago" · "2 d ago". */
export function ageLabel(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** The mail offline line with the real age of the last sync, when any mailbox has synced. */
export function mailOffline(accounts: readonly { last_synced_at: string | null }[], now: number): string | null {
  const times = accounts.map((a) => (a.last_synced_at ? Date.parse(a.last_synced_at) : NaN)).filter((t) => Number.isFinite(t));
  if (!times.length) return null;
  return `mail sync paused · last synced ${ageLabel(now - Math.max(...times))}`;
}

// --- What each core widget is bound to ----------------------------------------------

/** Facts read from the hooks (see src/lib/mocks/widgetSheet.ts for the long form). */
export const CORE_SOURCE: Record<CoreWidgetId, { name: string; kind: 'key' | 'local' | 'mail'; key?: StatusKey }> = {
  weather: { name: 'OpenWeather', kind: 'key', key: 'openweather' },
  today: { name: 'Calendar', kind: 'local' },
  tasks: { name: 'Tasks', kind: 'local' },
  inbox: { name: 'Mail', kind: 'mail' },
  watch: { name: 'Finnhub', kind: 'key', key: 'finnhub' },
  briefing: { name: 'NewsAPI', kind: 'key', key: 'news' },
};

export interface SourceStatusLike {
  phase: 'loading' | 'ready' | 'unknown' | 'error';
  keys: Partial<Record<StatusKey, boolean>>;
  reason: string | null;
}

export interface SourceVerdict { tone: 'ready' | 'failed' | 'paused' | 'syncing'; text: string; title?: string }

/**
 * One line on what a core widget is reading right now. A missing key is said
 * plainly because the Mac app then answers with its built-in sample, which the
 * card alone cannot tell apart from a reading.
 */
export function sourceVerdict(id: CoreWidgetId, status: SourceStatusLike, mailConnected: boolean | null): SourceVerdict {
  const src = CORE_SOURCE[id];
  if (src.kind === 'local') return { tone: 'ready', text: `${src.name} on this Mac · no key needed` };
  if (src.kind === 'mail') {
    if (mailConnected == null) return { tone: 'syncing', text: 'Checking the mailbox…' };
    return mailConnected ? { tone: 'ready', text: 'Mailbox connected' } : { tone: 'paused', text: 'No mailbox connected' };
  }
  if (status.phase === 'loading') return { tone: 'syncing', text: `Checking the ${src.name} key…` };
  if (status.phase !== 'ready') return { tone: 'paused', text: `${src.name} key: cannot tell from here`, title: status.reason ?? undefined };
  const present = src.key ? status.keys[src.key] : undefined;
  if (present === undefined) return { tone: 'paused', text: `${src.name} key: cannot tell from here` };
  return present
    ? { tone: 'ready', text: `${src.name} key on this Mac` }
    : { tone: 'failed', text: `No ${src.name} key · the Mac app shows its sample` };
}
