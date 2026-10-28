/**
 * Lectio's schedule, from its calendar feed (Skema → Abonnér) — pure and
 * tested here (betaSchoolIcs.test.ts).
 *
 * Lectio has no API. What it does give a student is a private iCalendar link,
 * which Rust fetches (src-tauri/src/school.rs, so the link never reaches the
 * webview) and hands over as text. This module reads that text: the VEVENTs,
 * their SUMMARY, LOCATION and DESCRIPTION, start and end in their own time
 * zone (TZID), and what Lectio marks as cancelled or changed — STATUS:CANCELLED
 * and the "Aflyst!" / "Ændret!" Lectio writes into a lesson's title. Then it
 * turns events into lessons for the ribbon, Today and the week.
 *
 * Recurrence rules are not expanded: Lectio exports every lesson as its own
 * event, so a recurring event (which Lectio does not write) shows once.
 */

import { DAY, MIN, SUBJECT_COLOURS, addDays, startOfDay } from './betaSchool';

// ── Reading the calendar ─────────────────────────────────────────────────────

export interface IcsEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  start: number;
  end: number;
  allDay: boolean;
  /** STATUS, upper-cased; empty when the event has none. */
  status: string;
}

interface Prop { name: string; params: Record<string, string>; value: string }

/** Lines with continuations joined (RFC 5545 §3.1: a line break followed by a space or a tab). */
export function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

/** `\n`, `\,`, `\;` and `\\` in a TEXT value. */
export function unescapeIcs(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** `NAME;PARAM=VALUE;PARAM="A:B":value` — the first colon outside quotes ends the name and parameters. */
function parseLine(line: string): Prop | null {
  let quoted = false;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rest] = line.slice(0, i).split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** Windows zone names some exporters write, mapped to the IANA zone with the same rules. */
const WINDOWS_ZONES: Record<string, string> = {
  'Romance Standard Time': 'Europe/Copenhagen',
  'W. Europe Standard Time': 'Europe/Berlin',
  'GMT Standard Time': 'Europe/London',
};

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormat(tz: string): Intl.DateTimeFormat | null {
  if (!zoneFormats.has(tz)) {
    let fmt: Intl.DateTimeFormat | null = null;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      fmt = null;
    }
    zoneFormats.set(tz, fmt);
  }
  return zoneFormats.get(tz) ?? null;
}

/**
 * A wall-clock time in an IANA zone, as epoch milliseconds. Intl knows each
 * zone's rules; the offset is read at a first guess and again at the
 * corrected time, which settles the hours around a daylight-saving change.
 * Null when the zone is unknown.
 */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number | null {
  const fmt = zoneFormat(WINDOWS_ZONES[tz] ?? tz.replace(/^\//, ''));
  if (!fmt) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (ms: number): number => {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - ms;
  };
  const first = wall - offsetAt(wall);
  const ms = wall - offsetAt(first);
  return Number.isFinite(ms) ? ms : null;
}

/** A DATE or DATE-TIME value: UTC with "Z", in its TZID, or floating (this Mac's time). */
export function parseIcsTime(value: string, params: Record<string, string>): { ms: number; allDay: boolean } | null {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date) return { ms: new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime(), allDay: true };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  if (params.TZID) {
    const ms = zonedTime(y, mo, d, h, mi, s, params.TZID);
    if (ms !== null) return { ms, allDay: false };
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false };
}

/** `PT1H30M`, `P1D` — enough of RFC 5545 durations for an event without DTEND. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = ((n(2) * 7 + n(3)) * 24 * 3600 + n(4) * 3600 + n(5) * 60 + n(6)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

/** Every VEVENT with a readable start. Events outside a VEVENT (time zones, alarms) are skipped. */
export function parseIcs(text: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: Prop[] | null = null;
  let depth = 0;
  for (const line of unfoldIcs(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && cur === null) { cur = []; depth = 0; } else if (cur) depth += 1;
      continue;
    }
    if (p.name === 'END') {
      if (cur && depth > 0) { depth -= 1; continue; }
      if (cur && p.value.toUpperCase() === 'VEVENT') {
        const ev = toEvent(cur, out.length);
        if (ev) out.push(ev);
        cur = null;
      }
      continue;
    }
    // A VALARM inside the event has its own DESCRIPTION; only the event's own lines count.
    if (cur && depth === 0) cur.push(p);
  }
  return out;
}

