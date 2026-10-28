/**
 * The Beta Clock's arithmetic (`Atlas Clock Beta.dc.html`): where the hours
 * and the cities sit on the 24-hour band, the time-zone sums behind every
 * city row, the timer and countdown formatting, the alarm schedule, and the
 * saved preferences. Pure and tested here; the ticking, the chime and the
 * notifications live in betaClockStore.ts.
 *
 * Every instant is epoch milliseconds and every wall-clock reading goes
 * through `zoneTime`, so the screen can be shown in the profile's time zone
 * while the Mac's own clock drives the ticks. Nothing here reads the real
 * clock: `nowMs` is always passed in, which is what makes it testable.
 */
import { CITIES } from './worldClock';

export type ClockTab = 'timer' | 'countdown' | 'alarm' | 'clocks';
export const CLOCK_TABS: readonly ClockTab[] = ['timer', 'countdown', 'alarm', 'clocks'];

export interface CityRef {
  name: string;
  /** An IANA zone, e.g. `Europe/Copenhagen`. */
  tz: string;
}

/**
 * The cities the Clocks tab offers. Short on purpose: a curated list the user
 * picks from, not a gazetteer. The design's twelve plus the home candidates
 * it listed, in a rough west-to-east order within each continent.
 */
export const CURATED_CITIES: readonly CityRef[] = [
  { name: 'Reykjavík', tz: 'Atlantic/Reykjavik' },
  { name: 'Lisbon', tz: 'Europe/Lisbon' },
  { name: 'London', tz: 'Europe/London' },
  { name: 'Paris', tz: 'Europe/Paris' },
  { name: 'Berlin', tz: 'Europe/Berlin' },
  { name: 'Copenhagen', tz: 'Europe/Copenhagen' },
  { name: 'Dubai', tz: 'Asia/Dubai' },
  { name: 'Mumbai', tz: 'Asia/Kolkata' },
  { name: 'Singapore', tz: 'Asia/Singapore' },
  { name: 'Hong Kong', tz: 'Asia/Hong_Kong' },
  { name: 'Tokyo', tz: 'Asia/Tokyo' },
  { name: 'Sydney', tz: 'Australia/Sydney' },
  { name: 'Auckland', tz: 'Pacific/Auckland' },
  { name: 'São Paulo', tz: 'America/Sao_Paulo' },
  { name: 'New York', tz: 'America/New_York' },
  { name: 'Toronto', tz: 'America/Toronto' },
  { name: 'Chicago', tz: 'America/Chicago' },
  { name: 'San Francisco', tz: 'America/Los_Angeles' },
];

/** The extra clocks a fresh install shows: the three the Home widget already carries. */
export const DEFAULT_CITIES: readonly CityRef[] = CITIES.map((c) => ({ name: c.city, tz: c.tz }));

// ── Time zones ───────────────────────────────────────────────────────────────

export const pad2 = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, '0');

/** `tz` when Intl accepts it, else null — a profile may carry anything. */
export function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface ZoneTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, like `Date#getDay`. */
  weekday: number;
  minuteOfDay: number;
  /** `YYYY-MM-DD` in the zone, for day comparisons. */
  dateKey: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at the instant `atMs`. */
export function zoneTime(tz: string, atMs: number): ZoneTime {
  const parts = formatterFor(tz).formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  // Some engines print midnight as "24" under h23; keep it on the 0–23 dial.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  return {
    year, month, day, hour, minute, second,
    weekday: WEEKDAYS.indexOf(get('weekday')),
    minuteOfDay: hour * 60 + minute,
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

/** Minutes east of UTC for `tz` at `atMs` (Copenhagen in winter: 60; Los Angeles in winter: −480). */
export function zoneOffsetMinutes(tz: string, atMs: number): number {
  const z = zoneTime(tz, atMs);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60000);
}

/**
 * The instant at which the wall clock in `tz` reads `hh:mm` on the given
 * calendar day of that zone. Two passes: the first offset is read at the
 * naive guess, which on a DST changeover day can sit on the wrong side of the
 * switch; the second reads it at the corrected instant.
 */
export function zoneInstant(tz: string, year: number, month: number, day: number, hh: number, mm: number): number {
  const naive = Date.UTC(year, month - 1, day, hh, mm, 0);
  const first = naive - zoneOffsetMinutes(tz, naive) * 60000;
  return naive - zoneOffsetMinutes(tz, first) * 60000;
}

