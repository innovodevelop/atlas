import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { BrowserRouter } from "react-router-dom";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { AppRoutes, type RouteOverride } from "./AppRoutes";
import { OnboardingGate } from "./components/OnboardingGate";
// The two `eager: true` surfaces in the registry, and the only page modules
// this file still names. Everything else is code-split so the entry chunk stays
// small and the startup paint is instant: the parse-and-eval cost of a page's
// JS lands on every launch whether the chunk came over the network or off
// disk, so lazy() still buys something for a local desktop app.
//
// These two are static because they are the FIRST paint of a cold start —
// the desk you land on, and the consent screen a new user is sent to — so
// neither may depend on a runtime chunk fetch that can fail in the webview.
import AtlasDashboard from "./pages/atlas/AtlasDashboard";
import AtlasPermissions from "./pages/AtlasPermissions";

// The twenty-odd `const X = lazy(() => import("./pages/…"))` lines that used to
// sit here are gone, and their absence is the point rather than tidiness.
// While this file named the admin pages, every consumer page transitively named
// them too — and a consumer build emitted all twelve admin chunks (plus
// mermaid's 28) no matter what VITE_ATLAS_EDITION said. Generating the table
// from `routableSurfaces`, whose admin half Rollup deletes outright in a
// consumer build, is what makes the split real instead of cosmetic. See
// src/AppRoutes.tsx and src/surfaces.ts.
//
// The query client and `clearPersistedCache` used to live here too, which put
// App.tsx on EVERY page's import graph (authClient, useAuth and the
// memory/privacy panel all need the teardown) and left a permanent import cycle
// through the two eager pages above. They now live in `@/lib/queryClient`,
// which imports nothing of ours — see that file for what the cycle actually
// broke.

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

// The registry's `eager` surfaces, supplied to the generated table.
//
// ADDING A ROUTE IS NOT DONE HERE ANY MORE. A new screen is a new entry in
// src/surfaces.ts and a `surface` export on the page; the route, the dock slot
// and the account-menu row all follow from that one edit. This map exists only
// for the two things the registry cannot express as data: which component to
// use instead of the lazy one, and the dashboard's first-run gate.
const ROUTE_OVERRIDES: Readonly<Record<string, RouteOverride>> = {
  "/": {
    Component: AtlasDashboard,
    // Applies to `/dashboard` too — they are one entry with an alias now, so
    // the two routes cannot drift into different wrappers the way hand-written
    // duplicates could.
    wrap: (el) => <OnboardingGate>{el}</OnboardingGate>,
  },
  // First-run consent. Genuinely revisitable, via Settings → Permissions
  // (AtlasSettings.tsx) — before T4 part 2 this route was referenced only by
  // OnboardingGate and Auth, which made AtlasPermissions' own "you can change
  // it later" a broken promise.
  "/permissions": { Component: AtlasPermissions },
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <RouteErrorBoundary>
          <AppRoutes overrides={ROUTE_OVERRIDES} fallback={<PageLoader />} />
        </RouteErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
