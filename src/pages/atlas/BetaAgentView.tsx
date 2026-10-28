/**
 * The Beta Agent View — `/agent-view` while the beta_ui flag is on (Beta
 * redesign phase 6, `Atlas Agent View Beta.dc.html`).
 *
 * The run list on the left, the raised hero with the sphere, the plan and the
 * live log. Three real sources fill it (the reading is in lib/betaAgentView.ts):
 * the agent tables (`useAgentRuns`, `useAgents`, `useToolCalls`) give runs
 * their goal, limit, the plan the brain's runner wrote before the first step
 * (so progress is done/total) and the steps taken; the brain's admin tables
 * (`useAgentSessions`, `useAgentEvents` — the same calls the Workshop page
 * makes) give Claude Code, CI and self-repair sessions their event stream,
 * polled fast while a session is live because the brain has no push channel
 * for them; and `useApprovals` gives the queue of actions the control port
 * holds for the user, answered inline through `approval_resolve`. A call an
 * agent run made carries the run's id, so its question shows inside the run's
 * plan, right after the step that asked it.
 *
 * The run controls are the brain's (services/atlas-brain/src/agentRoutes.ts):
 * Pause holds the run between steps and Resume carries on from the next one;
 * "Stop and undo" first lists what will be taken back and what cannot be,
 * then — on one confirmation — stops the run (the brain closes its open
 * questions with it) and runs the recorded inverses newest first. Only then
 * is each question answered "no" through `approval_resolve`, so Rust drops
 * what it held; a stop the brain refused leaves the run and its questions as
 * they were. The undo writes through the brain, which tells no other screen,
 * so this one emits `db:changed` for each table it touched. A live CI
 * pipeline or self-repair has a Stop of its own; a Claude Code session says
 * where to stop it instead, because Atlas only reads its transcript.
 *
 * A run's hero says what leaves the Mac for it (RUN_EGRESS_NOTE): every step
 * is a call to the AI provider.
 *
 * The hero sphere is the screen's Talk to Atlas entry (registered as the talk
 * anchor, so the corner orb steps aside); clicking it opens the panel.
 *
 * Keys: Esc → Home (or closes a confirm) · J/K move through the list,
 * and ↑/↓ do too while focus is in it (elsewhere they keep scrolling the page).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { agentRunControls, announceTableChanges, useAgentEvents, useAgentSessions, useIngestSessions, useStopSession, useSyncCiRuns } from '@/hooks/useAgentView';
import { useAgentRuns } from '@/hooks/useAgentRuns';
import { useAgents } from '@/hooks/useAgents';
import { useApprovals, describeOutcome } from '@/hooks/useApprovals';
import { useToolCalls } from '@/hooks/useToolCalls';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import {
  KIND_COLOUR, RUN_EGRESS_NOTE, SESSION_STOP, STATE_META, approvalsCard, brainError, countLive, defaultCardId, describeStop, isLive,
  logFromApprovals, logFromRun, logFromSession, orderCards, pauseNote, planFromApprovals, planFromRun, planFromSession,
  runCard, runUndone, sessionCard, stopFailure, undoChanges, undoPreview, undoStepChanges,
  type LogLine, type PlanStep, type RunCard,
} from '@/lib/betaAgentView';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/agent-view.css';

/** How often the log asks the brain while the selected session is live (its watcher re-ingests ~2 s after a transcript changes). */
const LIVE_MS = 5_000;
/** The run list while any session is active. */
const LIST_LIVE_MS = 10_000;
/**
 * How long an undo that waits for the step in flight is followed, and how
 * often. A step stops within its wall clock (agentRunner.ts
 * STEP_WALL_CLOCK_MS, 90 s) once the model call it is in returns.
 */
const UNDO_FOLLOW_MS = 3 * 60_000;
const UNDO_FOLLOW_POLL_MS = 3_000;

type Busy = 'pause' | 'resume' | 'stop' | null;