/** Whole days between two `dateKey`s (`b` − `a`). */
export function dayDelta(a: string, b: string): number {
  const toUtc = (k: string): number => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** Hours `tz` runs ahead of `homeTz` at `atMs`; half-hour zones give .5. */
export function hourDiff(tz: string, homeTz: string, atMs: number): number {
  return (zoneOffsetMinutes(tz, atMs) - zoneOffsetMinutes(homeTz, atMs)) / 60;
}

export function diffLabel(hours: number): string {
  if (hours === 0) return 'Same time';
  const abs = Math.abs(hours);
  const n = Number.isInteger(abs) ? String(abs) : abs.toFixed(1).replace(/\.0$/, '');
  return `${hours > 0 ? '+' : '−'}${n} h`;
}

export const dayBadge = (delta: number): 'Today' | 'Tomorrow' | 'Yesterday' =>
  delta === 0 ? 'Today' : delta > 0 ? 'Tomorrow' : 'Yesterday';

export function hhmm(z: ZoneTime): string {
  return `${pad2(z.hour)}:${pad2(z.minute)}`;
}

/** "Copenhagen" from `Europe/Copenhagen`, "Los Angeles" from `America/Los_Angeles`. */
export function cityForZone(tz: string): CityRef {
  const known = CURATED_CITIES.find((c) => c.tz === tz);
  if (known) return known;
  const leaf = tz.split('/').pop() ?? tz;
  return { name: leaf.replace(/_/g, ' '), tz };
}

export interface CityRow {
  name: string;
  tz: string;
  /** `HH:MM` in the city. */
  time: string;
  badge: 'Today' | 'Tomorrow' | 'Yesterday';
  /** "Home", "Same time", "+8 h". */
  diff: string;
  /** Before 06:00 or from 20:00 — the row goes ink. */
  night: boolean;
  home: boolean;
}

/** The Clocks list: home first, then the saved cities in their order. */
export function cityRows(home: CityRef, cities: readonly CityRef[], atMs: number): CityRow[] {
  const here = zoneTime(home.tz, atMs);
  const row = (c: CityRef, isHome: boolean): CityRow => {
    const z = zoneTime(c.tz, atMs);
    return {
      name: c.name,
      tz: c.tz,
      time: hhmm(z),
      badge: dayBadge(dayDelta(here.dateKey, z.dateKey)),
      diff: isHome ? 'Home' : diffLabel(hourDiff(c.tz, home.tz, atMs)),
      night: z.hour < 6 || z.hour >= 20,
      home: isHome,
    };
  };
  return [row(home, true), ...cities.map((c) => row(c, false))];
}

/** Curated cities matching `query`, minus the ones already shown and home. Five at most. */
export function searchCities(query: string, existing: readonly CityRef[], homeTz: string): CityRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return CURATED_CITIES
    .filter((c) => c.name.toLowerCase().includes(q) && c.tz !== homeTz && !existing.some((e) => e.tz === c.tz))
    .slice(0, 5);
}

// ── The 24-hour band ─────────────────────────────────────────────────────────

/** Sunrise and sunset as minutes of the day. */
export interface SunSpan { sunrise: number; sunset: number }

/** "6:42 AM" → 402, "17:24" → 1044, anything else → null. */
export function parseClockTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3].toLowerCase() === 'pm';
    h = (h % 12) + (pm ? 12 : 0);
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

export function sunSpan(sunrise: string | null | undefined, sunset: string | null | undefined): SunSpan | null {
  const a = parseClockTime(sunrise);
  const b = parseClockTime(sunset);
  return a != null && b != null && b > a ? { sunrise: a, sunset: b } : null;
}

export interface BandCell {
  hour: number;
  /** Fraction of the hour in daylight, 0..1. */
  light: number;
  /** The whole hour sits in the middle of the day (three hours clear of either edge). */
  high: boolean;
}

/**
 * The 24 cells behind the band. With a real sun the daylight is its span;
 * without one the design's generic day (06–20, brighter 09–17) stands in,
 * and the page says so.
 */
export function bandCells(sun: SunSpan | null): BandCell[] {
  const span = sun ?? { sunrise: 6 * 60, sunset: 20 * 60 };
  // Three hours in from either edge is "the middle of the day" — with the
  // generic span that is exactly the design's 09–17.
  const core = 180;
  return Array.from({ length: 24 }, (_, hour) => {
    const start = hour * 60;
    const end = start + 60;
    const overlap = Math.max(0, Math.min(end, span.sunset) - Math.max(start, span.sunrise));
    return {
      hour,
      light: Math.round((overlap / 60) * 100) / 100,
      high: start >= span.sunrise + core && end <= span.sunset - core,
    };
  });
}

