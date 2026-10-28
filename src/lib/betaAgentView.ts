/**
 * The Beta Agent View's reading of what Atlas is running — pure, tested here,
 * rendered by src/pages/atlas/BetaAgentView.tsx.
 *
 * `Atlas Agent View Beta.dc.html` draws one kind of thing: a run with a goal,
 * a limit, a plan and a live log. The app has three sources that each hold a
 * part of that picture, and none holds all of it:
 *
 *   - `runs` + `run_steps` + `tool_calls` (the agent tables): a goal, the
 *     step cap the runner applies, the plan the brain's runner writes to
 *     `runs.plan_json` before the first step (each step carrying its own
 *     status), the steps taken with what each can undo, and pause/stop.
 *   - `atlas_agent_sessions` + `atlas_agent_events` (the brain's admin
 *     tables): Claude Code sessions, CI pipelines and self-repair runs, each
 *     with a live event stream but no plan Atlas can read.
 *   - `approvals`: actions the control port queued that wait for the user,
 *     resolved through the Rust `approval_resolve` command. A call an agent
 *     run made carries the run's id, so its question sits inside that run's
 *     plan.
 *
 * This module maps each onto the design's shapes (a card in the run list, the
 * hero's status, plan steps, log lines) without inventing what a source does
 * not have: a run with no agent shows no limit, a session shows milestones
 * where the design shows a plan, and progress is only drawn once it is known
 * (a run's plan gives done/total; a run without one draws no measured bar).
 *
 * The inputs are structural (`RunLike`, `SessionLike`, …) rather than the hook
 * types, because this file sits inside the strict-null boundary and the hooks
 * reach `localClient.ts`, which does not (see tsconfig.strict.json).
 */
import type { QuickSphereState } from '@/lib/quickSphere';

// ---------------------------------------------------------------------------
// Inputs — the columns this module reads, as the hooks deliver them.
// ---------------------------------------------------------------------------

export interface RunLike {
  id: string;
  status: string;
  goal_text: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  cost_estimate: number;
  tokens_planner: number;
  tokens_worker: number;
  tokens_reasoner: number;
  agent?: { name: string };
  /** The runner's plan (JSON text or the parsed object, as localClient delivers it). */
  plan_json?: unknown;
  /** Set while the user has the run paused (absent on databases older than the column). */
  paused_at?: string | null;
}

export interface AgentLike {
  id: string;
  name: string;
  max_steps: number;
  daily_budget_limit: number;
}

export interface RunStepLike {
  id: string;
  step_index: number;
  kind: string;
  input_json: unknown;
  output_json: unknown;
  model_used: string | null;
  tokens_used: number;
  started_at: string;
  finished_at: string | null;
}

export interface ToolCallLike {
  id: string;
  run_id: string | null;
  tool_name: string;
  args_json: unknown;
  status: string;
  error_message: string | null;
  created_at: string;
  /** True (or 1) for a call that was queued for the user's answer. */
  requires_approval?: boolean | number;
}

export interface SessionLike {
  id: string;
  session_type: string;
  status: string;
  task_summary: string | null;
  started_at: string;
  ended_at: string | null;
  metadata: string;
}

export interface SessionEventLike {
  id: string;
  event_type: string;
  payload: string;
  ts: string;
}

