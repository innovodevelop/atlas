// CF-backed auth client (Supabase-removal, Phase 6). Talks to the atlas-site
// Cloudflare account endpoints (/api/auth/{signup,login}, /api/me) and keeps the
// session in localStorage. Atlas itself stays 100% local — only auth + the
// entitlement check cross to the cloud; no app data ever does.
//
// The session is a plain object cached behind a stable reference so useAuth can
// drive it via useSyncExternalStore without re-render loops.

export interface Entitlement {
  plan: string;
  status: string;
  features: string[];
  expiresAt: string | null;
}

export interface AtlasSession {
  userId: string;
  email: string;
  token: string;
  entitlement: Entitlement | null;
}

const AUTH_BASE = (import.meta.env.VITE_AUTH_BASE ?? "https://atlas.innovo-studio.com").replace(/\/$/, "");
const KEY = "atlas.session";
const listeners = new Set<() => void>();

// Stable snapshot: return the same object reference until the stored JSON
// actually changes (required by useSyncExternalStore).
let cachedRaw: string | null = null;
let cached: AtlasSession | null = null;

export function getSession(): AtlasSession | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cached = raw ? (JSON.parse(raw) as AtlasSession) : null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

function store(session: AtlasSession | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode / quota — session just won't persist */
  }
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getToken(): string | null {
  return getSession()?.token ?? null;
}

export function hasFeature(feature: string): boolean {
  return getSession()?.entitlement?.features?.includes(feature) ?? false;
}

async function postAuth(
  path: string,
  body: unknown,
): Promise<{ error?: string; session?: AtlasSession }> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "Couldn't reach the account server. Check your connection." };
  }
  const data = (await res.json().catch(() => ({}))) as {
    userId?: string;
    email?: string;
    token?: string;
    entitlement?: Entitlement;
    error?: string;
  };
  if (!res.ok || !data.token || !data.userId) {
    return { error: data.error ?? "Authentication failed." };
  }
  const session: AtlasSession = {
    userId: data.userId,
    email: data.email ?? "",
    token: data.token,
    entitlement: data.entitlement ?? null,
  };
  store(session);
  return { session };
}

export function signIn(email: string, password: string) {
  return postAuth("/api/auth/login", { email, password });
}

export function signUp(email: string, password: string) {
  return postAuth("/api/auth/signup", { email, password });
}

export function signOut(): void {
  store(null);
}

/**
 * Refresh entitlement from /api/me. On an invalid/expired token, clears the
 * session (forces re-login). On a network error, keeps the cached entitlement
 * (offline grace) so Atlas keeps working without internet.
 */
export async function refreshEntitlement(): Promise<Entitlement | null> {
  const s = getSession();
  if (!s) return null;
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/api/me`, { headers: { authorization: `Bearer ${s.token}` } });
  } catch {
    return s.entitlement; // offline: trust the cached snapshot
  }
  if (res.status === 401) {
    store(null);
    return null;
  }
  if (!res.ok) return s.entitlement;
  const data = (await res.json().catch(() => null)) as
    | { plan: string; status: string; features: string[]; expiresAt: string | null }
    | null;
  if (!data) return s.entitlement;
  const entitlement: Entitlement = {
    plan: data.plan,
    status: data.status,
    features: data.features,
    expiresAt: data.expiresAt,
  };
  store({ ...s, entitlement });
  return entitlement;
}
