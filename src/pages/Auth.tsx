import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Eye, EyeOff, Loader2, Chrome, Github } from "lucide-react";
import { z } from "zod";

const authSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  displayName: z.string().optional(),
});

// Aurora auth screen (design: .overlay/.authwrap/.authcard). Real Supabase
// wiring via useAuth is preserved.
const Auth = () => {
  const navigate = useNavigate();
  const { signIn, signUp, isAuthenticated, loading } = useAuth();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isAuthenticated && !loading) navigate("/");
  }, [isAuthenticated, loading, navigate]);

  const validate = () => {
    try {
      authSchema.parse({ email, password, displayName });
      setErrors({});
      return true;
    } catch (err) {
      if (err instanceof z.ZodError) {
        const next: Record<string, string> = {};
        err.errors.forEach((e) => { if (e.path[0]) next[e.path[0] as string] = e.message; });
        setErrors(next);
      }
      return false;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      if (mode === "signin") await signIn(email, password);
      else await signUp(email, password, displayName);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="page fx ac jc" style={{ minHeight: "100vh" }}>
        <div className="auro" />
        <Loader2 className="animate-spin" style={{ width: 28, height: 28, color: "hsl(243 82% 80%)" }} />
      </div>
    );
  }

  const isSignup = mode === "signup";
  return (
    <div className="overlay" data-screen-label="Aurora — Auth">
      <div className="ovwash" />
      <div className="authwrap"><div className="authcol">
        <div className="authlogo">
          <div className="authmk">A</div>
          <div><h1 className="authname">Atlas</h1><p className="authtag">AI Assistant</p></div>
        </div>
        <div className="authcard">
          <div className="authseg">
            <button className={`segbtn ${!isSignup ? "on" : ""}`} onClick={() => setMode("signin")}>Sign In</button>
            <button className={`segbtn ${isSignup ? "on" : ""}`} onClick={() => setMode("signup")}>Sign Up</button>
          </div>
          <h2 className="authh">{isSignup ? "Create your account" : "Welcome back"}</h2>
          <p className="auths">{isSignup ? "Start your journey with Atlas" : "Sign in to access your assistant"}</p>

          <form onSubmit={handleSubmit}>
            {isSignup && (
              <div className="fld">
                <label className="lbl">Display Name</label>
                <input className="field" placeholder="How should Atlas call you?" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
            )}
            <div className="fld">
              <label className="lbl">Email</label>
              <input className="field" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              {errors.email && <p style={{ fontSize: 12, color: "hsl(350 75% 72%)", margin: "6px 0 0" }}>{errors.email}</p>}
            </div>
            <div className="fld">
              <label className="lbl">Password</label>
              <div className="pwwrap">
                <input className="field" type={showPassword ? "text" : "password"} placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} style={{ paddingRight: 42 }} />
                <button type="button" className="eye" onClick={() => setShowPassword((s) => !s)}>{showPassword ? <EyeOff className="i16" /> : <Eye className="i16" />}</button>
              </div>
              {errors.password && <p style={{ fontSize: 12, color: "hsl(350 75% 72%)", margin: "6px 0 0" }}>{errors.password}</p>}
            </div>
            <button className="authbtn" type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="i16 animate-spin" style={{ marginRight: 8, display: "inline", verticalAlign: -3 }} />}
              {isSignup ? "Create Account" : "Sign In"}
            </button>
          </form>

          <div className="ordiv">or</div>
          <div className="oauth">
            <button className="oauthbtn" type="button" disabled><Chrome className="i16" />Google</button>
            <button className="oauthbtn" type="button" disabled><Github className="i16" />GitHub</button>
          </div>
          <p className="authswap">
            {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
            <button className="linkA" onClick={() => setMode(isSignup ? "signin" : "signup")}>{isSignup ? "Sign in" : "Sign up"}</button>
          </p>
        </div>
        <p className="authterms">By continuing, you agree to our Terms of Service and Privacy Policy.</p>
      </div></div>
    </div>
  );
};

export default Auth;
