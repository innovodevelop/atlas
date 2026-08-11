/**
 * The surface registry — one table naming every screen Atlas has.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Thirteen pages already exported `{ path, label, icon, entry, mock }` and
 * NOTHING IMPORTED ANY OF THEM. The router, the dock and the account menu were
 * each hand-written separately, so those exports were decoration: three lists
 * that had to be kept in sync by hand, and were not. `/atlas-teach` and
 * `/atlas-architecture` sat routed-but-unlinked for weeks, `/home` for longer.
 * The exports recorded that a surface existed; nothing checked that a route or
 * a link followed.
 *
 * This file is the one table. It is the SOURCE, not a mirror: routes, dock and
 * account menu are all generated from it, and `surfaces.test.ts` fails if a
 * page's own `export const surface` block ever disagrees with the entry here.
 * A registry that only labels surfaces is what we already had.
 *
 * ── THE CONSUMER / ADMIN SPLIT, AND HOW IT ACTUALLY BITES ───────────────────
 *
 * `edition` is not a label. In a consumer build, admin page modules must never
 * be IMPORTED — not lazily, not as an unreachable chunk on disk. The mechanism
 * is three lines and it depends on exactly one thing: Vite replaces
 * `import.meta.env.VITE_ATLAS_EDITION` with a string literal at build time.
 *
 *   1. `EDITION` folds to a literal ('consumer' or 'admin') during the build.
 *   2. `ADMIN_LOADERS` is a ternary on that literal. Rollup constant-folds the
 *      condition, deletes the dead branch, and every `import('./pages/...')`
 *      call inside it goes with it.
 *   3. A dynamic import that no longer exists in the module graph produces no
 *      chunk. The admin pages are not in the output at all — not split out,
 *      not lazy, ABSENT. `routableSurfaces` then has no entry for them, so the
 *      generated route table cannot reference them either.
 *
 * That is why the loaders live inline in ONE ternary rather than in a second
 * module: a static `import { ADMIN_LOADERS } from './surfaces.admin'` would put
 * the admin page graph back into the build no matter what the flag said.
 *
 * Default is `admin` (the flag unset ⇒ everything ships), so no build changes
 * behaviour until someone opts in with `VITE_ATLAS_EDITION=consumer`.
 *
 * ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
 *
 * It does not gate anything at runtime and it is not a security boundary. A
 * consumer build simply does not contain the admin screens; an admin build
 * contains everything and shows it. Anything that must be denied rather than
 * merely hidden belongs in the Rust control registry, not here.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Which build a surface belongs to. */
export type Edition = 'consumer' | 'admin';

/**
 * Where the surface is linked from.
 *
 * `none` is a real answer, not a gap: `/auth`, `/permissions` and `/settings`
 * are routed and reachable, but their entry points are hand-placed (the
 * first-run gate, a dock action opening the settings overlay). Generating a
 * menu row for them would duplicate a link that already exists.
 */
export type SurfaceEntry = 'dock' | 'menu' | 'none';

