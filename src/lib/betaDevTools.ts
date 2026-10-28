/**
 * The Beta dev tools' reading — Tests, Versions and Design Sync on one page
 * (BetaDevTools.tsx, `Atlas Dev Tools Beta.dc.html`). Pure and tested here.
 *
 * The row types below are structural copies of what the brain returns
 * (useTests.ts, useVersions.ts, useDesignSync.ts) rather than imports. The
 * hooks pull in the brain client, which the strict gate (tsconfig.strict.json)
 * cannot check, and this file sits inside that gate; the page passes the
 * hooks' rows straight in and TypeScript checks the shapes still agree.
 */

// ── Tabs ─────────────────────────────────────────────────────────────────────

export type DevTab = 'tests' | 'versions' | 'sync';

/** One page serves three routes; each tab is its route, so a tab is a link that survives a reload. */
export const DEV_TABS: ReadonlyArray<{ key: DevTab; label: string; path: string; heading: string }> = [
  { key: 'tests', label: 'Tests', path: '/tests', heading: 'tests' },
  { key: 'versions', label: 'Versions', path: '/versions', heading: 'versions' },
  { key: 'sync', label: 'Design Sync', path: '/design-sync', heading: 'design ⇄ code' },
];

export function tabFor(pathname: string): DevTab {
  const p = pathname.replace(/\/+$/, '') || '/';
  return DEV_TABS.find((t) => p === t.path || p.startsWith(`${t.path}/`))?.key ?? 'tests';
}

// ── Time and size ────────────────────────────────────────────────────────────

/** "just now", "12 min ago", "3 h ago", "2 d ago"; empty for a missing or unreadable time. */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** A run's duration the way the design prints it: "840 ms", "1.2s", "2m 04s"; "—" when not recorded. */
export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '—');

/** "A", "A and B", "A, B and C", "A, B, C, D and 3 more". */
export function listNames(names: readonly string[], max = 4): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A failed admin call as one readable sentence. The admin client throws the
 * brain's response body as the message, and the brain answers errors as
 * `{"error": "…"}`, so a raw message would show JSON; this takes the
 * sentence out of it. Anything else passes through, trimmed and capped.
 */