const BetaAgentView = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  /** The run or session whose stop is being confirmed. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  /** What the last control did or why it failed, kept with the card it was for. */
  const [notice, setNotice] = useState<{ cardId: string; text: string; error: boolean } | null>(null);
  const [sphereEl, setSphereEl] = useState<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  // Relative labels ("4m") age; a slow tick keeps them honest without refetching anything.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { if (!authLoading && !user) plainNavigate('/auth'); }, [user, authLoading, plainNavigate]);
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // ---- Sources ---------------------------------------------------------------
  const { runs, runSteps, isLoading: runsLoading, fetchRuns, fetchRunSteps } = useAgentRuns(20);
  const { agents } = useAgents();
  const { toolCalls } = useToolCalls(60);
  const { approvals, approveRequest, rejectRequest, outcomes, dismissOutcome, resolvingId, fetchApprovals } = useApprovals();
  /** A stop whose undo runs once the step in flight settles: followed until its rows land (see below). */
  const [followUndo, setFollowUndo] = useState<{ runId: string; until: number } | null>(null);
  const ingest = useIngestSessions();
  const syncCi = useSyncCiRuns();
  const stopSession = useStopSession();

  const pending = useMemo(() => approvals.filter((a) => a.status === 'pending'), [approvals]);
  const pendingByRun = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of pending) if (a.run_id) m.set(a.run_id, (m.get(a.run_id) ?? 0) + 1);
    return m;
  }, [pending]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // The session list is polled faster only while something in it is active.
  const [anySessionLive, setAnySessionLive] = useState(false);
  const { sessions, isLoading: sessionsLoading, error: sessionsError } = useAgentSessions(undefined, { refetchMs: anySessionLive ? LIST_LIVE_MS : undefined });
  useEffect(() => { setAnySessionLive(sessions.some((s) => s.status === 'active')); }, [sessions]);

  const cards = useMemo(() => orderCards([
    // The queue card appears once approvals exist at all — pending or answered — so the answers have a place to be read.
    ...(approvals.length || outcomes.length ? [approvalsCard(pending, now)] : []),
    ...runs.map((r) => runCard(r, agentById.get(r.agent_id), pendingByRun.get(r.id) ?? 0, now)),
    ...sessions.map((s) => sessionCard(s, now)),
  ]), [approvals, outcomes, pending, runs, agentById, pendingByRun, sessions, now]);

  const selectedId = pickedId && cards.some((c) => c.id === pickedId) ? pickedId : defaultCardId(cards);
  const card: RunCard | null = cards.find((c) => c.id === selectedId) ?? null;
  const run = card?.kind === 'run' ? runs.find((r) => r.id === card.sourceId) ?? null : null;
  const session = card?.kind === 'session' ? sessions.find((s) => s.id === card.sourceId) ?? null : null;
  const sessionId = session?.id ?? null;
  const live = !!card && isLive(card.state);

  const { events, isLoading: eventsLoading } = useAgentEvents(sessionId, { refetchMs: live ? LIVE_MS : undefined });

  // Steps are fetched per run: on opening it, and again when its status moves
  // (a finished run settles its last step). New steps between those arrive
  // through the hook's own `run_steps` subscription and its live polling.
  const runId = run?.id ?? null;
  const runStatus = run?.status ?? null;
  useEffect(() => { if (runId) void fetchRunSteps(runId); }, [runId, runStatus, fetchRunSteps]);
  const stepsHere = useMemo(() => (run ? runSteps.filter((s) => s.run_id === run.id) : []), [runSteps, run]);

  // ---- The columns -----------------------------------------------------------------
  const plan: PlanStep[] = useMemo(() => {
    if (!card) return [];
    if (card.kind === 'run' && run) return planFromRun(run, stepsHere, approvals);
    if (card.kind === 'session') return planFromSession(events);
    return planFromApprovals(pending);
  }, [card, run, stepsHere, approvals, events, pending]);

  const log: LogLine[] = useMemo(() => {
    if (!card) return [];
    if (card.kind === 'run' && run) return logFromRun(stepsHere, toolCalls, run.id, card.measured != null);
    if (card.kind === 'session') return logFromSession(events);
    return logFromApprovals(approvals);
  }, [card, run, stepsHere, toolCalls, events, approvals]);

  // Outcomes of approvals answered on this screen, shown where the question was.
  const outcomesHere = useMemo(() => {
    if (!card) return [];
    if (card.kind === 'approvals') return outcomes;
    if (card.kind === 'run') return outcomes.filter((o) => approvals.find((a) => a.id === o.approvalId)?.run_id === card.sourceId);
    return [];
  }, [card, outcomes, approvals]);

  const preview = useMemo(() => (run ? undoPreview(stepsHere, approvals, run.id) : null), [run, stepsHere, approvals]);
  const undone = useMemo(() => runUndone(stepsHere), [stepsHere]);

  // ---- Actions -----------------------------------------------------------------------
  const refreshRun = useCallback(async (id: string) => {
    await Promise.all([fetchRuns(), fetchRunSteps(id), fetchApprovals()]);
  }, [fetchRuns, fetchRunSteps, fetchApprovals]);

  const togglePause = useCallback(async () => {
    if (!run || !card || busy) return;
    const resuming = card.state === 'paused';
    setBusy(resuming ? 'resume' : 'pause');
    setNotice(null);
    try {
      await (resuming ? agentRunControls.resume(run.id) : agentRunControls.pause(run.id));
      await fetchRuns();
    } catch (e) {
      setNotice({ cardId: card.id, text: brainError(e), error: true });
    } finally { setBusy(null); }
  }, [run, card, busy, fetchRuns]);

  const stopRun = useCallback(async (undo: boolean) => {
    if (!run || !card || busy) return;
    setBusy('stop');
    setNotice(null);
    const asked = pending.filter((a) => a.run_id === run.id).map((a) => a.id);
    try {
      // The brain first. Once it has the run cancelled its runner refuses every
      // further call and closes the run's questions, so nothing the user meant
      // to cancel can run afterwards — and a stop it refuses changes nothing.
      const result = await agentRunControls.stop(run.id, { undo });
      // Then each question "no" through approval_resolve, the one path that
      // drops the payload Rust holds for it. The brain has closed the rows
      // already, so "already answered" is the expected reply, and not news.
      for (const id of asked) {
        const outcome = await rejectRequest(id).catch(() => null);
        if (outcome?.kind === 'already') dismissOutcome(id);
      }
      if (result.undo === 'after-step') setFollowUndo({ runId: run.id, until: Date.now() + UNDO_FOLLOW_MS });
      else if (result.undo) void announceTableChanges(undoChanges(result.undo.undone));
      setNotice({ cardId: card.id, text: describeStop(result), error: false });
      setConfirming(null);
    } catch (e) {
      const failure = stopFailure(e, asked.length);
      // A stop that may have landed may have undone things too; follow it as if it waited for a step.
      if (failure.unconfirmed && undo) setFollowUndo({ runId: run.id, until: Date.now() + UNDO_FOLLOW_MS });
      setNotice({ cardId: card.id, text: failure.text, error: true });
    } finally {
      setBusy(null);
      void refreshRun(run.id);
    }
  }, [run, card, busy, pending, rejectRequest, dismissOutcome, refreshRun]);

  // An undo that waited for the step in flight runs inside the brain later,
  // and nothing says when. While that run is open its steps are re-read until
  // the undo's rows land; then the screens showing what it changed are told.
  useEffect(() => {
    if (!followUndo || followUndo.runId !== runId) return;
    const t = window.setInterval(() => {
      if (Date.now() > followUndo.until) { setFollowUndo(null); return; }
      if (!document.hidden) void fetchRunSteps(followUndo.runId);
    }, UNDO_FOLLOW_POLL_MS);
    return () => window.clearInterval(t);
  }, [followUndo, runId, fetchRunSteps]);
  useEffect(() => {
    if (!followUndo || followUndo.runId !== runId || !runUndone(stepsHere)) return;
    setFollowUndo(null);
    void announceTableChanges(undoStepChanges(stepsHere));
  }, [followUndo, runId, stepsHere]);

  const stopThisSession = useCallback(() => {
    if (!session || !card) return;
    setNotice(null);
    stopSession.mutate(session.id, {
      onSuccess: (r) => {
        setConfirming(null);
        setNotice({ cardId: card.id, text: r.outcome === 'cancel-requested' ? 'GitHub was asked to cancel the run.' : 'Stopped.', error: false });
      },
      onError: (e) => setNotice({ cardId: card.id, text: brainError(e), error: true }),
    });
  }, [session, card, stopSession]);

  const skip = useCallback((approvalId: string) => {
    // Refusing throws the queued action away, so it takes a second click (as the Workshop does).
    if (rejecting !== approvalId) { setRejecting(approvalId); return; }
    void rejectRequest(approvalId).finally(() => setRejecting((cur) => (cur === approvalId ? null : cur)));
  }, [rejecting, rejectRequest]);

  const sync = useCallback(() => {
    ingest.mutate();
    syncCi.mutate();
    void fetchRuns();
    void fetchApprovals();
  }, [ingest, syncCi, fetchRuns, fetchApprovals]);
  const syncing = ingest.isPending || syncCi.isPending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = cards.findIndex((c) => c.id === selectedId);
      const inList = !!listRef.current && e.target instanceof Node && listRef.current.contains(e.target);
      const move = (to: number) => {
        if (!cards.length) return;
        e.preventDefault();
        const next = cards[Math.max(0, Math.min(cards.length - 1, to))];
        setPickedId(next.id);
        // Keep keyboard focus on the card that is now selected.
        if (inList) listRef.current?.querySelector<HTMLButtonElement>(`[data-card="${CSS.escape(next.id)}"]`)?.focus();
      };
      switch (e.key) {
        case 'Escape':
          if (confirming) setConfirming(null);
          else if (rejecting) setRejecting(null);
          else navigate('/');
          break;
        case 'j': move(i + 1); break;
        case 'k': move(i - 1); break;
        case 'ArrowDown': if (inList) move(i + 1); break;
        case 'ArrowUp': if (inList) move(i - 1); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards, selectedId, rejecting, confirming, navigate]);

  useEffect(() => { setRejecting(null); setConfirming(null); }, [selectedId]);
  // A card that stops being live has nothing left to confirm a stop for.
  useEffect(() => { if (!live) setConfirming(null); }, [live]);

  // ---- Render ------------------------------------------------------------------------
  const loading = authLoading || (runsLoading && sessionsLoading);
  const meta = card ? STATE_META[card.state] : null;
  const statusLabel = card?.kind === 'run' && card.state === 'stopped' && undone ? 'Stopped · undone' : meta?.label;
  const planTitle = !card ? 'Plan'
    : card.kind === 'run'
      ? (card.measured
        ? `Plan · ${card.measured.done} of ${card.measured.total} step${card.measured.total === 1 ? '' : 's'}`
        : `Steps · ${plan.filter((p) => !p.approvalId).length}`)
      : card.kind === 'session' ? `Milestones · ${plan.length}`
        : `Needs your answer · ${plan.length}`;
  const logTitle = !card ? 'What Atlas is doing' : card.kind === 'approvals' ? 'Answered' : live ? 'What Atlas is doing' : 'What Atlas did';
  const planEmpty = !card ? 'Pick a run to see its plan.'
    : card.kind === 'run'
      ? (!live ? 'This run recorded no steps.'
        : run?.status === 'pending' ? 'Waiting for the brain to pick this run up. It plans before the first step.'
          : run?.status === 'planning' ? 'Atlas is writing the plan.' : 'No steps recorded yet.')
      : card.kind === 'session' ? 'No milestones yet — the log has the detail.'
        : 'Nothing waiting on you.';
  const logEmpty = !card ? 'Pick a run to follow it.'
    : card.kind === 'session' ? (eventsLoading ? 'Reading…' : live ? 'Nothing logged yet. New events arrive as the transcript is written.' : 'This session logged nothing.')
      : card.kind === 'run' ? 'Nothing logged for this run.'
        : 'No approvals answered yet.';
  const noticeHere = notice && card && notice.cardId === card.id ? notice : null;
  const stepInFlight = plan.some((p) => p.mark === 'now' && !p.approvalId);
  const sessionStop = session ? SESSION_STOP[session.session_type] : undefined;

  return (
    <div className="b-ag" data-beta-tone="ink" data-screen-label="Beta — Agent View">
      <aside className="b-ag-aside" aria-label="Runs" ref={listRef}>
        <button type="button" className="b-ag-eyebrow" title="Back to Home · Esc" onClick={() => navigate('/')}>Agent · {countLive(cards)} running</button>
        {cards.map((c) => {
          const m = STATE_META[c.state];
          const on = c.id === selectedId;
          return (
            <button type="button" key={c.id} data-card={c.id} className={`b-ag-run${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setPickedId(c.id)}>
              <span className="b-ag-run-head">
                <i className={`b-ag-dot${m.pulse ? ' pulse' : ''}`} style={{ background: m.dot }} />
                <span className="b-ag-run-t">{c.title}</span>
                <span className="b-ag-run-when">{c.when}</span>
              </span>
              <span className={`b-ag-bar${c.progress == null && isLive(c.state) ? ' live' : ''}`} aria-hidden>
                <span style={{ background: m.dot, width: c.progress == null ? undefined : `${Math.round(c.progress * 100)}%` }} />
              </span>
              <span className="b-ag-run-sub">{c.sub}</span>
            </button>
          );
        })}
        {!loading && !cards.length ? (
          <div className="b-ag-aside-empty">
            <b>Nothing running</b>
            <span>Agent runs, Claude Code sessions and CI pipelines appear here. Sessions arrive from the brain's transcript watcher and from Sync; a run starts when a schedule's Run now asks for one.</span>
          </div>
        ) : null}
        {loading ? <p className="b-ag-note">Reading…</p> : null}
        <div className="b-ag-aside-foot">
          <button type="button" className="b-ag-sync" disabled={syncing} onClick={sync} title="Ingest Claude Code transcripts and fetch CI runs">
            <AtlasIcon name="sync" size={15} weight={1.8} />{syncing ? 'Syncing…' : 'Sync'}
          </button>
          {sessionsError ? <p className="b-ag-note err">{sessionsError.message}</p> : null}
          {ingest.error ? <p className="b-ag-note err">Ingest: {ingest.error.message}</p> : null}
          {syncCi.error ? <p className="b-ag-note err">CI: {syncCi.error.message}</p> : null}
          {ingest.data && !ingest.isPending ? <p className="b-ag-note">{ingest.data.sessions_upserted} session{ingest.data.sessions_upserted === 1 ? '' : 's'}, {ingest.data.events_inserted} event{ingest.data.events_inserted === 1 ? '' : 's'} ingested.</p> : null}
        </div>
      </aside>

      <main className="b-ag-main">
        <section className="b-ag-hero" aria-label={card ? card.title : 'Nothing running'}>
          <button type="button" className="b-ag-sphere" ref={setSphereEl} onClick={() => openTalk()} title="Talk to Atlas · ⌥ Space" aria-label="Talk to Atlas">
            <VeilSphere size="hero" count={9000} ink bg="#26262d" state={meta?.sphere ?? 'idle'} />
          </button>
          <div className="b-ag-hero-text">
            <span className="b-ag-status" style={{ color: meta?.fg ?? 'var(--b-on-ink-body)' }}>
              <i className={`b-ag-dot${meta?.pulse ? ' pulse' : ''}`} style={{ background: meta?.dot ?? 'var(--b-tertiary)' }} />
              {statusLabel ?? (loading ? 'Reading' : 'Nothing running')}
            </span>
            <h1 className="b-ag-h1">{card?.title ?? (loading ? '…' : 'Atlas is idle')}</h1>
            {card ? (card.goal ? <p className="b-ag-goal">{card.goal}</p> : null)
              : !loading ? <p className="b-ag-goal">No agent run, Claude Code session or pipeline is being tracked right now. Sync pulls in the latest transcripts and CI runs.</p> : null}
            {card?.state === 'paused' && card.kind === 'run' ? <p className="b-ag-hint">{pauseNote(plan)}</p> : null}
            {card?.kind === 'run' ? <p className="b-ag-hint">{RUN_EGRESS_NOTE}</p> : null}
            {card?.stopNote ? <p className="b-ag-hint">{card.stopNote}</p> : null}
            {card ? (
              <div className="b-ag-actions">
                {card.canPause && run ? (
                  <button type="button" className="b-ag-act b-ag-act--primary" disabled={!!busy} onClick={() => void togglePause()}
                    title={card.state === 'paused' ? 'Carries on from the next step' : 'Waits before the next step; the step in progress finishes first'}>
                    <AtlasIcon name={card.state === 'paused' ? 'play' : 'pause'} size={15} weight={1.9} />
                    {busy === 'pause' ? 'Pausing…' : busy === 'resume' ? 'Resuming…' : card.state === 'paused' ? 'Resume' : 'Pause'}
                  </button>
                ) : null}
                {card.canStop && (run || sessionStop) && confirming !== card.id ? (
                  <button type="button" className="b-ag-act b-ag-act--stop" disabled={!!busy || stopSession.isPending}
                    onClick={() => { setNotice(null); setConfirming(card.id); }}
                    title={run ? 'Shows what will be undone before anything stops' : sessionStop?.title}>
                    <AtlasIcon name="close" size={15} weight={1.9} />{run ? 'Stop and undo' : 'Stop'}
                  </button>
                ) : null}
                {card.limit ? <span className="b-ag-chip" title={card.limitNote ?? undefined}>{card.kind === 'run' ? `Limit · ${card.limit}` : card.limit}</span> : null}
                {card.kind === 'run' && run ? <span className="b-ag-chip b-num">{(run.tokens_planner + run.tokens_worker + run.tokens_reasoner).toLocaleString()} tokens{run.cost_estimate ? ` · $${run.cost_estimate.toFixed(4)}` : ''}</span> : null}
                {card.kind === 'approvals' ? <span className="b-ag-chip">{pending.length ? `${pending.length} to answer` : 'All answered'}</span> : null}
              </div>
            ) : null}

            {card && confirming === card.id && run && preview ? (
              <div className="b-ag-confirm" role="group" aria-label="Stop and undo">
                <b className="b-ag-confirm-t">{preview.undoable.length ? 'Stop this run and take back what it did?' : 'Stop this run?'}</b>
                {preview.undoable.length ? (
                  <>
                    <span className="b-ag-confirm-h">Will be undone, newest first</span>
                    <ul className="b-ag-confirm-list">{preview.undoable.map((l, i) => <li key={`u${i}`}>{l}</li>)}</ul>
                  </>
                ) : <p className="b-ag-confirm-p">Nothing it has done so far has an undo.</p>}
                {preview.cannot.length ? (
                  <>
                    <span className="b-ag-confirm-h">Can’t be undone</span>
                    <ul className="b-ag-confirm-list cannot">{preview.cannot.map((c, i) => <li key={`c${i}`}>{c.label}<span>{c.reason}</span></li>)}</ul>
                  </>
                ) : null}
                {preview.questions ? <p className="b-ag-confirm-p">{preview.questions} question{preview.questions === 1 ? '' : 's'} waiting on you will be skipped. Nothing in {preview.questions === 1 ? 'it' : 'them'} ran.</p> : null}
                {stepInFlight ? <p className="b-ag-confirm-p">The step in progress is stopped from making further changes; what it already did is undone with the rest.</p> : null}
                <div className="b-ag-actions">
                  <button type="button" className="b-ag-act b-ag-act--danger" disabled={!!busy} onClick={() => void stopRun(true)}>
                    {busy === 'stop' ? 'Stopping…' : preview.undoable.length ? `Stop and undo ${preview.undoable.length}` : 'Stop'}
                  </button>
                  {preview.undoable.length ? <button type="button" className="b-ag-act b-ag-act--stop" disabled={!!busy} onClick={() => void stopRun(false)}>Stop, keep changes</button> : null}
                  <button type="button" className="b-ag-act b-ag-act--quiet" disabled={!!busy} onClick={() => setConfirming(null)}>Keep running</button>
                </div>
              </div>
            ) : null}

            {card && confirming === card.id && session && sessionStop ? (
              <div className="b-ag-confirm" role="group" aria-label="Stop session">
                <b className="b-ag-confirm-t">{session.session_type === 'ci-pipeline' ? 'Cancel this CI run?' : 'Stop this repair?'}</b>
                <p className="b-ag-confirm-p">
                  {session.session_type === 'ci-pipeline'
                    ? 'Atlas asks GitHub to cancel the workflow run with your gh login. That request leaves the Mac; what the run already did stays done.'
                    : 'The repair stops after the stage in progress. It never applies its fix to your code, so there is nothing to undo.'}
                </p>
                <div className="b-ag-actions">
                  <button type="button" className="b-ag-act b-ag-act--danger" disabled={stopSession.isPending} onClick={stopThisSession}>
                    {stopSession.isPending ? 'Stopping…' : session.session_type === 'ci-pipeline' ? 'Cancel the run' : 'Stop'}
                  </button>
                  <button type="button" className="b-ag-act b-ag-act--quiet" disabled={stopSession.isPending} onClick={() => setConfirming(null)}>Keep running</button>
                </div>
              </div>
            ) : null}

            {noticeHere ? <p className={noticeHere.error ? 'b-ag-err' : 'b-ag-hint'} role={noticeHere.error ? 'alert' : 'status'}>{noticeHere.text}</p> : null}
          </div>
        </section>

        <div className="b-ag-body">
          <section className="b-ag-plan" aria-label="Plan">
            <span className="b-ag-col-h">{planTitle}</span>
            {plan.map((s, i) => {
              const answering = !!s.approvalId && resolvingId === s.approvalId;
              const confirmSkip = !!s.approvalId && rejecting === s.approvalId;
              const number = plan.slice(0, i + 1).filter((p) => !p.approvalId).length;
              return (
                <div key={s.id} className={`b-ag-step ${s.mark}${s.approvalId ? ' ask' : ''}`}>
                  <span className="b-ag-mark">{s.mark === 'done' ? '✓' : s.mark === 'failed' ? '!' : s.approvalId ? '?' : String(number)}</span>
                  <span className="b-ag-step-text">
                    <span className="b-ag-step-t">{s.title}</span>
                    {s.detail ? <span className="b-ag-step-d">{s.detail}</span> : null}
                    {s.approvalId ? (
                      <span className="b-ag-approve">
                        {!confirmSkip ? <button type="button" className="yes" disabled={answering} onClick={() => void approveRequest(s.approvalId!)}>{answering ? 'Running…' : 'Approve'}</button> : null}
                        <button type="button" className={`no${confirmSkip ? ' confirm' : ''}`} disabled={answering} onClick={() => skip(s.approvalId!)}>
                          {confirmSkip ? (answering ? 'Skipping…' : 'Skip — it will not run') : 'Skip this step'}
                        </button>
                        {confirmSkip ? <button type="button" className="no" disabled={answering} onClick={() => setRejecting(null)}>Keep waiting</button> : null}
                      </span>
                    ) : null}
                  </span>
                  <span className="b-ag-step-time">{s.time}</span>
                </div>
              );
            })}
            {outcomesHere.map((o) => {
              const d = describeOutcome(o);
              return (
                <div key={`outcome:${o.approvalId}`} className={`b-ag-step ${d.tone === 'good' ? 'done' : d.tone === 'bad' ? 'failed' : 'todo'}`} role="status">
                  <span className="b-ag-mark">{d.tone === 'good' ? '✓' : d.tone === 'bad' ? '!' : '–'}</span>
                  <span className="b-ag-step-text">
                    <span className="b-ag-step-t">{d.title}</span>
                    {d.detail ? <span className="b-ag-step-d">{d.detail}</span> : null}
                  </span>
                  <button type="button" className="b-ag-step-dismiss" onClick={() => dismissOutcome(o.approvalId)}>Dismiss</button>
                </div>
              );
            })}
            {!plan.length && !outcomesHere.length ? <div className="b-ag-col-empty">{planEmpty}</div> : null}
          </section>

          <section className="b-ag-log" aria-label="Activity log" aria-live={live ? 'polite' : undefined}>
            <span className="b-ag-col-h">
              {logTitle}
              {card && live ? (
                <span className="b-ag-live"><i className="b-ag-dot pulse" style={{ background: 'var(--b-blue)' }} />{card.kind === 'session' ? `live · every ${LIVE_MS / 1000} s` : 'live'}</span>
              ) : null}
            </span>
            {log.map((l) => (
              <div key={l.id} className="b-ag-line">
                <span className="b-ag-line-t">{l.time}</span>
                <span className="b-ag-line-k" style={{ color: KIND_COLOUR[l.kind] }}>{l.kind}</span>
                <span className="b-ag-line-m">{l.message}</span>
              </div>
            ))}
            {!log.length ? <div className="b-ag-col-empty">{logEmpty}</div> : null}
          </section>
        </div>
      </main>
    </div>
  );
};

export default BetaAgentView;