export interface SurfaceMeta {
  /** Canonical route path. Unique across the registry. */
  readonly path: string;
  /** Extra paths that render the same page (`/dashboard` is `/`). */
  readonly aliases?: readonly string[];
  readonly label: string;
  /** Lucide export name. A string, so metadata consumers need no icon imports. */
  readonly icon: string;
  readonly entry: SurfaceEntry;
  /** True when the surface still renders sample data anywhere. */
  readonly mock: boolean;
  readonly edition: Edition;
  /**
   * Keep this page statically imported in App.tsx rather than behind `lazy()`.
   * Two surfaces have earned it and the reason is the same for both: they are
   * the first thing rendered on a cold start, so a runtime chunk fetch that
   * fails in the webview would leave a blank window with no way forward.
   */
  readonly eager?: boolean;
  /** Linked only in DEV builds (an internal tool that stays URL-only when shipped). */
  readonly devOnly?: boolean;
  /**
   * Entitlement this surface needs before it routes: set it and the surface is
   * dropped from the route table unless `hasFeature(name)` says the signed-in
   * account has it (lib/authClient.ts, from the Cloudflare entitlement).
   *
   * Distinct from `edition`, which is a BUILD fact folded in by Rollup — the
   * admin screens are not in a consumer bundle at all. This one is a RUNTIME
   * fact about the account in front of us, so the page still ships and the
   * check has to be re-read whenever the entitlement changes (it arrives after
   * sign-in, and again after every /api/me refresh). Nothing gated this way is
   * secure; like the rest of this file it decides what is offered, not what is
   * permitted. Anything that must be denied belongs in the Rust control
   * registry.
   *
   * Nothing sets it yet. The dock and account menu are NOT gated on it — they
   * are module-scope consts derived once at import, which is the same staleness
   * the routing gate avoids by asking per render. The first surface to set
   * `feature` and appear in the dock has to fix that; a `feature` surface with
   * `entry: 'none'` needs nothing further.
   */
  readonly feature?: string;
  /**
   * Tab keys a consumer build may show, for surfaces whose tab strip is mixed.
   * Only `/atlas-core` has one. APPLYING it needs an edit inside
   * AtlasCoreScreen.tsx, which this registry does not own — see the entry.
   */
  readonly consumerTabs?: readonly string[];
}

/**
 * The edition this bundle was built for.
 *
 * Written as a direct comparison against `import.meta.env.VITE_ATLAS_EDITION`
 * so Vite's define pass can substitute a literal and Rollup can fold it. Do not
 * route this through a helper, a destructure or optional chaining — any of
 * those defeat the substitution and the admin chunks come back.
 *
 * Under `bun test` `import.meta.env` is an empty object, so this reads
 * `undefined` and lands on 'admin' — the test sees the full table, which is
 * what it needs to check.
 */
export const EDITION: Edition =
  import.meta.env.VITE_ATLAS_EDITION === 'consumer' ? 'consumer' : 'admin';

/**
 * Every surface, both editions, always. Metadata is a few hundred bytes of
 * strings and it is worth carrying: a consumer build that knows `/money` exists
 * can answer a typed URL with "not in this edition" instead of a bare 404.
 * What it must NOT carry is the component — that is `LOADERS`, below.
 */