/** The band's opacity for a cell: night .04, day .11, the middle of the day .18 (the design's three). */
export function cellAlpha(c: BandCell): number {
  return Math.round((0.04 + c.light * 0.07 + (c.high ? 0.07 : 0)) * 1000) / 1000;
}

/** Percent across the band for a minute of the day, two decimals. */
export function bandX(minuteOfDay: number): number {
  return Math.round((minuteOfDay / 1440) * 10000) / 100;
}

export interface BandPill {
  name: string;
  tz: string;
  time: string;
  /** The city's own hour, percent across the band. */
  hourX: number;
  /**
   * Where the pill's centre sits, percent: its hour, nudged inward just
   * enough that the whole pill stays inside the band.
   */
  x: number;
  /** Which of the band's two rows. */
  y: 28 | 72;
  /** Time only: the name did not fit beside its neighbours (it stays in the tooltip). */
  compact: boolean;
  home: boolean;
}

/**
 * Pill geometry, in CSS px, for the design's 12px/600 Geist pill: 10px
 * padding each side, a 6px gap between time and name. Glyph widths are
 * averages — generous, so an estimate errs toward dropping a name rather
 * than overlapping one.
 */
const PILL_PAD = 20;
const PILL_GAP = 6;
const PILL_DIGIT = 7.2;
const PILL_CHAR = 7.2;
/** Space kept between neighbours, and between a pill and the band's ends. */
const PILL_SPACE = 6;

export function pillWidth(time: string, name: string | null): number {
  return PILL_PAD + time.length * PILL_DIGIT + (name ? PILL_GAP + name.length * PILL_CHAR : 0);
}

/**
 * Home plus the first `max − 1` cities on a band `bandPx` wide. Home is
 * placed first and the cities in the user's order (move a city up to give
 * it priority). Each takes the first of the two rows where it fits with its
 * name, else the first where it fits as a time alone; one that fits nowhere
 * is left off the band (it is still in the Clocks list). The result is
 * sorted left to right.
 */
export function bandPills(home: CityRef, cities: readonly CityRef[], atMs: number, max = 5, bandPx = 1000): BandPill[] {
  const band = Math.max(120, bandPx);
  const picks = [{ c: home, home: true }, ...cities.slice(0, Math.max(0, max - 1)).map((c) => ({ c, home: false }))];
  const rows: Array<Array<[number, number]>> = [[], []];
  const out: BandPill[] = [];
  for (const { c, home: isHome } of picks) {
    const z = zoneTime(c.tz, atMs);
    const time = hhmm(z);
    const hourX = bandX(z.minuteOfDay);
    let placed: BandPill | null = null;
    for (const compact of [false, true]) {
      const w = pillWidth(time, compact ? null : c.name);
      if (w + 2 * PILL_SPACE > band) continue;
      const centre = Math.min(band - PILL_SPACE - w / 2, Math.max(PILL_SPACE + w / 2, (hourX / 100) * band));
      const span: [number, number] = [centre - w / 2, centre + w / 2];
      const row = rows.findIndex((r) => r.every(([a, b]) => span[1] + PILL_SPACE <= a || span[0] >= b + PILL_SPACE));
      if (row < 0) continue;
      rows[row].push(span);
      placed = { name: c.name, tz: c.tz, time, hourX, x: Math.round((centre / band) * 10000) / 100, y: row ? 72 : 28, compact, home: isHome };
      break;
    }
    if (placed) out.push(placed);
  }
  return out.sort((a, b) => a.x - b.x);
}

/** Whether the sun is up at `minuteOfDay`; null without a reading. */
export function sunUp(sun: SunSpan | null, minuteOfDay: number): boolean | null {
  if (!sun) return null;
  return minuteOfDay >= sun.sunrise && minuteOfDay < sun.sunset;
}

export function minutesLabel(minuteOfDay: number): string {
  return `${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`;
}

// ── Whose time, and whose sun ────────────────────────────────────────────────

/**
 * Zones that mean "nobody chose one". `profiles.timezone` defaults to 'UTC'
 * in the schema and no screen sets it, so a profile that says UTC almost
 * always means "unset" — showing a Copenhagen user UTC as "your time" would
 * be wrong by an hour all winter.
 */
