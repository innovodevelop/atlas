/**
 * The Beta dev tools — `/tests`, `/versions` and `/design-sync` while the
 * beta_ui flag is on (Beta redesign phase 6, `Atlas Dev Tools Beta.dc.html`).
 *
 * One page, three tabs, each tab its own route so a reload or a deep link
 * lands where it was. The data is the Workshop pages' own:
 *
 *   - Tests: the suites the brain discovered (atlas_test_suites) and their
 *     runs. A suite is a file, but running one runs its CI job's command, so
 *     the rows are the jobs (betaDevTools.ts `groupSuites`); Run and Run all
 *     start real runs through the brain's allowlist, and the sphere works
 *     while they do. A job's bun test step is read into a report (left-out
 *     features, rows 81 and 82): the tiles count tests and show coverage, a
 *     row says how many tests it ran, and an open row lists every test file
 *     with "N tests · X s", failing files first.
 *   - Versions: docs/VERSION-PLAN.md as the brain mirrored it into SQLite,
 *     with where the plan stands on GitHub, in the checkout and in this build;
 *     Open shows a version's features and changelog.
 *   - Design Sync: the design ⇄ code table the brain reads from the checkout
 *     and git (designScreens.ts), and the bundles of design/.sync-manifest.json.
 *
 * What the design shows that Atlas has no source for — release channels to
 * promote between, tester counts — is left out rather than drawn; see the
 * notes beside each section. The screen has no header sphere in the design,
 * so the shell's corner orb stays the talk entry point.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useDiscoverTests, useRecentTestRuns, useRunTest, useTestSuites } from '@/hooks/useTests';
import { BUILD_COMMIT, CHANGELOG_PAGE, usePlanSyncStatus, useSyncVersionPlan, useVersionDetail, useVersions, type VersionRow } from '@/hooks/useVersions';
import { parseSurfaces, useDesignScreens, useDesignSyncs, useSyncDesignManifest } from '@/hooks/useDesignSync';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { getAtlasState, publishAtlasState } from '@/lib/atlasStateBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import {
  BUNDLE_STATUS, DEV_TABS, FEATURE_TONE, JOB_COMMAND, SCREEN_STATE, ago, anyRunning, bundleMeta, coverageLine, coverageTile, duration, errorText,
  fileName, groupSuites, jobCount, jobLine, jobReport, outputTail, planSyncHeadline, planSyncLines, reportFiles, screenSummary, short, sortScreens,
  sortVersions, tabFor, testKpis, testTotals, testsLabel, versionChip, versionSub,
  type BundleStatus, type ChipTone, type JobGroup, type JobState, type LineState, type SyncTone,
} from '@/lib/betaDevTools';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/devtools.css';

/** Who this page is on the state bus. */
const BUS_SOURCE = 'devtools';
/** How often the suites are re-read while a run is in flight (the brain emits no event when one ends). */
const RUN_POLL_MS = 3_000;
/** How long the sphere shows the outcome of a run before it rests. */
const SETTLE_MS = 2_400;

/** Relative times re-read every half minute; nothing on this page needs finer. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

function Chip({ tone, children, title }: { tone: ChipTone; children: ReactNode; title?: string }) {
  return <span className={`b-dt-chip b-dt-chip--${tone}`} title={title}>{children}</span>;
}

/** The design's status strip: a dot, one sentence, the one action, and an optional detail below. */
function Strip({ tone, line, action, children }: { tone: LineState | SyncTone; line: ReactNode; action: ReactNode; children?: ReactNode }) {
  return (
    <div className={`b-dt-strip b-dt-strip--${tone}`} role="status">
      <span className="b-dt-strip-dot" aria-hidden />
      <div className="b-dt-strip-text">
        <span className="b-dt-strip-line">{line}</span>
        {children}
      </div>
      {action}
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="b-dt-empty">
      <b>{title}</b>
      {body ? <span>{body}</span> : null}
      {action}
    </div>
  );
}

