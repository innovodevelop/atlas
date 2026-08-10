/**
 * The registry, pinned to reality.
 *
 * Thirteen pages exported a `surface` descriptor that nothing imported, and the
 * only thing wrong with them was that no one could tell when they went stale —
 * a route could vanish, a label could change, a page could be added, and the
 * exports would keep saying whatever they said the day they were written. The
 * registry replaces those three hand-written lists with one, which makes drift
 * *possible in one place instead of three* — it does not make it impossible.
 * This file is what makes it impossible.
 *
 * ── WHY THIS READS SOURCE TEXT INSTEAD OF IMPORTING THE PAGES ───────────────
 *
 * Importing 23 page modules to read one exported constant would pull in React
 * DOM, three canvas renderers, framer-motion, mermaid and every CSS file in the
 * suite under a test runner with no DOM. The facts being checked are static —
 * what the files SAY — so they are read statically. It also means a page whose
 * runtime is broken still gets its registration checked.
 *
 * The same argument applies to the loader table in `surfaces.ts`: the mapping
 * from path to module lives in an `import()` call, and the only way to learn it
 * without executing every thunk is to read the source. That is deliberate — the
 * alternative was a duplicate `module: '...'` string in the metadata, i.e. one
 * more thing to keep in sync, which is the disease.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SURFACES, EDITION, routableSurfaces, dockSurfaces, menuSurfaces, surfaceByPath } from '@/surfaces';

const SRC = join(import.meta.dir);
const PAGES_ROOT = join(SRC, 'pages');
const REGISTRY_FILE = join(SRC, 'surfaces.ts');
const APP_FILE = join(SRC, 'App.tsx');

/** Every .tsx under src/pages, recursively, as a path relative to src/. */
function pageFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) pageFiles(full, out);
    else if (e.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

interface ParsedSurface {
  file: string;
  path: string;
  label: string;
  icon: string;
  entry: string;
  mock: boolean;
  edition: string;
}

/**
 * Pull the `export const surface` VALUE out of a page's source.
 *
 * Two shapes exist in the tree: `export const surface = { … }` and, in
 * AtlasModelLab, `export const surface: { …type… } = { … }`. Slicing from the
 * first `= {` skips the annotation — otherwise `entry: 'dock' | 'menu';` in the
 * type would be read as the value. The block ends at the first line starting
 * at column 0 with `}`, which the annotation's `} = {` does not match.
 */
function parseSurface(file: string): ParsedSurface | null {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('export const surface');
  if (start < 0) return null;

  const rest = src.slice(start);
  const end = rest.search(/^\}[^\n]*;[ \t]*$/m);
  if (end < 0) throw new Error(`${file}: 'export const surface' has no closing line`);
  const block = rest.slice(0, end);

  const eq = block.indexOf('= {');
  if (eq < 0) throw new Error(`${file}: 'export const surface' has no '= {' value`);
  const value = block.slice(eq);

  const str = (key: string): string => {
    const m = value.match(new RegExp(`^\\s*${key}:\\s*'([^']*)'`, 'm'));
    if (!m) throw new Error(`${file}: surface is missing a '${key}' field`);
    return m[1];
  };
  const bool = (key: string): boolean => {
    const m = value.match(new RegExp(`^\\s*${key}:\\s*(true|false)`, 'm'));
    if (!m) throw new Error(`${file}: surface is missing a '${key}' field`);
    return m[1] === 'true';
  };

  return {
    file,
    path: str('path'),
    label: str('label'),
    icon: str('icon'),
    entry: str('entry'),
    mock: bool('mock'),
    edition: str('edition'),
  };
}

const PARSED: ParsedSurface[] = pageFiles(PAGES_ROOT)
  .map(parseSurface)
  .filter((p): p is ParsedSurface => p !== null)
  .sort((a, b) => a.path.localeCompare(b.path));

