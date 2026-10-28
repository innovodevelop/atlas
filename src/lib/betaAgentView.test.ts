import { describe, expect, test } from 'bun:test';
import {
  APPROVALS_CARD_ID, ago, approvalsCard, brainError, clock, countLive, defaultCardId, describeStop, logFromApprovals, logFromRun,
  logFromSession, milestoneText, orderCards, pauseNote, planFromApprovals, planFromRun, planFromSession, planFromSteps, readPlan, runCard,
  runState, runTitle, runUndone, sessionCard, sessionState, shortPath, summarize, toolKind, truncate, undoPreview,
  type AgentLike, type ApprovalLike, type RunLike, type RunStepLike, type SessionEventLike, type SessionLike, type ToolCallLike,
} from './betaAgentView';

const NOW = Date.parse('2026-10-28T09:10:00Z');

const run = (over: Partial<RunLike> = {}): RunLike => ({
  id: 'r1', status: 'running', goal_text: 'Clear the inbox since 06:00 and hold anything about money.',
  started_at: '2026-10-28T09:02:00Z', finished_at: null, created_at: '2026-10-28T09:01:00Z',
  cost_estimate: 0, tokens_planner: 0, tokens_worker: 0, tokens_reasoner: 0, agent: { name: 'Inbox triage' }, ...over,
});
const agent: AgentLike = { id: 'a1', name: 'Inbox triage', max_steps: 20, daily_budget_limit: 5 };
const step = (over: Partial<RunStepLike> = {}): RunStepLike => ({
  id: 's1', step_index: 0, kind: 'planning', input_json: null, output_json: null, model_used: 'claude-opus-4-8',
  tokens_used: 1204, started_at: '2026-10-28T09:02:10Z', finished_at: '2026-10-28T09:02:40Z', ...over,
});
const approval = (over: Partial<ApprovalLike> = {}): ApprovalLike => ({
  id: 'ap1', run_id: 'r1', status: 'pending', action_summary: 'Archive "Invoice 4411"', reason: 'about money',
  risk_level: 'medium', approved_at: null, created_at: '2026-10-28T09:05:00Z', ...over,
});
const session = (over: Partial<SessionLike> = {}): SessionLike => ({
  id: 'sess-1', session_type: 'claude-code', status: 'active', task_summary: 'Beta Agent View',
  started_at: '2026-10-28T08:40:00Z', ended_at: null, metadata: JSON.stringify({ project: 'helloatlas', model: 'claude-sonnet-5' }), ...over,
});
const ev = (over: Partial<SessionEventLike> = {}): SessionEventLike => ({
  id: 'e1', event_type: 'tool_call', payload: JSON.stringify({ tool: 'Read' }), ts: '2026-10-28T08:41:00Z', ...over,
});

