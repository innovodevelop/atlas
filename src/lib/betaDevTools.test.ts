import { describe, expect, test } from 'bun:test';
import {
  STALL_MS, ago, anyRunning, bundleMeta, coverageLine, coverageTile, duration, errorText, fileTime, groupSuites, jobCount, jobLine, jobReport,
  listNames, outputTail, planSyncHeadline, planSyncLines, reportFiles, screenSummary, sortScreens, sortVersions, suiteCount, tabFor, testKpis,
  testTotals, testsAndTime, versionChip, versionSub,
  type PlanSyncLike, type ReportLike, type RunLike, type ScreenLike, type SuiteLike,
} from './betaDevTools';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const suite = (over: Partial<SuiteLike> & { id: string }): SuiteLike => ({
  name: over.id, description: null, ci_job: 'frontend', total_runs: 0, last_status: null, last_run_at: null, ...over,
});
const run = (over: Partial<RunLike> & { id: string; suite_id: string }): RunLike => ({
  status: 'passed', duration_ms: 1200, output: null, error_message: null, run_at: minsAgo(5), ...over,
});

describe('tabs', () => {
  test('each route is its tab', () => {
    expect(tabFor('/tests')).toBe('tests');
    expect(tabFor('/versions/')).toBe('versions');
    expect(tabFor('/design-sync')).toBe('sync');
    expect(tabFor('/elsewhere')).toBe('tests');
  });
});

describe('formats', () => {
  test('ago', () => {
    expect(ago(minsAgo(0), NOW)).toBe('just now');
    expect(ago(minsAgo(42), NOW)).toBe('42 min ago');
    expect(ago(minsAgo(180), NOW)).toBe('3 h ago');
    expect(ago(minsAgo(60 * 72), NOW)).toBe('3 d ago');
    expect(ago(null, NOW)).toBe('');
    expect(ago('not a date', NOW)).toBe('');
  });
  test('duration', () => {
    expect(duration(840)).toBe('840 ms');
    expect(duration(1200)).toBe('1.2s');
    expect(duration(64_000)).toBe('1m 04s');
    expect(duration(null)).toBe('—');
  });
  test('errorText takes the sentence out of the brain’s JSON error body', () => {
    expect(errorText(new Error('{"error":"design/.sync-manifest.json unreadable: ENOENT"}'))).toBe('design/.sync-manifest.json unreadable: ENOENT');
    expect(errorText(new Error('{"runId":"r1","status":"failed","error":"Unknown ci_job \\"x\\""}'))).toBe('Unknown ci_job "x"');
    expect(errorText(new Error('{not json'))).toBe('{not json');
    expect(errorText('  Not authenticated ')).toBe('Not authenticated');
    expect(errorText(new Error('x'.repeat(400)))).toHaveLength(300);
  });
  test('listNames', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['Mail'])).toBe('Mail');
    expect(listNames(['Mail', 'Weather'])).toBe('Mail and Weather');
    expect(listNames(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D and 2 more');
  });
});

