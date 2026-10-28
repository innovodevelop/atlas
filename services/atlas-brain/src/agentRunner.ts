/**
 * The agent runner — executes `runs` rows step by step (Beta Agent View,
 * left-out rows 85–88).
 *
 * WHY IT LIVES HERE. Until this file nothing in the local stack executed a
 * run: `runs`, `run_steps` and `tool_calls` were written by an edge function
 * that went away with Supabase, and a run created from a schedule's "Run now"
 * sat in `pending` forever. The brain already owns everything a run needs —
 * the model gateway, the desktop tools (`buildAtlasTools` + the control port
 * client) and atlas.db through bun:sqlite — so the runner is a brain loop
 * rather than a Rust one, and its logic is testable on Linux.
 *
 * WHAT A RUN DOES, in order:
 *   1. Claims a `pending` row (compare-and-set, so a run is executed once).
 *   2. Plans: one model call turns the goal into at most `agents.max_steps`
 *      steps. The plan is written to `runs.plan_json` BEFORE any step runs,
 *      so the Agent View can show the whole plan ahead of time, and each step
 *      carries its own status there, so progress is measured as done/total.
 *      When no model answer is usable the goal itself is the one-step plan
 *      (`source: "goal"`), so progress is still honest.
 *   3. Runs each step as a short tool loop over the desktop tools, with the
 *      `background` profile: writes run audited, and anything Rust treats as
 *      an actuation is queued as an approval instead of running. Every call
 *      carries the run id, so Rust files its `tool_calls` and `approvals`
 *      rows under this run.
 *   4. Between steps (and once more before it finishes) it checks the run's
 *      row: `paused_at` set → it waits; an approval of this run still pending
 *      and unexpired → it waits ("Waiting for you"); `cancelled` → it stops.
 *      Resume clears `paused_at` and the next step starts where the plan left
 *      off.
 *
 * UNDO. Each mutating call records its inverse with the step, where one
 * exists (`undoFor`): a task, note, calendar event or watchlist entry the run
 * created is deleted; a task or note it edited gets the edited fields back.
 * Mail, music, the Clock and anything that ran through an approval have no
 * inverse here and are recorded as such, so "Stop and undo" can list them as
 * steps that cannot be undone. Undo runs newest first. Smart-home calls are
 * not in this list because a run cannot make one: the tool layer
 * (orchestrator.ts ATLAS_TOOL_OPS) declares no home tool.
 *
 * WHAT IT DOES NOT DO. It does not enforce `agents.daily_budget_limit` (no
 * cost is computed for a model call anywhere in the brain), and it does not
 * read `agents.enabled_tools_json`: that list names the legacy tool set
 * (`task_create`, `shell_exec`, …), none of which exists, while the tools a
 * run really has are the desktop ones the control port advertises. Rust's
 * tier policy, not that list, decides what may run unattended.
 *
 * These writes go through bun:sqlite and emit no `db:changed`, so the Agent
 * View polls while a run is live (see useAgentRuns).
 */
import type { Database } from "bun:sqlite";
import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";
import { selectModel } from "../../../supabase/functions/_shared/providerRouting.ts";
import {
  buildAtlasTools,
  executeTool,
  isMutatingAtlasOp,
  type ChatMessage,
  type ToolCall,
  type ToolDecl,
} from "../../../supabase/functions/_shared/orchestrator.ts";
import type { CallOpts, ControlClient, ControlResult } from "./control.ts";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** How often the loop looks for a pending run, and a paused run for its resume. */
export const RUNNER_POLL_MS = 2_000;
/** Model calls inside one step. A step is one item of a plan, not a whole goal. */
export const STEP_MAX_AI_CALLS = 4;
/** Wall clock for one step's tool work. */
export const STEP_WALL_CLOCK_MS = 90_000;
/** A plan never runs longer than this, whatever the agent's own limit says. */
export const PLAN_MAX_STEPS = 12;
/**
 * Runs worked at once. More than one, so a run paused or waiting for an
 * answer does not hold every other run back; few, because each one is a
 * stream of model calls.
 */
export const MAX_PARALLEL_RUNS = 3;
/**
 * A pending run older than this when the brain starts is closed, not started.
 * Before this runner existed, "Run now" rows piled up unexecuted; starting
 * them all at the next launch would surprise the user with work they asked
 * for weeks ago.
 */
