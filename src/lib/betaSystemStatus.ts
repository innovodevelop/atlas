/**
 * The Beta System Status screen's arithmetic (`Atlas System Status Beta.dc.html`):
 * the headline from the probes, the tiles' formats, the battery rings, the
 * latency sparklines, the "On this Mac" bars and the "Recently" feed. Pure
 * and tested here, rendered by BetaSystemStatus.tsx.
 *
 * One thing here is not pure: the probe history. The brain's health answer
 * carries only the latest probe, and the Workshop page kept no history, so
 * the sparklines would have been a single bar. This module keeps the last
 * `MAX_SAMPLES` probes per service for the session, in a store the page
 * records into on every poll and reads with `useSyncExternalStore`. Every bar
 * is a real check this window made; nothing is back-filled.
 */
import type { QuickSphereState } from '@/lib/quickSphere';
import type { IconName } from '@/components/atlas/icons';

// ---- Shapes the page hands in (mirrors src/hooks/useSystemStatus.ts) --------

export interface ProbeService {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  latency_ms: number | null;
  last_check: string;
  error?: string;
}

export interface ProbeSample {
  /** `Date.now()` when the probe was recorded. */
  at: number;
  latency: number | null;
  ok: boolean;
}

export interface Headline { headline: string; sub: string }

// ---- Services ----------------------------------------------------------------

export const BRAIN = 'atlas-brain';
export const VOICE = 'voice-gateway';

/** What the design calls each probe, and where its latency comes from. */
export function serviceMeta(name: string): { label: string; desc: string } {
  switch (name) {
    case BRAIN: return { label: 'Brain', desc: 'Chat, memory and tools · answer time measured from this screen' };
    case VOICE: return { label: 'Voice', desc: 'Wake word and speech · probed by the brain' };
    default: return { label: name, desc: 'Probed by the brain' };
  }
}

export function serviceDown(s: ProbeService): boolean {
  return s.status !== 'healthy';
}

/**
 * The brain reports its own latency as 0 (it answers the request itself), so
 * the page measures the round trip of the health call and this swaps it in.
 * The brain probes the other services inside that same request, one after
 * the other, so their time is taken back out: what is left is the brain's own.
 */
export function withRoundTrip(services: readonly ProbeService[], roundTripMs: number | null): ProbeService[] {
  if (roundTripMs == null) return [...services];
  const others = services.reduce((sum, s) => (s.name !== BRAIN && s.latency_ms != null ? sum + s.latency_ms : sum), 0);
  const own = Math.max(1, Math.round(roundTripMs - others));
  return services.map((s) => (s.name === BRAIN ? { ...s, latency_ms: own } : s));
}

// ---- Headline and sphere -----------------------------------------------------

export interface SummaryInput {
  checking: boolean;
  loading: boolean;
  error: string | null;
  services: readonly ProbeService[] | null;
  unresolvedErrors: number;
}

export function sphereStateFor(i: SummaryInput): QuickSphereState {
  if (i.checking || (i.loading && !i.error)) return 'working';
  if (i.error) return 'alert';
  if (i.services?.some(serviceDown)) return 'alert';
  return 'success';
}

export function summarise(i: SummaryInput): Headline {
  if (i.checking) return { headline: 'Checking everything…', sub: 'Pinging the brain, the voice gateway and this Mac.' };
  if (i.error) return { headline: "Atlas's brain isn't answering.", sub: `${clip(i.error, 160).replace(/[.…]?$/, '.')} Check again once the app has started it.` };
  if (i.loading || !i.services) return { headline: 'Checking everything…', sub: 'First look at the brain and the voice gateway.' };
  const down = i.services.filter(serviceDown);
  const errNote = i.unresolvedErrors > 0 ? ` ${i.unresolvedErrors} unresolved ${i.unresolvedErrors === 1 ? 'error' : 'errors'} in the last 24 hours — see Recently.` : '';
  if (down.length === 0) return { headline: 'Everything is working.', sub: `The brain and the voice gateway answered normally.${errNote}` };
  if (down.length === 1) {
    const d = down[0];
    const { label } = serviceMeta(d.name);
    return { headline: `${label} isn't answering. Everything else is fine.`, sub: `${label} ${d.error ? `answered ${d.error}` : `is ${d.status}`}. The rest responded normally.${errNote}` };
  }
  return { headline: `${down.length} services aren't answering.`, sub: `${down.map((d) => serviceMeta(d.name).label).join(', ')} did not respond.${errNote}` };
}

// ---- Formats -----------------------------------------------------------------

/** "14 days", "3 h 12 m", "48 s" — the brain's uptime at the grain a glance needs. */
export function uptimeText(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const d = Math.floor(seconds / 86_400), h = Math.floor((seconds % 86_400) / 3600), m = Math.floor((seconds % 3600) / 60);
  if (d >= 1) return `${d} ${d === 1 ? 'day' : 'days'}`;
  if (h >= 1) return `${h} h ${m} m`;
  return `${m} m`;
}