function toEvent(props: readonly Prop[], n: number): IcsEvent | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const dtstart = get('DTSTART');
  const start = dtstart ? parseIcsTime(dtstart.value, dtstart.params) : null;
  if (!start) return null;
  const dtend = get('DTEND');
  const endParsed = dtend ? parseIcsTime(dtend.value, dtend.params) : null;
  const dur = get('DURATION');
  const duration = dur ? parseDuration(dur.value) : null;
  const end = endParsed && endParsed.ms >= start.ms
    ? endParsed.ms
    : duration !== null && duration >= 0 ? start.ms + duration : start.ms + (start.allDay ? DAY : 0);
  const text = (name: string) => unescapeIcs(get(name)?.value ?? '').trim();
  return {
    uid: text('UID') || `ev${n}-${start.ms}`,
    summary: text('SUMMARY'),
    location: text('LOCATION'),
    description: text('DESCRIPTION'),
    start: start.ms,
    end,
    allDay: start.allDay,
    status: text('STATUS').toUpperCase(),
  };
}

// ── Lessons ──────────────────────────────────────────────────────────────────

export type LessonState = 'normal' | 'changed' | 'cancelled';

export interface Lesson {
  id: string;
  title: string;
  room: string;
  teacher: string;
  start: number;
  end: number;
  allDay: boolean;
  state: LessonState;
  /** What Lectio says about the lesson beyond who and where — a note on a change, homework. */
  note: string;
  /** The title as Lectio wrote it, which exam detection reads. */
  raw: string;
}

const CANCELLED = /\baflyst|\bcancel+ed\b/i;
const CHANGED = /(^|[^a-zæøå])ændret|\bchanged\b/i;
const MARKER = /^\s*(?:aflyst|ændret|cancel+ed|changed)\s*!?\s*[-:–]?\s*/i;
const KEYED = /^(lærere?|teachers?|lokaler?|rooms?|hold|team|class|titel|title|note|lektier|homework)\s*:\s*(.*)$/i;

function field(text: string, keys: RegExp): string {
  for (const part of text.split(/\n|\s+[-–]\s+/)) {
    const m = KEYED.exec(part.trim());
    if (m && keys.test(m[1])) return m[2].trim();
  }
  return '';
}

/**
 * One event as a lesson. Lectio's own words decide its state: an event the
 * feed cancels, or whose title or note says "Aflyst", is cancelled; one marked
 * "Ændret" is changed. The marker comes off the title, and so do the teacher
 * and room fragments some titles carry, which get their own fields.
 */
export function toLesson(e: IcsEvent): Lesson {
  const both = `${e.summary}\n${e.description}`;
  const state: LessonState = e.status === 'CANCELLED' || CANCELLED.test(both) ? 'cancelled' : CHANGED.test(both) ? 'changed' : 'normal';
  const parts = e.summary.replace(MARKER, '').split(/\s+[-–]\s+/).map((p) => p.trim()).filter(Boolean);
  const titleParts: string[] = [];
  for (const p of parts) {
    const m = KEYED.exec(p);
    if (!m) { titleParts.push(p.replace(MARKER, '')); continue; }
    if (/^(hold|team|class|titel|title)$/i.test(m[1]) && m[2].trim()) titleParts.push(m[2].trim());
  }
  const teacher = field(e.summary, /^(lærere?|teachers?)$/i) || field(e.description, /^(lærere?|teachers?)$/i);
  const room = e.location || field(e.summary, /^(lokaler?|rooms?)$/i) || field(e.description, /^(lokaler?|rooms?)$/i);
  const note = e.description
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(lærere?|teachers?|lokaler?|rooms?|hold|team|class)\s*:/i.test(l) && !MARKER.test(l))
    .join(' ')
    .slice(0, 280);
  return {
    id: e.uid,
    title: titleParts.join(' · ').trim() || e.summary.replace(MARKER, '').trim() || 'Lesson',
    room,
    teacher,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    state,
    note,
    raw: e.summary,
  };
}

