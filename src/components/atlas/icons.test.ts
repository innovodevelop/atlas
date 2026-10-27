import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_GROUPS, ICON_NAMES, ICON_PATHS } from './icons';

// The handoff's own data file, mirrored in design/current. The test reads it
// rather than importing it (it is an ES module written for a browser page), so
// a re-export of the set that drops or mangles a glyph fails here.
const SOURCE = join(import.meta.dir, '../../../design/current/design_handoff_atlas_beta/atlas-icon-data.js');

describe('icon set 1a Precision', () => {
  const src = readFileSync(SOURCE, 'utf8');
  // The bluetooth glyph starts with a relative move (`m7 7…`); match both cases.
  const glyphs = [...src.matchAll(/\['([^']+)', '([Mm][^']+)'\]/g)].map((m) => ({ name: m[1], d: m[2] }));
  const groups = [...src.matchAll(/^ {2}\['([^']+)', '([^']+)', \[/gm)].map((m) => m[1]);

  test('the handoff has the glyphs this test expects to compare', () => {
    expect(glyphs.length).toBe(123);
    expect(groups.length).toBe(9);
  });

  test('every glyph in the handoff is here, path for path', () => {
    for (const g of glyphs) {
      expect(ICON_PATHS[g.name as keyof typeof ICON_PATHS]).toBe(g.d);
    }
    expect(ICON_NAMES.length).toBe(glyphs.length);
  });

  test('the groups match', () => {
    expect(ICON_GROUPS.map((g) => g[0])).toEqual(groups);
  });

  test('the dock and top bar glyphs exist', () => {
    for (const n of ['home', 'core', 'teach', 'mail', 'architecture', 'voice', 'bluetooth', 'wi-fi', 'wi-fi off', 'battery', 'charging', 'mac', 'airpods', 'mic', 'send']) {
      expect(ICON_NAMES).toContain(n);
    }
  });
});