export interface ApprovalLike {
  id: string;
  run_id: string | null;
  status: string;
  action_summary: string;
  reason: string | null;
  risk_level: string | null;
  approved_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// The design's vocabulary.
// ---------------------------------------------------------------------------

export type RunState = 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'stopped';
export type LogKind = 'read' | 'think' | 'tool' | 'write' | 'check' | 'error' | 'log';
export type StepMark = 'done' | 'now' | 'todo' | 'failed';
export type CardKind = 'run' | 'session' | 'approvals';

/** The run list's pinned entry for the approval queue (it is not a run). */
export const APPROVALS_CARD_ID = 'approvals';

export interface RunCard {
  id: string;
  kind: CardKind;
  /** The row the card stands for: a run id, a session id, or null for the queue. */
  sourceId: string | null;
  title: string;
  goal: string;
  /** The hero's chip. Runs: the step cap the runner applies; sessions: the session type; queue: none. */
  limit: string | null;
  /** The chip's hover text: what the limit means and what it does not cover. */
  limitNote: string | null;
  state: RunState;
  /** The list's right-hand label (mono). */
  when: string;
  /** The list's second line. */
  sub: string;
  /** 0..1 once the source says how far along it is; null draws no measured bar. */
  progress: number | null;
  /** A run's plan, counted: steps finished of steps planned. Null without a plan. */
  measured: { done: number; total: number } | null;
  startedAt: string | null;
  /**
   * True when a real stop exists for this card while it is live: an agent
   * run (the brain's runner), a CI pipeline (`gh run cancel`) or a self-repair
   * (it runs in the brain). A Claude Code session has none — see `stopNote`.
   */
  canStop: boolean;
  /** True for a live agent run: the runner waits between steps while it is paused. */
  canPause: boolean;
  /** Said instead of a Stop button when the card is live but cannot be stopped from here. */
  stopNote: string | null;
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  mark: StepMark;
  time: string;
  /** Set when the step is a pending approval: its buttons resolve this id. */
  approvalId?: string;
  /** A planned step cut short (a stop, or a brain that went away mid-step); the run never comes back to it. */
  stopped?: boolean;
}

export interface LogLine {
  id: string;
  time: string;
  kind: LogKind;
  message: string;
}

export interface StateMeta {
  label: string;
  /** The dot and the progress bar. */
  dot: string;
  /** The status line's text, on ink. */
  fg: string;
  pulse: boolean;
  sphere: QuickSphereState;
}

/** Design `SC` table; `failed` is the app's own (the design folds it into stopped). */
export const STATE_META: Record<RunState, StateMeta> = {
  running: { label: 'Working', dot: '#e07a1f', fg: '#ffb36b', pulse: true, sphere: 'working' },
  waiting: { label: 'Waiting for you', dot: '#3461f2', fg: '#8fa9ff', pulse: true, sphere: 'listening' },
  paused: { label: 'Paused', dot: '#b6b1aa', fg: 'rgba(249,247,244,.78)', pulse: false, sphere: 'muted' },
  done: { label: 'Done', dot: '#0fae76', fg: '#50dca0', pulse: false, sphere: 'success' },
  failed: { label: 'Failed', dot: '#d0453a', fg: '#ff9d8a', pulse: false, sphere: 'alert' },
  stopped: { label: 'Stopped', dot: '#d0453a', fg: '#ff9d8a', pulse: false, sphere: 'idle' },
};

/** Design `K` table, plus the two kinds the app's sources add. */
export const KIND_COLOUR: Record<LogKind, string> = {
  read: '#8fa9ff',
  think: '#b6a8ff',
  tool: '#ffb36b',
  write: '#50dca0',
  check: '#50dca0',
  error: '#ff9d8a',
  log: 'rgba(249,247,244,.62)',
};

export function isLive(state: RunState): boolean {
  return state === 'running' || state === 'waiting' || state === 'paused';
}

// ---------------------------------------------------------------------------
// Time and text.
// ---------------------------------------------------------------------------

/** "09:02:14" — the log's left column. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toTimeString().slice(0, 8);
}

/** "09:02" — the plan's right column. */
export function hhmm(iso: string | null | undefined): string {
  return clock(iso).slice(0, 5);
}

/** "now" / "4m" / "2h" / "3d" — the list's right column, short enough for mono. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The last two path segments, so a log line names the file without the tree above it. */
export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

export function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** One short line from a JSON value, or '' when there is nothing worth showing. */
export function summarize(value: unknown, max = 120): string {
  if (value == null) return '';
  if (typeof value === 'string') return truncate(value, max);
  let text: string;
  try { text = JSON.stringify(value); } catch { return ''; }
  if (!text || text === '{}' || text === '[]' || text === 'null') return '';
  return truncate(text, max);
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** A JSON column as an object, whether localClient parsed it already or left it text. */
function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return parseJson(v);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The brain's `{"error": "…"}` body out of an admin call's thrown message, or the message itself. */
export function brainError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const inner = str(parseJson(message).error);
  return inner ?? (message.trim() || 'Atlas did not answer.');
}

// ---------------------------------------------------------------------------
// Runs (the agent tables).
// ---------------------------------------------------------------------------

/** `runs.status` CHECK list (plus `paused_at`) → the design's state. */
export function runState(status: string, pausedAt?: string | null): RunState {
  switch (status) {
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'stopped';
    // pending, planning, running, verifying: the runner may still be working it.
    default: return pausedAt ? 'paused' : 'running';
  }
}

export type PlanStepStatus = 'todo' | 'now' | 'done' | 'failed' | 'stopped';

export interface RunPlanStep {
  title: string;
  detail: string;
  status: PlanStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string;
}

const PLAN_STATUSES = new Set<PlanStepStatus>(['todo', 'now', 'done', 'failed', 'stopped']);

/**
 * `runs.plan_json` as the runner writes it (services/atlas-brain/src/agentRunner.ts,
 * `RunPlan`): the planned steps, each with its status. Null when the run has
 * no plan — written before the runner existed, or still being planned.
 */
export function readPlan(planJson: unknown): RunPlanStep[] | null {
  const steps = asObject(planJson).steps;
  if (!Array.isArray(steps)) return null;
  const out: RunPlanStep[] = [];
  for (const s of steps) {
    const o = asObject(s);
    const title = str(o.title);
    if (!title) continue;
    const status = typeof o.status === 'string' && PLAN_STATUSES.has(o.status as PlanStepStatus) ? (o.status as PlanStepStatus) : 'todo';
    out.push({
      title,
      detail: str(o.detail) ?? '',
      status,
      startedAt: str(o.started_at),
      finishedAt: str(o.finished_at),
      summary: str(o.summary) ?? '',
    });
  }
  return out.length ? out : null;
}

/**
 * Steps finished of steps planned. A step cut short counts as finished: the
 * runner never returns to it, so leaving it out would hold the count below
 * the total for good.
 */
export function planProgress(plan: readonly RunPlanStep[]): { done: number; total: number } {
  return { done: plan.filter((s) => s.status === 'done' || s.status === 'failed' || s.status === 'stopped').length, total: plan.length };
}

/**
 * The runner's own ceiling on a plan (services/atlas-brain/src/agentRunner.ts
 * `PLAN_MAX_STEPS`, pinned to it by a test): a run plans at most this many
 * steps whatever its agent's `max_steps` says.
 */
export const RUN_PLAN_MAX_STEPS = 12;

/** The steps a run of an agent with this `max_steps` may plan — the runner's arithmetic (agentRunner.ts `plan`, `parsePlan`). */
export function runStepCap(maxSteps: number): number {
  return Math.min(RUN_PLAN_MAX_STEPS, Math.max(1, Math.floor(maxSteps) || 1));
}

/**
 * The hero chip: the cap the runner applies, not the agent's settings. The
 * agent's daily budget is left off — the runner computes no cost, so nothing
 * holds a run to it (the note says so).
 */
export function runLimit(agent: AgentLike | undefined): string | null {
  if (!agent) return null;
  const n = runStepCap(agent.max_steps);
  return `${n} step${n === 1 ? '' : 's'}`;
}

export function runLimitNote(agent: AgentLike | undefined): string | null {
  if (!agent) return null;
  const n = runStepCap(agent.max_steps);
  return [
    `A run of ${agent.name} plans at most ${n} step${n === 1 ? '' : 's'}.`,
    agent.max_steps > RUN_PLAN_MAX_STEPS ? `The agent allows ${agent.max_steps}; Atlas caps every plan at ${RUN_PLAN_MAX_STEPS}.` : null,
    agent.daily_budget_limit ? `Its $${agent.daily_budget_limit}/day budget is not enforced: Atlas does not yet work out what a run costs.` : null,
  ].filter(Boolean).join(' ');
}

/**
 * What leaves the Mac when an agent run works, said on every run's hero. Each
 * step is a model call: the planner gets the goal and the agent's
 * instructions, every step gets those, the plan and what its tools read.
 */
export const RUN_EGRESS_NOTE =
  'A run sends its goal, the agent’s instructions and whatever its tools read — mail, tasks, notes, your portfolio — to the AI provider at each step.';

/**
 * A run's name: the first sentence of its goal, short enough for the list.
 * Runs have no title column, and naming them after their agent (the old
 * reading) gave every run of one agent the same name in the list.
 */
export function runTitle(goal: string): string {
  const text = goal.trim().replace(/\s+/g, ' ');
  if (!text) return 'Untitled run';
  const first = text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text;
  return truncate(first.replace(/[.!?]$/, ''), 60);
}

export function runCard(run: RunLike, agent: AgentLike | undefined, pendingApprovals: number, now: number = Date.now()): RunCard {
  const base = runState(run.status, run.paused_at);
  // A live run with an approval queued against it is waiting on the user, whatever its row says.
  // A paused one stays paused: the user's pause is the stronger fact.
  const state: RunState = base === 'running' && pendingApprovals > 0 ? 'waiting' : base;
  const name = run.agent?.name ?? agent?.name ?? null;
  const limit = runLimit(agent);
  const startedAt = run.started_at ?? run.created_at;
  const title = runTitle(run.goal_text);
  const goal = run.goal_text.trim();
  // When the goal is one short sentence the heading already says it; the
  // paragraph then names who is doing it rather than repeating the heading.
  const paragraph = goal && goal.replace(/[.!?]$/, '') !== title ? goal : name ? `Run by ${name}.` : '';
  const plan = readPlan(run.plan_json);
  const measured = plan ? planProgress(plan) : null;
  const live = isLive(state);
  return {
    id: `run:${run.id}`,
    kind: 'run',
    sourceId: run.id,
    title,
    goal: paragraph,
    limit,
    limitNote: runLimitNote(agent),
    state,
    // The design's "3/6" while it works; a run without a plan has only its age.
    when: state === 'done' ? 'done' : live && measured ? `${measured.done}/${measured.total}` : ago(run.finished_at ?? startedAt, now),
    sub: [STATE_META[state].label, name].filter(Boolean).join(' · '),
    progress: !live ? 1 : measured ? measured.done / measured.total : null,
    measured,
    startedAt,
    canStop: live,
    canPause: live,
    stopNote: null,
  };
}

/** The plan step an approval was raised in: the step whose tool call came back queued with its id. */
function approvalPlanStep(steps: readonly RunStepLike[], approvalId: string): number | null {
  for (const s of steps) {
    if (s.kind !== 'tool_call') continue;
    const out = asObject(s.output_json);
    const result = asObject(out.result);
    const undo = asObject(out.undo);
    if (result.approval_id === approvalId || undo.approval_id === approvalId) {
      const index = asObject(s.input_json).plan_step;
      return typeof index === 'number' ? index : null;
    }
  }
  return null;
}

const STEP_STOPPED_DETAIL = 'Stopped before it finished.';

/**
 * The run's plan as the runner wrote it, every step marked; each question the
 * run is waiting on sits right after the step that asked it. Runs without a
 * plan fall back to the steps they recorded (`planFromSteps`).
 */
export function planFromRun(run: Pick<RunLike, 'id' | 'plan_json'>, steps: readonly RunStepLike[], approvals: readonly ApprovalLike[]): PlanStep[] {
  const plan = readPlan(run.plan_json);
  if (!plan) return planFromSteps(steps, approvals, run.id);
  const waiting = approvals.filter((a) => a.run_id === run.id && a.status === 'pending');
  const byStep = new Map<number, ApprovalLike[]>();
  const lastStarted = plan.reduce((acc, s, i) => (s.status !== 'todo' ? i : acc), 0);
  for (const a of waiting) {
    const at = approvalPlanStep(steps, a.id) ?? lastStarted;
    byStep.set(at, [...(byStep.get(at) ?? []), a]);
  }
  const out: PlanStep[] = [];
  plan.forEach((s, i) => {
    out.push({
      id: `plan:${i}`,
      title: s.title,
      detail: s.status === 'stopped' ? STEP_STOPPED_DETAIL : (s.status === 'done' || s.status === 'failed') && s.summary ? s.summary : s.detail,
      mark: s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : s.status === 'now' ? 'now' : 'todo',
      time: s.status === 'now' ? 'now' : s.finishedAt ? hhmm(s.finishedAt) : '',
      ...(s.status === 'stopped' ? { stopped: true } : {}),
    });
    for (const a of byStep.get(i) ?? []) out.push(approvalStep(a));
  });
  return out;
}

export const STEP_LABEL: Record<string, string> = {
  planning: 'Plan',
  thinking: 'Think',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  response: 'Respond',
  verification: 'Verify',
  error: 'Error',
};

const STEP_KIND: Record<string, LogKind> = {
  planning: 'think',
  thinking: 'think',
  tool_call: 'tool',
  tool_result: 'read',
  response: 'write',
  verification: 'check',
  error: 'error',
};

function approvalStep(a: ApprovalLike): PlanStep {
  return {
    id: `approval:${a.id}`,
    title: a.action_summary,
    detail: [a.risk_level ? `${a.risk_level} risk` : null, a.reason].filter(Boolean).join(' · ') || 'Needs your approval before it runs.',
    mark: 'now',
    time: 'now',
    approvalId: a.id,
  };
}

/**
 * A run without a plan (written before the brain's runner existed): its
 * recorded steps stand in, with any approval still pending against it as the
 * current step.
 */
export function planFromSteps(steps: readonly RunStepLike[], approvals: readonly ApprovalLike[], runId: string): PlanStep[] {
  const out: PlanStep[] = [...steps]
    .sort((a, b) => a.step_index - b.step_index)
    .map((s) => ({
      id: s.id,
      title: STEP_LABEL[s.kind] ?? s.kind,
      detail: summarize(s.output_json) || summarize(s.input_json) || [s.model_used, s.tokens_used ? `${s.tokens_used.toLocaleString()} tokens` : null].filter(Boolean).join(' · '),
      mark: s.finished_at ? (s.kind === 'error' ? 'failed' : 'done') : 'now',
      time: s.finished_at ? hhmm(s.finished_at) : 'now',
    }));
  for (const a of approvals) {
    if (a.run_id === runId && a.status === 'pending') out.push(approvalStep(a));
  }
  return out;
}

/** One step as a log line's kind and text, reading what the brain's runner records in it. */
function stepLine(s: RunStepLike): { kind: LogKind; message: string } {
  const input = asObject(s.input_json);
  const out = asObject(s.output_json);
  const op = str(input.op);
  if (s.kind === 'tool_call' && op === 'undo') {
    return { kind: out.ok === false ? 'error' : 'write', message: ['Undo', str(input.label), str(out.message)].filter(Boolean).join(' · ') };
  }
  if (s.kind === 'tool_call' && op) {
    const queued = asObject(out.result).status === 'awaiting_approval';
    const outcome = !s.finished_at ? 'running' : out.ok === false ? str(out.error) ?? 'failed' : queued ? 'waiting for you' : 'ok';
    return { kind: out.ok === false ? 'error' : 'tool', message: `${op}(${summarize(input.args, 60)}) · ${outcome}` };
  }
  if (s.kind === 'planning' && typeof out.steps === 'number') {
    const n = out.steps;
    return { kind: 'think', message: `Plan · ${n} step${n === 1 ? '' : 's'}${out.source === 'goal' ? ' · the goal as one step' : ''}` };
  }
  if (s.kind === 'response' && str(out.text)) return { kind: 'write', message: truncate(str(out.text)!, 160) };
  if (s.kind === 'error' && str(out.reason)) return { kind: 'error', message: str(out.reason)! };
  const meta = [s.model_used, s.tokens_used ? `${s.tokens_used.toLocaleString()} tokens` : null].filter(Boolean).join(' · ');
  return {
    kind: STEP_KIND[s.kind] ?? 'log',
    message: [STEP_LABEL[s.kind] ?? s.kind, meta || null, s.finished_at ? null : 'in progress'].filter(Boolean).join(' · '),
  };
}

/**
 * Steps and tool calls interleaved, newest first — the design's log for a run.
 *
 * A run the brain's runner worked (`planned`) records every call as a step
 * already, outcome included, so Rust's `tool_calls` rows would only repeat
 * them. The exception is a call queued for the user: it runs (or not) later,
 * through `approval_resolve`, and only its `tool_calls` row records how that
 * went — so those are kept.
 */
export function logFromRun(steps: readonly RunStepLike[], toolCalls: readonly ToolCallLike[], runId: string, planned = false): LogLine[] {
  const lines: Array<{ at: number; line: LogLine }> = [];
  for (const s of steps) {
    lines.push({
      at: new Date(s.started_at).getTime() || 0,
      line: { id: `step:${s.id}`, time: clock(s.started_at), ...stepLine(s) },
    });
  }
  for (const t of toolCalls) {
    if (t.run_id !== runId) continue;
    if (planned && !t.requires_approval) continue;
    const args = summarize(t.args_json, 60);
    lines.push({
      at: new Date(t.created_at).getTime() || 0,
      line: {
        id: `tool:${t.id}`,
        time: clock(t.created_at),
        kind: t.status === 'failed' ? 'error' : 'tool',
        message: `${t.tool_name}(${args}) · ${t.error_message ?? t.status}`,
      },
    });
  }
  return lines.sort((a, b) => b.at - a.at).map((x) => x.line);
}

/** What "Stop and undo" will do, read from the inverses the runner recorded with each call. */
export interface UndoPreview {
  /** Labels of what will be taken back, newest first. */
  undoable: string[];
  /** What the run did that Atlas cannot put back, and why. */
  cannot: Array<{ label: string; reason: string }>;
  /** Questions of this run still waiting; stopping skips them, and nothing in them ran. */
  questions: number;
}

/** The ids of steps an undo already took back. */
function undoneIds(steps: readonly RunStepLike[]): Set<string> {
  const ids = new Set<string>();
  for (const s of steps) {
    const of = asObject(s.input_json).undo_of;
    if (typeof of === 'string') ids.add(of);
  }
  return ids;
}

/** The brain's answer to a stop (agentRunner.ts `StopResult`), as far as the screen reads it. */
export interface StopOutcomeLike {
  stopped: boolean;
  approvalsClosed: number;
  undo?: {
    undone: ReadonlyArray<{ label: string; table?: string; kind?: string }>;
    failed: ReadonlyArray<{ label: string; message: string }>;
    cannot: ReadonlyArray<{ label: string }>;
  } | 'after-step';
}

/** One sentence saying what a stop did, for the hero once it is done. */
export function describeStop(r: StopOutcomeLike): string {
  const head = r.stopped ? 'Stopped.' : 'It had already ended.';
  const skipped = r.approvalsClosed ? ` ${r.approvalsClosed} waiting question${r.approvalsClosed === 1 ? ' was' : 's were'} skipped; nothing in ${r.approvalsClosed === 1 ? 'it' : 'them'} ran.` : '';
  if (!r.undo) return `${head}${skipped} Nothing was undone.`;
  if (r.undo === 'after-step') return `${head}${skipped} The step in progress finishes first; its undo runs right after.`;
  const { undone, failed, cannot } = r.undo;
  const parts = [
    undone.length ? `Undid ${undone.length} step${undone.length === 1 ? '' : 's'}.` : 'Nothing needed undoing.',
    failed.length ? `${failed.length} could not be undone: ${failed.map((f) => `${f.label} (${f.message})`).join('; ')}.` : null,
    cannot.length ? `${cannot.length} can’t be undone.` : null,
  ].filter(Boolean);
  return `${head}${skipped} ${parts.join(' ')}`;
}

/**
 * What a stop the brain did not confirm means. The screen asks the brain to
 * stop first and answers the run's questions only after it has, so a refused
 * stop leaves both as they were. A stop that timed out may still have landed
 * (the webview gives up after 8 s; the brain does not), so that case says
 * only what is known.
 */
export function stopFailure(e: unknown, questions: number): { text: string; unconfirmed: boolean } {
  if ((e as { name?: unknown } | null)?.name === 'AbortError') {
    return {
      text: 'The brain did not answer in time, so the stop is not confirmed. The run’s status here shows whether it stopped; no question was answered from this screen.',
      unconfirmed: true,
    };
  }
  const left = questions ? ` Its ${questions === 1 ? 'question is' : `${questions} questions are`} still waiting.` : '';
  return { text: `The run was not stopped: ${brainError(e)}${left}`, unconfirmed: false };
}

/** One `db:changed` event: the table a screen re-reads, and what kind of write it was. */
export interface TableChange {
  table: string;
  op: 'delete' | 'update';
}

/**
 * What an undo wrote, as the `db:changed` events the other screens re-read
 * on — one per table and kind. The brain's inverses go through bun:sqlite,
 * which emits nothing, so without these a task "Stop and undo" deleted stays
 * in Lists, Calendar and the Home widgets.
 */
export function undoChanges(undone: ReadonlyArray<{ table?: unknown; kind?: unknown }>): TableChange[] {
  const seen = new Map<string, TableChange>();
  for (const u of undone) {
    const table = str(u.table);
    if (!table) continue;
    const op: TableChange['op'] = u.kind === 'delete' ? 'delete' : 'update';
    seen.set(`${table}:${op}`, { table, op });
  }
  return [...seen.values()];
}

/** The same, read from the undo steps the runner recorded (an undo that ran after the step in flight). */
export function undoStepChanges(steps: readonly RunStepLike[]): TableChange[] {
  return undoChanges(steps.flatMap((s) => {
    const input = asObject(s.input_json);
    if (s.kind !== 'tool_call' || input.op !== 'undo' || asObject(s.output_json).ok === false) return [];
    return [{ table: input.table, kind: input.kind }];
  }));
}

/** True once "Stop and undo" has taken anything back in this run. */
export function runUndone(steps: readonly RunStepLike[]): boolean {
  return undoneIds(steps).size > 0;
}

/**
 * The confirmation's two lists, mirroring the runner's own undo
 * (agentRunner.ts `undoRun`): newest first, skipping what is already undone,
 * and leaving out a queued call that never ran (it was not approved, so there
 * is nothing to take back).
 */
export function undoPreview(steps: readonly RunStepLike[], approvals: readonly ApprovalLike[], runId: string): UndoPreview {
  const done = undoneIds(steps);
  const preview: UndoPreview = {
    undoable: [],
    cannot: [],
    questions: approvals.filter((a) => a.run_id === runId && a.status === 'pending').length,
  };
  const calls = [...steps].filter((s) => s.kind === 'tool_call').sort((a, b) => b.step_index - a.step_index);
  for (const s of calls) {
    if (done.has(s.id)) continue;
    const undo = asObject(asObject(s.output_json).undo);
    const label = str(undo.label);
    if (!label) continue;
    if (Object.keys(asObject(undo.action)).length) { preview.undoable.push(label); continue; }
    const approvalId = str(undo.approval_id);
    if (approvalId && approvals.find((a) => a.id === approvalId)?.status !== 'approved') continue;
    preview.cannot.push({ label, reason: str(undo.reason) ?? 'This has no undo.' });
  }
  return preview;
}

// ---------------------------------------------------------------------------
// Sessions (the brain's admin tables).
// ---------------------------------------------------------------------------

export const SESSION_TYPE_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  'ci-pipeline': 'CI pipeline',
  autonomous: 'Self-repair',
};

