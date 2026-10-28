/**
 * The Beta Answer — `/answer` (Beta redesign phase 3, `Atlas Answer Views
 * Beta.dc.html`): one question, one answer, in a shape.
 *
 * The sphere thinks in the centre with the question under it, then moves to
 * the corner as the answer rises. The header carries the question and the
 * answer's first sentence; the body carries the answer composed from the
 * brain's markdown (the same parser the Workshop's Answer views use) with a
 * real strip above it where one exists: this Mac's forecast for a weather
 * question, the way to Money for a spending one, the person as this Mac's
 * mail and calendar know them (AnswerShapes.tsx; nothing is sent anywhere
 * for the card). A comparison is restated by the brain as strict JSON and
 * drawn as the design's table once it validates (betaAnswer.ts
 * `parseComparison`); when it does not, the composed answer stands. A travel
 * question gets Rejseplanen's live board (DeparturesBoard.tsx) — dormant
 * until the user adds an access ID, and then the board is the answer and the
 * brain is not asked.
 *
 * Opened from the Talk panel with its last answer (answerStore), with a
 * question (`?q=` / router state) which it asks the brain itself, or onto
 * the departures board alone (router state `{ departures: true }`, Home's
 * Transit widget). "Earlier conversations" sits under the answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWeather } from '@/hooks/useWeather';
import { useTransit } from '@/hooks/useTransit';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { AnswerGrid, SourceRow } from '@/components/atlas-ui/answerViews/AnswerBlocks';
import { parseAnswer, planCards } from '@/components/atlas-ui/answerViews/parseAnswer';
import { ComparisonView, PersonView } from '@/components/atlas/answer/AnswerShapes';
import { DeparturesBoard } from '@/components/atlas/answer/DeparturesBoard';
import { EarlierConversations } from '@/components/atlas/answer/EarlierConversations';
import { TransitKeyCard, TransitStopPicker } from '@/components/atlas/answer/TransitSetup';
import { askAtlas, currentTalkSession } from '@/lib/askAtlas';
import type { BrainCitation } from '@/lib/brainSse';
import { setLastAnswer, useLastAnswer } from '@/lib/answerStore';
import { fetchComparison, fetchPerson } from '@/lib/answerBrain';
import {
  STEPS, classify, departuresFrom, headlineOf, parseComparison, parsePersonCard, personFromQuestion, questionFrom,
  type Comparison, type PersonCard,
} from '@/lib/betaAnswer';
import { routeFromQuestion, transitPlan } from '@/lib/transit';
import { isBetaUi } from '@/lib/betaFlag';
import { publishAtlasState } from '@/lib/atlasStateBus';
import { setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isRoutable } from '@/surfaces';
import { isTyping } from './atlasHelpers';
import '@/styles/surfaces/answerViews.css';
import '@/styles/beta/answer.css';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree. `entry: 'none'`: reached from the Talk panel, never listed.
 */
export const surface = {
  path: '/answer',
  label: 'Answer',
  icon: 'Sparkles',
  entry: 'none' as const,
  mock: false,
  edition: 'consumer' as const,
};

const ASKS = ['Do I need an umbrella tomorrow?', 'What needs me today?', 'What did I spend on food this month?'];
const SPEAK_HOLD_MS = 3200;
const NO_ROUTE = { from: null, to: null } as const;

