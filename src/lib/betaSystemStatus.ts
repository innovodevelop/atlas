/**
 * The Beta System Status screen's arithmetic (`Atlas System Status Beta.dc.html`):
 * the headline from the probes, the tiles' formats, the battery rings, the
 * latency sparklines, the "On this Mac" bars and the "Recently" feed. Pure
 * and tested here, rendered by BetaSystemStatus.tsx.
 *
 * One thing here is not pure: the probe history. The brain's health answer
 * carries only the latest probe, so this module keeps the last `MAX_SAMPLES`
 * probes per service in a store the page records into on every check and
 * reads with `useSyncExternalStore`. Every bar is a real check this Mac made;
 * nothing is back-filled. The store is mirrored to localStorage (capped by
 * count and age) so a reload does not wipe the sparklines (row 76); without
 * storage it simply lives for the session.
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
  /** The row's sentence when the probe brings its own (the AI provider, mail, Home Assistant). */
  detail?: string;
  /** Nothing to check (no mailbox, no bridge linked): a grey dot, never an outage. */
  idle?: boolean;
  /** The right-hand figure when it is not a latency ("OK", "off"). */
  value?: string;
  /** Measured before this request (the brain's minute-long AI probe cache), so not part of its round trip. */
  cached?: boolean;
}

export interface ProbeSample {
  /** When the probe ran, in `Date.now()` time (see `probeTime`). */
  at: number;
  latency: number | null;
  ok: boolean;
}

export interface Headline { headline: string; sub: string }

// ---- Services ----------------------------------------------------------------

export const BRAIN = 'atlas-brain';
export const VOICE = 'voice-gateway';
export const AI_PROVIDER = 'ai-provider';
export const MAIL = 'mail';
export const HOME_ASSISTANT = 'home-assistant';

/** What the design calls each probe, and where its latency comes from. */
export function serviceMeta(name: string): { label: string; desc: string } {
  switch (name) {
    case BRAIN: return { label: 'Brain', desc: 'Chat, memory and tools · answer time measured from this screen' };
    case VOICE: return { label: 'Voice', desc: 'Wake word and speech · probed by the brain' };
    case AI_PROVIDER: return { label: 'Reasoning', desc: 'The AI provider · checked by the brain without spending tokens' };
    case MAIL: return { label: 'Mail', desc: 'Mailbox sync on this Mac' };
    case HOME_ASSISTANT: return { label: 'Home Assistant', desc: 'The linked bridge on your network' };
    default: return { label: name, desc: 'Probed by the brain' };
  }
}

/** The row's sentence: the probe's own detail when it has one. */
export function serviceDesc(s: ProbeService): string {
  const base = s.detail ?? serviceMeta(s.name).desc;
  return serviceDown(s) && s.error && !base.includes(s.error) ? `${base} · ${s.error}` : base;
}

export function serviceDown(s: ProbeService): boolean {
  return !s.idle && s.status !== 'healthy';
}

/** The right-hand column: latency where it was measured, else what is known. */
export function valueText(s: ProbeService): string {
  if (s.idle) return s.value ?? 'off';
  if (serviceDown(s)) return s.status === 'degraded' ? (s.value ?? 'check') : 'down';
  if (s.latency_ms == null && s.value) return s.value;
  return latencyText(s.latency_ms, true);
}

/**
 * The brain reports its own latency as 0 (it answers the request itself), so
 * the page measures the round trip of the health call and this swaps it in.
 * The brain probes the other services inside that same request, one after
 * the other, so their time is taken back out: what is left is the brain's own.
 * A probe that failed still took its time (one that timed out, the whole
 * wait) and is taken out like any other. A probe answered from the brain's
 * cache was not run in this request and is not taken out.
 */
export function withRoundTrip(services: readonly ProbeService[], roundTripMs: number | null): ProbeService[] {
  if (roundTripMs == null) return [...services];
  const others = services.reduce((sum, s) => (s.name !== BRAIN && !s.cached && s.latency_ms != null ? sum + s.latency_ms : sum), 0);
  const own = Math.max(1, Math.round(roundTripMs - others));
  return services.map((s) => (s.name === BRAIN ? { ...s, latency_ms: own } : s));
}

// ---- Local services: mail and Home Assistant (row 75) ----------------------------

/** The `mail_accounts` columns the Mail row reads. */
export interface MailAccountRow {
  email_address: string;
  provider: string;
  status: 'active' | 'error' | 'disconnected' | string;
  last_error: string | null;
  last_synced_at: string | null;
}

