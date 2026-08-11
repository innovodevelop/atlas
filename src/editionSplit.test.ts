/**
 * The consumer/admin split, proved rather than declared.
 *
 * `surfaces.test.ts` checks that the registry agrees with the pages. This file
 * checks the thing the registry exists FOR: that a consumer build does not
 * contain the admin screens, and that a consumer asked for an admin URL gets a
 * 404 instead of a screen full of system prompts, model pickers and raw
 * tool-call JSON.
 *
 * Both halves are needed and neither implies the other:
 *
 *   ROUTING  — rendered through the app's real `<AppRoutes>` at the real path.
 *              A component that is present in the bundle but unrouted would
 *              pass this and fail the next.
 *   BUNDLE   — the built output, file by file. A route that is absent from the
 *              table but whose module still ships would pass the first and fail
 *              this one. "Not linked" is not the claim; "not there" is.
 *
 * ── WHY IT SPAWNS PROCESSES AND RUNS BUILDS ─────────────────────────────────
 *
 * `EDITION` is fixed when `src/surfaces.ts` is first evaluated, so one process
 * can only ever observe one edition — and under `bun test` that edition is
 * always `admin`. The only way to observe the consumer graph is a subprocess
 * with `VITE_ATLAS_EDITION=consumer` in its environment (Bun's
 * `import.meta.env` reflects the real environment, which is what makes this
 * work without a bundler). The same argument applies to the bundle: the
 * tree-shake is a property of Rollup's output, so the output is what gets
 * inspected. Both editions build in ~5s each; the builds run once, at module
 * load, into a scratch directory outside the repo.
 *
 * The admin build is not incidental — it is what gives the consumer assertions
 * teeth. Every "absent from consumer" check is paired with "present in admin",
 * so a build that emitted nothing at all, or a marker string that stopped
 * matching anything, fails loudly instead of passing vacuously.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SURFACES, EDITION, surfaceByPath, entitledSurfaces, routableSurfaces } from '@/surfaces';
import { visibleTabs } from '@/pages/atlas/AtlasCoreScreen';
import { visibleSettingsTabs } from '@/pages/atlas/AtlasSettings';
import { SURFACE_ICONS } from '@/components/atlas-ui/surfaceIcons';

const SRC = join(import.meta.dir);
const ROOT = join(SRC, '..');
const REGISTRY_FILE = join(SRC, 'surfaces.ts');
const APP_FILE = join(SRC, 'App.tsx');

type Edition = 'consumer' | 'admin';

// ── the probe: the real route table, rendered in a real consumer graph ───────

interface Probe {
  edition: string;
  path: string;
  notFound: boolean;
  pending: boolean;
  routed: string[];
  dockKept: string[];
  error: string | null;
}

function probe(edition: Edition, path: string): Probe {
  const r = Bun.spawnSync({
    cmd: ['bun', join(ROOT, 'scripts/edition-probe.tsx'), path],
    cwd: ROOT,
    env: { ...process.env, VITE_ATLAS_EDITION: edition },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = r.stdout.toString().trim();
  if (r.exitCode !== 0 || !out) {
    throw new Error(`edition-probe(${edition}, ${path}) failed: ${r.stderr.toString()}`);
  }
  // React logs a suspense warning to stderr on some paths; only the last stdout
  // line is the payload.
  return JSON.parse(out.split('\n').at(-1)!) as Probe;
}

// ── the builds ──────────────────────────────────────────────────────────────

/** `['./pages/atlas/AtlasBanking', …]`, read out of the registry's ADMIN_LOADERS. */
const ADMIN_MODULES: string[] = (() => {
  const src = readFileSync(REGISTRY_FILE, 'utf8');
  const start = src.indexOf('const ADMIN_LOADERS');
  const end = src.indexOf('} : {};', start);
  if (start < 0 || end < 0) throw new Error('surfaces.ts: could not find the ADMIN_LOADERS table');
  return [...src.slice(start, end).matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]);
})();

/** `'./pages/atlas/AtlasBanking'` → `'AtlasBanking'`, the name Vite gives the chunk. */
const chunkName = (spec: string) => spec.split('/').at(-1)!;

const OUT = mkdtempSync(join(tmpdir(), 'atlas-edition-'));

