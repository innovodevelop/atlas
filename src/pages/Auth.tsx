import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { requestPasswordReset } from '@/lib/authClient';
import { Loader2, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { AuthSphere, type OrbState } from '@/components/atlas-ui/AuthSphere';
import { readOnboarding } from '@/lib/atlasPermissions';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { useLoginVoice } from '@/hooks/useLoginVoice';
import { isVoiceOn, setVoiceOn as persistVoiceOn } from '@/lib/voicePreference';
import { emailFromSpeech, intentFromSpeech } from '@/lib/loginSpeech';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * `entry: 'none'`: you arrive here by being signed out, never by picking it
 * from a menu — the account menu's counterpart is "Sign out".
 */
export const surface = {
  path: '/auth',
  label: 'Sign in',
  icon: 'LogIn',
  entry: 'none' as const,
  mock: false,
  edition: 'consumer' as const,
};

// Split conversational login (design "Atlas Login C1 - Split"): flat #3461f2
// scene, the Atlas Sphere on the right. Atlas talks on the left (typed word by
// word); the right shows the choice, then collects each credential ONE at a
// time — the conversational cadence of the design — before a final confirmation.
// Real Supabase auth (useAuth signIn/signUp) is preserved.

type Mode = 'signin' | 'signup';
type FieldKey = 'name' | 'email' | 'password';
// `forgot` collects an address and asks for a reset link; `sent` is its
// deliberately ambiguous acknowledgement. Both are sign-in only — there is
// nothing to reset on an account that does not exist yet.
type StepKind = 'start' | 'field' | 'done' | 'forgot' | 'sent';

const SEQ: Record<Mode, FieldKey[]> = {
  signin: ['email', 'password'],
  signup: ['name', 'email', 'password'],
};

const firstName = (n: string) => n.trim().split(' ')[0] || 'friend';

// Legal pages live on the marketing site; open them in the system browser (the
// Tauri webview shouldn't navigate away from the app). Falls back to
// window.open when running as a plain web page (dev server).
const openLegal = async (e: React.MouseEvent, url: string) => {
  e.preventDefault();
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
};

function promptFor(mode: Mode, key: FieldKey, name: string): string {
  if (mode === 'signin') return key === 'email' ? 'Welcome back. What’s your email?' : 'And your password?';
  if (key === 'name') return 'Lovely. What should I call you?';
  if (key === 'email') return `Nice to meet you, ${firstName(name)}. What’s your email?`;
  return 'Now pick a password to keep it safe.';
}

const placeholderFor: Record<FieldKey, string> = {
  name: 'your name', email: 'your email', password: 'your password',
};


const Auth = () => {
  const navigate = useNavigate();
  const { signIn, signUp, isAuthenticated, loading } = useAuth();

  const [phase, setPhase] = useState<'intro' | 'chat'>('intro');
  const [kind, setKind] = useState<StepKind>('start');
  const [mode, setMode] = useState<Mode>('signin');
  const [idx, setIdx] = useState(0);
  const [vals, setVals] = useState<Record<FieldKey, string>>({ name: '', email: '', password: '' });

  const [toks, setToks] = useState<string[]>([]);
  const [shown, setShown] = useState(0);
  const [ready, setReady] = useState(false);
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The scene's colour. `warn` cross-fades the flat blue to amber over ~0.8s
   * (`.ascene.warn` in workshop.css).
   *
   * A refused sign-in is not an incidental event to be announced in the corner
   * of the screen and dismissed — on this surface it IS the state of the
   * conversation, so the surface says so and stays put. It also survives: a
   * toast is gone in four seconds, and someone who mistyped a password and
   * looked away has no way to know their attempt was rejected rather than
   * still running.
   */
  const [tone, setTone] = useState<'normal' | 'warn'>('normal');
  const typer = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Voice on the sign-in screen, persisted across launches.
   *
   * Default ON: Atlas is a voice-first product, and the first screen is exactly
   * where that should be true rather than promised. But it is a SETTING and not
   * a fact, because this screen also runs in shared offices and quiet rooms,
   * and a stranger's laptop announcing "And your password?" out loud is a good
   * way to make somebody close the app. The choice is remembered before there
   * is an account to remember it against, so it lives in localStorage rather
   * than in the profile.
   */
  const [voiceOn, setVoiceOn] = useState<boolean>(isVoiceOn);
  const { speak, stopPlayback, isPlaying } = useStreamingTTS();
  // The indirection that keeps `typeMsg` identity-stable — see its comment.
  const voiceRef = useRef<((text: string) => void) | null>(null);
  voiceRef.current = (text: string) => {
    if (!voiceOn) return;
    // Outside Tauri getVoiceEndpoint returns null and this is a no-op, so the
    // browser preview stays silent without a special case here.
    void speak(text).catch(() => { /* no gateway — the typed line still stands */ });
  };

  const toggleVoice = useCallback(() => {
    setVoiceOn((on) => {
      const next = !on;
      persistVoiceOn(next);
      // Silence takes effect NOW, not after the current sentence finishes —
      // somebody reaching for the mute button wants it quiet immediately.
      if (!next) stopPlayback();
      return next;
    });
  }, [stopPlayback]);

  /**
   * When Atlas last stopped talking.
   *
   * Both halves of the conversation now run through the same speakers and the
   * same room: the microphone hears the TTS. Without this, Atlas asking
   * "Welcome back. What's your email?" gets transcribed straight into the email
   * field. Browser echo cancellation is on (see useLoginVoice) but it is tuned
   * for a far-end talker on a call, not for the local process driving the
   * output — it does not reliably remove our own voice.
   *
   * So transcripts are dropped while TTS is playing and for a short tail after,
   * which covers the lag between the last audio frame and scribe committing the
   * sentence it built from it.
   */
  const quietSinceRef = useRef(0);
  useEffect(() => {
    if (!isPlaying) quietSinceRef.current = Date.now();
  }, [isPlaying]);
  const ECHO_TAIL_MS = 700;
  const atlasIsAudible = () => isPlaying || Date.now() - quietSinceRef.current < ECHO_TAIL_MS;

  useEffect(() => {
    if (!isAuthenticated || loading) return;
    // First run goes through consent before the dashboard: macOS used to fire
    // its permission prompts unannounced mid-launch, and a brand-new account
    // then landed on an empty dashboard with nothing to explain either.
    navigate(readOnboarding() ? '/' : '/permissions');
  }, [isAuthenticated, loading, navigate]);

  /**
   * Everything Atlas says on this screen goes through here — the opening
   * question, both credential prompts, the refusal, the reset step and the
   * welcome. So this is the one place speech has to be wired, and wiring it
   * anywhere else would have missed cases.
   *
   * IT USED TO SET `speaking` AND MAKE NO SOUND. The sphere animated as though
   * Atlas were talking, the subtitle read "Speak to me, or just type", and
   * nothing was ever said or heard: the screen promised a voice interface and
   * delivered a typewriter. Nothing technical was stopping it — the voice
   * gateway needs no session (voiceClient's getVoiceEndpoint only asks Rust for
   * a port and a gateway token), so TTS works perfectly well before anyone has
   * logged in. It was simply never connected.
   *
   * Read through a ref rather than taken as a dependency: this callback is a
   * dependency of the mount effect that starts the conversation, so letting its
   * identity change would restart the intro every time the player re-rendered.
   */
  const typeMsg = useCallback((text: string) => {
    window.clearInterval(typer.current);
    const t = text.split(' ');
    setToks(t); setShown(0); setReady(false); setOrbState('speaking');
    voiceRef.current?.(text);
    let i = 0;
    typer.current = window.setInterval(() => {
      i++; setShown(i);
      if (i >= t.length) { window.clearInterval(typer.current); setReady(true); setOrbState('idle'); }
    }, 115);
  }, []);

  // focus the field once its prompt finishes typing
  useEffect(() => {
    if (ready && (kind === 'field' || kind === 'forgot')) inputRef.current?.focus();
  }, [ready, kind, idx]);

  useEffect(() => {
    const to = window.setTimeout(() => {
      setPhase('chat');
      typeMsg("Hey — I’m Atlas. Have we met before?");
    }, 900);
    return () => { window.clearTimeout(to); window.clearInterval(typer.current); };
  }, [typeMsg]);

  const seq = SEQ[mode];
  const fieldKey = seq[idx];

  /**
   * THE RULE: never listen while a password is on screen.
   *
   * Transcription is not local — audio goes to ElevenLabs (see useLoginVoice).
   * Every other field here is an identifier the user is about to type in plain
   * sight anyway; the password is the one thing on this screen that must not
   * leave the machine as audio. `done` and `sent` are excluded too, for the
   * simpler reason that there is nothing left to answer.
   */
  const voiceInputAllowed =
    kind === 'start' || kind === 'forgot' || (kind === 'field' && fieldKey !== 'password');

  // Assigned below `pick`, which it calls. Held in a ref so the hook's options
  // can stay a stable shape while this closure sees the current step.
  const heardRef = useRef<(text: string) => void>(() => {});
  const {
    state: micState,
    partial: heardPartial,
    enable: enableMic,
    disable: disableMic,
  } = useLoginVoice({
    allowed: voiceInputAllowed,
    onTranscript: (t) => heardRef.current(t),
  });

  const pick = (m: Mode) => {
    setMode(m); setIdx(0); setKind('field'); setError(null); setTone('normal');
    typeMsg(promptFor(m, SEQ[m][0], vals.name));
  };

  /**
   * Route a completed utterance to whatever is on screen.
   *
   * Nothing here submits. A dictated answer fills the field and stops; the user
   * still presses Continue. Transcription is a guess, and a guess must not be
   * able to fire an account creation or a password-reset email on its own.
   */
  heardRef.current = (text: string) => {
    // Atlas's own voice, coming back through the microphone. Dropping it here
    // rather than in the hook keeps the hook's job to "capture audio" and this
    // screen's job to "decide what counts as an answer".
    if (atlasIsAudible()) return;
    const heard = text.trim();
    if (!heard) return;

    if (kind === 'start') {
      const m = intentFromSpeech(heard);
      // No guess, and deliberately no spoken re-prompt: Atlas answering out
      // loud here would be heard by the microphone that is still open and
      // start a conversation with itself.
      if (!m) { setError('I didn’t catch that — say yes or no, or tap a choice.'); return; }
      setError(null);
      pick(m);
      return;
    }

    const key = kind === 'forgot' ? 'email' : seq[idx];
    // Unreachable: the hook is gated on `voiceInputAllowed` and disconnects
    // before this step renders. Kept as the last line of defence, because the
    // cost of the gate ever failing open is a password read aloud to a
    // third-party transcription service.
    if (key === 'password') return;

    setVals((v) => ({
      ...v,
      [key]: key === 'email' ? emailFromSpeech(heard) : heard.replace(/[.,!?;:]+$/, ''),
    }));
    if (tone === 'warn') { setTone('normal'); setError(null); }
  };

  /**
   * A refused credential. STAY ON THIS STEP — the whole defect was moving on.
   *
   * The email is kept and the password cleared, because a wrong password is the
   * overwhelmingly likely case and retyping an address you got right is a
   * punishment for the machine's uncertainty. `idx` is untouched, so the field
   * on screen does not change under the user's hands.
   */
  const failed = useCallback((message: string, spoken?: string) => {
    setError(message);
    setTone('warn');
    setOrbState('idle');
    setVals((v) => ({ ...v, password: '' }));
    // `spoken` exists because the default sentence is about a REJECTED
    // CREDENTIAL, and the reset path reuses this handler for something else
    // entirely — a malformed address, or an account server that did not
    // answer. Saying "that didn't match what I have" when the truth is "I
    // couldn't reach the server" blames the user for our outage.
    typeMsg(spoken ?? 'That didn’t match what I have. Want to try again?');
  }, [typeMsg]);

  const advance = useCallback(async () => {
    const key = seq[idx];
    if (!vals[key].trim()) { setError('This one can’t be empty.'); return; }
    setError(null);
    if (idx < seq.length - 1) {
      const ni = idx + 1;
      setIdx(ni);
      typeMsg(promptFor(mode, seq[ni], vals.name));
      return;
    }
    // Last field → authenticate.
    //
    // THIS USED TO CLAIM SUCCESS UNCONDITIONALLY. `signIn`/`signUp` resolve with
    // `{ error }` on a rejected credential — they do not throw — so the `catch`
    // below could never fire for the failure that actually happens, and
    // `setKind('done')` ran on every attempt. A wrong password produced "Good to
    // see you", and "Enter Atlas →" then reloaded to `/`, which bounced straight
    // back here because no session had been stored: the sign-in appeared to
    // succeed and then silently restarted.
    //
    // So the result is now INSPECTED, and the check fails closed: `done`
    // requires a session object, not merely the absence of an error. An
    // unexpected shape from the account server has to read as "not signed in",
    // because the alternative is exactly the bug above.
    setSubmitting(true); setOrbState('thinking');
    try {
      const res = mode === 'signin'
        ? await signIn(vals.email, vals.password)
        : await signUp(vals.email, vals.password, vals.name);

      if (res?.error || !res?.data) {
        setSubmitting(false);
        // The server answers "Invalid email or password." for BOTH a wrong
        // address and a wrong password, deliberately — telling them apart is
        // how an attacker learns which emails have Atlas accounts (see
        // atlas-site functions/api/auth/login.ts, which also hashes on a
        // missing user so the timing cannot leak it either). So this screen
        // cannot say which one was wrong, and must not guess.
        failed(res?.error ?? 'That didn’t work — try again.');
        return;
      }

      setTone('normal');
      setKind('done');
      typeMsg(`Good to see you, ${firstName(vals.name || vals.email)}.`);
    } catch (err) {
      // Kept for a genuine throw (a bug in the client, not a rejected login).
      setSubmitting(false);
      failed(err instanceof Error ? err.message : 'That didn’t work — try again.');
      return;
    }
    setSubmitting(false);
  }, [idx, mode, seq, vals, signIn, signUp, typeMsg, failed]);

  /** Move to the reset step, carrying whatever email was already typed. */
  const startForgot = useCallback(() => {
    setKind('forgot');
    setError(null);
    setTone('normal');
    typeMsg('No problem. What’s the email on the account?');
  }, [typeMsg]);

  /**
   * Ask for a reset link.
   *
   * THE ACKNOWLEDGEMENT IS AMBIGUOUS ON PURPOSE, and it has to stay that way:
   * the server answers identically whether or not the address has an account,
   * precisely so nobody can use this box to discover who uses Atlas. If this
   * screen said "sent!" for a hit and "no such account" for a miss, it would
   * hand back exactly the oracle the endpoint refuses to be.
   */
  const sendReset = useCallback(async () => {
    if (!vals.email.trim()) { setError('This one can’t be empty.'); return; }
    setSubmitting(true);
    setOrbState('thinking');
    const { error: err } = await requestPasswordReset(vals.email.trim());
    setSubmitting(false);
    if (err) {
      // Only ever a malformed address or an unreachable server — never
      // "that account doesn't exist". The spoken line has to match: this is
      // not a rejected credential.
      failed(err, 'I couldn’t send that just now. Want to try again?');
      return;
    }
    setKind('sent');
    setOrbState('idle');
    typeMsg('If that address has an Atlas account, a link is on its way.');
  }, [vals.email, typeMsg, failed]);

  const back = () => {
    setKind('start'); setIdx(0); setError(null); setTone('normal');
    typeMsg("Hey — I’m Atlas. Have we met before?");
  };

  if (loading) {
    return (
      <div className="ascene fx ac jc">
        <Loader2 className="animate-spin" style={{ width: 28, height: 28, color: 'var(--surface)' }} />
      </div>
    );
  }

  /**
   * The subtitle is now a STATUS LINE, not a slogan.
   *
   * It used to read "Speak to me, or just type" on every step — including the
   * ones where nothing was listening, which is the promise this whole change
   * exists to stop making. Each branch below is a claim the code can back.
   */
  const sub = kind === 'done' ? 'Everything is ready.'
    : kind === 'sent' ? 'Check your inbox.'
      : micState === 'listening' ? 'I’m listening — or just type.'
        : micState === 'starting' ? 'One moment — turning the microphone on.'
          : micState === 'denied' ? 'No microphone, no problem. Typing works just as well.'
            // Distinct from `denied` on purpose: this one is OUR fault (no
            // sidecar, or the token mint failed), and saying "no problem" about
            // our own failure would be the app shrugging at its own bug.
            : micState === 'unavailable' ? 'I can’t hear you right now — please type instead.'
            // The password step: say why the microphone went quiet, at the exact
            // moment it does. Silence with no explanation reads as a fault.
            : !voiceInputAllowed ? 'Type this one — I stop listening for passwords.'
              : kind === 'start' ? 'Tell me where to begin.'
                : 'Type it, or tap the microphone.';
  const hasVal = kind === 'field' && !!vals[fieldKey]?.trim();

  const micLabel = !voiceInputAllowed
    ? 'Microphone off while a password is on screen'
    : micState === 'listening'
      ? 'Stop listening'
      : 'Let Atlas hear you';

  return (
    <div className={`ascene${tone === 'warn' ? ' warn' : ''}`} data-screen-label="Atlas — Login">
      <AuthSphere orbState={orbState} />
      <div className="avig" />
      <div className="ascrim" />
      <span className="alogo">atlas</span>
      {/* Sits beside the wordmark rather than in the answer column: it is a
          property of the whole screen, and it must stay reachable in every
          step — including the one where Atlas has just said your password
          prompt out loud in a room with other people in it. */}
      <button
        type="button"
        className="avoice"
        onClick={toggleVoice}
        aria-pressed={voiceOn}
        aria-label={voiceOn ? 'Turn Atlas\u2019s voice off' : 'Turn Atlas\u2019s voice on'}
        title={voiceOn ? 'Atlas is speaking \u2014 click to silence' : 'Atlas is silent \u2014 click to hear it'}
      >
        {voiceOn ? <Volume2 className="i16" /> : <VolumeX className="i16" />}
      </button>
      {/* Microphone consent, collected HERE rather than on the permissions
          screen that follows. It is asked for on a click, one sentence after
          Atlas has said out loud what it wants it for, and only on a screen
          where something immediately listens — which is the whole argument for
          moving it: an OS prompt you can connect to a thing that just happened
          is a different question from one that arrives unannounced.
          It goes hard-disabled on the password step; see `voiceInputAllowed`. */}
      <button
        type="button"
        className={`amic${micState === 'listening' ? ' live' : ''}`}
        onClick={() => { if (micState === 'listening') disableMic(); else void enableMic(); }}
        disabled={!voiceInputAllowed}
        aria-pressed={micState === 'listening'}
        aria-label={micLabel}
        title={micLabel}
      >
        {micState === 'starting'
          ? <Loader2 className="i16 animate-spin" />
          : micState === 'listening'
            ? <Mic className="i16" />
            : <MicOff className="i16" />}
      </button>

      <div className="agrid">
        <div className="aleft">
          {kind === 'field' && (
            <div className="adots" aria-hidden="true">
              {seq.map((k, i) => <span key={k} className={`adot${i <= idx ? ' on' : ''}`} />)}
            </div>
          )}
          <p className="amsg">
            {toks.slice(0, shown).map((w, i) => <span key={i} className="awd">{w} </span>)}
            {phase === 'chat' && !ready && <span className="acaret" />}
          </p>
          <p className="asub">{ready ? sub : ''}</p>
        </div>

        <div className="aright">
          <div className={`aans${ready ? ' on' : ''}`}>
            {/* The in-progress guess, shown so the user can see they are being
                heard correctly before it lands in a field. `aria-live` polite
                rather than assertive: scribe rewrites this several times a
                second, and an assertive region would make a screen reader
                stutter over every revision. */}
            {micState === 'listening' && (
              <p className="aheard" aria-live="polite">{heardPartial}</p>
            )}
            {kind === 'start' && (
              <div className="achoices">
                <button className="achoice" onClick={() => pick('signin')}
                  onMouseEnter={() => setOrbState('listening')} onMouseLeave={() => setOrbState('idle')}>
                  Yes, we&rsquo;ve met before
                </button>
                <button className="achoice" onClick={() => pick('signup')}
                  onMouseEnter={() => setOrbState('listening')} onMouseLeave={() => setOrbState('idle')}>
                  No, we&rsquo;re just meeting
                </button>
              </div>
            )}

            {kind === 'field' && (
              <div className="aform">
                <input
                  ref={inputRef}
                  key={`${mode}-${fieldKey}`}
                  className="bigin"
                  type={fieldKey === 'password' ? 'password' : fieldKey === 'email' ? 'email' : 'text'}
                  placeholder={placeholderFor[fieldKey]}
                  value={vals[fieldKey]}
                  onChange={(e) => {
                    setVals((v) => ({ ...v, [fieldKey]: e.target.value }));
                    // Typing is the retry. Drop the warning the moment it
                    // starts, so the amber describes the last ATTEMPT rather
                    // than becoming the permanent colour of the screen.
                    if (tone === 'warn') { setTone('normal'); setError(null); }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') advance(); }}
                  autoComplete={fieldKey === 'password' ? (mode === 'signin' ? 'current-password' : 'new-password') : fieldKey}
                />
                {error && <p className="aerr">{error}</p>}
                <div className="afoot">
                  {(hasVal || submitting) && (
                    <button className="aenter" onClick={advance} disabled={submitting}>
                      {submitting && <Loader2 className="i16 animate-spin" />}
                      {submitting ? 'One moment…' : idx < seq.length - 1 ? 'Continue →' : 'Enter Atlas →'}
                    </button>
                  )}
                  {/* Offered only where it can help: signing in, on the
                      password step. On the email step there is nothing to have
                      forgotten yet, and during sign-up there is no account to
                      reset. */}
                  {mode === 'signin' && fieldKey === 'password' && !submitting && (
                    <button type="button" className="aswap" onClick={startForgot}>Forgot password?</button>
                  )}
                  <button type="button" className="aswap" onClick={back}>Start over</button>
                </div>
              </div>
            )}

            {kind === 'forgot' && (
              <div className="aform">
                <input
                  ref={inputRef}
                  key="forgot-email"
                  className="bigin"
                  type="email"
                  placeholder="your email"
                  value={vals.email}
                  onChange={(e) => {
                    setVals((v) => ({ ...v, email: e.target.value }));
                    if (tone === 'warn') { setTone('normal'); setError(null); }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') sendReset(); }}
                  autoComplete="email"
                />
                {error && <p className="aerr">{error}</p>}
                <div className="afoot">
                  {(!!vals.email.trim() || submitting) && (
                    <button className="aenter" onClick={sendReset} disabled={submitting}>
                      {submitting && <Loader2 className="i16 animate-spin" />}
                      {submitting ? 'Sending…' : 'Send me a link →'}
                    </button>
                  )}
                  <button type="button" className="aswap" onClick={back}>Start over</button>
                </div>
              </div>
            )}

            {kind === 'sent' && (
              <div className="aform">
                {/* No "check your inbox!" flourish and no address echoed back.
                    The server will not say whether an account exists, so
                    neither does this. */}
                <p className="asub" style={{ margin: '0 0 18px' }}>
                  The link works once and expires in an hour. If nothing arrives, check spam — or try a different address.
                </p>
                <div className="afoot">
                  <button type="button" className="aswap" onClick={back}>Back to sign in</button>
                </div>
              </div>
            )}

            {kind === 'done' && (
              <a className="aenter" href="/">Enter Atlas →</a>
            )}
          </div>
        </div>
      </div>

      <p className="aterms">
        By continuing, you agree to our{' '}
        <a
          href="https://helloatlas.dk/terms"
          onClick={(e) => openLegal(e, 'https://helloatlas.dk/terms')}
          style={{ color: 'inherit', textDecoration: 'underline' }}
        >
          Terms
        </a>
        {' '}&amp;{' '}
        <a
          href="https://helloatlas.dk/privacy"
          onClick={(e) => openLegal(e, 'https://helloatlas.dk/privacy')}
          style={{ color: 'inherit', textDecoration: 'underline' }}
        >
          Privacy Policy
        </a>
        .
      </p>
    </div>
  );
};

export default Auth;
