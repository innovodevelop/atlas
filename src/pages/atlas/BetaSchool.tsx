/**
 * The Beta School — `/school` (Beta redesign phase 5, `Atlas School Beta.dc.html`
 * and `Atlas School Tools Beta.dc.html`). A new surface; there was no School
 * screen before it.
 *
 * Two school connections, both read by Rust with what the student hands over
 * on "Your school" and keeps in the Keychain (lib/betaSchoolSync.ts):
 *
 *   - Lectio's calendar feed: the schedule, today's lessons in the ribbon,
 *     cancellations and changes, and the exams in it;
 *   - LearnIT (Moodle) with a security key: assignments (which Atlas prepares
 *     on request), materials, messages and grades.
 *
 * Without them those views say what they need. What is the student's own is
 * kept on this Mac (lib/betaSchoolStore.ts): Study plan and the focus timer,
 * Cards (spaced repetition), the Socratic Tutor and what it saw them
 * understand, exams they add, and School Tools — Writing in sections with
 * numbered margin notes, and a Spreadsheet where Atlas may draft a column.
 *
 * The hero is the design's ink band: the sphere (this screen's talk entry
 * point), the clock, and the ribbon — today's lessons and study sessions, the
 * running one filling as it goes. Esc steps back to Today, then Home.
 *
 * School is a new surface, so it is routed whether or not the beta_ui flag is
 * on. Without the flag there is no Beta shell and so no Talk panel; the
 * sphere is then only the sphere, not a button that would open nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { SchoolAssignments } from '@/components/atlas/school/SchoolAssignments';
import { useWork } from '@/components/atlas/school/useSchoolWork';
import { SchoolCards } from '@/components/atlas/school/SchoolCards';
import { SchoolConnect } from '@/components/atlas/school/SchoolConnect';
import { SchoolExams } from '@/components/atlas/school/SchoolExams';
import { SchoolGrades } from '@/components/atlas/school/SchoolGrades';
import { SchoolMaterials } from '@/components/atlas/school/SchoolMaterials';
import { SchoolMessages } from '@/components/atlas/school/SchoolMessages';
import { SchoolPlan } from '@/components/atlas/school/SchoolPlan';
import { SchoolSchedule } from '@/components/atlas/school/SchoolSchedule';
import { SchoolSheet } from '@/components/atlas/school/SchoolSheet';
import { SchoolToday } from '@/components/atlas/school/SchoolToday';
import { SchoolTutor } from '@/components/atlas/school/SchoolTutor';
import { SchoolWriting } from '@/components/atlas/school/SchoolWriting';
import { SCHOOL_TABS, assignmentFromHash, assignmentHash, tabFromHash, type SchoolTab } from '@/components/atlas/school/schoolTabs';
import { useNow, useSchoolSyncLoop } from '@/components/atlas/school/useSchoolHooks';
import {
  clock, dueCards, dueIn, focusLeft, hhmm, isoWeek, longDate, weekStart, weekSummary, weekdayLong,
} from '@/lib/betaSchool';
import { dayRibbon } from '@/lib/betaSchoolIcs';
import { flushSchool, useSchool, useSchoolSaveFailed } from '@/lib/betaSchoolStore';
import { useSchoolSync } from '@/lib/betaSchoolSync';
import { dayItems } from '@/lib/betaSchoolWork';
import { isBetaUi } from '@/lib/betaFlag';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/school.css';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree. Consumer and not mock: nothing on the screen is sample
 * data — what has no source says so instead of being drawn.
 */
export const surface = {
  path: '/school',
  label: 'School',
  icon: 'GraduationCap',
  entry: 'menu' as const,
  mock: false,
  edition: 'consumer' as const,
};

interface Toast { text: string; undo?: () => void }

