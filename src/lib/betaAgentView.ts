/**
 * The Beta Agent View's reading of what Atlas is running — pure, tested here,
 * rendered by src/pages/atlas/BetaAgentView.tsx.
 *
 * `Atlas Agent View Beta.dc.html` draws one kind of thing: a run with a goal,
 * a limit, a plan and a live log. The app has three sources that each hold a
 * part of that picture, and none holds all of it:
 *
 *   - `runs` + `run_steps` + `tool_calls` (the agent tables): a goal, the
 *     agent's step and budget limits, the steps taken, a cancel.
 *   - `atlas_agent_sessions` + `atlas_agent_events` (the brain's admin
 *     tables): Claude Code sessions, CI pipelines and self-repair runs, each
 *     with a live event stream but no plan Atlas can read.
 *   - `approvals`: actions the control port queued that wait for the user,
 *     resolved through the Rust `approval_resolve` command.
 *
 * This module maps each onto the design's shapes (a card in the run list, the
 * hero's status, plan steps, log lines) without inventing what a source does
 * not have: a run with no agent shows no limit, a session shows milestones
 * where the design shows a plan, and progress is only drawn once it is known.
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
  /** The hero's chip. Runs: the agent's limits; sessions: the session type; queue: none. */
  limit: string | null;
  state: RunState;
  /** The list's right-hand label (mono). */
  when: string;
  /** The list's second line. */
  sub: string;
  /** 0..1 once the source says how far along it is; null draws no measured bar. */
  progress: number | null;
  startedAt: string | null;
  /** True only for a live agent run — the one thing with a real stop call. */
  canStop: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  mark: StepMark;
  time: string;
  /** Set when the step is a pending approval: its buttons resolve this id. */
  approvalId?: string;
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

// ---------------------------------------------------------------------------
// Runs (the agent tables).
// ---------------------------------------------------------------------------

/** `runs.status` CHECK list → the design's state. */
export function runState(status: string): RunState {
  switch (status) {
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'stopped';
    default: return 'running'; // pending, planning, running, verifying
  }
}

export function runLimit(agent: AgentLike | undefined): string | null {
  if (!agent) return null;
  return `${agent.max_steps} steps · $${agent.daily_budget_limit}/day`;
}

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
  const base = runState(run.status);
  // A live run with an approval queued against it is waiting on the user, whatever its row says.
  const state: RunState = base === 'running' && pendingApprovals > 0 ? 'waiting' : base;
  const name = run.agent?.name ?? agent?.name ?? null;
  const limit = runLimit(agent);
  const startedAt = run.started_at ?? run.created_at;
  const title = runTitle(run.goal_text);
  const goal = run.goal_text.trim();
  // When the goal is one short sentence the heading already says it; the
  // paragraph then names who is doing it rather than repeating the heading.
  const paragraph = goal && goal.replace(/[.!?]$/, '') !== title ? goal : name ? `Run by ${name}.` : '';
  return {
    id: `run:${run.id}`,
    kind: 'run',
    sourceId: run.id,
    title,
    goal: paragraph,
    limit,
    state,
    when: state === 'done' ? 'done' : ago(run.finished_at ?? startedAt, now),
    sub: [STATE_META[state].label, name].filter(Boolean).join(' · '),
    progress: isLive(state) ? null : 1,
    startedAt,
    canStop: isLive(state),
  };
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

/** The run's steps as the plan, with any approval still pending against it as the current step. */
export function planFromRun(steps: readonly RunStepLike[], approvals: readonly ApprovalLike[], runId: string): PlanStep[] {
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

/** Steps and tool calls interleaved, newest first — the design's log for a run. */
export function logFromRun(steps: readonly RunStepLike[], toolCalls: readonly ToolCallLike[], runId: string): LogLine[] {
  const lines: Array<{ at: number; line: LogLine }> = [];
  for (const s of steps) {
    const meta = [s.model_used, s.tokens_used ? `${s.tokens_used.toLocaleString()} tokens` : null].filter(Boolean).join(' · ');
    lines.push({
      at: new Date(s.started_at).getTime() || 0,
      line: {
        id: `step:${s.id}`,
        time: clock(s.started_at),
        kind: STEP_KIND[s.kind] ?? 'log',
        message: [STEP_LABEL[s.kind] ?? s.kind, meta || null, s.finished_at ? null : 'in progress'].filter(Boolean).join(' · '),
      },
    });
  }
  for (const t of toolCalls) {
    if (t.run_id !== runId) continue;
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

export function sessionCard(s: SessionLike, now: number = Date.now()): RunCard {
  const state = sessionState(s.status);
  const meta = parseJson(s.metadata);
  const type = SESSION_TYPE_LABEL[s.session_type] ?? s.session_type;
  return {
    id: `session:${s.id}`,
    kind: 'session',
    sourceId: s.id,
    title: s.task_summary?.trim() || `${type} session`,
    goal: sessionGoal(s, meta),
    limit: type,
    state,
    when: state === 'done' ? 'done' : ago(s.ended_at ?? s.started_at, now),
    sub: `${STATE_META[state].label} · ${type}`,
    progress: isLive(state) ? null : 1,
    startedAt: s.started_at,
    canStop: false,
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
    state: n > 0 ? 'waiting' : 'done',
    when: n > 0 ? String(n) : ago(newest, now),
    sub: n > 0 ? `Waiting for you · ${n} to answer` : 'Nothing waiting',
    progress: n > 0 ? null : 1,
    startedAt: newest,
    canStop: false,
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

export function countLive(cards: readonly RunCard[]): number {
  return cards.filter((c) => c.kind !== 'approvals' && isLive(c.state)).length;
}

/** Which card opens first: whatever waits on the user, else the newest live one, else the first. */
export function defaultCardId(cards: readonly RunCard[]): string | null {
  const ordered = orderCards(cards);
  const waiting = ordered.find((c) => c.state === 'waiting');
  if (waiting) return waiting.id;
  return ordered.find((c) => isLive(c.state))?.id ?? ordered[0]?.id ?? null;
}
