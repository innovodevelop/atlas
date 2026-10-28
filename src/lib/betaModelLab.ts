/**
 * The Beta Model Lab's reading — how each tier resolves on the lane being
 * looked at, the comparison rows, the usage lines and the formats — pure and
 * tested here, rendered by src/pages/atlas/BetaModelLab.tsx.
 *
 * Every routing fact comes from `src/lib/mocks/modelLab.ts`, the build-time
 * transcription of the gateway source (claudeAdapter.ts, bedrockAdapter.ts,
 * aiGateway.ts). This module only decides how a fact reads on a lane. The two
 * measured things the lab shows — usage per model and latency per lane — come
 * from the brain's model-call ledger (one row per gateway call, see
 * services/atlas-brain/src/modelCalls.ts) and are passed in as its summary, so
 * nothing here can invent a figure: with no calls, the functions say so in
 * words instead of returning a zero.
 */
import { GATEWAY, TIERS, type ModelTier } from '@/lib/mocks/modelLab';

export type Lane = 'anthropic' | 'bedrock';
export const LANES: readonly Lane[] = ['anthropic', 'bedrock'];

export const LANE_LABEL: Record<Lane, string> = { anthropic: 'First-party', bedrock: 'Bedrock' };

/** The gateway's own description of a lane (host, auth, streaming, detail). */
export function laneInfo(lane: Lane) {
  return GATEWAY.lanes.find((l) => l.id === lane) ?? GATEWAY.lanes[0];
}

/** "Bedrock (eu-central-1)": the region is the host's second label, so it cannot drift from the host. */
export function laneName(lane: Lane): string {
  if (lane === 'anthropic') return LANE_LABEL.anthropic;
  const region = laneInfo('bedrock').host.split('.')[1];
  return region ? `${LANE_LABEL.bedrock} (${region})` : LANE_LABEL.bedrock;
}

/** No `TIER_DEFAULT` entry: mapping the tier throws before a request is signed. */
export const isUnmapped = (t: ModelTier): boolean => t.bedrock.profile === null;

/** True when the id you name is not what runs — only ever on Bedrock. */
export const isBad = (t: ModelTier, lane: Lane): boolean => lane === 'bedrock' && (t.bedrock.substituted || isUnmapped(t));

export function namedOn(t: ModelTier, lane: Lane): string {
  return lane === 'anthropic' ? t.id : t.bedrock.requested;
}

export const NOTHING_INVOKED = 'none (mapping throws)';

export function invokedOn(t: ModelTier, lane: Lane): string {
  return lane === 'anthropic' ? t.firstParty.model : t.bedrock.profile ?? NOTHING_INVOKED;
}

export type TagTone = 'ok' | 'warn' | 'unmapped';

/** The card's tag: the one word that says whether the name is the model. */
export function tagOf(t: ModelTier, lane: Lane): { label: string; tone: TagTone } {
  if (lane === 'anthropic') return { label: 'Unchanged', tone: 'ok' };
  if (isUnmapped(t)) return { label: 'Unmapped', tone: 'unmapped' };
  if (t.bedrock.substituted) return { label: 'Substituted', tone: 'warn' };
  return { label: 'Entitled', tone: 'ok' };
}

/** Tiers on this lane that are not what their name says. Zero on first-party by construction. */
export function substitutedCount(lane: Lane): number {
  return lane === 'bedrock' ? TIERS.filter((t) => t.bedrock.substituted || isUnmapped(t)).length : 0;
}

/**
 * A profile or model id as a person would say it: `eu.anthropic.claude-opus-4-6-v1`
 * reads "Opus 4.6". The minor version is one or two digits and never the start
 * of a date stamp, so `claude-haiku-4-5-20251001-v1:0` is "Haiku 4.5", not 4.20.
 */