export function errorText(e: unknown, max = 300): string {
  const raw = (e instanceof Error ? e.message : String(e)).trim();
  let text = raw;
  if (raw.startsWith('{')) {
    try {
      const body: unknown = JSON.parse(raw);
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') text = (body as { error: string }).error.trim();
    } catch {
      // Not JSON after all; the raw text is the best there is.
    }
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── Tests ────────────────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface SuiteLike {
  id: string;
  name: string;
  description: string | null;
  ci_job: string | null;
  total_runs: number;
  last_status: RunStatus | null;
  last_run_at: string | null;
}

export interface RunLike {
  id: string;
  suite_id: string;
  status: RunStatus;
  duration_ms: number | null;
  output: string | null;
  error_message: string | null;
  run_at: string;
  /** What its bun test step reported (left-out features, rows 81 and 82); null for a job with no test step, a run in flight, or an older brain. */
  report?: ReportLike | null;
}

/** Structural copy of TestReport in services/atlas-brain/src/testReport.ts. */
export interface ReportFileLike {
  path: string;
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  /** The sum of the file's test times; Bun prints no per-file time. */
  ms: number;
  failed: string[];
}

export interface ReportLike {
  totals: { pass: number; fail: number; skip: number; todo: number; errors: number; tests: number; files: number; ms: number | null };
  files: ReportFileLike[];
  coverage: { lines: number | null; funcs: number | null; files: number } | null;
}

/** A job's state: the run statuses, plus `stalled` (a run that never reported back) and `never`. */
export type JobState = RunStatus | 'stalled' | 'never';

/**
 * A suite row is a test file, but running one runs its CI job's whole command
 * (adminRoutes.ts `runTest` → `CI_JOBS[ci_job]`): every file under `frontend`
 * runs `bun run ci:quick`. So the honest unit on this screen is the job — one
 * row per job, its files listed inside, its state the newest run of any of
 * them. Running "a suite" twice would run the same command twice.
 */
export interface JobGroup {
  job: string;
  suites: SuiteLike[];
  state: JobState;
  /** When the newest run of this job started. */
  lastRunAt: string | null;
  /** The suite id a run of this job is filed against: the one run most recently, else the first. */
  runSuiteId: string;
  /** The newest run of this job in the recent-runs list, for its duration and output. */
  latestRun: RunLike | null;
  totalRuns: number;
}

/** `runTest` files a suite with no ci_job under this job; the grouping follows it. */
export const DEFAULT_JOB = 'frontend';

/**
 * What each job runs, for the expanded row. Mirrors CI_JOBS in
 * services/atlas-brain/src/adminRoutes.ts, which is the authority: a job not
 * listed here shows no command rather than a guessed one.
 */
export const JOB_COMMAND: Readonly<Record<string, string>> = {
  frontend: 'bun run ci:quick, then bun test --coverage tests/ ./src ./scripts supabase/functions/_shared',
  'atlas-brain': 'bunx tsc --noEmit, then bun test --coverage · services/atlas-brain',
  'voice-gateway': 'bunx tsc --noEmit · services/voice-gateway',
  all: 'bun run ci',
};

/**
 * A run row is inserted as `running` and updated when the child exits. A
 * brain that quit mid-run leaves it `running` for ever, so past this age the
 * row is read as stalled — and the screen stops polling for it.
 */
export const STALL_MS = 30 * 60_000;

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

export function groupSuites(suites: readonly SuiteLike[], runs: readonly RunLike[], now: number): JobGroup[] {
  const by = new Map<string, SuiteLike[]>();
  for (const s of suites) {
    const job = s.ci_job || DEFAULT_JOB;
    const list = by.get(job);
    if (list) list.push(s);
    else by.set(job, [s]);
  }
  const groups: JobGroup[] = [];
  for (const [job, list] of by) {
    const ordered = [...list].sort((a, b) => a.name.localeCompare(b.name));
    const newest = ordered.reduce<SuiteLike | null>((best, s) => (time(s.last_run_at) > time(best?.last_run_at) ? s : best), null);
    const ran = newest && newest.last_run_at ? newest : null;
    let state: JobState = ran?.last_status ?? 'never';
    if (state === 'running' && ran && now - time(ran.last_run_at) > STALL_MS) state = 'stalled';
    const ids = new Set(ordered.map((s) => s.id));
    const latestRun = runs.reduce<RunLike | null>((best, r) => (ids.has(r.suite_id) && time(r.run_at) > time(best?.run_at) ? r : best), null);
    groups.push({
      job,
      suites: ordered,
      state,
      lastRunAt: ran?.last_run_at ?? null,
      runSuiteId: ran?.id ?? ordered[0].id,
      latestRun,
      totalRuns: ordered.reduce((n, s) => n + (s.total_runs || 0), 0),
    });
  }
  // The default job first (it is the app's own gate), then by name.
  return groups.sort((a, b) => (a.job === DEFAULT_JOB ? -1 : b.job === DEFAULT_JOB ? 1 : a.job.localeCompare(b.job)));
}

export interface TestKpis {
  total: number;
  passing: number;
  failing: number;
  running: number;
  notRun: number;
  lastRunAt: string | null;
}

export function testKpis(groups: readonly JobGroup[]): TestKpis {
  const k: TestKpis = { total: groups.length, passing: 0, failing: 0, running: 0, notRun: 0, lastRunAt: null };
  for (const g of groups) {
    if (g.state === 'passed') k.passing += 1;
    else if (g.state === 'failed' || g.state === 'stalled') k.failing += 1;
    else if (g.state === 'running') k.running += 1;
    else k.notRun += 1;
    if (time(g.lastRunAt) > time(k.lastRunAt)) k.lastRunAt = g.lastRunAt;
  }
  return k;
}

/** The muted line beside a job's name. */
export function jobLine(g: JobGroup, now: number): string {
  const when = ago(g.lastRunAt, now);
  switch (g.state) {
    case 'never': return 'never run';
    case 'running': return `running, started ${when}`;
    case 'stalled': return `no result: started ${when}`;
    case 'pending': return `queued ${when}`;
    default: return `${g.state} ${when}`;
  }
}

/** The files a job covers, as the count column says it. */
export const suiteCount = (g: JobGroup): string => plural(g.suites.length, 'suite');

// ESC [ … letter — terminal colour codes in a captured log. Built from the
// char code so the source carries no control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/**
 * The end of a run's log, for the expanded row: the error first when the
 * spawn itself failed, then the last `lines` lines of output, colour codes
 * stripped. Empty when the run recorded nothing.
 */
export function outputTail(run: RunLike | null, lines = 60): string {
  if (!run) return '';
  const parts: string[] = [];
  if (run.error_message) parts.push(run.error_message.trim());
  const out = (run.output ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').trimEnd();
  if (out) {
    const all = out.split('\n');
    parts.push((all.length > lines ? ['…', ...all.slice(-lines)] : all).join('\n'));
  }
  return parts.join('\n\n');
}

/** Poll fast only while a run is genuinely in flight; a stalled row does not count. */
export const anyRunning = (groups: readonly JobGroup[]): boolean => groups.some((g) => g.state === 'running');

// ── Test reports: counts, durations, coverage (rows 81 and 82) ──────────────

/** "1 test", "1,152 tests". */
export const testsLabel = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'test' : 'tests'}`;

/** A file's time. Most unit-test files run in under a millisecond, which reads as such rather than "0 ms". */
export function fileTime(ms: number): string {
  if (ms > 0 && ms < 1) return '<1 ms';
  return duration(ms);
}

/** The design's count and time columns as one line: "42 tests · 1.2s". */
export const testsAndTime = (tests: number, ms: number): string => `${testsLabel(tests)} · ${fileTime(ms)}`;

/** The job's report, when its newest run produced one. An older report is not borrowed for a newer run. */
export const jobReport = (g: JobGroup): ReportLike | null => g.latestRun?.report ?? null;

/** The count column: the tests the newest run ran, or the files the job covers when it has no report. */
export function jobCount(g: JobGroup): string {
  const r = jobReport(g);
  return r ? testsLabel(r.totals.tests) : suiteCount(g);
}

export interface ReportFileRow {
  path: string;
  tests: number;
  fail: number;
  dot: 'green' | 'red' | 'neutral';
  /** "12 tests · 0.4s", plus what did not pass when anything did not. */
  line: string;
  failed: string[];
}

/** A report's files as rows: failing first, then by path — what needs looking at on top. */
export function reportFiles(r: ReportLike): ReportFileRow[] {
  return [...r.files]
    .sort((a, b) => (b.fail > 0 ? 1 : 0) - (a.fail > 0 ? 1 : 0) || a.path.localeCompare(b.path))
    .map((f) => {
      const tests = f.pass + f.fail + f.skip + f.todo;
      const extra = [f.fail ? `${f.fail} failing` : '', f.skip ? `${f.skip} skipped` : '', f.todo ? `${f.todo} todo` : ''].filter(Boolean).join(', ');
      return {
        path: f.path || 'outside any file',
        tests,
        fail: f.fail,
        dot: f.fail ? 'red' : f.pass ? 'green' : 'neutral',
        line: `${testsAndTime(tests, f.ms)}${extra ? ` · ${extra}` : ''}`,
        failed: f.failed,
      };
    });
}

/** The newest report of each job, added up. Null when no job has one yet. */
export interface TestTotals { pass: number; fail: number; skip: number; todo: number; tests: number; jobs: number }

export function testTotals(groups: readonly JobGroup[]): TestTotals | null {
  const t: TestTotals = { pass: 0, fail: 0, skip: 0, todo: 0, tests: 0, jobs: 0 };
  for (const g of groups) {
    const r = jobReport(g);
    if (!r) continue;
    t.pass += r.totals.pass;
    t.fail += r.totals.fail;
    t.skip += r.totals.skip;
    t.todo += r.totals.todo;
    t.tests += r.totals.tests;
    t.jobs += 1;
  }
  return t.jobs ? t : null;
}

/** "56.08% of lines · 45.67% of functions · 138 source files". */
export function coverageLine(c: NonNullable<ReportLike['coverage']>): string {
  return [
    c.lines != null ? `${c.lines}% of lines` : null,
    c.funcs != null ? `${c.funcs}% of functions` : null,
    plural(c.files, 'source file'),
  ].filter(Boolean).join(' · ');
}

export interface CoverageTile {
  /** "56%" — lines, rounded, as the design's tile prints it. */
  value: string;
  /** What the figure is a share of: lines, or functions when Bun printed no line figure. */
  of: 'lines' | 'functions';
  job: string;
  detail: string;
}

/**
 * The Coverage tile. Each job measures its own tree, and percentages of two
 * trees do not add up, so the tile shows one job's figure and names it: the
 * default job's (the app's own gate) when it has one, else the first that does.
 */
export function coverageTile(groups: readonly JobGroup[]): CoverageTile | null {
  const ordered = [...groups].sort((a, b) => (a.job === DEFAULT_JOB ? -1 : b.job === DEFAULT_JOB ? 1 : 0));
  for (const g of ordered) {
    const c = jobReport(g)?.coverage;
    if (!c) continue;
    const figure = c.lines ?? c.funcs;
    if (figure == null) continue;
    return { value: `${Math.round(figure)}%`, of: c.lines != null ? 'lines' : 'functions', job: g.job, detail: `${g.job}, last run: ${coverageLine(c)}` };
  }
  return null;
}

// ── Versions ─────────────────────────────────────────────────────────────────

export type VersionStatus = 'planned' | 'in-progress' | 'released' | 'archived';

export interface VersionLike {
  id: string;
  semver: string;
  codename: string | null;
  status: VersionStatus;
  target_date: string | null;
  released_at: string | null;
  feature_count: number;
  done_count: number;
}

/** major/minor/patch as numbers; anything without a leading version sorts last (as adminRoutes.ts does). */
export function semverKey(semver: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(semver);
  if (!m) return [-1, -1, -1];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/**
 * Newest first, as the design lists them. The hook orders by the semver
 * string, which puts v0.10 before v0.9; this compares the numbers.
 */
export function sortVersions<T extends { semver: string }>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => {
    const ka = semverKey(a.semver);
    const kb = semverKey(b.semver);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return b.semver.localeCompare(a.semver);
  });
}

export type ChipTone = 'green' | 'blue' | 'muted' | 'warm' | 'red' | 'tint';

/**
 * The design's channel chip (stable / beta / archived). Atlas has no release
 * channels — one updater feed, `releases/latest` — so the chip says the
 * plan's own status in the same three colours: released green, in progress
 * blue, planned and archived quiet.
 */
export function versionChip(status: VersionStatus): { label: string; tone: ChipTone } {
  switch (status) {
    case 'released': return { label: 'released', tone: 'green' };
    case 'in-progress': return { label: 'in progress', tone: 'blue' };
    case 'archived': return { label: 'archived', tone: 'muted' };
    default: return { label: 'planned', tone: 'muted' };
  }
}

export const progressOf = (v: Pick<VersionLike, 'feature_count' | 'done_count'>): number =>
  v.feature_count > 0 ? Math.round((v.done_count / v.feature_count) * 100) : 0;

/** "7/12 features · 58% · target 2026-11-15" — or "released …" once it shipped. */
export function versionSub(v: VersionLike): string {
  const parts = [v.feature_count > 0 ? `${v.done_count}/${v.feature_count} features · ${progressOf(v)}%` : 'No features tracked'];
  if (v.released_at) parts.push(`released ${v.released_at.slice(0, 10)}`);
  else if (v.target_date) parts.push(`target ${v.target_date}`);
  return parts.join(' · ');
}

export type FeatureStatus = 'planned' | 'in-progress' | 'blocked' | 'done';
export const FEATURE_TONE: Readonly<Record<FeatureStatus, ChipTone>> = {
  done: 'green',
  'in-progress': 'blue',
  blocked: 'red',
  planned: 'muted',
};

// ── Plan sync (where docs/VERSION-PLAN.md stands) ────────────────────────────

/** Structural copy of PlanSyncStatus (useVersions.ts ← services/atlas-brain/src/planSync.ts). */
export interface PlanSyncLike {
  checkedAt: string;
  repo: string;
  ref: string;
  github: { ok: boolean; error: string | null; plan: { sha: string; date: string | null; message: string | null } | null };
  local: { path: string | null; headSha: string | null; branch: string | null; planDirty: boolean; containsPlan: boolean | null; behindBy: number | null; error: string | null };
  app: { buildSha: string | null; containsPlan: boolean | null; behindBy: number | null };
  githubOnly: ReadonlyArray<{ id: string }>;
  source: 'github' | 'local' | null;
}

export type LineState = 'ok' | 'behind' | 'unknown';
export interface PlanSyncLine { label: 'GitHub' | 'Local checkout' | 'Mac app'; state: LineState; detail: string }

/**
 * Where the latest roadmap change stands — merged on GitHub, pulled into this
 * Mac's checkout, built into the running app — judged against the last
 * commit that changed the plan, not the branch head. The same reading the
 * Workshop page's sync panel gives, as data.
 */
export function planSyncLines(status: PlanSyncLike, now: number): PlanSyncLine[] {
  const { github, local, app } = status;
  const plan = github.plan;
  const behind = (n: number | null) => (n ? ` · ${plural(n, 'commit')} behind ${status.ref}` : '');

  const githubLine: PlanSyncLine = github.ok && plan
    ? { label: 'GitHub', state: 'ok', detail: `${status.repo}@${status.ref} · plan ${short(plan.sha)}${plan.message ? ` “${plan.message}”` : ''}${plan.date ? ` · ${ago(plan.date, now)}` : ''}` }
    : { label: 'GitHub', state: 'unknown', detail: `${github.error ?? 'Not checked yet.'}${status.source === 'local' ? ' Showing the local checkout’s plan.' : ''}` };

  const localLine: PlanSyncLine = !local.path
    ? { label: 'Local checkout', state: 'unknown', detail: local.error ?? 'No checkout found.' }
    : local.containsPlan === true
      ? { label: 'Local checkout', state: 'ok', detail: `${local.branch ?? 'detached'} ${short(local.headSha)}${behind(local.behindBy)}${local.planDirty ? ' · uncommitted plan edits' : ''}` }
      : local.containsPlan === false
        ? { label: 'Local checkout', state: 'behind', detail: `${local.branch ?? 'detached'} ${short(local.headSha)} doesn’t have plan ${short(plan?.sha)} — pull ${status.ref}${behind(local.behindBy)}` }
        : { label: 'Local checkout', state: 'unknown', detail: `${local.branch ?? 'detached'} ${short(local.headSha)} (GitHub unreachable, can’t compare)` };

  const appLine: PlanSyncLine = !app.buildSha
    ? { label: 'Mac app', state: 'unknown', detail: 'This build didn’t record its commit.' }
    : app.containsPlan === true
      ? { label: 'Mac app', state: 'ok', detail: `Built from ${short(app.buildSha)}${behind(app.behindBy)}` }
      : app.containsPlan === false
        ? { label: 'Mac app', state: 'behind', detail: `Built from ${short(app.buildSha)}, before plan ${short(plan?.sha)} — rebuild to ship it` }
        : { label: 'Mac app', state: 'unknown', detail: `Built from ${short(app.buildSha)} (not on GitHub, or GitHub unreachable)` };

  return [githubLine, localLine, appLine];
}

/** The strip's colour and its one sentence. */
export function planSyncHeadline(status: PlanSyncLike, lines: readonly PlanSyncLine[], now: number): { tone: LineState; line: string } {
  const behind = lines.filter((l) => l.state === 'behind');
  const extra = status.githubOnly.length ? ` ${plural(status.githubOnly.length, 'feature change is', 'feature changes are')} on GitHub only — marked below.` : '';
  if (behind.length) {
    const what = behind.map((l) => (l.label === 'Mac app' ? 'this build' : 'the local checkout')).join(' and ');
    return { tone: 'behind', line: `The plan moved on GitHub; ${what} ${behind.length > 1 ? 'are' : 'is'} behind it.${extra}` };
  }
  if (lines.every((l) => l.state === 'ok')) {
    return { tone: 'ok', line: `The plan is the same on GitHub, in the checkout and in this build. Checked ${ago(status.checkedAt, now) || 'just now'}.${extra}` };
  }
  return {
    tone: 'unknown',
    line: status.github.ok
      ? `Plan read from ${status.repo}@${status.ref}. Not everything could be compared — details below.${extra}`
      : `GitHub couldn’t be reached${status.source === 'local' ? ', so the plan comes from the local checkout' : ''}.${extra}`,
  };
}

// ── Design ⇄ code ────────────────────────────────────────────────────────────

/** Mirrors services/atlas-brain/src/designScreens.ts. */
export type ScreenState = 'in-sync' | 'design-ahead' | 'new' | 'reference';

export interface ScreenLike {
  name: string;
  design: string;
  code: string | null;
  codeKind: 'beta' | 'workshop' | null;
  designChangedAt: string | null;
  codeChangedAt: string | null;
  state: ScreenState;
}

export const SCREEN_STATE: Readonly<Record<ScreenState, { label: string; tone: ChipTone }>> = {
  'in-sync': { label: 'In sync', tone: 'green' },
  'design-ahead': { label: 'Design ahead', tone: 'warm' },
  new: { label: 'New', tone: 'tint' },
  reference: { label: 'Reference', tone: 'muted' },
};

const STATE_ORDER: Readonly<Record<ScreenState, number>> = { 'design-ahead': 0, new: 1, 'in-sync': 2, reference: 3 };

/** What needs looking at first: design ahead, then new, then in sync; by name within each. */
export function sortScreens<T extends Pick<ScreenLike, 'name' | 'state'>>(screens: readonly T[]): T[] {
  return [...screens].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
}

export type SyncTone = 'ok' | 'ahead' | 'new' | 'unknown';

/** The strip above the table: its colour and the one sentence the design gives it. */
export function screenSummary(screens: readonly ScreenLike[]): { tone: SyncTone; line: string; ahead: number; fresh: number; inSync: number } {
  const ahead = screens.filter((s) => s.state === 'design-ahead');
  const fresh = screens.filter((s) => s.state === 'new');
  const inSync = screens.filter((s) => s.state === 'in-sync').length;
  if (screens.length === 0) return { tone: 'unknown', line: 'No design screens found in the current handoff.', ahead: 0, fresh: 0, inSync };
  const parts: string[] = [];
  if (ahead.length) parts.push(`${plural(ahead.length, 'screen')} changed in design since ${ahead.length === 1 ? 'its' : 'their'} code: ${listNames(ahead.map((s) => s.name))}.`);
  if (fresh.length) parts.push(`${plural(fresh.length, 'screen')} ${fresh.length === 1 ? 'is' : 'are'} new and ${fresh.length === 1 ? 'has' : 'have'} no code yet: ${listNames(fresh.map((s) => s.name))}.`);
  if (!parts.length) parts.push(`Design and code match. ${plural(inSync, 'screen')} in sync.`);
  return { tone: ahead.length ? 'ahead' : fresh.length ? 'new' : 'ok', line: parts.join(' '), ahead: ahead.length, fresh: fresh.length, inSync };
}

/** "Atlas Mail Beta.dc.html" from a repo path. */
export const fileName = (path: string): string => path.split('/').pop() ?? path;

// ── Design bundles (design/.sync-manifest.json) ─────────────────────────────

export type BundleStatus = 'received' | 'auditing' | 'implementing' | 'complete' | 'rejected';
export const BUNDLE_STATUS: Readonly<Record<BundleStatus, { label: string; tone: ChipTone }>> = {
  received: { label: 'Received', tone: 'muted' },
  auditing: { label: 'Auditing', tone: 'tint' },
  implementing: { label: 'Implementing', tone: 'blue' },
  complete: { label: 'Complete', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
};

/** "v0.4.0 · synced 2026-10-27 · 25 surfaces". The version id is stored as `v0-4-0`. */
export function bundleMeta(b: { version_id: string | null; synced_at: string; completed_at: string | null }, surfaces: number): string {
  return [
    b.version_id ? b.version_id.replace(/-/g, '.') : null,
    `synced ${b.synced_at.slice(0, 10)}`,
    b.completed_at ? `done ${b.completed_at.slice(0, 10)}` : null,
    surfaces ? plural(surfaces, 'surface') : null,
  ].filter(Boolean).join(' · ');
}