describe('groupSuites', () => {
  test('one row per CI job; a suite with no job runs under frontend', () => {
    const groups = groupSuites([
      suite({ id: 'b1', name: 'atlas-brain/a.test.ts', ci_job: 'atlas-brain' }),
      suite({ id: 't1', name: 'auth.spec.ts', ci_job: null }),
      suite({ id: 't2', name: 'chat.spec.ts' }),
    ], [], NOW);
    expect(groups.map((g) => g.job)).toEqual(['frontend', 'atlas-brain']);
    expect(groups[0].suites.map((s) => s.id)).toEqual(['t1', 't2']);
    expect(suiteCount(groups[0])).toBe('2 suites');
    expect(groups[0].state).toBe('never');
    expect(groups[0].runSuiteId).toBe('t1');
  });

  test('the newest run of any of its suites is the job state, and the suite a rerun is filed against', () => {
    const [g] = groupSuites([
      suite({ id: 't1', last_status: 'failed', last_run_at: minsAgo(60), total_runs: 2 }),
      suite({ id: 't2', last_status: 'passed', last_run_at: minsAgo(5), total_runs: 1 }),
    ], [run({ id: 'r1', suite_id: 't1', run_at: minsAgo(60), status: 'failed' }), run({ id: 'r2', suite_id: 't2', run_at: minsAgo(5) }), run({ id: 'rx', suite_id: 'other', run_at: minsAgo(1) })], NOW);
    expect(g.state).toBe('passed');
    expect(g.runSuiteId).toBe('t2');
    expect(g.latestRun?.id).toBe('r2');
    expect(g.totalRuns).toBe(3);
    expect(jobLine(g, NOW)).toBe('passed 5 min ago');
  });

  test('a run that never reported back reads as stalled, and stops counting as running', () => {
    const fresh = groupSuites([suite({ id: 't', last_status: 'running', last_run_at: minsAgo(2) })], [], NOW);
    expect(fresh[0].state).toBe('running');
    expect(anyRunning(fresh)).toBe(true);
    const old = groupSuites([suite({ id: 't', last_status: 'running', last_run_at: new Date(NOW - STALL_MS - 60_000).toISOString() })], [], NOW);
    expect(old[0].state).toBe('stalled');
    expect(anyRunning(old)).toBe(false);
    expect(jobLine(old[0], NOW)).toMatch(/^no result: started/);
  });

  test('kpis count jobs', () => {
    const groups = groupSuites([
      suite({ id: 'a', ci_job: 'frontend', last_status: 'passed', last_run_at: minsAgo(10) }),
      suite({ id: 'b', ci_job: 'atlas-brain', last_status: 'failed', last_run_at: minsAgo(3) }),
      suite({ id: 'c', ci_job: 'voice-gateway' }),
    ], [], NOW);
    expect(testKpis(groups)).toEqual({ total: 3, passing: 1, failing: 1, running: 0, notRun: 1, lastRunAt: minsAgo(3) });
  });
});