export const SURFACES: readonly SurfaceMeta[] = [
  // ── CONSUMER ──────────────────────────────────────────────────────────────
  {
    path: '/',
    aliases: ['/dashboard'],
    label: 'Dashboard',
    icon: 'Home',
    entry: 'dock',
    mock: false,
    edition: 'consumer',
    eager: true,
  },
  {
    path: '/atlas-core',
    label: 'Core',
    icon: 'Cpu',
    entry: 'dock',
    mock: false,
    edition: 'consumer',
    // The tab strip mixes two audiences. Overview, Search, Knowledge, Memory
    // and Research are all "what Atlas knows about me" — the reason a person
    // opens this screen. Live (a raw event stream), Agent (agent CRUD, tool
    // calls, schedules, approval queue) and Learning (validation-success rates
    // and pipeline metrics) are operator instrumentation.
    //
    // NOT ENFORCED YET. `TABS` is a const inside AtlasCoreScreen.tsx and that
    // file's body is not this pass's to edit. The data is declared here so the
    // filter is a one-line change there: `TABS.filter(t => tabs.includes(t.key))`.
    consumerTabs: ['overview', 'search', 'knowledge', 'research', 'memory'],
  },
  { path: '/mail', label: 'Mail', icon: 'Mail', entry: 'dock', mock: false, edition: 'consumer' },
  { path: '/home', label: 'Voice home', icon: 'Mic', entry: 'menu', mock: false, edition: 'consumer' },
  {
    path: '/atlas-teach',
    label: 'Teach Atlas',
    icon: 'GraduationCap',
    entry: 'menu',
    mock: false,
    edition: 'consumer',
  },
  {
    path: '/smart-home',
    label: 'Smart home',
    icon: 'Home',
    entry: 'menu',
    // Real since the Home Assistant adapter landed: `useSmartHome` → the Rust
    // `home` module → HA over the LAN. Nothing on the surface is sample data.
    mock: false,
    edition: 'consumer',
  },
  {
    path: '/health',
    label: 'Health',
    icon: 'HeartPulse',
    entry: 'menu',
    // Real since the Apple Health import landed: `useHealth` → `health_snapshot`
    // → the local store filled from a genuine iPhone export. Normally EMPTY
    // (macOS has no HealthKit store, ADR 008) — empty is not mock.
    mock: false,
    edition: 'consumer',
  },
  { path: '/onboarding', label: 'Onboarding', icon: 'ShieldCheck', entry: 'menu', mock: false, edition: 'consumer' },
  {
    path: '/settings',
    label: 'Settings',
    icon: 'Settings',
    // The dock's settings button opens the overlay; this route exists for
    // deep links. Generating a menu row would be a second door to one room.
    entry: 'none',
    mock: false,
    edition: 'consumer',
  },
  { path: '/auth', label: 'Sign in', icon: 'LogIn', entry: 'none', mock: false, edition: 'consumer' },
  {
    path: '/permissions',
    label: 'Permissions',
    icon: 'ShieldCheck',
    entry: 'none',
    mock: false,
    edition: 'consumer',
    eager: true,
  },

  // ── ADMIN ─────────────────────────────────────────────────────────────────
  {
    path: '/money',
    label: 'Money',
    icon: 'Landmark',
    entry: 'menu',
    // Mastercard Open Finance is sandbox-only; the surface says so in a
    // standing banner and stamps every card. Admin until a real adapter lands.
    mock: true,
    edition: 'admin',
  },
  {
    path: '/browser',
    label: 'Browser',
    icon: 'Compass',
    entry: 'menu',
    // No engine behind it, and none planned — permanently admin.
    mock: true,
    edition: 'admin',
  },
  { path: '/widgets', label: 'Widget catalog', icon: 'LayoutGrid', entry: 'menu', mock: false, edition: 'admin' },
  { path: '/widget-sheet', label: 'Widget sheet', icon: 'Layers', entry: 'menu', mock: true, edition: 'admin' },
  { path: '/answer-views', label: 'Answer views', icon: 'Sparkles', entry: 'menu', mock: true, edition: 'admin' },
  {
    path: '/model-lab',
    label: 'Model lab',
    icon: 'FlaskConical',
    entry: 'menu',
    // Model ids, the provider KEY INVENTORY and 30-day spend. Never consumer.
    mock: true,
    edition: 'admin',
  },
  { path: '/versions', label: 'Versions', icon: 'GitBranch', entry: 'menu', mock: false, edition: 'admin' },
  { path: '/agent-view', label: 'Agent view', icon: 'Monitor', entry: 'menu', mock: false, edition: 'admin' },
  { path: '/design-sync', label: 'Design sync', icon: 'Palette', entry: 'menu', mock: false, edition: 'admin' },
  { path: '/tests', label: 'Tests', icon: 'TestTube2', entry: 'menu', mock: false, edition: 'admin' },
  {
    path: '/atlas-architecture',
    label: 'How Atlas works',
    icon: 'Network',
    entry: 'menu',
    mock: false,
    edition: 'admin',
  },
  {
    path: '/homekit-lab',
    label: 'HomeKit lab',
    icon: 'Network',
    entry: 'menu',
    // Nothing on it is invented: every row is an mDNS answer and every error is
    // the Rust error verbatim. The screen is normally EMPTY, because the
    // HomeKit Accessory Simulator is not installed — empty is not mock, and the
    // empty state says which of the two it is.
    mock: false,
    // Admin, and in practice Lighthouse-only: the commands behind it exist only
    // when src-tauri is built with the `homekit` Cargo feature, which
    // tauri.lighthouse.conf.json5 sets and Atlas.app does not. NOT `devOnly` —
    // Lighthouse is a production build and this is the one screen that can
    // pair an accessory, so hiding its link in a release would leave it
    // reachable by URL alone.
    edition: 'admin',
  },
  {
    path: '/atlas-sphere',
    label: 'Sphere gallery',
    icon: 'Orbit',
    entry: 'menu',
    mock: false,
    edition: 'admin',
    // ~20 raw renderer sliders. It was already DEV-only in the account menu;
    // that gate is preserved here rather than dropped in the move.
    devOnly: true,
  },
] as const;

