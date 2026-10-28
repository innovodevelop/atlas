/**
 * The Beta Agent View — `/agent-view` while the beta_ui flag is on (Beta
 * redesign phase 6, `Atlas Agent View Beta.dc.html`).
 *
 * The run list on the left, the raised hero with the sphere, the plan and the
 * live log. Three real sources fill it (the reading is in lib/betaAgentView.ts):
 * the agent tables (`useAgentRuns`, `useAgents`, `useToolCalls`) give runs
 * their goal, limit, steps and the one real stop call (`cancelRun`); the
 * brain's admin tables (`useAgentSessions`, `useAgentEvents` — the same calls
 * the Workshop page makes) give Claude Code, CI and self-repair sessions their
 * event stream, polled fast while a session is live because the brain has no
 * push channel for them; and `useApprovals` gives the queue of actions the
 * control port holds for the user, answered inline through `approval_resolve`.
 *
 * What the design shows and this screen does not: Pause/Resume (no source has
 * a pause call — `runs.status` has no paused value and sessions cannot be
 * paused from here) and the "undo" half of "Stop and undo" (cancelling a run
 * flips its row; nothing can reverse a step already taken). Both are left out
 * rather than drawn dead.
 *
 * The hero sphere is the screen's Talk to Atlas entry (registered as the talk
 * anchor, so the corner orb steps aside); clicking it opens the panel.
 *
 * Keys: Esc → Home (or closes a Skip confirm) · J/K move through the list,
 * and ↑/↓ do too while focus is in it (elsewhere they keep scrolling the page).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useAgentEvents, useAgentSessions, useIngestSessions, useSyncCiRuns } from '@/hooks/useAgentView';
import { useAgentRuns } from '@/hooks/useAgentRuns';
import { useAgents } from '@/hooks/useAgents';
import { useApprovals, describeOutcome } from '@/hooks/useApprovals';
import { useToolCalls } from '@/hooks/useToolCalls';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import {
  KIND_COLOUR, STATE_META, approvalsCard, countLive, defaultCardId, isLive, logFromApprovals,
  logFromRun, logFromSession, orderCards, planFromApprovals, planFromRun, planFromSession, runCard, sessionCard,
  type LogLine, type PlanStep, type RunCard,
} from '@/lib/betaAgentView';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/agent-view.css';

/** How often the log asks the brain while the selected session is live (its watcher re-ingests ~2 s after a transcript changes). */
const LIVE_MS = 5_000;
/** The run list while any session is active. */
const LIST_LIVE_MS = 10_000;

