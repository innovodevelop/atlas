import { describe, expect, test } from 'bun:test';
import type { SeriesRow } from '@/hooks/useHealthSeries';
import {
  barsFrom, dayLabel, goalLinePct, headlineFor, numberOf, parseLog, parseMinutes, readiness, readinessWord, ringsFrom, sparkOf, stagesFrom, trendOf,
} from './betaHealth';

const row = (day: string, raw: number, unit = 'bpm'): SeriesRow => ({ day, raw, value: String(raw), unit, low: null, high: null, sampleCount: 1 });

describe('parsing the formatted figures', () => {
  test('minutes', () => {
    expect(parseMinutes('7h 12m')).toBe(432);
    expect(parseMinutes('48m')).toBe(48);
    expect(parseMinutes('8h')).toBe(480);
    expect(parseMinutes('—')).toBeNull();
    expect(parseMinutes(null)).toBeNull();
  });
  test('numbers', () => {
    expect(numberOf('8,213')).toBe(8213);
    expect(numberOf('64 ms')).toBe(64);
    expect(numberOf(undefined)).toBeNull();
  });
});

describe('rings and readiness', () => {
  test('ratios against stated goals', () => {
    const rings = ringsFrom({ asleep: '6h 0m', deep: '1h 20m', energy: '250 kcal', heart: [row('2026-10-27', 60), row('2026-10-26', 64), row('2026-10-25', 68)] });
    expect(rings.map((r) => r.fraction)).toEqual([0.75, 1, 0.5]);
    expect(rings[0].why).toBe('deep 1h 20m');
    expect(rings[1].why).toBe('at or under your week');
    expect(rings[2].why).toBe('250 kcal to go');
    expect(readiness(rings)).toBe(75);
    expect(readinessWord(75)).toBe('Good to go');
  });
  test('missing figures are null, not zero', () => {
    const rings = ringsFrom({});
    expect(rings.every((r) => r.fraction === null)).toBe(true);
    expect(readiness(rings)).toBeNull();
    expect(readinessWord(null)).toBe('No readings yet');
    expect(headlineFor(null, rings, null).title).toBe('Nothing to read yet.');
  });
  test('recovery needs a second day and a higher rate scores lower', () => {
    expect(ringsFrom({ heart: [row('d', 60)] })[1]).toMatchObject({ fraction: null, why: 'needs a second day' });
    expect(ringsFrom({ heart: [row('d', 72), row('c', 60)] })[1].fraction).toBeCloseTo(60 / 72);
  });
  test('headline follows the picked ring', () => {
    const rings = ringsFrom({ asleep: '7h 50m' });
    expect(headlineFor('sleep', rings, 98).title).toBe('Sleep carried today.');
    expect(headlineFor('activity', rings, null).title).toBe('No activity recorded.');
  });
});

describe('series drawing', () => {
  const rows = [row('2026-10-27', 8240, ''), row('2026-10-26', 11400, ''), row('2026-10-25', 5300, '')];
  test('bars run oldest to newest with headroom over the goal', () => {
    const bars = barsFrom(rows, 10000);
    expect(bars.map((b) => b.day)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(bars[1].over).toBe(true);
    expect(bars[1].pct).toBe(95);
    expect(goalLinePct(10000, bars)).toBe(83);
  });
  test('sparkline and trend', () => {
    expect(sparkOf(rows).split(' ')).toHaveLength(3);
    expect(sparkOf([rows[0]])).toBe('');
    expect(trendOf([row('d', 64, 'ms'), row('c', 56, 'ms'), row('b', 56, 'ms')])).toEqual({ text: '+8.0 ms on the week', dir: 'up' });
    expect(trendOf([row('d', 58, 'bpm'), row('c', 58, 'bpm')]).text).toBe('steady');
    expect(trendOf([]).text).toBe('no readings');
  });
  test('stages keep only what the export has', () => {
    expect(stagesFrom({ deep: '1h 40m', rem: '1h 52m' }).map((s) => s.label)).toEqual(['Deep', 'REM']);
  });
  test('day labels', () => {
    expect(dayLabel('2026-10-27', '2026-10-27')).toBe('Today');
    expect(dayLabel('2026-10-26', '2026-10-27').length).toBeGreaterThan(0);
  });
});

describe('the day log', () => {
  test('parses and clamps', () => {
    expect(parseLog(null)).toEqual({ water: 0, mood: null });
    expect(parseLog('{"water":12,"mood":"Good"}')).toEqual({ water: 8, mood: 'Good' });
    expect(parseLog('{"water":3,"mood":"Silly"}')).toEqual({ water: 3, mood: null });
    expect(parseLog('nonsense')).toEqual({ water: 0, mood: null });
  });
});
