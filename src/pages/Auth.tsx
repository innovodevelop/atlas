import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2 } from 'lucide-react';
import { AuthSphere, type OrbState } from './AuthSphere';

// Split conversational login (design "Atlas Login C1 - Split"): flat #ff6a00
// scene, the Atlas Sphere on the right, a typed Atlas prompt on the left and
// choices / big-text credential inputs on the right. Real Supabase auth
// (useAuth signIn/signUp) is preserved — the conversational steps collect the
// email + password (and a name on sign-up).

type Step = 'start' | 'form';
type Mode = 'signin' | 'signup';

const Auth = () => {
  const navigate = useNavigate();
  const { signIn, signUp, isAuthenticated, loading } = useAuth();

  const [phase, setPhase] = useState<'intro' | 'chat'>('intro');
  const [step, setStep] = useState<Step>('start');
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const [toks, setToks] = useState<string[]>([]);
  const [shown, setShown] = useState(0);
  const [ready, setReady] = useState(false);
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (isAuthenticated && !loading) navigate('/');
  }, [isAuthenticated, loading, navigate]);

  const typeMsg = useCallback((text: string) => {
    window.clearInterval(typer.current);
    const t = text.split(' ');
    setToks(t); setShown(0); setReady(false); setOrbState('speaking');
    let i = 0;
    typer.current = window.setInterval(() => {
      i++; setShown(i);
      if (i >= t.length) { window.clearInterval(typer.current); setReady(true); setOrbState('idle'); }
    }, 120);
  }, []);

  useEffect(() => {
    const to = window.setTimeout(() => {
      setPhase('chat');
      typeMsg("Hey — I'm Atlas. Have we met before?");
    }, 900);
    return () => { window.clearTimeout(to); window.clearInterval(typer.current); };
  }, [typeMsg]);

  const pick = (m: Mode) => {
    setMode(m);
    setStep('form');
    typeMsg(m === 'signin' ? 'Welcome back. Let’s sign you in.' : 'Lovely. Let’s set you up.');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email || !password || (mode === 'signup' && !name)) {
      setError('Please fill in every field.');
      return;
    }
    setSubmitting(true);
    setOrbState('thinking');
    try {
      if (mode === 'signin') await signIn(email, password);
      else await signUp(email, password, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
      setOrbState('idle');
    }
  };

  if (loading) {
    return (
      <div className="ascene fx ac jc">
        <Loader2 className="animate-spin" style={{ width: 28, height: 28, color: '#fffdfa' }} />
      </div>
    );
  }

  const sub = step === 'start' ? 'Tell me where to begin.' : 'Speak to me, or just type.';

  return (
    <div className="ascene" data-screen-label="Atlas — Login">
      <AuthSphere orbState={orbState} />
      <div className="avig" />
      <div className="ascrim" />
      <span className="alogo">atlas</span>

      <div className="agrid">
        <div className="aleft">
          <p className="amsg">
            {toks.slice(0, shown).map((w, i) => <span key={i} className="awd">{w} </span>)}
            {phase === 'chat' && !ready && <span className="acaret" />}
          </p>
          <p className="asub">{ready ? sub : ''}</p>
        </div>

        <div className="aright">
          <div className={`aans${ready ? ' on' : ''}`}>
            {step === 'start' ? (
              <div className="achoices">
                <button className="achoice" onClick={() => pick('signin')}>Yes, we&rsquo;ve met before</button>
                <button className="achoice" onClick={() => pick('signup')}>No, we&rsquo;re just meeting</button>
              </div>
            ) : (
              <form className="aform" onSubmit={submit}>
                {mode === 'signup' && (
                  <input className="bigin" placeholder="your name" value={name}
                    onChange={(e) => setName(e.target.value)} autoFocus autoComplete="name" />
                )}
                <input className="bigin" type="email" placeholder="your email" value={email}
                  onChange={(e) => setEmail(e.target.value)} autoFocus={mode === 'signin'} autoComplete="email" />
                <input className="bigin" type="password" placeholder="your password" value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
                {error && <p className="aerr">{error}</p>}
                <div className="afoot">
                  <button className="aenter" type="submit" disabled={submitting}>
                    {submitting && <Loader2 className="i16 animate-spin" />}
                    {submitting ? 'One moment…' : 'Enter Atlas →'}
                  </button>
                  <button type="button" className="aswap" onClick={() => pick(mode === 'signin' ? 'signup' : 'signin')}>
                    {mode === 'signin' ? 'New here?' : 'Been here before?'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      <p className="aterms">By continuing, you agree to our Terms &amp; Privacy Policy.</p>
    </div>
  );
};

export default Auth;
