/**
 * Atlas Health — the real adapter, replacing `src/lib/mocks/health.ts`.
 *
 * ── THE DOMINANT FACT ───────────────────────────────────────────────────────
 *
 * THERE IS NO DATA UNTIL SOMEONE IMPORTS AN EXPORT. `HKHealthStore.isHealth
 * DataAvailable()` is FALSE on macOS (docs/decisions/008, pinned by
 * src-tauri/tests/platform_health_home_wall.rs), so this Mac has no Health
 * store to read, no permission dialog to raise and nothing to poll. The only
 * working source is a file the person exports from the Health app on their
 * iPhone and hands to Atlas.
 *
 * That makes "nothing yet" the PRIMARY state of this surface — the state every
 * install is in, not an edge case — which is why `emptyReason()` below is a
 * first-class projection and not an afterthought, and why the page leads with
 * how to get data rather than with a spinner.
 *
 * ── WHY EVERY CARD CARRIES A DATE ───────────────────────────────────────────
 *
 * An import is a snapshot of the past, not a feed. `store::latest_metrics`
 * returns the most recent day EACH metric was measured, and those days differ —
 * weight is weekly, heart rate is continuous — so a card without its own date
 * would show a three-week-old step count in the same shape as this morning's
 * pulse. `dayKicker()` puts the real day in every card header and never says
 * "Today" for a day that is not today. `coverageOf()` labels the whole dataset
 * with its range, and `Freshness` decides whether the page wears a stale strip.
 *
 * ── WHAT THIS FILE DOES NOT INVENT ──────────────────────────────────────────
 *
 * `signals`, `devices`, `clay` and `primaryDevice` are part of the design's
 * vocabulary and come back EMPTY from Rust, on purpose: each of them describes a
 * live paired device, and a file somebody dragged in last month is not one. They
 * are passed through empty rather than filled with plausible content, and the
 * page renders nothing for them. Likewise there is no `delta` on any card: a
 * trend needs a second day, `health_snapshot` returns one, and "+22m" invented
 * from a single reading is the exact failure this product refuses.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 *
 * Everything that decides what a person reads is a PURE function of the JSON
 * plus today's date, exported and tested (`useHealth.test.ts`). The hook is the
 * thin part: invoke, store, re-invoke. There is no DOM test runner in this repo,
 * so a hook whose judgement lives inside `useState` is a hook whose judgement is
 * untested.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import type { HealthCategory, HealthMetric, HealthSnapshot, UseAtlasHealth } from '@/lib/mocks/health';

/* ── The wire ─────────────────────────────────────────────────────────────── */

export const HEALTH_SNAPSHOT_COMMAND = 'health_snapshot';
export const HEALTH_IMPORT_COMMAND = 'health_import';
export const HEALTH_FORGET_COMMAND = 'health_forget';

/** Minimal `invoke`, injected so every path here is testable without Tauri. */
export type InvokeFn = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** The id `store::export_source` gives the one source that can exist today. */
export const EXPORT_SOURCE_ID = 'apple_export';

/* ── What Rust sends ──────────────────────────────────────────────────────── */

/** One row of `health_metrics`, as `store::metric_json` writes it. */
export interface RawMetric {
  metric: string;
  name: string;
  category: string;
  /** Already formatted by Rust — "7h 12m", "8,213", "58 bpm". */
  value: string;
  raw: number;
  unit: string;
  /** `sum` or `avg` — how the day was reduced. */
  stat: string;
  /** YYYY-MM-DD. Never absent; see the header. */
  day: string;
  sampleCount: number;
  source: string | null;
  low: number | null;
  high: number | null;
  /** "58 bpm–66 bpm", or null when the day held one reading. */
  range: string | null;
}

export interface RawWorkout {
  activity: string;
  startedAt: string;
  endedAt: string;
  day: string;
  durationMin: number;
  distanceKm: number | null;
  energyKcal: number | null;
  avgHeartRate: number | null;
  source: string | null;
}

