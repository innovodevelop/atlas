/**
 * The cutover guard: every surface has a Beta page before the flag goes.
 *
 * Phase 8 turns `beta_ui` on by default and deletes the Workshop screens the
 * Beta replaced (docs/design-sync/beta-cutover.md). That is only mechanical if
 * every surface in the registry already has its Beta page — its loader is a
 * `Beta<Name>` page, or App.tsx hands its path to one in BETA_CONSUMER,
 * BETA_ADMIN or the "/" ternary — or is on a short, reasoned list of screens
 * that keep their Workshop page on purpose. A surface that lands with neither
 * would ride through the cutover as a Workshop screen inside the Beta shell,
 * and nobody would decide that; this file makes somebody decide it.
 *
 * Like `surfaces.test.ts`, it reads source text and never imports a page. The
 * reading itself lives in src/lib/betaCutover.ts and is pinned there on small
 * fixtures; here it runs on the real tree.
 *
 * ── WHEN THIS FAILS ────────────────────────────────────────────────────────
 *
 * A surface is "missing": give it a Beta page (name the page module
 * `Beta<Name>.tsx` and point the registry loader at it, or add an override to
 * BETA_CONSUMER / BETA_ADMIN in App.tsx), or, if it should stay a Workshop
 * screen, add it to KEEP_WORKSHOP in src/lib/betaCutover.ts with the reason.
 * An allow-list entry is "stale": its screen got a Beta page, so remove it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SURFACES } from '@/surfaces';
import {
  KEEP_WORKSHOP,
  OVERRIDE_MAPS,
  buildInventory,
  classifySurfaces,
  isBetaModule,
  parseBetaOverrides,
  parseLoaderTable,
  parseModule,
  resolveSpec,
} from '@/lib/betaCutover';
import { readTree } from '../scripts/beta-cutover-inventory';

const SRC = import.meta.dir;
const ROOT = join(SRC, '..');
const REGISTRY = 'src/surfaces.ts';
const APP = 'src/App.tsx';
const README = join(ROOT, 'design/current/design_handoff_atlas_beta/README.md');

const read = (repoPath: string): string => readFileSync(join(ROOT, repoPath), 'utf8');
const exists = (repoPath: string): boolean => existsSync(join(ROOT, repoPath));
/** A specifier as written in `from`, to the repo path it loads. */
const fileOf = (spec: string, from: string): string | null => {
  const r = resolveSpec(spec, from, exists);
  return r.kind === 'module' ? r.path : null;
};

const PATHS = SURFACES.map((s) => s.path);
const LOADERS = parseLoaderTable(read(REGISTRY));
const OVERRIDES = parseBetaOverrides(read(APP));
const COVERAGE = classifySurfaces(PATHS, LOADERS, OVERRIDES);
const verdictOf = (path: string) => COVERAGE.find((c) => c.path === path);

describe('the guard reads what it guards', () => {
  // Every check below passes vacuously on an empty parse, so the parse is
  // asserted first: a renamed map or a reshaped table fails here, by name.
  test('one loader per registered surface', () => {
    expect([...LOADERS.keys()].sort()).toEqual([...PATHS].sort());
  });

  test('both override maps were found', () => {
    for (const map of OVERRIDE_MAPS) {
      expect(OVERRIDES.some((o) => o.via === map), `${map} in App.tsx yielded no overrides`).toBe(true);
    }
  });

  test('"/" goes to the Beta Home while the flag is on', () => {
    expect(OVERRIDES.filter((o) => o.path === '/')).toEqual([{ path: '/', spec: './pages/atlas/BetaHome', via: 'flag ternary' }]);
  });
});

describe('every surface has a Beta page', () => {
  test('no surface is left without one', () => {
    const missing = COVERAGE.filter((c) => c.kind === 'missing').map((c) => `${c.path} (${c.kind === 'missing' ? c.workshop : ''})`);
    expect(
      missing,
      'These surfaces have no Beta page, no App.tsx override and no KEEP_WORKSHOP entry. See the header of src/betaCutover.test.ts.',
    ).toEqual([]);
  });

  test('every override is for a registered surface', () => {
    expect(OVERRIDES.map((o) => o.path).filter((p) => !PATHS.includes(p))).toEqual([]);
  });

  test('no path is overridden twice', () => {
    const paths = OVERRIDES.map((o) => o.path);
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
  });

  test('every override loads a Beta page that exists', () => {
    for (const o of OVERRIDES) {
      const file = fileOf(o.spec, APP);
      expect(file, `${o.path} → ${o.spec} does not resolve`).not.toBeNull();
      expect(isBetaModule(o.spec), `${o.path} → ${o.spec} is not a Beta<Name> page`).toBe(true);
    }
  });

  test('every loader resolves to a file', () => {
    for (const [path, spec] of LOADERS) expect(fileOf(spec, REGISTRY), `${path} → ${spec}`).not.toBeNull();
  });
});