/** "now", "4 min ago", "3 h ago", "2 days ago". */
export function agoText(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'never';
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/**
 * Mail as a service row, from what the sync already stores: an account the
 * last sync failed on is a problem worth the headline; no account is simply
 * nothing to check. Mail is not probed over the network from here — the sync
 * owns that — so the row has no latency, only "OK".
 */
export function mailService(accounts: readonly MailAccountRow[], now: Date): ProbeService {
  const at = now.toISOString();
  const live = accounts.filter((a) => a.status !== 'disconnected');
  if (!live.length) {
    return { name: MAIL, status: 'healthy', latency_ms: null, last_check: at, idle: true, value: 'off', detail: accounts.length ? 'Every mailbox is disconnected · reconnect in Mail' : 'No mailbox connected' };
  }
  const failing = live.filter((a) => a.status === 'error' || !!a.last_error);
  const newest = live.map((a) => a.last_synced_at).filter((t): t is string => !!t).sort().pop() ?? null;
  const count = `${live.length} ${live.length === 1 ? 'account' : 'accounts'}`;
  if (failing.length) {
    const f = failing[0];
    const err = clip(f.last_error ?? 'the last sync failed', 90);
    return {
      name: MAIL, status: 'degraded', latency_ms: null, last_check: at, value: failing.length === live.length ? 'failing' : `${failing.length} failing`,
      error: err, detail: `${failing.length} of ${count} failing · ${f.email_address}: ${err}`,
    };
  }
  return { name: MAIL, status: 'healthy', latency_ms: null, last_check: at, value: 'OK', detail: `${count} · last fetch ${agoText(newest, now)}` };
}

/** `system_probe_home_assistant`'s answer (src-tauri/src/system_status.rs). */
export interface HaProbe {
  linked: boolean;
  name?: string;
  devices?: number;
  ok?: boolean;
  latency_ms?: number | null;
  error?: string | null;
  checked_at?: string;
}

export function homeAssistantService(p: HaProbe, now: Date): ProbeService {
  const at = p.checked_at ?? now.toISOString();
  if (!p.linked) {
    return { name: HOME_ASSISTANT, status: 'healthy', latency_ms: null, last_check: at, idle: true, value: 'off', detail: 'No bridge linked · link one in Smart Home' };
  }
  const devices = p.devices ?? 0;
  const where = `${devices} ${devices === 1 ? 'device' : 'devices'} · ${p.name ?? 'Home Assistant'}`;
  if (p.ok) return { name: HOME_ASSISTANT, status: 'healthy', latency_ms: p.latency_ms ?? null, last_check: at, detail: `${where} · local network` };
  return { name: HOME_ASSISTANT, status: 'down', latency_ms: p.latency_ms ?? null, last_check: at, error: p.error ?? 'not answering', detail: where };
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
  if (i.checking) return { headline: 'Checking everything…', sub: 'Pinging the brain, the voice gateway, the AI provider, mail and Home Assistant.' };
  if (i.error) return { headline: "Atlas's brain isn't answering.", sub: `${clip(i.error, 160).replace(/[.…]?$/, '.')} Check again once the app has started it.` };
  if (i.loading || !i.services) return { headline: 'Checking everything…', sub: 'First look at the brain, the voice gateway and the AI provider.' };
  const down = i.services.filter(serviceDown);
  const errNote = i.unresolvedErrors > 0 ? ` ${i.unresolvedErrors} unresolved ${i.unresolvedErrors === 1 ? 'error' : 'errors'} in the last 24 hours — see Recently.` : '';
  if (down.length === 0) return { headline: 'Everything is working.', sub: `Every service answered normally.${errNote}` };
  if (down.length === 1) {
    const d = down[0];
    const { label } = serviceMeta(d.name);
    const verb = d.status === 'degraded' ? 'needs a look' : "isn't answering";
    return { headline: `${label} ${verb}. Everything else is fine.`, sub: `${label}: ${clip(d.error ?? d.status, 140).replace(/[.…]?$/, '.')} The rest responded normally.${errNote}` };
  }
  return { headline: `${down.length} services need a look.`, sub: `${down.map((d) => serviceMeta(d.name).label).join(', ')} did not answer normally.${errNote}` };
}

// ---- Formats -----------------------------------------------------------------

/** "14 days", "3 h 12 m", "48 s" — an uptime at the grain a glance needs. */
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
/** Older samples are dropped on load: a week-old spike is not "recent". */
export const MAX_SAMPLE_AGE_MS = 7 * 86_400_000;

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
  if (n <= 0) return 'No checks yet.';
  if (n === 1) return 'One check so far; the bars fill in as this screen keeps checking.';
  return `Latency from the last ${n} checks, kept on this Mac across reloads. The brain is checked every 10 s while this screen is open, the AI provider once a minute.`;
}

// ---- The probe history store -------------------------------------------------

type History = Readonly<Record<string, readonly ProbeSample[]>>;

export const PROBE_HISTORY_KEY = 'atlas:system_probe_history';

interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