/** `atlas_agent_sessions.status` CHECK list → the design's state. */
export function sessionState(status: string): RunState {
  switch (status) {
    case 'active': return 'running';
    case 'paused': return 'paused';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'stopped';
    default: return 'running';
  }
}

/** The hero paragraph for a session, from what the ingesters write into `metadata`. */
export function sessionGoal(s: SessionLike, meta: Record<string, unknown>): string {
  switch (s.session_type) {
    case 'claude-code': {
      const bits = [str(meta.project) ? `in ${str(meta.project)}` : null, str(meta.model) ? `on ${str(meta.model)}` : null].filter(Boolean);
      return `A Claude Code session${bits.length ? ` ${bits.join(', ')}` : ''}, read from its transcript as it is written.${str(meta.prUrl) ? ` It opened a pull request.` : ''}`;
    }
    case 'ci-pipeline':
      return `A GitHub Actions run${str(meta.branch) ? ` on ${str(meta.branch)}` : ''}, as the last CI sync saw it.`;
    case 'autonomous': {
      const stage = str(meta.pipeline_stage);
      const err = str(meta.error_message);
      return [err ? `Repairing: ${truncate(err, 140)}` : 'An autonomous repair run.', stage ? `Stage: ${stage.replace(/_/g, ' ')}.` : null].filter(Boolean).join(' ');
    }
    default:
      return 'A session the brain is tracking.';
  }
}

