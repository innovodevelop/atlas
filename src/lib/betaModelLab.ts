/**
 * The Beta Model Lab's reading — how each tier resolves on the lane being
 * looked at, the comparison rows, the usage lines and the formats — pure and
 * tested here, rendered by src/pages/atlas/BetaModelLab.tsx.
 *
 * Every routing fact comes from `src/lib/mocks/modelLab.ts`, the build-time
 * transcription of the gateway source (claudeAdapter.ts, bedrockAdapter.ts,
 * aiGateway.ts). This module only decides how a fact reads on a lane. The two
 * measured things the lab shows — usage and latency — come from the app's own
 * tables and are passed in as rows, so nothing here can invent a figure: with
 * no rows, the functions say so in words instead of returning a zero.
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

// ---- Measured readings -------------------------------------------------------

/** One `atlas_usage_history` row: per provider, per day. Never per model. */
export interface UsageRow {
  date: string;
  provider: string;
  total_calls: number | null;
  estimated_cost: number | null;
  tokens_used: number | null;
}

/** One `atlas_provider_status` row, the fields the lab reads. */
export interface ProviderHealthRow {
  provider: string;
  total_calls: number | null;
  successful_calls: number | null;
  avg_response_time_ms: number | null;
}

export interface UsageLine {
  provider: string;
  label: string;
  calls: number;
  tokens: number;
  cost: number;
  /** 0–1, of tokens when any were recorded, else of calls. */
  share: number;
  colour: string;
  value: string;
}

export interface UsageSummary {
  lines: UsageLine[];
  days: number;
  calls: number;
  tokens: number;
  cost: number;
}

export const USAGE_COLOURS = ['#1e1e24', '#3461f2', '#7854ff', '#0fae76', '#e07a1f', '#8b8681'];

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

/** The usage card's lines: one per provider the table has rows for, largest first. */
export function usageByProvider(rows: readonly UsageRow[]): UsageSummary {
  const by = new Map<string, { calls: number; tokens: number; cost: number }>();
  const days = new Set<string>();
  for (const r of rows) {
    if (!r.provider) continue;
    days.add(r.date);
    const key = r.provider.toLowerCase();
    const cur = by.get(key) ?? { calls: 0, tokens: 0, cost: 0 };
    cur.calls += num(r.total_calls);
    cur.tokens += num(r.tokens_used);
    cur.cost += num(r.estimated_cost);
    by.set(key, cur);
  }
  const totals = [...by.values()].reduce((a, v) => ({ calls: a.calls + v.calls, tokens: a.tokens + v.tokens, cost: a.cost + v.cost }), { calls: 0, tokens: 0, cost: 0 });
  const lines = [...by.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens || b[1].cost - a[1].cost || b[1].calls - a[1].calls)
    .map(([provider, v], i) => {
      const share = totals.tokens > 0 ? v.tokens / totals.tokens : totals.calls > 0 ? v.calls / totals.calls : 0;
      const value = v.tokens > 0
        ? `${formatTokens(v.tokens)} tok · ${usd(v.cost)}`
        : v.calls > 0 ? `${v.calls} ${v.calls === 1 ? 'call' : 'calls'} · ${usd(v.cost)}` : 'not called';
      return { provider, label: providerLabel(provider), ...v, share, colour: USAGE_COLOURS[i % USAGE_COLOURS.length], value };
    });
  return { lines, days: days.size, ...totals };
}

/** 820 → "820 ms", 1 840 → "1.8 s". */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The latency a lane card can state. Only first-party has a row shape: the
 * table's CHECK constraint admits five provider names and Bedrock is not one
 * of them, so on Bedrock the honest answer is that it cannot be recorded.
 */
export function latencyOf(lane: Lane, rows: readonly ProviderHealthRow[]): string {
  if (lane === 'bedrock') return 'not recordable (no Bedrock row in atlas_provider_status)';
  const row = rows.find((r) => r.provider === 'anthropic');
  if (!row) return 'not recorded';
  const total = num(row.total_calls);
  if (row.avg_response_time_ms == null) return total > 0 ? `${total} calls · no timing recorded` : 'not recorded';
  return `${formatMs(num(row.avg_response_time_ms))} avg · ${num(row.successful_calls)}/${total} ok`;
}

export type StatusTone = 'ready' | 'syncing' | 'failed' | 'paused';

export interface LaneReading {
  /** False outside the desktop app: the Keychain cannot be seen at all. */
  available: boolean;
  loading: boolean;
  /** Whether this lane's key (or AWS pair) is in the Keychain; null when unread. */
  keyPresent: boolean | null;
  /** This lane is the stored `atlas_ai_provider`. */
  selected: boolean;
  /** The brain sidecar's own report; null when it could not be read. */
  brainRunning: boolean | null;
}

/** The lane card's status pill: what is known, in as few words as the pill holds. */
export function laneStatus(r: LaneReading): { text: string; tone: StatusTone } {
  if (!r.available) return { text: 'Desktop app only', tone: 'paused' };
  if (r.loading) return { text: 'Reading…', tone: 'syncing' };
  if (r.selected) {
    if (r.keyPresent === false) return { text: 'Selected · no key', tone: 'failed' };
    if (r.brainRunning === false) return { text: 'Selected · brain not running', tone: 'failed' };
    if (r.brainRunning === true && r.keyPresent === true) return { text: 'Live · key present', tone: 'ready' };
    return { text: 'Selected', tone: 'paused' };
  }
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
