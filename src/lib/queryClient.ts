/**
 * The react-query client, and the one teardown that clears it.
 *
 * WHY THIS IS NOT IN App.tsx ANY MORE. `clearPersistedCache` is needed by
 * lib/authClient.ts, hooks/useAuth.ts and the memory/privacy panel, so while it
 * lived in App.tsx those modules imported the app root — and the app root
 * imports its two eager pages. Any module those pages reach that also reaches
 * authClient closed a cycle, and ES modules resolve a cycle by handing back a
 * half-initialised namespace: the symptom is a bare
 * `Cannot access 'AtlasPermissions' before initialization` at start-up, from a
 * file that looks entirely correct.
 *
 * That is what happened the moment the consent screen started speaking:
 * AtlasPermissions → useAtlasSpeech → useStreamingTTS → voiceClient →
 * localClient → authClient → App. Nothing in that chain is wrong; the cycle was
 * simply already at zero clearance, and adding a link tipped it over.
 *
 * This module is a leaf — it imports only from @tanstack — so nothing that
 * needs the cache can drag a page module in behind it.
 *
 * NO DISK PERSISTENCE (removed 2026-08-11, audit C11). This used to wrap
 * `queryClient` in `PersistQueryClientProvider` with a `PERSIST_ALLOWLIST` of
 * ["weather", "profile", "tasks", "notes", "calendar", "user"], on the theory
 * that those are the "instant startup" queries worth surviving a relaunch. None
 * of them do: `rg queryKey` across every `useQuery` call site turns up admin/
 * agent/version/test/learning/provider-status/usage-history keys only — the
 * screens the allowlist named (weather, tasks, notes, calendar) fetch through
 * the module-scoped stores in src/hooks, not react-query. So every cold start
 * paid a synchronous localStorage read, and every admin-surface query event
 * paid a throttled reserialize, to persist and rehydrate nothing. The
 * `atlas-query-cache` key is still scrubbed below so an install that has it on
 * disk from before this change doesn't carry an orphan forever.
 */
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Evict inactive queries after 30 min. 24h let the in-memory cache grow
      // unbounded across a long-open desktop session.
      gcTime: 30 * 60 * 1000,
      // A desktop window flaps focus constantly (cmd-tab, display wake) —
      // the default refetch-on-focus refired EVERY mounted query each time,
      // hammering the WKWebView Networking process. Cards stay fresh via
      // their own activity-gated refetchIntervals instead.
      refetchOnWindowFocus: false,
      staleTime: 60 * 1000,
      retry: 2,
    },
  },
});

// Drops the account-scoped query cache — used by sign-out, a dead session and
// the "delete all my data" control. Three modules depend on this exact name and
// its privacy contract (authClient, useAuth, MemoryPrivacyPanel): it must
// leave nothing of the user's data behind, on disk or in memory.
export const clearPersistedCache = () => {
  queryClient.clear();
  try {
    // Pre-C11 installs may still carry the old persisted cache key on disk —
    // remove it so it doesn't sit there as a permanent orphan. The
    // `typeof window` guard (not just optional chaining) matters here: where
    // there's no `window` at all (SSR/tests), the bare identifier throws a
    // ReferenceError before `?.` ever gets a chance to short-circuit it.
    if (typeof window !== "undefined") window.localStorage.removeItem("atlas-query-cache");
  } catch {
    /* storage unavailable */
  }
};