let history: History = {};
let lastAt: Record<string, number> = {};
let loaded = false;
let storageOverride: KeyValueStore | null | undefined;
const listeners = new Set<() => void>();

function storage(): KeyValueStore | null {
  if (storageOverride !== undefined) return storageOverride;
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** Parse what was saved, keeping only well-formed, recent samples, at most MAX_SAMPLES per service. */
export function parseHistory(raw: string | null, now = Date.now()): Record<string, ProbeSample[]> {
  if (!raw) return {};
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out: Record<string, ProbeSample[]> = {};
  for (const [name, list] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const samples = list
      .filter((s): s is ProbeSample => !!s && typeof s === 'object'
        && typeof (s as ProbeSample).at === 'number' && typeof (s as ProbeSample).ok === 'boolean'
        && ((s as ProbeSample).latency === null || typeof (s as ProbeSample).latency === 'number'))
      .filter((s) => now - s.at <= MAX_SAMPLE_AGE_MS && s.at <= now + 60_000)
      .map((s) => ({ at: s.at, latency: s.latency, ok: s.ok }))
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_SAMPLES);
    if (samples.length) out[name] = samples;
  }
  return out;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const saved = parseHistory(storage()?.getItem(PROBE_HISTORY_KEY) ?? null);
    // Anything recorded before the load (there is nothing, normally) wins.
    history = { ...saved, ...history };
    for (const [name, list] of Object.entries(history)) lastAt[name] = Math.max(lastAt[name] ?? -Infinity, list[list.length - 1]?.at ?? -Infinity);
  } catch { /* unreadable storage: this session only */ }
}

function persist(): void {
  try { storage()?.setItem(PROBE_HISTORY_KEY, JSON.stringify(history)); } catch { /* full or private: this session only */ }
}

/**
 * When the check behind `s` ran. A service the brain may answer from its cache
 * says so (`cached`, true or false: the AI provider, probed at most once a
 * minute while the health route is polled every 10 s), and is keyed on its own
 * probe time, so one probe handed out to six polls is one bar. Every other
 * service is checked in the request that carried it: when that answer arrived.
 */
export function probeTime(s: ProbeService, arrivedAt: number): number {
  if (s.cached === undefined) return arrivedAt;
  const probed = Date.parse(s.last_check);
  return Number.isFinite(probed) ? probed : arrivedAt;
}

/**
 * Records one check of some services. A check is identified per service by
 * when it ran (`probeTime`), so the same answer handed in twice — React's
 * development double effects, the page remounting over the cached answer, or
 * the brain repeating its cached AI probe — stays one bar, and nothing older
 * than a service's newest bar can slip in behind it. Services are checked on
 * different clocks (the brain every 10 s, the AI provider and Home Assistant
 * every minute), which is why the guard is per service.
 */
export function recordProbe(services: readonly ProbeService[], at = Date.now()): void {
  ensureLoaded();
  const next: Record<string, readonly ProbeSample[]> = { ...history };
  let changed = false;
  for (const s of services) {
    if (s.idle) continue;
    const t = probeTime(s, at);
    if (t <= (lastAt[s.name] ?? -Infinity)) continue;
    lastAt[s.name] = t;
    next[s.name] = pushSample(history[s.name] ?? [], { at: t, latency: s.latency_ms, ok: !serviceDown(s) });
    changed = true;
  }
  if (!changed) return;
  history = next;
  persist();
  listeners.forEach((l) => l());
}

export function getProbeHistory(): History {
  ensureLoaded();
  return history;
}

export function subscribeProbeHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests: forget everything, and use `store` (or no storage at all) from now on. */
export function _resetProbeHistory(store: KeyValueStore | null = null): void {
  history = {};
  lastAt = {};
  loaded = false;
  storageOverride = store;
  listeners.clear();
}

// ---- Counters ----------------------------------------------------------------

export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function countToday<T extends { created_at: string }>(rows: readonly T[], now: Date): T[] {
  const start = startOfDay(now).getTime();
  return rows.filter((r) => { const t = new Date(r.created_at).getTime(); return !Number.isNaN(t) && t >= start; });
}

/** The part of the brain's `/admin/model-calls` answer the Model calls tile reads (rows 72, 77). */
export interface ModelCallsToday {
  today: { since: string; calls: number; failed: number };
  recording_since: string | null;
}

/** The Model calls tile: today's count from the brain's ledger, or why there is none. */
export function modelCallsTile(native: boolean, s: ModelCallsToday | null, error: string | null): { v: string; d: string } {
  if (!native) return { v: '—', d: 'Only in the Mac app' };
  if (!s) return { v: '—', d: error ? 'The brain’s ledger is unreadable' : 'Reading…' };
  const { calls, failed } = s.today;
  if (!s.recording_since) return { v: '0', d: 'none yet · the brain records every call' };
  return { v: countText(calls), d: failed ? `${failed} failed · since midnight` : 'none failed · since midnight' };
}