function build(edition: Edition): string[] {
  const dir = join(OUT, edition);
  const r = Bun.spawnSync({
    cmd: ['bunx', 'vite', 'build', '--outDir', dir, '--emptyOutDir'],
    cwd: ROOT,
    env: { ...process.env, VITE_ATLAS_EDITION: edition },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) {
    throw new Error(`vite build (${edition}) failed:\n${r.stderr.toString()}\n${r.stdout.toString()}`);
  }
  return readdirSync(join(dir, 'assets'));
}

const FILES: Record<Edition, string[]> = { consumer: build('consumer'), admin: build('admin') };

const contents = (edition: Edition): string => {
  const dir = join(OUT, edition, 'assets');
  return FILES[edition]
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
};
const BODY: Record<Edition, string> = { consumer: contents('consumer'), admin: contents('admin') };

// ── routing ─────────────────────────────────────────────────────────────────

describe('an admin path in a consumer build is unknown, not hidden', () => {
  test('/model-lab renders the 404 page', () => {
    const p = probe('consumer', '/model-lab');
    expect(p.error).toBeNull();
    expect(p.edition).toBe('consumer');
    expect(p.notFound).toBe(true);
  });

  test('…and renders the page itself in an admin build', () => {
    // The teeth: if `notFound` were true everywhere — a broken probe, an empty
    // route table — the assertion above would mean nothing.
    const p = probe('admin', '/model-lab');
    expect(p.notFound).toBe(false);
    expect(p.pending).toBe(true);
  });

  test('every admin path 404s in a consumer build', () => {
    const consumerRouted = new Set(probe('consumer', '/').routed);
    const admin = SURFACES.filter((s) => s.edition === 'admin').map((s) => s.path);
    expect(admin.length).toBeGreaterThan(0);
    expect(admin.filter((p) => consumerRouted.has(p))).toEqual([]);
  });

  test('every consumer path still routes in a consumer build', () => {
    const routed = new Set(probe('consumer', '/').routed);
    const consumer = SURFACES.filter((s) => s.edition === 'consumer').map((s) => s.path);
    expect(consumer.filter((p) => !routed.has(p))).toEqual([]);
    expect(probe('consumer', '/mail').notFound).toBe(false);
  });

  test('the dock cannot link to a screen this edition does not ship', () => {
    // A registered-but-unrouted path is dropped; an unknown path is kept, so a
    // typo still 404s loudly instead of silently deleting a button.
    expect(probe('consumer', '/').dockKept).toEqual(['/mail', '/not-a-surface']);
    expect(probe('admin', '/').dockKept).toEqual(['/mail', '/model-lab', '/not-a-surface']);
  });
});

/**
 * The OTHER gate, and it is not the edition one.
 *
 * `edition` is decided by the build: the admin screens are absent from a
 * consumer bundle, which is what every test above measures. `feature` is
 * decided by the account in front of us — the page ships, and the entitlement
 * says whether it has a route. That check cannot be observed in the bundle at
 * all, so it is observed here, on the pure derivation the router calls.
 *
 * No surface sets `feature` yet, so the gated case is constructed. That is
 * deliberate: adding a real surface to prove the mechanism would change the
 * hardcoded counts in surfaces.test.ts and ship a screen nobody asked for.
 */
describe('a surface may also be gated on an entitlement', () => {
  test('a surface carrying `feature` does not route when the entitlement is absent', () => {
    const base = routableSurfaces[0];
    const gated = { ...base, meta: { ...base.meta, feature: 'clock-pro' } };

    expect(entitledSurfaces(() => false, [gated])).toEqual([]);
    // …and it comes back the moment the account has it, so this is a gate and
    // not a deletion — the same distinction the tab-strip tests draw.
    expect(entitledSurfaces((f) => f === 'clock-pro', [gated])).toEqual([gated]);
    // A different feature is not a near miss.
    expect(entitledSurfaces((f) => f === 'clock-basic', [gated])).toEqual([]);
  });

  test('an ungated surface is untouched by the gate', () => {
    // The check is asked about nothing, so a signed-out account still gets the
    // whole table. A gate that fired on every surface would be catastrophic and
    // otherwise silent.
    expect(entitledSurfaces(() => false).length).toBe(routableSurfaces.length);
    expect(SURFACES.filter((s) => s.feature).map((s) => s.path)).toEqual([]);
  });

  test('the router routes the gated table, not the raw one', () => {
    // Without this, `feature` could be declared, tested in isolation and never
    // applied — which is precisely how `consumerTabs` sat inert for weeks.
    const src = readFileSync(join(SRC, 'AppRoutes.tsx'), 'utf8');
    const code = src.slice(src.indexOf('*/') + 2);
    expect(code.includes('entitledSurfaces(')).toBe(true);
    expect(code.includes('routableSurfaces'), 'AppRoutes still maps the ungated table').toBe(false);
  });
});

// ── the bundle ──────────────────────────────────────────────────────────────

describe('the consumer bundle does not contain the admin screens', () => {
  test('the admin loader table was parsed', () => {
    // Guards the regex: if ADMIN_LOADERS is reformatted, every check below
    // would pass over an empty list.
    expect(ADMIN_MODULES.length).toBe(SURFACES.filter((s) => s.edition === 'admin').length);
  });

  test('no admin page module is emitted as a chunk', () => {
    const present = ADMIN_MODULES.filter((m) =>
      FILES.consumer.some((f) => f.startsWith(`${chunkName(m)}-`)));
    expect(present).toEqual([]);
  });

  test('…and every one of them IS emitted by the admin build', () => {
    const missing = ADMIN_MODULES.filter((m) =>
      !FILES.admin.some((f) => f.startsWith(`${chunkName(m)}-`)));
    expect(missing).toEqual([]);
  });

  test('no admin page CODE is inlined into a consumer chunk', () => {
    // Independent of chunk naming: these strings are written in the admin
    // pages' own JSX and survive minification. A tree-shake that merged an
    // admin page into a shared chunk instead of dropping it would be caught
    // here and nowhere else.
    // 'HomeKit Accessory Simulator' is the HomeKit lab's — a phrase that
    // appears nowhere else in the tree, in the one paragraph the page exists
    // to print. A consumer build containing it would be shipping a LAN pairing
    // tool to people who cannot use it and were never meant to see it.
    for (const marker of ['Atlas — Banking', 'Atlas — Model lab', 'Atlas — HomeKit lab', 'HomeKit Accessory Simulator']) {
      expect(BODY.admin.includes(marker), `${marker} missing from the admin build`).toBe(true);
      expect(BODY.consumer.includes(marker), `${marker} leaked into the consumer build`).toBe(false);
    }
  });

  test('mermaid ships only where a diagram does', () => {
    // ~1 MB of diagram engine reachable from /atlas-architecture alone.
    expect(BODY.admin.includes('sequenceDiagram')).toBe(true);
    expect(BODY.consumer.includes('sequenceDiagram')).toBe(false);
  });

  test('the consumer build is materially smaller', () => {
    expect(FILES.consumer.length).toBeLessThan(FILES.admin.length);
  });

  /**
   * THE SPLIT BELOW ROUTE GRANULARITY.
   *
   * Everything above this test is about whole screens, and for a while that
   * was the entire enforcement: `EDITION` was exported and imported by nothing
   * but itself, and `consumerTabs` was declared by the registry and read by
   * nothing at all. So a consumer build shipped the Atlas Core Agent tab (the
   * agent editor, the tool-call log, the approval queue, `system_prompt`), the
   * Live and Learning panels, and the entire Budget & AI settings tab —
   * emergency stop, spend history, per-tier token accounting — on the ENTRY
   * chunk, reachable from first paint.
   *
   * Hiding a tab does not remove its code, and this is the test that knows the
   * difference. Every marker is a string written in the admin-only component's
   * own source, so it survives minification and does not depend on chunk
   * names; each is paired with a present-in-admin assertion so a typo cannot
   * make the check pass vacuously.
   */
  test('no admin-only PANEL is inlined into a consumer chunk', () => {
    const markers = [
      // Atlas Core → Agent (AtlasAgentTab)
      'system_prompt', 'No agents yet', 'Run timeline', 'No schedules',
      // Atlas Core → Live and Learning (AtlasCoreAdminTabs)
      'atlas_provider_status', 'No providers reporting', 'Validation success',
      // Settings → Budget & AI (AtlasBudgetTab, BudgetSettingsPanel)
      'Emergency Stop', 'Usage & cost analytics', 'Token usage by tier', 'Spent (30d)',
    ];
    for (const marker of markers) {
      expect(BODY.admin.includes(marker), `${marker} missing from the admin build`).toBe(true);
      expect(BODY.consumer.includes(marker), `${marker} leaked into the consumer build`).toBe(false);
    }
  });

  /**
   * The OTHER half, and it is not implied by the one above: with the panels
   * lazily loaded, a filter that returned every tab would still produce a
   * consumer bundle containing no admin code — and a "Budget & AI" button that
   * renders nothing at all when pressed. The bundle test cannot see that. So
   * the filters are called directly, with the edition passed in, which is also
   * the only way to observe the consumer answer from a process that is pinned
   * to admin.
   */
  test('the consumer tab strips are filtered, not merely declared', () => {
    const coreKeys = visibleTabs('consumer').map((t) => t.key);
    // As a set: the registry lists what is allowed, TABS decides the order the
    // strip is drawn in, and the filter must not reorder the strip.
    expect([...coreKeys].sort()).toEqual([...surfaceByPath('/atlas-core')!.consumerTabs!].sort());
    for (const hidden of ['live', 'agent', 'learning']) {
      expect(coreKeys.includes(hidden), `Atlas Core still offers '${hidden}' to consumers`).toBe(false);
    }
    // …and admin keeps all eight, so the filter is a split and not a deletion.
    expect(visibleTabs('admin').length).toBeGreaterThan(coreKeys.length);
    for (const shown of ['live', 'agent', 'learning']) {
      expect(visibleTabs('admin').some((t) => t.key === shown)).toBe(true);
    }

    const settingsKeys = visibleSettingsTabs('consumer').map((t) => t.key);
    expect(settingsKeys.includes('budget'), 'Settings still offers Budget & AI to consumers').toBe(false);
    expect(visibleSettingsTabs('admin').some((t) => t.key === 'budget')).toBe(true);
    // Everything else survives — a gate, not an amputation.
    expect(settingsKeys.length).toBe(visibleSettingsTabs('admin').length - 1);
  });

  test('no tab is on a strip without a panel behind it, or the reverse', () => {
    // A tab whose panel is admin-only must not be offered to consumers, and a
    // tab that IS offered must have a panel that ships. The dispatcher's
    // admin-only cases are read from its source; the strip comes from the
    // filter. This is what makes "hidden" and "absent" the same set.
    const dispatcher = readFileSync(join(SRC, 'components/atlas-ui/AtlasCoreTabs.tsx'), 'utf8');
    const adminOnlyCases = [...dispatcher.matchAll(/case '(\w+)': return adminOnly\(/g)].map((m) => m[1]);
    expect(adminOnlyCases.sort()).toEqual(['agent', 'learning', 'live']);
    for (const key of adminOnlyCases) {
      expect(visibleTabs('consumer').some((t) => t.key === key)).toBe(false);
    }
  });
});

// ── the wiring that makes the above true ────────────────────────────────────

describe('one registry drives the router, the dock and the menu', () => {
  test('App.tsx declares no route by hand', () => {
    // The generated table is the only route table. A single hand-written
    // <Route> would be a screen the registry does not know about — and, in a
    // consumer build, potentially an admin screen that survived the split.
    const app = readFileSync(APP_FILE, 'utf8');
    expect([...app.matchAll(/<Route\b/g)].length).toBe(0);
  });

  test('every eager surface is actually routed eagerly', () => {
    // AppRoutes cannot import the eager pages itself (it must stay renderable
    // under a test runner), so App.tsx supplies them. A surface marked eager
    // with no override would silently become a lazy chunk fetch on the cold
    // start it was marked eager to protect.
    const app = readFileSync(APP_FILE, 'utf8');
    const block = app.slice(app.indexOf('const ROUTE_OVERRIDES'));
    const overridden = new Set([...block.slice(0, block.indexOf('};')).matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]));
    expect(overridden.size).toBeGreaterThan(0);
    for (const s of SURFACES.filter((s) => s.eager)) {
      expect(overridden.has(s.path), `${s.path} is eager but has no route override`).toBe(true);
    }
  });

  test('the account menu is generated, not listed', () => {
    // It was a hand-written list of 17 buttons that had already drifted from
    // the pages it linked. Any literal path in this file is that list coming
    // back.
    const menu = readFileSync(join(SRC, 'components/atlas-ui/AccountMenu.tsx'), 'utf8');
    const code = menu.slice(menu.indexOf('*/') + 2);
    expect([...code.matchAll(/go\('\//g)].length).toBe(0);
  });

  test('every icon the registry names resolves, and none is spare', () => {
    const named = new Set(SURFACES.map((s) => s.icon));
    expect([...named].filter((n) => !SURFACE_ICONS[n])).toEqual([]);
    expect(Object.keys(SURFACE_ICONS).filter((n) => !named.has(n))).toEqual([]);
  });

  test('this file itself ran in the default (admin) edition', () => {
    // Everything above is stated relative to that assumption.
    expect(EDITION).toBe('admin');
  });
});
