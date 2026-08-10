/**
 * Local proactive digest (Phase 4) — the on-device replacement for the old
 * `atlas-daily-digest` pg_cron edge function.
 *
 * One route: POST /proactive/cycle. Gathers the user's recent signal from
 * atlas.db (memories, upcoming events/tasks, unresolved chat threads), runs a
 * SMALL BOUNDED tool loop against the desktop control port, and writes at most
 * MAX_INSIGHTS rows into `ai_insights` (is_spoken=0) for useProactiveAI to
 * surface.
 *
 * HARD CONTAINMENT — the Supabase original recursed and ran away; this one is
 * structurally incapable of it. The bound used to be "exactly ONE AI call",
 * which was true while this file could only read `atlas.db` directly. It can
 * now look things up (weather, quotes, headlines, what is on the calendar
 * through the port), and a lookup is worthless unless the model gets to read
 * the answer — so the bound is no longer one call, and the doc says so rather
 * than flattering the old design:
 *
 *   - `last_run_at` is stamped BEFORE any AI call, so at most one CYCLE per
 *     user per cooldown interval (default 12h) no matter how often the
 *     scheduler or the UI hits the route. This is the outer bound and it did
 *     not change.
 *   - at most PROACTIVE_MAX_AI_CALLS (3) model calls per cycle, and at most
 *     PROACTIVE_WALL_CLOCK_MS (60s) of wall clock across the whole loop.
 *     Whichever trips first ends the cycle; neither can be extended from
 *     inside the loop.
 *   - the loop is flat. It never calls runChat, so it cannot inherit that
 *     function's 6 iterations, its streaming pass, its knowledge extraction or
 *     its memory writes — a digest that reused the chat orchestrator would be
 *     a background process with a chat process's budget.
 *   - desktop tools are READ-ONLY here, twice over: `buildAtlasTools(…,
 *     {allowMutating: false})` never describes a mutating action, and
 *     `executeTool` refuses one structurally if the model invents the name.
 *     Nothing runs at 3am that the user would see happen.
 *   - profile is `background`, so Rust's own gate downgrades any actuation to
 *     an approval regardless of what this file believes.
 *   - at most MAX_INSIGHTS inserts per run, no recursion, no self-fetch.
 *   - skips entirely when learning is disabled or no AI key is configured.
 *
 * With no control port (standalone brain, no desktop) there are no tools to
 * declare and the cycle collapses back to exactly one AI call, which is the
 * behaviour this file had before.
 *
 * Cost: cheap tier only (selectModel("summary")). Once digest volume justifies
 * it, this is the natural home for the Anthropic Batch API (50% off) — the
 * digest is latency-insensitive by construction.
 */

import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";
import { selectModel } from "../../../supabase/functions/_shared/providerRouting.ts";
import {
  buildAtlasTools,
  executeTool,
  type ChatMessage,
  type ToolCall,
  type ToolDecl,
} from "../../../supabase/functions/_shared/orchestrator.ts";
import { createControlClient, type ControlClient } from "./control.ts";
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
  /** The tool-loop seam. Used only when there are desktop tools to declare. */
  completeTurn?: CompleteTurn;
  hasKey?: () => boolean;
  now?: () => Date;
  /**
   * The desktop control port. Constructed here rather than injected from
   * index.ts because this module is the only thing that decides the digest's
   * profile and read-only stance, and threading a second client through the
   * route table would put that decision two files away from the comment that
   * explains it. Tests pass a stub, or nothing at all — with no env the client
   * reports unavailable and no tools are declared.
   */
  control?: ControlClient;
}

const MAX_INSIGHTS = 3;
const DEFAULT_COOLDOWN_HOURS = 12;

/**
 * The two bounds on one cycle's tool loop.
 *
 * THREE CALLS, not six: the digest's job is one lookup, one read of the answer,
 * one write-up. A fourth is the model going exploring on a schedule with the
 * user's money and nobody watching the meter.
 *
 * SIXTY SECONDS, because iteration count alone is not a bound — three calls to
 * a hung port is still a stuck cycle, and this one holds the cooldown stamp, so
 * a cycle that never finishes silently costs the user the next twelve hours of
 * digests. Generous compared to a chat turn's 20s only because nobody is
 * waiting on it; the point is that it terminates, not that it is fast.
 */
export const PROACTIVE_MAX_AI_CALLS = 3;
export const PROACTIVE_WALL_CLOCK_MS = 60_000;

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

