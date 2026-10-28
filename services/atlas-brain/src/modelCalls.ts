/**
 * The model-call ledger (Beta rows 72, 73, 77): one row in atlas.db for every
 * call the AI gateway makes, and the summary Model Lab and System Status draw.
 *
 * The gateway (supabase/functions/_shared/aiGateway.ts) only measures — lane,
 * the model it actually invoked, tokens in and out, how long the provider
 * took, whether it worked — and hands each record to one observer. This module
 * is that observer for the brain: it prices the call from a small table of
 * Anthropic list prices, writes the row, and keeps the table capped. Every
 * model call Atlas makes goes through the brain (the voice gateway delegates
 * its turns here), so this one ledger sees all of them.
 *
 * The cost is an ESTIMATE at Anthropic's first-party list price, stored with
 * the row so a later price change does not rewrite history. Bedrock bills its
 * own (partner) rates, so a Bedrock row carries the first-party price of the
 * same model, and the screens say so. A model with no entry in the table is
 * stored with no cost rather than a guessed one.
 *
 * The brain writes atlas.db through bun:sqlite, which bypasses the Rust
 * `db:changed` event, so the screens read this through the admin route below
 * and poll it like every other /admin/* surface.
 */

import { Database } from "bun:sqlite";
import {
  getAIConfig,
  setModelCallObserver,
  type ModelCallRecord,
} from "../../../supabase/functions/_shared/aiGateway.ts";

// Mirror of the atlas_model_calls DDL in src-tauri/src/db_schema.sql, inlined
// for the same reason as CHAT_TURNS_DDL in localDb.ts: a standalone brain (dev,
// tests) must be able to record against a DB the Rust core has not migrated
// yet. Keep the two in lockstep.
export const MODEL_CALLS_DDL = `
CREATE TABLE IF NOT EXISTS atlas_model_calls (
  id                 TEXT PRIMARY KEY,
  started_at         TEXT NOT NULL,
  lane               TEXT NOT NULL,
  provider           TEXT NOT NULL,
  requested_model    TEXT,
  model              TEXT NOT NULL,
  stream             INTEGER NOT NULL DEFAULT 0,
  http_status        INTEGER,
  ok                 INTEGER NOT NULL,
  error              TEXT,
  latency_ms         INTEGER NOT NULL,
  duration_ms        INTEGER,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_atlas_model_calls_started ON atlas_model_calls(started_at);`;

export function ensureModelCallsTable(db: Database): void {
  db.exec(MODEL_CALLS_DDL);
}

// ---------------------------------------------------------------------------
// Prices

/** The date the table below was copied from Anthropic's published list prices. */
export const PRICES_AS_OF = "2026-10-06";

/** USD per million tokens. Cache writes are the 5-minute TTL rate (1.25x input). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Anthropic first-party list prices for every model the gateway can invoke
 * (claudeAdapter.ts tiers on first-party, bedrockAdapter.ts profiles on
 * Bedrock), keyed by "family major.minor" so a first-party id and a Bedrock
 * profile of the same model share one row.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "haiku 4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "sonnet 4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "sonnet 5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "opus 4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "opus 4.8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "opus 5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "fable 5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};

/**
 * "claude-opus-4-6", "eu.anthropic.claude-opus-4-6-v1" → "opus 4.6";
 * "claude-sonnet-5" → "sonnet 5". The minor version is one or two digits and
 * never the start of a date stamp, so "claude-haiku-4-5-20251001-v1:0" is
 * "haiku 4.5", not 4.20 (the same reading as profileLabel in the Model Lab).
 */
export function priceKey(modelId: string): string | null {
  const m = modelId.toLowerCase().match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (!m) return null;
  return m[3] ? `${m[1]} ${m[2]}.${m[3]}` : `${m[1]} ${m[2]}`;
}

export function priceOf(modelId: string): ModelPrice | null {
  const key = priceKey(modelId);
  return key ? MODEL_PRICES[key] ?? null : null;
}

export interface TokenCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/**
 * The call's cost at list price, or null when it cannot be stated: an unpriced
 * model, or a call that reported no tokens at all (a failed call, or a legacy
 * lane whose stream carries no usage). Anthropic's `input_tokens` excludes the
 * cached part, so the three input counts are priced separately and added.
 */