function useViewport() {
  const [v, setV] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const f = () => setV({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return v;
}

const BetaAnswer = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  const last = useLastAnswer();
  const { weather, isFallback } = useWeather();
  const transit = useTransit();
  const { w: vw, h: vh } = useViewport();
  const opened = useMemo(() => questionFrom(location.search, location.state), [location.search, location.state]);
  const [openedAt] = useState(() => Date.now());
  // Home's Transit widget opens the board alone; a question asked here
  // afterwards leaves that mode.
  const [boardOnly, setBoardOnly] = useState(() => !opened && departuresFrom(location.state));

  const [question, setQuestion] = useState<string | null>(boardOnly ? null : opened ?? last?.question ?? null);
  const [text, setText] = useState(opened || boardOnly ? '' : last?.text ?? '');
  const [citations, setCitations] = useState<BrainCitation[]>(opened || boardOnly ? [] : last?.citations ?? []);
  const [phase, setPhase] = useState<'idle' | 'think' | 'answer'>(boardOnly ? 'answer' : opened ? 'think' : last ? 'answer' : 'idle');
  /** The composed answer has finished arriving: what a comparison is restated from. */
  const [done, setDone] = useState(!opened && !boardOnly && !!last);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [fullAnswer, setFullAnswer] = useState(false);
  const [person, setPerson] = useState<PersonCard | null>(null);
  const [boardLine, setBoardLine] = useState('');
  const [picking, setPicking] = useState(false);
  /** A stop was chosen for this question, so the question's own "from" no longer overrides the saved stop. */
  const [pickedHere, setPickedHere] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const rest = useRef<number | null>(null);
  const sphereRef = useRef<HTMLDivElement | null>(null);
  // Read inside `run` without making it depend on every change of the store.
  const transitRef = useRef(transit);
  transitRef.current = transit;

  // Beta only: the Workshop UI goes back to its own Answer views, or Home.
  useEffect(() => { if (!isBetaUi()) plainNavigate(isRoutable('/answer-views') ? '/answer-views' : '/', { replace: true }); }, [plainNavigate]);
  useEffect(() => { if (!authLoading && !user) plainNavigate('/auth'); }, [user, authLoading, plainNavigate]);
  useEffect(() => { setTalkAnchor(sphereRef.current); return () => setTalkAnchor(null); }, []);
  useEffect(() => () => { abort.current?.abort(); if (rest.current) window.clearTimeout(rest.current); publishAtlasState('idle', 'answer'); }, []);

  const run = useCallback(async (q: string) => {
    const asked = q.trim();
    if (!asked) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    if (rest.current) window.clearTimeout(rest.current);
    setBoardOnly(false);
    setQuestion(asked);
    setStep(0);
    setText('');
    setCitations([]);
    setError(null);
    setDraft('');
    setDone(false);
    setComparison(null);
    setFullAnswer(false);
    setPerson(null);
    setBoardLine('');
    setPicking(false);
    setPickedHere(false);
    // With an access ID and a stop, Rejseplanen's board IS the answer: the
    // brain could only guess at a timetable it cannot see.
    const t = transitRef.current;
    if (classify(asked) === 'travel' && transitPlan(t.status, t.stop, routeFromQuestion(asked).from) === 'board') {
      setPhase('answer');
      setDone(true);
      publishAtlasState('idle', 'answer');
      return;
    }
    setPhase('think');
    publishAtlasState('thinking', 'answer');
    const stepTimer = window.setTimeout(() => setStep(1), 900);
    try {
      const result = await askAtlas(asked, {
        screen: 'Answer',
        signal: ctrl.signal,
        onText: (t) => { setText(t); setPhase('answer'); },
      });
      if (ctrl.signal.aborted) return;
      setText(result.text);
      setCitations(result.citations);
      setPhase('answer');
      setDone(true);
      if (result.text) setLastAnswer({ question: asked, text: result.text, citations: result.citations });
      else setError('Atlas did not find anything to say about that.');
      publishAtlasState('speaking', 'answer');
      rest.current = window.setTimeout(() => publishAtlasState('idle', 'answer'), SPEAK_HOLD_MS);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : 'Atlas did not answer.');
      setPhase('answer');
      setDone(true);
      publishAtlasState('alert', 'answer');
      rest.current = window.setTimeout(() => publishAtlasState('idle', 'answer'), SPEAK_HOLD_MS);
    } finally {
      window.clearTimeout(stepTimer);
    }
  }, []);

  // Opened with a question: ask it once, unless it is the one already answered.
  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (askedOnOpen.current || !opened) return;
    askedOnOpen.current = true;
    if (opened !== last?.question) void run(opened);
    else { setText(last.text); setCitations(last.citations); setPhase('answer'); setDone(true); }
  }, [opened, last, run]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === 'Escape') navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const shape = question ? classify(question) : 'explain';

  // Row 27: once the composed answer is in, the brain restates it as a
  // table. What comes back is validated against the question and the answer;
  // anything that fails keeps the composed answer on screen.
  useEffect(() => {
    if (!done || shape !== 'compare' || !question || !text.trim()) return;
    const ctrl = new AbortController();
    fetchComparison(question, text, ctrl.signal)
      .then((raw) => { if (!ctrl.signal.aborted) setComparison(parseComparison(raw, `${question}\n${text}`)); })
      .catch(() => { /* the composed answer stands */ });
    return () => ctrl.abort();
  }, [done, shape, question, text]);

  // Row 28: the person, from this Mac's mail and calendar. Asked alongside
  // the composed answer rather than after it: it needs no model.
  useEffect(() => {
    if (shape !== 'person' || !question) return;
    const name = personFromQuestion(question);
    if (!name) return;
    const ctrl = new AbortController();
    fetchPerson(name, ctrl.signal)
      .then((raw) => { if (!ctrl.signal.aborted) setPerson(parsePersonCard(raw)); })
      .catch(() => { /* no card; the composed answer stands */ });
    return () => ctrl.abort();
  }, [shape, question]);

  const parsed = useMemo(() => parseAnswer(text, citations), [text, citations]);
  const cards = useMemo(() => planCards(parsed.blocks), [parsed.blocks]);
  const headline = headlineOf(text);
  const srcs = parsed.sources.slice(0, 3);
  const think = phase === 'think';
  const size = Math.max(200, Math.round(Math.min(vh * 0.44, 460)));
  const k = Math.min(92, Math.max(64, vw * 0.07)) / size;
  const hours = shape === 'weather' ? weather.hourly.slice(0, 8) : [];
  const temps = hours.map((h) => h.temp);
  const lo = Math.min(...temps, 0), hi = Math.max(...temps, 1);

  const travel = boardOnly || shape === 'travel';
  const route = question && !boardOnly ? routeFromQuestion(question) : NO_ROUTE;
  const plan = travel ? transitPlan(transit.status, transit.stop, pickedHere ? null : route.from) : null;
  const showTable = shape === 'compare' && comparison !== null;
  const title = boardOnly
    ? boardLine || 'Departures'
    : headline || boardLine || (error ? 'Atlas could not answer that.' : 'Atlas is answering…');

  return (
    <div className={`b-answer b-answer--${think ? 'thinking' : 'answered'}`} data-screen-label="Beta — Answer">
      <div className="b-answer-sphere" ref={sphereRef} style={{ width: size, height: size, transform: think ? 'translate(-50%, -50%) scale(1)' : `translate(0, 0) scale(${k.toFixed(3)})` }}>
        <VeilSphere size="hero" bg="transparent" tone={[249, 247, 244]} alpha={0.62} scale={0.42} />
      </div>

      {think ? (
        <div className="b-answer-think">
          <p className="b-answer-q" key={question}>{question}</p>
          <p className="b-answer-step"><i />{STEPS[shape][step]}</p>
        </div>
      ) : null}

      {!think && (question || boardOnly) ? (
        <>
          <header className="b-answer-head">
            <div className="b-answer-head-text">
              <span className="b-answer-asked">{boardOnly ? 'Transit' : `“${question}”`}</span>
              <h1 className="b-answer-h1">{title}</h1>
            </div>
            {srcs.length ? (
              <span className="b-answer-srcs">{srcs.map((s) => <span className="b-answer-src" key={s.url}><i />{s.domain}</span>)}</span>
            ) : null}
          </header>
          <main className="b-answer-main nosb" key={question ?? 'departures'}>
            {error ? <p className="b-answer-err">{error}</p> : null}
            {plan === 'unavailable' ? <p className="b-answer-transit-solo">Live departures come from Rejseplanen, through the Atlas app on your Mac.</p> : null}
            {plan === 'needs-key' ? <TransitKeyCard transit={transit} /> : null}
            {plan === 'pick-stop' || (plan === 'board' && picking) ? (
              <TransitStopPicker
                transit={transit}
                initial={pickedHere ? null : route.from}
                onPicked={() => { setPicking(false); setPickedHere(true); }}
              />
            ) : null}
            {plan === 'board' && !picking && transit.stop ? (
              <DeparturesBoard transit={transit} stop={transit.stop} to={route.to} onHeadline={setBoardLine} onChangeStop={() => setPicking(true)} />
            ) : null}
            {shape === 'person' && person ? <PersonView card={person} onOpenMail={isRoutable('/mail') ? () => navigate('/mail') : undefined} /> : null}
            {showTable && comparison ? <ComparisonView comparison={comparison} /> : null}
            {shape === 'weather' ? (
              <section className="b-answer-hero" aria-label="Forecast">
                <div className="b-answer-hero-row">
                  <span className="b-answer-big">{Math.round(weather.temp)}°</span>
                  <span className="b-answer-lede">{weather.condition} in {weather.location}{isFallback ? ' — a sample until a reading arrives' : ''}. Sunrise {weather.sunrise}, sunset {weather.sunset}.</span>
                </div>
                {hours.length ? (
                  <div className="b-answer-hours">
                    {hours.map((h) => (
                      <span className="b-answer-hour" key={h.time} title={`${h.time} · ${Math.round(h.temp)}° · ${h.icon.replace(/-/g, ' ')}`}>
                        <small>{Math.round(h.temp)}°</small>
                        <b className={/rain|storm|drizzle|snow|shower/i.test(h.icon) ? 'hot' : ''} style={{ height: `${Math.max(8, Math.round(((h.temp - lo) / Math.max(1, hi - lo)) * 70) + 20)}%` }} />
                        <span>{h.time}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
            {shape === 'money' && isRoutable('/money') ? (
              <section className="b-answer-cards" aria-label="Money">
                <button type="button" className="b-answer-card hot" style={{ cursor: 'pointer', textAlign: 'left' }} onClick={() => navigate('/money')}>
                  <small>Money</small><b>Open your spending</b><span>Budgets, holdings and transactions live on the Money screen.</span>
                </button>
              </section>
            ) : null}
            {showTable && parsed.blocks.length ? (
              <button type="button" className="b-btn b-btn--card b-answer-more" aria-expanded={fullAnswer} onClick={() => setFullAnswer((v) => !v)}>
                <AtlasIcon name={fullAnswer ? 'chevron up' : 'chevron down'} size={14} />{fullAnswer ? 'Hide the full answer' : 'Read the full answer'}
              </button>
            ) : null}
            {parsed.blocks.length && (!showTable || fullAnswer) ? <section className="b-answer-body"><AnswerGrid cards={cards} ink={false} /></section> : null}
            {parsed.sources.length ? <section className="b-answer-sources" aria-label="Sources">{parsed.sources.map((s) => <SourceRow key={s.url} source={s} />)}</section> : null}
            {done ? <EarlierConversations openedAt={openedAt} current={currentTalkSession()} className="b-answer-earlier" /> : null}
          </main>
        </>
      ) : null}

      {!think && !question && !boardOnly ? (
        <div className="b-answer-empty">
          <h1>Ask Atlas something.</h1>
          <p>The answer takes the shape of the question: a forecast, a sum, a comparison, a person, the next departure.</p>
          <div className="b-answer-chips">{ASKS.map((q) => <button type="button" key={q} className="b-chip b-chip--card" onClick={() => void run(q)}>{q}</button>)}</div>
          <EarlierConversations openedAt={openedAt} current={currentTalkSession()} className="b-answer-earlier" />
        </div>
      ) : null}

      <form className="b-answer-ask" onSubmit={(e) => { e.preventDefault(); void run(draft); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={question ? 'Ask a follow-up…' : 'Ask Atlas…'} aria-label="Ask Atlas" />
        <button type="submit" className="b-btn b-btn--primary" disabled={!draft.trim() || think}>{think ? 'Thinking…' : 'Ask'}</button>
      </form>
    </div>
  );
};

export default BetaAnswer;
