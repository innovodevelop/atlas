/**
 * The Clock's half of "Atlas, wake me at seven", "stop" and "snooze".
 *
 * The path: the brain's `atlas_clock` tool (supabase/functions/_shared/
 * orchestrator.ts) calls the control port's `clock.*` ops, which check the
 * arguments in Rust (src-tauri/src/control/ops_clock.rs) and emit
 * `clock:command` to this webview; the clock store answers it on
 * `clock_command_reply` with one of the sentences below, and that sentence is
 * what the model reads back and says. Pure: parsing the tool's arguments into
 * an alarm, and the replies.
 */
import {
  DAY_ORDER, daysLabel, draftAlarm, finishAlarm, inLabel, parseHHMM, pad2, whenLabel,
  type Alarm,
} from './betaClock';

export type VoiceAction = 'set_alarm' | 'stop_alarm' | 'snooze_alarm';

export interface ClockCommand {
  id: string;
  action: string;
  args: unknown;
}

export interface VoiceReply {
  ok: boolean;
  message: string;
  data?: Record<string, unknown> | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `clock:command` payload, or null when it is not one. */
export function readCommand(raw: unknown): ClockCommand | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.action !== 'string') return null;
  return { id: raw.id, action: raw.action, args: raw.args ?? {} };
}

/**
 * `07:00`, `7:05`, `19:30`; and, leniently, `7`, `7am`, `7:30 pm`. Rust has
 * already insisted on HH:MM, so the lenient forms only matter if that check
 * ever loosens. Null when it is not a time of day.
 */
export function parseVoiceTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] == null ? 0 : Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  } else if (h > 23 || m[2] == null) {
    // A bare "7" without am/pm is ambiguous; the tool asks for HH:MM.
    return null;
  }
  return `${pad2(h)}:${pad2(min)}`;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Weekday words to the store's day numbers (0 = Sunday). Null when a word is not a day. */
export function parseVoiceDays(raw: unknown): number[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out = new Set<number>();
  for (const w of raw) {
    if (typeof w !== 'string') return null;
    const word = w.trim().toLowerCase();
    const day = word.length >= 3 ? DAY_NAMES.findIndex((d) => d.startsWith(word)) : -1;
    if (day < 0) return null;
    out.add(day);
  }
  return DAY_ORDER.filter((d) => out.has(d));
}

/** The tool's arguments as a finished alarm, or what was wrong with them. */
export function voiceAlarm(args: unknown, nowMs: number): { ok: true; alarm: Alarm } | { ok: false; error: string } {
  const a = isRecord(args) ? args : {};
  const time = parseVoiceTime(a.time);
  if (!time || !parseHHMM(time)) return { ok: false, error: 'The Clock could not read that time. Ask for it as 24-hour HH:MM, such as 07:00.' };
  const days = parseVoiceDays(a.days);
  if (!days) return { ok: false, error: 'The Clock could not read those days. Use weekday names such as mon or sat.' };
  const label = typeof a.label === 'string' ? a.label.trim().slice(0, 60) : '';
  const alarm = finishAlarm({ ...draftAlarm(nowMs), time, days, label: label || 'Alarm', ringOn: null });
  return alarm ? { ok: true, alarm } : { ok: false, error: 'The Clock could not read that time.' };
}

const sameDays = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((d) => b.includes(d));

/**
 * The alarm to save: an existing one at the same time on the same days is
 * switched on (and takes the new label, if one was given) instead of a second
 * copy appearing — asking twice should not ring twice. It keeps its speaker.
 */
export function mergeVoiceAlarm(alarms: readonly Alarm[], fresh: Alarm, labelGiven: boolean): { alarm: Alarm; existed: boolean } {
  const twin = alarms.find((a) => a.time === fresh.time && sameDays(a.days, fresh.days));
  if (!twin) return { alarm: fresh, existed: false };
  return { alarm: { ...twin, on: true, snoozedUntil: null, label: labelGiven ? fresh.label : twin.label }, existed: true };
}

/** ", every day", ", on weekdays", ", on Mon, Wed"; nothing for a one-off. */
export function repeatPhrase(days: readonly number[]): string {
  if (!days.length) return '';
  const label = daysLabel(days);
  if (label === 'Every day') return ', every day';
  if (label === 'Weekdays' || label === 'Weekends') return `, on ${label.toLowerCase()}`;
  return `, on ${label}`;
}

/** What the model reads back after setting an alarm. `out` is where it rings. */
export function setReply(alarm: Alarm, at: number | null, nowMs: number, tz: string, existed: boolean, out: string): string {
  const verb = existed ? 'Switched on' : 'Set';
  const repeat = repeatPhrase(alarm.days);
  const when = at == null ? alarm.time : `${whenLabel(tz, at, nowMs)} (${inLabel(at - nowMs)})`;
  return `${verb} the alarm “${alarm.label}” for ${when}${repeat}. It rings on ${out} while Atlas is running and this Mac is awake.`;
}

export const NOTHING_RINGING = 'No alarm is ringing right now, so there was nothing to stop or snooze.';

/** Snooze length from the tool's arguments: 1–30 minutes, nine when absent. */
export function snoozeMinutes(args: unknown, fallback = 9): number {
  const m = isRecord(args) && typeof args.minutes === 'number' && Number.isFinite(args.minutes) ? Math.round(args.minutes) : fallback;
  return Math.min(30, Math.max(1, m));
}