const UNSET_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu']);

export type ZoneSource = 'profile' | 'mac';

/** The zone the screen is drawn in: the profile's when it names a real one, else this Mac's. */
export function homeZone(profileTz: string | null | undefined, macTz: string): { tz: string; source: ZoneSource } {
  const p = validZone(profileTz);
  if (p && !UNSET_ZONES.has(p)) return { tz: p, source: 'profile' };
  return { tz: validZone(macTz) ?? 'UTC', source: 'mac' };
}

/** 60 → "UTC+1", 330 → "UTC+5:30", −480 → "UTC−8", 0 → "UTC". */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const a = Math.abs(minutes);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${minutes > 0 ? '+' : '−'}${h}${m ? `:${pad2(m)}` : ''}`;
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * The zone a place name keeps — the weather's "Copenhagen" — looked up in the
 * curated list and among the leaves of `zones` (the home zone, say). Null
 * when Atlas cannot tell; "Copenhagen, DK" reads as "Copenhagen".
 */
export function zoneForPlace(place: string | null | undefined, zones: readonly string[] = []): string | null {
  if (!place) return null;
  const q = fold(place.split(',')[0]);
  if (!q) return null;
  const hit = CURATED_CITIES.find((c) => fold(c.name) === q);
  if (hit) return hit.tz;
  return zones.find((tz) => fold(cityForZone(tz).name) === q) ?? null;
}

export type SunReading =
  /** The reading's place keeps the home zone's time, so its sun is the band's. */
  | { kind: 'here'; sun: SunSpan; place: string }
  /** A real reading, but for a place in another zone. */
  | { kind: 'elsewhere'; place: string }
  /** A real reading for a place whose zone Atlas cannot tell. */
  | { kind: 'unknown'; place: string }
  /** No reading yet, or only the built-in sample. */
  | { kind: 'none' };

export interface WeatherSun {
  location?: string | null;
  sunrise?: string | null;
  sunset?: string | null;
}

/**
 * The sun for the band. The weather's sunrise and sunset are wall-clock times
 * at the reading's place (datafetch.rs shifts them by that place's offset),
 * so they belong on the band — which is the home zone's day — only when that
 * place keeps the home zone's time right now. Anything else would draw one
 * city's daylight across another city's hours.
 */
export function homeSun(w: WeatherSun | null | undefined, homeTz: string, atMs: number, isSample: boolean): SunReading {
  if (!w || isSample) return { kind: 'none' };
  const span = sunSpan(w.sunrise, w.sunset);
  if (!span) return { kind: 'none' };
  const place = (w.location ?? '').trim();
  const tz = zoneForPlace(place, [homeTz]);
  if (!tz) return { kind: 'unknown', place: place || 'the reading' };
  if (zoneOffsetMinutes(tz, atMs) !== zoneOffsetMinutes(homeTz, atMs)) return { kind: 'elsewhere', place };
  return { kind: 'here', sun: span, place };
}

/** The line under the band that says where its daylight came from. */
export function sunCaption(r: SunReading): string {
  switch (r.kind) {
    case 'here': return `Sunrise ${minutesLabel(r.sun.sunrise)} · sunset ${minutesLabel(r.sun.sunset)} · ${r.place}`;
    case 'elsewhere': return `Daylight is a generic 06–20: the weather reading is for ${r.place}, which keeps another time.`;
    case 'unknown': return `Daylight is a generic 06–20: Atlas can't tell which time zone ${r.place} keeps.`;
    default: return 'Daylight is a generic 06–20 until a weather reading arrives.';
  }
}

const longDates = new Map<string, Intl.DateTimeFormat>();
const shortDates = new Map<string, Intl.DateTimeFormat>();

function cachedFormat(cache: Map<string, Intl.DateTimeFormat>, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });
    cache.set(tz, f);
  }
  return f;
}

/** "Wednesday 14 January" in `tz` — the hero's eyebrow. */
export function dateLine(tz: string, atMs: number): string {
  return cachedFormat(longDates, tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(atMs));
}

/**
 * An instant as the home zone's clock reads it, with as much date as it
 * needs: "14:05" today, "Thu 07:00" within the week, "3 Feb 09:00" beyond.
 */
