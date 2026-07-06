import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AuroraDashboard from "./pages/aurora/AuroraDashboard";
import Dashboard from "./pages/Dashboard";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";

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
      gcTime: 24 * 60 * 60 * 1000, // keep cached data a day for the persister
    },
  },
});

const persister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: "atlas-query-cache",
});

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

const App = () => (
  <PersistQueryClientProvider
    client={queryClient}
    persistOptions={{ persister, maxAge: 24 * 60 * 60 * 1000, buster: "v1" }}
  >
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <RouteErrorBoundary>
        <Routes>
          {/* Aurora dashboard is the main route */}
          <Route path="/" element={<AuroraDashboard />} />
          <Route path="/dashboard" element={<AuroraDashboard />} />
          <Route path="/legacy-dashboard" element={<Dashboard />} />
          <Route path="/auth" element={<Auth />} />
          
          {/* Atlas Core Dashboard */}
          <Route 
            path="/atlas-core" 
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