/** The feed as lessons, sorted, kept to a window around now so the cache stays small. */
export function lessonsFromIcs(text: string, now: number, opts: { pastDays?: number; futureDays?: number; cap?: number } = {}): Lesson[] {
  const from = addDays(startOfDay(now), -(opts.pastDays ?? 21));
  const to = addDays(startOfDay(now), opts.futureDays ?? 400);
  return parseIcs(text)
    .filter((e) => e.end >= from && e.start < to)
    .map(toLesson)
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
    .slice(0, opts.cap ?? 4000);
}

/** Lessons that start on the day beginning at `dayStartMs`. */
export function lessonsOn(lessons: readonly Lesson[], dayStartMs: number): Lesson[] {
  const end = addDays(dayStartMs, 1);
  return lessons.filter((l) => l.start >= dayStartMs && l.start < end).sort((a, b) => a.start - b.start);
}

/** A steady colour per course name, from the design's course palette. */
export function courseColour(name: string): string {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SUBJECT_COLOURS[h % SUBJECT_COLOURS.length];
}

export function lessonStateLabel(state: LessonState): string {
  return state === 'cancelled' ? 'Cancelled' : state === 'changed' ? 'Changed' : '';
}

// ── The ribbon: lessons and study sessions, side by side ─────────────────────

export interface DayItem {
  id: string;
  title: string;
  start: number;
  end: number;
  /** The line under the title when nothing is running: room and teacher, or the subject. */
  sub: string;
  colour: string;
  cancelled: boolean;
  done: boolean;
}

export type DayItemState = 'past' | 'now' | 'next';
export interface DayRibbonItem { item: DayItem; state: DayItemState; fill: number; minutesLeft: number }

/**
 * Today's lessons and sessions for the hero ribbon, at most `max`, the one
 * under way filled as far as it has run. A cancelled lesson is never under
 * way. When there are more than fit, the window slides so the running and
 * upcoming ones stay in view.
 */
export function dayRibbon(items: readonly DayItem[], now: number, max = 4): DayRibbonItem[] {
  const day0 = startOfDay(now);
  const day1 = addDays(day0, 1);
  const today = items.filter((i) => i.start >= day0 && i.start < day1).sort((a, b) => a.start - b.start);
  const out = today.map((item): DayRibbonItem => {
    const over = now >= item.end;
    const state: DayItemState = over || item.done ? 'past' : !item.cancelled && now >= item.start ? 'now' : 'next';
    const fill = state === 'now' ? Math.min(1, (now - item.start) / (item.end - item.start || 1)) : 0;
    return { item, state, fill, minutesLeft: state === 'now' ? Math.ceil((item.end - now) / MIN) : 0 };
  });
  if (out.length <= max) return out;
  const firstLive = out.findIndex((i) => i.state !== 'past');
  const from = firstLive < 0 ? out.length - max : Math.min(firstLive, out.length - max);
  return out.slice(from, from + max);
}

// ── The cache on this Mac ────────────────────────────────────────────────────

export interface LectioCache { fetchedAt: number; lessons: Lesson[] }

/** The cached schedule read back defensively: a damaged entry is an empty schedule, not a broken screen. */
export function parseLectioCache(raw: string | null): LectioCache | null {
  if (!raw) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.fetchedAt !== 'number' || !Array.isArray(o.lessons)) return null;
  const lessons: Lesson[] = [];
  for (const l of o.lessons.slice(0, 4000)) {
    if (typeof l !== 'object' || l === null) continue;
    const x = l as Record<string, unknown>;
    const s = (k: string) => (typeof x[k] === 'string' ? (x[k] as string).slice(0, 600) : '');
    if (typeof x.start !== 'number' || typeof x.end !== 'number' || !s('id')) continue;
    const state: LessonState = x.state === 'cancelled' || x.state === 'changed' ? x.state : 'normal';
    lessons.push({ id: s('id'), title: s('title') || 'Lesson', room: s('room'), teacher: s('teacher'), start: x.start, end: x.end, allDay: x.allDay === true, state, note: s('note'), raw: s('raw') });
  }
  return { fetchedAt: o.fetchedAt, lessons };
}
