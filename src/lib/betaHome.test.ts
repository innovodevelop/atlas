import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HOME, DEFAULT_SETTINGS, SPANS, WIDGETS, WIDGET_BY_ID, capacity, cellsUsed, cycleSetting, editorReducer,
  fromTableSize, openEditor, overflowIds, packStage, parsePrefs, stageRowCount, toTableSize,
} from './betaHome';

describe('Beta Home model', () => {
  test('sizes round-trip through the dashboard_layout table, unknown sizes read as L', () => {
    for (const s of ['S', 'M', 'L', 'XL'] as const) expect(fromTableSize(toTableSize(s))).toBe(s);
    expect(fromTableSize('xl')).toBe('XL');
    expect(fromTableSize('huge')).toBe('L');
    expect(fromTableSize(null)).toBe('L');
  });

  test('the default Home only lists widgets that exist, at sizes they offer', () => {
    for (const d of DEFAULT_HOME) {
      const def = WIDGET_BY_ID.get(d.id);
      expect(def).toBeDefined();
      expect(def!.sizes).toContain(d.size);
      expect(def!.source).not.toBe('unwired');
    }
    expect(new Set(WIDGETS.map((w) => w.id)).size).toBe(WIDGETS.length);
  });

  test('stage packing spends the row budget in order and lets a small card fill the last gap', () => {
    // 2 rows × 6 cols = 12 cells. L (6) + L (6) fills it; the M (3) is dropped,
    // but a later S (2)… also no room. Try 3 rows = 18: L, L, M (3) = 15, then
    // L (6) does not fit and is skipped, S (2) fits → 17.
    const slots = [
      { id: 'inbox', size: 'L' as const }, { id: 'weather', size: 'L' as const }, { id: 'watch', size: 'M' as const },
      { id: 'today', size: 'L' as const }, { id: 'air', size: 'S' as const },
    ];
    const { placed, dropped } = packStage(slots, 3);
    expect(placed.map((p) => p.id)).toEqual(['inbox', 'weather', 'watch', 'air']);
    expect(dropped.map((d) => d.id)).toEqual(['today']);
    expect(placed[0]).toMatchObject({ cols: 3, rows: 2, delay: 0 });
    expect(placed[3].delay).toBe(4 * 55);
    expect(cellsUsed(placed)).toBe(17);
  });

  test('a card taller than the stage is clipped to it rather than dropped', () => {
    const { placed } = packStage([{ id: 'inbox', size: 'L' }], 1);
    expect(placed[0].rows).toBe(1);
    expect(placed[0].cols).toBe(3);
  });

  test('row count follows the viewport', () => {
    // 900 px tall, a 280 px band: 900 − 64 − 280 − 94 − 30 = 432 → (432 + 12) / 133 = 3.3 → 3 rows
    expect(stageRowCount(900, 280)).toBe(3);
    expect(stageRowCount(600, 220)).toBe(1);
    // 1400 − 64 − 300 − 94 − 30 = 912 → (912 + 12) / 133 = 6.9 → 6 rows
    expect(stageRowCount(1400, 300)).toBe(6);
  });

  test('capacity meter', () => {
    const c = capacity(DEFAULT_HOME, 4);
    expect(c.total).toBe(24);
    expect(c.used).toBe(cellsUsed(DEFAULT_HOME));
    // Two XLs (12 each) and an S (2) against 2 rows × 6 = 12 cells: 26 used.
    expect(capacity([{ id: 'inbox', size: 'XL' }, { id: 'weather', size: 'XL' }, { id: 'today', size: 'S' }], 2))
      .toMatchObject({ over: true, tone: 'over', label: '14 cells over' });
    expect(overflowIds([{ id: 'inbox', size: 'XL' }, { id: 'weather', size: 'XL' }], 2).has('weather')).toBe(true);
  });

  test('the editor reorders, resizes within the offered sizes, adds once, removes, and Cancel restores', () => {
    let s = openEditor(DEFAULT_HOME, 'stage', DEFAULT_SETTINGS);
    s = editorReducer(s, { type: 'move', id: 'clock', before: 'inbox' });
    expect(s.slots[0].id).toBe('clock');
    s = editorReducer(s, { type: 'move', id: 'clock', before: null });
    expect(s.slots[s.slots.length - 1].id).toBe('clock');
    s = editorReducer(s, { type: 'size', id: 'weather', size: 'S' });
    expect(s.slots.find((x) => x.id === 'weather')!.size).toBe('S');
    // Weather does not offer XL; the draft is unchanged.
    s = editorReducer(s, { type: 'size', id: 'weather', size: 'XL' });
    expect(s.slots.find((x) => x.id === 'weather')!.size).toBe('S');
    s = editorReducer(s, { type: 'add', id: 'sleep' });
    s = editorReducer(s, { type: 'add', id: 'sleep' });
    expect(s.slots.filter((x) => x.id === 'sleep')).toHaveLength(1);
    // Unwired widgets cannot be added: no fake card.
    s = editorReducer(s, { type: 'add', id: 'focus' });
    expect(s.slots.some((x) => x.id === 'focus')).toBe(false);
    s = editorReducer(s, { type: 'remove', id: 'inbox' });
    expect(s.slots.some((x) => x.id === 'inbox')).toBe(false);
    s = editorReducer(s, { type: 'layout', layout: 'grid' });
    s = editorReducer(s, { type: 'setting', key: 'density' });
    expect(s.layout).toBe('grid');
    expect(s.settings.density).toBe('Dense');
    s = editorReducer(s, { type: 'cancel' });
    expect(s.slots).toEqual(DEFAULT_HOME.map((x) => ({ ...x })));
    expect(s.layout).toBe('stage');
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });

  test('reset goes back to the handoff default', () => {
    let s = openEditor([{ id: 'air', size: 'S' }], 'grid', cycleSetting(DEFAULT_SETTINGS, 'surface'));
    s = editorReducer(s, { type: 'reset' });
    expect(s.slots.map((x) => x.id)).toEqual(DEFAULT_HOME.map((x) => x.id));
    expect(s.layout).toBe('stage');
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
  });

  test('settings cycle through their values and preferences parse defensively', () => {
    expect(cycleSetting(DEFAULT_SETTINGS, 'labels').labels).toBe('On hover');
    expect(cycleSetting(cycleSetting(DEFAULT_SETTINGS, 'labels'), 'labels').labels).toBe('Always');
    expect(parsePrefs(null)).toEqual({ layout: 'stage', settings: DEFAULT_SETTINGS });
    expect(parsePrefs('{"layout":"centred","settings":{"density":"Airy","surface":"neon"}}'))
      .toEqual({ layout: 'centred', settings: { ...DEFAULT_SETTINGS, density: 'Airy' } });
    expect(parsePrefs('not json')).toEqual({ layout: 'stage', settings: DEFAULT_SETTINGS });
  });

  test('spans are the guideline spans', () => {
    expect(SPANS).toEqual({ S: [2, 1], M: [3, 1], L: [3, 2], XL: [6, 2] });
  });
});
