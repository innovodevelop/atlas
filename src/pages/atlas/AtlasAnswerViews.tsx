/**
 * Atlas — Answer views (`/answer-views`).
 *
 * The presentation layer for ONE chat turn: you ask, and the answer is laid out
 * as it arrives. Design reference: `Atlas Answer Views.dc.html`.
 *
 * WHAT IT IS BOUND TO. The live path is the app's real one — `useUnifiedChat`
 * → the brain sidecar's `/chat-with-memory` → the shared orchestrator in
 * `supabase/functions/_shared/orchestrator.ts` (legacy directory name; it is
 * runtime-neutral shared TS, not a Supabase dependency). That path emits
 * exactly two things to the webview:
 *
 *   1. OpenAI-shaped content deltas — the answer's markdown, streamed.
 *   2. An optional `{ citations: [...] }` SSE event written ahead of the
 *      stream, carrying whatever the tool loop collected.
 *
 * Everything on this screen is one of those two, or a client-side measurement
 * of them. In particular the "This turn" panel does NOT claim a model id, a
 * token count or a tool list: the orchestrator keeps those in `TurnCapture`,
 * the brain writes them to the local `chat_turns` table, and none of it is sent
 * to the webview. Saying so is the honest render — see the panel's own note.
 *
 * WHAT THE DESIGN ASKS FOR THAT THE APP CANNOT DO. The prototype composes an
 * answer out of dashboard widgets (`clock`, `agenda`, `wnow`, `port`… — a
 * 50-entry table) placed on one of eight random layouts. Nothing in the chat
 * payload plans widgets, and there is no widget registry to resolve such a plan
 * against. So the 12-column grid, the card geometry, the radii, the type and
 * the two skins are the design's; what fills the cards is the model's own text,
 * segmented by `parseAnswer`. That is the whole substitution, and it is why
 * there is no "Shuffle the answer" button: shuffling meant re-rolling fake
 * content, and there is no fake content here to re-roll.
 *
 * SPECIMENS. The brain is desktop-only (`getBrainEndpoint()` returns null in a
 * browser), so without a specimen mode this surface would be blank in every
 * environment where it is reviewed. `src/lib/mocks/answerViews.ts` holds sample
 * assistant turns — raw markdown, exactly what the stream would carry — run
 * through the same parser and the same renderers. Specimen mode is entered
 * explicitly and says so in the band, the status line and the rail.
 *
 * NAVIGATION. Per the app's pattern there is no back link in the header: the
 * headline itself is the control, plus Esc. With an answer showing, both return
 * to the ask state; from the ask state, both go to the dashboard.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, FileText, Gauge, LayoutGrid, Link2, Send, Sparkles, Trash2 } from 'lucide-react';
import { Button, Empty, Panel, Row } from '@/components/atlas-ui/primitives';
import { useUnifiedChat } from '@/hooks/useUnifiedChat';
import { getBrainEndpoint } from '@/lib/brainClient';
import { getToken } from '@/lib/authClient';
import { ANSWER_SPECIMENS, DEFAULT_SPECIMEN } from '@/lib/mocks/answerViews';
import {
  answerSubline, blockLabel, parseAnswer, planCards,
} from '@/components/atlas-ui/answerViews/parseAnswer';
import { AnswerGrid, AnswerReading, SourceRow } from '@/components/atlas-ui/answerViews/AnswerBlocks';
import '@/styles/surfaces/answerViews.css';

export const surface = {
  path: '/answer-views',
  label: 'Answer views',
  icon: 'Sparkles',
  entry: 'menu' as const,
  mock: true,
  edition: 'admin' as const,
};

type Availability = 'checking' | 'ready' | 'no-desktop' | 'signed-out';
type RunState = 'idle' | 'running' | 'done' | 'failed';
type ViewMode = 'composed' | 'reading';
type Skin = 'paper' | 'ink';

interface RunTiming {
  startedAt: number;
  firstTokenMs: number | null;
  elapsedMs: number | null;
}

const IDLE_TIMING: RunTiming = { startedAt: 0, firstTokenMs: null, elapsedMs: null };

const ms = (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`);

const AtlasAnswerViews = () => {
  const navigate = useNavigate();

  const [availability, setAvailability] = useState<Availability>('checking');
  const [mode, setMode] = useState<'live' | 'specimen'>('live');
  const [specimenId, setSpecimenId] = useState(DEFAULT_SPECIMEN);
  const [view, setView] = useState<ViewMode>('composed');
  const [skin, setSkin] = useState<Skin>('paper');
  const [draft, setDraft] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [runState, setRunState] = useState<RunState>('idle');
  const [timing, setTiming] = useState<RunTiming>(IDLE_TIMING);
  const inputRef = useRef<HTMLInputElement>(null);

  // The app's own chat path — same hook the dashboard talks through, so this
  // surface renders exactly what the product produces, not a parallel client.
  const { messages, isLoading, sendMessage, clearMessages } = useUnifiedChat({
    enableMemory: true,
    source: 'text_chat',
  });

  /**
   * Availability, checked once. Two structural failures are distinguishable
   * before a request is made — no sidecar (browser, or the process is down) and
   * no account token — and they need different copy, so they are separated
   * here rather than collapsed into one "something went wrong".
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = getToken();
      const brain = await getBrainEndpoint();
      if (cancelled) return;
      setAvailability(!brain ? 'no-desktop' : !token ? 'signed-out' : 'ready');
    })();
    return () => { cancelled = true; };
  }, []);

  const lastAssistant = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant') ?? null,
    [messages],
  );

  const specimen = useMemo(
    () => ANSWER_SPECIMENS.find((s) => s.id === specimenId) ?? ANSWER_SPECIMENS[0],
    [specimenId],
  );

  const isSpecimen = mode === 'specimen';
  const questionShown = isSpecimen ? specimen.question : asked;

  const parsed = useMemo(
    () => parseAnswer(
      isSpecimen ? specimen.markdown : (lastAssistant?.content ?? ''),
      isSpecimen ? specimen.citations : (lastAssistant?.citations ?? []),
    ),
    [isSpecimen, specimen, lastAssistant?.content, lastAssistant?.citations],
  );
  const cards = useMemo(() => planCards(parsed.blocks), [parsed.blocks]);
  const subline = useMemo(() => answerSubline(parsed.blocks), [parsed.blocks]);
  const hasAnswer = parsed.blocks.length > 0;

  // First-token latency, measured in the webview. It is the delay the user
  // actually experiences; it is not the server's TTFB and is not labelled as one.
  useEffect(() => {
    if (runState !== 'running' || !lastAssistant?.content) return;
    setTiming((t) => (t.firstTokenMs == null ? { ...t, firstTokenMs: performance.now() - t.startedAt } : t));
  }, [lastAssistant?.content, runState]);

  const ask = useCallback(async () => {
    const q = draft.trim();
    if (!q || availability !== 'ready' || isLoading) return;
    setMode('live');
    setAsked(q);
    setDraft('');
    setRunState('running');
    setTiming({ startedAt: performance.now(), firstTokenMs: null, elapsedMs: null });
    const result = await sendMessage(q);
    setTiming((t) => ({ ...t, elapsedMs: performance.now() - t.startedAt }));
    setRunState(result ? 'done' : 'failed');
  }, [draft, availability, isLoading, sendMessage]);

  const reset = useCallback(() => {
    clearMessages();
    setAsked(null);
    setRunState('idle');
    setTiming(IDLE_TIMING);
    setMode('live');
  }, [clearMessages]);

  /** The headline and Esc are the only way back — never a link in the header. */
  const back = useCallback(() => {
    if (hasAnswer || asked || isSpecimen) { reset(); return; }
    navigate('/');
  }, [hasAnswer, asked, isSpecimen, reset, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) { el?.blur(); return; }
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  const openSpecimens = useCallback(() => {
    setMode('specimen');
    setSpecimenId(DEFAULT_SPECIMEN);
  }, []);

  // --- band copy -----------------------------------------------------------

  const headline = hasAnswer && parsed.headline
    ? parsed.headline
    : { lead: 'Answer views', accent: '' };

  const bandSubline = hasAnswer
    ? subline
    : 'One chat turn, laid out as it arrives. Ask Atlas something — the answer is parsed into blocks and placed on the grid.';

  const statusLine = isSpecimen
    ? 'Specimen · not a live answer'
    : runState === 'running'
      ? (lastAssistant?.content ? 'Atlas is answering' : 'Composing the view…')
      : runState === 'failed'
        ? 'The turn returned nothing'
        : hasAnswer ? 'Answer ready' : 'Waiting for a question';

  const recipeLine = [
    view === 'composed' ? 'Composed' : 'Reading',
    skin,
    `${cards.length} block${cards.length === 1 ? '' : 's'}`,
    `${parsed.sources.length} source${parsed.sources.length === 1 ? '' : 's'}`,
  ].join(' · ');

  // --- the answer region ---------------------------------------------------

  let body: ReactNode;
  if (hasAnswer) {
    body = view === 'composed'
      ? <AnswerGrid cards={cards} ink={skin === 'ink'} />
      : <AnswerReading blocks={parsed.blocks} ink={skin === 'ink'} />;
  } else if (isSpecimen) {
    // The `empty` specimen exists precisely to render this: a generation that
    // closed with no content deltas.
    body = (
      <Empty
        size="block"
        icon={<Sparkles className="i20" />}
        title="The generation was empty"
        body="The stream closed without a single content delta. The chat hook substitutes its fallback line; there is nothing to lay out."
      />
    );
  } else if (availability === 'checking') {
    body = <Empty size="block" title="Looking for the brain" body="Asking the Rust core for the sidecar's port and token." />;
  } else if (availability === 'no-desktop') {
    body = (
      <Empty
        size="block"
        icon={<Sparkles className="i20" />}
        title="Atlas brain not reachable"
        body="Chat runs entirely on the local brain sidecar, which only exists inside the desktop app. There is no cloud endpoint to fall back to, so nothing can be asked from here."
        status="stale"
        action={{ label: 'Open a specimen instead', onClick: openSpecimens, variant: 'ghost' }}
      />
    );
  } else if (availability === 'signed-out') {
    body = (
      <Empty
        size="block"
        icon={<Sparkles className="i20" />}
        title="Sign in to ask"
        body="The brain wants an account token before it will answer. Entitlement lives on Cloudflare; the turn itself still runs locally."
        status="stale"
        action={{ label: 'Open a specimen instead', onClick: openSpecimens, variant: 'ghost' }}
      />
    );
  } else if (runState === 'failed') {
    body = (
      <Empty
        size="block"
        icon={<Sparkles className="i20" />}
        title="The turn returned nothing"
        body="The request was cancelled, or the gateway refused it. Rate limits, exhausted credits and gateway errors are reported as a toast by the chat hook — this screen only knows that no answer arrived."
        status="error"
        action={{ label: 'Ask again', onClick: () => inputRef.current?.focus(), variant: 'ghost' }}
      />
    );
  } else if (runState === 'running') {
    body = (
      <div className="av-pending" role="status" aria-live="polite">
        <span className="av-pending-bar" />
        <span className="av-pending-bar" />
        <span className="av-pending-bar" />
        <p className="av-pending-text">Waiting for the first token.</p>
      </div>
    );
  } else {
    body = (
      <Empty
        size="block"
        icon={<Sparkles className="i20" />}
        title="Nothing asked yet"
        body="Ask a question above and the answer is parsed as it streams: prose, lists, tables and code become cards, and anything the tool loop cited becomes a source."
        action={{ label: 'Or open a specimen', onClick: openSpecimens, variant: 'ghost' }}
      />
    );
  }

  const citationCount = parsed.sources.filter((s) => s.via === 'citation').length;
  const inlineCount = parsed.sources.filter((s) => s.via === 'inline').length;

  return (
    <div className="page av-page" data-screen-label="Atlas — Answer views">
      {/* The design's two wash layers, as static CSS. The prototype also mounts
          a sphere in the band; the renderer is mid-merge in another track, so
          this surface does not mount one rather than mounting the wrong one. */}
      <div className="av-wash" aria-hidden />
      <div className="grain" aria-hidden />

      <section className="bandB av-band">
        <div className="av-band-main">
          {questionShown && (
            <p className="av-ask-chip">
              <span className="av-ask-chip-k">{isSpecimen ? 'Specimen' : 'You asked'}</span>
              {questionShown}
            </p>
          )}
          <h2
            className="greetB returnable av-headline"
            onClick={back}
            title={hasAnswer || asked || isSpecimen ? 'Back to the question (Esc)' : 'Back to the dashboard (Esc)'}
          >
            {headline.lead}
            {headline.accent && <span className="accw">{headline.accent}</span>}
          </h2>
          {bandSubline && <p className="gsubB av-subline">{bandSubline}</p>}
        </div>

        <div className="bandmetaB av-band-meta">
          <p className={`av-status${runState === 'running' ? ' av-status--live' : ''}`}>
            <span className="av-status-dot" aria-hidden />
            {statusLine}
          </p>
          <p className="av-recipe tnum">{recipeLine}</p>
          <div className="av-dials">
            <button
              type="button"
              className="av-dial"
              onClick={() => setView((v) => (v === 'composed' ? 'reading' : 'composed'))}
            >
              <span className="av-dial-k">view</span>
              {view === 'composed' ? <LayoutGrid className="i14" /> : <FileText className="i14" />}
              {view === 'composed' ? 'Composed' : 'Reading'}
            </button>
            <button
              type="button"
              className="av-dial"
              onClick={() => setSkin((s) => (s === 'paper' ? 'ink' : 'paper'))}
            >
              <span className="av-dial-k">surface</span>
              {skin === 'paper' ? 'Paper' : 'Ink'}
            </button>
            <button
              type="button"
              className={`av-dial${isSpecimen ? ' av-dial--on' : ''}`}
              onClick={() => (isSpecimen ? reset() : openSpecimens())}
            >
              <span className="av-dial-k">source</span>
              <BookOpen className="i14" />
              {isSpecimen ? 'Specimen' : 'Live'}
            </button>
          </div>
        </div>
      </section>

      <section className="av-askrow">
        <div className="av-ask-field">
          <input
            ref={inputRef}
            className="av-ask-input"
            value={draft}
            placeholder={
              availability === 'ready'
                ? 'Ask Atlas something'
                : availability === 'checking' ? 'Looking for the brain…' : 'Asking needs the desktop app'
            }
            disabled={availability !== 'ready'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
          />
          <Button
            variant="ink"
            icon={<Send className="i16" />}
            onClick={() => void ask()}
            disabled={availability !== 'ready' || !draft.trim()}
            loading={isLoading}
          >
            Ask
          </Button>
          {(asked || isSpecimen) && (
            <Button variant="ghost" icon={<Trash2 className="i16" />} onClick={reset}>Clear</Button>
          )}
        </div>

        {isSpecimen && (
          <div className="av-specimens">
            {ANSWER_SPECIMENS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`av-specimen${s.id === specimenId ? ' av-specimen--on' : ''}`}
                onClick={() => setSpecimenId(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <main className="av-body">
        <div className="av-main">{body}</div>

        <aside className="av-rail">
          <Panel title="Sources" icon={<Link2 className="i16" />}>
            {parsed.sources.map((s) => <SourceRow key={s.url} source={s} />)}
            {parsed.sources.length === 0 && hasAnswer && (
              <Empty body="No sources. Either no search ran, or it ran and the answer cited nothing — the two look identical from here, because only the citations the tool loop collected reach the webview." />
            )}
            {parsed.sources.length === 0 && !hasAnswer && <Empty body="No answer yet." />}
          </Panel>

          <Panel title="This turn" icon={<Gauge className="i16" />}>
            {isSpecimen ? (
              <>
                <Row title="Shape" meta={specimen.label} />
                <Empty body={specimen.producedBy} />
                <Empty body="A specimen is markdown held in the repo. It has no timings, because nothing ran." status="stale" />
              </>
            ) : (
              <>
                <Row title="Words" meta="Answer text, markdown stripped" trail={<span className="tnum">{parsed.words}</span>} />
                <Row title="Blocks" meta="Parsed from the stream" trail={<span className="tnum">{parsed.blocks.length}</span>} />
                <Row title="Citations event" meta="Collected by the tool loop" trail={<span className="tnum">{citationCount}</span>} />
                <Row title="Links in the answer" meta="Written by the model itself" trail={<span className="tnum">{inlineCount}</span>} />
                <Row title="First token" meta="Measured in the webview" trail={<span className="tnum">{ms(timing.firstTokenMs)}</span>} />
                <Row title="Total" meta="Submit to stream close" trail={<span className="tnum">{ms(timing.elapsedMs)}</span>} />
                <Empty body="Which tools ran, which model answered and what the turn cost are not in this payload. The orchestrator keeps them in TurnCapture and the brain writes them to chat_turns; the stream carries content deltas and citations only." />
              </>
            )}
          </Panel>

          {hasAnswer && (
            <Panel title="Blocks" icon={<LayoutGrid className="i16" />}>
              {cards.map((c, i) => (
                <Row
                  key={i}
                  title={blockLabel(c.block)}
                  meta={c.block.kind}
                  trail={<span className="tnum">{c.cols}×{c.rows}</span>}
                  density="compact"
                />
              ))}
            </Panel>
          )}
        </aside>
      </main>
    </div>
  );
};

export default AtlasAnswerViews;
