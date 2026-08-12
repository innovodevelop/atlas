/**
 * Unit tests for the feature scaffolder's PURE parts.
 *
 * Everything under test is a string → string (or string → boolean/throw)
 * function with no disk access — `scripts/new-surface.ts` keeps its
 * insertion logic pure exactly so it can be exercised here without writing
 * into the repo. Nothing in this file calls `main()`, and nothing in this
 * file touches `fs.writeFileSync`.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCssTemplate,
  buildLoaderLine,
  buildPageTemplate,
  buildSpec,
  buildSurfaceEntryBlock,
  bumpSurfaceCounts,
  camelFromKebab,
  defaultLabel,
  ensureNewSurface,
  hasIconEntry,
  hasLoaderLine,
  hasSurfaceEntry,
  insertIconEntry,
  insertLoaderLine,
  insertSurfaceEntry,
  kebabCase,
  parseArgs,
  SURFACES_TEST_LOADER_REGEX,
  SurfaceExistsError,
} from './new-surface';

// ── naming ────────────────────────────────────────────────────────────────

describe('naming helpers', () => {
  test('kebabCase', () => {
    expect(kebabCase('Journal')).toBe('journal');
    expect(kebabCase('SmartHome')).toBe('smart-home');
    expect(kebabCase('HomeKitLab')).toBe('home-kit-lab');
    expect(kebabCase('HTTPServer')).toBe('http-server');
  });

  test('camelFromKebab', () => {
    expect(camelFromKebab('journal')).toBe('journal');
    expect(camelFromKebab('smart-home')).toBe('smartHome');
    expect(camelFromKebab('answer-views')).toBe('answerViews');
  });

  test('defaultLabel sentence-cases like the existing registry labels', () => {
    expect(defaultLabel('journal')).toBe('Journal');
    expect(defaultLabel('smart-home')).toBe('Smart home');
    expect(defaultLabel('widget-catalog')).toBe('Widget catalog');
  });
});

// ── spec ──────────────────────────────────────────────────────────────────

describe('buildSpec', () => {
  test('derives path, component name, css name and module spec from Name alone', () => {
    const spec = buildSpec({ name: 'Journal', icon: 'BookOpen' });
    expect(spec.path).toBe('/journal');
    expect(spec.componentName).toBe('AtlasJournal');
    expect(spec.cssName).toBe('journal');
    expect(spec.moduleSpec).toBe('./pages/atlas/AtlasJournal');
    expect(spec.label).toBe('Journal');
    expect(spec.entry).toBe('menu');
    expect(spec.edition).toBe('consumer');
    expect(spec.feature).toBeUndefined();
  });

  test('a multi-word Name kebabs and camels consistently across path/css/component', () => {
    const spec = buildSpec({ name: 'DailyBriefing', icon: 'Newspaper', label: 'Daily briefing' });
    expect(spec.path).toBe('/daily-briefing');
    expect(spec.cssName).toBe('dailyBriefing');
    expect(spec.componentName).toBe('AtlasDailyBriefing');
    expect(spec.label).toBe('Daily briefing');
  });

  test('explicit flags override the defaults', () => {
    const spec = buildSpec({
      name: 'Journal', icon: 'BookOpen', entry: 'dock', edition: 'admin', feature: 'journal-pro',
    });
    expect(spec.entry).toBe('dock');
    expect(spec.edition).toBe('admin');
    expect(spec.feature).toBe('journal-pro');
  });
});

// ── templates ────────────────────────────────────────────────────────────

describe('page + css templates', () => {
  const spec = buildSpec({ name: 'Journal', icon: 'BookOpen', label: 'Journal' });

  test('the page carries the surface export literal in the shape surfaces.test.ts parses', () => {
    const src = buildPageTemplate(spec);
    expect(src).toContain('export const surface = {');
    expect(src).toMatch(/path:\s*'\/journal'/);
    expect(src).toMatch(/label:\s*'Journal'/);
    expect(src).toMatch(/icon:\s*'BookOpen'/);
    expect(src).toMatch(/entry:\s*'menu'/);
    expect(src).toMatch(/mock:\s*false/);
    expect(src).toMatch(/edition:\s*'consumer'/);
    // The closing line must be recognisable by parseSurface's own regex:
    // a line starting at column 0 with `}` and ending `;`.
    expect(src).toMatch(/^\}[^\n]*;[ \t]*$/m);
  });

  test('an entry with --feature emits the feature field', () => {
    const gated = buildSpec({ name: 'Journal', icon: 'BookOpen', feature: 'journal-pro' });
    expect(buildPageTemplate(gated)).toMatch(/feature:\s*'journal-pro'/);
  });

  test('the page wires Esc-to-return via isTyping, and an Empty state', () => {
    const src = buildPageTemplate(spec);
    expect(src).toContain("import { isTyping } from './atlasHelpers';");
    expect(src).toContain("e.key !== 'Escape'");
    expect(src).toContain('isTyping(e.target)');
    expect(src).toContain('import { Empty } from');
    expect(src).toContain('<Empty');
  });

  test('the page imports and renders the requested icon', () => {
    const src = buildPageTemplate(spec);
    expect(src).toContain("import { BookOpen } from 'lucide-react';");
    expect(src).toContain('<BookOpen className="i20" />');
  });

  test('the page imports its own css and default-exports the component', () => {
    const src = buildPageTemplate(spec);
    expect(src).toContain("import '@/styles/surfaces/journal.css';");
    expect(src).toContain('export default AtlasJournal;');
  });

  test('the css carries the banner-comment convention and the page-scoped classes the template uses', () => {
    const src = buildCssTemplate(spec);
    expect(src).toMatch(/^\/\* ={10,}/);
    expect(src).toContain('.journal-page');
    expect(src).toContain('.journal-body');
  });
});

// ── SURFACES entry insertion ─────────────────────────────────────────────

describe('insertSurfaceEntry', () => {
  const FIXTURE = `export const SURFACES: readonly SurfaceMeta[] = [
  // ── CONSUMER ──────────────────────────────────────────────────────────────
  { path: '/', label: 'Dashboard', icon: 'Home', entry: 'dock', mock: false, edition: 'consumer' },
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
  { path: '/money', label: 'Money', icon: 'Landmark', entry: 'menu', mock: true, edition: 'admin' },
  {
    path: '/atlas-sphere',
    label: 'Sphere gallery',
    icon: 'Orbit',
    entry: 'menu',
    mock: false,
    edition: 'admin',
    devOnly: true,
  },
] as const;
`;

  const consumerBlock = buildSurfaceEntryBlock(
    buildSpec({ name: 'Journal', icon: 'BookOpen', label: 'Journal' }),
  );
  const adminBlock = buildSurfaceEntryBlock(
    buildSpec({ name: 'Journal', icon: 'BookOpen', label: 'Journal', edition: 'admin' }),
  );

  test('a consumer entry lands after the last consumer entry, before the ADMIN marker', () => {
    const out = insertSurfaceEntry(FIXTURE, 'consumer', consumerBlock);
    expect(out).toContain(consumerBlock);
    const permIdx = out.indexOf("path: '/permissions'");
    const journalIdx = out.indexOf("path: '/journal'");
    const adminMarkerIdx = out.indexOf('// ── ADMIN');
    expect(permIdx).toBeGreaterThan(-1);
    expect(journalIdx).toBeGreaterThan(permIdx);
    expect(adminMarkerIdx).toBeGreaterThan(journalIdx);
    // Exactly one blank line still separates the new last consumer entry
    // from the admin marker — the insertion must not eat or duplicate it.
    expect(out).toContain('\n\n  // ── ADMIN');
    // And no blank line was introduced between the two consumer entries.
    expect(out).not.toContain("eager: true,\n  },\n\n  {\n    path: '/journal'");
  });

  test('an admin entry lands after the last admin entry, before the array close', () => {
    const out = insertSurfaceEntry(FIXTURE, 'admin', adminBlock);
    const sphereIdx = out.indexOf("path: '/atlas-sphere'");
    const journalIdx = out.indexOf("path: '/journal'");
    const closeIdx = out.indexOf('] as const;');
    expect(journalIdx).toBeGreaterThan(sphereIdx);
    expect(closeIdx).toBeGreaterThan(journalIdx);
  });

  test('is idempotent: inserting the same path twice changes nothing the second time', () => {
    const once = insertSurfaceEntry(FIXTURE, 'consumer', consumerBlock);
    const twice = insertSurfaceEntry(once, 'consumer', consumerBlock);
    expect(twice).toBe(once);
  });

  test('hasSurfaceEntry', () => {
    expect(hasSurfaceEntry(FIXTURE, '/money')).toBe(true);
    expect(hasSurfaceEntry(FIXTURE, '/journal')).toBe(false);
  });
});

// ── loader-line insertion ────────────────────────────────────────────────

describe('loader line', () => {
  test('buildLoaderLine matches surfaces.test.ts\'s OWN loader regex', () => {
    const line = buildLoaderLine('/journal', './pages/atlas/AtlasJournal');
    expect(line).toBe("  '/journal': () => import('./pages/atlas/AtlasJournal'),");
    // Fresh RegExp: SURFACES_TEST_LOADER_REGEX carries the `g` flag and a
    // shared lastIndex would make a second assertion in this file flaky.
    const re = new RegExp(SURFACES_TEST_LOADER_REGEX.source, 'm');
    expect(re.test(line)).toBe(true);
    const m = line.match(re);
    expect(m?.[1]).toBe('/journal');
    expect(m?.[2]).toBe('./pages/atlas/AtlasJournal');
  });

  const LOADERS_FIXTURE = `const CONSUMER_LOADERS: Record<string, Loader> = {
  '/': () => import('./pages/atlas/AtlasDashboard'),
  '/permissions': () => import('./pages/AtlasPermissions'),
};

const ADMIN_LOADERS: Record<string, Loader> = EDITION === 'admin' ? {
  '/money': () => import('./pages/atlas/AtlasBanking'),
  '/atlas-sphere': () => import('./pages/AtlasSphereGallery'),
} : {};
`;

  test('a consumer loader line is appended inside CONSUMER_LOADERS, not ADMIN_LOADERS', () => {
    const line = buildLoaderLine('/journal', './pages/atlas/AtlasJournal');
    const out = insertLoaderLine(LOADERS_FIXTURE, 'consumer', line);
    const consumerBlock = out.slice(out.indexOf('CONSUMER_LOADERS'), out.indexOf('ADMIN_LOADERS'));
    expect(consumerBlock).toContain(line);
    const adminBlock = out.slice(out.indexOf('ADMIN_LOADERS'));
    expect(adminBlock).not.toContain(line);
    // Every produced line still satisfies the real parsing regex.
    const re = new RegExp(SURFACES_TEST_LOADER_REGEX.source, 'gm');
    const paths = [...out.matchAll(re)].map((m) => m[1]);
    expect(paths).toEqual(['/', '/permissions', '/journal', '/money', '/atlas-sphere']);
  });

  test('an admin loader line is appended inside ADMIN_LOADERS', () => {
    const line = buildLoaderLine('/journal', './pages/atlas/AtlasJournal');
    const out = insertLoaderLine(LOADERS_FIXTURE, 'admin', line);
    const adminBlock = out.slice(out.indexOf('ADMIN_LOADERS'));
    expect(adminBlock).toContain(line);
    expect(out.slice(0, out.indexOf('ADMIN_LOADERS'))).not.toContain(line);
  });

  test('is idempotent', () => {
    const line = buildLoaderLine('/journal', './pages/atlas/AtlasJournal');
    const once = insertLoaderLine(LOADERS_FIXTURE, 'consumer', line);
    const twice = insertLoaderLine(once, 'consumer', line);
    expect(twice).toBe(once);
  });

  test('hasLoaderLine', () => {
    expect(hasLoaderLine(LOADERS_FIXTURE, '/money')).toBe(true);
    expect(hasLoaderLine(LOADERS_FIXTURE, '/journal')).toBe(false);
  });
});

// ── icon insertion ────────────────────────────────────────────────────────

describe('insertIconEntry', () => {
  const ICONS_FIXTURE = `import type { ComponentType } from 'react';
import {
  CircleDot, Compass, Cpu, FlaskConical, GitBranch, GraduationCap, HeartPulse,
  Home, Landmark, Layers, LayoutGrid, LogIn, Mail, Mic, Monitor, Network, Orbit,
  Palette, Settings, ShieldCheck, Sparkles, TestTube2,
} from 'lucide-react';

export type IconComponent = ComponentType<{ className?: string }>;

export const SURFACE_ICONS: Readonly<Record<string, IconComponent>> = {
  Compass, Cpu, FlaskConical, GitBranch, GraduationCap, HeartPulse,
  Home, Landmark, Layers, LayoutGrid, LogIn, Mail, Mic, Monitor, Network, Orbit,
  Palette, Settings, ShieldCheck, Sparkles, TestTube2,
};

export const surfaceIcon = (name: string): IconComponent => SURFACE_ICONS[name] ?? CircleDot;
`;

  test('adds the icon to both the import list and the SURFACE_ICONS map', () => {
    const out = insertIconEntry(ICONS_FIXTURE, 'BookOpen');
    const importBlock = out.slice(out.indexOf('import {'), out.indexOf("} from 'lucide-react';"));
    expect(importBlock).toMatch(/\bBookOpen\b/);
    const mapBlock = out.slice(
      out.indexOf('export const SURFACE_ICONS'),
      out.indexOf('export const surfaceIcon'),
    );
    expect(mapBlock).toMatch(/\bBookOpen\b/);
  });

  test('keeps both lists alphabetised', () => {
    const out = insertIconEntry(ICONS_FIXTURE, 'BookOpen');
    const importBlock = out.slice(out.indexOf('import {') + 'import {'.length, out.indexOf("} from 'lucide-react';"));
    const names = importBlock.split(',').map((s) => s.trim()).filter(Boolean);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain('BookOpen');
  });

  test('an already-present icon (e.g. Home) is left untouched — no duplicate', () => {
    const out = insertIconEntry(ICONS_FIXTURE, 'Home');
    expect(out).toBe(ICONS_FIXTURE);
  });

  test('is idempotent for a genuinely new icon', () => {
    const once = insertIconEntry(ICONS_FIXTURE, 'BookOpen');
    const twice = insertIconEntry(once, 'BookOpen');
    expect(twice).toBe(once);
    // Only one BookOpen in the map, not two.
    const mapBlock = twice.slice(
      twice.indexOf('export const SURFACE_ICONS'),
      twice.indexOf('export const surfaceIcon'),
    );
    expect(mapBlock.match(/\bBookOpen\b/g)?.length).toBe(1);
  });

  test('the output still parses as a valid identifier list (no stray commas/newlines)', () => {
    const out = insertIconEntry(ICONS_FIXTURE, 'BookOpen');
    const importBlock = out.slice(out.indexOf('import {') + 'import {'.length, out.indexOf("} from 'lucide-react';"));
    for (const line of importBlock.split('\n').map((l) => l.trim()).filter(Boolean)) {
      expect(line).toMatch(/^[A-Za-z0-9, ]+,$/);
    }
  });

  test('hasIconEntry', () => {
    expect(hasIconEntry(ICONS_FIXTURE, 'Home')).toBe(true);
    expect(hasIconEntry(ICONS_FIXTURE, 'BookOpen')).toBe(false);
  });
});

// ── count bumping ────────────────────────────────────────────────────────

describe('bumpSurfaceCounts', () => {
  test('bumps both hardcoded counts by 1 when they agree', () => {
    const src = `test('the count is the count', () => {
  expect(PARSED.length).toBe(24);
  expect(SURFACES.length).toBe(24);
});`;
    const out = bumpSurfaceCounts(src);
    expect(out).toContain('expect(PARSED.length).toBe(25);');
    expect(out).toContain('expect(SURFACES.length).toBe(25);');
  });

  test('throws loudly if the two counts disagree, and writes nothing', () => {
    const src = `expect(PARSED.length).toBe(24);\nexpect(SURFACES.length).toBe(23);`;
    expect(() => bumpSurfaceCounts(src)).toThrow(/disagree/);
  });

  test('throws loudly if the shape is not exactly two counts', () => {
    expect(() => bumpSurfaceCounts('expect(PARSED.length).toBe(24);')).toThrow(/expected exactly 2/);
    expect(() => bumpSurfaceCounts('no counts here at all')).toThrow(/expected exactly 2/);
  });
});

// ── refuses-when-exists ──────────────────────────────────────────────────

describe('ensureNewSurface (the refuses-when-exists path)', () => {
  test('does nothing when the page does not already exist', () => {
    expect(() => ensureNewSurface(false, 'src/pages/atlas/AtlasJournal.tsx')).not.toThrow();
  });

  test('refuses cleanly, with the path in the message, when it does', () => {
    let caught: unknown;
    try {
      ensureNewSurface(true, 'src/pages/atlas/AtlasMail.tsx');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SurfaceExistsError);
    expect((caught as Error).message).toContain('src/pages/atlas/AtlasMail.tsx');
    expect((caught as Error).message).toContain('already exists');
  });
});

// ── CLI parsing ──────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('parses the documented shape', () => {
    const args = parseArgs(['Journal', '--label', 'Journal', '--icon', 'BookOpen']);
    expect(args).toEqual({ name: 'Journal', label: 'Journal', icon: 'BookOpen', entry: undefined, edition: undefined, feature: undefined });
  });

  test('parses all optional flags', () => {
    const args = parseArgs([
      'Journal', '--label', 'Journal', '--icon', 'BookOpen',
      '--entry', 'dock', '--edition', 'admin', '--feature', 'journal-pro',
    ]);
    expect(args.entry).toBe('dock');
    expect(args.edition).toBe('admin');
    expect(args.feature).toBe('journal-pro');
  });

  test('rejects a missing Name', () => {
    expect(() => parseArgs(['--icon', 'BookOpen'])).toThrow(/Name/);
  });

  test('rejects a lowercase Name', () => {
    expect(() => parseArgs(['journal', '--icon', 'BookOpen'])).toThrow(/PascalCase/);
  });

  test('rejects a missing --icon', () => {
    expect(() => parseArgs(['Journal'])).toThrow(/--icon/);
  });

  test('rejects an invalid --entry', () => {
    expect(() => parseArgs(['Journal', '--icon', 'BookOpen', '--entry', 'sidebar'])).toThrow(/--entry/);
  });

  test('rejects an invalid --edition', () => {
    expect(() => parseArgs(['Journal', '--icon', 'BookOpen', '--edition', 'internal'])).toThrow(/--edition/);
  });

  test('rejects a flag with no value', () => {
    expect(() => parseArgs(['Journal', '--icon'])).toThrow(/needs a value/);
  });
});