export function profileLabel(id: string | null): string {
  if (!id) return 'nothing';
  const m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

export interface TierDetail {
  kicker: string;
  headline: string;
  named: string;
  invoked: string;
  note: string;
  bad: boolean;
}

export function detailOf(t: ModelTier, lane: Lane): TierDetail {
  const bad = isBad(t, lane);
  const named = namedOn(t, lane);
  const invoked = invokedOn(t, lane);
  if (lane === 'anthropic') {
    // The transcription's first-party notes point at a Bedrock panel "below"
    // that only the Workshop layout has, so the note is built from the facts.
    const onBedrock = isUnmapped(t)
      ? 'Bedrock has no profile Atlas will call for it.'
      : t.bedrock.substituted
        ? `Bedrock would run ${profileLabel(t.bedrock.profile)} instead.`
        : 'Bedrock runs the same model.';
    return { kicker: 'First-party lane', headline: `Passed through unchanged. ${t.label} is ${t.label}.`, named, invoked, note: `${firstClause(t.firstParty.note)}. ${onBedrock}`, bad };
  }
  if (isUnmapped(t)) {
    return { kicker: 'Unmapped on Bedrock', headline: `${t.label} has no Bedrock profile Atlas will call.`, named, invoked, note: t.bedrock.note, bad };
  }
  if (t.bedrock.substituted) {
    return { kicker: 'Substituted on Bedrock', headline: `Asking for ${t.label} runs ${profileLabel(t.bedrock.profile)}.`, named, invoked, note: t.bedrock.note, bad };
  }
  return { kicker: 'Entitled on Bedrock', headline: `${t.label} is what runs.`, named, invoked, note: t.bedrock.note, bad };
}

/** "Passed through unchanged — the frontier problem…" → "Passed through unchanged". */
function firstClause(s: string): string {
  return s.split(/\.\s|\.$| — /)[0].trim();
}

const THINKING_TEXT: Record<ModelTier['bedrock']['thinking'], string> = {
  omitted: 'omitted (no thinking)',
  'explicitly-disabled': 'explicitly disabled',
  unconditional: 'unconditional',
};

export function entitlementOf(t: ModelTier): string {
  if (t.bedrock.requestedState === 'invocable') return 'entitled';
  return isUnmapped(t) ? 'unmapped' : 'not entitled · substituted';
}

export function geographyOf(t: ModelTier): string {
  return t.bedrock.geo === 'eea' ? 'EEA (eu. profile)' : t.bedrock.geo === 'worldwide' ? 'worldwide (global. profile)' : 'n/a';
}

export interface Fact { k: string; v: string; mono: boolean; warn: boolean }

/** The detail's fact list, in the design's reading order. */
export function factsOf(t: ModelTier): Fact[] {
  const entitlement = entitlementOf(t);
  const rows: Array<[string, string, boolean]> = [
    ['Band', t.band + (t.isDefault ? ' · default tier' : ''), false],
    ['Reached by', t.aliases.length ? t.aliases.join(', ') : 'its own id only', true],
    ['First-party', `${t.firstParty.model} · ${firstClause(t.firstParty.note)}`, true],
    ['Bedrock named', t.bedrock.requested, true],
    ['Bedrock invoked', t.bedrock.profile ?? NOTHING_INVOKED, true],
    ['Entitlement', entitlement, false],
    ['Geography', geographyOf(t), false],
    ['Override env var', t.bedrock.envOverride, true],
    ['Thinking on Bedrock', THINKING_TEXT[t.bedrock.thinking], false],
    ['Server tools', 'first-party lane only', false],
  ];
  return rows.map(([k, v, mono]) => ({ k, v, mono, warn: k === 'Entitlement' && entitlement !== 'entitled' }));
}

export interface CompareCell { v: string; mono: boolean; warn: boolean }
export interface CompareRow { k: string; cells: CompareCell[] }

/** Values that mean "not what the name says" are filled, so a difference reads at a glance. */
const WARN_VALUES = new Set(['substituted', 'unmapped', 'worldwide']);

/** Every tier side by side, on one lane. Routing facts only: nothing here is a measurement. */
export function compareRows(lane: Lane): CompareRow[] {
  const bed = lane === 'bedrock';
  const fields: Array<[string, (t: ModelTier) => string, boolean]> = [
    ['Band', (t) => t.band, false],
    ['Default tier', (t) => (t.isDefault ? 'yes · unknown ids land here' : 'no'), false],
    ['Reached by', (t) => (t.aliases.length ? t.aliases.join(', ') : 'its own id only'), true],
    ['Invoked on this lane', (t) => invokedOn(t, lane), true],
    ['Entitlement', (t) => (!bed ? 'n/a' : t.bedrock.requestedState === 'invocable' ? 'entitled' : isUnmapped(t) ? 'unmapped' : 'substituted'), false],
    ['Geography', (t) => (!bed ? 'n/a' : t.bedrock.geo === 'eea' ? 'EEA' : t.bedrock.geo === 'worldwide' ? 'worldwide' : 'n/a'), false],
    ['Override env var', (t) => t.bedrock.envOverride, true],
    ['Adaptive / effort', (t) => (t.capabilities.adaptive ? 'supported' : 'not sent'), false],
    ['Thinking on Bedrock', (t) => THINKING_TEXT[t.bedrock.thinking], false],
    ['Server tools', () => 'first-party only', false],
  ];
  return fields.map(([k, read, mono]) => ({
    k,
    cells: TIERS.map((t) => { const v = read(t); return { v, mono, warn: WARN_VALUES.has(v) }; }),
  }));
}

/** The gateway rules, in the design's order, from the transcription's own sentences. */
export const GATEWAY_RULES: ReadonlyArray<{ t: string; b: string }> = [
  { t: 'Server-tool bridge', b: GATEWAY.serverToolBridge },
  { t: 'Fail closed', b: GATEWAY.failClosed },
  { t: 'EEA containment', b: GATEWAY.eeaNote },
  { t: 'Embeddings', b: GATEWAY.embeddings },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-28" → "28 Jul 2026" (or "28 Jul"), without a time zone moving the day. */
export function dayLabel(iso: string, withYear = true): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso;
  return withYear ? `${Number(m[3])} ${month} ${m[1]}` : `${Number(m[3])} ${month}`;
}

// ---- Measured readings: the brain's model-call ledger --------------------------

/**
 * The brain's `/admin/model-calls` answer (services/atlas-brain/src/modelCalls.ts):
 * every call the AI gateway made in the window, folded per model and per lane.
 * Mirrored here because the webview cannot import the sidecar's modules.
 */
export interface ModelUsage {
  model: string;
  provider: string;
  calls: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  unpriced_calls: number;
}

export interface LaneLatency {
  lane: string;
  provider: string;
  calls: number;
  ok: number;
  p50_ms: number | null;
  p95_ms: number | null;
  last_at: string | null;
}

export interface ModelCallsSummary {
  days: number;
  since: string;
  prices_as_of: string;
  running_lane: string | null;
  recording_since: string | null;
  today: { since: string; calls: number; failed: number };
  total: { calls: number; failed: number; tokens: number; cost_usd: number | null; unpriced_calls: number };
  models: ModelUsage[];
  lanes: LaneLatency[];
}

export interface UsageLine {
  /** The model as a person says it ("Sonnet 4.6"); first-party and Bedrock calls of one model share a line. */
  label: string;
  calls: number;
  failed: number;
  tokens: number;
  /** Null when none of its calls could be priced. */
  cost: number | null;
  /** 0–1, of tokens when any were recorded, else of calls. */
  share: number;
  colour: string;
  value: string;
}

export interface UsageSummary {
  lines: UsageLine[];
  calls: number;
  tokens: number;
  cost: number | null;
  unpricedCalls: number;
}

export const USAGE_COLOURS = ['#1e1e24', '#3461f2', '#7854ff', '#0fae76', '#e07a1f', '#8b8681'];
/** The design's colour for a tier that exists but was not called. */
export const UNUSED_COLOUR = '#d8d4cd';

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  bedrock: 'Bedrock',
  perplexity: 'Perplexity',
  openai: 'OpenAI',
  lovable_ai: 'Lovable AI',
  jina: 'Jina',
  firecrawl: 'Firecrawl',
  gemini: 'Gemini',
};