/**
 * What stopping a live session means for each kind (the brain's
 * POST /admin/agent-sessions/:id/stop): CI asks GitHub to cancel, a
 * self-repair is stopped inside the brain, and a Claude Code session cannot
 * be stopped from Atlas at all.
 */
export const SESSION_STOP: Record<string, { canStop: boolean; title: string }> = {
  'ci-pipeline': { canStop: true, title: 'Asks GitHub to cancel this workflow run' },
  autonomous: { canStop: true, title: 'Stops the repair after the stage in progress' },
  'claude-code': { canStop: false, title: 'Atlas only reads this session’s transcript. Stop it in the terminal or app where it runs.' },
};

export function sessionCard(s: SessionLike, now: number = Date.now()): RunCard {
  const state = sessionState(s.status);
  const meta = parseJson(s.metadata);
  const type = SESSION_TYPE_LABEL[s.session_type] ?? s.session_type;
  const live = isLive(state);
  const stop = SESSION_STOP[s.session_type];
  return {
    id: `session:${s.id}`,
    kind: 'session',
    sourceId: s.id,
    title: s.task_summary?.trim() || `${type} session`,
    goal: sessionGoal(s, meta),
    limit: type,
    limitNote: null,
    state,
    when: state === 'done' ? 'done' : ago(s.ended_at ?? s.started_at, now),
    sub: `${STATE_META[state].label} · ${type}`,
    progress: live ? null : 1,
    measured: null,
    startedAt: s.started_at,
    canStop: live && !!stop?.canStop,
    canPause: false,
    stopNote: live && stop && !stop.canStop ? stop.title : null,
  };
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite']);

export function toolKind(tool: string): LogKind {
  if (READ_TOOLS.has(tool)) return 'read';
  if (WRITE_TOOLS.has(tool)) return 'write';
  return 'tool';
}

const STAGE_LABEL: Record<string, string> = {
  audit_start: 'Audit started',
  audit_complete: 'Diagnosis written',
  propose_complete: 'Fix proposed',
  propose_failed: 'Proposal failed',
  test_start: 'Tests started',
  test_complete: 'Tests finished',
  pipeline_complete: 'Pipeline complete',
  stopped: 'Stopped',
};

/** The one-line reading of a milestone event's payload: `{kind}` from the JSONL ingest, `{stage}` from self-repair. */
export function milestoneText(payload: Record<string, unknown>): { title: string; detail: string } {
  const kind = str(payload.kind);
  if (kind === 'pr-link') return { title: 'Pull request opened', detail: str(payload.url) ?? '' };
  if (kind === 'compact') {
    const pre = typeof payload.preTokens === 'number' ? `${payload.preTokens.toLocaleString()} tokens before` : '';
    return { title: 'Context compacted', detail: pre };
  }
  const stage = str(payload.stage);
  if (stage) {
    return {
      title: STAGE_LABEL[stage] ?? stage.replace(/_/g, ' '),
      detail: str(payload.diagnosis) ?? str(payload.reason) ?? str(payload.status) ?? '',
    };
  }
  return { title: 'Milestone', detail: summarize(payload) };
}

/** A session has no plan Atlas can read; its milestones stand in, oldest first. */
export function planFromSession(events: readonly SessionEventLike[]): PlanStep[] {
  return events
    .filter((e) => e.event_type === 'milestone' || e.event_type === 'error')
    .map((e) => {
      const payload = parseJson(e.payload);
      const at = new Date(e.ts).getTime() || 0;
      if (e.event_type === 'error') {
        return { at, step: { id: e.id, title: 'Error', detail: str(payload.reason) ?? str(payload.message) ?? summarize(payload), mark: 'failed' as StepMark, time: hhmm(e.ts) } };
      }
      const { title, detail } = milestoneText(payload);
      return { at, step: { id: e.id, title, detail, mark: 'done' as StepMark, time: hhmm(e.ts) } };
    })
    .sort((a, b) => a.at - b.at)
    .map((x) => x.step);
}

/** Every event as a log line, newest first (the API already orders by ts DESC; sorted again so a merge cannot undo that). */
export function logFromSession(events: readonly SessionEventLike[]): LogLine[] {
  return [...events]
    .map((e) => {
      const payload = parseJson(e.payload);
      const tool = str(payload.tool) ?? '';
      let kind: LogKind;
      let message: string;
      switch (e.event_type) {
        case 'file_edit': {
          const file = str(payload.file);
          kind = 'write';
          message = file ? `${tool || 'Edit'} ${shortPath(file)}` : tool || 'File edit';
          break;
        }
        case 'tool_call':
          kind = toolKind(tool);
          message = tool || 'Tool call';
          break;
        case 'milestone': {
          const m = milestoneText(payload);
          kind = 'check';
          message = m.detail ? `${m.title} · ${truncate(m.detail, 90)}` : m.title;
          break;
        }
        case 'error':
          kind = 'error';
          message = str(payload.reason) ?? str(payload.message) ?? (summarize(payload) || 'Error');
          break;
        case 'question':
        case 'discovery':
          kind = 'think';
          message = str(payload.text) ?? str(payload.message) ?? (summarize(payload) || e.event_type);
          break;
        default:
          kind = 'log';
          message = str(payload.message) ?? (summarize(payload) || 'log');
      }
      return { at: new Date(e.ts).getTime() || 0, line: { id: e.id, time: clock(e.ts), kind, message } };
    })
    .sort((a, b) => b.at - a.at)
    .map((x) => x.line);
}

// ---------------------------------------------------------------------------
// The approval queue (the control port).
// ---------------------------------------------------------------------------

export function approvalsCard(pending: readonly ApprovalLike[], now: number = Date.now()): RunCard {
  const n = pending.length;
  const newest = pending.reduce<string | null>((acc, a) => (acc == null || a.created_at > acc ? a.created_at : acc), null);
  return {
    id: APPROVALS_CARD_ID,
    kind: 'approvals',
    sourceId: null,
    // Not "Waiting for you": that is the status line right above the heading.
    title: 'Approvals',
    goal: n === 0
      ? 'Nothing is waiting. When Atlas queues an action it may not take alone, it appears here with Approve and Skip.'
      : `${n} action${n === 1 ? '' : 's'} Atlas queued need${n === 1 ? 's' : ''} your answer before anything runs. Approving runs it now; skipping throws it away.`,
    limit: null,
    limitNote: null,
    state: n > 0 ? 'waiting' : 'done',
    when: n > 0 ? String(n) : ago(newest, now),
    sub: n > 0 ? `Waiting for you · ${n} to answer` : 'Nothing waiting',
    progress: n > 0 ? null : 1,
    measured: null,
    startedAt: newest,
    canStop: false,
    canPause: false,
    stopNote: null,
  };
}

/** Pending approvals as the queue's plan — one step each, all current. */
export function planFromApprovals(pending: readonly ApprovalLike[]): PlanStep[] {
  return [...pending].sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).map(approvalStep);
}

