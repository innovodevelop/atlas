/**
 * The route table, generated from `src/surfaces.ts`.
 *
 * ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────
 *
 * Two reasons, both structural.
 *
 * 1. It is the half of App.tsx that must be RENDERABLE ON ITS OWN. The whole
 *    claim of the consumer/admin split is "an admin path in a consumer build
 *    lands on 404", and the only honest way to check that is to render the real
 *    table at that path and look at what comes out. App.tsx cannot be rendered
 *    under a test runner — it eagerly imports the dashboard, which drags canvas
 *    renderers, CSS and a dozen realtime hooks with it. This module imports
 *    `NotFound` and a list of `lazy()` thunks, and a thunk for a route that does
 *    not match is never called. `src/editionProbe.tsx` renders exactly this.
 *
 * 2. `App.tsx` USED TO BE imported by every page in the app (via
 *    `clearPersistedCache` → `lib/authClient.ts` → `hooks/useAuth.ts`), so
 *    anything App.tsx named statically was reachable from every page. That
 *    back-edge is why the hand-written
 *    `lazy(() => import('./pages/atlas/AtlasBanking'))` table had to go: it put
 *    the admin page graph behind every consumer page no matter what the edition
 *    flag said. The back-edge itself is gone now — the query client and its
 *    teardown moved to `@/lib/queryClient` after the cycle caused a start-up
 *    TDZ crash — but generating the table from the registry is still what makes
 *    the edition split structural rather than a naming convention, so it stays.
 *
 * ── EAGER ROUTES ────────────────────────────────────────────────────────────
 *
 * `lazy()` stays for everything that had it — a previous session replaced lazy
 * with static imports and that was reverted on purpose. Two surfaces are marked
 * `eager` in the registry because they are the first paint of a cold start, and
 * they are supplied by the caller through `overrides` rather than imported
 * here, so this module stays cheap enough to render in a test. App.tsx is the
 * only caller and it passes both; a DEV assertion below catches the day someone
 * marks a third surface eager and forgets.
 */
import { Suspense, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import NotFound from './pages/NotFound';
import { routableSurfaces } from './surfaces';

export interface RouteOverride {
  /** Renders instead of the registry's `lazy()` component (for `eager` surfaces). */
  Component?: ComponentType<Record<string, never>>;
  /** Wraps the element — the dashboard's first-run gate is the only user. */
  wrap?: (el: ReactElement) => ReactElement;
}

interface Props {
  overrides?: Readonly<Record<string, RouteOverride>>;
  /** Rendered while a lazy route's chunk loads. */
  fallback?: ReactNode;
}

export const AppRoutes = ({ overrides = {}, fallback = null }: Props) => {
  if (import.meta.env.DEV) {
    const unhonoured = routableSurfaces
      .filter((s) => s.meta.eager && !overrides[s.meta.path]?.Component)
      .map((s) => s.meta.path);
    if (unhonoured.length) {
      console.error(
        `[atlas] surfaces marked eager but routed lazily: ${unhonoured.join(', ')}. ` +
          'A cold start now depends on a chunk fetch that can fail in the webview.',
      );
    }
  }

  return (
    /* One suspense boundary for every lazy route. */
    <Suspense fallback={fallback}>
      <Routes>
        {routableSurfaces.flatMap(({ meta, paths, Component }) => {
          const override = overrides[meta.path];
          const Page = override?.Component ?? Component;
          const element = override?.wrap ? override.wrap(<Page />) : <Page />;
          // Aliases render the SAME element, not a second copy: `/dashboard`
          // and `/` were two hand-written routes before, which is how they
          // drifted into different wrappers in the first place.
          return paths.map((path) => <Route key={path} path={path} element={element} />);
        })}

        {/* Everything the registry does not route for THIS edition — including
            every admin path in a consumer build — falls here. That is the
            entire product of the split: `/model-lab` is not a hidden route in a
            consumer build, it is an unknown one. */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
};