export function whenLabel(tz: string, atMs: number, nowMs: number): string {
  const at = zoneTime(tz, atMs);
  const days = dayDelta(zoneTime(tz, nowMs).dateKey, at.dateKey);
  if (days === 0) return hhmm(at);
  if (days > 0 && days < 7) return `${DAY_SHORT[at.weekday]} ${hhmm(at)}`;
  return `${cachedFormat(shortDates, tz, { day: 'numeric', month: 'short' }).format(new Date(atMs))} ${hhmm(at)}`;
}

// ── Durations ────────────────────────────────────────────────────────────────

/** `m:ss`, `h:mm:ss`, with `.cc` when asked — the design's `fmtT`. Sign is the caller's. */
export function fmtDuration(ms: number, centis = false): string {
  const a = Math.abs(ms);
  const h = Math.floor(a / 3600000);
  const m = Math.floor(a / 60000) % 60;
  const s = Math.floor(a / 1000) % 60;
  const c = Math.floor(a / 10) % 100;
  return `${h ? `${h}:${pad2(m)}` : pad2(m)}:${pad2(s)}${centis ? `.${pad2(c)}` : ''}`;
}

/** "in 12 min", "in 2 h 5 min", "in 3 d 2 h". */
export function inLabel(deltaMs: number): string {
  const m = Math.max(0, Math.round(deltaMs / 60000));
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `in ${d} d ${h % 24} h`;
}

// ── Timer (counts up, with laps) ─────────────────────────────────────────────

export interface TimerState {
  running: boolean;
  /** When the current run began (epoch ms); meaningful while running. */
  startedAt: number;
  /** Time banked by earlier runs. */
  accMs: number;
  /** Elapsed totals at each lap mark, ascending. */
  laps: number[];
}

export const TIMER_IDLE: TimerState = { running: false, startedAt: 0, accMs: 0, laps: [] };

export function timerElapsed(t: TimerState, nowMs: number): number {
  return t.accMs + (t.running ? Math.max(0, nowMs - t.startedAt) : 0);
}

export interface LapRow {
  n: number;
  /** This lap's own duration. */
  split: string;
  /** Against the lap before: "—" for the first. */
  delta: string;
  deltaTone: 'none' | 'slower' | 'faster';
  /** Elapsed at the mark. */
  total: string;
  tag: 'Fastest' | 'Slowest' | null;
}

/** Newest first. Fastest/slowest are only called once there are more than two laps to compare. */
export function lapRows(laps: readonly number[]): LapRow[] {
  const durations = laps.map((t, i) => t - (i ? laps[i - 1] : 0));
  const tagged = durations.length > 2;
  const min = tagged ? Math.min(...durations) : null;
  const max = tagged ? Math.max(...durations) : null;
  return durations
    .map((d, i): LapRow => {
      const prev = i ? durations[i - 1] : null;
      const delta = prev == null ? null : d - prev;
      return {
        n: i + 1,
        split: fmtDuration(d, true),
        delta: delta == null ? '—' : `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${fmtDuration(delta, true)}`,
        deltaTone: delta == null || delta === 0 ? 'none' : delta > 0 ? 'slower' : 'faster',
        total: fmtDuration(laps[i], true),
        tag: tagged && d === min ? 'Fastest' : tagged && d === max && max !== min ? 'Slowest' : null,
      };
    })
    .reverse();
}

/** How long the lap in progress has run. */
export function currentLap(elapsed: number, laps: readonly number[]): number {
  return elapsed - (laps.length ? laps[laps.length - 1] : 0);
}

export function timerStatus(t: TimerState, elapsed: number): 'Running' | 'Paused' | 'Ready' {
  return t.running ? 'Running' : elapsed > 0 ? 'Paused' : 'Ready';
}

export const lapCountLabel = (n: number): string => `${n} ${n === 1 ? 'lap' : 'laps'}`;

// ── Countdown (counts down, past zero is a state) ────────────────────────────

export type CountdownMode = 'duration' | 'target';

export interface CountdownState {
  mode: CountdownMode;
  /** The duration, in ms, when `mode` is 'duration'. */
  durMs: number;
  /** A `datetime-local` value when `mode` is 'target'. */
  target: string;
  running: boolean;
  /** The instant it reaches zero; meaningful while running. */
  endAt: number;
  /** Time left when paused; null when not paused. */
  pausedLeft: number | null;
  /** Time left at each split, descending (negative past zero). */
  splits: number[];
  /** The `endAt` whose zero has been announced, so it is announced once. */
  announcedEnd: number;
  /**
   * The whole span as it stood at Start, kept through pauses; 0 before a
   * start. Without it a target countdown's total would shrink with the clock
   * and its ring would never empty.
   */
  spanMs: number;
}

