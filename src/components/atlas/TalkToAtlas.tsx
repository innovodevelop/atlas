/**
 * Talk to Atlas — one consistent way to talk to Atlas on every screen
 * (handoff `atlas-orb.js`).
 *
 * A 128 px sphere sits bottom-left. Click it or press ⌥Space and a panel
 * opens: what Atlas is doing, its answer, three suggested asks, and a line to
 * type into. Esc closes. Typed questions go to the brain (`askAtlas`), and
 * the sphere's state follows the turn through the state bus, so the sphere
 * in the panel, the orb, the top bar and every other sphere agree.
 *
 * The microphone belongs to whichever screen owns the voice session (the
 * dashboard today); the mic button asks it to start a turn through the bus
 * and is disabled when nobody is listening for that.
 *
 * Header-sphere mode (handoff `atlas-orb.js`: "uses the page's header sphere
 * when there is one"): a screen that renders a band sphere registers it on the
 * talk bus, this orb hides, and the panel opens beside that sphere instead.
 * The same bus carries `openTalk(question)` from a screen's suggested asks.
 *
 * Keyboard and screen readers: the panel is a shell layer
 * (src/hooks/useShellLayer.ts). Opening it puts focus in the message field,
 * Tab stays inside while it is open, Esc closes it (and only it, when a status
 * panel is open underneath), and closing hands focus back to whatever opened
 * it. The streamed answer is not a live region, since a screen reader would
 * read it token by token; a hidden status line announces the finished answer,
 * or the error, once.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { VeilSphere } from './VeilSphere';
import { AtlasIcon } from './AtlasIcon';
import { screenLabel } from './TopBar';
import { useShellLayer } from '@/hooks/useShellLayer';
import { focusables } from '@/lib/shellLayers';
import { STATE_COLOUR, hasVoiceOwner, publishAtlasState, requestVoice, useAtlasState, type AtlasBusState } from '@/lib/atlasStateBus';
import { takeTalkRequest, useTalkAnchor, useTalkRequestTick } from '@/lib/talkBus';
import { askAtlas } from '@/lib/askAtlas';
import type { BrainCitation } from '@/lib/brainSse';
import { setLastAnswer } from '@/lib/answerStore';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isRoutable } from '@/surfaces';

const STATE_TEXT: Partial<Record<AtlasBusState, string>> = {
  idle: 'Atlas is here',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Atlas',
  working: 'Working on it…',
  success: 'Done',
  alert: 'Needs you',
  muted: 'Microphone off',
};

const SOURCE = 'talk';
const PANEL_ID = 'b-talk-panel';
const NOTHING = 'I didn’t find anything to say about that.';
/** How long the answer's `speaking` holds before the sphere rests. */
const SPEAK_HOLD_MS = 3600;

export function suggestionsFor(screen: string): string[] {
  return ['What needs me today?', 'Do I need an umbrella?', `Summarise ${screen.toLowerCase()}`];
}