describe('KEEP_WORKSHOP: each entry is a decision that is still true', () => {
  const entries = Object.entries(KEEP_WORKSHOP);

  test('every entry names a registered surface', () => {
    expect(entries.map(([p]) => p).filter((p) => !PATHS.includes(p))).toEqual([]);
  });

  test('no entry is stale: none of these has a Beta page yet', () => {
    const stale = entries.filter(([p]) => verdictOf(p)?.kind !== 'kept').map(([p]) => `${p} is now ${verdictOf(p)?.kind}`);
    expect(stale, 'Remove these from KEEP_WORKSHOP: their screens have a Beta page now.').toEqual([]);
  });

  test('a "hero" page still draws its Beta hero', () => {
    for (const [path, reason] of entries) {
      if (reason.kind !== 'hero') continue;
      const page = fileOf(LOADERS.get(path) ?? '', REGISTRY);
      expect(page, path).not.toBeNull();
      const imports = parseModule(page as string, read(page as string)).imports.map((i) => i.spec);
      expect(imports.some((s) => /components\/atlas\/BetaScreenHero$/.test(s)), `${page} no longer imports its hero`).toBe(true);
    }
  });

  test('a "superseded" screen points at a path that has a Beta page', () => {
    for (const [path, reason] of entries) {
      if (reason.kind !== 'superseded') continue;
      const by = verdictOf(reason.by)?.kind;
      expect(by === 'beta-page' || by === 'override', `${path} is superseded by ${reason.by}, which is ${by}`).toBe(true);
    }
  });

  // The handoff's screen map is the record of which screens were designed.
  // Skipped (visibly) once a later design pull moves the handoff out of
  // design/current, rather than failing on a file that is not this repo's code.
  test.skipIf(!existsSync(README))('the handoff agrees: designed screens are in its screen map, the rest are not', () => {
    const text = readFileSync(README, 'utf8');
    const from = text.indexOf('## Screen map');
    expect(from).toBeGreaterThan(-1);
    const section = text.slice(from);
    const end = section.indexOf('\n## ', 3);
    const rows = (end < 0 ? section : section.slice(0, end)).split('\n').filter((l) => l.startsWith('|')).join('\n');
    for (const [path, reason] of entries) {
      const name = (LOADERS.get(path) ?? '').split('/').pop() as string;
      const mapped = rows.includes(`${name}.tsx`);
      expect(mapped, `${path} (${name}) is "${reason.kind}" but the screen map ${mapped ? 'lists' : 'does not list'} it`).toBe(reason.kind !== 'no-design');
    }
  });
});

describe('the guard bites', () => {
  test('a new Workshop surface with no Beta page is reported', () => {
    const loaders = new Map([...LOADERS, ['/cutover-probe', './pages/atlas/AtlasCutoverProbe']]);
    const c = classifySurfaces([...PATHS, '/cutover-probe'], loaders, OVERRIDES);
    expect(c.filter((x) => x.kind === 'missing').map((x) => x.path)).toEqual(['/cutover-probe']);
  });

  test('a new surface that is a Beta page passes', () => {
    const loaders = new Map([...LOADERS, ['/cutover-probe', './pages/atlas/BetaCutoverProbe']]);
    const c = classifySurfaces([...PATHS, '/cutover-probe'], loaders, OVERRIDES);
    expect(c.filter((x) => x.kind === 'missing')).toEqual([]);
  });
});

describe('the inventory, on the real tree', () => {
  const inv = buildInventory(readTree(ROOT));
  const goes = new Set(inv.removable.map((r) => r.path));

  test('every Beta page that takes a route survives the cutover', () => {
    const beta = [
      ...OVERRIDES.map((o) => fileOf(o.spec, APP)),
      ...[...LOADERS.values()].filter(isBetaModule).map((s) => fileOf(s, REGISTRY)),
    ];
    expect(beta.filter((f) => f === null || goes.has(f))).toEqual([]);
  });

  test('no Workshop page on the allow-list is deleted', () => {
    expect(inv.kept.map((k) => k.page).filter((p) => goes.has(p))).toEqual([]);
  });

  test('nothing that stays imports a whole replaced page', () => {
    // A named panel can be moved out first; a page imported whole cannot go at all.
    expect(inv.blockers.filter((b) => b.whole).map((b) => `${b.from}:${b.line} → ${b.page}`)).toEqual([]);
    expect(inv.replaced.filter((r) => r.blocked)).toEqual([]);
  });

  test('every replaced page is on the deletion list', () => {
    expect(inv.replaced.map((r) => r.page).filter((p) => !goes.has(p))).toEqual([]);
    expect(inv.replaced.length).toBeGreaterThan(0);
  });

  test('every import in the app resolves', () => {
    expect(inv.unresolved).toEqual([]);
  });
});
