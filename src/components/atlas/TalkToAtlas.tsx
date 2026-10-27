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
 * Phase 2 adds the header-sphere mode: a screen that renders a band sphere
 * marks it as the talk entry point and this orb hides.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { VeilSphere } from './VeilSphere';
import { AtlasIcon } from './AtlasIcon';
import { screenLabel } from './TopBar';
import { STATE_COLOUR, hasVoiceOwner, publishAtlasState, requestVoice, useAtlasState, type AtlasBusState } from '@/lib/atlasStateBus';
import { askAtlas } from '@/lib/askAtlas';
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abort = useRef<AbortController | null>(null);
  const restTimer = useRef<number | null>(null);
  const screen = screenLabel(pathname);
  const canOpenAnswer = isRoutable('/answer-views');

  const clearRest = () => { if (restTimer.current) { window.clearTimeout(restTimer.current); restTimer.current = null; } };

  const show = useCallback(() => {
    setOpen(true);
    setSay('Go ahead, I’m listening.');
    setError(null);
    setAnswered(false);
    publishAtlasState('listening', SOURCE);
    window.setTimeout(() => inputRef.current?.focus(), 50);
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
      if (!result.text) setSay('I didn’t find anything to say about that.');
      setAnswered(!!result.text);
      restTimer.current = window.setTimeout(() => publishAtlasState('idle', SOURCE), SPEAK_HOLD_MS);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : 'Atlas did not answer.');
      publishAtlasState('alert', SOURCE);
      restTimer.current = window.setTimeout(() => publishAtlasState('idle', SOURCE), SPEAK_HOLD_MS);
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  }, [busy, screen]);

  // ⌥Space toggles; Esc closes (captured, so the page under it does not also
  // act on the same Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'Space') {
        e.preventDefault();
        if (open) hide(); else show();
      } else if (e.key === 'Escape' && open) {
        e.stopImmediatePropagation();
        e.preventDefault();
        hide();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, hide, show]);

  useEffect(() => () => { clearRest(); abort.current?.abort(); }, []);

  const colour = STATE_COLOUR[state];
  const tipOn = state !== 'idle' && !open;
  const micOwner = hasVoiceOwner();

  return (
    <>
      <button type="button" className="b-orb" aria-label="Talk to Atlas" aria-expanded={open} onClick={() => (open ? hide() : show())}>
        <VeilSphere size="orb" bg="transparent" tone={[249, 247, 244]} alpha={0.75} scale={0.44} />
      </button>
      <div className={`b-orb-tip${tipOn ? ' on' : ''}`} aria-hidden="true">
        <span className="b-orb-dot" style={{ background: colour }} />
        <span>{state === 'idle' ? 'Talk to Atlas' : STATE_TEXT[state] ?? state}</span>
        <kbd>⌥ Space</kbd>
      </div>

      {open ? (
        <div className="b-talk" role="dialog" aria-label="Talk to Atlas">
          <div className="b-talk-stage"><VeilSphere size="panel" ink bg="#1e1e24" /></div>
          <div className="b-talk-state">
            <span className="b-orb-dot" style={{ background: colour }} />
            <span>{STATE_TEXT[state] ?? state}</span>
          </div>
          <p className={`b-talk-say${error ? ' err' : ''}`}>{error ?? say}</p>
          {answered && canOpenAnswer ? (
            <button type="button" className="b-talk-link" onClick={() => { hide(); navigate('/answer-views'); }}>Open the full answer →</button>
          ) : null}
          {!busy && !answered ? (
            <div className="b-talk-chips">
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
              aria-label="Use the microphone"
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
        </div>
      ) : null}
    </>
  );
}
