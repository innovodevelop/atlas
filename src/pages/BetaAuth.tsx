/**
 * The Beta sign-in — `/auth` while the beta_ui flag is on (Beta redesign
 * phase 7, `Atlas Entry Beta.dc.html`).
 *
 * The same conversation as the Workshop screen — "Have we met before?", then
 * one credential at a time, with forgot-password and its deliberately
 * ambiguous acknowledgement — on the Beta's two-column scene: the sphere on
 * Atlas Blue, Atlas's line typing in on paper. The calls are the real ones:
 * `useAuth().signIn / signUp` against the Cloudflare D1 account server and
 * `requestPasswordReset`, with their results inspected rather than assumed
 * (a refused credential stays on the step it was refused on, with the
 * password cleared and the email kept).
 *
 * What is deliberately NOT here: Atlas's voice. The Workshop greeting read
 * out loud was the most-complained-about thing on the old Entry, so the Beta
 * entry types and never speaks, and the design's "Voice on/off" pill goes
 * with it — a toggle for a sound that does not exist would be a control that
 * does nothing. Voice INPUT stays: the microphone in the answer pill is the
 * Workshop's `useLoginVoice`, with the same rule (never on the password
 * step; see `micAllowed`) and the same contract (a transcript fills the
 * field, the user still presses the button).
 *
 * The name a new account gives is kept in the local profile
 * (`entryProfile.ts`), so Home greets them by it; the Workshop dropped it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useLoginVoice } from '@/hooks/useLoginVoice';
import { requestPasswordReset } from '@/lib/authClient';
import { readOnboarding } from '@/lib/atlasPermissions';
import { emailFromSpeech } from '@/lib/loginSpeech';
import {
  FIELD_ORDER, GREETING, PLACEHOLDER, afterSignInPath, authEyebrow, authSphereState, authSubline, autocompleteFor,
  callName, enterLabel, fieldType, micAllowed, nextLabel, promptFor, spokenForAuthError, trailFor, validateField,
  type AuthStage, type EntryMode, type FieldKey,
} from '@/lib/betaEntry';
import { rememberName } from '@/lib/entryProfile';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { EntryScene } from '@/components/atlas/entry/EntryScene';
import { useTypewriter } from '@/components/atlas/entry/useTypewriter';
import { isTyping } from './atlas/atlasHelpers';
import '@/styles/beta/entry.css';

const BLANK: Record<FieldKey, string> = { name: '', email: '', password: '' };

/** Read at the moment of leaving: consent can have been answered in another window since mount. */
const onboarded = () => readOnboarding() !== null;

/**
 * The microphone with a line through it — the design's own glyph for the
 * password step. The icon set has no "mic off", and drawing it here keeps
 * the set the set rather than adding a name only this screen uses.
 */
const MicBlocked = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5.4a2.6 2.6 0 0 1-5.2 0V6.1A2.6 2.6 0 0 1 12 3.5zM18.1 11.5a6.1 6.1 0 0 1-12.2 0M12 17.6v3M4.4 4.4l15.2 15.2" />
  </svg>
);

