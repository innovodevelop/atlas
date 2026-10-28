/**
 * The cutover model, on trees small enough to read.
 *
 * `src/betaCutover.test.ts` runs the same code on the real app; this file pins
 * the rules it is built from — what counts as an import, what counts as the
 * flag-off side of a check, what a moved panel drags along — so a wrong answer
 * on the real tree can be traced to a rule rather than argued about.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildInventory,
  classifySurfaces,
  cssClasses,
  exportClosure,
  isBetaModule,
  normalizePath,
  parseBetaOverrides,
  parseLoaderTable,
  parseModule,
  reach,
  resolveSpec,
  type Edge,
} from './betaCutover';

const byPath = (mod: ReturnType<typeof parseModule>, spec: string) => {
  const found = mod.imports.find((i) => i.spec === spec);
  if (!found) throw new Error(`no import of ${spec}`);
  return found;
};

describe('paths and names', () => {
  test('normalizes dot segments', () => {
    expect(normalizePath('src/pages/atlas/../../lib/./x.ts')).toBe('src/lib/x.ts');
    expect(normalizePath('./src//a')).toBe('src/a');
  });

  test('a Beta page is one named Beta<Name>', () => {
    expect(isBetaModule('./pages/atlas/BetaMail')).toBe(true);
    expect(isBetaModule('src/pages/BetaAuth.tsx')).toBe(true);
    expect(isBetaModule('./pages/atlas/AtlasMail')).toBe(false);
    expect(isBetaModule('./pages/atlas/Betamax')).toBe(false);
  });
});

describe('parseModule', () => {
  test('reads every import shape, and nothing in a comment', () => {
    const mod = parseModule('src/x.tsx', [
      "import A from './a';",
      "import type { T } from './t';",
      "import { type U, type V } from './uv';",
      "import W, { type X } from './wx';",
      "import './style.css';",
      "export { Y } from './y';",
      "export type { Z } from './z';",
      "// const Ghost = lazy(() => import('./ghost'));",
      '/* import Nope from "./nope"; */',
      "const L = lazy(() => import('./lazy'));",
      'const dyn = (n: string) => import(n);',
      'export default () => [A, W, L, dyn];',
    ].join('\n'));
    expect(mod.imports.map((i) => i.spec).sort()).toEqual(['./a', './lazy', './style.css', './t', './uv', './wx', './y', './z']);
    expect(byPath(mod, './t').typeOnly).toBe(true);
    expect(byPath(mod, './uv').typeOnly).toBe(true);
    expect(byPath(mod, './wx').typeOnly).toBe(false);
    expect(byPath(mod, './style.css').sideEffect).toBe(true);
    expect(byPath(mod, './y').reexport).toBe(true);
    expect(byPath(mod, './z').typeOnly).toBe(true);
    expect(byPath(mod, './lazy').dynamic).toBe(true);
    expect(byPath(mod, './a').line).toBe(1);
    expect(mod.opaqueDynamic).toEqual([11]);
  });

  test('marks imports that only the flag-off side of a check uses', () => {
    const mod = parseModule('src/x.tsx', [
      "import { isBetaUi as flagOn, useBetaUi } from '@/lib/betaFlag';",
      "import Beta from './Beta';",
      "import Old from './Old';",
      "import OldIf from './OldIf';",
      "import OldAnd from './OldAnd';",
      "import Both from './Both';",
      "import Unused from './Unused';",
      "import OldAlias from './OldAlias';",
      'export function Page() {',
      '  const beta = useBetaUi();',
      '  if (!flagOn()) OldIf();',
      '  const a = flagOn() ? Beta : Old;',
      '  const b = !flagOn() && OldAnd;',
      '  const c = flagOn() ? Both : Both;',
      '  const d = beta ? null : OldAlias;',
      "  const e = flagOn() ? null : import('./OldLazy');",
      '  return [a, b, c, d, e];',
      '}',
    ].join('\n'));
    const off = (spec: string) => byPath(mod, spec).flagOffOnly;
    expect(off('./Beta')).toBe(false);
    expect(off('./Old')).toBe(true);
    expect(off('./OldIf')).toBe(true);
    expect(off('./OldAnd')).toBe(true);
    expect(off('./Both')).toBe(false);
    expect(off('./Unused')).toBe(false);
    expect(off('./OldAlias')).toBe(true);
    expect(off('./OldLazy')).toBe(true);
    // The checks themselves are listed for the "remove the flag checks" step.
    expect(mod.flagSites.map((s) => `${s.line}:${s.name}`)).toEqual([
      '10:useBetaUi', '11:flagOn', '12:flagOn', '13:flagOn', '14:flagOn', '16:flagOn',
    ]);
  });

  test('a property that happens to share an import name is not a use of it', () => {
    const mod = parseModule('src/x.tsx', [
      "import { isBetaUi } from './lib/betaFlag';",
      "import Old from './Old';",
      'export const v = isBetaUi() ? { Old: 1 }.Old : Old;',
    ].join('\n'));
    expect(byPath(mod, './Old').flagOffOnly).toBe(true);
  });

  test('a file with no flag import has no flag-off imports', () => {
    const mod = parseModule('src/x.tsx', "import Old from './Old';\nconst isBetaUi = () => true;\nexport const v = isBetaUi() ? 1 : Old;");
    expect(byPath(mod, './Old').flagOffOnly).toBe(false);
    expect(mod.flagSites).toEqual([]);
  });

  test('a stylesheet contributes its @import lines only', () => {
    const mod = parseModule('src/a.css', "/* @import 'nope.css'; */\n@import './b.css';\n.x { color: red }");
    expect(mod.imports.map((i) => [i.spec, i.line])).toEqual([['./b.css', 2]]);
  });
});

