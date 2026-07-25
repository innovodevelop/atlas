/**
 * Local proactive digest (Phase 4) — the on-device replacement for the old
 * `atlas-daily-digest` pg_cron edge function.
 *
 * One route: POST /proactive/cycle. Gathers the user's recent signal from
 * atlas.db (memories, upcoming events/tasks, unresolved chat threads), makes
 * exactly ONE cheap-tier AI call, and writes at most MAX_INSIGHTS rows into
 * `ai_insights` (is_spoken=0) for useProactiveAI to surface.
 *
 * HARD CONTAINMENT — the Supabase original recursed and ran away; this one is
 * structurally incapable of it:
 *   - `last_run_at` is stamped BEFORE the AI call, so at most one completion
 *     per user per cooldown interval (default 12h) no matter how often the
 *     scheduler or the UI hits the route.
 *   - at most MAX_INSIGHTS inserts per run, one AI call per run, no recursion,
 *     no self-fetch.
 *   - skips entirely when learning is disabled or no AI key is configured.
 *
 * Cost: cheap tier only (selectModel("summary")). Once digest volume justifies
 * it, this is the natural home for the Anthropic Batch API (50% off) — the
 * digest is latency-insensitive by construction.
 */

import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";
import { selectModel } from "../../../supabase/functions/_shared/providerRouting.ts";
import type { LocalDb } from "./localDb.ts";

// Presence (not the value) gates the scheduler's token-only fallback below —
// in dev the brain runs without a token and the fallback must stay off
// entirely. Read at call time, not module load, so it is testable.
const sidecarTokenConfigured = () => !!process.env.SIDECAR_TOKEN;

interface Deps {
  db: LocalDb;
  requireUser: (req: Request) => { userId: string; email: string; token: string };
  json: (body: unknown, status?: number) => Response;
  /** Test seams — production (index.ts) omits these and gets the real gateway. */
  complete?: (system: string, user: string) => Promise<string | null>;
  hasKey?: () => boolean;
  now?: () => Date;
}

const MAX_INSIGHTS = 3;
const DEFAULT_COOLDOWN_HOURS = 12;

const nowIso = () => new Date().toISOString();

// Runtime-ensured DDL (same pattern as CHAT_TURNS_DDL in localDb.ts): the
// cooldown stamp must persist even for zero-insight runs, and this module owns
// its own state table rather than reaching into db_schema.sql.
const PROACTIVE_STATE_DDL = `
CREATE TABLE IF NOT EXISTS proactive_state (
  user_id     TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL
);`;

/**
 * One non-streaming cheap-tier completion; returns the raw text or null.
 * (Private twin of learningRoutes.ts's completeText — that module keeps its
 * helpers module-private on purpose.)
 */
