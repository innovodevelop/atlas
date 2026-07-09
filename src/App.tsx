import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AuroraDashboard from "./pages/aurora/AuroraDashboard";
import AuroraHome from "./pages/aurora/AuroraHome";
import AuroraCore from "./pages/aurora/AuroraCore";
import Dashboard from "./pages/Dashboard";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { useRealtimePauseOnInactivity } from "./hooks/useRealtimePauseOnInactivity";

// Lazy load heavy pages
const LegacyIndex = lazy(() => import("./pages/Index"));
const AtlasDemo = lazy(() => import("./pages/AtlasDemo"));
const AtlasCore = lazy(() => import("./pages/AtlasCore"));
const AtlasTeach = lazy(() => import("./pages/AtlasTeach"));
 const AtlasArchitecture = lazy(() => import("./pages/AtlasArchitecture"));

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
    shouldDehydrateQuery: (query: { queryKey: unknown[] }) => {
      const head = String(query.queryKey?.[0] ?? "").toLowerCase();
      return PERSIST_ALLOWLIST.some((k) => head.includes(k));
    },
  },
};

export const clearPersistedCache = () => {
  try {
    window.localStorage.removeItem("atlas-query-cache");
  } catch {
    /* storage unavailable */
  }
};

// Loading fallback for lazy routes
const PageLoader = () => (
  <div className="min-h-screen bg-background flex items-center justify-center">
    <div className="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
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
        <Routes>
          {/* Aurora screens */}
          <Route path="/" element={<AuroraDashboard />} />
          <Route path="/dashboard" element={<AuroraDashboard />} />
          <Route path="/home" element={<AuroraHome />} />
          <Route path="/atlas-core" element={<AuroraCore />} />
          <Route path="/legacy-dashboard" element={<Dashboard />} />
          <Route path="/auth" element={<Auth />} />

          {/* Legacy Atlas Core health dashboard */}
          <Route
            path="/atlas-core-legacy"
            element={
              <Suspense fallback={<PageLoader />}>
                <AtlasCore />
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
          
          {/* Legacy routes with lazy loading */}
          <Route 
            path="/legacy" 
            element={
              <Suspense fallback={<PageLoader />}>
                <LegacyIndex />
              </Suspense>
            } 
          />
          <Route 
            path="/atlas-demo" 
            element={
              <Suspense fallback={<PageLoader />}>
                <AtlasDemo />
              </Suspense>
            } 
          />
          
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </RouteErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </PersistQueryClientProvider>
);

export default App;