/** `'/money' → './pages/atlas/AtlasBanking'`, read out of the registry's own source. */
const LOADERS: Map<string, string> = (() => {
  const src = readFileSync(REGISTRY_FILE, 'utf8');
  const out = new Map<string, string>();
  const re = /^ {2}'([^']+)':\s*\(\)\s*=>\s*import\('([^']+)'\),$/gm;
  for (const m of src.matchAll(re)) out.set(m[1], m[2]);
  return out;
})();

describe('the surface registry covers every page, exactly once', () => {
  test('every page that registers a surface has a registry entry', () => {
    const registered = new Set(SURFACES.map((s) => s.path));
    const missing = PARSED.filter((p) => !registered.has(p.path));
    expect(missing.map((m) => `${m.path} (${m.file})`)).toEqual([]);
  });

  test('every registry entry is backed by a page that registers it', () => {
    const onDisk = new Set(PARSED.map((p) => p.path));
    const orphans = SURFACES.filter((s) => !onDisk.has(s.path)).map((s) => s.path);
    expect(orphans).toEqual([]);
  });

  test('no page is registered twice and no path is claimed twice', () => {
    const byPath = new Map<string, string[]>();
    for (const p of PARSED) byPath.set(p.path, [...(byPath.get(p.path) ?? []), p.file]);
    const dupes = [...byPath.entries()].filter(([, files]) => files.length > 1);
    expect(dupes).toEqual([]);

    const paths = SURFACES.map((s) => s.path);
    expect(paths.length).toBe(new Set(paths).size);
  });

  test('aliases do not collide with a canonical path or with each other', () => {
    const seen = new Set<string>();
    for (const s of SURFACES) {
      seen.add(s.path);
      for (const a of s.aliases ?? []) {
        expect(seen.has(a)).toBe(false);
        seen.add(a);
      }
    }
  });

  test('the count is the count — 24 pages, 24 entries', () => {
    // A bare number so that ADDING a page without registering it, or removing
    // one without unregistering it, fails here even if some other assertion is
    // relaxed later. Bump it deliberately when a real surface is added.
    expect(PARSED.length).toBe(24);
    expect(SURFACES.length).toBe(24);
  });
});

describe('registry entries and page exports agree field by field', () => {
  for (const p of PARSED) {
    test(`${p.path} matches its page`, () => {
      const entry = SURFACES.find((s) => s.path === p.path);
      expect(entry).toBeDefined();
      expect({ label: entry!.label, icon: entry!.icon, entry: entry!.entry, mock: entry!.mock, edition: entry!.edition })
        .toEqual({ label: p.label, icon: p.icon, entry: p.entry, mock: p.mock, edition: p.edition });
    });
  }
});

describe('every entry names a real route', () => {
  test('every entry has a loader, and every loader has an entry', () => {
    const paths = new Set(SURFACES.map((s) => s.path));
    expect([...LOADERS.keys()].filter((k) => !paths.has(k))).toEqual([]);
    expect([...paths].filter((p) => !LOADERS.has(p))).toEqual([]);
  });

  test('each loader imports the file that registers that path', () => {
    for (const [path, spec] of LOADERS) {
      // './pages/atlas/AtlasBanking' → src/pages/atlas/AtlasBanking.tsx
      const file = join(SRC, `${spec.replace(/^\.\//, '')}.tsx`);
      const parsed = PARSED.find((p) => p.file === file);
      expect(parsed, `${path} loads ${spec}, which registers no surface`).toBeDefined();
      expect(parsed!.path).toBe(path);
    }
  });

  test('the loader table was parsed at all', () => {
    // The regex above depends on one-line-per-entry formatting. If someone
    // reformats the table, every check in this describe passes vacuously —
    // so assert the shape was actually found.
    expect(LOADERS.size).toBe(SURFACES.length);
  });

  test('every route App.tsx still declares by hand is a registered path', () => {
    // Tolerant on purpose. Today App.tsx hand-writes `<Route path="…">`; the
    // next pass generates them from `routableSurfaces`, at which point there
    // are no literals left and this passes vacuously — correctly, because
    // drift is then impossible by construction. Until then it catches a route
    // that exists in the router but not in the registry.
    const app = readFileSync(APP_FILE, 'utf8');
    const declared = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');
    const unknown = declared.filter((p) => surfaceByPath(p) === undefined);
    expect(unknown).toEqual([]);
  });
});