type Loader = () => Promise<{ default: ComponentType<Record<string, never>> }>;

/**
 * Consumer page loaders.
 *
 * One line per surface, in a fixed shape — `'/path': () => import('./module'),`
 * — because `surfaces.test.ts` parses THIS SOURCE TEXT to learn which file
 * backs which path. It cannot ask at runtime (calling the thunk would load
 * every page), and a duplicated `module: '...'` field in the metadata above
 * would just be a second thing to keep in sync. Reformatting an entry off one
 * line turns the test red, which is correct: the test's whole job is to notice
 * when this table and the pages drift apart.
 */
const CONSUMER_LOADERS: Record<string, Loader> = {
  '/': () => import('./pages/atlas/AtlasDashboard'),
  '/atlas-core': () => import('./pages/atlas/AtlasCoreScreen'),
  '/mail': () => import('./pages/atlas/AtlasMail'),
  '/home': () => import('./pages/atlas/AtlasHome'),
  '/atlas-teach': () => import('./pages/AtlasTeach'),
  '/smart-home': () => import('./pages/atlas/AtlasSmartHome'),
  '/health': () => import('./pages/atlas/AtlasHealth'),
  '/onboarding': () => import('./pages/atlas/AtlasOnboarding'),
  '/settings': () => import('./pages/atlas/AtlasSettingsRoute'),
  '/auth': () => import('./pages/Auth'),
  '/permissions': () => import('./pages/AtlasPermissions'),
};

/**
 * Admin page loaders — the dead branch in a consumer build.
 *
 * The ternary is the whole mechanism (see the file header). Do not lift this
 * object to the top level "for readability": an unconditional table of
 * `import()` calls emits every admin chunk into a consumer build.
 */
const ADMIN_LOADERS: Record<string, Loader> = EDITION === 'admin' ? {
  '/money': () => import('./pages/atlas/AtlasBanking'),
  '/browser': () => import('./pages/atlas/AtlasBrowser'),
  '/widgets': () => import('./pages/atlas/AtlasWidgetCatalog'),
  '/widget-sheet': () => import('./pages/atlas/AtlasWidgetSheet'),
  '/answer-views': () => import('./pages/atlas/AtlasAnswerViews'),
  '/model-lab': () => import('./pages/atlas/AtlasModelLab'),
  '/versions': () => import('./pages/atlas/AtlasVersions'),
  '/agent-view': () => import('./pages/atlas/AtlasAgentView'),
  '/design-sync': () => import('./pages/atlas/AtlasDesignSync'),
  '/tests': () => import('./pages/atlas/AtlasTests'),
  '/atlas-architecture': () => import('./pages/AtlasArchitecture'),
  '/homekit-lab': () => import('./pages/atlas/AtlasHomeKitLab'),
  '/atlas-sphere': () => import('./pages/AtlasSphereGallery'),
} : {};

/** A surface this bundle can actually render, with its component resolved. */
export interface RoutableSurface {
  readonly meta: SurfaceMeta;
  /** Every path that should map to this component — canonical plus aliases. */
  readonly paths: readonly string[];
  readonly Component: LazyExoticComponent<ComponentType<Record<string, never>>>;
}