/** Answered approvals as the queue's log, newest first. */
export function logFromApprovals(answered: readonly ApprovalLike[]): LogLine[] {
  return [...answered]
    .filter((a) => a.status !== 'pending')
    .map((a) => ({ at: new Date(a.approved_at ?? a.created_at).getTime() || 0, a }))
    .sort((x, y) => y.at - x.at)
    .map(({ a }) => ({
      id: `approval:${a.id}`,
      time: clock(a.approved_at ?? a.created_at),
      kind: a.status === 'approved' ? ('check' as LogKind) : ('log' as LogKind),
      message: `${a.action_summary} · ${a.status}`,
    }));
}

// ---------------------------------------------------------------------------
// The list.
// ---------------------------------------------------------------------------

const STATE_ORDER: Record<RunState, number> = { waiting: 0, running: 1, paused: 2, failed: 3, stopped: 4, done: 5 };

/** Waiting first, then working, then the finished ones; newest first inside each group. The queue card, when present, stays on top. */
export function orderCards(cards: readonly RunCard[]): RunCard[] {
  return [...cards].sort((a, b) => {
    if (a.kind === 'approvals') return -1;
    if (b.kind === 'approvals') return 1;
    const d = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (d !== 0) return d;
    return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
  });
}

/** The eyebrow's "N running": working or waiting on the user, as the design counts — a paused run is not running. */
export function countLive(cards: readonly RunCard[]): number {
  return cards.filter((c) => c.kind !== 'approvals' && (c.state === 'running' || c.state === 'waiting')).length;
}

/**
 * The hero's line under a paused run. A pause lands between steps, so a step
 * already in flight finishes first; the plan says which.
 */
export function pauseNote(plan: readonly PlanStep[]): string {
  const steps = plan.filter((p) => !p.approvalId);
  // Paused before the brain picked it up: nothing is planned or run until Resume.
  if (!steps.length) return 'Paused before it started. Resume lets Atlas plan it and begin.';
  const inFlight = steps.find((p) => p.mark === 'now');
  if (inFlight) return `Pausing after “${inFlight.title}”. Nothing new starts until you resume.`;
  // A step cut short is not where Resume picks up; the first one not started is.
  const next = steps.findIndex((p) => p.mark === 'todo' && !p.stopped);
  return next >= 0 ? `Paused before step ${next + 1}. Resume carries on from there.` : 'Paused. Resume carries on from where it stopped.';
}

/** Which card opens first: whatever waits on the user, else the newest live one, else the first. */
export function defaultCardId(cards: readonly RunCard[]): string | null {
  const ordered = orderCards(cards);
  const waiting = ordered.find((c) => c.state === 'waiting');
  if (waiting) return waiting.id;
  return ordered.find((c) => isLive(c.state))?.id ?? ordered[0]?.id ?? null;
}