describe('the consumer/admin split', () => {
  test('every entry is consumer or admin', () => {
    expect(SURFACES.filter((s) => s.edition !== 'consumer' && s.edition !== 'admin')).toEqual([]);
  });

  test('the classification is the agreed one', () => {
    const of = (e: string) => SURFACES.filter((s) => s.edition === e).map((s) => s.path).sort();
    expect(of('consumer')).toEqual([
      '/', '/atlas-core', '/atlas-teach', '/auth', '/health', '/home',
      '/mail', '/onboarding', '/permissions', '/settings', '/smart-home',
    ].sort());
    expect(of('admin')).toEqual([
      '/agent-view', '/answer-views', '/atlas-architecture', '/atlas-sphere',
      '/browser', '/design-sync', '/homekit-lab', '/model-lab', '/money', '/tests',
      '/versions', '/widget-sheet', '/widgets',
    ].sort());
  });

  test('/money and /browser are admin because they have no backend', () => {
    // The two surfaces that draw sample data. If either is ever reclassified
    // consumer, `mock` must be false first — a consumer never sees invented
    // numbers. This is the honesty rule expressed as an assertion.
    for (const s of SURFACES) {
      if (s.edition === 'consumer') expect(s.mock, `${s.path} is consumer but still mock`).toBe(false);
    }
  });

  test('/atlas-core names a restricted tab set, and every tab in it is real', () => {
    const core = SURFACES.find((s) => s.path === '/atlas-core')!;
    expect(core.consumerTabs?.length).toBeGreaterThan(0);

    // The keys are read from AtlasCoreScreen's own TABS array, so a renamed or
    // deleted tab fails here instead of silently dropping out of the filter.
    const src = readFileSync(join(SRC, 'pages/atlas/AtlasCoreScreen.tsx'), 'utf8');
    const tabsBlock = src.slice(src.indexOf('const TABS = ['));
    const real = new Set([...tabsBlock.slice(0, tabsBlock.indexOf('];')).matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]));
    expect(real.size).toBeGreaterThan(0);
    for (const t of core.consumerTabs!) expect(real.has(t), `no tab named '${t}'`).toBe(true);
  });
});

describe('the derived views the next pass consumes', () => {
  test('under bun the edition defaults to admin, so everything is routable', () => {
    // `import.meta.env` is an empty object outside Vite, so VITE_ATLAS_EDITION
    // reads undefined and lands on 'admin'. That default is load-bearing: an
    // unconfigured build must ship everything, never silently drop screens.
    expect(EDITION).toBe('admin');
    expect(routableSurfaces.length).toBe(SURFACES.length);
  });

  test('routable surfaces carry every path they answer to', () => {
    const dash = routableSurfaces.find((s) => s.meta.path === '/')!;
    expect(dash.paths).toEqual(['/', '/dashboard']);
    for (const s of routableSurfaces) expect(s.paths[0]).toBe(s.meta.path);
  });

  test('dock and menu are disjoint, and neither contains an unlinked surface', () => {
    const dock = new Set(dockSurfaces.map((s) => s.path));
    for (const s of menuSurfaces) expect(dock.has(s.path)).toBe(false);
    for (const s of [...dockSurfaces, ...menuSurfaces]) expect(s.entry).not.toBe('none');
  });

  test('devOnly surfaces are absent from a non-dev menu', () => {
    // `import.meta.env.DEV` is undefined under bun, i.e. a production-shaped
    // build — the sphere gallery must not be listed.
    expect(menuSurfaces.some((s) => s.path === '/atlas-sphere')).toBe(false);
    expect(SURFACES.some((s) => s.path === '/atlas-sphere' && s.devOnly)).toBe(true);
  });

  test('a path this build cannot render is still recognisable', () => {
    expect(surfaceByPath('/dashboard')?.path).toBe('/');
    expect(surfaceByPath('/money')?.label).toBe('Money');
    expect(surfaceByPath('/nope')).toBeUndefined();
  });
});
