import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { clearPersistedCache } from "@/App";
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
    void auth.refreshEntitlement();
  }, []);

  const signUp = useCallback(async (email: string, password: string, _displayName?: string) => {
    const { error, session } = await auth.signUp(email, password);
    if (error) {
      toast.error(error);
      return { error };
    }
    toast.success("Account created successfully!");
    return { data: session };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error, session } = await auth.signIn(email, password);
    if (error) {
      toast.error(error);
      return { error };
    }
    toast.success("Welcome back!");
    return { data: session };
  }, []);

  const signOut = useCallback(async () => {
    auth.signOut();
    // Persisted query cache holds account-scoped data — drop it on sign-out.
    clearPersistedCache();
    toast.success("Signed out successfully");
    return {};
  }, []);

  const user = session ? { id: session.userId, email: session.email } : null;

  return {
    user,
    // Back-compat shim: callers read session.access_token for bearer auth.
    session: session ? { access_token: session.token, user } : null,
    entitlement: session?.entitlement ?? null,
    loading,
    signUp,
    signIn,
    signOut,
    isAuthenticated: !!session,
    hasFeature: auth.hasFeature,
  };
};
