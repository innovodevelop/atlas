import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AtlasDashboard from "./pages/atlas/AtlasDashboard";
import NotFound from "./pages/NotFound";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { useRealtimePauseOnInactivity } from "./hooks/useRealtimePauseOnInactivity";

// Only the default route (AtlasDashboard) is eager — everything else is
// code-split so the entry chunk stays small and the startup paint is instant.
// The legacy Dashboard especially must stay lazy: it drags 9 realtime hooks
// and the whole legacy card stack into whatever chunk it lands in.
const AtlasHome = lazy(() => import("./pages/atlas/AtlasHome"));
const AtlasCoreScreen = lazy(() => import("./pages/atlas/AtlasCoreScreen"));
// Mail is a full route, not the dashboard's `expanded === 'email'` overlay —
// the overlay stays as the glanceable card, this is the supervision surface.
const AtlasMail = lazy(() => import("./pages/atlas/AtlasMail"));
// Settings was overlay-only (rendered inside AtlasDashboard behind
// `settingsOpen`), so nothing could link to it and it was unreachable from any
// other screen. It is a route AS WELL now — the dock button and the account
// menu still open the overlay. See AtlasSettingsRoute for why both.
const AtlasSettingsRoute = lazy(() => import("./pages/atlas/AtlasSettingsRoute"));
const Auth = lazy(() => import("./pages/Auth"));
import { OnboardingGate } from "./components/OnboardingGate";
// Statically imported (not lazy): this is the first screen a new user sees, so
// it must not depend on a runtime chunk fetch that could fail in the webview.
import AtlasPermissions from "./pages/AtlasPermissions";
// `/atlas-demo` used to be lazy-loaded here. It was a 1133-line particle
// tuning lab for the three.js sphere — the largest page in the repo, linked
// from nowhere, and the only importer of src/components/atlas-demo/. Both are
// deleted with the renderer they tuned. The tuning surface that survives is
// /atlas-sphere, which drives the renderer the app actually uses.
// Both are reachable from the account menu (dock avatar → "Teach Atlas" /
// "How Atlas works"). Before T4 part 3 they were routes with no link anywhere.
const AtlasTeach = lazy(() => import("./pages/AtlasTeach"));
const AtlasArchitecture = lazy(() => import("./pages/AtlasArchitecture"));
// Internal QA surface for the sphere — a design tool, not a product screen, so
// it is deliberately NOT on the dock. It is linked from the account menu in DEV
// builds only, which is where it gets used; in a shipped build it stays
// URL-only on purpose.
const AtlasSphereGallery = lazy(() => import("./pages/AtlasSphereGallery"));

// Instant startup: dashboard data (weather, stocks, news, tasks…) is
// persisted to disk-backed localStorage, so the app paints with last-known
// data immediately and refetches in the background. Bump `buster` when the
// cached shape changes.
const queryClient = new QueryClient({
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
const persistOptions = {
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

// Loading fallback for lazy routes
const PageLoader = () => (
  <div className="min-h-screen bg-background flex items-center justify-center">
    {/* This was the clearest live proof of the token drift: `border-primary`
        reads --primary, which was #ff6a00, so every route transition flashed an
        orange ring on a blue app. It is Atlas Blue now, and the spinner is a
        masked conic gradient rather than a border — nothing in the suite draws
        with an element border any more. */}
    <div
      className="w-10 h-10 rounded-full animate-spin"
      style={{
        background: 'conic-gradient(from 0deg, transparent 0deg, hsl(var(--primary)) 300deg)',
        WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0)',
        mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0)',
      }}
    />
  </div>
);

// App-wide side effects that must run once, inside the providers.
const GlobalEffects = () => {
  useRealtimePauseOnInactivity();
  return null;
};

const App = () => (
  <PersistQueryClientProvider
    client={queryClient}
    persistOptions={persistOptions}
  >
    <TooltipProvider>
      <GlobalEffects />
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <RouteErrorBoundary>
        {/* One suspense boundary for every lazy route */}
        <Suspense fallback={<PageLoader />}>
        <Routes>
          {/* Atlas screens */}
          <Route path="/" element={<OnboardingGate><AtlasDashboard /></OnboardingGate>} />
          <Route path="/dashboard" element={<OnboardingGate><AtlasDashboard /></OnboardingGate>} />
          <Route path="/home" element={<AtlasHome />} />
          <Route path="/atlas-core" element={<AtlasCoreScreen />} />
          <Route path="/mail" element={<AtlasMail />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/settings" element={<AtlasSettingsRoute />} />
          {/* First-run consent. Genuinely revisitable now, via Settings →
              Permissions (AtlasSettings.tsx). The comment that used to sit here
              claimed that was already true; it was not — before T4 part 2 this
              route was referenced only by OnboardingGate and Auth, which made
              AtlasPermissions' own "you can change it later" a broken promise. */}
          <Route path="/permissions" element={<AtlasPermissions />} />

          {/* `/atlas-core-legacy` used to sit here, pointing at pages/AtlasCore
              and the 34-file src/components/atlas-health tree behind it. Both
              are deleted (T4 part 3). Nothing linked to the route; the panels
              worth keeping were absorbed first — Agent CRUD, schedules, tool
              calls and the run timeline into Atlas Core's Agent tab, usage and
              cost into Settings → Budget, the memory tab and the error log into
              Atlas Core. The five settings panels that were always live still
              live in atlas-health/ and are mounted from AtlasSettings.
              An older comment here sent readers to docs/ROADMAP.md "before
              reviving or deleting any of it"; that cross-reference resolved to
              nothing — the roadmap's one do-not-clean-up rule is about
              supabase/functions/_shared, not this tree. */}
          <Route
            path="/atlas-sphere"
            element={
              <Suspense fallback={<PageLoader />}>
                <AtlasSphereGallery />
              </Suspense>
            }
          />
           <Route
             path="/atlas-architecture" 
             element={
               <Suspense fallback={<PageLoader />}>
                 <AtlasArchitecture />
               </Suspense>
             } 
           />
          <Route 
            path="/atlas-teach" 
            element={
              <Suspense fallback={<PageLoader />}>
                <AtlasTeach />
              </Suspense>
            }
          />

          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
        </RouteErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </PersistQueryClientProvider>
);

export default App;
