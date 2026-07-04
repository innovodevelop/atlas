import { useState, useEffect, useCallback } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { clearPersistedCache } from "@/App";

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, currentSession) => {
        setSession(currentSession);
        setUser(currentSession?.user ?? null);
        setLoading(false);
      }
    );

    // THEN check for existing session
    supabase.auth.getSession().then(({ data: { session: existingSession } }) => {
      setSession(existingSession);
      setUser(existingSession?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName?: string) => {
    try {
      const redirectUrl = `${window.location.origin}/`;

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectUrl,
          data: {
            display_name: displayName,
          },
        },
      });

      if (error) {
        if (error.message.includes("already registered")) {
          toast.error("This email is already registered. Please sign in instead.");
        } else {
          toast.error(error.message);
        }
        return { error };
      }

      toast.success("Account created successfully!");
      return { data };
    } catch (err) {
      console.error("Sign up error:", err);
      toast.error("An unexpected error occurred. Please try again.");
      return { error: err };
    }
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        toast.error(error.message);
        return { error };
      }

      toast.success("Welcome back!");
      return { data };
    } catch (err) {
      console.error("Sign in error:", err);
      toast.error("An unexpected error occurred. Please try again.");
      return { error: err };
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        toast.error(error.message);
        return { error };
      }
      // Persisted query cache holds auth-scoped data — drop it on sign-out
      clearPersistedCache();
      toast.success("Signed out successfully");
      return {};
    } catch (err) {
      console.error("Sign out error:", err);
      toast.error("An unexpected error occurred. Please try again.");
      return { error: err };
    }
  }, []);

  return {
    user,
    session,
    loading,
    signUp,
    signIn,
    signOut,
    isAuthenticated: !!user,
  };
};