describe('exportClosure', () => {
  const page = [
    "import { useA } from './a';",
    "import { b } from './b';",
    "import type { T } from './t';",
    "import Unrelated from './unrelated';",
    'const helper = () => useA();',
    'function deeper(): T { return helper() as T; }',
    'export function Panel() { return deeper(); }',
    'export type Key = "x" | "y";',
    'export const Other = () => [Unrelated, b];',
    'const local = 1;',
    'export { local as Renamed };',
    'export default function Page() { return [Panel, Other]; }',
  ].join('\n');

  test('follows local helpers to the imports a moved panel needs', () => {
    expect(exportClosure('src/p.tsx', page, ['Panel'])).toEqual({ specs: ['./a', './t'], whole: false, unknown: [] });
  });

  test('a type with no imports moves alone', () => {
    expect(exportClosure('src/p.tsx', page, ['Key'])).toEqual({ specs: [], whole: false, unknown: [] });
  });

  test('a renamed export resolves to its local', () => {
    expect(exportClosure('src/p.tsx', page, ['Renamed']).unknown).toEqual([]);
  });

  test('the default export, or a namespace, means the whole page', () => {
    const c = exportClosure('src/p.tsx', page, ['default']);
    expect(c.whole).toBe(true);
    expect(c.specs).toEqual(['./a', './b', './t', './unrelated']);
    expect(exportClosure('src/p.tsx', page, ['*']).whole).toBe(true);
  });

  test('names the file does not declare are reported', () => {
    expect(exportClosure('src/p.tsx', page, ['Missing']).unknown).toEqual(['Missing']);
  });
});

describe('resolveSpec', () => {
  const files = new Set(['src/lib/x.ts', 'src/pages/A.tsx', 'src/ui/index.ts', 'src/styles/a.css']);
  const has = (p: string) => files.has(p);

  test('follows the @ alias, relative paths, index files and stylesheets', () => {
    expect(resolveSpec('@/lib/x', 'src/main.tsx', has)).toEqual({ kind: 'module', path: 'src/lib/x.ts' });
    expect(resolveSpec('../lib/x', 'src/pages/A.tsx', has)).toEqual({ kind: 'module', path: 'src/lib/x.ts' });
    expect(resolveSpec('./ui', 'src/main.tsx', has)).toEqual({ kind: 'module', path: 'src/ui/index.ts' });
    expect(resolveSpec('./styles/a.css?inline', 'src/main.tsx', has)).toEqual({ kind: 'module', path: 'src/styles/a.css' });
    expect(resolveSpec('./pages/A.tsx', 'src/main.tsx', has)).toEqual({ kind: 'module', path: 'src/pages/A.tsx' });
  });

  test('names packages by their install name', () => {
    expect(resolveSpec('@tauri-apps/api/core', 'src/main.tsx', has)).toEqual({ kind: 'package', name: '@tauri-apps/api' });
    expect(resolveSpec('three/examples/jsm/x', 'src/main.tsx', has)).toEqual({ kind: 'package', name: 'three' });
  });

  test('says when it cannot', () => {
    expect(resolveSpec('./missing', 'src/main.tsx', has)).toEqual({ kind: 'unresolved' });
    expect(resolveSpec('/favicon.svg', 'src/main.tsx', has)).toEqual({ kind: 'asset' });
  });
});

