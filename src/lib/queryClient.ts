/**
 * The react-query client, its disk persister, and the one teardown that drops
 * both.
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
 */
import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

// Instant startup: dashboard data (weather, stocks, news, tasks…) is
// persisted to disk-backed localStorage, so the app paints with last-known
// data immediately and refetches in the background. Bump `buster` when the
// cached shape changes.
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

const persister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: "atlas-query-cache",
});

// Only persist the small, stable "instant startup" queries. Volatile/large
// payloads (stock sparklines, news, realtime health) would bloat localStorage
// and get replayed into memory on every launch.
const PERSIST_ALLOWLIST = ["weather", "profile", "tasks", "notes", "calendar", "user"];

export const persistOptions = {
  persister,
  maxAge: 24 * 60 * 60 * 1000,
  buster: "v2",
  dehydrateOptions: {
    shouldDehydrateQuery: (query: { queryKey: readonly unknown[] }) => {
      const head = String(query.queryKey?.[0] ?? "").toLowerCase();
      return PERSIST_ALLOWLIST.some((k) => head.includes(k));
    },
  },
};

// Drops the account-scoped query cache — used by sign-out, a dead session and
// the "delete all my data" control.
//
// Order matters. Removing only the storage key is not a clear: the QueryClient
// still holds the pre-erase snapshots in memory, and PersistQueryClientProvider
// re-serialises them into the same key on the very next cache event — so rows
// erased under a right-to-erasure control would be back on disk seconds later.
// Dropping the in-memory cache FIRST leaves nothing to re-persist; only then is
// the key removed.
export const clearPersistedCache = () => {
  queryClient.clear();
  try {
    // The persister is a no-op when there's no `window` (see above), so this is
    // safe outside the browser too.
    persister.removeClient();
  } catch {
    /* storage unavailable */
  }
  // createSyncStoragePersister throttles writes behind a 1s trailing timer, so a
  // write scheduled just before this call can still land right after it. By then
  // the cache is empty, so the worst case is the key reappearing holding an
  // empty dehydrated state — never user data.
};
