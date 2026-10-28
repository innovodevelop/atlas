import { describe, expect, test } from 'bun:test';
import {
  agoLabel, coreEscapeStep, coreHeroLine, coreOverviewTiles, coreTabFromHash, coreTabIntro,
  coreTabStrip, healthTone, indexingRow, researchRunning, researchTag,
} from './betaCore';
import { ICON_PATHS } from '@/components/atlas/icons';

const TABS = [
  { key: 'search', label: 'Search' },
  { key: 'overview', label: 'Overview' },
  { key: 'live', label: 'Live', live: true },
  { key: 'agent', label: 'Agent' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'research', label: 'Research' },
  { key: 'learning', label: 'Learning' },
  { key: 'memory', label: 'Memory' },
];
const CONSUMER = TABS.filter((t) => !['live', 'agent', 'learning'].includes(t.key));

describe('the tab strip', () => {
  test('keeps the order and the set it is given — the edition filter stays the screen’s', () => {
    expect(coreTabStrip(CONSUMER, 'overview').map((t) => t.key)).toEqual(CONSUMER.map((t) => t.key));
    expect(coreTabStrip(TABS, 'overview').map((t) => t.key)).toEqual(TABS.map((t) => t.key));
  });

  test('marks the open tab, the live pulse and the admin note', () => {
    const strip = coreTabStrip(TABS, 'agent');
    expect(strip.filter((t) => t.current).map((t) => t.key)).toEqual(['agent']);
    expect(strip.find((t) => t.key === 'live')?.live).toBe(true);
    expect(strip.find((t) => t.key === 'search')?.live).toBe(false);
    // The admin note sits on admin tabs that are not open, as in the design.
    expect(strip.filter((t) => t.adminNote).map((t) => t.key).sort()).toEqual(['learning', 'live']);
  });

  test('every tab draws a real glyph from the Precision set', () => {
    for (const t of coreTabStrip(TABS, 'overview')) expect(ICON_PATHS[t.icon]).toBeTruthy();
  });
});

describe('intros and deep links', () => {
  test('consumer tabs carry their own intro; admin tabs read theirs from the screen', () => {
    expect(coreTabIntro('search')).toContain('Search everything');
    expect(coreTabIntro('live', { live: 'The raw stream.' })).toBe('The raw stream.');
    // Without the admin copy (a consumer build) it falls back, never empty.
    expect(coreTabIntro('live')).toBe(coreTabIntro('overview'));
  });

  test('a hash opens a tab only if this edition shows it', () => {
    const keys = CONSUMER.map((t) => t.key);
    expect(coreTabFromHash('#memory', keys)).toBe('memory');
    expect(coreTabFromHash('#MEMORY', keys)).toBe('memory');
    expect(coreTabFromHash('#agent', keys)).toBeNull();
    expect(coreTabFromHash('', keys)).toBeNull();
    expect(coreTabFromHash('#nope', keys)).toBeNull();
  });

  test('Esc steps out one level', () => {
    expect(coreEscapeStep('memory')).toBe('overview');
    expect(coreEscapeStep('overview')).toBe('home');
  });
});

describe('the overview', () => {
  test('the knowledge line follows the real research count', () => {
    expect(coreHeroLine(0)).toBe('Nothing is running in the background right now.');
    expect(coreHeroLine(1)).toContain('1 topic ');
    expect(coreHeroLine(3)).toContain('3 topics');
  });

  test('tiles show the numbers they are handed and nothing else', () => {
    const tiles = coreOverviewTiles({ activeResearch: 2, queued: 1, errorRate: 0, healthScore: 100 });
    expect(tiles.map((t) => [t.key, t.value])).toEqual([['research', '2'], ['queued', '1'], ['errors', '0.0%'], ['health', '100%']]);
    expect(tiles.find((t) => t.key === 'queued')?.detail).toBe('topic waiting to start');
    expect(tiles.find((t) => t.key === 'errors')?.tone).toBe('ink');
    expect(tiles.find((t) => t.key === 'health')?.tone).toBe('good');
    const bad = coreOverviewTiles({ activeResearch: 0, queued: 0, errorRate: 40, healthScore: 60 });
    expect(bad.find((t) => t.key === 'errors')?.tone).toBe('bad');
    expect(bad.find((t) => t.key === 'health')?.tone).toBe('bad');
    for (const t of tiles) expect(ICON_PATHS[t.icon]).toBeTruthy();
  });

  test('before the health read lands, the tiles show dashes, not a measured zero', () => {
    const tiles = coreOverviewTiles(null);
    expect(tiles.map((t) => t.value)).toEqual(['—', '—', '—', '—']);
    expect(tiles.every((t) => t.tone === 'ink')).toBe(true);
  });

  test('health tone bands', () => {
    expect(healthTone(95)).toBe('good');
    expect(healthTone(90)).toBe('good');
    expect(healthTone(80)).toBe('ink');
    expect(healthTone(69)).toBe('bad');
  });

  test('research tags and which rows can pause', () => {
    expect(researchTag('researching')).toEqual({ label: 'Researching', tone: 'blue' });
    expect(researchTag('queued').tone).toBe('neutral');
    expect(researchTag('paused').tone).toBe('muted');
    expect(researchTag('odd').label).toBe('Odd');
    expect(researchRunning('processing')).toBe(true);
    expect(researchRunning('queued')).toBe(false);
  });

  test('relative times', () => {
    const now = Date.UTC(2026, 9, 28, 12, 0, 0);
    const ago = (s: number) => new Date(now - s * 1000).toISOString();
    expect(agoLabel(ago(20), now)).toBe('just now');
    expect(agoLabel(ago(12 * 60), now)).toBe('12 min ago');
    expect(agoLabel(ago(3 * 3600), now)).toBe('3 h ago');
    expect(agoLabel(ago(30 * 3600), now)).toBe('Yesterday');
    expect(agoLabel(ago(4 * 86400), now)).toBe('4 days ago');
    expect(agoLabel(null, now)).toBe('');
    expect(agoLabel('not a date', now)).toBe('');
  });

  test('the indexing row says only what is measured', () => {
    const now = Date.UTC(2026, 9, 28, 12, 0, 0);
    expect(indexingRow(1203, new Date(now - 12 * 60_000).toISOString(), now)).toEqual({ title: '1,203 entries', sub: 'Last indexed 12 min ago' });
    expect(indexingRow(1, null, now)).toEqual({ title: '1 entry', sub: 'Indexed' });
    expect(indexingRow(0, null, now)).toEqual({ title: '0 entries', sub: 'Nothing indexed yet' });
  });
});