describe('reach', () => {
  const e = (from: string, to: string, extra: Partial<Edge> = {}): Edge => ({
    from, to, line: 1, dynamic: false, typeOnly: false, flagOffOnly: false, names: [], ...extra,
  });
  const edges = [e('m', 'a'), e('a', 'b'), e('m', 'c', { flagOffOnly: true }), e('c', 'd')];

  test('walks every edge from the roots', () => {
    expect([...reach(['m'], edges)].sort()).toEqual(['a', 'b', 'c', 'd', 'm']);
  });

  test('honours deleted modules, dropped edges and edges still to come', () => {
    expect([...reach(['m'], edges, { removed: new Set(['a']), drop: (x) => x.flagOffOnly, extra: [e('m', 'x')] })].sort()).toEqual(['m', 'x']);
  });
});

describe('the registry and App.tsx, read as text', () => {
  test('the loader table, from both editions', () => {
    const t = parseLoaderTable([
      'const CONSUMER_LOADERS = {',
      "  '/': () => import('./pages/atlas/AtlasDashboard'),",
      "  '/mail': () => import('./pages/atlas/AtlasMail'),",
      '};',
      "const ADMIN_LOADERS = EDITION === 'admin' ? {",
      "  '/money': () => import('./pages/atlas/AtlasBanking'),",
      '} : {};',
      "export const SURFACES = [{ path: '/x' }];",
    ].join('\n'));
    expect([...t.entries()]).toEqual([
      ['/', './pages/atlas/AtlasDashboard'],
      ['/mail', './pages/atlas/AtlasMail'],
      ['/money', './pages/atlas/AtlasBanking'],
    ]);
  });

  test('the overrides, in each shape App.tsx writes them', () => {
    const o = parseBetaOverrides([
      'import { lazy } from "react";',
      'import AtlasDashboard from "./pages/atlas/AtlasDashboard";',
      'import BetaHome from "./pages/atlas/BetaHome";',
      'import BetaPermissions from "./pages/BetaPermissions";',
      'import AtlasPermissions from "./pages/AtlasPermissions";',
      'import { isBetaUi } from "./lib/betaFlag";',
      '// "/ghost": { Component: lazy(() => import("./pages/Ghost")) },',
      'const BETA_CONSUMER = {',
      '  "/mail": { Component: lazy(() => import("./pages/atlas/BetaMail")) },',
      '  "/permissions": { Component: BetaPermissions },',
      '};',
      'const BETA_ADMIN = import.meta.env.VITE_ATLAS_EDITION === "consumer" ? {} : (() => {',
      '  const BetaDevTools = lazy(() => import("./pages/atlas/BetaDevTools"));',
      '  return { "/tests": { Component: BetaDevTools }, "/versions": { Component: BetaDevTools } };',
      '})();',
      'const ROUTE_OVERRIDES = {',
      '  "/": { Component: isBetaUi() ? BetaHome : AtlasDashboard, wrap: (el) => el },',
      '  "/permissions": { Component: AtlasPermissions },',
      '  ...(isBetaUi() ? { ...BETA_CONSUMER, ...BETA_ADMIN } : {}),',
      '};',
    ].join('\n'));
    expect(o).toEqual([
      { path: '/mail', spec: './pages/atlas/BetaMail', via: 'BETA_CONSUMER' },
      { path: '/permissions', spec: './pages/BetaPermissions', via: 'BETA_CONSUMER' },
      { path: '/tests', spec: './pages/atlas/BetaDevTools', via: 'BETA_ADMIN' },
      { path: '/versions', spec: './pages/atlas/BetaDevTools', via: 'BETA_ADMIN' },
      { path: '/', spec: './pages/atlas/BetaHome', via: 'flag ternary' },
    ]);
  });

  test('classification: a Beta loader, then an override, then the allow-list, else missing', () => {
    const loaders = new Map([
      ['/a', './pages/BetaA'],
      ['/b', './pages/AtlasB'],
      ['/c', './pages/AtlasC'],
      ['/d', './pages/AtlasD'],
    ]);
    const c = classifySurfaces(['/a', '/b', '/c', '/d'], loaders, [{ path: '/b', spec: './pages/BetaB', via: 'BETA_CONSUMER' }], {
      '/c': { kind: 'no-design', why: 'test' },
    });
    expect(c.map((x) => x.kind)).toEqual(['beta-page', 'override', 'kept', 'missing']);
  });
});