export const COUNTDOWN_PRESETS: readonly { label: string; minutes: number }[] = [
  { label: '5 min', minutes: 5 }, { label: '10 min', minutes: 10 }, { label: '25 min', minutes: 25 },
  { label: '45 min', minutes: 45 }, { label: '1 h', minutes: 60 },
];
export const COUNTDOWN_MIN_MS = 60000;

export const COUNTDOWN_IDLE: CountdownState = {
  mode: 'duration', durMs: 25 * 60000, target: '', running: false, endAt: 0, pausedLeft: null, splits: [], announcedEnd: 0, spanMs: 0,
};

/** A `datetime-local` value as an instant, or null when it does not parse. */
export function parseTargetLocal(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The whole span: as it stood at Start once started, else the duration or the time from now to the target (never negative). */
export function countdownTotal(c: CountdownState, nowMs: number): number {
  if ((c.running || c.pausedLeft != null) && c.spanMs > 0) return c.spanMs;
  if (c.mode === 'target') {
    const t = parseTargetLocal(c.target);
    return t == null ? 0 : Math.max(0, t - nowMs);
  }
  return c.durMs;
}

/** Time left: negative once past zero while running. */
export function countdownLeft(c: CountdownState, nowMs: number): number {
  if (c.running) return c.endAt - nowMs;
  if (c.pausedLeft != null) return c.pausedLeft;
  return countdownTotal(c, nowMs);
}

export const RING_R = 120;
export const RING_C = 2 * Math.PI * RING_R;

/** Dash offset for the ring: full at the start, empty at zero, and empty past zero. */
export function ringOffset(left: number, total: number): number {
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  return Math.round(RING_C * (1 - frac) * 10) / 10;
}

export interface SplitRow { n: number; left: string; used: string }

/** Newest first: how much was left at the mark, and how much the stretch before it took. */
export function splitRows(splits: readonly number[], total: number): SplitRow[] {
  return splits
    .map((left, i) => ({
      n: i + 1,
      left: `${left < 0 ? '+' : ''}${fmtDuration(left)}`,
      used: fmtDuration((i ? splits[i - 1] : total) - left),
    }))
    .reverse();
}

/** Whether Start (or Resume) has anything to count. */
export function countdownCanStart(c: CountdownState, nowMs: number): boolean {
  return !c.running && (c.pausedLeft != null || countdownTotal(c, nowMs) > 0);
}

/** The line under the ring. `tz` is the zone the end time is read in. */
export function countdownStatus(c: CountdownState, nowMs: number, tz: string): string {
  const left = countdownLeft(c, nowMs);
  if (c.running) return left < 0 ? 'Past zero · still counting' : `Running · ends ${whenLabel(tz, c.endAt, nowMs)}`;
  if (c.pausedLeft != null) return c.pausedLeft < 0 ? 'Paused past zero' : 'Paused';
  if (c.mode === 'target') {
    const t = parseTargetLocal(c.target);
    if (t == null) return 'Pick a date and time';
    if (t <= nowMs) return 'That moment has passed';
  }
  return 'Ready';
}

/** A `datetime-local` string for `ms` in the Mac's own zone (the input is local). */
export function targetInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ── Alarms ───────────────────────────────────────────────────────────────────

export interface Alarm {
  id: string;
  /** `HH:MM`, read on the home zone's clock. */
  time: string;
  label: string;
  /** Weekdays (0 = Sunday); empty means once. */
  days: number[];
  on: boolean;
  /** The instant a snooze rings, or null. */
  snoozedUntil: number | null;
}

export const DAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];
export const DAY_LETTER: readonly string[] = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const DAY_SHORT: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const SNOOZE_MINUTES = 9;
/** An alarm found due later than this is reported as missed rather than rung. */
export const RING_GRACE_MS = 10 * 60000;

export function daysLabel(days: readonly number[]): string {
  if (days.length === 7) return 'Every day';
  if (days.length === 5 && !days.includes(0) && !days.includes(6)) return 'Weekdays';
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends';
  if (days.length === 0) return 'Once';
  return DAY_ORDER.filter((d) => days.includes(d)).map((d) => DAY_SHORT[d]).join(', ');
}

