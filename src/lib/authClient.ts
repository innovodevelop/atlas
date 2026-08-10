// CF-backed auth client (Supabase-removal, Phase 6). Talks to the atlas-site
// Cloudflare account endpoints (/api/auth/{signup,login}, /api/me) and keeps the
// session in localStorage. Atlas itself stays 100% local — only auth + the
// entitlement check cross to the cloud; no app data ever does.
//
// The session is a plain object cached behind a stable reference so useAuth can
// drive it via useSyncExternalStore without re-render loops.

import { toast } from "sonner";
import { clearPersistedCache } from "@/lib/queryClient";

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

const AUTH_BASE = (import.meta.env.VITE_AUTH_BASE ?? "https://helloatlas.dk").replace(/\/$/, "");
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

/**
 * Ask for a password-reset link.
 *
 * DELIBERATELY NOT `postAuth`: that helper treats a response without a token as
 * a failure, which is right for sign-in and wrong here — this endpoint never
 * returns a session, and its whole design is to answer identically whether or
 * not the address has an account (see atlas-site functions/api/auth/forgot.ts).
 * Routing it through postAuth would turn every successful request into
 * "Authentication failed."
 *
 * Resolves `{}` on success. The caller must NOT report whether an account was
 * found, because this function cannot know and the server will not say.
 */
export async function requestPasswordReset(email: string): Promise<{ error?: string }> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/api/auth/forgot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch {
    return { error: "Couldn't reach the account server. Check your connection." };
  }
  if (res.ok) return {};
  // The only non-200 that carries meaning is a malformed address — a fact
  // about the typed string, not about who has an account.
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { error: data.error ?? "Couldn't send a reset link just now." };
}

/**
 * The one teardown for "this session is over" — sign-out, expired token, or a
 * deleted account. Drops the session AND the persisted react-query cache, which
 * holds account-scoped snapshots (profile, tasks, notes, calendar). Clearing
 * only the session would leave that data sitting readable in localStorage.
 */
function endSession(): void {
  store(null);
  clearPersistedCache();
}

export function signOut(): void {
  endSession();
}

// macOS app-data directory (Tauri `app_data_dir` for identifier
// com.magnuspilegaard.atlas) — the one route to the local corpus that doesn't
// need a session.
export const LOCAL_DATA_DIR = "~/Library/Application Support/com.magnuspilegaard.atlas";

/**
 * Told the account is gone while we were signed in — deleted from another
 * device, or by calling POST /api/account/delete directly as the privacy policy
 * (§9) invites. That signs the user out permanently (there is no row left to
 * sign back in to), and Settings → Memory & Privacy is the only in-app control
 * that can erase the local corpus, so it becomes unreachable.
 *
 * We deliberately do NOT erase local data here. The user consented to deleting
 * an account, not to destroying everything Atlas knows, and the policy promises
 * account deletion "does not touch the data on your device". Losing the ability
 * to erase from inside the app is recoverable — the data folder is right there;
 * an unasked-for wipe is not. So the honest move is to say, at that exact
 * moment, where the data lives. The toast never auto-dismisses: it is the last
 * chance to see this.
 */
function notifyAccountGone(): void {
  toast.warning("Your Atlas account no longer exists", {
    description:
      `You've been signed out and can't sign in again. The data on this Mac was not touched — ` +
      `to erase it, delete the folder ${LOCAL_DATA_DIR}.`,
    duration: Infinity,
    closeButton: true,
  });
}

// Only the API answers JSON; a 404 served as HTML is a missing route (bad
// deploy), not a deleted account, and must never be acted on as one.
const isJsonResponse = (res: Response): boolean =>
  res.headers.get("content-type")?.includes("json") ?? false;

/**
 * Refresh entitlement from /api/me. On an invalid/expired token (401) or a
 * deleted account (404), clears the session (forces re-login). On a network
 * error, keeps the cached entitlement (offline grace) so Atlas keeps working
 * without internet; other server errors (5xx) keep it too, so an outage never
 * signs anyone out.
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
  // 404 = the user row is gone (account deleted elsewhere). Terminal like 401:
  // keeping the cached entitlement would leave a deleted account fully unlocked.
  if (res.status === 401 || (res.status === 404 && isJsonResponse(res))) {
    const accountGone = res.status === 404;
    endSession();
    if (accountGone) notifyAccountGone();
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
  // The session can have died while this request was in flight (sign-out,
  // account deletion, a 401 from another call). Writing the snapshot we started
  // with would resurrect it, so only store if we're still the current session.
  if (getSession() !== s) return entitlement;
  store({ ...s, entitlement });
  return entitlement;
}

// A cross-internet POST behind a captive portal can hang until the OS gives up
// (minutes), leaving the caller's "deleting…" spinner running with no way out.
// 20s is generous for a single D1 delete and still short enough to be an answer.
const ACCOUNT_DELETE_TIMEOUT_MS = 20_000;

/**
 * Permanently deletes the server-side account via POST /api/account/delete
 * (GDPR Art. 17) and ends the local session. Only the cloud slice — the D1 user
 * row, its waitlist entry and throttle key — is erased; everything Atlas knows
 * lives on this Mac and stays there, which is what privacy §9 / terms §8
 * promise. Erasing the local corpus is a separate, opt-in step the caller runs
 * afterwards.
 * A 404 means the row is already gone, which is the state the user asked for,
 * so it counts as deleted rather than as a failure.
 * `signedOut` tells the caller the session was torn down on a failure path (a
 * dead token), which changes what the user has to be told: the account is still
 * there, but this screen is now behind a fresh sign-in.
 */
export async function deleteAccount(): Promise<{ error?: string; deleted?: true; signedOut?: true }> {
  const s = getSession();
  if (!s) return { error: "You're not signed in." };
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, ACCOUNT_DELETE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/api/account/delete`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}` },
      signal: abort.signal,
    });
  } catch {
    // The request may have reached D1 and committed before the connection
    // dropped (or before we gave up on it), so we can't claim either outcome —
    // only that it's unconfirmed.
    return timedOut
      ? {
          error:
            `The account server didn't answer within ${ACCOUNT_DELETE_TIMEOUT_MS / 1000} seconds, so we can't ` +
            `confirm whether the account was deleted. Check back later before trying again.`,
        }
      : { error: "Couldn't reach the account server, so we can't confirm whether the account was deleted." };
  } finally {
    clearTimeout(timer);
  }
  if (res.ok || (res.status === 404 && isJsonResponse(res))) {
    endSession();
    return { deleted: true };
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) {
    // Dead token — nothing left to retry with. Tokens last 30 days, so this is a
    // routine expiry, not an anomaly: say what happened instead of returning a
    // bare server error that hides the sign-out.
    endSession();
    return {
      error: "Your session had expired, so the account was NOT deleted and you've been signed out. Sign in again to retry.",
      signedOut: true,
    };
  }
  return { error: data.error ?? "Account deletion failed." };
}