const BetaSchool = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const location = useLocation();
  const school = useSchool();
  const sync = useSchoolSync();
  const work = useWork();
  const saveFailed = useSchoolSaveFailed();
  const [tab, setTabState] = useState<SchoolTab>(() => tabFromHash(location.hash));
  const [sphereEl, setSphereEl] = useState<HTMLElement | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | null>(null);
  const focusRunning = school.focus.endsAt !== null;
  // Seconds only matter while the focus timer runs; the clock and the ribbon move by the minute.
  const now = useNow(focusRunning ? 1000 : 15_000);
  const talk = isBetaUi();
  const openAssignment = assignmentFromHash(location.hash);
  useSchoolSyncLoop();

  // The hero sphere is this screen's talk entry point.
  useEffect(() => {
    if (!talk) return;
    setTalkAnchor(sphereEl);
    return () => setTalkAnchor(null);
  }, [sphereEl, talk]);
  useEffect(() => () => flushSchool(), []);
  // Back and forward move between views, since each one has its own hash.
  useEffect(() => { setTabState(tabFromHash(location.hash)); }, [location.hash]);

  const setTab = useCallback((t: SchoolTab) => {
    setTabState(t);
    plainNavigate({ hash: t === 'today' ? '' : t }, { replace: true });
    window.scrollTo({ top: 0 });
  }, [plainNavigate]);

  // An assignment opens as its own history entry, so Back closes it.
  const openWork = useCallback((key: string | null) => {
    setTabState('assignments');
    plainNavigate({ hash: assignmentHash(key) }, { replace: key === null && !!openAssignment });
    window.scrollTo({ top: 0 });
  }, [plainNavigate, openAssignment]);

  const showToast = useCallback((text: string, undo?: () => void) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 5200 : 3200);
  }, []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      if (openAssignment) openWork(null);
      else if (tab !== 'today') setTab('today');
      else navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, setTab, navigate, openAssignment, openWork]);

  const lessons = sync.lectio.cache?.lessons;
  const ribbon = useMemo(() => dayRibbon(dayItems(lessons ?? [], school.sessions, school.subjects, now), now, 4), [lessons, school.sessions, school.subjects, now]);
  const cardsDue = useMemo(() => dueCards(school.cards, now).length, [school.cards, now]);
  const next = work.find((w) => !w.done && w.due !== null) ?? null;
  const nextSteps = next?.prepared ? next.prepared.steps : null;
  const nextDone = nextSteps ? nextSteps.filter((x) => x.done).length : 0;
  const connected = !!sync.conn?.lectio || !!sync.conn?.moodle.connected;
  const freshWork = work.filter((w) => w.fresh && !w.done).length;
  const week = weekSummary(school.sessions, weekStart(now));
  const left = focusLeft(school.focus, now);
  const current = SCHOOL_TABS.find((t) => t.key === tab) ?? SCHOOL_TABS[0];

  const subline = useMemo(() => {
    const parts: string[] = [];
    const live = ribbon.find((r) => r.state === 'now');
    const upcoming = ribbon.find((r) => r.state === 'next');
    const cancelled = ribbon.filter((r) => r.item.cancelled && r.state !== 'past');
    if (live) parts.push(`${live.item.title} is under way, ${live.minutesLeft} min left.`);
    else if (upcoming) parts.push(`Next up: ${upcoming.item.title} at ${hhmm(upcoming.item.start)}.`);
    if (cancelled.length) parts.push(`${cancelled.map((r) => r.item.title).join(' and ')} ${cancelled.length === 1 ? 'is' : 'are'} cancelled.`);
    if (cardsDue) parts.push(`${cardsDue} ${cardsDue === 1 ? 'card is' : 'cards are'} due.`);
    if (next?.due != null) parts.push(`${next.title} is ${next.due < now ? 'past its due date' : `due ${dueIn(next.due, now)}`}.`);
    return parts.length
      ? parts.join(' ')
      : 'Your schedule, assignments, study plan, cards and tutor in one calm place.';
  }, [ribbon, cardsDue, next, now]);

  return (
    <div className="b-sc" data-beta-tone="paper" data-screen-label={`Beta — School · ${current.label}`}>
      <header className="b-sc-hero">
        <section className="b-sc-day" data-beta-tone="ink" aria-label="School day">
          <div className="b-sc-day-top">
            {talk ? (
              <button type="button" className="b-sc-day-sphere" ref={setSphereEl} aria-label="Talk to Atlas" title="Talk to Atlas · ⌥ Space" onClick={() => openTalk()}>
                <VeilSphere ink bg="#1e1e24" count={3000} />
              </button>
            ) : (
              <div className="b-sc-day-sphere"><VeilSphere ink bg="#1e1e24" count={3000} /></div>
            )}
            <div className="b-sc-day-text">
              <span className="b-eyebrow b-eyebrow--onink">School · {longDate(now)}</span>
              <button type="button" className="b-sc-day-title" title={tab === 'today' ? 'Back to Home · Esc' : 'Back to Today · Esc'} onClick={() => (tab === 'today' ? navigate('/') : setTab('today'))}>
                {current.title}
              </button>
            </div>
            <span className="b-sc-day-clock">
              <span className="b-num">{hhmm(now)}</span>
              <small>{weekdayLong(now)} · week {isoWeek(now)}</small>
            </span>
          </div>
          <div className="b-sc-ribbon" aria-label="Today’s lessons and sessions">
            {ribbon.map((r) => (
              <div key={r.item.id} className={`b-sc-mod ${r.state}${r.item.cancelled ? ' cancelled' : ''}`}>
                <span className="b-sc-mod-fill" style={{ width: `${Math.round(r.fill * 100)}%` }} />
                <span className="b-sc-mod-time b-num"><i style={{ background: r.item.colour }} />{hhmm(r.item.start)}–{hhmm(r.item.end)}</span>
                <span className="b-sc-mod-name">{r.item.title}</span>
                <span className="b-sc-mod-sub">{r.item.cancelled ? 'Cancelled' : r.state === 'now' ? `Now · ${r.minutesLeft} min left` : r.item.done ? 'Done' : r.state === 'past' ? 'Over' : r.item.sub}</span>
              </div>
            ))}
            {!ribbon.length ? (
              <button type="button" className="b-sc-mod b-sc-mod--empty" onClick={() => setTab(sync.conn?.lectio ? 'schedule' : 'plan')}>
                <span className="b-sc-mod-name">{sync.conn?.lectio ? 'No lessons today' : 'Nothing planned today'}</span>
                <span className="b-sc-mod-sub">{sync.conn?.lectio ? 'Your lessons and the sessions you plan show here as the day runs. See the week →' : 'Sessions you plan, and your Lectio lessons once it is connected, show here. Plan one →'}</span>
              </button>
            ) : null}
          </div>
          <p className="b-sc-day-line">{subline}</p>
        </section>

        <div className="b-sc-hero-side">
          <button type="button" className="b-sc-next" onClick={() => (next ? openWork(next.key) : setTab('plan'))}>
            <span className="b-sc-next-head"><span>Next deadline</span><span>{next?.due != null ? (next.due < now ? 'overdue' : dueIn(next.due, now)) : ''}</span></span>
            <span className="b-sc-next-title">{next ? next.title : 'No deadlines'}</span>
            {nextSteps && nextSteps.length ? (
              <span className="b-sc-bar b-sc-bar--card"><span style={{ width: `${Math.round((nextDone / nextSteps.length) * 100)}%` }} /></span>
            ) : null}
            <span className="b-sc-next-sub">
              {!next ? 'Add what is due in Study plan, or connect LearnIT.' : nextSteps ? `${nextDone} of ${nextSteps.length} steps done` : [next.course, 'not prepared yet'].filter(Boolean).join(' · ')}
            </span>
          </button>
          <div className="b-sc-stats">
            <button type="button" className="b-sc-stat" onClick={() => setTab('cards')}><span>Cards due</span><b className="b-num">{cardsDue}</b></button>
            <button type="button" className="b-sc-stat" onClick={() => setTab('plan')}><span>This week</span><b className="b-num">{week.done}/{week.planned}</b></button>
            <button type="button" className="b-sc-stat" onClick={() => setTab('plan')}><span>Focus</span><b className={`b-num${focusRunning ? ' live' : ''}`}>{clock(left)}</b></button>
          </div>
        </div>
      </header>

      <nav className="b-sc-tabs nosb" role="tablist" aria-label="School">
        {SCHOOL_TABS.map((t) => (
          <button type="button" role="tab" key={t.key} aria-selected={tab === t.key} className={`b-sc-tab${tab === t.key ? ' on' : ''}${t.key === 'writing' ? ' b-sc-tab--tools' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'cards' && cardsDue ? <span className="b-sc-tab-n b-num">{cardsDue}</span> : null}
            {t.key === 'assignments' && freshWork ? <span className="b-sc-tab-n b-num" aria-label={`${freshWork} new`}>{freshWork}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'today' && sync.conn && !connected ? (
        <div className="b-sc-banner b-sc-banner--act">
          <p><b>No school is connected.</b> <span>Your schedule, assignments, messages, materials and grades come from Lectio and LearnIT once you link them. Atlas never sees your school password.</span></p>
          <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => setTab('school')}>Connect a school</button>
        </div>
      ) : null}
      {saveFailed ? (
        <p className="b-sc-banner b-sc-banner--err" role="alert">Changes can’t be saved on this Mac right now: storage is full or blocked. They last until Atlas closes.</p>
      ) : null}

      <div className="b-sc-view" key={tab}>
        {tab === 'today' ? <SchoolToday now={now} onTab={setTab} onOpen={openWork} /> : null}
        {tab === 'schedule' ? <SchoolSchedule now={now} onTab={setTab} /> : null}
        {tab === 'assignments' ? <SchoolAssignments now={now} openKey={openAssignment} onOpen={openWork} onTab={setTab} onToast={showToast} /> : null}
        {tab === 'plan' ? <SchoolPlan onToast={showToast} /> : null}
        {tab === 'cards' ? <SchoolCards onToast={showToast} /> : null}
        {tab === 'tutor' ? <SchoolTutor onToast={showToast} /> : null}
        {tab === 'grades' ? <SchoolGrades onTab={setTab} /> : null}
        {tab === 'exams' ? <SchoolExams now={now} onTab={setTab} onToast={showToast} /> : null}
        {tab === 'messages' ? <SchoolMessages now={now} onTab={setTab} /> : null}
        {tab === 'materials' ? <SchoolMaterials onTab={setTab} onToast={showToast} /> : null}
        {tab === 'writing' ? <SchoolWriting onToast={showToast} /> : null}
        {tab === 'sheet' ? <SchoolSheet onToast={showToast} /> : null}
        {tab === 'school' ? <SchoolConnect onToast={showToast} /> : null}
      </div>

      {toast ? (
        <div className="b-sc-toast" role="status">
          {toast.text}
          {toast.undo ? <button type="button" onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button> : null}
        </div>
      ) : null}
    </div>
  );
};

export default BetaSchool;