describe('test reports (rows 81 and 82)', () => {
  // The brain's report for its own suite and the app's, abridged from real runs.
  const brainReport: ReportLike = {
    totals: { pass: 259, fail: 0, skip: 0, todo: 0, errors: 0, tests: 259, files: 23, ms: 3550 },
    files: [{ path: 'src/greeting.test.ts', pass: 10, fail: 0, skip: 0, todo: 0, ms: 352.59, failed: [] }],
    coverage: { lines: 72.2, funcs: 75.6, files: 25 },
  };
  const appReport: ReportLike = {
    totals: { pass: 1145, fail: 2, skip: 7, todo: 0, errors: 0, tests: 1154, files: 73, ms: 16_850 },
    files: [
      { path: 'tests/auth.spec.ts', pass: 5, fail: 0, skip: 8, todo: 0, ms: 0.66, failed: [] },
      { path: 'src/lib/betaHome.test.ts', pass: 30, fail: 0, skip: 0, todo: 0, ms: 0.4, failed: [] },
      { path: 'src/lib/betaDevTools.test.ts', pass: 12, fail: 2, skip: 0, todo: 1, ms: 1240, failed: ['formats > ago', 'tabs > each route is its tab'] },
      { path: 'src/empty.test.ts', pass: 0, fail: 0, skip: 0, todo: 0, ms: 0, failed: [] },
    ],
    coverage: { lines: 56.08, funcs: 45.67, files: 138 },
  };
  const groups = () => groupSuites([
    suite({ id: 'f', ci_job: 'frontend', last_status: 'failed', last_run_at: minsAgo(4) }),
    suite({ id: 'b', ci_job: 'atlas-brain', last_status: 'passed', last_run_at: minsAgo(9) }),
    suite({ id: 'v', ci_job: 'voice-gateway', last_status: 'passed', last_run_at: minsAgo(20) }),
  ], [
    run({ id: 'r1', suite_id: 'f', run_at: minsAgo(4), status: 'failed', report: appReport }),
    run({ id: 'r0', suite_id: 'f', run_at: minsAgo(60), report: { ...appReport, coverage: { lines: 99, funcs: 99, files: 1 } } }),
    run({ id: 'r2', suite_id: 'b', run_at: minsAgo(9), report: brainReport }),
    run({ id: 'r3', suite_id: 'v', run_at: minsAgo(20), report: null }),
  ], NOW);

  test('rows count tests, and fall back to files for a job with no test step', () => {
    const [front, brain, voice] = groups();
    expect([front.job, brain.job, voice.job]).toEqual(['frontend', 'atlas-brain', 'voice-gateway']);
    expect(jobCount(front)).toBe('1,154 tests');
    expect(jobCount(brain)).toBe('259 tests');
    expect(jobCount(voice)).toBe('1 suite');
    expect(jobReport(front)).toBe(appReport);
  });

  test('the files of a run: failing first, each as “N tests · X s”', () => {
    const rows = reportFiles(appReport);
    expect(rows.map((r) => r.path)).toEqual(['src/lib/betaDevTools.test.ts', 'src/empty.test.ts', 'src/lib/betaHome.test.ts', 'tests/auth.spec.ts']);
    expect(rows[0]).toMatchObject({ dot: 'red', tests: 15, line: '15 tests · 1.2s · 2 failing, 1 todo', failed: ['formats > ago', 'tabs > each route is its tab'] });
    expect(rows[1]).toMatchObject({ dot: 'neutral', line: '0 tests · 0 ms' });
    expect(rows[2].line).toBe('30 tests · <1 ms');
    expect(rows[3]).toMatchObject({ dot: 'green', line: '13 tests · <1 ms · 8 skipped' });
    expect(testsAndTime(1, 840)).toBe('1 test · 840 ms');
    expect(fileTime(0)).toBe('0 ms');
  });

  test('totals add up the newest report of each job', () => {
    expect(testTotals(groups())).toEqual({ pass: 1404, fail: 2, skip: 7, todo: 0, tests: 1413, jobs: 2 });
    expect(testTotals(groupSuites([suite({ id: 'x' })], [], NOW))).toBeNull();
  });

  test('coverage: the app’s own job first, its newest run, named', () => {
    expect(coverageTile(groups())).toEqual({ value: '56%', of: 'lines', job: 'frontend', label: 'Coverage', detail: 'frontend, last run: 56.08% of lines · 45.67% of functions · 138 source files' });
    // Only atlas-brain has a report: its figure, and its name where it shows, not only on hover.
    const brainOnly = groups().filter((g) => g.job !== 'frontend');
    expect(coverageTile(brainOnly)).toMatchObject({ value: '72%', job: 'atlas-brain', label: 'Coverage · atlas-brain' });
    // The frontend job is there but its newest run printed no report: the
    // brain's figure is shown, and the heading says so.
    const frontNoReport = groupSuites([
      suite({ id: 'f', ci_job: 'frontend', last_status: 'failed', last_run_at: minsAgo(2) }),
      suite({ id: 'b', ci_job: 'atlas-brain', last_status: 'passed', last_run_at: minsAgo(9) }),
    ], [
      run({ id: 'r1', suite_id: 'f', run_at: minsAgo(2), status: 'failed', report: null }),
      run({ id: 'r2', suite_id: 'b', run_at: minsAgo(9), report: brainReport }),
    ], NOW);
    expect(coverageTile(frontNoReport)).toMatchObject({ value: '72%', job: 'atlas-brain', label: 'Coverage · atlas-brain' });
    expect(coverageTile(groupSuites([suite({ id: 'x' })], [], NOW))).toBeNull();
    expect(coverageLine({ lines: null, funcs: 50, files: 1 })).toBe('50% of functions · 1 source file');
  });
});

describe('outputTail', () => {
  test('error first, colour codes stripped, only the end kept', () => {
    const esc = String.fromCharCode(27);
    const output = Array.from({ length: 80 }, (_, i) => `${esc}[31mline ${i}${esc}[0m`).join('\n');
    const tail = outputTail(run({ id: 'r', suite_id: 's', output, error_message: 'exit 1' }), 3);
    expect(tail).toBe('exit 1\n\n…\nline 77\nline 78\nline 79');
    expect(outputTail(null)).toBe('');
    expect(outputTail(run({ id: 'r', suite_id: 's' }))).toBe('');
  });
});

describe('versions', () => {
  test('newest first by number, not by string', () => {
    const sorted = sortVersions([{ semver: 'v0.9.0' }, { semver: 'v0.10.0' }, { semver: 'v0.2' }, { semver: 'next' }]);
    expect(sorted.map((v) => v.semver)).toEqual(['v0.10.0', 'v0.9.0', 'v0.2', 'next']);
  });
  test('chip and sub line', () => {
    expect(versionChip('released')).toEqual({ label: 'released', tone: 'green' });
    expect(versionChip('in-progress').tone).toBe('blue');
    const v = { id: 'v', semver: 'v0.4.0', codename: 'Beta', status: 'in-progress' as const, target_date: '2026-11-15', released_at: null, feature_count: 12, done_count: 7 };
    expect(versionSub(v)).toBe('7/12 features · 58% · target 2026-11-15');
    expect(versionSub({ ...v, feature_count: 0, done_count: 0, released_at: '2026-08-04T10:00:00Z' })).toBe('No features tracked · released 2026-08-04');
  });
});

