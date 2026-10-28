/**
 * The widget screens' reading of their data — pure, tested here, rendered by
 * src/components/atlas/home/views/*. Weather: the sky mix a condition maps to,
 * the sun's place on its arc, the moon's phase, the week's bars, the air
 * reading's words. Calendar: the day's window, where an event sits in it, the
 * free slots Atlas can offer, the headline. Tasks: the headline, the priority
 * cycle, the due label, which tasks Atlas can be asked to take. Briefing: what
 * the voice reads and whether a story can be opened.
 */
import type { CalendarEvent } from '@/hooks/useCalendarEvents';
import type { NewsItem } from '@/hooks/useNews';
import type { SkyMix } from './weatherSky';

/**
 * The fields of a task this file reads. Structural on purpose: importing the
 * type from src/hooks/useTasks.ts would pull that hook into the strict gate
 * (tsconfig.strict.json), which it does not pass. A `Task` from the hook fits.
 * `completed` is a 0/1 integer in SQLite and a boolean once the hook has it;
 * both read the same here.
 */
export interface ViewTask {
  id: string;
  title: string;
  completed: boolean | number;
  priority: string | null;
  due_date: string | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ---- Weather ---------------------------------------------------------------------

/** "6:42 AM" → minutes since midnight; "3PM" → 900; anything else → null. */
export function parseClockLabel(label: string): number | null {
  const m = label.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + parseInt(m[2] ?? '0', 10);
}

/** The hour a forecast slice stands for; the "Now" slice is the current hour. */
export function hourOfLabel(label: string, nowHour: number): number {
  const mins = parseClockLabel(label);
  return mins == null ? nowHour : Math.floor(mins / 60);
}

/** 0 by day, 1 by night, .5 in the hour the sun rises or sets. Without times: 7–17 is day. */
export function nightAt(hour: number, sunriseMin: number | null, sunsetMin: number | null): number {
  const rise = sunriseMin == null ? 7 : Math.floor(sunriseMin / 60);
  const set = sunsetMin == null ? 17 : Math.floor(sunsetMin / 60);
  if (hour === rise || hour === set) return 0.5;
  return hour > rise && hour < set ? 0 : 1;
}

/** What the Rust fetch's icon words (and the condition behind them) mean for the sky. */
export function skyMix(icon: string, condition: string, windMph: number, hour: number, sunriseMin: number | null, sunsetMin: number | null): SkyMix {
  const night = nightAt(hour, sunriseMin, sunsetMin);
  const wind = clamp01(windMph / 30);
  const foggy = /fog|mist|haze|smoke/i.test(condition);
  const base: Record<string, Omit<SkyMix, 'night' | 'wind'>> = {
    'sunny': { cloud: 0.12, rain: 0, sun: 1, fog: 0 },
    'partly-cloudy': { cloud: 0.45, rain: 0, sun: 0.9, fog: 0 },
    'cloudy': { cloud: 0.86, rain: 0, sun: 0.45, fog: 0 },
    'rainy': { cloud: 0.95, rain: 0.8, sun: 0.2, fog: 0.05 },
    'stormy': { cloud: 1, rain: 0.95, sun: 0.1, fog: 0 },
    'snowy': { cloud: 0.9, rain: 0.3, sun: 0.3, fog: 0.35 },
  };
  const b = base[icon] ?? base['cloudy'];
  return {
    cloud: b.cloud,
    rain: b.rain,
    wind: Math.max(wind, b.rain > 0.5 ? 0.35 : 0),
    sun: b.sun * (1 - night),
    night,
    fog: foggy ? Math.max(0.8, b.fog) : b.fog,
  };
}

/** The Rust fetch's icon word as a reader would say it: 'partly-cloudy' → 'Partly cloudy'. */
export function iconWord(icon: string): string {
  const w = icon.replace(/-/g, ' ').trim();
  return w ? w[0].toUpperCase() + w.slice(1) : 'Unknown';
}

/** The design's one word for a mix. */
export function skyWord(m: SkyMix): string {
  if (m.rain > 0.6) return 'Heavy rain';
  if (m.rain > 0.2) return 'Rain';
  if (m.rain > 0) return 'Drizzle';
  if (m.fog > 0.5) return 'Fog';
  if (m.wind > 0.8) return 'Windy';
  if (m.cloud > 0.8) return 'Overcast';
  if (m.cloud > 0.55) return 'Cloudy';
  if (m.night >= 1) return 'Clear night';
  return 'Sunny spells';
}

/** How much the sun or moon body shows through, and how soft it is, for a mix. */
export function bodyLook(m: SkyMix): { opacity: number; blurPx: number } {
  return {
    opacity: Math.max(0.18, 1 - m.cloud * 0.55 - m.rain * 0.35 - m.fog * 0.3),
    blurPx: m.cloud * 3 + m.fog * 4,
  };
}

export interface ArcPoint { day: boolean; frac: number; x: number; y: number }

/**
 * Where the light sits on the design's arc (percentages of the box): the sun
 * from sunrise (left) to sunset (right) by day, the moon across the night.
 */
export function sunArc(nowMin: number, sunriseMin: number | null, sunsetMin: number | null): ArcPoint {
  const rise = sunriseMin ?? 7 * 60, set = sunsetMin ?? 17 * 60;
  const day = nowMin >= rise && nowMin <= set;
  const frac = day
    ? clamp01((nowMin - rise) / Math.max(1, set - rise))
    : clamp01(((nowMin - set + 1440) % 1440) / Math.max(1, 1440 - (set - rise)));
  const ang = Math.PI * (1 - frac);
  return { day, frac, x: +(50 + Math.cos(ang) * 45.2).toFixed(1), y: +(95 - Math.sin(ang) * 86).toFixed(1) };
}

/** "9h 14m of light", from the two clock labels. */
export function daylightLabel(sunriseMin: number | null, sunsetMin: number | null): string | null {
  if (sunriseMin == null || sunsetMin == null || sunsetMin <= sunriseMin) return null;
  const mins = sunsetMin - sunriseMin;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m of light`;
}

/** Minutes since midnight as "07:24". */
export function clock24(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const SYNODIC_DAYS = 29.530588853;
/** A reference new moon: 2000-01-06 18:14 UTC. */
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const PHASE_NAMES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];

/** The moon's phase on a date, from the synodic month — maths, not a feed. */
export function moonPhase(at: number): { name: string; illumination: number; age: number } {
  const days = (at - NEW_MOON_MS) / 86400000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const frac = age / SYNODIC_DAYS;
  const illumination = Math.round((1 - Math.cos(frac * 2 * Math.PI)) / 2 * 100);
  const name = PHASE_NAMES[Math.round(frac * 8) % 8];
  return { name, illumination, age };
}

export interface DayBar { day: string; icon: string; lo: number; hi: number; left: number; width: number; warm: boolean }

/** The week's rows: each day's span laid against the week's own range, the warmest day marked. */
export function dayBars(daily: readonly { day: string; high: number; low: number; icon: string }[]): DayBar[] {
  if (!daily.length) return [];
  const lo = Math.min(...daily.map((d) => d.low));
  const hi = Math.max(...daily.map((d) => d.high));
  const span = Math.max(1, hi - lo);
  return daily.map((d) => ({
    day: d.day,
    icon: d.icon,
    lo: Math.round(d.low),
    hi: Math.round(d.high),
    left: +(((d.low - lo) / span) * 100).toFixed(1),
    width: +(Math.max(4, ((d.high - d.low) / span) * 100)).toFixed(1),
    warm: d.high === hi,
  }));
}

/** OpenWeather's 1–5 scale in words and tones. */
export const AQI_WORDS = ['', 'Good', 'Fair', 'Moderate', 'Poor', 'Very poor'] as const;
export function aqiWord(aqi: number): string { return AQI_WORDS[aqi] ?? 'Unknown'; }
export function aqiTone(aqi: number): 'good' | 'mid' | 'bad' { return aqi <= 2 ? 'good' : aqi === 3 ? 'mid' : 'bad'; }
/** PM2.5 against the WHO-ish 75 µg/m³ ceiling the Home widget uses, 0–1. */
export function pm25Fraction(pm25: number): number { return clamp01(pm25 / 75); }

/** One line Atlas can stand behind: a rule on the reading, not a forecast of pollen. */
export function airAdvice(aqi: number, pm25: number): string {
  if (aqi <= 1) return 'Clean air right now — a good time to open the windows.';
  if (aqi === 2) return 'The air is fair. Fine for a run or an open window.';
  if (aqi === 3) return `Moderate air (PM2.5 ${Math.round(pm25)} µg/m³). Sensitive lungs may want to keep windows shut.`;
  if (aqi === 4) return `Poor air (PM2.5 ${Math.round(pm25)} µg/m³). Keep windows closed and skip the long run.`;
  return `Very poor air (PM2.5 ${Math.round(pm25)} µg/m³). Stay in with the windows shut if you can.`;
}

// ---- Calendar --------------------------------------------------------------------

const DEFAULT_LENGTH_MS = 45 * 60000;
const endOf = (e: CalendarEvent) => e.end_time ? Date.parse(e.end_time) : Date.parse(e.start_time) + DEFAULT_LENGTH_MS;
const HOUR = 3600000;

export function startOfDay(at: number): number {
  const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime();
}

/** Events that start on the local day beginning at `dayStart`, by start. */
export function eventsOnDay(events: readonly CalendarEvent[], dayStart: number): CalendarEvent[] {
  const end = dayStart + 24 * HOUR;
  return events
    .filter((e) => { const t = Date.parse(e.start_time); return t >= dayStart && t < end; })
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

/** The hours the day grid shows: 8–18, widened to hold every event of the day. */
export function dayWindow(events: readonly CalendarEvent[], dayStart: number): { startHour: number; endHour: number } {
  let startHour = 8, endHour = 18;
  for (const e of events) {
    const s = Math.floor((Date.parse(e.start_time) - dayStart) / HOUR);
    const en = Math.ceil((endOf(e) - dayStart) / HOUR);
    if (s < startHour) startHour = Math.max(0, s);
    if (en > endHour) endHour = Math.min(24, en);
  }
  return { startHour, endHour };
}

/** Top and height in px for an event in a grid of `hourPx` per hour, with the design's 2px insets. */
export function eventBox(e: CalendarEvent, dayStart: number, startHour: number, hourPx: number): { top: number; height: number } {
  const start = (Date.parse(e.start_time) - dayStart) / HOUR - startHour;
  const hours = Math.max(0.25, (endOf(e) - Date.parse(e.start_time)) / HOUR);
  return { top: Math.round(start * hourPx + 2), height: Math.max(22, Math.round(hours * hourPx - 4)) };
}

export interface FreeSlot { start: number; end: number; minutes: number }

/**
 * Gaps in the day Atlas can offer: from `from` (now, or the window's start on
 * another day) to the window's end, at least `min` minutes, each capped at an
 * hour, a long gap also offering its last hour — at most `max` slots.
 */
export function freeSlots(events: readonly CalendarEvent[], dayStart: number, startHour: number, endHour: number, from: number, min = 30, max = 3): FreeSlot[] {
  // A slot offered "now" starts on the next quarter hour, not at 12:07:33.
  const windowStart = Math.max(dayStart + startHour * HOUR, ceilQuarter(from));
  const windowEnd = dayStart + endHour * HOUR;
  const busy = events.map((e) => [Date.parse(e.start_time), endOf(e)] as const).sort((a, b) => a[0] - b[0]);
  const out: FreeSlot[] = [];
  const offer = (s: number, e: number) => {
    const gap = (e - s) / 60000;
    if (gap < min) return;
    out.push({ start: s, end: s + Math.min(gap, 60) * 60000, minutes: Math.min(gap, 60) });
    if (gap >= 150) out.push({ start: e - 60 * 60000, end: e, minutes: 60 });
  };
  let cursor = windowStart;
  for (const [s, e] of busy) {
    if (e <= cursor) continue;
    if (s > cursor) offer(cursor, Math.min(s, windowEnd));
    cursor = Math.max(cursor, e);
    if (cursor >= windowEnd) break;
  }
  if (cursor < windowEnd) offer(cursor, windowEnd);
  return out.slice(0, max);
}

/** A time rounded up to the next quarter hour on the local clock (a time on one stays put). */
export function ceilQuarter(at: number): number {
  const d = new Date(at);
  if (d.getSeconds() || d.getMilliseconds()) { d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1); }
  const rem = d.getMinutes() % 15;
  if (rem) d.setMinutes(d.getMinutes() + 15 - rem);
  return d.getTime();
}

/** The title a block booked for a task carries — how the day knows the task has its time. */
export function focusTitle(task: Pick<ViewTask, 'title'> | null): string {
  return task ? `Focus: ${task.title.trim()}` : 'Focus block';
}

/**
 * What booking each slot is for: the open tasks Atlas would take first, one
 * per slot, so the block lands in the calendar with the work it makes room
 * for — skipping a task that already has a block that day — and a plain
 * focus block once the tasks run out.
 */
export function slotPlans<T extends ViewTask>(slotCount: number, tasks: readonly T[], dayTitles: readonly string[]): (T | null)[] {
  const booked = new Set(dayTitles.map((t) => t.trim()));
  const order = delegable(tasks.filter((t) => !booked.has(focusTitle(t))), slotCount);
  return Array.from({ length: slotCount }, (_, i) => order[i] ?? null);
}

export function fmtMinutes(mins: number): string {
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** "4 meetings, 3h 15m" · "1 meeting, 30 min" · "A free day". */
export function meetingsHeadline(events: readonly CalendarEvent[]): string {
  if (!events.length) return 'A free day';
  const mins = events.reduce((a, e) => a + (endOf(e) - Date.parse(e.start_time)) / 60000, 0);
  return `${events.length} ${events.length === 1 ? 'meeting' : 'meetings'}, ${fmtMinutes(mins)}`;
}

export interface WeekDay { dayStart: number; letter: string; number: number; today: boolean; past: boolean }

/** Monday to Sunday of the week `now` falls in; days before today are past. */
export function weekDays(now: number): WeekDay[] {
  const today = startOfDay(now);
  // Calendar arithmetic, not millisecond arithmetic: a week that crosses a
  // DST change has a 23- or 25-hour day in it.
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + i);
    const dayStart = date.getTime();
    return {
      dayStart,
      letter: ['S', 'M', 'T', 'W', 'T', 'F', 'S'][date.getDay()],
      number: date.getDate(),
      today: dayStart === today,
      past: dayStart < today,
    };
  });
}

/** The event the side card shows: the one picked, else the one on or next, else the first. */
export function cardEvent(events: readonly CalendarEvent[], pickedId: string | null, now: number): CalendarEvent | null {
  const picked = pickedId ? events.find((e) => e.id === pickedId) : undefined;
  if (picked) return picked;
  return events.find((e) => endOf(e) >= now) ?? events[0] ?? null;
}

// ---- Tasks -----------------------------------------------------------------------

export function taskHeadline(done: number, total: number): string {
  if (!total) return 'Nothing on the list';
  return `${done} of ${total} done`;
}

export function taskSub(tasks: readonly ViewTask[], now: number): string {
  const open = tasks.filter((t) => !t.completed);
  if (!tasks.length) return 'Add a task below, or say it to Atlas.';
  if (!open.length) return 'Everything is done.';
  const today = startOfDay(now);
  const overdue = open.filter((t) => t.due_date && Date.parse(t.due_date) < today).length;
  if (overdue) return `${overdue} ${overdue === 1 ? 'task is' : 'tasks are'} overdue.`;
  const high = open.filter((t) => priorityTone(t.priority) === 'high').length;
  if (high) return `${high} high-priority ${high === 1 ? 'task' : 'tasks'} still open.`;
  return 'Nothing urgent left.';
}

export type PriorityTone = 'high' | 'med' | 'low';
export function priorityTone(p: string | null): PriorityTone {
  const k = (p ?? '').toLowerCase();
  return k === 'high' ? 'high' : k === 'low' ? 'low' : 'med';
}
export function priorityWord(p: string | null): string {
  return { high: 'High', med: 'Med', low: 'Low' }[priorityTone(p)];
}
/** Tapping the pill cycles low → medium → high → low; the store spells them in full. */
export function nextPriority(p: string | null): string {
  return { low: 'medium', med: 'high', high: 'low' }[priorityTone(p)];
}

/** "Due today" · "Due tomorrow" · "Overdue · Mon 3 Nov" · "Due Fri 7 Nov" · "No due date". */
export function dueLabel(due: string | null, now: number): string {
  if (!due) return 'No due date';
  const t = Date.parse(due);
  if (Number.isNaN(t)) return 'No due date';
  const today = startOfDay(now);
  const day = startOfDay(t);
  const date = new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (day === today) return 'Due today';
  if (day === today + 24 * HOUR) return 'Due tomorrow';
  if (day < today) return `Overdue · ${date}`;
  return `Due ${date}`;
}

/** The `value` an `<input type="date">` wants for a due date, or ''. */
export function dueInputValue(due: string | null): string {
  if (!due) return '';
  const t = Date.parse(due);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Open tasks in the order Atlas would take them: high first, nearest due first. */
export function delegable<T extends ViewTask>(tasks: readonly T[], max = 3): T[] {
  const rank: Record<PriorityTone, number> = { high: 0, med: 1, low: 2 };
  return tasks
    .filter((t) => !t.completed)
    .sort((a, b) => {
      const r = rank[priorityTone(a.priority)] - rank[priorityTone(b.priority)];
      if (r) return r;
      const da = a.due_date ? Date.parse(a.due_date) : Infinity, db = b.due_date ? Date.parse(b.due_date) : Infinity;
      return da - db;
    })
    .slice(0, max);
}

/** Open tasks first, then done; each group as the store ordered them. */
export function orderTasks<T extends ViewTask>(tasks: readonly T[]): T[] {
  return [...tasks.filter((t) => !t.completed), ...tasks.filter((t) => t.completed)];
}

/** The ring's dash offset for a 0–1 fraction on a circle of this circumference. */
export function ringOffset(circumference: number, fraction: number): number {
  return +(circumference * (1 - clamp01(fraction))).toFixed(1);
}

// ---- Briefing --------------------------------------------------------------------

/** A story can be opened when its link is a real address, not the sample's '#'. */
export function storyUrlOk(url: string | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

/** What the voice reads for a story: the headline, then the summary if there is one. */
export function listenText(story: NewsItem): string {
  const body = story.description?.trim();
  return body ? `${story.title.trim()}. ${body}` : story.title.trim();
}

/** The question the "why it matters" card asks the brain. */
export function whyQuestion(story: NewsItem): string {
  const body = story.description?.trim();
  return `Why might this headline matter to me? "${story.title.trim()}" (${story.source}${body ? `: ${body}` : ''}). Two sentences, and say so if you cannot tell.`;
}

/** How many stories one Listen reads — the design's "all six", and one request's worth of speech. */
export const BRIEFING_READS = 6;

/**
 * The stories one Listen reads: the one on screen first, then the ones after
 * it, wrapping round, at most `max`. A tapped story is where the reading
 * starts, so "Listen" always begins with what you are looking at.
 */
export function briefingOrder<T>(news: readonly T[], from: number, max = BRIEFING_READS): T[] {
  if (!news.length) return [];
  const start = ((from % news.length) + news.length) % news.length;
  const out: T[] = [];
  for (let i = 0; i < Math.min(max, news.length); i++) out.push(news[(start + i) % news.length]);
  return out;
}

/**
 * The whole reading as one text, each story its own paragraph. One text, not
 * a queue of six: the voice gateway fetches every queued sentence at once,
 * and six parallel requests run into the speech provider's concurrency limit.
 */
export function briefingText(stories: readonly NewsItem[]): string {
  return stories.map(listenText).join('\n\n');
}

/** Minutes the reading takes at a speaking pace of 160 words a minute, at least one. */
export function readingMinutes(text: string, wpm = 160): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.round(words / wpm));
}

// ---- Weather: the slice and the air in full (row 4) ------------------------------

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Where the wind blows from, as a compass point: 290° → "W". */
export function windFrom(deg: number | null | undefined): string | null {
  if (deg == null || !Number.isFinite(deg)) return null;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** The rain bar's height in a slice, 0–1: 5 mm in three hours is a downpour. */
export function rainFraction(mm: number | null | undefined, ceiling = 5): number {
  return mm && mm > 0 ? clamp01(mm / ceiling) : 0;
}

/** "60% · 1.2 mm" · "20%" · "1.2 mm" · null — what a slice says about rain. */
export function sliceRain(pop: number | null | undefined, mm: number | null | undefined): string | null {
  const parts: string[] = [];
  if (pop != null && pop > 0) parts.push(`${Math.round(pop)}%`);
  if (mm != null && mm > 0) parts.push(`${mm.toFixed(1)} mm`);
  return parts.length ? parts.join(' · ') : null;
}

export type Pollutant = 'pm25' | 'pm10' | 'o3' | 'no2';

/**
 * OpenWeather's own bands for each pollutant (µg/m³), the lower edge of
 * Fair, Moderate, Poor and Very poor — the table its 1–5 index is read from.
 */
export const POLLUTANT_BANDS: Record<Pollutant, readonly [number, number, number, number]> = {
  pm25: [10, 25, 50, 75],
  pm10: [20, 50, 100, 200],
  o3: [60, 100, 140, 180],
  no2: [40, 70, 150, 200],
};
export const POLLUTANT_LABEL: Record<Pollutant, string> = { pm25: 'PM2.5', pm10: 'PM10', o3: 'O₃', no2: 'NO₂' };

/** A pollutant's own 1–5 band (the same scale as the index). */
export function pollutantBand(kind: Pollutant, v: number): number {
  const edges = POLLUTANT_BANDS[kind];
  return 1 + edges.filter((e) => v >= e).length;
}

/** The bar's fill: the reading against the edge of Very poor. */
export function pollutantFraction(kind: Pollutant, v: number): number {
  return clamp01(v / POLLUTANT_BANDS[kind][3]);
}

/** The pollutants the reading carries, in the design's order, skipping any the station does not report. */
export function pollutantRows(air: { pm25: number; pm10?: number | null; o3?: number | null; no2?: number | null }): { kind: Pollutant; label: string; value: number; band: number; fraction: number }[] {
  const all: [Pollutant, number | null | undefined][] = [['pm25', air.pm25], ['pm10', air.pm10], ['o3', air.o3], ['no2', air.no2]];
  return all.flatMap(([kind, v]) => (v == null || !Number.isFinite(v) ? [] : [{
    kind, label: POLLUTANT_LABEL[kind], value: v, band: pollutantBand(kind, v), fraction: pollutantFraction(kind, v),
  }]));
}

/** "Feels 66°" when it differs from the reading by a degree or more; null otherwise. */
export function feelsLine(temp: number, feels: number | null | undefined): string | null {
  if (feels == null || !Number.isFinite(feels)) return null;
  return Math.round(feels) !== Math.round(temp) ? `Feels ${Math.round(feels)}°` : null;
}

// ---- Calendar: Atlas prepares a meeting (row 9) ----------------------------------

const TIME_ONLY = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const PREP_WHEN = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

/**
 * The question "Prepare" asks the brain: the event's own fields and nothing
 * else from the calendar, so what leaves the Mac is exactly what the card
 * shows. The brain may add what it already knows (mail, memory) and says so.
 */
export function prepareQuestion(e: Pick<CalendarEvent, 'title' | 'start_time' | 'end_time' | 'location' | 'attendees' | 'description'>): string {
  const lines = [
    'Prepare me for this event. Write short notes I can read in a minute: what it is likely about, what to bring or decide, and two or three questions worth asking.',
    'Use the details below and anything you already know about these people or this subject from my mail and memory, and say which is which. If there is too little to go on, say so in one line instead of guessing.',
    '',
    `Title: ${e.title.trim()}`,
    `When: ${PREP_WHEN.format(new Date(e.start_time))}${e.end_time ? ` to ${TIME_ONLY.format(new Date(e.end_time))}` : ''}`,
  ];
  if (e.location?.trim()) lines.push(`Where: ${e.location.trim()}`);
  if (e.attendees.length) lines.push(`With: ${e.attendees.join(', ')}`);
  if (e.description?.trim()) lines.push(`Notes on the event: ${e.description.trim().slice(0, 2000)}`);
  return lines.join('\n');
}

/** "Prepared 12 min ago" · "Prepared yesterday" — how old a note is. */
export function notedLabel(verb: string, notedAt: string | null, now: number): string {
  const t = notedAt ? Date.parse(notedAt) : NaN;
  if (!Number.isFinite(t)) return verb;
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return `${verb} just now`;
  if (mins < 60) return `${verb} ${mins} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(t)) / (24 * HOUR));
  if (days <= 0) return `${verb} ${Math.round(mins / 60)} h ago`;
  if (days === 1) return `${verb} yesterday`;
  return `${verb} ${days} days ago`;
}