describe('cssClasses', () => {
  test('reads selectors, never declaration values', () => {
    const css = [
      '/* .commented { } */',
      '.a, .b:hover > .c-d { transition: opacity .2s; background: url(x.png) }',
      '@media (max-width: 900.5px) { .e { color: red } }',
      '@keyframes k { from { opacity: 0 } to { opacity: 1 } }',
      'html[data-ui="beta"] .f::after { content: ".g" }',
    ].join('\n');
    expect(cssClasses(css)).toEqual(['a', 'b', 'c-d', 'e', 'f']);
  });
});

describe('buildInventory on a small app', () => {
  const tree = new Map<string, string>([
    ['src/main.tsx', "import App from './App';\nimport './styles/workshop.css';\nexport default App;"],
    ['src/lib/betaFlag.ts', 'export const isBetaUi = () => true;'],
    ['src/App.tsx', [
      "import { lazy } from 'react';",
      "import { isBetaUi } from './lib/betaFlag';",
      "import AtlasDash from './pages/AtlasDash';",
      "import BetaHome from './pages/BetaHome';",
      "import './surfaces';",
      "// const Ghost = lazy(() => import('./pages/Ghost'));",
      "const BETA_CONSUMER = { '/mail': { Component: lazy(() => import('./pages/BetaMail')) } };",
      "const BETA_ADMIN = import.meta.env.VITE_ATLAS_EDITION === 'consumer' ? {} : (() => {",
      "  const BetaTools = lazy(() => import('./pages/BetaTools'));",
      "  return { '/tools': { Component: BetaTools } };",
      '})();',
      "export default { '/': { Component: isBetaUi() ? BetaHome : AtlasDash }, ...(isBetaUi() ? { ...BETA_CONSUMER, ...BETA_ADMIN } : {}) };",
    ].join('\n')],
    ['src/surfaces.ts', [
      'export const CONSUMER_LOADERS = {',
      "  '/': () => import('./pages/AtlasDash'),",
      "  '/mail': () => import('./pages/AtlasMail'),",
      "  '/core': () => import('./pages/AtlasCore'),",
      '};',
      "export const ADMIN_LOADERS = true ? { '/tools': () => import('./pages/AtlasTools') } : {};",
    ].join('\n')],
    ['src/pages/AtlasDash.tsx', "import { Old } from '../components/Old';\nexport type Key = 'a';\nexport default function AtlasDash() { return Old; }"],
    ['src/pages/BetaHome.tsx', "import type { Key } from './AtlasDash';\nimport { shared } from '../lib/shared';\nexport default function BetaHome() { const k: Key = 'a'; return shared + k; }"],
    ['src/pages/AtlasMail.tsx', [
      "import { Old } from '../components/Old';",
      "import { dep } from '../lib/panelDep';",
      "import { shared } from '../lib/shared';",
      "import oldPkg from 'old-only-pkg';",
      "import '../styles/mail.css';",
      'const helper = () => dep;',
      'export function Panel() { return helper(); }',
      'export default function AtlasMail() { return [Old, shared, oldPkg]; }',
    ].join('\n')],
    ['src/pages/BetaMail.tsx', "import { Panel } from './AtlasMail';\nimport { shared } from '../lib/shared';\nexport default function BetaMail() { return [Panel(), shared, 'cardB']; }"],
    ['src/pages/AtlasCore.tsx', "import { Hero } from '../components/BetaScreenHero';\nexport default function AtlasCore() { return Hero; }"],
    ['src/pages/AtlasTools.tsx', 'export default function AtlasTools() { return null; }'],
    ['src/pages/BetaTools.tsx', 'export default function BetaTools() { return null; }'],
    ['src/components/Old.tsx', "import { other } from '../lib/oldOnly';\nexport const Old = other;"],
    ['src/components/BetaScreenHero.tsx', 'export const Hero = 1;'],
    ['src/lib/oldOnly.ts', 'export const other = 1;'],
    ['src/lib/oldOnly.test.ts', "import { other } from './oldOnly';\nexport default other;"],
    ['src/lib/panelDep.ts', 'export const dep = 1;'],
    ['src/lib/shared.ts', 'export const shared = 1;'],
    ['src/lib/orphan.ts', 'export const orphan = 1;'],
    ['src/styles/workshop.css', '.cardB { color: red }\n.unused { transition: opacity .2s }'],
    ['src/styles/mail.css', '.mail { color: red }'],
  ]);
  const inv = buildInventory(tree, { keep: { '/core': { kind: 'hero', why: 'test' } } });

  test('coverage reads all three kinds of override', () => {
    expect(inv.coverage.map((c) => `${c.path}:${c.kind}`)).toEqual(['/:override', '/mail:override', '/core:kept', '/tools:override']);
  });

  test('the replaced pages go, the kept one stays', () => {
    expect(inv.replaced.map((r) => r.page)).toEqual(['src/pages/AtlasDash.tsx', 'src/pages/AtlasMail.tsx', 'src/pages/AtlasTools.tsx']);
    expect(inv.kept.map((k) => k.page)).toEqual(['src/pages/AtlasCore.tsx']);
  });

  test('Beta code importing from a page that goes is a blocker, and its panel brings what it needs', () => {
    expect(inv.blockers.map((b) => [b.from, b.page, b.names, b.typeOnly, b.carries])).toEqual([
      ['src/pages/BetaHome.tsx', 'src/pages/AtlasDash.tsx', ['Key'], true, []],
      ['src/pages/BetaMail.tsx', 'src/pages/AtlasMail.tsx', ['Panel'], false, ['src/lib/panelDep.ts']],
    ]);
  });

  test('only the old UI: deleted; shared and carried: kept', () => {
    expect(inv.removable.map((r) => `${r.path}:${r.why}`)).toEqual([
      'src/components/Old.tsx:old UI only',
      'src/lib/oldOnly.ts:old UI only',
      'src/pages/AtlasDash.tsx:replaced page',
      'src/pages/AtlasMail.tsx:replaced page',
      'src/pages/AtlasTools.tsx:replaced page',
      'src/styles/mail.css:old UI only',
    ]);
    expect(inv.shared.map((s) => `${s.path}:${s.keptImporters}`)).toEqual(['src/lib/panelDep.ts:1', 'src/lib/shared.ts:2']);
  });

  test('the rest of the report', () => {
    expect(inv.flagOffEdges.map((e) => `${e.from}→${e.to}`)).toEqual(['src/App.tsx→src/pages/AtlasDash.tsx']);
    expect(inv.flagSites.map((s) => `${s.file}:${s.line}`)).toEqual(['src/App.tsx:12', 'src/App.tsx:12']);
    expect(inv.oldOnlyPackages).toEqual([{ name: 'old-only-pkg', usedBy: ['src/pages/AtlasMail.tsx'] }]);
    expect(inv.tests).toEqual([{ file: 'src/lib/oldOnly.test.ts', imports: ['src/lib/oldOnly.ts'] }]);
    expect(inv.deadToday.map((d) => d.path)).toEqual(['src/lib/orphan.ts']);
    expect(inv.workshopCss).toEqual([{ sheet: 'src/styles/workshop.css', classes: 2, usedAfter: 1, byModule: [{ path: 'src/pages/BetaMail.tsx', classes: ['cardB'] }] }]);
    expect(inv.unresolved).toEqual([]);
  });

  test('a Beta module importing a whole page keeps that page', () => {
    const t = new Map(tree);
    t.set('src/pages/BetaMail.tsx', "import AtlasMail from './AtlasMail';\nexport default function BetaMail() { return AtlasMail; }");
    const i = buildInventory(t, { keep: { '/core': { kind: 'hero', why: 'test' } } });
    expect(i.blockers.find((b) => b.page === 'src/pages/AtlasMail.tsx')?.whole).toBe(true);
    expect(i.replaced.find((r) => r.page === 'src/pages/AtlasMail.tsx')?.blocked).toBe(true);
    expect(i.removable.some((r) => r.path === 'src/pages/AtlasMail.tsx')).toBe(false);
    // Everything the page imports stays with it: AtlasDash still goes, so the
    // component both pages use turns from "old UI only" into "shared".
    expect(i.removable.some((r) => r.path === 'src/pages/AtlasDash.tsx')).toBe(true);
    expect(i.removable.some((r) => r.path === 'src/components/Old.tsx')).toBe(false);
    expect(i.shared.some((s) => s.path === 'src/components/Old.tsx')).toBe(true);
  });

  test('nothing is blocked on the small app as written', () => {
    expect(inv.replaced.every((r) => !r.blocked)).toBe(true);
  });
});