describe('text and time', () => {
  test('clock and ago', () => {
    expect(clock('2026-10-28T09:02:14Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(clock('')).toBe('');
    expect(clock('not a date')).toBe('');
    expect(ago('2026-10-28T09:09:30Z', NOW)).toBe('now');
    expect(ago('2026-10-28T09:02:00Z', NOW)).toBe('8m');
    expect(ago('2026-10-28T06:10:00Z', NOW)).toBe('3h');
    expect(ago('2026-10-25T09:10:00Z', NOW)).toBe('3d');
    expect(ago(null, NOW)).toBe('');
  });
  test('shortPath, truncate, summarize', () => {
    expect(shortPath('/Users/m/helloatlas/src/pages/atlas/BetaAgentView.tsx')).toBe('atlas/BetaAgentView.tsx');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('  ab  ', 4)).toBe('ab');
    expect(summarize({ a: 1 })).toBe('{"a":1}');
    expect(summarize({})).toBe('');
    expect(summarize(null)).toBe('');
    expect(summarize('a long string'.repeat(20), 10)).toHaveLength(10);
  });
});

describe('runs', () => {
  test('status maps onto the design states', () => {
    expect(runState('pending')).toBe('running');
    expect(runState('verifying')).toBe('running');
    expect(runState('completed')).toBe('done');
    expect(runState('failed')).toBe('failed');
    expect(runState('cancelled')).toBe('stopped');
  });
  test('a live run with an approval queued is waiting on the user', () => {
    const c = runCard(run(), agent, 1, NOW);
    expect(c.state).toBe('waiting');
    expect(c.canStop).toBe(true);
    expect(c.limit).toBe('20 steps · $5/day');
    expect(c.title).toBe('Clear the inbox since 06:00 and hold anything about money');
    // A one-sentence goal is the heading already, so the paragraph names the agent instead.
    expect(c.goal).toBe('Run by Inbox triage.');
    expect(c.progress).toBeNull();
    expect(c.when).toBe('8m');
    expect(c.sub).toBe('Waiting for you · Inbox triage');
  });
  test('a run is named by the first sentence of its goal', () => {
    expect(runTitle('Book flights to Lisbon. Stay inside the €2,000 limit.')).toBe('Book flights to Lisbon');
    expect(runTitle('Spend at most $2.50 on the API today')).toBe('Spend at most $2.50 on the API today');
    expect(runTitle('   ')).toBe('Untitled run');
    expect(runTitle('word '.repeat(30))).toHaveLength(60);
    const c = runCard(run({ goal_text: 'Book flights to Lisbon. Stay inside the €2,000 limit.' }), agent, 0, NOW);
    expect(c.title).toBe('Book flights to Lisbon');
    expect(c.goal).toBe('Book flights to Lisbon. Stay inside the €2,000 limit.');
  });
  test('a finished run is done, full, and cannot be stopped', () => {
    const c = runCard(run({ status: 'completed', finished_at: '2026-10-28T09:08:00Z' }), agent, 0, NOW);
    expect(c.state).toBe('done');
    expect(c.when).toBe('done');
    expect(c.progress).toBe(1);
    expect(c.canStop).toBe(false);
  });
  test('without an agent there is no limit and the goal names the card', () => {
    const c = runCard(run({ agent: undefined }), undefined, 0, NOW);
    expect(c.limit).toBeNull();
    expect(c.title.startsWith('Clear the inbox')).toBe(true);
    expect(c.goal).toBe('');
    expect(c.sub).toBe('Working');
  });
  test('without a plan, the steps in order stand in, then the pending approval against this run', () => {
    const plan = planFromSteps(
      [step({ id: 's2', step_index: 1, kind: 'tool_call', finished_at: null, input_json: { tool: 'mail.archive' } }), step()],
      [approval(), approval({ id: 'ap2', run_id: 'other' }), approval({ id: 'ap3', status: 'approved' })],
      'r1',
    );
    expect(plan.map((p) => p.title)).toEqual(['Plan', 'Tool call', 'Archive "Invoice 4411"']);
    expect(plan[0].mark).toBe('done');
    expect(plan[0].detail).toBe('claude-opus-4-8 · 1,204 tokens');
    expect(plan[1].mark).toBe('now');
    expect(plan[1].detail).toBe('{"tool":"mail.archive"}');
    expect(plan[2].approvalId).toBe('ap1');
    expect(plan[2].detail).toBe('medium risk · about money');
  });
  test('the log interleaves steps and this run\'s tool calls, newest first', () => {
    const tc = (over: Partial<ToolCallLike>): ToolCallLike => ({ id: 't1', run_id: 'r1', tool_name: 'web_search', args_json: { q: 'x' }, status: 'completed', error_message: null, created_at: '2026-10-28T09:03:00Z', ...over });
    const log = logFromRun([step()], [tc({}), tc({ id: 't2', run_id: 'r9' }), tc({ id: 't3', status: 'failed', error_message: 'timeout', created_at: '2026-10-28T09:04:00Z' })], 'r1');
    expect(log.map((l) => l.id)).toEqual(['tool:t3', 'tool:t1', 'step:s1']);
    expect(log[0].kind).toBe('error');
    expect(log[0].message).toBe('web_search({"q":"x"}) · timeout');
    expect(log[2].kind).toBe('think');
    expect(log[2].message).toBe('Plan · claude-opus-4-8 · 1,204 tokens');
  });
});

describe('sessions', () => {
  test('status maps onto the design states', () => {
    expect(sessionState('active')).toBe('running');
    expect(sessionState('paused')).toBe('paused');
    expect(sessionState('completed')).toBe('done');
    expect(sessionState('cancelled')).toBe('stopped');
  });
  test('the card reads the ingester\'s metadata', () => {
    const c = sessionCard(session(), NOW);
    expect(c.title).toBe('Beta Agent View');
    expect(c.limit).toBe('Claude Code');
    expect(c.goal).toContain('in helloatlas');
    expect(c.goal).toContain('on claude-sonnet-5');
    expect(c.canStop).toBe(false);
    expect(c.when).toBe('30m');
  });
  test('an untitled session and broken metadata still render', () => {
    const c = sessionCard(session({ task_summary: null, session_type: 'ci-pipeline', metadata: 'not json', status: 'failed' }), NOW);
    expect(c.title).toBe('CI pipeline session');
    expect(c.state).toBe('failed');
    expect(c.goal).toContain('GitHub Actions');
  });
  test('tool names sort into read, write and tool', () => {
    expect(toolKind('Read')).toBe('read');
    expect(toolKind('Grep')).toBe('read');
    expect(toolKind('Edit')).toBe('write');
    expect(toolKind('Bash')).toBe('tool');
  });
  test('milestones become the plan, oldest first; errors are failed steps', () => {
    const plan = planFromSession([
      ev({ id: 'm2', event_type: 'milestone', payload: JSON.stringify({ kind: 'compact', preTokens: 120000 }), ts: '2026-10-28T08:50:00Z' }),
      ev({ id: 'x', event_type: 'error', payload: JSON.stringify({ stage: 'audit', reason: 'AI completion failed' }), ts: '2026-10-28T08:55:00Z' }),
      ev({ id: 'm1', event_type: 'milestone', payload: JSON.stringify({ kind: 'pr-link', url: 'https://github.com/x/y/pull/1' }), ts: '2026-10-28T08:45:00Z' }),
      ev({ id: 'm3', event_type: 'milestone', payload: JSON.stringify({ stage: 'audit_complete', diagnosis: 'Token expired' }), ts: '2026-10-28T08:58:00Z' }),
      ev(),
    ]);
    expect(plan.map((p) => p.title)).toEqual(['Pull request opened', 'Context compacted', 'Error', 'Diagnosis written']);
    expect(plan[0].detail).toBe('https://github.com/x/y/pull/1');
    expect(plan[1].detail).toBe('120,000 tokens before');
    expect(plan[2].mark).toBe('failed');
    expect(plan[2].detail).toBe('AI completion failed');
    expect(plan[3].detail).toBe('Token expired');
    expect(milestoneText({ stage: 'something_new' }).title).toBe('something new');
  });
  test('every event is a log line, newest first', () => {
    const log = logFromSession([
      ev(),
      ev({ id: 'e2', event_type: 'file_edit', payload: JSON.stringify({ tool: 'Edit', file: '/a/b/src/lib/x.ts' }), ts: '2026-10-28T08:43:00Z' }),
      ev({ id: 'e3', payload: JSON.stringify({ tool: 'Bash' }), ts: '2026-10-28T08:42:00Z' }),
      ev({ id: 'e4', event_type: 'milestone', payload: JSON.stringify({ kind: 'pr-link', url: 'u' }), ts: '2026-10-28T08:44:00Z' }),
      ev({ id: 'e5', event_type: 'log', payload: '{}', ts: '2026-10-28T08:39:00Z' }),
    ]);
    expect(log.map((l) => l.id)).toEqual(['e4', 'e2', 'e3', 'e1', 'e5']);
    expect(log[0]).toMatchObject({ kind: 'check', message: 'Pull request opened · u' });
    expect(log[1]).toMatchObject({ kind: 'write', message: 'Edit lib/x.ts' });
    expect(log[2]).toMatchObject({ kind: 'tool', message: 'Bash' });
    expect(log[3]).toMatchObject({ kind: 'read', message: 'Read' });
    expect(log[4]).toMatchObject({ kind: 'log', message: 'log' });
  });
});

describe('the approval queue', () => {
  test('waits while anything is pending, rests otherwise', () => {
    const busy = approvalsCard([approval(), approval({ id: 'ap2' })], NOW);
    expect(busy.id).toBe(APPROVALS_CARD_ID);
    expect(busy.title).toBe('Approvals');
    expect(busy.state).toBe('waiting');
    expect(busy.when).toBe('2');
    expect(busy.goal.startsWith('2 actions Atlas queued need your answer')).toBe(true);
    const quiet = approvalsCard([], NOW);
    expect(quiet.state).toBe('done');
    expect(quiet.sub).toBe('Nothing waiting');
  });
  test('the plan is one current step per pending approval, oldest first', () => {
    const plan = planFromApprovals([approval({ id: 'b', created_at: '2026-10-28T09:06:00Z' }), approval({ id: 'a' })]);
    expect(plan.map((p) => p.approvalId)).toEqual(['a', 'b']);
    expect(plan.every((p) => p.mark === 'now')).toBe(true);
  });
  test('the log is what was answered, never what still waits', () => {
    const log = logFromApprovals([
      approval(),
      approval({ id: 'ok', status: 'approved', approved_at: '2026-10-28T09:07:00Z' }),
      approval({ id: 'no', status: 'rejected', approved_at: '2026-10-28T09:08:00Z' }),
    ]);
    expect(log.map((l) => l.id)).toEqual(['approval:no', 'approval:ok']);
    expect(log[0].kind).toBe('log');
    expect(log[1].kind).toBe('check');
    expect(log[1].message).toBe('Archive "Invoice 4411" · approved');
  });
});

describe('the list', () => {
  test('the queue stays on top; then waiting, working, finished; newest first within a group', () => {
    const cards = orderCards([
      runCard(run({ id: 'old', status: 'completed', started_at: '2026-10-27T09:00:00Z' }), agent, 0, NOW),
      sessionCard(session({ id: 's-new', started_at: '2026-10-28T09:00:00Z' }), NOW),
      sessionCard(session({ id: 's-old', started_at: '2026-10-28T08:00:00Z' }), NOW),
      runCard(run({ id: 'wait' }), agent, 1, NOW),
      approvalsCard([approval()], NOW),
    ]);
    expect(cards.map((c) => c.id)).toEqual(['approvals', 'run:wait', 'session:s-new', 'session:s-old', 'run:old']);
    expect(countLive(cards)).toBe(3);
    expect(defaultCardId(cards)).toBe('approvals');
  });
  test('with nothing waiting the newest live card opens, and an empty list opens nothing', () => {
    const cards = [runCard(run({ id: 'done', status: 'completed' }), agent, 0, NOW), sessionCard(session(), NOW)];
    expect(defaultCardId(cards)).toBe('session:sess-1');
    expect(defaultCardId([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The brain runner's plan, pause, stop and undo (left-out rows 85–88).
// ---------------------------------------------------------------------------

const PLAN = {
  source: 'model',
  written_at: '2026-10-28T09:02:05Z',
  steps: [
    { title: 'Read the trip note', detail: 'Dates and who joins', status: 'done', started_at: '2026-10-28T09:02:06Z', finished_at: '2026-10-28T09:03:00Z', summary: '1–5 Nov is free.' },
    { title: 'Archive the old invoice', detail: '', status: 'now', started_at: '2026-10-28T09:03:01Z' },
    { title: 'Add it to the calendar', detail: 'With reminders', status: 'todo' },
  ],
};

describe('a run with a plan', () => {
  test('the plan is read whether localClient parsed it or left it text, and junk is no plan', () => {
    expect(readPlan(PLAN)?.map((s) => s.status)).toEqual(['done', 'now', 'todo']);
    expect(readPlan(JSON.stringify(PLAN))?.[0]).toMatchObject({ title: 'Read the trip note', summary: '1–5 Nov is free.', finishedAt: '2026-10-28T09:03:00Z' });
    expect(readPlan({ steps: [{ title: 'x', status: 'exploded' }] })?.[0].status).toBe('todo');
    for (const junk of [null, undefined, '', 'not json', {}, { steps: 'no' }, { steps: [{}] }]) expect(readPlan(junk)).toBeNull();
  });
  test('progress is measured as steps finished of steps planned', () => {
    const c = runCard(run({ plan_json: PLAN }), agent, 0, NOW);
    expect(c.measured).toEqual({ done: 1, total: 3 });
    expect(c.progress).toBeCloseTo(1 / 3);
    expect(c.when).toBe('1/3');
    expect(c.canPause).toBe(true);
    expect(c.canStop).toBe(true);
    // Without a plan nothing is measured, and the bar sweeps instead.
    expect(runCard(run(), agent, 0, NOW)).toMatchObject({ measured: null, progress: null, when: '8m' });
  });
  test('paused is its own state, and outranks a waiting question', () => {
    expect(runState('running', '2026-10-28T09:05:00Z')).toBe('paused');
    expect(runState('cancelled', '2026-10-28T09:05:00Z')).toBe('stopped');
    const c = runCard(run({ paused_at: '2026-10-28T09:05:00Z', plan_json: PLAN }), agent, 1, NOW);
    expect(c.state).toBe('paused');
    expect(c.sub).toBe('Paused · Inbox triage');
    expect(c.canPause).toBe(true);
    // The eyebrow counts what is running, as the design does.
    expect(countLive([c, runCard(run({ id: 'r2' }), agent, 0, NOW)])).toBe(1);
  });
  test('the plan column is the planned steps, with a question right after the step that asked it', () => {
    const steps = [
      step({ id: 'tc', step_index: 2, kind: 'tool_call', input_json: { plan_step: 1, op: 'mail.archive', args: { thread_id: 'th' } }, output_json: { ok: true, result: { status: 'awaiting_approval', approval_id: 'ap1' } } }),
    ];
    const plan = planFromRun(run({ plan_json: PLAN }), steps, [approval(), approval({ id: 'other', run_id: 'r9' })]);
    expect(plan.map((p) => p.title)).toEqual(['Read the trip note', 'Archive the old invoice', 'Archive "Invoice 4411"', 'Add it to the calendar']);
    expect(plan.map((p) => p.mark)).toEqual(['done', 'now', 'now', 'todo']);
    expect(plan[0].detail).toBe('1–5 Nov is free.');
    expect(plan[1].time).toBe('now');
    expect(plan[2].approvalId).toBe('ap1');
    expect(plan[3].detail).toBe('With reminders');
    expect(plan[3].time).toBe('');
  });
  test('a question with no recorded step sits after the last step that started', () => {
    const plan = planFromRun(run({ plan_json: PLAN }), [], [approval()]);
    expect(plan.map((p) => p.approvalId ?? p.title)).toEqual(['Read the trip note', 'Archive the old invoice', 'ap1', 'Add it to the calendar']);
  });
  test('a step cut short by a stop says so', () => {
    const stopped = { ...PLAN, steps: [{ ...PLAN.steps[1], status: 'stopped', finished_at: '2026-10-28T09:04:00Z' }] };
    expect(planFromRun(run({ plan_json: stopped }), [], [])[0]).toMatchObject({ mark: 'todo', detail: 'Stopped before it finished.', stopped: true });
  });
  test('a paused run a new brain took over resumes after the step it cut short, and counts that step as finished', () => {
    const adopted = { ...PLAN, steps: [PLAN.steps[0], { ...PLAN.steps[1], status: 'stopped', finished_at: '2026-10-28T09:04:00Z' }, PLAN.steps[2]] };
    const c = runCard(run({ paused_at: '2026-10-28T09:04:00Z', plan_json: adopted }), agent, 0, NOW);
    expect(c.measured).toEqual({ done: 2, total: 3 });
    expect(pauseNote(planFromRun(run({ plan_json: adopted }), [], []))).toBe('Paused before step 3. Resume carries on from there.');
  });
  test('the pause line says whether a step is still finishing', () => {
    const plan = planFromRun(run({ plan_json: PLAN }), [], [approval()]);
    expect(pauseNote(plan)).toBe('Pausing after “Archive the old invoice”. Nothing new starts until you resume.');
    const between = planFromRun(run({ plan_json: { ...PLAN, steps: [PLAN.steps[0], { ...PLAN.steps[2] }] } }), [], [approval()]);
    expect(pauseNote(between)).toBe('Paused before step 2. Resume carries on from there.');
    // Paused before the brain picked it up: there is no plan yet, and none is written until Resume.
    expect(pauseNote([])).toBe('Paused before it started. Resume lets Atlas plan it and begin.');
  });
  test('the log reads what the runner records, and keeps only the queued calls from Rust', () => {
    const steps = [
      step({ id: 'p', kind: 'planning', output_json: { steps: 3, source: 'model' } }),
      step({ id: 'c', step_index: 1, kind: 'tool_call', started_at: '2026-10-28T09:03:00Z', input_json: { plan_step: 0, op: 'tasks.create', args: { title: 'Dentist' } }, output_json: { ok: true, result: {} } }),
      step({ id: 'q', step_index: 2, kind: 'tool_call', started_at: '2026-10-28T09:03:10Z', input_json: { plan_step: 1, op: 'mail.archive', args: {} }, output_json: { ok: true, result: { status: 'awaiting_approval' } } }),
      step({ id: 'x', step_index: 3, kind: 'tool_call', started_at: '2026-10-28T09:03:20Z', input_json: { op: 'tasks.update', args: {} }, output_json: { ok: false, error: 'no such task' } }),
      step({ id: 'r', step_index: 4, kind: 'response', started_at: '2026-10-28T09:03:30Z', output_json: { text: 'Added the dentist task.' } }),
      step({ id: 'u', step_index: 5, kind: 'tool_call', started_at: '2026-10-28T09:03:40Z', input_json: { undo_of: 'c', op: 'undo', label: 'Created the task “Dentist”' }, output_json: { ok: true, message: 'Removed.' } }),
    ];
    const tc = (over: Partial<ToolCallLike>): ToolCallLike => ({ id: 't1', run_id: 'r1', tool_name: 'tasks.create', args_json: {}, status: 'completed', error_message: null, created_at: '2026-10-28T09:03:01Z', ...over });
    const log = logFromRun(steps, [tc({}), tc({ id: 't2', tool_name: 'mail.archive', requires_approval: 1, status: 'completed', created_at: '2026-10-28T09:05:00Z' })], 'r1', true);
    expect(log.map((l) => l.id)).toEqual(['tool:t2', 'step:u', 'step:r', 'step:x', 'step:q', 'step:c', 'step:p']);
    expect(log.map((l) => l.message)).toEqual([
      'mail.archive() · completed',
      'Undo · Created the task “Dentist” · Removed.',
      'Added the dentist task.',
      'tasks.update() · no such task',
      'mail.archive() · waiting for you',
      'tasks.create({"title":"Dentist"}) · ok',
      'Plan · 3 steps',
    ]);
    expect(log.map((l) => l.kind)).toEqual(['tool', 'write', 'write', 'error', 'tool', 'tool', 'think']);
  });
});

describe('stop and undo', () => {
  const call = (id: string, index: number, undo: unknown, input: Record<string, unknown> = { op: 'tasks.create' }) =>
    step({ id, step_index: index, kind: 'tool_call', input_json: input, output_json: { ok: true, undo } });
  test('the confirmation lists what comes back, newest first, and what cannot', () => {
    const steps = [
      call('a', 1, { label: 'Created the task “Dentist”', action: { kind: 'delete', table: 'user_tasks', id: 't1' } }),
      call('b', 2, { label: 'Started playback', action: null, reason: 'Playback cannot be put back the way it was.' }),
      call('c', 3, { label: 'Edited the note “Trip”', action: { kind: 'restore', table: 'user_notes', id: 'n1', values: { title: 'Trip' } } }),
      call('d', 4, { label: 'Archive “Invoice”', action: null, reason: 'Ran outside.', approval_id: 'ap-yes' }),
      call('e', 5, { label: 'Archive “Other”', action: null, reason: 'Ran outside.', approval_id: 'ap1' }),
      step({ id: 'plain', step_index: 6, kind: 'tool_call', input_json: { op: 'tasks.list' }, output_json: { ok: true } }),
    ];
    const p = undoPreview(steps, [approval({ id: 'ap-yes', status: 'approved' }), approval()], 'r1');
    expect(p.undoable).toEqual(['Edited the note “Trip”', 'Created the task “Dentist”']);
    expect(p.cannot).toEqual([
      { label: 'Archive “Invoice”', reason: 'Ran outside.' },
      { label: 'Started playback', reason: 'Playback cannot be put back the way it was.' },
    ]);
    expect(p.questions).toBe(1);
  });
  test('what an undo already took back is not offered twice', () => {
    const steps = [
      call('a', 1, { label: 'Created the task “Dentist”', action: { kind: 'delete', table: 'user_tasks', id: 't1' } }),
      step({ id: 'u', step_index: 2, kind: 'tool_call', input_json: { undo_of: 'a', op: 'undo' }, output_json: { ok: true, message: 'Removed.' } }),
    ];
    expect(undoPreview(steps, [], 'r1').undoable).toEqual([]);
    expect(runUndone(steps)).toBe(true);
    expect(runUndone([steps[0]])).toBe(false);
  });
  test('what the stop did, in one sentence', () => {
    expect(describeStop({ stopped: true, approvalsClosed: 0 })).toBe('Stopped. Nothing was undone.');
    expect(describeStop({ stopped: true, approvalsClosed: 2, undo: 'after-step' }))
      .toBe('Stopped. 2 waiting questions were skipped; nothing in them ran. The step in progress finishes first; its undo runs right after.');
    expect(describeStop({ stopped: false, approvalsClosed: 0, undo: { undone: [{ label: 'a' }, { label: 'b' }], failed: [{ label: 'c', message: 'It no longer exists.' }], cannot: [{ label: 'd' }] } }))
      .toBe('It had already ended. Undid 2 steps. 1 could not be undone: c (It no longer exists.). 1 can’t be undone.');
    expect(describeStop({ stopped: true, approvalsClosed: 1, undo: { undone: [], failed: [], cannot: [] } }))
      .toBe('Stopped. 1 waiting question was skipped; nothing in it ran. Nothing needed undoing.');
  });
  test('the brain\'s error body is read out of a thrown admin call', () => {
    expect(brainError(new Error('{"error":"Only a run that is still going can be paused."}'))).toBe('Only a run that is still going can be paused.');
    expect(brainError(new Error('Atlas brain is not running.'))).toBe('Atlas brain is not running.');
    expect(brainError('')).toBe('Atlas did not answer.');
  });
});

describe('stopping a session', () => {
  test('CI and self-repair have a stop; Claude Code says where to stop it', () => {
    expect(sessionCard(session({ session_type: 'ci-pipeline' }), NOW)).toMatchObject({ canStop: true, stopNote: null, canPause: false });
    expect(sessionCard(session({ session_type: 'autonomous' }), NOW).canStop).toBe(true);
    const cc = sessionCard(session(), NOW);
    expect(cc.canStop).toBe(false);
    expect(cc.stopNote).toContain('Stop it in the terminal or app where it runs');
    // An ended session has nothing to stop and nothing to say about it.
    expect(sessionCard(session({ session_type: 'ci-pipeline', status: 'completed' }), NOW)).toMatchObject({ canStop: false, stopNote: null });
    expect(sessionCard(session({ status: 'completed' }), NOW).stopNote).toBeNull();
  });
});