/** A row of `health_sync_state`, plus the companion stub that always refuses. */
export interface RawSource {
  id: string;
  name: string;
  kind: string;
  state: string;
  detail: string | null;
  exportDate?: string | null;
  fileName?: string | null;
  lastImportAt?: string | null;
  days?: number;
  recordsRead?: number;
  recordsUsed?: number;
  recordsRejected?: number;
  workouts?: number;
  firstDay?: string | null;
  lastDay?: string | null;
  enabled: boolean;
  /** Only the companion has one: why it cannot work at all. */
  reason?: string;
}

/** `health::privacy()` — statements, not switches. `fixed` is always true. */
export interface RawPrivacyRule {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  fixed: boolean;
}

export interface RawCoverage {
  metrics: number;
  days: number;
  workouts: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface RawSnapshot {
  capturedAt: string;
  hasData: boolean;
  sources: RawSource[];
  metrics: RawMetric[];
  workouts: RawWorkout[];
  coverage: RawCoverage;
  privacy: RawPrivacyRule[];
  /** All four are `[]`/null from Rust and stay that way. See the header. */
  signals: unknown[];
  devices: unknown[];
  clay: unknown[];
  primaryDevice: unknown;
}

/** `health::report_json` — what one import actually did. */
export interface ImportReport {
  fileName: string;
  fileBytes: number;
  exportDate: string | null;
  recordsRead: number;
  recordsUsed: number;
  recordsIgnored: number;
  recordsRejected: number;
  rejectionReasons: { reason: string; count: number }[];
  workouts: number;
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  detail: string;
}

/* ── Days ─────────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Whole days from `from` to `to`, both YYYY-MM-DD.
 *
 * Built through `Date.UTC` on the three parts rather than by subtracting two
 * local `Date`s: a DST boundary makes one local day 23 or 25 hours long, and
 * "yesterday" turning into "2 days ago" twice a year on the clocks change is
 * exactly the kind of quiet wrongness this surface cannot afford. Returns null
 * for anything that is not a date, so a malformed day never becomes day zero —
 * which would read as "Today".
 */
export function dayDiff(from: string, to: string): number | null {
  const a = utcDay(from);
  const b = utcDay(to);
  if (a === null || b === null) return null;
  // Exact, with no rounding to hide behind: UTC has no DST, so the gap between
  // two UTC midnights is always a whole number of 86,400,000ms. A `Math.round`
  // here would quietly repair a local-time implementation and take this
  // function's only real guarantee with it.
  return (b - a) / 86_400_000;
}

function utcDay(iso: string): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  // Rejects 31 February, which `Date.UTC` would silently roll into March.
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/** "2 Aug", or "2 Aug 2025" once the year differs from today's. */
export function formatDay(iso: string, today: string): string {
  const ms = utcDay(iso);
  if (ms === null) return 'an unknown day';
  const d = new Date(ms);
  const sameYear = typeof today === 'string' && today.slice(0, 4) === iso.slice(0, 4);
  const stem = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return sameYear ? stem : `${stem} ${d.getUTCFullYear()}`;
}

/**
 * The card header's right-hand word — the day this particular number is from.
 *
 * "Today" is reserved for today. Everything else says how old it is, in the
 * shortest form that is still true, and past six days it gives up on relative
 * wording and names the date: "6 days ago" is readable, "23 days ago" is not.
 */
export function dayKicker(day: string, today: string): string {
  const age = dayDiff(day, today);
  if (age === null) return 'Unknown day';
  if (age < 0) return formatDay(day, today);
  if (age === 0) return 'Today';
  if (age === 1) return 'Yesterday';
  if (age <= 6) return `${age} days ago`;
  return formatDay(day, today);
}

/* ── Coverage: what the dataset is, and how old ───────────────────────────── */

/**
 * `none` is the day-one state, not a fault.
 * `stale` is the one that changes the page: past a week, an import is history
 * rather than a picture of now, and the surface says so above the cards.
 */
export type Freshness = 'none' | 'fresh' | 'recent' | 'stale';

/** Days after which the whole dataset is labelled stale on screen. */
export const STALE_AFTER_DAYS = 7;

export interface Coverage {
  firstDay: string | null;
  lastDay: string | null;
  /** Days that actually carry a reading. */
  days: number;
  metrics: number;
  workouts: number;
  /** Calendar days the range spans, gaps included. */
  spanDays: number;
  /** Days inside the range with nothing in them. A partial import. */
  gapDays: number;
  /** Age of the newest day. Null when there is nothing. */
  ageDays: number | null;
  level: Freshness;
  /** "8 Jul – 2 Aug 2026 · 26 of 31 days" */
  rangeLabel: string;
  /** "Newest reading is 23 days old (2 Aug)." */
  ageLabel: string;
}

export function coverageOf(raw: RawCoverage, today: string): Coverage {
  const first = raw && raw.firstDay ? raw.firstDay : null;
  const last = raw && raw.lastDay ? raw.lastDay : null;
  const days = raw && typeof raw.days === 'number' ? raw.days : 0;
  const span = first && last ? (dayDiff(first, last) ?? 0) + 1 : 0;
  const ageDays = last ? dayDiff(last, today) : null;

  let level: Freshness = 'none';
  if (ageDays !== null) {
    if (ageDays <= 0) level = 'fresh';
    else if (ageDays <= STALE_AFTER_DAYS) level = 'recent';
    else level = 'stale';
  }

  // A negative age means the file carries days after today — a clock
  // disagreement, not data from the future. It is not "fresh", and saying so
  // out loud beats silently clamping it.
  const ahead = ageDays !== null && ageDays < 0;

  const rangeLabel = !first || !last
    ? 'No days imported'
    : first === last
      ? `${formatDay(first, today)} · one day`
      : `${formatDay(first, today)} – ${formatDay(last, today)} · ${
          span > days ? `${days} of ${span} days` : `${days} days`
        }`;

  const ageLabel = ageDays === null
    ? 'Nothing imported yet.'
    : ahead
      ? `The newest day in this import (${formatDay(last, today)}) is later than today — check this Mac's clock.`
      : ageDays === 0
        ? 'The newest reading is from today.'
        : ageDays === 1
          ? 'The newest reading is from yesterday.'
          : `The newest reading is ${ageDays} days old (${formatDay(last, today)}).`;

  return {
    firstDay: first,
    lastDay: last,
    days,
    metrics: raw && typeof raw.metrics === 'number' ? raw.metrics : 0,
    workouts: raw && typeof raw.workouts === 'number' ? raw.workouts : 0,
    spanDays: span,
    gapDays: span > days ? span - days : 0,
    ageDays,
    level: ahead ? 'stale' : level,
    rangeLabel,
    ageLabel,
  };
}

/* ── Cards ────────────────────────────────────────────────────────────────── */

const CATEGORIES: HealthCategory[] = ['heart', 'move', 'sleep', 'body', 'mind', 'care'];

/** Rust's category vocabulary is a subset of the design's; anything else is `body`. */
function categoryOf(name: string): HealthCategory {
  return (CATEGORIES as string[]).includes(name) ? (name as HealthCategory) : 'body';
}

/**
 * The four measurements a person looks for first get a wider card. Everything
 * else is the same size, because ranking the rest would be a judgement about
 * someone's health made by a layout table.
 */
const WIDE = ['steps', 'sleep_asleep_minutes', 'resting_heart_rate_bpm', 'active_energy_kcal'];

/** Cards are grouped, not ranked: move, sleep, heart, body. */
const CATEGORY_ORDER: HealthCategory[] = ['move', 'sleep', 'heart', 'body', 'mind', 'care'];

const STAT_WORD: Record<string, string> = { sum: 'daily total', avg: 'daily average' };

/**
 * The line under the number. Only facts the row actually carries: the day's
 * range, how many readings made it, and which device recorded it.
 *
 * The source matters more than it looks. Two devices log the same walk, the
 * importer keeps the largest single source's total rather than their sum
 * (import.rs), so "8,213 · iPhone" is the honest rendering of a number that a
 * Watch would have counted differently.
 */
export function captionOf(m: RawMetric): string {
  const parts: string[] = [];
  if (m.range) parts.push(m.range);
  if (typeof m.sampleCount === 'number' && m.sampleCount > 1) {
    parts.push(`${m.sampleCount} readings`);
  } else if (STAT_WORD[m.stat]) {
    parts.push(STAT_WORD[m.stat]);
  }
  if (m.source) parts.push(m.source);
  return parts.join(' · ');
}

/**
 * One stored metric as a card.
 *
 * `kind: 'big'` for all of them and no `delta`: the snapshot holds one day per
 * metric, so a sparkline or a trend arrow would have to be made up. `kicker`
 * carries the day — that is the whole anti-fabrication contract of this file.
 */
export function toCard(m: RawMetric, today: string): HealthMetric {
  return {
    id: m.metric,
    name: m.name,
    category: categoryOf(m.category),
    kind: 'big',
    kicker: dayKicker(m.day, today),
    sourceId: EXPORT_SOURCE_ID,
    signalIds: [],
    value: m.value,
    caption: captionOf(m),
    cols: WIDE.includes(m.metric) ? 3 : 2,
    rows_: 1,
  };
}

/** `48 min`, `1h 12m` — the same shape Rust uses for a duration. */
export function minutesLabel(min: number): string {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Recent workouts as one `rows` card, or null when there are none.
 *
 * Null rather than an empty card: a "Workouts" card reading nothing is a claim
 * that the person did not train, and an import that simply predates the gym is
 * not evidence of that.
 */
export function toWorkoutCard(workouts: RawWorkout[], today: string): HealthMetric | null {
  if (!workouts || workouts.length === 0) return null;
  const shown = workouts.slice(0, 5);
  return {
    id: 'workouts',
    name: 'Workouts',
    category: 'move',
    kind: 'rows',
    kicker: dayKicker(shown[0].day, today),
    sourceId: EXPORT_SOURCE_ID,
    signalIds: [],
    value: `${workouts.length} imported`,
    caption: workouts.length > shown.length ? `Showing the ${shown.length} most recent` : 'Most recent first',
    rows: shown.map((w) => ({
      label: `${w.activity} · ${minutesLabel(w.durationMin)}`,
      // Its own day, per workout, for the same reason every card has one.
      value: dayKicker(w.day, today),
    })),
    cols: 3,
    rows_: 2,
  };
}

/* ── The snapshot ─────────────────────────────────────────────────────────── */

/**
 * `HealthSnapshot` plus what a real store knows and a sample never did.
 *
 * It EXTENDS the mock's interface rather than replacing it so `HealthWidget`,
 * `HealthSources` and `metricAvailability` keep compiling against exactly the
 * contract they were written for.
 */
export interface RealHealthSnapshot extends HealthSnapshot {
  hasData: boolean;
  coverage: Coverage;
  sourceRows: RawSource[];
  workoutRows: RawWorkout[];
  /** The card built from `workoutRows`, or null. */
  workoutCard: HealthMetric | null;
}

/** Which of the sources is the export, if it has ever run. */
export function exportSource(raw: RawSnapshot): RawSource | null {
  const rows = raw && Array.isArray(raw.sources) ? raw.sources : [];
  return rows.find((s) => s && s.id === EXPORT_SOURCE_ID) ?? null;
}

/**
 * The whole surface, from the JSON plus today.
 *
 * `signals`, `devices`, `clay` and `primaryDevice` are hardcoded empty here even
 * though Rust already sends them empty. That is deliberate belt-and-braces: if a
 * later backend ever starts populating them, the page still will not render a
 * paired-device story it cannot stand behind until someone comes here and
 * decides to.
 */
export function toSnapshot(raw: RawSnapshot, today: string): RealHealthSnapshot {
  const metrics = Array.isArray(raw.metrics) ? raw.metrics : [];
  const workouts = Array.isArray(raw.workouts) ? raw.workouts : [];
  const cards = metrics
    .map((m) => toCard(m, today))
    .sort((a, b) => {
      const d = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  const workoutCard = toWorkoutCard(workouts, today);

  return {
    capturedAt: raw.capturedAt,
    hasData: !!raw.hasData,
    coverage: coverageOf(raw.coverage, today),
    sourceRows: Array.isArray(raw.sources) ? raw.sources : [],
    workoutRows: workouts,
    workoutCard,
    metrics: workoutCard ? [...cards, workoutCard] : cards,
    // The one source that can exist, in the shape `HealthSources` reads.
    sources: (Array.isArray(raw.sources) ? raw.sources : []).map((s) => ({
      id: s.id,
      name: s.name,
      meta: s.detail ?? '',
      state: s.state,
      // `enabled` is what `metricAvailability` gates a card on. The export is a
      // file that was read, not a feed that can be paused, so it is on whenever
      // it exists — the companion arrives `enabled: false` and stays that way.
      enabled: !!s.enabled,
    })),
    privacy: (Array.isArray(raw.privacy) ? raw.privacy : []).map((p) => ({
      id: p.id,
      name: p.name,
      note: p.note,
      enabled: !!p.enabled,
    })),
    signals: [],
    devices: [],
    clay: [],
    primaryDevice: null,
  };
}

/* ── Why the surface is empty ─────────────────────────────────────────────── */

/**
 * The reasons a person can be looking at nothing. Separate because the NEXT
 * STEP is separate, and "nothing to show" without one is a dead end.
 */
export type EmptyReason =
  | 'desktop_only'  // running in a browser: there is no local store at all
  | 'signed_out'    // no identity, so no store to scope a read to
  | 'loading'
  | 'error'
  | 'no_import'     // the ordinary day-one state
  | 'imported_nothing'; // a file was read and produced no usable rows

export function emptyReason(s: {
  supported: boolean;
  userId: string | null;
  loading: boolean;
  error: string | null;
  snapshot: RealHealthSnapshot | null;
}): EmptyReason | null {
  if (!s.supported) return 'desktop_only';
  if (!s.userId) return 'signed_out';
  if (s.error) return 'error';
  if (!s.snapshot) return s.loading ? 'loading' : 'error';
  if (s.snapshot.hasData) return null;
  const src = s.snapshot.sourceRows.find((r) => r.id === EXPORT_SOURCE_ID);
  // An import that ran and left nothing behind is a different problem from
  // never having imported: the file was the wrong one, or every record in it
  // used a unit Atlas refuses to guess at.
  return src ? 'imported_nothing' : 'no_import';
}

/** One sentence about what an import did, for the strip after it finishes. */
export function describeReport(r: ImportReport, today: string): string {
  if (!r) return '';
  const bits: string[] = [];
  bits.push(`${r.days} ${r.days === 1 ? 'day' : 'days'} from ${r.fileName}`);
  if (r.firstDay && r.lastDay) {
    bits.push(
      r.firstDay === r.lastDay
        ? formatDay(r.firstDay, today)
        : `${formatDay(r.firstDay, today)} – ${formatDay(r.lastDay, today)}`,
    );
  }
  if (r.workouts > 0) bits.push(`${r.workouts} workouts`);
  if (r.recordsRejected > 0) {
    const why = (r.rejectionReasons ?? [])
      .map((x) => `${x.count} ${x.reason}`)
      .join(', ');
    // Never a silent skip: an import that used 4 of 40,000 records leaves
    // somebody staring at an empty year with no idea why.
    bits.push(`${r.recordsRejected} records skipped${why ? ` (${why})` : ''}`);
  }
  return bits.join(' · ');
}

/* ── The hook ─────────────────────────────────────────────────────────────── */

export const DESKTOP_ONLY =
  'Health data lives in Atlas’ own database on your Mac, so this screen only works in the desktop app.';

export interface UseHealth extends Omit<UseAtlasHealth, 'snapshot'> {
  snapshot: RealHealthSnapshot | null;
  /** False in a browser: there is no local store to read. */
  supported: boolean;
  reason: EmptyReason | null;
  /** Import is running; the surface must not offer a second one. */
  importing: boolean;
  /** What the last import did, until the next navigation. */
  report: ImportReport | null;
  importFromPath: (path: string) => Promise<void>;
  /** Deletes every health row this account has. Not reachable by Atlas itself. */
  forget: () => Promise<void>;
  /** Local calendar day, YYYY-MM-DD — the reference every label is relative to. */
  today: string;
}

/** Today in the user's own calendar, not UTC. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Milliseconds until the next local midnight, clamped to at least a second.
 *
 * `today` is what every card's kicker is computed against — "Today",
 * "Yesterday", "6 days ago" — and it was only ever re-stamped inside a
 * successful read. Nothing schedules a read, so a window left open across
 * midnight went on labelling the previous day's step count "Today" until the
 * user happened to navigate away and back. The comment above the re-stamp said
 * this could not happen; this is what makes that true.
 *
 * Computed from the wall clock rather than added to it, so a DST change (a
 * 23- or 25-hour day) still lands on midnight rather than an hour either side.
 */
export function msUntilLocalMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1000, next.getTime() - now.getTime());
}

async function tauriInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke(cmd, args);
}

function messageOf(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return 'Atlas could not read the health store.';
}

export const useHealth = (invokeFn?: InvokeFn): UseHealth => {
  const { user } = useAuth();
  const userId: string | null = user ? user.id : null;
  const supported = isTauri() || !!invokeFn;

  const [raw, setRaw] = useState<RawSnapshot | null>(null);
  // Starts true: the first paint happens before the effect runs, and a page that
  // reads "no data" for one frame before the store answers is a lie with a short
  // lifetime rather than no lie.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [today, setToday] = useState(localToday());

  // The injected `invoke` must not re-trigger the load effect when a caller
  // passes an inline function; it is identity, not state.
  const invokeRef = useRef<InvokeFn>(invokeFn ?? tauriInvoke);
  invokeRef.current = invokeFn ?? tauriInvoke;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!supported) { setError(DESKTOP_ONLY); return; }
    if (!userId) return;
    setLoading(true);
    try {
      const next = (await invokeRef.current(HEALTH_SNAPSHOT_COMMAND, { userId })) as RawSnapshot;
      if (!alive.current) return;
      setRaw(next);
      setError(null);
      // Re-stamped on every read: a window left open overnight would otherwise
      // keep calling yesterday "Today" until it was reloaded.
      setToday(localToday());
    } catch (e) {
      if (!alive.current) return;
      setError(messageOf(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [supported, userId]);

  useEffect(() => {
    if (!supported) { setError(DESKTOP_ONLY); return; }
    setError(null);
    void refresh();
  }, [refresh, supported]);

  /**
   * Midnight. No invoke — the kickers are a pure function of `today`, so the
   * date advancing is enough to relabel every card, and a health store does not
   * need re-reading just because the clock rolled over. Re-arms itself, so a
   * window left open for a week keeps up.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (!alive.current) return;
        setToday(localToday());
        arm();
      }, msUntilLocalMidnight());
    };
    arm();
    return () => clearTimeout(timer);
  }, [today]);

  const importFromPath = useCallback(async (path: string) => {
    if (!supported) { setError(DESKTOP_ONLY); return; }
    if (!userId) { setError('Sign in first — health data is stored per account.'); return; }
    const trimmed = (path ?? '').trim();
    if (!trimmed) {
      setError('Choose the export.zip you saved from the Health app on your iPhone.');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const r = (await invokeRef.current(HEALTH_IMPORT_COMMAND, { userId, path: trimmed })) as ImportReport;
      if (!alive.current) return;
      setReport(r);
      await refresh();
    } catch (e) {
      if (!alive.current) return;
      setError(messageOf(e));
    } finally {
      if (alive.current) setImporting(false);
    }
  }, [refresh, supported, userId]);

  const forget = useCallback(async () => {
    if (!supported || !userId) return;
    try {
      await invokeRef.current(HEALTH_FORGET_COMMAND, { userId });
      if (!alive.current) return;
      setReport(null);
      await refresh();
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    }
  }, [refresh, supported, userId]);

  const snapshot = useMemo<RealHealthSnapshot | null>(
    () => (raw ? toSnapshot(raw, today) : null),
    [raw, today],
  );

  const reason = emptyReason({ supported, userId, loading, error, snapshot });

  /**
   * The two switches the mock contract owes. THEY DO NOTHING HERE, and nothing
   * on the page calls them: the only source is a file that was already read, so
   * "pause this source" would be a control with no state behind it. The page
   * renders sources as rows, not toggles, for exactly that reason.
   */
  const setSourceEnabled = useCallback(() => {}, []);
  const setSignalEnabled = useCallback(() => {}, []);

  return {
    snapshot,
    loading,
    error,
    // The one line that takes the sample chrome off the page.
    isMock: false,
    supported,
    reason,
    importing,
    report,
    today,
    setSourceEnabled,
    setSignalEnabled,
    refresh,
    importFromPath,
    forget,
  };
};

export default useHealth;