export function providerLabel(p: string): string {
  const key = p.toLowerCase().replace(/\s+/g, '_');
  return PROVIDER_LABEL[key] ?? p.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** 950 → "950", 1 500 → "1.5k", 25 000 → "25k", 11 400 000 → "11.4M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const usd = (v: number): string => `$${v.toFixed(2)}`;

const tokensOf = (m: ModelUsage): number => num(m.input_tokens) + num(m.output_tokens) + num(m.cache_read_tokens) + num(m.cache_write_tokens);

/**
 * The usage card: one line per model the ledger holds, largest first, then the
 * tiers the running lane can invoke that were not called at all ("not called",
 * as the design draws Fable 5). Costs are summed only over calls that carried
 * one, so an unpriced call never reads as free.
 */
export function usageByModel(summary: ModelCallsSummary | null, unusedModels: readonly string[] = []): UsageSummary {
  const by = new Map<string, { calls: number; failed: number; tokens: number; cost: number | null }>();
  for (const m of summary?.models ?? []) {
    const label = profileLabel(m.model);
    const cur = by.get(label) ?? { calls: 0, failed: 0, tokens: 0, cost: null };
    cur.calls += num(m.calls);
    cur.failed += num(m.failed);
    cur.tokens += tokensOf(m);
    if (m.cost_usd != null) cur.cost = (cur.cost ?? 0) + num(m.cost_usd);
    by.set(label, cur);
  }
  const totalTokens = [...by.values()].reduce((a, v) => a + v.tokens, 0);
  const totalCalls = [...by.values()].reduce((a, v) => a + v.calls, 0);
  const lines: UsageLine[] = [...by.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens || b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
    .map(([label, v], i) => {
      const share = totalTokens > 0 ? v.tokens / totalTokens : totalCalls > 0 ? v.calls / totalCalls : 0;
      const price = v.cost == null ? 'no price' : usd(v.cost);
      const value = v.tokens > 0 ? `${formatTokens(v.tokens)} tok · ${price}` : `${v.calls} ${v.calls === 1 ? 'call' : 'calls'} · ${price}`;
      return { label, ...v, share, colour: USAGE_COLOURS[i % USAGE_COLOURS.length], value };
    });
  const seen = new Set(lines.map((l) => l.label));
  for (const id of unusedModels) {
    const label = profileLabel(id);
    if (!id || seen.has(label)) continue;
    seen.add(label);
    lines.push({ label, calls: 0, failed: 0, tokens: 0, cost: null, share: 0, colour: UNUSED_COLOUR, value: 'not called' });
  }
  const priced = lines.filter((l) => l.cost != null);
  return {
    lines,
    calls: totalCalls,
    tokens: totalTokens,
    cost: priced.length ? priced.reduce((a, l) => a + (l.cost ?? 0), 0) : null,
    unpricedCalls: num(summary?.total.unpriced_calls),
  };
}

/** The models a lane's tiers invoke, in tier order, for the "not called" lines. */
export function laneModels(lane: Lane): string[] {
  return TIERS.map((t) => (lane === 'anthropic' ? t.firstParty.model : t.bedrock.profile ?? '')).filter(Boolean);
}

/** 820 → "820 ms", 1 840 → "1.8 s". */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** What each gateway lane is, in the words the lab uses. */
export const GATEWAY_LANE_LABEL: Record<string, string> = {
  anthropic: 'First-party',
  bedrock: 'Bedrock',
  bridge: 'Bridge to first-party',
  degraded: 'Bedrock, no web tools',
  lovable_ai: 'Lovable AI (dev)',
  gemini: 'Gemini (dev)',
};

export function gatewayLaneLabel(lane: string): string {
  return GATEWAY_LANE_LABEL[lane] ?? providerLabel(lane);
}

export interface LatencyLine {
  lane: string;
  label: string;
  /** "1.8 s", or "—" when no call on the lane worked. */
  p95: string;
  detail: string;
  /** 0–1 against the slowest lane's p95. */
  share: number;
}

/** p95 per lane, the busiest lane first: the time until the provider answered, over the calls that worked. */
export function latencyLines(summary: ModelCallsSummary | null): LatencyLine[] {
  const lanes = summary?.lanes ?? [];
  const peak = Math.max(1, ...lanes.map((l) => num(l.p95_ms)));
  return lanes.map((l) => ({
    lane: l.lane,
    label: gatewayLaneLabel(l.lane),
    p95: l.p95_ms == null ? '—' : formatMs(l.p95_ms),
    detail: `${l.calls} ${l.calls === 1 ? 'call' : 'calls'}${l.ok < l.calls ? ` · ${l.calls - l.ok} failed` : ''}${l.p50_ms != null ? ` · median ${formatMs(l.p50_ms)}` : ''}`,
    share: l.p95_ms == null ? 0 : num(l.p95_ms) / peak,
  }));
}

/** A lane card's own p95: the calls served on that lane itself (not the bridge or the degraded path). */
export function laneP95(summary: ModelCallsSummary | null, lane: Lane): LaneLatency | null {
  return summary?.lanes.find((l) => l.lane === lane) ?? null;
}

/** The lane card's Latency fact. */
export function latencyFact(summary: ModelCallsSummary | null, lane: Lane): string {
  if (!summary) return 'not read yet';
  const l = laneP95(summary, lane);
  if (!l || !l.calls) return `no calls in the last ${summary.days} days`;
  if (l.p95_ms == null) return `${l.calls} ${l.calls === 1 ? 'call' : 'calls'}, none answered`;
  return `${formatMs(l.p95_ms)} p95 · ${l.calls} ${l.calls === 1 ? 'call' : 'calls'}`;
}

/** The brain's running provider as a lab lane; null for none or a developer-only provider. */
export function runningLaneOf(summary: ModelCallsSummary | null): Lane | null {
  const p = summary?.running_lane;
  return p === 'anthropic' || p === 'bedrock' ? p : null;
}

export type StatusTone = 'ready' | 'syncing' | 'failed' | 'paused';

export interface LaneReading {
  /** False outside the desktop app: the Keychain cannot be seen at all. */
  available: boolean;
  loading: boolean;
  /** Whether this lane's key (or AWS pair) is in the Keychain; null when unread. */
  keyPresent: boolean | null;
  /** This lane is the stored `atlas_ai_provider` — what the brain starts on. */
  selected: boolean;
  /** The brain's own report; null when it could not be read. */
  brainRunning: boolean | null;
  /** Whether the running brain is on this lane now; null when the brain could not say. */
  running?: boolean | null;
  /** This lane's p95 over the window, when it has one. */
  p95Ms?: number | null;
}

/** The lane card's status pill: what is known, in as few words as the pill holds. */
export function laneStatus(r: LaneReading): { text: string; tone: StatusTone } {
  if (!r.available) return { text: 'Desktop app only', tone: 'paused' };
  if (r.loading) return { text: 'Reading…', tone: 'syncing' };
  if (r.selected) {
    if (r.keyPresent === false) return { text: 'Selected · no key', tone: 'failed' };
    // Stored but not what the brain runs: the switch waits for a restart.
    if (r.running === false) return { text: 'Selected · from next start', tone: 'syncing' };
    if (r.brainRunning === false) return { text: 'Selected · brain not running', tone: 'failed' };
    if (r.brainRunning === true && r.keyPresent === true) {
      return { text: r.p95Ms != null ? `Live · ${formatMs(r.p95Ms)} p95` : 'Live · key present', tone: 'ready' };
    }
    return { text: 'Selected', tone: 'paused' };
  }
  if (r.running === true) return { text: 'Running until restart', tone: 'syncing' };
  if (r.keyPresent === null) return { text: 'Key unknown', tone: 'paused' };
  return r.keyPresent ? { text: 'Key present', tone: 'ready' } : { text: 'No key', tone: 'paused' };
}

/** The lane card's facts: the transcription's host, auth and streaming, then one line per lane. */
export function laneFacts(lane: Lane, latency: string): Array<{ k: string; v: string }> {
  const l = laneInfo(lane);
  const own = lane === 'anthropic'
    ? { k: 'Max tokens', v: `${GATEWAY.maxTokens.blocking} blocking · ${GATEWAY.maxTokens.streaming} streaming` }
    : { k: 'Switch', v: GATEWAY.switchKeychain };
  return [{ k: 'Host', v: l.host }, { k: 'Auth', v: l.auth }, { k: 'Streaming', v: l.streaming }, own, { k: 'Latency', v: latency }];
}

// ---- The provider switch (row 74) ------------------------------------------------

export interface SwitchPlan {
  /** False when the lane has no key: the gateway fails closed, so switching would only stop Atlas answering. */
  allowed: boolean;
  /** Why it is not allowed, in a sentence. */
  reason: string | null;
  /** What changes, and what leaves the Mac, from the next start. */
  effect: string;
}

/**
 * What switching the stored `atlas_ai_provider` to `target` would do. The brain
 * reads the preference when it is spawned, so every switch takes effect on the
 * next start, and the sentence says where prompts go from then on.
 */
export function switchPlan(target: Lane, keyPresent: boolean | null): SwitchPlan {
  const host = laneInfo(target).host;
  const effect = target === 'bedrock'
    ? `From the next start, chat, memory and background prompts go to ${laneName('bedrock')} at ${host} instead of ${laneInfo('anthropic').host}. Turns that need web search still go to Anthropic when its key is present.`
    : `From the next start, every prompt goes to ${host} instead of ${laneName('bedrock')}.`;
  if (keyPresent === false) {
    return {
      allowed: false,
      reason: target === 'bedrock' ? 'Add the AWS access key pair in Settings first: without it Bedrock refuses every call.' : 'Add an Anthropic API key in Settings first: without it the first-party lane refuses every call.',
      effect,
    };
  }
  return { allowed: true, reason: null, effect };
}