const BetaAgentView = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  /** The run whose cancel write failed, so the hero can say it is still running. */
  const [stopFailed, setStopFailed] = useState<string | null>(null);
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
  const { runs, runSteps, isLoading: runsLoading, fetchRuns, fetchRunSteps, cancelRun } = useAgentRuns(20);
  const { agents } = useAgents();
  const { toolCalls } = useToolCalls(60);
  const { approvals, approveRequest, rejectRequest, outcomes, dismissOutcome, resolvingId, fetchApprovals } = useApprovals();
  const ingest = useIngestSessions();
  const syncCi = useSyncCiRuns();

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
  const sessionId = card?.kind === 'session' ? card.sourceId : null;
  const live = !!card && isLive(card.state);

  const { events, isLoading: eventsLoading } = useAgentEvents(sessionId, { refetchMs: live ? LIVE_MS : undefined });

  // Steps are fetched per run: on opening it, and again when its status moves
  // (a finished run settles its last step). New steps between those arrive
  // through the hook's own `run_steps` subscription.
  const runId = run?.id ?? null;
  const runStatus = run?.status ?? null;
  useEffect(() => { if (runId) void fetchRunSteps(runId); }, [runId, runStatus, fetchRunSteps]);
  const stepsHere = useMemo(() => (run ? runSteps.filter((s) => s.run_id === run.id) : []), [runSteps, run]);

  // ---- The columns -----------------------------------------------------------------
  const plan: PlanStep[] = useMemo(() => {
    if (!card) return [];
    if (card.kind === 'run' && run) return planFromRun(stepsHere, approvals, run.id);
    if (card.kind === 'session') return planFromSession(events);
    return planFromApprovals(pending);
  }, [card, run, stepsHere, approvals, events, pending]);

  const log: LogLine[] = useMemo(() => {
    if (!card) return [];
    if (card.kind === 'run' && run) return logFromRun(stepsHere, toolCalls, run.id);
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

  // ---- Actions -----------------------------------------------------------------------
  const stop = useCallback(async () => {
    if (!run || stopping) return;
    setStopping(true);
    setStopFailed(null);
    try {
      const ok = await cancelRun(run.id);
      if (!ok) setStopFailed(run.id);
    } finally { setStopping(false); }
  }, [run, stopping, cancelRun]);

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
          if (rejecting) setRejecting(null); else navigate('/');
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
  }, [cards, selectedId, rejecting, navigate]);

  useEffect(() => { setRejecting(null); }, [selectedId]);

  // ---- Render ------------------------------------------------------------------------
  const loading = authLoading || (runsLoading && sessionsLoading);
  const meta = card ? STATE_META[card.state] : null;
  const planDone = plan.filter((p) => p.mark === 'done' || p.mark === 'failed').length;
  const planTitle = !card ? 'Plan'
    : card.kind === 'run' ? `Plan · ${planDone} of ${plan.length} step${plan.length === 1 ? '' : 's'}`
      : card.kind === 'session' ? `Milestones · ${plan.length}`
        : `Needs your answer · ${plan.length}`;
  const logTitle = !card ? 'What Atlas is doing' : card.kind === 'approvals' ? 'Answered' : live ? 'What Atlas is doing' : 'What Atlas did';
  const planEmpty = !card ? 'Pick a run to see its plan.'
    : card.kind === 'run' ? (live ? 'No steps recorded yet.' : 'This run recorded no steps.')
      : card.kind === 'session' ? 'No milestones yet — the log has the detail.'
        : 'Nothing waiting on you.';
  const logEmpty = !card ? 'Pick a run to follow it.'
    : card.kind === 'session' ? (eventsLoading ? 'Reading…' : live ? 'Nothing logged yet. New events arrive as the transcript is written.' : 'This session logged nothing.')
      : card.kind === 'run' ? 'Nothing logged for this run.'
        : 'No approvals answered yet.';

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
            <span>Agent runs, Claude Code sessions and CI pipelines appear here. Sessions arrive from the brain's transcript watcher and from Sync; runs need an agent to be executed.</span>
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
              {meta?.label ?? (loading ? 'Reading' : 'Nothing running')}
            </span>
            <h1 className="b-ag-h1">{card?.title ?? (loading ? '…' : 'Atlas is idle')}</h1>
            {card ? (card.goal ? <p className="b-ag-goal">{card.goal}</p> : null)
              : !loading ? <p className="b-ag-goal">No agent run, Claude Code session or pipeline is being tracked right now. Sync pulls in the latest transcripts and CI runs.</p> : null}
            {run && stopFailed === run.id && isLive(card?.state ?? 'done') ? <p className="b-ag-err" role="alert">The run could not be stopped. It is still marked as running.</p> : null}
            {card ? (
              <div className="b-ag-actions">
                {card.canStop && run ? (
                  <button type="button" className="b-ag-act b-ag-act--stop" disabled={stopping} onClick={() => void stop()} title="Marks the run cancelled">
                    <AtlasIcon name="close" size={15} weight={1.9} />{stopping ? 'Stopping…' : 'Stop run'}
                  </button>
                ) : null}
                {card.limit ? <span className="b-ag-chip">{card.kind === 'run' ? `Limit · ${card.limit}` : card.limit}</span> : null}
                {card.kind === 'run' && run ? <span className="b-ag-chip b-num">{(run.tokens_planner + run.tokens_worker + run.tokens_reasoner).toLocaleString()} tokens{run.cost_estimate ? ` · $${run.cost_estimate.toFixed(4)}` : ''}</span> : null}
                {card.kind === 'approvals' ? <span className="b-ag-chip">{pending.length ? `${pending.length} to answer` : 'All answered'}</span> : null}
              </div>
            ) : null}
          </div>
        </section>

        <div className="b-ag-body">
          <section className="b-ag-plan" aria-label="Plan">
            <span className="b-ag-col-h">{planTitle}</span>
            {plan.map((s, i) => {
              const busy = !!s.approvalId && resolvingId === s.approvalId;
              const confirming = !!s.approvalId && rejecting === s.approvalId;
              return (
                <div key={s.id} className={`b-ag-step ${s.mark}`}>
                  <span className="b-ag-mark">{s.mark === 'done' ? '✓' : s.mark === 'failed' ? '!' : String(i + 1)}</span>
                  <span className="b-ag-step-text">
                    <span className="b-ag-step-t">{s.title}</span>
                    {s.detail ? <span className="b-ag-step-d">{s.detail}</span> : null}
                    {s.approvalId ? (
                      <span className="b-ag-approve">
                        {!confirming ? <button type="button" className="yes" disabled={busy} onClick={() => void approveRequest(s.approvalId!)}>{busy ? 'Running…' : 'Approve'}</button> : null}
                        <button type="button" className={`no${confirming ? ' confirm' : ''}`} disabled={busy} onClick={() => skip(s.approvalId!)}>
                          {confirming ? (busy ? 'Skipping…' : 'Skip — it will not run') : 'Skip this step'}
                        </button>
                        {confirming ? <button type="button" className="no" disabled={busy} onClick={() => setRejecting(null)}>Keep waiting</button> : null}
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