export function TalkToAtlas() {
  const { pathname } = useLocation();
  const navigate = useBetaNavigate();
  const state = useAtlasState();
  const [open, setOpen] = useState(false);
  const [say, setSay] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  /** What a screen reader hears: the finished answer or the error, once. */
  const [announce, setAnnounce] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const openRef = useRef(false);
  const abort = useRef<AbortController | null>(null);
  /** The last complete answer, for the Answer screen. */
  const lastAnswer = useRef<{ question: string; text: string; citations: BrainCitation[] } | null>(null);
  const restTimer = useRef<number | null>(null);
  const screen = screenLabel(pathname);
  const canOpenAnswer = isRoutable('/answer');

  const clearRest = () => { if (restTimer.current) { window.clearTimeout(restTimer.current); restTimer.current = null; } };

  const show = useCallback(() => {
    // Already open (a screen's suggested ask): the layer does not re-run its
    // opening, so put the caret back in the field here.
    if (openRef.current) window.requestAnimationFrame(() => inputRef.current?.focus());
    setOpen(true);
    setSay('Go ahead, I’m listening.');
    setError(null);
    setAnswered(false);
    setAnnounce('');
    publishAtlasState('listening', SOURCE);
  }, []);

  const hide = useCallback(() => {
    setOpen(false);
    clearRest();
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    publishAtlasState('idle', SOURCE);
  }, []);

  const ask = useCallback(async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    clearRest();
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setDraft('');
    setError(null);
    setAnswered(false);
    setAnnounce('');
    setSay(`“${question}”`);
    setBusy(true);
    publishAtlasState('thinking', SOURCE);
    let spoke = false;
    try {
      const result = await askAtlas(question, {
        screen,
        signal: ctrl.signal,
        onText: (text) => {
          if (!spoke) { spoke = true; publishAtlasState('speaking', SOURCE); }
          setSay(text);
        },
      });
      if (ctrl.signal.aborted) return;
      if (!result.text) setSay(NOTHING);
      else lastAnswer.current = { question, text: result.text, citations: result.citations };
      setAnswered(!!result.text);
      setAnnounce(result.text || NOTHING);
      restTimer.current = window.setTimeout(() => publishAtlasState('idle', SOURCE), SPEAK_HOLD_MS);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const message = e instanceof Error ? e.message : 'Atlas did not answer.';
      setError(message);
      setAnnounce(message);
      publishAtlasState('alert', SOURCE);
      restTimer.current = window.setTimeout(() => publishAtlasState('idle', SOURCE), SPEAK_HOLD_MS);
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  }, [busy, screen]);

  useEffect(() => { openRef.current = open; }, [open]);

  // ⌥Space toggles, from anywhere. Esc belongs to the layer stack
  // (useShellLayer below), so it closes only the topmost layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== 'Space') return;
      e.preventDefault();
      if (openRef.current) hide(); else show();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hide, show]);

  useEffect(() => () => { clearRest(); abort.current?.abort(); }, []);

  // A screen asked for the panel (a suggested ask, the band's Join). The
  // request is taken once, so re-renders never repeat the question.
  const tick = useTalkRequestTick();
  useEffect(() => {
    if (!tick) return;
    const req = takeTalkRequest();
    if (!req) return;
    show();
    if (req.question) void ask(req.question);
  }, [tick, show, ask]);

  // Header-sphere mode: with an anchor on screen the orb hides and the panel
  // sits beside the anchor, clamped to the window.
  const anchor = useTalkAnchor();

  useShellLayer(open, {
    id: 'talk',
    ref: panelRef,
    onClose: hide,
    initialFocus: () => inputRef.current,
    // Back to whatever opened it; failing that (a mouse click in WebKit leaves
    // focus on <body>), the orb, or the button on the page's header sphere.
    returnFocus: (opener) => opener ?? orbRef.current ?? (anchor ? focusables(anchor)[0] ?? null : null),
  });

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor) { setPos(null); return; }
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const width = 336;
      const left = Math.max(16, Math.min(r.right + 14, window.innerWidth - width - 16));
      const top = Math.max(76, Math.min(r.top, window.innerHeight - 420));
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchor]);

  const colour = STATE_COLOUR[state];
  const tipOn = state !== 'idle' && !open;
  const micOwner = hasVoiceOwner();

  return (
    <>
      {!anchor ? (
        <>
          <button
            type="button"
            ref={orbRef}
            className="b-orb"
            aria-label="Talk to Atlas"
            aria-keyshortcuts="Alt+Space"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? PANEL_ID : undefined}
            onClick={() => (open ? hide() : show())}
          >
            <VeilSphere size="orb" bg="transparent" tone={[249, 247, 244]} alpha={0.75} scale={0.44} />
          </button>
          <div className={`b-orb-tip${tipOn ? ' on' : ''}`} aria-hidden="true">
            <span className="b-orb-dot" style={{ background: colour }} />
            <span>{state === 'idle' ? 'Talk to Atlas' : STATE_TEXT[state] ?? state}</span>
            <kbd>⌥ Space</kbd>
          </div>
        </>
      ) : null}

      {open ? (
        <div
          ref={panelRef}
          id={PANEL_ID}
          className={`b-talk${pos ? ' b-talk--anchored' : ''}`}
          style={pos ?? undefined}
          role="dialog"
          aria-modal="true"
          aria-label="Talk to Atlas"
        >
          <div className="b-talk-stage"><VeilSphere size="panel" ink bg="#1e1e24" /></div>
          <div className="b-talk-state">
            <span className="b-orb-dot" style={{ background: colour }} aria-hidden="true" />
            <span>{STATE_TEXT[state] ?? state}</span>
          </div>
          <p className={`b-talk-say${error ? ' err' : ''}`}>{error ?? say}</p>
          {answered && canOpenAnswer ? (
            <button type="button" className="b-talk-link" onClick={() => { if (lastAnswer.current) setLastAnswer(lastAnswer.current); hide(); navigate('/answer'); }}>Open the full answer →</button>
          ) : null}
          {!busy && !answered ? (
            <div className="b-talk-chips" role="group" aria-label="Suggested questions">
              {suggestionsFor(screen).map((q) => (
                <button type="button" key={q} className="b-talk-chip" onClick={() => void ask(q)}>{q}</button>
              ))}
            </div>
          ) : null}
          <div className="b-talk-row">
            <input
              ref={inputRef}
              className="b-talk-in"
              placeholder="Say it, or type to Atlas"
              aria-label="Message Atlas"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); if (!busy) publishAtlasState('listening', SOURCE); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void ask(draft); }}
            />
            <button
              type="button"
              className="b-talk-mic"
              aria-label={micOwner ? 'Talk out loud' : 'Microphone: open Home to use it'}
              title={micOwner ? 'Talk out loud' : 'Open Home to use the microphone'}
              disabled={!micOwner}
              onClick={() => { if (requestVoice()) hide(); }}
            >
              <AtlasIcon name="mic" size={18} />
            </button>
            <button type="button" className="b-talk-go" aria-label="Send" onClick={() => void ask(draft)} disabled={busy}>
              <AtlasIcon name="send" size={16} />
            </button>
          </div>
          <p className="b-sr-only" role="status" aria-atomic="true">{announce}</p>
        </div>
      ) : null}
    </>
  );
}