async function completeText(system: string, user: string): Promise<string | null> {
  try {
    const res = await aiChatCompletion({
      model: selectModel("summary"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** Extract the first JSON array/object from model output (fenced or bare). */
function parseModelJson(content: string | null): unknown | null {
  if (!content) return null;
  const match = content.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Filler the model produces despite instructions — pleasantries and check-ins
// with no actionable content. Anything matching is dropped before insert.
const GENERIC_RE =
  /\b(hope you(?:'| a)?re|hope your|have a (?:great|good|nice|wonderful)|just checking in|checking in on you|keep up the|thinking of you|no (?:news|updates)|nothing (?:new|major|to report)|happy (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

interface Candidate { title?: unknown; content?: unknown }

/** Quality gate: keep only specific, non-generic insights; cap at MAX_INSIGHTS. */
export function filterInsights(parsed: unknown): Array<{ title: string; content: string }> {
  if (!Array.isArray(parsed)) return [];
  const kept: Array<{ title: string; content: string }> = [];
  for (const item of parsed as Candidate[]) {
    const title = typeof item?.title === "string" ? item.title.trim().slice(0, 200) : "";
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    // Empty or near-empty content is filler by definition; so are pleasantries.
    if (!title || content.length < 20) continue;
    if (GENERIC_RE.test(title) || GENERIC_RE.test(content)) continue;
    kept.push({ title, content });
    if (kept.length >= MAX_INSIGHTS) break;
  }
  return kept;
}

/**
 * The Rust scheduler holds the SIDECAR_TOKEN but no user JWT (tokens live in
 * the webview's auth store, never in the Rust core). When a request passes the
 * sidecar-token gate but carries no bearer, resolve "the most recent local
 * user" from the data itself — atlas.db is single-machine, so the newest
 * writer IS the app's user. A user who has never signed in has no rows, so
 * the cycle correctly no-ops.
 */
function latestLocalUser(db: LocalDb): string | null {
  const row = db._db
    .query(
      `SELECT user_id FROM (
         SELECT user_id, created_at FROM chat_turns
         UNION ALL
         SELECT user_id, created_at FROM ai_memory
       ) ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { user_id: string } | null;
  return row?.user_id ?? null;
}

function gatherSignal(db: LocalDb, userId: string, now: Date): string {
  const iso = now.toISOString();
  const in7d = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString();

  const mems = db._db
    .query(`SELECT key, value FROM ai_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 12`)
    .all(userId) as Array<{ key: string; value: string }>;
  const events = db._db
    .query(
      `SELECT title, start_time, location FROM user_events
        WHERE user_id = ? AND start_time >= ? AND start_time <= ?
        ORDER BY start_time LIMIT 8`,
    )
    .all(userId, iso, in7d) as Array<{ title: string; start_time: string; location: string | null }>;
  const tasks = db._db
    .query(
      `SELECT title, priority, due_date FROM user_tasks
        WHERE user_id = ? AND completed = 0
        ORDER BY (due_date IS NULL), due_date LIMIT 8`,
    )
    .all(userId) as Array<{ title: string; priority: string; due_date: string | null }>;
  // Recent user-side turns: what was on their mind that may still be open.
  const turns = db._db
    .query(
      `SELECT content FROM chat_turns
        WHERE user_id = ? AND role = 'user' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 8`,
    )
    .all(userId, twoDaysAgo) as Array<{ content: string }>;

  const lines: string[] = [];
  for (const e of events) lines.push(`event: "${e.title}" at ${e.start_time}${e.location ? ` (${e.location})` : ""}`);
  for (const t of tasks) lines.push(`open task: "${t.title}" (${t.priority}${t.due_date ? `, due ${t.due_date}` : ""})`);
  for (const m of mems) lines.push(`memory ${m.key}: ${String(m.value).slice(0, 200)}`);
  for (const t of turns) lines.push(`recent user message: ${String(t.content).slice(0, 200)}`);
  return lines.join("\n");
}

export function createProactiveHandlers({
  db,
  requireUser,
  json,
  complete = completeText,
  hasKey = hasAIKey,
  now = () => new Date(),
}: Deps) {
  db._db.exec(PROACTIVE_STATE_DDL);

  const cooldownHours = () => {
    const n = Number(process.env.ATLAS_PROACTIVE_INTERVAL_HOURS);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_HOURS;
  };

  // POST /proactive/cycle {} → {ok, insightsCreated, skipped?}
  async function cycle(req: Request): Promise<Response> {
    let userId: string;
    try {
      userId = requireUser(req).userId;
    } catch (e) {
      // 403 = bad sidecar token — always fatal.
      //
      // The scheduler fallback is deliberately narrow. It only applies when a
      // sidecar token is CONFIGURED (so the caller proved it) and the request
      // carries NO Authorization header at all — i.e. exactly the Rust
      // scheduler, which holds the token but never a JWT. Without the
      // SIDECAR_TOKEN condition this route would be fully unauthenticated in
      // dev (CORS is `*` on loopback), letting any web page trigger an AI
      // completion as the local user; without the header condition, an expired
      // or garbage bearer would silently execute as a different account on a
      // multi-account machine.
      const status = (e as { status?: number })?.status;
      const hasAuthHeader = !!req.headers.get("authorization");
      if (status !== 401 || !sidecarTokenConfigured() || hasAuthHeader) throw e;
      const resolved = latestLocalUser(db);
      if (!resolved) return json({ ok: true, insightsCreated: 0, skipped: "no-user" });
      userId = resolved;
    }

    // Learning master switch (atlas_system_settings is single-row; agent A's
    // seed guarantees it exists on fresh installs). Missing row reads as off.
    const settings = db._db
      .query(`SELECT learning_enabled FROM atlas_system_settings LIMIT 1`)
      .get() as { learning_enabled: number } | null;
    if (!settings?.learning_enabled) return json({ ok: true, insightsCreated: 0, skipped: "disabled" });

    if (!hasKey()) return json({ ok: true, insightsCreated: 0, skipped: "no-key" });

    const nowDate = now();
    const state = db._db
      .query(`SELECT last_run_at FROM proactive_state WHERE user_id = ?`)
      .get(userId) as { last_run_at: string } | null;
    if (state) {
      const elapsedH = (nowDate.getTime() - Date.parse(state.last_run_at)) / 3_600_000;
      if (Number.isFinite(elapsedH) && elapsedH < cooldownHours()) {
        return json({ ok: true, insightsCreated: 0, skipped: "cooldown" });
      }
    }
    // Stamp BEFORE the AI call: even a crash mid-run cannot produce more than
    // one completion per interval.
    db._db
      .query(
        `INSERT INTO proactive_state (user_id, last_run_at) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET last_run_at = excluded.last_run_at`,
      )
      .run(userId, nowDate.toISOString());

    const signal = gatherSignal(db, userId, nowDate);
    if (!signal) return json({ ok: true, insightsCreated: 0, skipped: "no-signal" });

    const parsed = parseModelJson(
      await complete(
        "You are Atlas's proactive digest process. From the user's recent context, produce at most " +
          `${MAX_INSIGHTS} proactive insights that are genuinely actionable or timely: a reminder tied to an ` +
          "upcoming event or task, a follow-up on something the user left unresolved, or a concrete connection " +
          "worth surfacing right now. Every insight must reference something specific from the context. " +
          "NEVER produce filler, greetings, pleasantries, or generic advice — if nothing clears that bar, " +
          'return []. Respond ONLY with a JSON array: [{"title": "...", "content": "..."}]. ' +
          `Current date/time: ${nowDate.toISOString()}`,
        signal,
      ),
    );

    let insightsCreated = 0;
    for (const insight of filterInsights(parsed)) {
      await db.from("ai_insights").insert({
        user_id: userId,
        insight_type: "proactive",
        title: insight.title,
        content: insight.content,
        is_spoken: false,
        created_at: nowIso(),
      });
      insightsCreated++;
    }
    return json({ ok: true, insightsCreated });
  }

  return { cycle };
}