export function parseHHMM(s: string): { hh: number; mm: number } | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh <= 23 && mm <= 59 ? { hh, mm } : null;
}

/**
 * When `a` rings next after `nowMs`: a pending snooze first, otherwise the
 * next of the next eight days whose weekday the alarm allows. Null when the
 * time does not parse. The repeat days are judged in `tz`, like the time.
 */
export function nextFire(a: Alarm, nowMs: number, tz: string): number | null {
  if (a.snoozedUntil != null && a.snoozedUntil > nowMs) return a.snoozedUntil;
  const t = parseHHMM(a.time);
  if (!t) return null;
  for (let i = 0; i < 8; i++) {
    const day = zoneTime(tz, nowMs + i * 86400000);
    const at = zoneInstant(tz, day.year, day.month, day.day, t.hh, t.mm);
    if (at <= nowMs) continue;
    if (a.days.length && !a.days.includes(zoneTime(tz, at).weekday)) continue;
    return at;
  }
  return null;
}

export interface AlarmPlan { alarm: Alarm; at: number }

/** The soonest enabled alarm, or null. */
export function nextAlarm(alarms: readonly Alarm[], nowMs: number, tz: string): AlarmPlan | null {
  let best: AlarmPlan | null = null;
  for (const alarm of alarms) {
    if (!alarm.on) continue;
    const at = nextFire(alarm, nowMs, tz);
    if (at != null && (!best || at < best.at)) best = { alarm, at };
  }
  return best;
}

/**
 * Alarms that came due in (`lastMs`, `nowMs`]: `ring` when found within the
 * grace, `missed` when the gap was longer — a Mac that slept through 07:30
 * and woke at 09:00 should say so, not ring at nine.
 */
export function dueAlarms(alarms: readonly Alarm[], lastMs: number, nowMs: number, tz: string, graceMs = RING_GRACE_MS): { ring: AlarmPlan[]; missed: AlarmPlan[] } {
  const ring: AlarmPlan[] = [];
  const missed: AlarmPlan[] = [];
  for (const alarm of alarms) {
    if (!alarm.on) continue;
    const at = nextFire(alarm, lastMs, tz);
    if (at == null || at > nowMs) continue;
    (nowMs - at <= graceMs ? ring : missed).push({ alarm, at });
  }
  return { ring, missed };
}

/** The alarm after it has rung (or been missed): the snooze is spent, and a one-off switches off. */
export function afterFire(a: Alarm): Alarm {
  return { ...a, snoozedUntil: null, on: a.days.length > 0 };
}

export function snoozeUntil(nowMs: number, minutes = SNOOZE_MINUTES): number {
  return nowMs + minutes * 60000;
}

export const sortAlarms = (alarms: readonly Alarm[]): Alarm[] => [...alarms].sort((p, q) => p.time.localeCompare(q.time));

