/**
 * The Beta School — `/school` (Beta redesign phase 5, `Atlas School Beta.dc.html`
 * and `Atlas School Tools Beta.dc.html`). A new surface; there was no School
 * screen before it.
 *
 * The design is drawn around a school connection: the day's modules from
 * Lectio, assignments Atlas prepared, messages, materials, grades, exams.
 * Atlas has no connector for Lectio, LearnIT or itslearning, so none of those
 * are drawn as if they were here — "Your school" says what would arrive and
 * why it cannot yet. What is real is everything the student brings:
 *
 *   - Study plan: subjects, deadlines and sessions, with sessions spread
 *     before a deadline on request, and the focus timer;
 *   - Cards: spaced repetition (Again / Hard / Good / Easy) on cards they
 *     write or let Atlas draft from their notes;
 *   - Tutor: a Socratic tutor on the brain that asks and hints, three steps,
 *     and never writes the answer;
 *   - Writing and Spreadsheet (School Tools): their own documents with
 *     rewrites from the margin, and a small sheet with real formulas.
 *
 * The hero is the design's ink band: the sphere (this screen's talk entry
 * point), the clock, and the ribbon — today's study sessions from the plan,
 * the running one filling as it goes. All of it is kept on this Mac
 * (lib/betaSchoolStore.ts). Esc steps back to Today, then Home.
 *
 * School is a new surface, so it is routed whether or not the beta_ui flag is
 * on. Without the flag there is no Beta shell and so no Talk panel; the
 * sphere is then only the sphere, not a button that would open nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { SchoolCards } from '@/components/atlas/school/SchoolCards';
import { SchoolConnect } from '@/components/atlas/school/SchoolConnect';
import { SchoolPlan } from '@/components/atlas/school/SchoolPlan';
import { SchoolSheet } from '@/components/atlas/school/SchoolSheet';
import { SchoolToday } from '@/components/atlas/school/SchoolToday';
import { SchoolTutor } from '@/components/atlas/school/SchoolTutor';
import { SchoolWriting } from '@/components/atlas/school/SchoolWriting';
import { SCHOOL_TABS, tabFromHash, type SchoolTab } from '@/components/atlas/school/schoolTabs';
import { useNow } from '@/components/atlas/school/useSchoolHooks';
import {
  MIN, clock, deadlineProgress, dueCards, dueIn, focusLeft, hhmm, isoWeek, longDate, todayRibbon,
  upcomingDeadlines, weekStart, weekSummary, weekdayLong,
} from '@/lib/betaSchool';
import { flushSchool, useSchool, useSchoolSaveFailed } from '@/lib/betaSchoolStore';
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
  const saveFailed = useSchoolSaveFailed();
  const [tab, setTabState] = useState<SchoolTab>(() => tabFromHash(location.hash));
  const [sphereEl, setSphereEl] = useState<HTMLElement | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | null>(null);
  const focusRunning = school.focus.endsAt !== null;
  // Seconds only matter while the focus timer runs; the clock and the ribbon move by the minute.
  const now = useNow(focusRunning ? 1000 : 15_000);
  const talk = isBetaUi();

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
      if (tab !== 'today') setTab('today');
      else navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, setTab, navigate]);

  const subjectOf = useCallback((id: string | null) => (id ? school.subjects.find((s) => s.id === id) : undefined), [school.subjects]);
  const ribbon = useMemo(() => todayRibbon(school.sessions, now, 4), [school.sessions, now]);
  const cardsDue = useMemo(() => dueCards(school.cards, now).length, [school.cards, now]);
  const next = upcomingDeadlines(school.deadlines, 1)[0] ?? null;
  const nextProgress = next ? deadlineProgress(next, school.sessions) : null;
  const week = weekSummary(school.sessions, weekStart(now));
  const left = focusLeft(school.focus, now);
  const current = SCHOOL_TABS.find((t) => t.key === tab) ?? SCHOOL_TABS[0];

  const subline = useMemo(() => {
    const parts: string[] = [];
    const live = ribbon.find((r) => r.state === 'now');
    const upcoming = ribbon.find((r) => r.state === 'next');
    if (live) parts.push(`${live.session.title} is under way, ${live.minutesLeft} min left.`);
    else if (upcoming) parts.push(`Next up: ${upcoming.session.title} at ${hhmm(upcoming.session.start)}.`);
    if (cardsDue) parts.push(`${cardsDue} ${cardsDue === 1 ? 'card is' : 'cards are'} due.`);
    if (next) parts.push(`${next.title} is ${next.due < now ? 'overdue' : `due ${dueIn(next.due, now)}`}.`);
    return parts.length
      ? parts.join(' ')
      : 'Your study plan, flashcards, a tutor and your own documents, kept on this Mac. Start with a deadline or a card.';
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
          <div className="b-sc-ribbon" aria-label="Today’s sessions">
            {ribbon.map((r) => {
              const sub = subjectOf(r.session.subjectId);
              const end = r.session.start + r.session.minutes * MIN;
              return (
                <div key={r.session.id} className={`b-sc-mod ${r.state}`}>
                  <span className="b-sc-mod-fill" style={{ width: `${Math.round(r.fill * 100)}%` }} />
                  <span className="b-sc-mod-time b-num"><i style={{ background: sub?.colour ?? '#8fa9ff' }} />{hhmm(r.session.start)}–{hhmm(end)}</span>
                  <span className="b-sc-mod-name">{r.session.title}</span>
                  <span className="b-sc-mod-sub">{r.state === 'now' ? `Now · ${r.minutesLeft} min left` : r.session.done ? 'Done' : r.state === 'past' ? 'Over' : sub?.name ?? `${r.session.minutes} min`}</span>
                </div>
              );
            })}
            {!ribbon.length ? (
              <button type="button" className="b-sc-mod b-sc-mod--empty" onClick={() => setTab('plan')}>
                <span className="b-sc-mod-name">Nothing planned today</span>
                <span className="b-sc-mod-sub">Sessions you plan show here as the day runs. Plan one →</span>
              </button>
            ) : null}
          </div>
          <p className="b-sc-day-line">{subline}</p>
        </section>

        <div className="b-sc-hero-side">
          <button type="button" className="b-sc-next" onClick={() => setTab('plan')}>
            <span className="b-sc-next-head"><span>Next deadline</span><span>{next ? (next.due < now ? 'overdue' : dueIn(next.due, now)) : ''}</span></span>
            <span className="b-sc-next-title">{next ? next.title : 'No deadlines'}</span>
            {nextProgress && nextProgress.total ? (
              <span className="b-sc-bar b-sc-bar--card"><span style={{ width: `${Math.round((nextProgress.done / nextProgress.total) * 100)}%` }} /></span>
            ) : null}
            <span className="b-sc-next-sub">
              {!next ? 'Add what is due in Study plan.' : nextProgress && nextProgress.total ? `${nextProgress.done} of ${nextProgress.total} planned sessions done` : 'No sessions planned for it yet'}
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
          </button>
        ))}
      </nav>

      {tab === 'today' ? (
        <p className="b-sc-banner"><b>No school is connected.</b> <span>Schedule, assignments, messages, materials, grades and exams would come from Lectio, LearnIT or itslearning, and Atlas can’t connect to them yet. Everything here is yours, kept on this Mac.</span></p>
      ) : null}
      {saveFailed ? (
        <p className="b-sc-banner b-sc-banner--err" role="alert">Changes can’t be saved on this Mac right now: storage is full or blocked. They last until Atlas closes.</p>
      ) : null}

      <div className="b-sc-view" key={tab}>
        {tab === 'today' ? <SchoolToday now={now} onTab={setTab} /> : null}
        {tab === 'plan' ? <SchoolPlan onToast={showToast} /> : null}
        {tab === 'cards' ? <SchoolCards onToast={showToast} /> : null}
        {tab === 'tutor' ? <SchoolTutor onToast={showToast} /> : null}
        {tab === 'writing' ? <SchoolWriting onToast={showToast} /> : null}
        {tab === 'sheet' ? <SchoolSheet onToast={showToast} /> : null}
        {tab === 'school' ? <SchoolConnect /> : null}
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