interface ViewProps {
  open: string | null;
  onOpen: (id: string | null) => void;
  now: number;
}

// ── Tests ────────────────────────────────────────────────────────────────────

const DOT: Record<JobState, string> = {
  passed: 'green', failed: 'red', stalled: 'red', running: 'blue', pending: 'neutral', skipped: 'neutral', never: 'quiet',
};

function TestsView({ open, onOpen, now }: ViewProps) {
  const { suites, isLoading, error, refetch } = useTestSuites();
  const recent = useRecentTestRuns();
  const { mutateAsync: startRun } = useRunTest();
  const discover = useDiscoverTests();
  const plan = usePlanSyncStatus();
  const [starting, setStarting] = useState<ReadonlySet<string>>(() => new Set());
  const [runError, setRunError] = useState<string | null>(null);

  const groups = useMemo(() => groupSuites(suites, recent.runs, now), [suites, recent.runs, now]);
  const kpis = testKpis(groups);
  const totals = testTotals(groups);
  const coverage = coverageTile(groups);
  const running = anyRunning(groups);
  const busy = useCallback((g: JobGroup) => g.state === 'running' || starting.has(g.job), [starting]);
  const busyAny = running || starting.size > 0;

  // The brain records a run's end in SQLite and tells no one, so while one is
  // in flight the suites are re-read every few seconds — and only then.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => { void refetch(); }, RUN_POLL_MS);
    return () => window.clearInterval(t);
  }, [running, refetch]);

  // The sphere works while a run does, then shows how it went: success when
  // every job passed, alert when one failed, and rests.
  const wasRunning = useRef(false);
  const settle = useRef<number | null>(null);
  const refetchRuns = recent.refetch;
  const failing = kpis.failing;
  useEffect(() => {
    if (running) {
      if (settle.current) window.clearTimeout(settle.current);
      wasRunning.current = true;
      publishAtlasState('working', BUS_SOURCE);
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    // The finished run's duration and log are in the runs list, not the suites.
    void refetchRuns();
    publishAtlasState(failing > 0 ? 'alert' : 'success', BUS_SOURCE);
    settle.current = window.setTimeout(() => publishAtlasState('idle', BUS_SOURCE), SETTLE_MS);
  }, [running, failing, refetchRuns]);
  useEffect(() => () => {
    if (settle.current) window.clearTimeout(settle.current);
    const s = getAtlasState();
    if (s.source === BUS_SOURCE && s.state !== 'idle') publishAtlasState('idle', BUS_SOURCE);
  }, []);

  const runJob = useCallback(async (g: JobGroup) => {
    setRunError(null);
    setStarting((s) => new Set(s).add(g.job));
    try {
      await startRun(g.runSuiteId);
    } catch (e) {
      setRunError(`${g.job}: ${errorText(e)}`);
    } finally {
      await refetch();
      setStarting((s) => { const next = new Set(s); next.delete(g.job); return next; });
    }
  }, [startRun, refetch]);

  // Each job once: running every suite would run the same command once per file.
  const runAll = useCallback(() => { void Promise.all(groups.filter((g) => !busy(g)).map(runJob)); }, [groups, busy, runJob]);

  const local = plan.data?.local;
  const where = local?.headSha ? `${local.branch ?? 'detached'} · ${short(local.headSha)}` : BUILD_COMMIT ? `build · ${short(BUILD_COMMIT)}` : null;
  const lastRun = kpis.lastRunAt ? ago(kpis.lastRunAt, now) : 'never';

  return (
    <>
      {/* Passing and Failing count tests once a job has reported them, as the
          design does; until then, jobs. A job can fail on lint or types with
          no test failing, so Failing also says how many jobs failed. */}
      <div className="b-dt-kpis">
        <div className="b-dt-kpi b-dt-kpi--ink" title={totals ? `Tests passing in the newest run of ${totals.jobs === 1 ? 'the one job' : `each of the ${totals.jobs} jobs`} that ran bun test` : 'Jobs whose newest run passed'}>
          <span>Passing</span>
          <b>{busyAny ? '…' : totals ? totals.pass.toLocaleString('en-US') : kpis.passing}{!busyAny && (totals ? totals.tests : kpis.total) ? <small>/ {totals ? totals.tests.toLocaleString('en-US') : kpis.total}</small> : null}</b>
        </div>
        <div className={`b-dt-kpi${(kpis.failing || totals?.fail) && !busyAny ? ' b-dt-kpi--bad' : ''}`} title={totals ? 'Tests failing in the newest run of each job; a job can also fail on lint or types' : 'Jobs whose newest run failed'}>
          <span>Failing</span>
          <b>{busyAny ? '…' : totals ? totals.fail.toLocaleString('en-US') : kpis.failing}{!busyAny && totals && kpis.failing ? <small>· {kpis.failing} {kpis.failing === 1 ? 'job' : 'jobs'} failed</small> : null}</b>
        </div>
        <div className="b-dt-kpi" title={coverage?.detail ?? 'Measured by bun test --coverage when the frontend or atlas-brain job runs'}>
          <span>Coverage</span>
          <b>{coverage ? coverage.value : '—'}{coverage ? <small>{coverage.of}</small> : null}</b>
        </div>
        <div className="b-dt-kpi"><span>Last run</span><b className="b-dt-kpi-time">{busyAny ? 'now' : lastRun}</b></div>
      </div>

      <div className="b-dt-actions">
        <button type="button" className="b-dt-primary" disabled={!groups.length || busyAny} onClick={runAll}>{busyAny ? 'Running…' : 'Run all tests'}</button>
        {where ? <span className="b-dt-ref b-num" title="The checkout the brain runs tests in">{where}</span> : null}
        <button type="button" className="b-btn b-btn--ghost b-dt-discover" disabled={discover.isPending} onClick={() => discover.mutate()}>
          <AtlasIcon name="search" size={15} weight={1.7} />{discover.isPending ? 'Discovering…' : 'Discover'}
        </button>
        {discover.data ? <span className="b-dt-note">{discover.data.discovered} suite files found.</span> : null}
      </div>
      {runError ? <p className="b-dt-err" role="alert">{runError}</p> : null}
      {discover.error ? <p className="b-dt-err" role="alert">Discover failed: {errorText(discover.error)}</p> : null}

      <section className="b-dt-list" aria-label="Test jobs">
        {error ? (
          <Empty title="Couldn’t read the test suites" body={errorText(error)} action={<button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void refetch()}>Try again</button>} />
        ) : isLoading ? (
          <Empty title="Reading test suites…" />
        ) : !groups.length ? (
          <Empty
            title="No test suites tracked"
            body="Discover lists tests/*.spec.ts and services/*/src/*.test.ts and files each under the CI job that runs it."
            action={<button type="button" className="b-btn b-btn--primary b-btn--row" disabled={discover.isPending} onClick={() => discover.mutate()}>Discover now</button>}
          />
        ) : groups.map((g) => {
          const isOpen = open === g.job;
          const isBusy = busy(g);
          const tail = isOpen ? outputTail(g.latestRun) : '';
          const report = jobReport(g);
          const files = isOpen && report ? reportFiles(report) : [];
          return (
            <div key={g.job} className={`b-dt-job${isOpen ? ' open' : ''}`}>
              <div className="b-dt-job-row">
                <span className={`b-dt-dot b-dt-dot--${isBusy ? 'blue' : DOT[g.state]}${isBusy ? ' pulse' : ''}`} aria-hidden />
                <button type="button" className="b-dt-job-name" aria-expanded={isOpen} onClick={() => onOpen(isOpen ? null : g.job)}>
                  <span className="b-num">{g.job}</span>
                  <span className="b-dt-job-desc">{isBusy && g.state !== 'running' ? 'starting…' : jobLine(g, now)}</span>
                </button>
                <span className="b-dt-job-count b-num" title={report ? `${report.totals.files} test files` : 'Suite files this job covers'}>{jobCount(g)}</span>
                <span className="b-dt-job-time b-num">{isBusy ? '…' : duration(g.latestRun?.duration_ms)}</span>
                <button type="button" className="b-btn b-btn--card b-btn--row" disabled={isBusy} onClick={() => void runJob(g)}>{isBusy ? 'Running…' : 'Run'}</button>
              </div>
              {isOpen ? (
                <div className="b-dt-more">
                  <div className="b-dt-more-head">
                    <span className="b-eyebrow">Runs</span>
                    <code className="b-num">{JOB_COMMAND[g.job] ?? 'not a job this screen knows'}</code>
                  </div>
                  {report ? (
                    <>
                      <p className="b-dt-note">
                        {testsLabel(report.totals.tests)} in {report.totals.files} {report.totals.files === 1 ? 'file' : 'files'}
                        {report.totals.ms != null ? ` · ${duration(report.totals.ms)} in bun test` : ''}
                        {report.totals.errors ? ` · ${report.totals.errors} ${report.totals.errors === 1 ? 'error' : 'errors'} outside any test` : ''}
                        {report.coverage ? ` · coverage ${coverageLine(report.coverage)}` : ''}
                      </p>
                      <div className="b-dt-tfs" role="list" aria-label={`Test files in ${g.job}`}>
                        {files.map((f) => (
                          <div key={f.path} className="b-dt-tf" role="listitem">
                            <span className={`b-dt-dot b-dt-dot--${f.dot}`} aria-hidden />
                            <span className="b-dt-tf-path b-num" title={f.path}>{f.path}</span>
                            <span className="b-dt-tf-line b-num">{f.line}</span>
                            {f.failed.length ? <span className="b-dt-tf-failed">{f.failed.join(' · ')}</span> : null}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="b-dt-files">
                      {g.suites.map((s) => <span key={s.id} className="b-dt-file b-num" title={s.description ?? undefined}>{s.name}</span>)}
                    </div>
                  )}
                  {tail ? <pre className="b-dt-log">{tail}</pre> : (
                    <p className="b-dt-note">{g.latestRun ? 'The last run recorded no output.' : g.lastRunAt ? 'Its last run is older than the 50 newest; run it again to see the log.' : 'Not run yet.'}</p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
      <p className="b-dt-foot">One row per CI job: a suite file runs its job’s whole command, so the job is what passes or fails. The frontend and atlas-brain jobs run bun test with coverage; test counts, file times and the coverage figure are read from that run’s own output. A file’s time is the sum of its tests’ times, because Bun prints none per file.</p>
    </>
  );
}

// ── Versions ─────────────────────────────────────────────────────────────────

const LINE_WORD: Record<LineState, string> = { ok: 'Up to date', behind: 'Behind', unknown: 'Unknown' };

function VersionDetail({ version, githubOnly }: { version: VersionRow; githubOnly: ReadonlyMap<string, { local: string | null }> }) {
  const { features, changelog, isLoading } = useVersionDetail(version.id);
  return (
    <div className="b-dt-more">
      {isLoading ? <p className="b-dt-note">Reading features…</p> : !features.length ? <p className="b-dt-note">This version has no tracked features yet.</p> : (
        <div className="b-dt-rows">
          {features.map((f) => {
            const gh = githubOnly.get(f.id);
            const meta = [f.assigned_agent ? `Agent: ${f.assigned_agent}` : null, gh ? (gh.local ? `The local checkout still says ${gh.local}` : 'Not in the local checkout yet') : null].filter(Boolean).join(' · ');
            return (
              <div key={f.id} className="b-dt-feat">
                <span className={`b-dt-dot b-dt-dot--${FEATURE_TONE[f.status] ?? 'muted'}`} aria-hidden />
                <span className="b-dt-feat-text"><b>{f.title}</b>{meta ? <span>{meta}</span> : null}</span>
                {gh ? <Chip tone="warm" title="Changed on GitHub; this Mac’s checkout hasn’t pulled it">GitHub only</Chip> : null}
                <Chip tone={FEATURE_TONE[f.status] ?? 'muted'}>{f.status}</Chip>
              </div>
            );
          })}
        </div>
      )}
      {changelog.length ? (
        <>
          <span className="b-eyebrow b-dt-more-h">{changelog.length >= CHANGELOG_PAGE ? `Changelog · latest ${CHANGELOG_PAGE}` : 'Changelog'}</span>
          <div className="b-dt-rows">
            {changelog.map((c) => (
              <div key={c.id} className="b-dt-cl">
                <Chip tone="muted">{c.category}</Chip>
                <span className="b-dt-cl-t" title={c.description ?? undefined}>{c.title}</span>
                <span className="b-dt-cl-d b-num">{c.related_feature ? `${c.related_feature} · ` : ''}{c.created_at.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function VersionsView({ open, onOpen, now }: ViewProps) {
  const { versions, isLoading, error, refetch } = useVersions();
  const syncPlan = useSyncVersionPlan();
  const status = usePlanSyncStatus();
  const sorted = useMemo(() => sortVersions(versions), [versions]);
  const githubOnly = useMemo(() => new Map((status.data?.githubOnly ?? []).map((f) => [f.id, f])), [status.data]);
  const lines = status.data ? planSyncLines(status.data, now) : null;
  const head = status.data && lines ? planSyncHeadline(status.data, lines, now) : null;
  const sync = () => syncPlan.mutate(undefined, { onSuccess: () => { void refetch(); } });
  const syncButton = (
    <button type="button" className="b-dt-strip-btn" disabled={syncPlan.isPending} onClick={sync}>
      {syncPlan.isPending ? 'Syncing…' : syncPlan.isSuccess ? 'Sync again' : 'Sync now'}
    </button>
  );

  return (
    <>
      <Strip
        tone={head?.tone ?? 'unknown'}
        line={head?.line ?? (status.error ? `Where the plan stands is unknown: ${errorText(status.error)}` : 'Checking GitHub…')}
        action={syncButton}
      >
        {lines ? (
          <ul className="b-dt-strip-lines">
            {lines.map((l) => <li key={l.label} className={`is-${l.state}`}><b>{l.label}</b> {LINE_WORD[l.state]} · {l.detail}</li>)}
          </ul>
        ) : null}
      </Strip>
      {syncPlan.error ? <p className="b-dt-err" role="alert">Sync failed: {errorText(syncPlan.error)}</p> : null}
      {syncPlan.data?.changelog_error ? <p className="b-dt-warn">Changelog not refreshed: {syncPlan.data.changelog_error}</p> : null}

      <section className="b-dt-list" aria-label="Versions">
        {error ? (
          <Empty title="Couldn’t read the versions" body={errorText(error)} action={<button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void refetch()}>Try again</button>} />
        ) : isLoading ? (
          <Empty title="Reading versions…" />
        ) : !sorted.length ? (
          <Empty title="No versions tracked" body="The plan syncs from GitHub every 5 minutes. Sync now fetches it straight away." action={<button type="button" className="b-btn b-btn--primary b-btn--row" disabled={syncPlan.isPending} onClick={sync}>Sync now</button>} />
        ) : sorted.map((v) => {
          const isOpen = open === v.id;
          const chip = versionChip(v.status);
          const current = v.status === 'in-progress';
          return (
            <div key={v.id} className={`b-dt-ver${current ? ' is-current' : ''}${isOpen ? ' open' : ''}`}>
              <div className="b-dt-ver-row">
                <span className="b-dt-ver-v b-num">{v.semver}</span>
                <Chip tone={chip.tone}>{chip.label}</Chip>
                <span className="b-dt-ver-text"><b>{v.codename ?? v.semver}</b><span>{versionSub(v)}</span></span>
                <button type="button" className={`b-dt-ver-btn${current ? ' ink' : ''}`} aria-expanded={isOpen} onClick={() => onOpen(isOpen ? null : v.id)}>{isOpen ? 'Close' : 'Open'}</button>
              </div>
              {isOpen ? <VersionDetail version={v} githubOnly={githubOnly} /> : null}
            </div>
          );
        })}
      </section>
      <p className="b-dt-foot">Versions come from docs/VERSION-PLAN.md on GitHub. Atlas ships one update feed, so there are no channels to promote or roll back here; a status changes by editing the plan.</p>
    </>
  );
}

// ── Design Sync ──────────────────────────────────────────────────────────────

async function reveal(root: string, rel: string): Promise<string | null> {
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(`${root.replace(/\/+$/, '')}/${rel}`);
    return null;
  } catch {
    return 'Show in Finder works in the desktop app.';
  }
}

function SyncView({ now }: ViewProps) {
  const { syncs, isLoading, error } = useDesignSyncs();
  const manifest = useSyncDesignManifest();
  const screensQ = useDesignScreens();
  const [revealNote, setRevealNote] = useState<string | null>(null);
  const result = screensQ.result;
  const screens = useMemo(() => sortScreens(result?.screens ?? []), [result]);
  const summary = result && !screensQ.error ? screenSummary(result.screens) : null;
  const current = syncs[0] ?? null;

  const syncing = manifest.isPending || screensQ.isFetching;
  // A successful sync re-reads the screen table itself (the hook invalidates
  // it). The table reads the checkout, not the manifest rows, so it is worth
  // re-reading even when copying the manifest failed.
  const sync = () => manifest.mutate(undefined, { onError: () => { void screensQ.refetch(); } });
  const show = (rel: string) => { if (result) void reveal(result.root, rel).then(setRevealNote); };

  const screensError = screensQ.error
    ? errorText(screensQ.error) === 'not found'
      ? 'This brain predates the screen table. Restart Atlas to load it.'
      : `The screen table couldn’t be read: ${errorText(screensQ.error)}`
    : null;
  const line = screensError ?? summary?.line ?? (screensQ.isLoading ? 'Reading the design and the code…' : result?.error ?? 'No design screens found.');

  return (
    <>
      <Strip
        tone={screensError ? 'unknown' : summary?.tone ?? 'unknown'}
        line={line}
        action={<button type="button" className="b-dt-strip-btn" disabled={syncing} onClick={sync}>{syncing ? 'Syncing…' : manifest.isSuccess ? 'Sync again' : 'Sync now'}</button>}
      >
        {current ? (
          <span className="b-dt-strip-sub">{current.bundle_name} · {BUNDLE_STATUS[current.status as BundleStatus]?.label ?? current.status}{result ? ` · checked ${ago(result.checkedAt, now) || 'just now'}` : ''}</span>
        ) : null}
      </Strip>
      {manifest.error ? <p className="b-dt-err" role="alert">Manifest not synced: {errorText(manifest.error)}</p> : null}
      {(manifest.data?.skipped.length ?? 0) > 0 ? <p className="b-dt-warn">Skipped in the manifest: {manifest.data?.skipped.join(' · ')}</p> : null}
      {result?.error && result.screens.length ? <p className="b-dt-warn">{result.error}</p> : null}
      {revealNote ? <p className="b-dt-note">{revealNote}</p> : null}

      <section className="b-dt-list" aria-label="Design and code">
        <div className="b-dt-scr b-dt-scr--head" aria-hidden><span>Design file</span><span>Code</span><span>State</span></div>
        {screens.length ? screens.map((s) => {
          const st = SCREEN_STATE[s.state];
          return (
            <div key={s.design} className="b-dt-scr">
              <button type="button" className="b-dt-scr-name" title={`${fileName(s.design)}${s.designChangedAt ? ` · changed ${ago(s.designChangedAt, now)}` : ''} — show in Finder`} onClick={() => show(s.design)}>{s.name}</button>
              {s.code ? (
                <button type="button" className="b-dt-scr-code b-num" title={`${s.codeKind === 'workshop' ? 'Workshop page · ' : ''}${s.codeChangedAt ? `changed ${ago(s.codeChangedAt, now)} · ` : ''}show in Finder`} onClick={() => show(s.code ?? '')}>{s.code}</button>
              ) : <span className="b-dt-scr-code b-dt-scr-none">no code yet</span>}
              <Chip tone={st.tone}>{st.label}</Chip>
            </div>
          );
        }) : (
          <Empty title={screensQ.isLoading ? 'Reading…' : 'No screens to show'} body={screensQ.isLoading ? undefined : screensError ?? result?.error ?? undefined} />
        )}
      </section>

      <section className="b-dt-list" aria-label="Design bundles">
        <div className="b-dt-list-head"><span className="b-dt-h2">Bundles</span><span className="b-num">design/.sync-manifest.json</span></div>
        {error ? (
          <Empty title="Couldn’t read the design bundles" body={errorText(error)} />
        ) : isLoading ? (
          <Empty title="Reading design bundles…" />
        ) : !syncs.length ? (
          <Empty title="No bundles tracked yet" body="Sync now copies design/.sync-manifest.json in: every Claude Design handoff, its status and the version it shipped in." action={<button type="button" className="b-btn b-btn--primary b-btn--row" disabled={syncing} onClick={sync}>Sync now</button>} />
        ) : syncs.map((b) => {
          const st = BUNDLE_STATUS[b.status as BundleStatus] ?? { label: b.status, tone: 'muted' as const };
          return (
            <div key={b.id} className="b-dt-bundle">
              <Chip tone={st.tone}>{st.label}</Chip>
              <span className="b-dt-bundle-text"><b>{b.bundle_name}</b><span>{bundleMeta(b, parseSurfaces(b.surfaces).length)}</span></span>
              <span className="b-dt-sha b-num" title={b.audit_notes ?? undefined}>{b.sha256.slice(0, 8)}</span>
            </div>
          );
        })}
      </section>
      <p className="b-dt-foot">“In sync” means the code changed after its design did, read from git; it is a pointer to where to look, not a review.</p>
    </>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

const BetaDevTools = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const { pathname } = useLocation();
  const { user, loading: authLoading } = useAuth();
  const tab = tabFor(pathname);
  const meta = DEV_TABS.find((t) => t.key === tab) ?? DEV_TABS[0];
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);

  // Same gate as the Workshop pages: these routes show the plan, the test
  // logs and the repo layout, and their buttons start processes on the Mac.
  useEffect(() => { if (!authLoading && !user) plainNavigate('/auth'); }, [user, authLoading, plainNavigate]);

  // The three routes are one component, so React keeps its state across a tab
  // change; what was open on one tab means nothing on the next.
  useEffect(() => { setOpen(null); }, [tab]);

  // Esc steps out: an open row first, then Home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (open) setOpen(null);
      else navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, navigate]);

  const view: ViewProps = { open, onOpen: setOpen, now };

  return (
    <div className="b-dt" data-screen-label={`Beta — Dev tools · ${meta.label}`}>
      <header className="b-dt-head">
        <div className="b-dt-titles">
          <button type="button" className="b-dt-back" title="Back to Home · Esc" onClick={() => navigate('/')}>Developer · internal</button>
          <h1 className="b-dt-h1">{meta.heading}</h1>
        </div>
        <nav className="b-dt-tabs" aria-label="Developer tools">
          {DEV_TABS.map((t) => {
            const on = t.key === tab;
            return <button key={t.key} type="button" className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} onClick={() => { if (!on) navigate(t.path); }}>{t.label}</button>;
          })}
        </nav>
      </header>

      {tab === 'tests' ? <TestsView {...view} /> : tab === 'versions' ? <VersionsView {...view} /> : <SyncView {...view} />}
    </div>
  );
};

export default BetaDevTools;
