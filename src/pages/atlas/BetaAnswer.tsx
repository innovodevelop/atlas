/**
 * The Beta Answer — `/answer` (Beta redesign phase 3, `Atlas Answer Views
 * Beta.dc.html`): one question, one answer, in a shape.
 *
 * The sphere thinks in the centre with the question under it, then moves to
 * the corner as the answer rises. The header carries the question and the
 * answer's first sentence; the body carries the answer composed from the
 * brain's markdown (the same parser the Workshop's Answer views use) with a
 * real strip above it where one exists: this Mac's forecast for a weather
 * question, the way to Money for a spending one. The design's other shapes
 * (departures, a comparison, a person) have no source behind them yet, so
 * they read as the composed answer rather than an invented layout.
 *
 * Opened from the Talk panel with its last answer (answerStore), or with a
 * question (`?q=` / router state) which it asks the brain itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWeather } from '@/hooks/useWeather';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AnswerGrid, SourceRow } from '@/components/atlas-ui/answerViews/AnswerBlocks';
import { parseAnswer, planCards } from '@/components/atlas-ui/answerViews/parseAnswer';
import { askAtlas } from '@/lib/askAtlas';
import type { BrainCitation } from '@/lib/brainSse';
import { setLastAnswer, useLastAnswer } from '@/lib/answerStore';
import { STEPS, classify, headlineOf, questionFrom } from '@/lib/betaAnswer';
import { isBetaUi } from '@/lib/betaFlag';
import { publishAtlasState } from '@/lib/atlasStateBus';
import { setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isRoutable } from '@/surfaces';
import { isTyping } from './atlasHelpers';
import '@/styles/surfaces/answerViews.css';

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
  const { w: vw, h: vh } = useViewport();
  const opened = useMemo(() => questionFrom(location.search, location.state), [location.search, location.state]);

  const [question, setQuestion] = useState<string | null>(opened ?? last?.question ?? null);
  const [text, setText] = useState(opened ? '' : last?.text ?? '');
  const [citations, setCitations] = useState<BrainCitation[]>(opened ? [] : last?.citations ?? []);
  const [phase, setPhase] = useState<'idle' | 'think' | 'answer'>(opened ? 'think' : last ? 'answer' : 'idle');
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const abort = useRef<AbortController | null>(null);
  const rest = useRef<number | null>(null);
  const sphereRef = useRef<HTMLDivElement | null>(null);

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
    setQuestion(asked);
    setPhase('think');
    setStep(0);
    setText('');
    setCitations([]);
    setError(null);
    setDraft('');
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
      if (result.text) setLastAnswer({ question: asked, text: result.text, citations: result.citations });
      else setError('Atlas did not find anything to say about that.');
      publishAtlasState('speaking', 'answer');
      rest.current = window.setTimeout(() => publishAtlasState('idle', 'answer'), SPEAK_HOLD_MS);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : 'Atlas did not answer.');
      setPhase('answer');
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
    else { setText(last.text); setCitations(last.citations); setPhase('answer'); }
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

      {!think && question ? (
        <>
          <header className="b-answer-head">
            <div className="b-answer-head-text">
              <span className="b-answer-asked">“{question}”</span>
              <h1 className="b-answer-h1">{headline || (error ? 'Atlas could not answer that.' : 'Atlas is answering…')}</h1>
            </div>
            {srcs.length ? (
              <span className="b-answer-srcs">{srcs.map((s) => <span className="b-answer-src" key={s.url}><i />{s.domain}</span>)}</span>
            ) : null}
          </header>
          <main className="b-answer-main nosb" key={question}>
            {error ? <p className="b-answer-err">{error}</p> : null}
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
            {parsed.blocks.length ? <section className="b-answer-body"><AnswerGrid cards={cards} ink={false} /></section> : null}
            {parsed.sources.length ? <section className="b-answer-sources" aria-label="Sources">{parsed.sources.map((s) => <SourceRow key={s.url} source={s} />)}</section> : null}
          </main>
        </>
      ) : null}

      {!think && !question ? (
        <div className="b-answer-empty">
          <h1>Ask Atlas something.</h1>
          <p>The answer takes the shape of the question: a forecast, a sum, a plain explanation.</p>
          <div className="b-answer-chips">{ASKS.map((q) => <button type="button" key={q} className="b-chip b-chip--card" onClick={() => void run(q)}>{q}</button>)}</div>
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
