import { describe, expect, test } from 'bun:test';
import { arcsOf, initialsOf, linePoints, money, pct } from './betaMoney';

describe('formats', () => {
  test('money and percent', () => {
    expect(money(1234.5, 'USD')).toMatch(/1,?235|1\.235|1 235/);
    expect(money(12.345, 'EUR', 2)).toMatch(/12[.,]35/);
    expect(pct(1.84)).toBe('+1.8%');
    expect(pct(-0.26)).toBe('−0.3%');
  });
  test('initials', () => {
    expect(initialsOf('Danske Bank · everyday')).toBe('DB');
    expect(initialsOf('')).toBe('?');
  });
});

describe('arcsOf', () => {
  test('shares sum to one and lay end to end', () => {
    const arcs = arcsOf([{ label: 'Stocks', value: 60 }, { label: 'ETFs', value: 30 }, { label: 'Cash', value: 10 }], true);
    expect(arcs.map((a) => a.share)).toEqual([0.6, 0.3, 0.1]);
    expect(arcs[0].offset).toBe(0);
    expect(arcs[1].offset).toBeLessThan(0);
    expect(arcs[2].offset).toBeLessThan(arcs[1].offset);
  });
  test('draws nothing before the entrance', () => {
    expect(arcsOf([{ label: 'A', value: 1 }], false)[0].dash.startsWith('0.0 ')).toBe(true);
  });
  test('ignores negative values and empties', () => {
    expect(arcsOf([{ label: 'A', value: -5 }], true)[0].share).toBe(0);
    expect(arcsOf([], true)).toEqual([]);
  });
});

describe('linePoints', () => {
  test('needs two points', () => {
    expect(linePoints([{ date: 'd', value: 1 }]).line).toBe('');
  });
  test('spans the box newest-right and keeps min/max', () => {
    const r = linePoints([{ date: '1', value: 100 }, { date: '2', value: 150 }, { date: '3', value: 125 }]);
    expect(r.min).toBe(100);
    expect(r.max).toBe(150);
    expect(r.line.startsWith('0.0,92.0')).toBe(true);
    expect(r.line.endsWith('300.0,50.0')).toBe(true);
    expect(r.area.startsWith('0,100 ')).toBe(true);
  });
});