describe('plan sync', () => {
  const base: PlanSyncLike = {
    checkedAt: minsAgo(1),
    repo: 'innovodevelop/atlas',
    ref: 'atlas-redesign',
    github: { ok: true, error: null, plan: { sha: 'abcdef1234', date: minsAgo(30), message: 'Plan: v0.4' } },
    local: { path: '/repo', headSha: '1234567890', branch: 'atlas-redesign', planDirty: false, containsPlan: true, behindBy: 0, error: null },
    app: { buildSha: 'fedcba9876', containsPlan: true, behindBy: 2 },
    githubOnly: [],
    source: 'github',
  };
  test('all caught up', () => {
    const lines = planSyncLines(base, NOW);
    expect(lines.map((l) => l.state)).toEqual(['ok', 'ok', 'ok']);
    expect(lines[2].detail).toBe('Built from fedcba9 · 2 commits behind atlas-redesign');
    expect(planSyncHeadline(base, lines, NOW).tone).toBe('ok');
  });
  test('a build from before the plan is behind, and says rebuild', () => {
    const status = { ...base, app: { buildSha: 'fedcba9876', containsPlan: false, behindBy: 4 }, githubOnly: [{ id: 'f1' }] };
    const lines = planSyncLines(status, NOW);
    expect(lines[2].state).toBe('behind');
    expect(lines[2].detail).toMatch(/rebuild to ship it/);
    const head = planSyncHeadline(status, lines, NOW);
    expect(head.tone).toBe('behind');
    expect(head.line).toBe('The plan moved on GitHub; this build is behind it. 1 feature change is on GitHub only — marked below.');
  });
  test('GitHub unreachable reads as unknown, never as fine', () => {
    const status: PlanSyncLike = { ...base, github: { ok: false, error: 'gh: not logged in.', plan: null }, local: { ...base.local, containsPlan: null }, app: { ...base.app, containsPlan: null }, source: 'local' };
    const lines = planSyncLines(status, NOW);
    expect(lines.map((l) => l.state)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(lines[0].detail).toBe('gh: not logged in. Showing the local checkout’s plan.');
    expect(planSyncHeadline(status, lines, NOW)).toEqual({ tone: 'unknown', line: 'GitHub couldn’t be reached, so the plan comes from the local checkout.' });
  });
});

describe('design ⇄ code', () => {
  const screen = (name: string, state: ScreenLike['state']): ScreenLike => ({ name, design: `design/x/Atlas ${name} Beta.dc.html`, code: null, codeKind: null, designChangedAt: null, codeChangedAt: null, state });
  test('the strip names what moved and what is new', () => {
    const s = screenSummary([screen('Mail', 'in-sync'), screen('Smart Home', 'design-ahead'), screen('Music', 'new'), screen('Clock', 'new')]);
    expect(s.tone).toBe('ahead');
    expect(s.line).toBe('1 screen changed in design since its code: Smart Home. 2 screens are new and have no code yet: Music and Clock.');
  });
  test('all in sync', () => {
    expect(screenSummary([screen('Mail', 'in-sync'), screen('Guidelines', 'reference')])).toMatchObject({ tone: 'ok', line: 'Design and code match. 1 screen in sync.' });
    expect(screenSummary([]).tone).toBe('unknown');
  });
  test('what needs looking at sorts first', () => {
    expect(sortScreens([screen('B', 'in-sync'), screen('A', 'new'), screen('C', 'design-ahead'), screen('D', 'reference')]).map((s) => s.name)).toEqual(['C', 'A', 'B', 'D']);
  });
  test('bundle meta', () => {
    expect(bundleMeta({ version_id: 'v0-4-0', synced_at: '2026-10-27T18:30:00.000Z', completed_at: null }, 25)).toBe('v0.4.0 · synced 2026-10-27 · 25 surfaces');
  });
});