export const STALE_PENDING_MS = 10 * 60_000;

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * `runs.paused_at` — set while a run is paused. A column rather than a new
 * value of `runs.status`: the status CHECK list is part of the table, and
 * SQLite can only change it by rebuilding `runs`, which would cascade-delete
 * every run's steps and approvals on the way. A paused run keeps its live
 * status; the Agent View reads `paused_at` as the "Paused" state.
 *
 * db_schema.sql declares the column for fresh installs; this adds it to a DB
 * created before it existed (same pattern as ensurePersonalityColumns).
 */
export function ensureAgentRunSchema(db: Database): void {
  try {
    const cols = db.query(`PRAGMA table_info(runs)`).all() as { name: string }[];
    if (cols.length && !cols.some((c) => c.name === "paused_at")) {
      db.exec(`ALTER TABLE runs ADD COLUMN paused_at TEXT`);
    }
  } catch { /* no runs table yet — the Rust schema creates it with the column */ }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type PlanStepStatus = "todo" | "now" | "done" | "failed" | "stopped";

export interface PlannedStep {
  title: string;
  detail: string;
  status: PlanStepStatus;
  started_at?: string;
  finished_at?: string;
  /** What the step did and found, in the model's own words (clipped). */
  summary?: string;
}

/** What `runs.plan_json` holds. */
export interface RunPlan {
  steps: PlannedStep[];
  /** "model": the planner's answer; "goal": no usable answer, so the goal is the plan. */
  source: "model" | "goal";
  written_at: string;
}

function clip(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The first JSON array in model output (fenced or bare), or null. */
function firstJsonArray(content: string | null): unknown[] | null {
  if (!content) return null;
  const m = content.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(m[0]);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The planner's answer as a plan, capped at `maxSteps`; the goal as a
 * one-step plan when the answer has no usable step. Never throws.
 */
export function parsePlan(content: string | null, goal: string, maxSteps: number, at: string = nowIso()): RunPlan {
  const cap = Math.max(1, Math.min(PLAN_MAX_STEPS, Math.floor(maxSteps) || 1));
  const steps: PlannedStep[] = [];
  for (const item of firstJsonArray(content) ?? []) {
    if (steps.length >= cap) break;
    if (typeof item === "string" && item.trim()) {
      steps.push({ title: clip(item, 120), detail: "", status: "todo" });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title : typeof o.step === "string" ? o.step : "";
      if (!title.trim()) continue;
      steps.push({ title: clip(title, 120), detail: typeof o.detail === "string" ? clip(o.detail, 300) : "", status: "todo" });
    }
  }
  if (steps.length) return { steps, source: "model", written_at: at };
  return { steps: [{ title: clip(goal, 120) || "Work the goal", detail: "", status: "todo" }], source: "goal", written_at: at };
}

function planSystemPrompt(maxSteps: number, toolNames: string[], agentPrompt: string | null): string {
  // The agent's own instructions say what kind of work this is ("you triage
  // my inbox"); a goal like "Scheduled run: Morning" means little without them.
  const role = agentPrompt?.trim() ? `\n\nThe agent this run belongs to is told:\n${clip(agentPrompt, 1_500)}` : "";
  return (
    "You plan work for Atlas, a personal assistant on the user's Mac. Break the goal into the fewest concrete steps " +
    `that reach it — at most ${maxSteps}. Each step must be something Atlas can do with these tools: ` +
    `${toolNames.length ? toolNames.join(", ") : "none (reasoning and writing only)"}. ` +
    'Respond ONLY with a JSON array: [{"title": "short imperative", "detail": "what done looks like"}].' +
    role
  );
}

function stepSystemPrompt(agentPrompt: string, goal: string, plan: RunPlan, index: number, earlier: string[]): string {
  const list = plan.steps.map((s, i) => `${i + 1}. ${s.title}${i === index ? "   <- this step" : ""}`).join("\n");
  const done = earlier.length ? `\n\nWhat the earlier steps found:\n${earlier.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "";
  return (
    `${agentPrompt.trim()}\n\n` +
    `You are working one step of a run for the user. The goal: ${goal}\n\nThe plan:\n${list}${done}\n\n` +
    "Do ONLY the marked step, using the tools when they help, then answer with one or two sentences saying what " +
    "you did and found. If a tool says an action is waiting for the user's approval, say it is waiting — never that " +
    "it is done. Nobody is watching live: do not ask questions, do the step as well as the tools allow."
  );
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Tables an undo may touch, with the columns a restore may write. Literals only. */
const UNDO_TABLES = {
  user_tasks: ["title", "completed", "priority", "due_date"],
  user_notes: ["title", "content"],
  user_events: [] as string[],
  user_watchlist: [] as string[],
} as const;
export type UndoTable = keyof typeof UNDO_TABLES;

export type UndoAction =
  | { kind: "delete"; table: UndoTable; id: string }
  | { kind: "restore"; table: UndoTable; id: string; values: Record<string, unknown> };

/** What a mutating call leaves for "Stop and undo": an inverse, or the reason there is none. */
export interface UndoRecord {
  /** One line naming what the call did, for the confirmation list. */
  label: string;
  action: UndoAction | null;
  /** Set when `action` is null. */
  reason?: string;
  /** Set when the call was queued for approval instead of running. */
  approval_id?: string;
}

const CREATE_TABLE: Record<string, UndoTable> = {
  "tasks.create": "user_tasks",
  "notes.create": "user_notes",
  "events.create": "user_events",
  "watchlist.add": "user_watchlist",
};
const UPDATE_TABLE: Record<string, UndoTable> = {
  "tasks.update": "user_tasks",
  "notes.update": "user_notes",
};

/** What each create is called in the confirmation list. */
const NOUN: Record<string, string> = {
  "tasks.create": "task",
  "notes.create": "note",
  "events.create": "calendar event",
  "watchlist.add": "watchlist entry",
  "tasks.update": "task",
  "notes.update": "note",
};

/** Calls that change something Atlas cannot put back, and why — the "can't be undone" list. */
const NO_INVERSE: Record<string, { label: string; reason: string }> = {
  "mail.archive": { label: "Archived a mail thread", reason: "Mail has no un-archive Atlas can run." },
  "mail.mark_read": { label: "Marked a mail thread read", reason: "Mail has no mark-unread Atlas can run." },
  "music.play": { label: "Started playback", reason: "Playback cannot be put back the way it was." },
  "music.pause": { label: "Paused playback", reason: "Playback cannot be put back the way it was." },
  "music.volume": { label: "Changed the volume", reason: "The previous volume was not recorded." },
  "clock.set_alarm": { label: "Set an alarm", reason: "The Clock has no remove-alarm Atlas can run; delete it in Clock." },
  "clock.stop_alarm": { label: "Stopped an alarm", reason: "A stopped alarm cannot ring again." },
  "clock.snooze_alarm": { label: "Snoozed an alarm", reason: "A snooze cannot be taken back." },
};

function rowOf(data: unknown): Record<string, unknown> | null {
  const row = (data as { row?: unknown } | null)?.row;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

function nameOf(args: Record<string, unknown>, row: Record<string, unknown> | null): string {
  const v = row?.title ?? row?.symbol ?? args.title ?? args.symbol;
  return typeof v === "string" && v.trim() ? `“${clip(v, 60)}”` : "";
}

/**
 * The record a call leaves behind, or null for a call that changed nothing
 * (a read, a refused or failed call). `before` is the row as it stood before
 * an update — the runner reads it just ahead of the call.
 */
export function undoFor(
  op: string,
  args: Record<string, unknown>,
  result: ControlResult,
  before: Record<string, unknown> | null = null,
): UndoRecord | null {
  if (!isMutatingAtlasOp(op) || !result.ok) return null;
  const data = result.data as Record<string, unknown> | null;
  const row = rowOf(data);
  const what = nameOf(args, row);
  const noun = NOUN[op] ?? op;

  if (data && data.status === "awaiting_approval") {
    const summary = typeof data.action_summary === "string" ? clip(data.action_summary, 120) : op;
    return {
      label: summary,
      action: null,
      reason: "It ran only once you approved it, outside this run, so it cannot be taken back from here.",
      approval_id: typeof data.approval_id === "string" ? data.approval_id : undefined,
    };
  }

  const created = CREATE_TABLE[op];
  if (created) {
    // `watchlist.add` answers "unchanged" when the symbol was already listed:
    // the run created nothing, so there is nothing to take back.
    if (data?.action !== "created") return null;
    const id = row?.id;
    const label = `Created the ${noun} ${what}`.trim();
    if (typeof id !== "string" || !id) {
      return { label, action: null, reason: "The new row's id did not come back, so it cannot be found again." };
    }
    return { label, action: { kind: "delete", table: created, id } };
  }

  const updated = UPDATE_TABLE[op];
  if (updated) {
    const id = typeof args.id === "string" ? args.id : null;
    const changed = Array.isArray(data?.changed) ? (data.changed as unknown[]).filter((c): c is string => typeof c === "string") : [];
    const allowed = UNDO_TABLES[updated] as readonly string[];
    const values: Record<string, unknown> = {};
    for (const c of changed) if (allowed.includes(c) && before && c in before) values[c] = before[c];
    const label = `Edited the ${noun} ${what || nameOf({}, before)}`.trim();
    if (!id || !before || !Object.keys(values).length) {
      return { label, action: null, reason: "The values before the edit were not recorded." };
    }
    return { label, action: { kind: "restore", table: updated, id, values } };
  }

  const known = NO_INVERSE[op];
  return { label: known?.label ?? op, action: null, reason: known?.reason ?? "This action has no inverse." };
}

/** Run one inverse against atlas.db, scoped to the run's user. Never throws. */
export function applyUndo(db: Database, userId: string, action: UndoAction): { ok: boolean; message: string } {
  if (!(action.table in UNDO_TABLES)) return { ok: false, message: `Not an undoable table: ${action.table}` };
  try {
    if (action.kind === "delete") {
      const r = db.prepare(`DELETE FROM ${action.table} WHERE id = ? AND user_id = ?`).run(action.id, userId);
      return r.changes ? { ok: true, message: "Removed." } : { ok: true, message: "Already gone." };
    }
    const allowed = UNDO_TABLES[action.table] as readonly string[];
    const cols = Object.keys(action.values).filter((c) => allowed.includes(c));
    if (!cols.length) return { ok: false, message: "Nothing to put back." };
    const r = db
      .prepare(`UPDATE ${action.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND user_id = ?`)
      .run(...cols.map((c) => action.values[c] as string | number | null), action.id, userId);
    return r.changes ? { ok: true, message: "Put back as it was." } : { ok: false, message: "It no longer exists." };
  } catch (e) {
    return { ok: false, message: String(e).slice(0, 200) };
  }
}

function readBefore(db: Database, userId: string, op: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const table = UPDATE_TABLE[op];
  if (!table || typeof args.id !== "string") return null;
  try {
    return (db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(args.id, userId) as Record<string, unknown> | null) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  user_id: string;
  agent_id: string;
  status: string;
  goal_text: string;
  plan_json: string | null;
  paused_at: string | null;
}

interface AgentRow {
  system_prompt: string;
  max_steps: number | null;
}

type StepKind = "planning" | "thinking" | "tool_call" | "tool_result" | "response" | "verification" | "error";

/** The statuses in which the runner may still be working a run. */
const LIVE = new Set(["pending", "planning", "running", "verifying"]);

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** One model turn, reduced to what the runner reads. */
export interface ModelTurn {
  content: string | null;
  toolCalls: ToolCall[];
  tokens: number;
}

export type CompleteFn = (model: string, messages: ChatMessage[], tools: ToolDecl[]) => Promise<ModelTurn | null>;

type ToolRunner = typeof executeTool;
type ControlLike = Pick<ControlClient, "available" | "capabilities" | "call">;

export interface RunnerDeps {
  db: Database;
  control?: ControlLike;
  complete?: CompleteFn;
  hasKey?: () => boolean;
  runTool?: ToolRunner;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  now?: () => number;
}

export interface UndoReport {
  undone: Array<{ stepId: string; label: string; message: string }>;
  failed: Array<{ stepId: string; label: string; message: string }>;
  cannot: Array<{ stepId: string; label: string; reason: string }>;
}

export type ActionResult = { ok: true } | { ok: false; error: string; status: number };

export interface StopResult {
  ok: true;
  /** False when the run had already ended before this stop arrived. */
  stopped: boolean;
  /** Approvals of this run that were still waiting and are now closed unanswered. */
  approvalsClosed: number;
  /** The undo's report; "after-step" when it waits for a step still in flight. */
  undo?: UndoReport | "after-step";
}

async function completeLive(model: string, messages: ChatMessage[], tools: ToolDecl[]): Promise<ModelTurn | null> {
  try {
    const res = await aiChatCompletion({
      model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      stream: false,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }>;
      usage?: { total_tokens?: number };
    };
    const message = data?.choices?.[0]?.message;
    if (!message) return null;
    return {
      content: typeof message.content === "string" && message.content.trim() ? message.content : null,
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      tokens: typeof data.usage?.total_tokens === "number" ? data.usage.total_tokens : 0,
    };
  } catch {
    return null;
  }
}

const STOPPED_REASON = "The run was stopped before this was answered. Nothing was run.";

export function createAgentRunner(deps: RunnerDeps) {
  const { db, control } = deps;
  const complete = deps.complete ?? completeLive;
  const hasKey = deps.hasKey ?? hasAIKey;
  const runTool = deps.runTool ?? executeTool;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? RUNNER_POLL_MS;
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();

  ensureAgentRunSchema(db);

  /** Runs being executed, with the promise that settles when each ends. */
  const inFlight = new Map<string, Promise<void>>();
  /** Runs whose stop asked for an undo while the runner was still inside them. */
  const undoAfterStop = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const readRun = (runId: string) =>
    db.prepare(`SELECT id, user_id, agent_id, status, goal_text, plan_json, paused_at FROM runs WHERE id = ?`).get(runId) as RunRow | null;

  function nextIndex(runId: string): number {
    const r = db.prepare(`SELECT COALESCE(MAX(step_index), -1) AS m FROM run_steps WHERE run_id = ?`).get(runId) as { m: number };
    return r.m + 1;
  }

  function insertStep(runId: string, kind: StepKind, input: unknown, output: unknown, opts: { model?: string | null; tier?: string | null; tokens?: number; finished?: boolean } = {}): string {
    const id = crypto.randomUUID();
    const at = iso();
    db.prepare(
      `INSERT INTO run_steps (id, run_id, step_index, kind, model_tier, model_used, input_json, output_json, tokens_used, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, runId, nextIndex(runId), kind, opts.tier ?? null, opts.model ?? null,
      input == null ? null : JSON.stringify(input),
      output == null ? null : JSON.stringify(output),
      opts.tokens ?? 0, at, opts.finished === false ? null : at,
    );
    return id;
  }

  function finishStep(stepId: string, output: unknown, tokens = 0): void {
    db.prepare(`UPDATE run_steps SET output_json = ?, tokens_used = tokens_used + ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(output), tokens, iso(), stepId);
  }

  function addTokens(runId: string, column: "tokens_planner" | "tokens_worker", n: number): void {
    if (n > 0) db.prepare(`UPDATE runs SET ${column} = COALESCE(${column}, 0) + ? WHERE id = ?`).run(n, runId);
  }

  /** Write the plan, with every step's status, where the Agent View reads it. */
  function savePlan(runId: string, p: RunPlan): void {
    db.prepare(`UPDATE runs SET plan_json = ? WHERE id = ?`).run(JSON.stringify(p), runId);
  }

  function markStep(runId: string, p: RunPlan, index: number, patch: Partial<PlannedStep>): void {
    p.steps[index] = { ...p.steps[index], ...patch };
    savePlan(runId, p);
  }

  /** Move a live run to a new status; never revives one the user stopped. */
  function setStatus(runId: string, status: string, extra: { error?: string; result?: unknown } = {}): void {
    const finished = status === "completed" || status === "failed";
    db.prepare(
      `UPDATE runs SET status = ?, error_message = COALESCE(?, error_message), result_json = COALESCE(?, result_json),
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END, paused_at = CASE WHEN ? THEN NULL ELSE paused_at END
       WHERE id = ? AND status NOT IN ('cancelled','completed','failed')`,
    ).run(status, extra.error ?? null, extra.result == null ? null : JSON.stringify(extra.result), finished ? 1 : 0, iso(), finished ? 1 : 0, runId);
  }

  const stopped = (runId: string) => readRun(runId)?.status === "cancelled";

  /** Approvals of this run that are still answerable. Expired ones no longer hold it up. */
  function waitingApprovals(runId: string): number {
    const r = db.prepare(
      `SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`,
    ).get(runId, iso()) as { n: number };
    return r.n;
  }

  /**
   * Between steps: go on, or wait while the run is paused or one of its
   * approvals is unanswered, or stop once it is cancelled.
   */
  async function gate(runId: string): Promise<"go" | "stop"> {
    for (;;) {
      const run = readRun(runId);
      if (!run || run.status === "cancelled") return "stop";
      if (!run.paused_at && waitingApprovals(runId) === 0) return "go";
      await sleep(pollMs);
    }
  }

  /** The control client this run's tool calls go through: run id attached, inverse recorded. */
  function runControl(runId: string, userId: string, planStep: number): ControlLike | undefined {
    if (!control) return undefined;
    return {
      available: () => control.available(),
      capabilities: () => control.capabilities(),
      async call(op: string, args: unknown, opts: CallOpts): Promise<ControlResult> {
        // Stop means no further side effects, even inside the step in flight.
        if (stopped(runId)) {
          return { ok: false, error: { code: "not_permitted", message: "The run was stopped before this could run.", retryable: false } };
        }
        const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
        const before = readBefore(db, userId, op, a);
        const stepId = insertStep(runId, "tool_call", { plan_step: planStep, op, args: a }, null, { finished: false });
        const result = await control.call(op, args, { ...opts, runId });
        const undo = undoFor(op, a, result, before);
        finishStep(stepId, {
          ok: result.ok,
          ...(result.ok ? { result: result.data } : { error: result.error.message }),
          ...(undo ? { undo } : {}),
        });
        return result;
      },
    };
  }

  async function plan(run: RunRow, agent: AgentRow | null, toolNames: string[]): Promise<RunPlan> {
    const maxSteps = Math.min(PLAN_MAX_STEPS, Math.max(1, agent?.max_steps ?? PLAN_MAX_STEPS));
    const model = selectModel("planning");
    const stepId = insertStep(run.id, "planning", { goal: run.goal_text, max_steps: maxSteps }, null, { model, tier: "planner", finished: false });
    const turn = await complete(model, [
      { role: "system", content: planSystemPrompt(maxSteps, toolNames, agent?.system_prompt ?? null) },
      { role: "user", content: run.goal_text },
    ], []);
    const p = parsePlan(turn?.content ?? null, run.goal_text, maxSteps, iso());
    finishStep(stepId, { steps: p.steps.length, source: p.source }, turn?.tokens ?? 0);
    addTokens(run.id, "tokens_planner", turn?.tokens ?? 0);
    savePlan(run.id, p);
    return p;
  }

  /** One plan step: a bounded tool loop. Returns the step's own summary line. */
  async function step(run: RunRow, agent: AgentRow | null, p: RunPlan, index: number, earlier: string[], tools: ToolDecl[]): Promise<string | null> {
    const model = selectModel("chat");
    const deadline = now() + STEP_WALL_CLOCK_MS;
    const ctl = runControl(run.id, run.user_id, index);
    const messages: Array<ChatMessage & Record<string, unknown>> = [
      { role: "system", content: stepSystemPrompt(agent?.system_prompt ?? "You are Atlas.", run.goal_text, p, index, earlier) },
      { role: "user", content: `Step ${index + 1}: ${p.steps[index].title}${p.steps[index].detail ? ` — ${p.steps[index].detail}` : ""}` },
    ];
    let tokens = 0;
    let answer: string | null = null;
    for (let calls = 0; calls < STEP_MAX_AI_CALLS; calls++) {
      if (now() >= deadline || stopped(run.id)) break;
      const turn = await complete(model, messages, tools);
      if (!turn) break;
      tokens += turn.tokens;
      if (!turn.toolCalls.length || calls === STEP_MAX_AI_CALLS - 1) { answer = turn.content; break; }
      messages.push({ role: "assistant", content: turn.content ?? "", tool_calls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        const result = now() >= deadline
          ? { error: "This step's time budget ran out before the call could run." }
          : (await runTool(call, { userId: run.user_id, supabase: null, control: ctl, deadline, profile: "background", allowMutating: true })).result;
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    addTokens(run.id, "tokens_worker", tokens);
    insertStep(run.id, answer ? "response" : "error", { plan_step: index, title: p.steps[index].title },
      answer ? { text: clip(answer, 1_000) } : { reason: stopped(run.id) ? "Stopped." : "The model gave no usable answer for this step." },
      { model, tier: "worker", tokens });
    return answer ? clip(answer, 300) : null;
  }

  /** Execute one run from `pending` to its end. Resolves; never throws. */
  async function executeRun(runId: string): Promise<void> {
    const claimed = db.prepare(`UPDATE runs SET status = 'planning', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'pending'`).run(iso(), runId);
    if (!claimed.changes) return;
    const run = readRun(runId)!;
    try {
      if (!hasKey()) {
        insertStep(runId, "error", null, { reason: "No AI key is configured, so the run could not be planned." });
        setStatus(runId, "failed", { error: "No AI key is configured." });
        return;
      }
      const agent = db.prepare(`SELECT system_prompt, max_steps FROM agents WHERE id = ?`).get(run.agent_id) as AgentRow | null;
      const caps = control?.available() ? await control.capabilities() : [];
      const tools = buildAtlasTools(caps, { allowMutating: true }).filter((t) => t.function.name.startsWith("atlas_"));

      const p = await plan(run, agent, tools.map((t) => t.function.name));
      setStatus(runId, "running");

      const earlier: string[] = [];
      let failures = 0;
      for (let i = 0; i < p.steps.length; i++) {
        if ((await gate(runId)) === "stop") break;
        markStep(runId, p, i, { status: "now", started_at: iso() });
        const line = await step(run, agent, p, i, earlier, tools);
        const status: PlanStepStatus = line ? "done" : stopped(runId) ? "stopped" : "failed";
        markStep(runId, p, i, { status, finished_at: iso(), ...(line ? { summary: line } : {}) });
        if (line) earlier.push(line); else failures++;
      }
      // The last step may have queued a question: the run is not done until
      // it is answered (or expires), or the user stops it.
      if (!stopped(runId) && (await gate(runId)) === "go") {
        if (failures === p.steps.length) setStatus(runId, "failed", { error: "No step produced a usable answer." });
        else setStatus(runId, "completed", { result: { summary: earlier[earlier.length - 1] ?? "", steps: p.steps.length, failed_steps: failures } });
      }
    } catch (e) {
      insertStep(runId, "error", null, { reason: String(e).slice(0, 500) });
      setStatus(runId, "failed", { error: String(e).slice(0, 500) });
    } finally {
      const owner = undoAfterStop.get(runId);
      if (owner) { undoAfterStop.delete(runId); undoRun(runId, owner); }
    }
  }

  /** One sweep: start the oldest pending runs while there is room. */
  function tick(): void {
    while (inFlight.size < MAX_PARALLEL_RUNS) {
      const busy = [...inFlight.keys()];
      const next = db.prepare(
        `SELECT id FROM runs WHERE status = 'pending'${busy.length ? ` AND id NOT IN (${busy.map(() => "?").join(",")})` : ""}
         ORDER BY created_at ASC LIMIT 1`,
      ).get(...busy) as { id: string } | null;
      if (!next) return;
      const id = next.id;
      inFlight.set(id, executeRun(id).finally(() => { inFlight.delete(id); }));
    }
  }

  /**
   * Runs left mid-way by a brain that stopped. The loop above lives in memory,
   * so nothing would ever move them again; they are closed as failed rather
   * than shown as working forever. Pending runs older than STALE_PENDING_MS
   * are closed too, unstarted (see there).
   */
  function recoverOrphans(): number {
    const at = iso();
    const orphaned = db.prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?, paused_at = NULL,
         error_message = 'Atlas stopped while this run was in progress; it was not resumed.'
       WHERE status IN ('planning','running','verifying')`,
    ).run(at);
    const stale = db.prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?,
         error_message = 'Atlas was not running agents when this was asked for, and it was not started this long afterwards.'
       WHERE status = 'pending' AND created_at < ?`,
    ).run(at, new Date(now() - STALE_PENDING_MS).toISOString());
    return orphaned.changes + stale.changes;
  }

  function start(): () => void {
    ensureAgentRunSchema(db);
    try { recoverOrphans(); } catch (e) { console.warn("[agent-runner] orphan sweep failed:", e); }
    timer = setInterval(() => { try { tick(); } catch (e) { console.warn("[agent-runner] tick failed:", e); } }, pollMs);
    return () => { if (timer) clearInterval(timer); timer = null; };
  }

  function owned(runId: string, userId: string): RunRow | null {
    const run = readRun(runId);
    return run && run.user_id === userId ? run : null;
  }

  function pause(runId: string, userId: string): ActionResult {
    const run = owned(runId, userId);
    if (!run) return { ok: false, error: "No such run.", status: 404 };
    if (!LIVE.has(run.status)) return { ok: false, error: "Only a run that is still going can be paused.", status: 409 };
    db.prepare(`UPDATE runs SET paused_at = COALESCE(paused_at, ?) WHERE id = ?`).run(iso(), runId);
    return { ok: true };
  }

  function resume(runId: string, userId: string): ActionResult {
    const run = owned(runId, userId);
    if (!run) return { ok: false, error: "No such run.", status: 404 };
    if (!LIVE.has(run.status)) return { ok: false, error: "This run has ended, so there is nothing to resume.", status: 409 };
    db.prepare(`UPDATE runs SET paused_at = NULL WHERE id = ?`).run(runId);
    return { ok: true };
  }

  /** Is the approval behind a queued call one that actually ran? */
  function approvalRan(approvalId: string | undefined): boolean {
    if (!approvalId) return false;
    const a = db.prepare(`SELECT status FROM approvals WHERE id = ?`).get(approvalId) as { status: string } | null;
    return a?.status === "approved";
  }

  /** Inverses of every recorded step not yet undone, newest first. */
  function undoRun(runId: string, userId: string): UndoReport {
    const report: UndoReport = { undone: [], failed: [], cannot: [] };
    const rows = db.prepare(`SELECT id, input_json, output_json FROM run_steps WHERE run_id = ? AND kind = 'tool_call' ORDER BY step_index DESC`).all(runId) as Array<{ id: string; input_json: string | null; output_json: string | null }>;
    const already = new Set<string>();
    for (const r of rows) {
      const undoOf = parseObject(r.input_json)?.undo_of;
      if (typeof undoOf === "string") already.add(undoOf);
    }
    for (const r of rows) {
      if (already.has(r.id)) continue;
      const undo = parseObject(r.output_json)?.undo as UndoRecord | undefined;
      if (!undo || typeof undo !== "object") continue;
      if (!undo.action) {
        // A queued call that was never approved never ran: nothing to take back.
        if (undo.approval_id && !approvalRan(undo.approval_id)) continue;
        report.cannot.push({ stepId: r.id, label: undo.label, reason: undo.reason ?? "" });
        continue;
      }
      const res = applyUndo(db, userId, undo.action);
      insertStep(runId, "tool_call", { undo_of: r.id, op: "undo", label: undo.label }, res);
      (res.ok ? report.undone : report.failed).push({ stepId: r.id, label: undo.label, message: res.message });
    }
    return report;
  }

  /**
   * Close this run's unanswered questions. The webview answers them "no"
   * through `approval_resolve` first (the only path that also drops Rust's
   * in-memory payload); this is the backstop for any it could not reach. A
   * row settled here can never be approved afterwards: `approval_resolve`
   * compare-and-sets on `status = 'pending'` and refuses to run anything
   * once it loses.
   */
  function closeApprovals(runId: string): number {
    const at = iso();
    const rows = db.prepare(`SELECT id, tool_call_id FROM approvals WHERE run_id = ? AND status = 'pending'`).all(runId) as Array<{ id: string; tool_call_id: string }>;
    let closed = 0;
    for (const a of rows) {
      const r = db.prepare(
        `UPDATE approvals SET status = 'rejected', approved_by = 'system', approved_at = ?, reason = ? WHERE id = ? AND status = 'pending'`,
      ).run(at, STOPPED_REASON, a.id);
      if (!r.changes) continue;
      closed++;
      db.prepare(`UPDATE tool_calls SET status = 'rejected', completed_at = ? WHERE id = ? AND status = 'awaiting_approval'`).run(at, a.tool_call_id);
    }
    return closed;
  }

  /**
   * Stop a run; with `undo`, also take back what it did. The stop lands at
   * once (the runner refuses further calls and closes the run's questions);
   * when the runner is inside this run right now the undo waits for it to
   * settle, so nothing the step was still finishing escapes the undo.
   *
   * An undo of a run that already ended is allowed: "Stop and undo" pressed
   * the moment a run finishes should still take back what it did.
   */
  async function stop(runId: string, userId: string, opts: { undo: boolean; settleMs?: number }): Promise<StopResult | (ActionResult & { ok: false })> {
    const run = owned(runId, userId);
    if (!run) return { ok: false, error: "No such run.", status: 404 };
    const r = db.prepare(
      `UPDATE runs SET status = 'cancelled', paused_at = NULL, finished_at = COALESCE(finished_at, ?)
       WHERE id = ? AND status NOT IN ('completed','failed','cancelled')`,
    ).run(iso(), runId);
    const approvalsClosed = closeApprovals(runId);
    const base = { ok: true as const, stopped: r.changes > 0, approvalsClosed };
    if (!opts.undo) return base;
    const running = inFlight.get(runId);
    if (running) {
      const settled = await Promise.race([running.then(() => true), sleep(opts.settleMs ?? 5_000).then(() => false)]);
      if (!settled && inFlight.has(runId)) { undoAfterStop.set(runId, userId); return { ...base, undo: "after-step" }; }
    }
    return { ...base, undo: undoRun(runId, userId) };
  }

  return {
    start, tick, executeRun, recoverOrphans, pause, resume, stop, undoRun,
    /** Ids of the runs being worked right now. */
    get inFlight(): string[] { return [...inFlight.keys()]; },
  };
}

export type AgentRunner = ReturnType<typeof createAgentRunner>;