// ---- Versions: uptime since the last update, install and update events (row 78) ----

export interface VersionRow { version: string; previous_version: string | null; first_seen_at: string }
export interface AppHistory { bundle_id: string; version: string; history: VersionRow[] }

/** How long this version has been running here, and the tile's sentence; null when it was never recorded. */
export function versionUptime(h: AppHistory | null, now: Date): { seconds: number; d: string } | null {
  const current = h?.history[0];
  if (!h || !current || current.version !== h.version) return null;
  const t = new Date(current.first_seen_at).getTime();
  if (Number.isNaN(t)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - t) / 1000));
  return { seconds, d: current.previous_version ? `since the update to ${h.version}` : `on ${h.version} · since its first launch on record` };
}

export function versionMessage(v: VersionRow): string {
  return v.previous_version ? `Atlas ${v.version} installed · was ${v.previous_version}` : `Atlas ${v.version} · first launch on record`;
}

// ---- On this Mac (row 79) -----------------------------------------------------------

/** `system_storage`'s answer (src-tauri/src/system_status.rs). Bytes throughout. */
export interface StorageReport {
  database: { bytes: number; wal_bytes: number };
  parts: { memory: number; mail: number; audit: number; other: number } | null;
  parts_error: string | null;
  /**
   * The model files: the brain's embedder, the voice gateway's VAD and the
   * wake word — never the sidecar binaries that carry the first two. `build`:
   * as counted when this build was made (inside the sidecars they cannot be
   * measured apart); `checkout`: the model folders, measured now.
   */
  models: { bytes: number; source: 'build' | 'checkout' } | null;
  /** Why there is no models figure. */
  models_error?: string | null;
  measured_at: string;
}

export interface StoreBar { k: string; v: string; w: string; c: string; title: string }

/** Decimal units, as Finder counts: "412 MB", "1.9 GB", "0.3 MB". */
export function bytesText(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '0 MB';
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 10e6) return `${Math.round(b / 1e6)} MB`;
  return `${(b / 1e6).toFixed(1)} MB`;
}

/**
 * The design's rows — memory, the audit trail, the mail cache, the models —
 * after atlas.db as a whole, which the first three are parts of. Widths are
 * against the largest row; a row whose figure could not be measured is left
 * out rather than drawn as zero.
 */
export function storageBars(r: StorageReport): StoreBar[] {
  const rows: Array<{ k: string; b: number; c: string; title: string }> = [
    { k: 'atlas.db', b: r.database.bytes, c: '#9ad7ff', title: 'The whole database file, with its write-ahead log' },
  ];
  if (r.parts) {
    rows.push(
      { k: 'Memory', b: r.parts.memory, c: '#8fa9ff', title: 'Memories, their vectors and the keyword index · part of atlas.db' },
      { k: 'Audit trail', b: r.parts.audit, c: '#50dca0', title: 'Tool calls, approvals and mail actions · part of atlas.db' },
      { k: 'Mail cache', b: r.parts.mail, c: '#ffb36b', title: 'Mailboxes, messages, threads and drafts · part of atlas.db' },
    );
  }
  if (r.models) {
    rows.push({
      k: 'Models on device', b: r.models.bytes, c: '#b6a8ff',
      title: r.models.source === 'build'
        ? 'The embedder, voice-activity and wake-word model files, as counted when this build was made · the brain and voice sidecars carry them'
        : 'The embedder, voice-activity and wake-word model files of this checkout',
    });
  }
  const max = Math.max(1, ...rows.map((x) => x.b));
  return rows.map((x) => ({ k: x.k, v: bytesText(x.b), w: `${Math.max(2, Math.round((x.b / max) * 100))}%`, c: x.c, title: x.title }));
}

// ---- Recently ----------------------------------------------------------------

export interface ErrorRow { id: string; error_message: string; severity: 'critical' | 'error' | 'warning' | 'info'; resolved: boolean; created_at: string }
export interface ToolCallRow { id: string; tool_name: string; status: string; created_at: string }
export interface RepairRow { id: string; status: string; diagnosis: string | null; created_at: string }

export interface RecentEvent {
  id: string;
  kind: 'error' | 'action' | 'repair' | 'update';
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

export function recentEvents(
  errors: readonly ErrorRow[], calls: readonly ToolCallRow[], repairs: readonly RepairRow[], now: Date, limit = 8,
  versions: readonly VersionRow[] = [],
): RecentEvent[] {
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
  for (const v of versions) {
    const at = new Date(v.first_seen_at).getTime();
    if (Number.isNaN(at)) continue;
    out.push({ id: `v-${v.version}-${v.first_seen_at}`, kind: 'update', at, t: eventTime(v.first_seen_at, now), m: versionMessage(v), c: '#3461f2' });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
