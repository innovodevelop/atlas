/**
 * The Beta Voice — `/home` while the beta_ui flag is on (Beta redesign phase
 * 3, `Atlas Voice Beta.dc.html`): the sphere-led conversation surface.
 *
 * The band: the sphere (tap or Space to start a turn), the state chip, Back,
 * what you said, what Atlas said, one line about the state, the controls
 * (Start talking · Stop speaking · Mute · End session), and three asks when
 * resting. Below: this session's turns, typed input, and what went with the
 * last question.
 *
 * Everything comes from the voice session (`useVoiceSession`): the live
 * partial transcript is the "you" line while listening, `onFinalTranscript`
 * and `onTurnEnd` are the turns, `sendText` is the typed path (Atlas answers
 * out loud, as it would a spoken question). No second chat pipeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useAtlasSettings } from '@/hooks/useAtlasSettings';
import { useVoiceSession } from '@/hooks/useVoiceSession';
import { toVoiceSettings } from '@/lib/voiceTuning';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { STATE_COLOUR, onVoiceRequest, publishAtlasState, type AtlasBusState } from '@/lib/atlasStateBus';
import { setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isTyping } from './atlasHelpers';

interface Turn { id: number; who: 'You' | 'Atlas'; text: string; at: number; interrupted?: boolean }

const ASKS = [
  'What needs me today?',
  'Do I need an umbrella?',
  'What did I ask you last?',
];

const LINE: Record<string, [string, string]> = {
  idle: ['Resting', 'Say “Hey Atlas”, tap the sphere, or press Space'],
  listening: ['Listening', 'Speak naturally. Atlas waits for a real pause'],
  thinking: ['Thinking', 'The request has left this Mac'],
  speaking: ['Speaking', 'Tap the sphere or just talk to interrupt'],
  muted: ['Muted', 'The microphone is off. Nothing is being heard'],
};

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

const BetaVoice = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { settings } = useAtlasSettings();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [typed, setTyped] = useState('');
  const [started, setStarted] = useState<number | null>(null);
  const turnsRef = useRef<HTMLDivElement | null>(null);
  const sphereRef = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);

  useEffect(() => { if (!authLoading && !user) plainNavigate('/auth'); }, [user, authLoading, plainNavigate]);

  const push = useCallback((who: Turn['who'], text: string, interrupted = false) => {
    const t = text.trim();
    if (!t) return;
    setStarted((s) => s ?? Date.now());
    setTurns((cur) => [...cur, { id: ++seq.current, who, text: t, at: Date.now(), interrupted }]);
  }, []);

  const voice = useVoiceSession({
    voiceId: settings.voiceId,
    ttsModelId: settings.ttsModel,
    voiceSettings: toVoiceSettings(settings),
    onFinalTranscript: (text) => push('You', text),
    onTurnEnd: (spoken, interrupted) => push('Atlas', spoken, interrupted),
  });
  const { effectiveAtlasState, muted, toggleMute, handleManualActivate, cancel, sendText, partialTranscript, connected } = voice;
  const phase: AtlasBusState = muted ? 'muted' : effectiveAtlasState;

  // This screen owns the voice session while it is open: the sphere, the top
  // bar and the Talk panel's mic all follow it through the bus.
  useEffect(() => { publishAtlasState(phase, 'voice'); }, [phase]);
  useEffect(() => onVoiceRequest(handleManualActivate), [handleManualActivate]);
  useEffect(() => { setTalkAnchor(sphereRef.current); return () => setTalkAnchor(null); }, []);
  useEffect(() => () => { publishAtlasState('idle', 'voice'); }, []);

  useEffect(() => { if (turnsRef.current) turnsRef.current.scrollTop = turnsRef.current.scrollHeight; }, [turns.length]);

  const tap = useCallback(() => {
    if (muted) { toggleMute(); return; }
    if (effectiveAtlasState === 'speaking') { cancel(); return; }
    if (effectiveAtlasState === 'idle') handleManualActivate();
  }, [muted, toggleMute, effectiveAtlasState, cancel, handleManualActivate]);

  const say = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    push('You', t);
    sendText(t);
    setTyped('');
  }, [push, sendText]);

  const end = useCallback(() => {
    cancel();
    setTurns([]);
    setStarted(null);
  }, [cancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === 'Escape') navigate('/');
      else if (e.key === ' ') { e.preventDefault(); tap(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, tap]);

  const lastYou = useMemo(() => [...turns].reverse().find((t) => t.who === 'You')?.text ?? '', [turns]);
  const lastAtlas = useMemo(() => [...turns].reverse().find((t) => t.who === 'Atlas')?.text ?? '', [turns]);
  const youLine = effectiveAtlasState === 'listening' && partialTranscript ? partialTranscript : lastYou;
  const replyLine = lastAtlas || (turns.length ? '' : 'Ask me anything. I’ll answer out loud, here, on this Mac.');
  const [label, hint] = LINE[phase] ?? LINE.idle;
  const live = phase !== 'idle' && phase !== 'muted';
  const mins = started ? Math.max(1, Math.round((Date.now() - started) / 60000)) : 0;
  const sessionMeta = turns.length ? `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'} · ${mins} min` : connected ? 'Gateway ready' : 'Gateway connecting';
  const tapTitle = muted ? 'Unmute' : effectiveAtlasState === 'speaking' ? 'Stop speaking' : 'Talk to Atlas';

  return (
    <div className="b-voice" data-screen-label="Beta — Voice">
      <header className="b-band b-band--tall b-voice-band">
        <div className="b-band-sphere" ref={sphereRef}>
          <VeilSphere size="band" bg="#f1eeea" />
          <button type="button" className="b-stage-talk" title={tapTitle} aria-label={tapTitle} onClick={tap} />
        </div>
        <div className="b-voice-text">
          <div className="b-voice-top">
            <span className={`b-voice-chip${live ? ' live' : ''}`}><i style={{ background: STATE_COLOUR[phase] }} />{label}</span>
            <span className="b-voice-sp" />
            <button type="button" className="b-btn b-btn--card" title="Back — or press Esc" onClick={() => navigate('/')}><AtlasIcon name="chevron left" size={15} />Back<kbd>Esc</kbd></button>
          </div>
          <div className="b-voice-lines">
            <p className={`b-voice-you${youLine ? '' : ' empty'}`}>{youLine || (live ? '…' : '')}</p>
            <p className={`b-voice-reply${effectiveAtlasState === 'speaking' ? ' speaking' : ''}`}>{replyLine}</p>
            <p className="b-voice-hint">{hint}{!connected ? ' · voice gateway not connected' : ''}</p>
          </div>
          <div className="b-voice-controls">
            {phase === 'idle' ? <button type="button" className="b-btn b-btn--primary" onClick={handleManualActivate}><AtlasIcon name="mic" size={17} />Start talking</button> : null}
            {effectiveAtlasState === 'speaking' && !muted ? <button type="button" className="b-btn b-btn--ink" onClick={cancel}><AtlasIcon name="pause" size={17} />Stop speaking</button> : null}
            <button type="button" className={`b-btn ${muted ? 'b-btn--danger-fill' : 'b-btn--card b-btn--mute'}`} onClick={toggleMute}><AtlasIcon name="mic" size={17} />{muted ? 'Unmute' : 'Mute'}</button>
            {live || turns.length ? <button type="button" className="b-btn b-btn--card b-btn--danger" onClick={end}><AtlasIcon name="close" size={16} />End session</button> : null}
          </div>
          {phase === 'idle' ? (
            <div className="b-voice-asks">
              {ASKS.map((q) => <button type="button" key={q} className="b-chip b-chip--card" onClick={() => say(q)}>{q}</button>)}
            </div>
          ) : null}
        </div>
      </header>

      <div className="b-voice-body">
        <section className="b-voice-session" aria-label="This session">
          <div className="b-voice-session-head"><p className="b-card-title">This session</p><span className="b-num">{sessionMeta}</span></div>
          <div className="b-voice-turns nosb" ref={turnsRef}>
            {turns.map((t) => (
              <div key={t.id} className={`b-voice-turn${t.who === 'Atlas' ? ' atlas' : ''}`}>
                <span className="b-voice-turn-who">{t.who}</span>
                <p>{t.text}{t.interrupted ? ' …' : ''}</p>
                <span className="b-voice-turn-ts b-num">{TIME.format(new Date(t.at))}</span>
              </div>
            ))}
            {turns.length === 0 ? <div className="b-voice-none">Say “Hey Atlas”, tap the sphere, or pick a question to start.</div> : null}
          </div>
          <form className="b-voice-typed" onSubmit={(e) => { e.preventDefault(); say(typed); }}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type to Atlas…" aria-label="Type to Atlas" />
            <button type="submit" className={`b-btn b-btn--row${typed.trim() ? ' b-btn--primary' : ''}`} disabled={!typed.trim()}>Send</button>
          </form>
        </section>

        <aside className="b-voice-aside nosb">
          <div className="b-voice-card">
            <div className="b-voice-card-head"><p className="b-card-title">How a turn travels</p><p>What happens to your words on this screen.</p></div>
            <div className="b-voice-ctx"><span className="b-voice-tag">Mic</span><span>Heard on this Mac; the wake word runs on device</span></div>
            <div className="b-voice-ctx"><span className="b-voice-tag">Memory</span><span>The brain recalls what it knows about you, locally</span></div>
            <div className="b-voice-ctx"><span className="b-voice-tag">Model</span><span>The question goes to the reasoning model; the reply is spoken here</span></div>
            <p className="b-voice-route">Nothing is kept outside this Mac except the question itself. <button type="button" className="b-link" onClick={() => navigate('/atlas-architecture')}>How this works</button></p>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default BetaVoice;