export function latencyText(ms: number | null, ok: boolean): string {
  if (!ok) return 'down';
  if (ms == null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

export function clockText(at: number | null): string {
  if (at == null) return '—';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function countText(n: number | null): string {
  return n == null ? '—' : n.toLocaleString();
}

// ---- Battery rings -----------------------------------------------------------

/** The ring's circumference at r=23 in a 54-box, as the design draws it. */
export const RING_C = 144.5;

export function ringOffset(percent: number | null): string {
  if (percent == null) return RING_C.toFixed(1);
  const p = Math.min(100, Math.max(0, percent));
  return (RING_C * (1 - p / 100)).toFixed(1);
}

/** Green when fine or charging, blue when comfortable, orange when low, red when nearly out. */
export function batteryColour(percent: number | null, charging = false): string {
  if (percent == null) return '#b6b1aa';
  if (charging || percent >= 70) return '#0fae76';
  if (percent >= 50) return '#3461f2';
  if (percent >= 25) return '#e07a1f';
  return '#d0453a';
}

/** The glyph for a Bluetooth device, from system_profiler's minor type and the name. */
export function deviceIcon(kind: string | null, name: string): IconName {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('headphone') || k.includes('headset') || /airpods|beats/i.test(name)) return 'airpods';
  if (k.includes('keyboard')) return 'keyboard';
  if (k.includes('mouse') || k.includes('trackpad')) return 'trackpad';
  if (k.includes('speaker')) return 'speaker';
  if (k.includes('phone') || /iphone/i.test(name)) return 'iphone';
  if (k.includes('watch') || /watch/i.test(name)) return 'watch';
  if (k.includes('display') || k.includes('monitor')) return 'display';
  return 'bluetooth';
}

export function deviceLine(kind: string | null, percent: number | null): string {
  const k = kind ?? 'Bluetooth';
  return percent == null ? `${k} · no battery reading` : `${percent}% · ${k}`;
}

export interface BatteryLike { percent: number; charging: boolean; on_power: boolean; remaining: string | null }

/** "charging", "on power", pmset's "3:12 remaining", or plain "on battery". */
export function batteryState(b: BatteryLike | null): string {
  if (!b) return 'no battery · mains power';
  return b.charging ? 'charging' : b.on_power ? 'on power' : b.remaining ?? 'on battery';
}

export function macLine(b: BatteryLike | null): string {
  return b ? `This Mac · ${b.percent}% · ${batteryState(b)}` : `This Mac · ${batteryState(null)}`;
}

// ---- Latency sparklines ------------------------------------------------------

export const MAX_SAMPLES = 12;

export function pushSample(list: readonly ProbeSample[], sample: ProbeSample, max = MAX_SAMPLES): ProbeSample[] {
  const next = [...list, sample];
  return next.length > max ? next.slice(next.length - max) : next;
}

export interface Bar { h: string | null; c: string }

/**
 * Twelve slots, oldest left. Empty slots stay empty rather than being
 * invented; a failed probe is a full orange bar; the rest scale against the
 * slowest sample so a spike reads as a spike.
 */
export function barsOf(samples: readonly ProbeSample[], slots = MAX_SAMPLES): Bar[] {
  const recent = samples.slice(-slots);
  const peak = Math.max(1, ...recent.map((s) => (s.ok && s.latency != null ? s.latency : 0)));
  const bars: Bar[] = recent.map((s) => {
    if (!s.ok) return { h: '95%', c: '#e07a1f' };
    if (s.latency == null) return { h: '30%', c: '#d8d4cd' };
    return { h: `${Math.max(14, Math.round((s.latency / peak) * 100))}%`, c: '#d8d4cd' };
  });
  while (bars.length < slots) bars.unshift({ h: null, c: 'transparent' });
  return bars;
}

export function samplesCaption(n: number): string {
  if (n <= 0) return 'No checks yet this session.';
  if (n === 1) return 'One check so far this session; bars fill in every 10 s while this screen is open.';
  return `Latency from the last ${n} checks this session, every 10 s while this screen is open.`;
}

// ---- The probe history store -------------------------------------------------

type History = Readonly<Record<string, readonly ProbeSample[]>>;
let history: History = {};
let lastAt = -Infinity;
const listeners = new Set<() => void>();

/**
 * Records one poll. A poll is identified by when it arrived, so the same
 * answer handed in twice — React's development double effects, or the page
 * remounting over the cached answer — stays one bar, and nothing older than
 * the newest recorded poll can slip in behind it.
 */
export function recordProbe(services: readonly ProbeService[], at = Date.now()): void {
  if (at <= lastAt) return;
  lastAt = at;
  const next: Record<string, readonly ProbeSample[]> = { ...history };
  for (const s of services) {
    next[s.name] = pushSample(history[s.name] ?? [], { at, latency: s.latency_ms, ok: !serviceDown(s) });
  }
  history = next;
  listeners.forEach((l) => l());
}

export function getProbeHistory(): History {
  return history;
}

export function subscribeProbeHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function _resetProbeHistory(): void {
  history = {};
  lastAt = -Infinity;
  listeners.clear();
}

// ---- Counters ----------------------------------------------------------------

export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** `YYYY-MM-DD` in local time, the key `atlas_usage_history.date` is written with. */
export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function countToday<T extends { created_at: string }>(rows: readonly T[], now: Date): T[] {
  const start = startOfDay(now).getTime();
  return rows.filter((r) => { const t = new Date(r.created_at).getTime(); return !Number.isNaN(t) && t >= start; });
}

export interface UsageRow { provider: string; total_calls: number; failed_calls: number }

export function sumUsage(rows: readonly UsageRow[]): { total: number; failed: number; providers: number } | null {
  if (!rows.length) return null;
  return {
    total: rows.reduce((a, r) => a + (Number(r.total_calls) || 0), 0),
    failed: rows.reduce((a, r) => a + (Number(r.failed_calls) || 0), 0),
    providers: new Set(rows.map((r) => r.provider)).size,
  };
}

// ---- On this Mac -------------------------------------------------------------

export interface TableInfo { name: string; rows: number }
export interface StoreBar { k: string; v: string; w: string; c: string }

const STORE_COLOURS = ['#8fa9ff', '#50dca0', '#ffb36b', '#b6a8ff', '#ff9a9a', '#9ad7ff'];

/** The fullest tables of atlas.db, widest first. Rows, not bytes: no command measures bytes yet. */
export function storageBars(tables: readonly TableInfo[], top = 6): StoreBar[] {
  const live = tables.filter((t) => t.rows > 0).sort((a, b) => b.rows - a.rows).slice(0, top);
  const max = live[0]?.rows ?? 1;
  return live.map((t, i) => ({
    k: t.name.replace(/_/g, ' '),
    v: `${t.rows.toLocaleString()} rows`,
    w: `${Math.max(2, Math.round((t.rows / max) * 100))}%`,
    c: STORE_COLOURS[i % STORE_COLOURS.length],
  }));
}

// ---- Recently ----------------------------------------------------------------

export interface ErrorRow { id: string; error_message: string; severity: 'critical' | 'error' | 'warning' | 'info'; resolved: boolean; created_at: string }
export interface ToolCallRow { id: string; tool_name: string; status: string; created_at: string }
export interface RepairRow { id: string; status: string; diagnosis: string | null; created_at: string }

export interface RecentEvent {
  id: string;
  kind: 'error' | 'action' | 'repair';
  at: number;
  t: string;
  m: string;
  c: string;
  /** The error row behind an unresolved error event, so the row can offer Resolve and Repair. */
  errorId?: string;
}

/** "09:42" today, "Yesterday", else "12 Oct". */
export function eventTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = startOfDay(now);
  const that = startOfDay(d).getTime();
  if (that === today.getTime()) return clockText(d.getTime());
  // Calendar arithmetic, not 86 400 000 ms: a day with a clock change is not 24 h long.
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (that === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function recentEvents(errors: readonly ErrorRow[], calls: readonly ToolCallRow[], repairs: readonly RepairRow[], now: Date, limit = 8): RecentEvent[] {
  const out: RecentEvent[] = [];
  for (const e of errors) {
    const at = new Date(e.created_at).getTime();
    if (Number.isNaN(at)) continue;
    const c = e.resolved ? '#8b8681' : e.severity === 'warning' ? '#e07a1f' : e.severity === 'info' ? '#8b8681' : '#d0453a';
    out.push({ id: `e-${e.id}`, kind: 'error', at, t: eventTime(e.created_at, now), m: clip(e.error_message, 90), c, errorId: e.resolved ? undefined : e.id });
  }
  for (const t of calls) {
    const at = new Date(t.created_at).getTime();
    if (Number.isNaN(at)) continue;
    const c = t.status === 'failed' || t.status === 'rejected' ? '#d0453a' : t.status === 'completed' || t.status === 'approved' ? '#3461f2' : '#e07a1f';
    out.push({ id: `t-${t.id}`, kind: 'action', at, t: eventTime(t.created_at, now), m: `${t.tool_name} · ${t.status.replace(/_/g, ' ')}`, c });
  }
  for (const r of repairs) {
    const at = new Date(r.created_at).getTime();
    if (Number.isNaN(at)) continue;
    const c = r.status === 'verified' ? '#0fae76' : r.status === 'failed' || r.status === 'rejected' ? '#d0453a' : '#3461f2';
    out.push({ id: `r-${r.id}`, kind: 'repair', at, t: eventTime(r.created_at, now), m: `Repair ${r.status}${r.diagnosis ? ` · ${clip(r.diagnosis, 60)}` : ''}`, c });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
