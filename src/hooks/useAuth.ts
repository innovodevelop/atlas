import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { clearPersistedCache } from "@/lib/queryClient";
import * as auth from "@/lib/authClient";

// Auth is now backed by the Cloudflare account system (atlas-site), not Supabase.
// The session lives in localStorage (authClient); every useAuth instance stays in
// sync via useSyncExternalStore. Same external shape as before (user / session /
// loading / signIn / signUp / signOut / isAuthenticated) plus entitlement +
// hasFeature. `session.access_token` is kept so existing bearer-token callers
// keep working.
export const useAuth = () => {
  const session = useSyncExternalStore(auth.subscribe, auth.getSession, auth.getSession);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(false);
    // Re-validate entitlement in the background (offline-safe; clears the
    // session on a 401 so an expired token forces re-login).
    //
    // Every mounted consumer runs this, and there are 26 of them — the
    // dashboard alone used to fire three concurrent `GET /api/me` on load
    // (audit finding C8). The fix is NOT a guard here, because a guard here
    // only knows about this component: `refreshEntitlement` itself now shares
    // one in-flight request per token, so this line costs at most one call no
    // matter how many surfaces are mounted. Do not add a second guard on top.
    void auth.refreshEntitlement();
  }, []);

  // NEITHER OF THESE TOASTS ANY MORE, and neither throws.
  //
  // They return `{ error }` or `{ data }`, and the CALLER decides what the user
  // sees. `src/pages/Auth.tsx` is the only caller: it is a full-screen
  // conversational scene where a toast is the wrong medium — it slides in over
  // the corner of a page whose whole job is to be talking to you, and it says
  // the failure somewhere other than where the failure happened.
  //
  // The success toasts went for a sharper reason. "Welcome back!" fired from
  // here on a path that could not tell whether anything had been stored, and
  // the sign-in screen separately assumed success because these functions do
  // not throw — so a rejected password produced a cheerful toast AND a
  // "Good to see you". Two independent claims of success for a login that did
  // not happen. The screen now renders both outcomes itself, from the returned
  // value, in the place the user is already looking.
  const signUp = useCallback(async (email: string, password: string, _displayName?: string) => {
    const { error, session } = await auth.signUp(email, password);
    if (error) return { error };
    return { data: session };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error, session } = await auth.signIn(email, password);
    if (error) return { error };
    return { data: session };
  }, []);

  const signOut = useCallback(async () => {
    auth.signOut();
    // Persisted query cache holds account-scoped data — drop it on sign-out.
    clearPersistedCache();
    toast.success("Signed out successfully");
    return {};
  }, []);

  // ONE OBJECT PER SESSION, not one per render. `session` is already a stable
  // snapshot (authClient caches it until the stored JSON changes), but a fresh
  // `{ id, email }` on every render made `user` a new dependency every time,
  // and a hook that fetches on `[user]` and sets state looped forever:
  // useMailIntelligence's refresh did exactly that and froze Beta Home. Keyed
  // on the account, so an entitlement refresh does not refetch either.
  const userId = session?.userId;
  const email = session?.email;
  const user = useMemo(() => (userId !== undefined && email !== undefined ? { id: userId, email } : null), [userId, email]);
  // Back-compat shim: callers read session.access_token for bearer auth.
  const token = session?.token;
  const legacySession = useMemo(() => (user && token !== undefined ? { access_token: token, user } : null), [user, token]);

  return {
    user,
    session: legacySession,
    entitlement: session?.entitlement ?? null,
    loading,
    signUp,
    signIn,
    signOut,
    isAuthenticated: !!session,
    hasFeature: auth.hasFeature,
  };
};