const BetaAuth = () => {
  const navigate = useBetaNavigate();
  const { signIn, signUp, isAuthenticated, loading } = useAuth();
  const { shown, target, typing, say } = useTypewriter();

  const [stage, setStage] = useState<AuthStage>('start');
  const [mode, setMode] = useState<EntryMode | null>(null);
  const [key, setKey] = useState<FieldKey | null>(null);
  const [vals, setVals] = useState<Record<FieldKey, string>>(BLANK);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const enterRef = useRef<HTMLButtonElement | null>(null);

  // Atlas opens the conversation. `say` is stable, so this runs on mount —
  // and runs again cleanly if React ever replays the effect, because `say`
  // cancels whatever was being typed before it starts.
  useEffect(() => { say(GREETING); }, [say]);

  // Arrived here already signed in (a typed URL, a stale link): straight
  // through. Guarded to the opening step so the sign-in that is finishing
  // below gets to show its own "Welcome back" first.
  useEffect(() => {
    if (loading || !isAuthenticated || stage !== 'start' || submitting) return;
    navigate(afterSignInPath(onboarded()), { replace: true });
  }, [loading, isAuthenticated, stage, submitting, navigate]);

  // Focus the field once its question has finished typing, and the way in
  // once "Welcome back" has, so Enter carries on either way.
  useEffect(() => {
    if (typing) return;
    if (stage === 'field' || stage === 'forgot') inputRef.current?.focus();
    else if (stage === 'done') enterRef.current?.focus();
  }, [typing, stage, key]);

  /* ---- the microphone --------------------------------------------------- */

  const allowed = micAllowed(stage, key);
  // Assigned below, after the state it reads exists; held in a ref so the
  // hook's options keep a stable shape while this closure sees the current step.
  const heardRef = useRef<(text: string) => void>(() => {});
  const mic = useLoginVoice({ allowed, onTranscript: (t) => heardRef.current(t) });
  heardRef.current = (text: string) => {
    const heard = text.trim();
    if (!heard) return;
    const k: FieldKey | null = stage === 'forgot' ? 'email' : key;
    // Unreachable: the hook is gated on `allowed` and disconnects before the
    // password step renders. Kept as the last line of defence, because the
    // cost of the gate ever failing open is a password sent to a third-party
    // transcription service.
    if (!k || k === 'password') return;
    // Nothing here submits. A dictated answer fills the field and stops; a
    // transcript is a guess, and a guess must not create an account.
    setVals((v) => ({ ...v, [k]: k === 'email' ? emailFromSpeech(heard) : heard.replace(/[.,!?;:]+$/, '') }));
    setError('');
  };

  /* ---- the steps -------------------------------------------------------- */

  const ask = useCallback((m: EntryMode, k: FieldKey, name: string) => {
    setStage('field');
    setKey(k);
    setError('');
    say(promptFor(m, k, name));
  }, [say]);

  const choose = (m: EntryMode) => {
    setMode(m);
    ask(m, FIELD_ORDER[m][0], vals.name);
  };

  /**
   * Which conversation a pending request belongs to. "Start over" (or Esc)
   * stays available while the account server is answering, because a hung
   * request must not trap anyone on this screen; a late answer for a
   * conversation that has since restarted is then dropped rather than
   * dragging the screen back to a step the user left. (A late SUCCESS still
   * signs in — the session is stored by the client — and the opening step's
   * redirect takes it from there.)
   */
  const attempt = useRef(0);

  const restart = useCallback(() => {
    attempt.current += 1;
    setStage('start');
    setMode(null);
    setKey(null);
    setError('');
    setSubmitting(false);
    setVals(BLANK);
    say(GREETING);
  }, [say]);

  const startForgot = useCallback(() => {
    setStage('forgot');
    setKey('email');
    setError('');
    say('No problem. What’s the email on the account?');
  }, [say]);

  /**
   * A refused attempt. STAY ON THIS STEP: the email is kept and the password
   * cleared, because a wrong password is the overwhelmingly likely case and
   * retyping an address you got right is a punishment for the machine's
   * uncertainty. The line Atlas says never blames the user for our outage.
   */
  const refused = useCallback((message: string, m: EntryMode) => {
    setSubmitting(false);
    setError(message);
    setVals((v) => ({ ...v, password: '' }));
    say(spokenForAuthError(message, m));
  }, [say]);

  const next = useCallback(async () => {
    if (submitting || !key) return;
    const value = vals[key].trim();

    if (stage === 'forgot') {
      const bad = validateField('email', value, 'signin');
      if (bad) { setError(bad); return; }
      setSubmitting(true);
      setError('');
      const mine = attempt.current;
      // THE ACKNOWLEDGEMENT IS AMBIGUOUS ON PURPOSE: the server answers the
      // same whether or not the address has an account, so nobody can use
      // this box to discover who uses Atlas. The only error it ever carries
      // is a malformed address or an unreachable server.
      const { error: err } = await requestPasswordReset(value);
      if (mine !== attempt.current) return;
      setSubmitting(false);
      if (err) { setError(err); say('I couldn’t send that just now. Want to try again?'); return; }
      setStage('sent');
      setKey(null);
      say('If that address has an Atlas account, a link is on its way.');
      return;
    }

    if (!mode) return;
    const bad = validateField(key, value, mode);
    if (bad) { setError(bad); return; }
    const order = FIELD_ORDER[mode];
    const i = order.indexOf(key);
    if (i < order.length - 1) { ask(mode, order[i + 1], vals.name); return; }

    // Last field → authenticate. `signIn`/`signUp` resolve with `{ error }` on
    // a rejected credential — they do not throw — so the result is inspected
    // and the check fails closed: success requires a session, not merely the
    // absence of an error.
    setSubmitting(true);
    setError('');
    const mine = attempt.current;
    try {
      const res = mode === 'signin'
        ? await signIn(vals.email.trim(), vals.password)
        : await signUp(vals.email.trim(), vals.password, callName(vals.name));
      if (mine !== attempt.current) return;
      if (res?.error || !res?.data) { refused(res?.error ?? 'That didn’t work — try again.', mode); return; }
      setSubmitting(false);
      if (mode === 'signup') {
        const name = callName(vals.name);
        // Fire and forget: the account exists now, and a profile write that
        // fails (no desktop DB in the browser preview) costs only the
        // greeting, never the sign-up. See entryProfile.ts.
        void rememberName(res.data.userId, name);
        // A new account goes straight to consent, as the design does; the
        // name travels with it so the welcome can use it before the profile
        // write has landed.
        navigate('/permissions', { state: { firstName: name } });
        return;
      }
      setStage('done');
      setKey(null);
      say('Welcome back. Everything is where you left it.');
    } catch (e) {
      if (mine !== attempt.current) return;
      refused(e instanceof Error ? e.message : 'That didn’t work — try again.', mode);
    }
  }, [submitting, key, vals, stage, mode, ask, signIn, signUp, refused, navigate, say]);

  // Esc backs out of the conversation. In a field it only leaves the field;
  // on a question or the reset acknowledgement it starts over. Not on `done`:
  // that account is signed in, and "start over" would only bounce through
  // the opening step into the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      if (stage === 'field' || stage === 'forgot' || stage === 'sent') restart();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, restart]);

  /* ---- render ----------------------------------------------------------- */

  const inField = (stage === 'field' || stage === 'forgot') && key !== null;
  const micBlocked = stage === 'field' && key === 'password';
  const micOn = mic.state === 'listening';
  const micStarting = mic.state === 'starting';
  const signingUp = mode === 'signup' && stage === 'field';
  const current = key ? vals[key] : '';
  const hasValue = !!current.trim();
  const trail = mode && key ? trailFor(mode, key, vals) : [];
  const micLabel = micBlocked
    ? 'Microphone off while a password is on screen'
    : micOn ? 'Stop listening' : micStarting ? 'Cancel — stop turning the microphone on' : 'Let Atlas hear you';

  return (
    <EntryScene
      variant="auth"
      screenLabel={signingUp ? 'Atlas Sign up — Beta' : 'Atlas Login — Beta'}
      kicker={signingUp ? 'New here' : 'Sign in'}
      line="Speak to Atlas or type. Passwords are always typed, and the microphone switches off while one is on screen."
      sphereState={authSphereState(micOn, submitting)}
      eyebrow={authEyebrow(stage, mode)}
      said={shown}
      target={target}
      typing={typing}
      sub={authSubline(stage, micBlocked, mic.state)}
    >
      {stage === 'start' && !typing ? (
        <div className="b-en-choices b-en-pop">
          <button type="button" className="b-en-btn b-en-btn--ink" onClick={() => choose('signin')}>Yes, sign me in</button>
          <button type="button" className="b-en-btn b-en-btn--panel" onClick={() => choose('signup')}>No, I’m new</button>
        </div>
      ) : null}

      {inField && key ? (
        <div className="b-en-form b-en-pop">
          <div className={`b-en-pill${error ? ' err' : ''}`}>
            <input
              ref={inputRef}
              key={`${stage}-${mode ?? ''}-${key}`}
              className="b-en-input"
              type={fieldType(key)}
              value={current}
              placeholder={PLACEHOLDER[key]}
              aria-label={PLACEHOLDER[key]}
              aria-invalid={error ? true : undefined}
              autoComplete={autocompleteFor(key, mode ?? 'signin')}
              autoCapitalize={key === 'name' ? 'words' : 'none'}
              spellCheck={false}
              maxLength={key === 'name' ? 60 : undefined}
              onChange={(e) => { const v = e.target.value; setVals((prev) => ({ ...prev, [key]: v })); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void next(); }}
            />
            <button
              type="button"
              className={`b-en-mic${micBlocked ? ' blocked' : micOn ? ' live' : ''}`}
              disabled={micBlocked}
              aria-pressed={micOn}
              aria-label={micLabel}
              title={micLabel}
              onClick={() => { if (micOn || micStarting) mic.disable(); else void mic.enable(); }}
            >
              {micBlocked
                ? <MicBlocked />
                : <AtlasIcon name={micStarting ? 'loading' : 'mic'} size={18} weight={1.6} className={micStarting ? 'b-en-spin' : undefined} />}
            </button>
            <button type="button" className={`b-en-next${hasValue ? ' on' : ''}`} disabled={submitting} onClick={() => void next()}>
              {nextLabel(stage === 'forgot' ? 'forgot' : 'field', key, mode ?? 'signin', submitting)}
            </button>
          </div>
          {/* The in-progress guess, so the user can see they are being heard
              correctly before it lands in the field. Polite: scribe rewrites
              it several times a second. */}
          {micOn && mic.partial ? <p className="b-en-heard" aria-live="polite">{mic.partial}</p> : null}
          {error ? <p role="alert" className="b-en-error">{error}</p> : null}
          <div className="b-en-swaps">
            {/* Offered only where it can help: signing in, on the password
                step. On the email step there is nothing to have forgotten
                yet, and during sign-up there is no account to reset. */}
            {stage === 'field' && mode === 'signin' && key === 'password' && !submitting ? (
              <button type="button" className="b-en-swap" onClick={startForgot}>Forgot password?</button>
            ) : null}
            <button type="button" className="b-en-swap" onClick={restart}>{stage === 'forgot' ? 'Back to sign in' : 'Start over'}</button>
          </div>
          {trail.length ? (
            <div className="b-en-trail">
              {trail.map((t) => <span key={t.k} className="b-en-trail-chip"><span>{t.k}</span>{t.v}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}

      {stage === 'sent' ? (
        <div className="b-en-form b-en-pop">
          {/* No address echoed back: the server will not say whether an
              account exists, so neither does this. */}
          <p className="b-en-note">The link works once and expires in an hour. If nothing arrives, check spam — or try a different address.</p>
          <div className="b-en-choices">
            <button type="button" className="b-en-btn b-en-btn--panel b-en-btn--sm" onClick={restart}>Back to sign in</button>
          </div>
        </div>
      ) : null}

      {stage === 'done' && !typing ? (
        <div className="b-en-choices b-en-pop">
          <button ref={enterRef} type="button" className="b-en-btn b-en-btn--ink" onClick={() => navigate(afterSignInPath(onboarded()))}>
            {enterLabel(onboarded())}
          </button>
        </div>
      ) : null}
    </EntryScene>
  );
};

export default BetaAuth;