// ---- Tasks: Atlas researches a task (row 10) -------------------------------------

/** The question "Research" asks: the task's own fields, a short note back. */
export function researchQuestion(t: Pick<ViewTask, 'title' | 'due_date' | 'priority'>, now: number): string {
  return [
    'Research this task for me and write a short note, five lines at most: what it involves, the first concrete step, and anything I should check or watch out for.',
    'Use what you know from my mail and memory where it helps, and look things up if you need to. If you cannot tell, say so in one line.',
    '',
    `Task: ${t.title.trim()}`,
    `Due: ${dueLabel(t.due_date, now).replace(/^Due /, '')}`,
    `Priority: ${priorityWord(t.priority)}`,
  ].join('\n');
}

// ---- Up next (row 15) ------------------------------------------------------------

/** The events still to come or on now, soonest first, at most `max`. */
export function upNextEvents(events: readonly CalendarEvent[], now: number, max = 4): CalendarEvent[] {
  return events
    .filter((e) => endOf(e) > now)
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time))
    .slice(0, max);
}

const WEEKDAY_TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** "now" · "in 18 min" · "in 3 h" · "tomorrow 09:30" · "Thu 14:00". */
export function upNextWhen(e: CalendarEvent, now: number): string {
  const start = Date.parse(e.start_time);
  if (start <= now) return 'now';
  const mins = Math.round((start - now) / 60000);
  const day = Math.round((startOfDay(start) - startOfDay(now)) / (24 * HOUR));
  if (day === 0) return mins >= 120 ? `in ${Math.round(mins / 60)} h` : `in ${Math.max(1, mins)} min`;
  if (day === 1) return `tomorrow ${TIME_ONLY.format(new Date(start))}`;
  return WEEKDAY_TIME.format(new Date(start));
}

/** "Room 4 · with Maya Ortiz" · "with Ida, Lukas and 2 more" · null. */
export function withLine(e: Pick<CalendarEvent, 'location' | 'attendees'>): string | null {
  const parts: string[] = [];
  if (e.location?.trim()) parts.push(e.location.trim());
  const people = e.attendees.filter((a) => a.trim());
  if (people.length) {
    const shown = people.slice(0, 2).join(', ');
    parts.push(`with ${shown}${people.length > 2 ? ` and ${people.length - 2} more` : ''}`);
  }
  return parts.length ? parts.join(' · ') : null;
}
