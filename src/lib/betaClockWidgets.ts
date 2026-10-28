/**
 * What the Home widgets read from the Clock's store (`Atlas Widgets Beta.dc.html`,
 * the time group): Elsewhere — your Clock cities, the next alarm and a running
 * timer or countdown; Clock dials — home and the cities as analogue faces; and
 * Countdown — the one countdown the Clock keeps.
 *
 * Pure, like betaClock.ts: every function takes the saved preferences, the
 * instant and the zone, so the widgets show exactly what /clock shows and the
 * arithmetic is tested here. The adapters live in components/atlas/home/widgets.tsx.
 */
import type { WidgetSize } from './betaHome';
import {
  cityForZone, cityRows, countdownLeft, countdownTotal, diffLabel, fmtDuration, hhmm, hourDiff, nextAlarm,
  parseTargetLocal, timerElapsed, whenLabel, zoneTime,
  type CityRef, type CityRow, type ClockPrefs, type CountdownState,
} from './betaClock';

// ── Elsewhere ────────────────────────────────────────────────────────────────

/** The design's widget carries four cities at most; the Clocks list carries the rest. */
export const ELSEWHERE_CITIES = 4;

export interface ElsewhereFace {
  /** The saved cities after home, at most four. */
  cities: CityRow[];
  /** All saved cities, for the meta line. */
  total: number;
  /** The next alarm (its label, and when: "07:30" or "Tue 07:30"), or null with none on. */
  alarm: { label: string; when: string } | null;
  /** The timer, or the countdown when no timer runs; null when neither does. */
  running: { label: string; value: string; over: boolean } | null;
}

export function elsewhere(prefs: Pick<ClockPrefs, 'cities' | 'alarms' | 'timer' | 'countdown'>, nowMs: number, tz: string): ElsewhereFace {
  const rows = cityRows(cityForZone(tz), prefs.cities, nowMs).filter((r) => !r.home).slice(0, ELSEWHERE_CITIES);
  const next = nextAlarm(prefs.alarms, nowMs, tz);
  let running: ElsewhereFace['running'] = null;
  if (prefs.timer.running) {
    running = { label: 'Timer', value: fmtDuration(timerElapsed(prefs.timer, nowMs)), over: false };
  } else if (prefs.countdown.running) {
    const left = countdownLeft(prefs.countdown, nowMs);
    running = left < 0
      ? { label: 'Over by', value: `+${fmtDuration(left)}`, over: true }
      : { label: 'Countdown', value: fmtDuration(left), over: false };
  }
  return {
    cities: rows,
    total: prefs.cities.length,
    alarm: next ? { label: next.alarm.label || 'Alarm', when: whenLabel(tz, next.at, nowMs) } : null,
    running,
  };
}

export const citiesMeta = (n: number): string => (n === 0 ? 'No cities' : `${n} ${n === 1 ? 'city' : 'cities'}`);

// ── Clock dials ──────────────────────────────────────────────────────────────

/** Dials per size, as the design draws them: one in S, a row of three in M, two rows in L. */
export function dialCount(size: WidgetSize): number {
  return size === 'S' ? 1 : size === 'M' ? 3 : 6;
}

export interface Dial {
  name: string;
  tz: string;
  /** `HH:MM` in the city. */
  time: string;
  /** "Home", "+8 h". */
  diff: string;
  /** Hand angles in degrees, clockwise from twelve. */
  hourDeg: number;
  minuteDeg: number;
  /** Before 06:00 or from 20:00: the face goes dark, as the Clocks list does. */
  night: boolean;
  home: boolean;
}

/** The hands for a wall clock reading: the hour hand moves with the minutes. */
export function handAngles(hour: number, minute: number): { hourDeg: number; minuteDeg: number } {
  return { hourDeg: Math.round(((hour % 12) * 30 + minute * 0.5) * 10) / 10, minuteDeg: minute * 6 };
}

/** Home first, then the saved cities in their order, `count` at most. */
export function dials(homeTz: string, cities: readonly CityRef[], nowMs: number, count: number): Dial[] {
  const home = cityForZone(homeTz);
  return [{ c: home, home: true }, ...cities.filter((c) => c.tz !== homeTz).map((c) => ({ c, home: false }))]
    .slice(0, Math.max(0, count))
    .map(({ c, home: isHome }) => {
      const z = zoneTime(c.tz, nowMs);
      return {
        name: c.name,
        tz: c.tz,
        time: hhmm(z),
        diff: isHome ? 'Home' : diffLabel(hourDiff(c.tz, homeTz, nowMs)),
        ...handAngles(z.hour, z.minute),
        night: z.hour < 6 || z.hour >= 20,
        home: isHome,
      };
    });
}

// ── Countdown ────────────────────────────────────────────────────────────────

export interface CountdownFace {
  state: 'running' | 'over' | 'paused' | 'ready' | 'until' | 'none';
  value: string;
  /** The small word beside the value. */
  delta: string;
  sub: string;
  /** How much of the span has gone, 0–1; null when nothing is counting. */
  fraction: number | null;
}

/** "6d 3h" past a day, "2:14:05" under one — a target a week out reads as days. */
export function compactLeft(ms: number): string {
  const a = Math.abs(ms);
  if (a < 86400000) return fmtDuration(a);
  const d = Math.floor(a / 86400000);
  const h = Math.floor((a % 86400000) / 3600000);
  return h ? `${d}d ${h}h` : `${d}d`;
}

export function countdownFace(c: CountdownState, nowMs: number, tz: string): CountdownFace {
  const left = countdownLeft(c, nowMs);
  const total = countdownTotal(c, nowMs);
  const gone = (l: number): number => (total > 0 ? Math.max(0, Math.min(1, 1 - l / total)) : 1);
  if (c.running) {
    if (left < 0) return { state: 'over', value: `+${compactLeft(left)}`, delta: 'Over by', sub: 'Past zero · still counting', fraction: 1 };
    return { state: 'running', value: compactLeft(left), delta: 'Left', sub: `Ends ${whenLabel(tz, c.endAt, nowMs)}`, fraction: gone(left) };
  }
  if (c.pausedLeft != null) {
    return { state: 'paused', value: `${c.pausedLeft < 0 ? '+' : ''}${compactLeft(c.pausedLeft)}`, delta: 'Paused', sub: 'Resume it in Clock', fraction: gone(c.pausedLeft) };
  }
  if (c.mode === 'target') {
    const t = parseTargetLocal(c.target);
    if (t == null || t <= nowMs) return { state: 'none', value: '—', delta: '', sub: 'Pick a moment to count down to in Clock', fraction: null };
    return { state: 'until', value: compactLeft(t - nowMs), delta: 'Until', sub: `${whenLabel(tz, t, nowMs)} · start it in Clock`, fraction: null };
  }
  return { state: 'ready', value: fmtDuration(c.durMs), delta: 'Ready', sub: 'Start it in Clock', fraction: null };
}

/** The tick the countdown face needs: every second while counting, else once a minute. */
export function countdownTickMs(c: CountdownState): number {
  return c.running ? 1000 : 60000;
}
