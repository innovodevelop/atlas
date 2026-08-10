/**
 * Renders the app's REAL route table at a given path and prints what came out.
 *
 * Run in a subprocess by `src/editionSplit.test.ts`, once per edition:
 *
 *   VITE_ATLAS_EDITION=consumer bun scripts/edition-probe.tsx /model-lab
 *
 * A subprocess because `EDITION` is decided when `src/surfaces.ts` is first
 * evaluated, so one process can only ever observe one edition — and because
 * under Bun `import.meta.env` reflects the real environment, which is what
 * makes the consumer graph observable at all without a bundler.
 *
 * It renders `<AppRoutes>` — the same component App.tsx renders, not a copy of
 * it — so "an admin path 404s in a consumer build" is checked against the
 * router the app actually ships rather than against a restatement of its rules.
 * `lazy()` thunks for routes that do not match are never called, which is why
 * this can run under a test runner with no DOM: the only page module that
 * loads is NotFound.
 *
 * Prints one line of JSON: { edition, path, notFound, pending, routed, dockKept }.
 */
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { AppRoutes } from '../src/AppRoutes';
import { EDITION, routableSurfaces } from '../src/surfaces';
import { dockableItems } from '../src/components/atlas-ui/primitives/dockEdition';

const path = process.argv[2] ?? '/';

let html = '';
let error: string | null = null;
try {
  html = renderToString(
    <StaticRouter location={path}>
      {/* No `overrides`: the eager surfaces render through their lazy() twins
          here, which is fine because a suspended route only reaches the
          fallback and this probe never asserts on page CONTENT — only on
          whether the router matched a route at all. */}
      <AppRoutes fallback={<i data-probe="pending" />} />
    </StaticRouter>,
  );
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}

console.log(JSON.stringify({
  edition: EDITION,
  path,
  // NotFound's own copy. Matching on rendered output rather than on a route
  // list is the whole point: it is the 404 a user would see.
  notFound: html.includes('Oops! Page not found'),
  pending: html.includes('data-probe="pending"'),
  routed: routableSurfaces.map((s) => s.meta.path),
  // The dock's edition filter, exercised in the same graph: a consumer path, an
  // admin path, and a path the registry has never heard of.
  dockKept: dockableItems(
    ['/mail', '/model-lab', '/not-a-surface'].map((to) => ({ id: to, label: to, icon: null, to })),
  ).map((i) => i.to),
  error,
}));