export function estimateCost(modelId: string, t: TokenCounts): number | null {
  const price = priceOf(modelId);
  if (!price) return null;
  const counts = [t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens];
  if (counts.every((c) => c == null)) return null;
  const n = (v: number | null) => (v != null && Number.isFinite(v) ? v : 0);
  return (
    n(t.inputTokens) * price.input +
    n(t.outputTokens) * price.output +
    n(t.cacheReadTokens) * price.cacheRead +
    n(t.cacheWriteTokens) * price.cacheWrite
  ) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Writing

/** Rows older than this are dropped; the screens look back thirty days at most. */
export const MAX_AGE_DAYS = 90;
/** A hard ceiling on top of the age limit, so a runaway loop cannot grow the table without bound. */
export const MAX_ROWS = 50_000;
/** Prune once per this many inserts rather than on every one. */
const PRUNE_EVERY = 200;

let insertsSincePrune = 0;

export function recordModelCall(db: Database, r: ModelCallRecord, id: string = crypto.randomUUID()): void {
  const cost = estimateCost(r.model, r);
  db.query(`
    INSERT INTO atlas_model_calls (
      id, started_at, lane, provider, requested_model, model, stream, http_status, ok, error,
      latency_ms, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    new Date(r.startedAt).toISOString(),
    r.lane,
    r.provider,
    r.requestedModel || null,
    r.model || r.requestedModel || "unknown",
    r.stream ? 1 : 0,
    r.status,
    r.ok ? 1 : 0,
    r.error,
    Math.max(0, Math.round(r.latencyMs)),
    r.durationMs == null ? null : Math.max(0, Math.round(r.durationMs)),
    r.inputTokens,
    r.outputTokens,
    r.cacheReadTokens,
    r.cacheWriteTokens,
    cost,
  );
  if (++insertsSincePrune >= PRUNE_EVERY) {
    insertsSincePrune = 0;
    pruneModelCalls(db);
  }
}

/** Drop rows past the age limit, then everything beyond the newest MAX_ROWS. */
export function pruneModelCalls(db: Database, now = new Date(), maxAgeDays = MAX_AGE_DAYS, maxRows = MAX_ROWS): number {
  const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
  const aged = db.query(`DELETE FROM atlas_model_calls WHERE started_at < ?`).run(cutoff).changes;
  const over = db.query(`
    DELETE FROM atlas_model_calls WHERE id IN (
      SELECT id FROM atlas_model_calls ORDER BY started_at DESC LIMIT -1 OFFSET ?
    )`).run(maxRows).changes;
  return aged + over;
}

/**
 * Register the gateway observer that writes every call into atlas.db. A write
 * that fails is logged and dropped: the ledger is bookkeeping and must never
 * fail the answer it describes (the gateway also guards the call). Returns the
 * function that unregisters it.
 */
export function installModelCallRecorder(db: Database): () => void {
  ensureModelCallsTable(db);
  try {
    pruneModelCalls(db);
  } catch (e) {
    console.error("[modelCalls] prune failed:", e);
  }
  setModelCallObserver((record) => {
    try {
      recordModelCall(db, record);
    } catch (e) {
      console.error("[modelCalls] could not record a model call:", e);
    }
  });
  return () => setModelCallObserver(null);
}

// ---------------------------------------------------------------------------
// Reading

/** One stored row, the columns the summary reads. */
export interface ModelCallRow {
  started_at: string;
  lane: string;
  provider: string;
  model: string;
  ok: number;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

export interface ModelUsage {
  model: string;
  provider: string;
  calls: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Null when no call of this model could be priced. */
  cost_usd: number | null;
  /** Calls of this model that carried no cost (unpriced, or no tokens reported). */
  unpriced_calls: number;
}

export interface LaneLatency {
  lane: string;
  provider: string;
  calls: number;
  ok: number;
  /** Over the calls that worked; a failure's time says nothing about the provider's speed. */
  p50_ms: number | null;
  p95_ms: number | null;
  last_at: string | null;
}

export interface ModelCallsSummary {
  days: number;
  since: string;
  prices_as_of: string;
  /** The lane this brain process was started on (getAIConfig), or null with no AI key. */
  running_lane: string | null;
  /** The oldest row in the ledger, whatever the window: when recording began, as far as it still knows. */
  recording_since: string | null;
  today: { since: string; calls: number; failed: number };
  total: { calls: number; failed: number; tokens: number; cost_usd: number | null; unpriced_calls: number };
  models: ModelUsage[];
  lanes: LaneLatency[];
}

/**
 * Nearest-rank percentile: the smallest value with at least p% of the sample at
 * or below it. Null for an empty sample; with few calls it is honestly the
 * slowest of them, which is what a p95 of seven calls is.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const n = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Local midnight of `now`, as the ISO instant rows are compared against. */
export function startOfLocalDay(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

export interface SummaryOptions {
  days: number;
  now: Date;
  runningLane: string | null;
  recordingSince: string | null;
}

/** Pure: fold the window's rows into per-model usage, per-lane latency and today's count. */
export function summarizeModelCalls(rows: readonly ModelCallRow[], o: SummaryOptions): ModelCallsSummary {
  const since = new Date(o.now.getTime() - o.days * 86_400_000).toISOString();
  const todayStart = startOfLocalDay(o.now);
  const models = new Map<string, ModelUsage>();
  const lanes = new Map<string, { provider: string; calls: number; ok: number; times: number[]; last: string | null }>();
  const today = { since: todayStart, calls: 0, failed: 0 };

  for (const r of rows) {
    if (r.started_at < since) continue;
    const ok = r.ok === 1;
    if (r.started_at >= todayStart) {
      today.calls++;
      if (!ok) today.failed++;
    }

    const m = models.get(r.model) ?? {
      model: r.model, provider: r.provider, calls: 0, failed: 0,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      cost_usd: null, unpriced_calls: 0,
    };
    m.calls++;
    if (!ok) m.failed++;
    m.input_tokens += n(r.input_tokens);
    m.output_tokens += n(r.output_tokens);
    m.cache_read_tokens += n(r.cache_read_tokens);
    m.cache_write_tokens += n(r.cache_write_tokens);
    if (r.cost_usd == null) m.unpriced_calls++;
    else m.cost_usd = (m.cost_usd ?? 0) + r.cost_usd;
    models.set(r.model, m);

    const l = lanes.get(r.lane) ?? { provider: r.provider, calls: 0, ok: 0, times: [], last: null };
    l.calls++;
    if (ok) {
      l.ok++;
      l.times.push(n(r.latency_ms));
    }
    if (!l.last || r.started_at > l.last) l.last = r.started_at;
    lanes.set(r.lane, l);
  }

  const tokensOf = (m: ModelUsage) => m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_write_tokens;
  const modelList = [...models.values()].sort((a, b) => tokensOf(b) - tokensOf(a) || b.calls - a.calls || a.model.localeCompare(b.model));
  const laneList: LaneLatency[] = [...lanes.entries()]
    .map(([lane, l]) => ({ lane, provider: l.provider, calls: l.calls, ok: l.ok, p50_ms: percentile(l.times, 50), p95_ms: percentile(l.times, 95), last_at: l.last }))
    .sort((a, b) => b.calls - a.calls || a.lane.localeCompare(b.lane));

  const priced = modelList.filter((m) => m.cost_usd != null);
  return {
    days: o.days,
    since,
    prices_as_of: PRICES_AS_OF,
    running_lane: o.runningLane,
    recording_since: o.recordingSince,
    today,
    total: {
      calls: modelList.reduce((a, m) => a + m.calls, 0),
      failed: modelList.reduce((a, m) => a + m.failed, 0),
      tokens: modelList.reduce((a, m) => a + tokensOf(m), 0),
      cost_usd: priced.length ? priced.reduce((a, m) => a + (m.cost_usd ?? 0), 0) : null,
      unpriced_calls: modelList.reduce((a, m) => a + m.unpriced_calls, 0),
    },
    models: modelList,
    lanes: laneList,
  };
}

/** The window's rows, oldest first, plus when the ledger begins. */
export function readModelCallsSummary(db: Database, days: number, now = new Date(), runningLane: string | null = null): ModelCallsSummary {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = db.query(`
    SELECT started_at, lane, provider, model, ok, latency_ms,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
    FROM atlas_model_calls WHERE started_at >= ? ORDER BY started_at ASC
  `).all(since) as ModelCallRow[];
  const first = db.query(`SELECT MIN(started_at) AS first FROM atlas_model_calls`).get() as { first: string | null } | null;
  return summarizeModelCalls(rows, { days, now, runningLane, recordingSince: first?.first ?? null });
}

/** Thirty days is what the screens draw; a year is the most the route will read. */
export function clampDays(raw: unknown): number {
  const d = Math.floor(Number(raw));
  if (!Number.isFinite(d) || d < 1) return 30;
  return Math.min(d, 365);
}

interface Deps {
  db: Database;
  requireUser: (req: Request) => unknown;
  json: (body: unknown, status?: number) => Response;
}

/** GET /admin/model-calls?days=30 — the summary above, for this brain process. */
export function createModelCallHandlers({ db, requireUser, json }: Deps) {
  ensureModelCallsTable(db);
  return {
    getModelCalls(req: Request, days: unknown): Response {
      requireUser(req);
      return json(readModelCallsSummary(db, clampDays(days), new Date(), getAIConfig()?.provider ?? null));
    },
  };
}
