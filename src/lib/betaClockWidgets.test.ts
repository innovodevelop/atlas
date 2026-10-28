import { describe, expect, test } from 'bun:test';
import { COUNTDOWN_IDLE, TIMER_IDLE, defaultPrefs, type Alarm, type CityRef, type ClockPrefs } from './betaClock';
import {
  ELSEWHERE_CITIES, citiesMeta, compactLeft, countdownFace, countdownTickMs, dialCount, dials, elsewhere, handAngles,
} from './betaClockWidgets';

// 2026-01-14 10:30:00 UTC — a Wednesday, no DST anywhere north.
const NOW = Date.UTC(2026, 0, 14, 10, 30, 0);

const CITIES: CityRef[] = [
  { name: 'Tokyo', tz: 'Asia/Tokyo' },
  { name: 'New York', tz: 'America/New_York' },
  { name: 'London', tz: 'Europe/London' },
  { name: 'Sydney', tz: 'Australia/Sydney' },
  { name: 'Dubai', tz: 'Asia/Dubai' },
];

const alarm = (over: Partial<Alarm> = {}): Alarm => ({ id: 'a1', time: '12:00', label: 'Lunch', days: [], on: true, snoozedUntil: null, ...over });

const prefs = (over: Partial<ClockPrefs> = {}): ClockPrefs => ({ ...defaultPrefs(), cities: CITIES, ...over });

describe('Elsewhere', () => {
  test('the first four cities after home, the next alarm, nothing running', () => {
    const e = elsewhere(prefs({ alarms: [alarm()] }), NOW, 'UTC');
    expect(e.cities.map((c) => c.name)).toEqual(['Tokyo', 'New York', 'London', 'Sydney']);
    expect(e.cities).toHaveLength(ELSEWHERE_CITIES);
    expect(e.cities[0]).toMatchObject({ time: '19:30', diff: '+9 h' });
    expect(e.total).toBe(5);
    expect(e.alarm).toEqual({ label: 'Lunch', when: '12:00' });
    expect(e.running).toBeNull();
  });
  test('a running timer wins over a countdown; an overrun countdown says so', () => {
    const timer = { ...TIMER_IDLE, laps: [], running: true, startedAt: NOW - 65000, accMs: 0 };
    expect(elsewhere(prefs({ timer }), NOW, 'UTC').running).toEqual({ label: 'Timer', value: '01:05', over: false });
    const countdown = { ...COUNTDOWN_IDLE, splits: [], running: true, endAt: NOW + 90000, spanMs: 300000 };
    expect(elsewhere(prefs({ countdown }), NOW, 'UTC').running).toEqual({ label: 'Countdown', value: '01:30', over: false });
    const over = { ...countdown, endAt: NOW - 5000 };
    expect(elsewhere(prefs({ countdown: over }), NOW, 'UTC').running).toEqual({ label: 'Over by', value: '+00:05', over: true });
  });
  test('no alarm switched on is no alarm', () => {
    expect(elsewhere(prefs({ alarms: [alarm({ on: false })] }), NOW, 'UTC').alarm).toBeNull();
  });
  test('the meta line counts cities', () => {
    expect(citiesMeta(0)).toBe('No cities');
    expect(citiesMeta(1)).toBe('1 city');
    expect(citiesMeta(4)).toBe('4 cities');
  });
});

describe('Clock dials', () => {
  test('one, three or six faces by size', () => {
    expect([dialCount('S'), dialCount('M'), dialCount('L')]).toEqual([1, 3, 6]);
  });
  test('home first, then the cities, never home twice', () => {
    const list = dials('Europe/London', CITIES, NOW, 3);
    expect(list.map((d) => d.name)).toEqual(['London', 'Tokyo', 'New York']);
    expect(list[0]).toMatchObject({ home: true, diff: 'Home', time: '10:30' });
    expect(list[2]).toMatchObject({ home: false, diff: '−5 h', time: '05:30', night: true });
  });
  test('the hour hand moves with the minutes', () => {
    expect(handAngles(10, 30)).toEqual({ hourDeg: 315, minuteDeg: 180 });
    expect(handAngles(0, 0)).toEqual({ hourDeg: 0, minuteDeg: 0 });
    expect(handAngles(15, 45)).toEqual({ hourDeg: 112.5, minuteDeg: 270 });
  });
});

describe('Countdown', () => {
  test('running, with how much of the span has gone', () => {
    const c = { ...COUNTDOWN_IDLE, running: true, endAt: NOW + 60000, spanMs: 240000 };
    const f = countdownFace(c, NOW, 'UTC');
    expect(f).toMatchObject({ state: 'running', value: '01:00', delta: 'Left', sub: 'Ends 10:31' });
    expect(f.fraction).toBeCloseTo(0.75);
    expect(countdownTickMs(c)).toBe(1000);
  });
  test('past zero keeps counting', () => {
    const f = countdownFace({ ...COUNTDOWN_IDLE, running: true, endAt: NOW - 3000, spanMs: 60000 }, NOW, 'UTC');
    expect(f).toMatchObject({ state: 'over', value: '+00:03', delta: 'Over by', fraction: 1 });
  });
  test('paused, ready and a target still to start', () => {
    expect(countdownFace({ ...COUNTDOWN_IDLE, pausedLeft: 30000, spanMs: 60000 }, NOW, 'UTC')).toMatchObject({ state: 'paused', value: '00:30', fraction: 0.5 });
    expect(countdownFace(COUNTDOWN_IDLE, NOW, 'UTC')).toMatchObject({ state: 'ready', value: '25:00', fraction: null });
    expect(countdownTickMs(COUNTDOWN_IDLE)).toBe(60000);
    expect(countdownFace({ ...COUNTDOWN_IDLE, mode: 'target', target: '' }, NOW, 'UTC').state).toBe('none');
  });
  test('a long span reads in days', () => {
    expect(compactLeft(6 * 86400000 + 3 * 3600000 + 5000)).toBe('6d 3h');
    expect(compactLeft(2 * 86400000)).toBe('2d');
    expect(compactLeft(3723000)).toBe('1:02:03');
  });
});
