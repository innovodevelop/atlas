/**
 * The Stage band's reading of the day — pure, so it can be tested without
 * React: which calendar event is "now in focus", how far away it is, what
 * follows it, and the three asks the band suggests.
 */
import type { CalendarEvent } from '@/hooks/useCalendarEvents';

const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const URL_RE = /https?:\/\/\S+/;
/** An event without an end is treated as this long for "is it still on". */
const DEFAULT_LENGTH_MS = 45 * 60000;

export function stageDate(now: number): string {
  return `${DAY_FMT.format(new Date(now))} · ${TIME_FMT.format(new Date(now))}`;
}

export function eventTime(e: CalendarEvent): string {
  return TIME_FMT.format(new Date(e.start_time));
}

export function eventDuration(e: CalendarEvent): string | null {
  if (!e.end_time) return null;
  const mins = Math.round((Date.parse(e.end_time) - Date.parse(e.start_time)) / 60000);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h} hour${h === 1 ? '' : 's'}`;
}

function endOf(e: CalendarEvent): number {
  return e.end_time ? Date.parse(e.end_time) : Date.parse(e.start_time) + DEFAULT_LENGTH_MS;
}

export function byStart(events: readonly CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

/** The events that start on the local calendar day of `now`. */
export function todaysEvents(events: readonly CalendarEvent[], now: number): CalendarEvent[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return byStart(events.filter((e) => { const t = Date.parse(e.start_time); return t >= start.getTime() && t < end.getTime(); }));
}

/** The event the focus card shows: the one that is on or next, else the last of the day. */
export function focusEvent(events: readonly CalendarEvent[], now: number): CalendarEvent | null {
  const sorted = byStart(events);
  return sorted.find((e) => endOf(e) >= now) ?? sorted[sorted.length - 1] ?? null;
}

/** What comes after the focus event, at most `max` of them. */
export function thenEvents(events: readonly CalendarEvent[], focus: CalendarEvent | null, max = 3): CalendarEvent[] {
  if (!focus) return [];
  const sorted = byStart(events);
  const i = sorted.findIndex((e) => e.id === focus.id);
  return sorted.slice(i + 1, i + 1 + max);
}

export type FocusPhase = 'ahead' | 'now' | 'done';

export function focusPhase(e: CalendarEvent, now: number): FocusPhase {
  if (Date.parse(e.start_time) > now) return 'ahead';
  return endOf(e) > now ? 'now' : 'done';
}

/** "in 12 min" · "in 3 h" · "now" · "done". */
export function focusIn(e: CalendarEvent, now: number): string {
  const phase = focusPhase(e, now);
  if (phase !== 'ahead') return phase;
  const mins = Math.round((Date.parse(e.start_time) - now) / 60000);
  return mins >= 120 ? `in ${Math.round(mins / 60)} h` : `in ${Math.max(1, mins)} min`;
}

/** The first link in the event's location or notes, if any — what "Join" opens. */
export function joinUrl(e: CalendarEvent | null): string | null {
  if (!e) return null;
  return e.location?.match(URL_RE)?.[0] ?? e.description?.match(URL_RE)?.[0] ?? null;
}

export function shortTitle(t: string, max = 22): string {
  const s = t.trim();
  return s.length > max ? `${s.slice(0, max - 2).trimEnd()}…` : s;
}

export interface SuggestedAsk { t: string; q: string }

/** Three asks built from the day: the next event, the mail that needs you, the weather. */
export function suggestedAsks(events: readonly CalendarEvent[], now: number, needsYou: number): SuggestedAsk[] {
  const next = focusEvent(events, now);
  const asks: SuggestedAsk[] = [];
  if (next && focusPhase(next, now) !== 'done') asks.push({ t: `Brief me on ${shortTitle(next.title)}`, q: `Brief me before ${next.title.trim()}` });
  asks.push(needsYou > 0
    ? { t: `${needsYou} mail${needsYou === 1 ? '' : 's'} need me`, q: 'Which mails need me today?' }
    : { t: 'Check my mail', q: 'Anything new in my mail?' });
  asks.push({ t: 'Do I need an umbrella?', q: 'Do I need an umbrella today?' });
  if (asks.length < 3) asks.push({ t: 'Plan my evening', q: 'Help me plan this evening' });
  return asks.slice(0, 3);
}

/** The band's one line of context, from real counts only. */
export function contextLine(parts: { events: number; needsYou: number; tasksOpen: number; weather?: string | null }): string {
  const bits: string[] = [];
  if (parts.events > 0) bits.push(`${parts.events} ${parts.events === 1 ? 'event' : 'events'} today`);
  if (parts.needsYou > 0) bits.push(`${parts.needsYou} ${parts.needsYou === 1 ? 'mail needs' : 'mails need'} you`);
  if (parts.tasksOpen > 0) bits.push(`${parts.tasksOpen} open ${parts.tasksOpen === 1 ? 'task' : 'tasks'}`);
  if (parts.weather) bits.push(parts.weather);
  if (!bits.length) return 'A clear day. Ask Atlas anything.';
  const s = bits.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}