/** One model turn, reduced to the only two things the loop reads. */
export interface ProactiveTurn {
  content: string | null;
  toolCalls: ToolCall[];
}

export type CompleteTurn = (
  messages: ChatMessage[],
  tools: ToolDecl[],
) => Promise<ProactiveTurn | null>;

export interface ToolLoopOutcome {
  /** The prose of the turn that stopped the loop. null when nothing usable. */
  content: string | null;
  aiCalls: number;
  toolCalls: number;
  /** Which bound (or which answer) ended it. Reported in the route's body. */
  stoppedBy: "answer" | "iterations" | "deadline" | "no-response";
}

/**
 * The digest's own tool loop. Deliberately NOT runChat.
 *
 * Extracted as a free function taking every clock, model and tool as an
 * argument so both bounds are testable without a database, a port or a real
 * sixty-second wait. The route below is the only production caller.
 *
 * Two ordering details that are the whole containment:
 *   - the deadline is checked at the TOP of each iteration and again before
 *     each tool call, so a single slow op cannot buy a fourth model call.
 *   - once `aiCalls` reaches the ceiling the loop stops instead of executing
 *     that turn's tools. Running them would be work whose result no model call
 *     is left to read — pure cost, and for an actuating op it would be a side
 *     effect nobody ever asked about.
 */
export async function proactiveToolLoop(opts: {
  messages: ChatMessage[];
  tools: ToolDecl[];
  complete: CompleteTurn;
  runTool: (call: ToolCall) => Promise<unknown>;
  /** Absolute epoch-ms ceiling for the whole loop. */
  deadline: number;
  clock?: () => number;
  maxAiCalls?: number;
}): Promise<ToolLoopOutcome> {
  const clock = opts.clock ?? Date.now;
  const maxAiCalls = opts.maxAiCalls ?? PROACTIVE_MAX_AI_CALLS;
  const messages: Array<ChatMessage & Record<string, unknown>> = opts.messages.map((m) => ({ ...m }));

  let aiCalls = 0;
  let toolCalls = 0;

  while (aiCalls < maxAiCalls) {
    if (clock() >= opts.deadline) {
      return { content: null, aiCalls, toolCalls, stoppedBy: "deadline" };
    }

    const turn = await opts.complete(messages, opts.tools);
    aiCalls++;
    if (!turn) return { content: null, aiCalls, toolCalls, stoppedBy: "no-response" };
    if (turn.toolCalls.length === 0) {
      return { content: turn.content, aiCalls, toolCalls, stoppedBy: "answer" };
    }
    // Out of model calls: stop here rather than running tools nothing will read.
    if (aiCalls >= maxAiCalls) break;

    messages.push({ role: "assistant", content: turn.content ?? "", tool_calls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      toolCalls++;
      const result =
        clock() >= opts.deadline
          ? { error: "The digest's time budget ran out before this could be checked." }
          : await opts.runTool(call);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      } as ChatMessage & Record<string, unknown>);
    }
  }

  return { content: null, aiCalls, toolCalls, stoppedBy: "iterations" };
}

/**
 * Production `completeTurn`: one cheap-tier call that may answer with tools.
 *
 * Returns null on any failure — same contract as completeText, and for the same
 * reason: a background cycle has nobody to report an exception to, so a dead
 * gateway must end the cycle quietly rather than reject the route.
 */