/** Surfaces belonging to this edition, whether or not they are linked anywhere. */
export const editionSurfaces: readonly SurfaceMeta[] =
  SURFACES.filter((s) => s.edition === 'consumer' || EDITION === 'admin');

/**
 * The route table, ready to map to `<Route>`.
 *
 * Derived from the LOADERS, not from `editionSurfaces` — in a consumer build
 * the admin loaders were deleted by the bundler, so those surfaces drop out
 * here for the only reason that matters: there is no component to render.
 * `lazy()` is called once, at module scope; calling it per render would remount
 * the page on every parent update.
 */
export const routableSurfaces: readonly RoutableSurface[] = SURFACES
  .map((meta): RoutableSurface | null => {
    const load = CONSUMER_LOADERS[meta.path] ?? ADMIN_LOADERS[meta.path];
    if (!load) return null;
    return {
      meta,
      paths: [meta.path, ...(meta.aliases ?? [])],
      Component: lazy(load),
    };
  })
  .filter((s): s is RoutableSurface => s !== null);

/**
 * `hasFeature`, passed in rather than imported.
 *
 * This module is imported by the router, the dock, the account menu and the
 * edition probe, and it deliberately has no dependencies beyond React's
 * `lazy`. Reaching into lib/authClient.ts for the real check would drag the
 * auth client, the query client and the toaster behind every one of them —
 * and, worse, would invite the check at module scope, which is where a
 * runtime entitlement goes stale (see `feature` on SurfaceMeta).
 */
export type FeatureCheck = (feature: string) => boolean;

/** True when `has` permits this surface. An ungated surface is always allowed. */
export const surfaceEntitled = (meta: SurfaceMeta, has: FeatureCheck): boolean =>
  meta.feature === undefined || has(meta.feature);

/**
 * The route table this ACCOUNT may render — `routableSurfaces` minus anything
 * whose entitlement is missing.
 *
 * Kept as a function of the check instead of another module-scope const, so
 * `AppRoutes` can re-derive it on the render that follows the entitlement
 * arriving. A snapshot taken at import would need an app restart before a
 * newly-bought feature had a route, and would silently 404 it until then.
 *
 * `from` defaults to the registry's own routable list; it is a parameter so the
 * gate can be exercised against a surface that carries `feature` while the
 * registry itself still has none.
 */
export const entitledSurfaces = (
  has: FeatureCheck,
  from: readonly RoutableSurface[] = routableSurfaces,
): readonly RoutableSurface[] => from.filter((s) => surfaceEntitled(s.meta, has));

/** Dock items for this edition, in registry order. */
export const dockSurfaces: readonly SurfaceMeta[] =
  editionSurfaces.filter((s) => s.entry === 'dock');

/**
 * Account-menu items for this edition, in registry order.
 *
 * `devOnly` entries are dropped from a production build — the sphere gallery
 * stays URL-only when shipped, exactly as AccountMenu gated it by hand.
 */
export const menuSurfaces: readonly SurfaceMeta[] =
  editionSurfaces.filter((s) => s.entry === 'menu' && (!s.devOnly || !!import.meta.env.DEV));

const BY_PATH = new Map<string, SurfaceMeta>();
for (const s of SURFACES) {
  BY_PATH.set(s.path, s);
  for (const a of s.aliases ?? []) BY_PATH.set(a, s);
}

/**
 * Look up a surface by any of its paths, INCLUDING one this build cannot
 * render. A consumer build asked for `/money` gets the metadata back and can
 * say "that screen is not in this edition" rather than pretending the path was
 * never a thing.
 */
export const surfaceByPath = (path: string): SurfaceMeta | undefined => BY_PATH.get(path);

/** True when this build ships the surface at `path`. */
export const isRoutable = (path: string): boolean =>
  routableSurfaces.some((s) => s.paths.includes(path));
