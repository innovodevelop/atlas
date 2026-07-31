import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';
import { AuthSphere, type OrbState } from './AuthSphere';
import { readOnboarding } from '@/lib/atlasPermissions';

// Split conversational login (design "Atlas Login C1 - Split"): flat #3461f2
// scene, the Atlas Sphere on the right. Atlas talks on the left (typed word by
// word); the right shows the choice, then collects each credential ONE at a
// time — the conversational cadence of the design — before a final confirmation.
// Real Supabase auth (useAuth signIn/signUp) is preserved.

type Mode = 'signin' | 'signup';
type FieldKey = 'name' | 'email' | 'password';
type StepKind = 'start' | 'field' | 'done';

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
  const typer = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isAuthenticated || loading) return;
    // First run goes through consent before the dashboard: macOS used to fire
    // its permission prompts unannounced mid-launch, and a brand-new account
    // then landed on an empty dashboard with nothing to explain either.
    navigate(readOnboarding() ? '/' : '/permissions');
  }, [isAuthenticated, loading, navigate]);

  const typeMsg = useCallback((text: string) => {
    window.clearInterval(typer.current);
    const t = text.split(' ');
    setToks(t); setShown(0); setReady(false); setOrbState('speaking');
    let i = 0;
    typer.current = window.setInterval(() => {
      i++; setShown(i);
      if (i >= t.length) { window.clearInterval(typer.current); setReady(true); setOrbState('idle'); }
    }, 115);
  }, []);

  // focus the field once its prompt finishes typing
  useEffect(() => {
    if (ready && kind === 'field') inputRef.current?.focus();
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

  const pick = (m: Mode) => {
    setMode(m); setIdx(0); setKind('field'); setError(null);
    typeMsg(promptFor(m, SEQ[m][0], vals.name));
  };

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
    // last field → authenticate
    setSubmitting(true); setOrbState('thinking');
    try {
      if (mode === 'signin') await signIn(vals.email, vals.password);
      else await signUp(vals.email, vals.password, vals.name);
      setKind('done');
      typeMsg(`Good to see you, ${firstName(vals.name || vals.email)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work — try again.');
      setOrbState('idle');
    } finally {
      setSubmitting(false);
    }
  }, [idx, mode, seq, vals, signIn, signUp, typeMsg]);

  const back = () => {
    setKind('start'); setIdx(0); setError(null);
    typeMsg("Hey — I’m Atlas. Have we met before?");
  };

  if (loading) {
    return (
      <div className="ascene fx ac jc">
        <Loader2 className="animate-spin" style={{ width: 28, height: 28, color: '#fffdfa' }} />
      </div>
    );
  }

  const sub = kind === 'start' ? 'Tell me where to begin.'
    : kind === 'done' ? 'Everything is ready.'
      : 'Speak to me, or just type.';
  const hasVal = kind === 'field' && !!vals[fieldKey]?.trim();

  return (
    <div className="ascene" data-screen-label="Atlas — Login">
      <AuthSphere orbState={orbState} />
      <div className="avig" />
      <div className="ascrim" />
      <span className="alogo">atlas</span>

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
                  onChange={(e) => setVals((v) => ({ ...v, [fieldKey]: e.target.value }))}
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
                  <button type="button" className="aswap" onClick={back}>Start over</button>
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
