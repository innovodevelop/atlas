import { describe, expect, test } from 'bun:test';
import {
  APPROVALS_CARD_ID, ago, approvalsCard, clock, countLive, defaultCardId, logFromApprovals, logFromRun,
  logFromSession, milestoneText, orderCards, planFromApprovals, planFromRun, planFromSession, runCard,
  runState, runTitle, sessionCard, sessionState, shortPath, summarize, toolKind, truncate,
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
  test('the plan is the steps in order, then the pending approval against this run', () => {
    const plan = planFromRun(
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
