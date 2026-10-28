import { describe, expect, test } from 'bun:test';
import { diffForTable, slotsFromTable, toBetaId, toTableId } from './betaHomeSync';

const row = (widget_id: string, position: number, size = 'l', visible = true) => ({ widget_id, position, size, visible });

describe('ids', () => {
  test('translate both ways and leave shared ids alone', () => {
    expect(toBetaId('calendar')).toBe('today');
    expect(toBetaId('stocks')).toBe('watch');
    expect(toBetaId('mail')).toBe('inbox');
    expect(toBetaId('worldclock')).toBe('clock');
    expect(toBetaId('weather')).toBe('weather');
    expect(toTableId('today')).toBe('calendar');
    expect(toTableId('steps')).toBe('steps');
  });
});

describe('slotsFromTable', () => {
  test('orders by position, drops hidden and unknown rows', () => {
    const slots = slotsFromTable([
      row('tasks', 2, 'm'), row('weather', 0, 'l'), row('mail', 1, 'l', false), row('legacy-thing', 3), row('calendar', 4, 's'),
    ]);
    expect(slots).toEqual([{ id: 'weather', size: 'L' }, { id: 'tasks', size: 'M' }, { id: 'today', size: 'S' }]);
  });
  test('clamps a size the widget does not offer', () => {
    // Weather offers S/M/L; an xl row falls back to its default L.
    expect(slotsFromTable([row('weather', 0, 'xl')])).toEqual([{ id: 'weather', size: 'L' }]);
    // The watchlist does offer XL.
    expect(slotsFromTable([row('stocks', 0, 'xl')])).toEqual([{ id: 'watch', size: 'XL' }]);
  });
  test('ignores a duplicate widget', () => {
    expect(slotsFromTable([row('tasks', 0), row('tasks', 1, 's')])).toHaveLength(1);
  });
});

describe('diffForTable', () => {
  const before = [{ id: 'weather', size: 'L' as const }, { id: 'today', size: 'L' as const }, { id: 'tasks', size: 'M' as const }];
  test('no change → nothing to write', () => {
    expect(diffForTable(before, before)).toEqual({ order: null, sizes: [], visibility: [] });
  });
  test('a resize writes one size', () => {
    const after = [before[0], { id: 'today', size: 'S' as const }, before[2]];
    expect(diffForTable(before, after)).toEqual({ order: null, sizes: [{ widgetId: 'calendar', size: 's' }], visibility: [] });
  });
  test('a move writes the whole order in table ids', () => {
    const after = [before[2], before[0], before[1]];
    expect(diffForTable(before, after).order).toEqual(['tasks', 'weather', 'calendar']);
  });
  test('add shows and sizes; remove hides', () => {
    const after = [before[0], before[1], { id: 'steps', size: 'S' as const }];
    const d = diffForTable(before, after);
    expect(d.visibility).toEqual([{ widgetId: 'steps', visible: true }, { widgetId: 'tasks', visible: false }]);
    expect(d.sizes).toEqual([{ widgetId: 'steps', size: 's' }]);
    expect(d.order).toEqual(['weather', 'calendar', 'steps']);
  });
});