export function newAlarmId(nowMs: number): string {
  return `al_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** The honest note's shape: an early alarm far enough away that the Mac has to be kept awake for it. */
export function earlyNext(next: AlarmPlan | null, nowMs: number, tz: string): boolean {
  if (!next) return false;
  return zoneTime(tz, next.at).hour < 10 && next.at - nowMs > 3 * 3600000;
}

/** "in 9 h 12 min", or "Off" — the row's right-hand word. */
export function alarmWhen(a: Alarm, nowMs: number, tz: string): string {
  if (!a.on) return 'Off';
  const at = nextFire(a, nowMs, tz);
  return at == null ? 'Off' : inLabel(at - nowMs);
}

/** "Snoozed until 07:39" while a snooze is pending, else null. */
export function snoozeLine(a: Alarm, nowMs: number, tz: string): string | null {
  return a.snoozedUntil != null && a.snoozedUntil > nowMs ? `Snoozed until ${hhmm(zoneTime(tz, a.snoozedUntil))}` : null;
}

/** The hero's line under the time. */
export function heroLine(next: AlarmPlan | null, alarms: readonly Alarm[], nowMs: number, tz: string): string {
  if (next) return `Next alarm: ${next.alarm.label || 'Alarm'} at ${whenLabel(tz, next.at, nowMs)}, ${inLabel(next.at - nowMs)}. Rings only while Atlas is running.`;
  return alarms.length ? 'No alarms are switched on.' : 'No alarms yet.';
}

/** A fresh alarm for the editor: seven on weekdays, the design's default. */
export function draftAlarm(nowMs: number): Alarm {
  return { id: newAlarmId(nowMs), time: '07:00', label: 'Alarm', days: [1, 2, 3, 4, 5], on: true, snoozedUntil: null };
}

/**
 * What Save stores: a trimmed label (never empty), the days in order, a spent
 * snooze cleared (the time it was snoozing may have changed), and switched on
 * — saving an alarm is asking for it. Null when the time does not parse.
 */
export function finishAlarm(draft: Alarm): Alarm | null {
  const t = parseHHMM(draft.time);
  if (!t) return null;
  return {
    ...draft,
    time: `${pad2(t.hh)}:${pad2(t.mm)}`,
    label: draft.label.trim() || 'Alarm',
    days: DAY_ORDER.filter((d) => draft.days.includes(d)),
    on: true,
    snoozedUntil: null,
  };
}

// ── Preferences (localStorage 'atlas:clock') ─────────────────────────────────

export interface ClockPrefs {
  cities: CityRef[];
  alarms: Alarm[];
  timer: TimerState;
  countdown: CountdownState;
  /**
   * The zone alarms are read in — the screen's home zone, saved so that a
   * fresh launch rings an alarm on the clock it was set on even before the
   * profile has loaded. Null until the screen has said; then this Mac's zone.
   */
  zone: string | null;
}

export const PREFS_KEY = 'atlas:clock';

export function defaultPrefs(): ClockPrefs {
  return { cities: [...DEFAULT_CITIES], alarms: [], timer: { ...TIMER_IDLE, laps: [] }, countdown: { ...COUNTDOWN_IDLE, splits: [] }, zone: null };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const numList = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : []);

/** A saved blob back into preferences; anything unreadable falls back to the default for that field. */
export function parsePrefs(raw: string | null): ClockPrefs {
  const out = defaultPrefs();
  if (!raw) return out;
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v)) return out;

    if (Array.isArray(v.cities)) {
      const cities = v.cities
        .filter(isRecord)
        .map((c) => ({ name: str(c.name, ''), tz: str(c.tz, '') }))
        .filter((c) => c.name && validZone(c.tz));
      // An empty saved list is a choice; a missing one is the default.
      out.cities = cities;
    }

    if (Array.isArray(v.alarms)) {
      out.alarms = v.alarms
        .filter(isRecord)
        .map((a): Alarm => ({
          id: str(a.id, ''),
          time: str(a.time, ''),
          label: str(a.label, 'Alarm'),
          days: numList(a.days).filter((d) => d >= 0 && d <= 6 && Number.isInteger(d)),
          on: a.on === true,
          snoozedUntil: typeof a.snoozedUntil === 'number' && Number.isFinite(a.snoozedUntil) ? a.snoozedUntil : null,
        }))
        .filter((a) => a.id && parseHHMM(a.time));
    }

    out.zone = typeof v.zone === 'string' ? validZone(v.zone) : null;

    if (isRecord(v.timer)) {
      const t = v.timer;
      const laps = numList(t.laps);
      // Laps are ascending marks by construction; a corrupt order is dropped rather than drawn.
      const ascending = laps.every((l, i) => i === 0 || l >= laps[i - 1]);
      out.timer = {
        running: t.running === true,
        startedAt: num(t.startedAt, 0),
        accMs: Math.max(0, num(t.accMs, 0)),
        laps: ascending ? laps : [],
      };
      if (out.timer.running && out.timer.startedAt <= 0) out.timer.running = false;
    }

    if (isRecord(v.countdown)) {
      const c = v.countdown;
      const mode: CountdownMode = c.mode === 'target' ? 'target' : 'duration';
      out.countdown = {
        mode,
        durMs: Math.max(COUNTDOWN_MIN_MS, num(c.durMs, COUNTDOWN_IDLE.durMs)),
        target: str(c.target, ''),
        running: c.running === true,
        endAt: num(c.endAt, 0),
        pausedLeft: typeof c.pausedLeft === 'number' && Number.isFinite(c.pausedLeft) ? c.pausedLeft : null,
        splits: numList(c.splits),
        announcedEnd: num(c.announcedEnd, 0),
        spanMs: Math.max(0, num(c.spanMs, 0)),
      };
      if (out.countdown.running && out.countdown.endAt <= 0) out.countdown.running = false;
    }
  } catch {
    /* a corrupt preference is a default, not a crash */
  }
  return out;
}