async function completeTurnLive(messages: ChatMessage[], tools: ToolDecl[]): Promise<ProactiveTurn | null> {
  try {
    const res = await aiChatCompletion({
      model: selectModel("summary"),
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
      stream: false,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }>;
    };
    const message = data?.choices?.[0]?.message;
    if (!message) return null;
    return {
      content: typeof message.content === "string" && message.content.trim() ? message.content : null,
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    };
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

/**
 * Quoted spans, removed before the filler test runs on `content`.
 *
 * A REAL FALSE POSITIVE THE TOOL LOOP INTRODUCES. Before the digest had tools,
 * `content` was model prose about rows this file had already read, so a
 * pleasantry in it really was the model padding. Now the model can read mail
 * subjects and news headlines and quote them, and third parties write exactly
 * the strings this regex hunts: a thread titled "Hope your week is going well"
 * or a headline "Nothing new to report from the Fed" makes a specific,
 * genuinely actionable insight — "the thread X is still unanswered from
 * Tuesday" — get dropped for words Atlas did not choose.
 *
 * So the test now runs on the content with quoted spans blanked out. A
 * pleasantry inside quotation marks is somebody else's voice being reported;
 * one outside them is Atlas's own, which is the thing worth refusing. The
 * TITLE is still tested whole and unmodified — a title is Atlas speaking in its
 * own voice no matter what punctuation it contains, and "Hope you're well"
 * as a headline is filler even if the model wrapped it in quotes.
 *
 * Straight and curly DOUBLE quotes only. Single quotes were tried and dropped:
 * apostrophes in contractions pair up ("you're … don't") and would blank a
 * span of Atlas's own prose, which is the exact prose this gate exists to read.
 */
const QUOTED_SPAN_RE = /"[^"]*"|“[^”]*”/g;

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
    if (GENERIC_RE.test(title)) continue;
    if (GENERIC_RE.test(content.replace(QUOTED_SPAN_RE, " "))) continue;
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

/**
 * The digest's instructions. `withTools` adds the paragraph that only makes
 * sense when there is a port — telling a toolless model to "look things up"
 * produces invented weather.
 */
function digestSystemPrompt(nowIsoText: string, withTools: boolean): string {
  const base =
    "You are Atlas's proactive digest process. From the user's recent context, produce at most " +
    `${MAX_INSIGHTS} proactive insights that are genuinely actionable or timely: a reminder tied to an ` +
    "upcoming event or task, a follow-up on something the user left unresolved, or a concrete connection " +
    "worth surfacing right now. Every insight must reference something specific from the context. " +
    "NEVER produce filler, greetings, pleasantries, or generic advice — if nothing clears that bar, " +
    "return []. ";
  const tools = withTools
    ? "You may look things up on the user's desktop first — weather, quotes, headlines, their own lists. " +
      "You have very few lookups available, so only use one when it would change what you write. " +
      "Everything you can reach is read-only; you are running in the background with nobody at the " +
      "keyboard, so do not attempt to change anything. "
    : "";
  return (
    base +
    tools +
    'When you are ready, respond ONLY with a JSON array: [{"title": "...", "content": "..."}]. ' +
    `Current date/time: ${nowIsoText}`
  );
}

export function createProactiveHandlers({
  db,
  requireUser,
  json,
  complete = completeText,
  completeTurn = completeTurnLive,
  hasKey = hasAIKey,
  now = () => new Date(),
  control = createControlClient(),
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

    // Read-only desktop tools, and only the desktop ones. The chat tools that
    // buildAtlasTools also returns are deliberately dropped: web_search and
    // deep_research would let a background timer spend research money, and
    // memory_store would let the digest rewrite the user's memory from text it
    // just fetched off the internet. The digest reports; it does not learn.
    const caps = control.available() ? await control.capabilities() : [];
    const tools = buildAtlasTools(caps, { allowMutating: false }).filter((t) =>
      t.function.name.startsWith("atlas_"),
    );

    let stoppedBy: ToolLoopOutcome["stoppedBy"] | undefined;
    let content: string | null;

    if (tools.length === 0) {
      // No port, no tools: exactly one AI call, as this file has always done.
      content = await complete(digestSystemPrompt(nowDate.toISOString(), false), signal);
    } else {
      const deadline = Date.now() + PROACTIVE_WALL_CLOCK_MS;
      const outcome = await proactiveToolLoop({
        messages: [
          { role: "system", content: digestSystemPrompt(nowDate.toISOString(), true) },
          { role: "user", content: signal },
        ],
        tools,
        complete: completeTurn,
        deadline,
        runTool: async (toolCall) =>
          (
            await executeTool(toolCall, {
              userId,
              supabase: null,
              control,
              deadline,
              // No user JWT here — the scheduler never has one (see
              // latestLocalUser). mail.* therefore cannot run from the digest
              // even if it were somehow reached, which is the right answer.
              profile: "background",
              allowMutating: false,
            })
          ).result,
      });
      stoppedBy = outcome.stoppedBy;
      content = outcome.content;
    }

    const parsed = parseModelJson(content);

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
    // `stoppedBy` only appears on the tool path, so the toolless response body
    // is byte-identical to what it was before this loop existed.
    return json(stoppedBy ? { ok: true, insightsCreated, stoppedBy } : { ok: true, insightsCreated });
  }

  return { cycle };
}
