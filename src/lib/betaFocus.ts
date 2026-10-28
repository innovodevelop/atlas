/**
 * Focus — a 25 or 50 minute session during which Atlas holds its own
 * notifications (Beta row 12, `Atlas Widget Screens Beta.dc.html` #focus).
 * Pure: the session clock, what the gate holds, the day's numbers and the
 * saved state's parsing are tested here; the running store is focusGate.ts
 * and the screen is components/atlas/home/views/FocusView.tsx.
 *
 * The session is counted, not ticked: it keeps the milliseconds already done
 * and the moment the current run began, so a paused session stays paused
 * across a reload and a running one comes back with the right time left even
 * if the Mac slept through part of it.
 */

/** The design's lengths, as the task fixes them. */
export const FOCUS_LENGTHS = [25, 50] as const;
export type FocusLength = (typeof FOCUS_LENGTHS)[number];
export const isFocusLength = (v: unknown): v is FocusLength => v === 25 || v === 50;

/**
 * What a notifier says it is sending. Only `message` is held: an alarm the
 * user set and an approval Atlas is waiting on are exactly what a focus
 * session must not swallow.
 */
export type NotifyKind = 'message' | 'alarm' | 'approval';

export interface HeldNote {
  /** Which part of Atlas wanted to speak: "Mail", "Research". */
  source: string;
  title: string;
  body?: string;
  at: number;
}

export interface FocusSession {
  lengthMin: number;
  /** When the session was first started. */
  startedAt: number;
  /** When the current run began counting; null while paused. */
  runningSince: number | null;
  /** Milliseconds counted before `runningSince`. */
  doneMs: number;
  /** The task the session is for, when one was picked. */
  task: string | null;
  held: HeldNote[];
}

export interface FocusLogEntry {
  startedAt: number;
  endedAt: number;
  /** Minutes actually focused (pauses not counted). */
  minutes: number;
  held: number;
  task: string | null;
  /** Ran to the end rather than being ended early. */
  completed: boolean;
}

export interface FocusPrefs {
  lengthMin: FocusLength;
  /** A Shortcut to run when a session starts (to turn on a macOS Focus), or ''. */
  startShortcut: string;
  /** A Shortcut to run when it ends, or ''. */
  endShortcut: string;
}

export const DEFAULT_FOCUS_PREFS: FocusPrefs = { lengthMin: 25, startShortcut: '', endShortcut: '' };

/** The log keeps a fortnight of sessions: enough for "today" and a longest run. */
export const LOG_KEEP_MS = 14 * 24 * 3600000;
/** A flood of held notes is still only worth a screenful. */
export const HELD_MAX = 50;

export function elapsedMs(s: FocusSession, now: number): number {
  return s.doneMs + (s.runningSince != null ? Math.max(0, now - s.runningSince) : 0);
}

export function lengthMs(s: Pick<FocusSession, 'lengthMin'>): number {
  return s.lengthMin * 60000;
}

export function leftMs(s: FocusSession, now: number): number {
  return Math.max(0, lengthMs(s) - elapsedMs(s, now));
}

export const isRunning = (s: FocusSession | null): boolean => !!s && s.runningSince != null;

/** 0–1 of the session done, for the ring. */
export function progress(s: FocusSession | null, now: number): number {
  if (!s) return 0;
  return Math.min(1, elapsedMs(s, now) / Math.max(1, lengthMs(s)));
}

export function startSession(lengthMin: number, now: number, task: string | null = null): FocusSession {
  return { lengthMin, startedAt: now, runningSince: now, doneMs: 0, task: task?.trim() || null, held: [] };
}

export function pauseSession(s: FocusSession, now: number): FocusSession {
  if (s.runningSince == null) return s;
  return { ...s, doneMs: elapsedMs(s, now), runningSince: null };
}

export function resumeSession(s: FocusSession, now: number): FocusSession {
  if (s.runningSince != null) return s;
  return { ...s, runningSince: now };
}

/** The moment a running session reaches its end; null while paused. */
export function endsAt(s: FocusSession): number | null {
  return s.runningSince != null ? s.runningSince + (lengthMs(s) - s.doneMs) : null;
}

/** Whether a notification of this kind is held right now: only messages, only while a session runs. */
export function shouldHold(s: FocusSession | null, kind: NotifyKind, now: number): boolean {
  return kind === 'message' && !!s && isRunning(s) && leftMs(s, now) > 0;
}

export function holdNote(s: FocusSession, note: HeldNote): FocusSession {
  return { ...s, held: [...s.held, note].slice(-HELD_MAX) };
}

/** The log line for a session that ends now (on its own, or because the user ended it). */
export function logEntry(s: FocusSession, now: number): FocusLogEntry {
  const done = Math.min(lengthMs(s), elapsedMs(s, now));
  return {
    startedAt: s.startedAt,
    endedAt: now,
    minutes: Math.round(done / 60000),
    held: s.held.length,
    task: s.task,
    completed: done >= lengthMs(s),
  };
}

/** The log with a new entry, minus what is older than the fortnight it keeps. */
export function appendLog(log: readonly FocusLogEntry[], entry: FocusLogEntry, now: number): FocusLogEntry[] {
  return [...log, entry].filter((e) => now - e.endedAt <= LOG_KEEP_MS);
}

const startOfDay = (at: number): number => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

export interface DayStats { minutes: number; sessions: number; longest: number; held: number; entries: FocusLogEntry[] }

/** Today's sessions on this Mac's clock (a session counts on the day it ended). */
export function dayStats(log: readonly FocusLogEntry[], now: number): DayStats {
  const from = startOfDay(now);
  const entries = log.filter((e) => e.endedAt >= from && e.minutes > 0);
  return {
    minutes: entries.reduce((n, e) => n + e.minutes, 0),
    sessions: entries.length,
    longest: entries.reduce((n, e) => Math.max(n, e.minutes), 0),
    held: entries.reduce((n, e) => n + e.held, 0),
    entries,
  };
}

/** "24:59" · "1:02:07" — the ring's clock. */
export function fmtClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "0m" · "45m" · "2h 40m". */
export function fmtFocusMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** "Nothing held" · "1 notification held" · "3 notifications held". */
export function heldLabel(n: number): string {
  if (!n) return 'Nothing held';
  return `${n} ${n === 1 ? 'notification' : 'notifications'} held`;
}

/** "2 from Mail, 1 from Research" — what the held notes were, by source, largest first. */
export function heldBySource(held: readonly HeldNote[]): string {
  const counts = new Map<string, number>();
  for (const h of held) counts.set(h.source, (counts.get(h.source) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([src, n]) => `${n} from ${src}`).join(', ');
}

// --- Saved state -------------------------------------------------------------------

export const FOCUS_KEY = 'atlas:focus';

export interface FocusSaved {
  session: FocusSession | null;
  log: FocusLogEntry[];
  prefs: FocusPrefs;
  /** The session that just ended and what it held, until the user has seen it. */
  ended: { entry: FocusLogEntry; held: HeldNote[] } | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

function parseHeld(v: unknown): HeldNote[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((h) => {
    if (!h || typeof h !== 'object') return [];
    const o = h as Record<string, unknown>;
    const at = num(o.at);
    const title = str(o.title);
    if (at == null || !title) return [];
    return [{ source: str(o.source, 40) || 'Atlas', title, body: str(o.body, 400) || undefined, at }];
  }).slice(-HELD_MAX);
}

function parseEntry(v: unknown): FocusLogEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const startedAt = num(o.startedAt), endedAt = num(o.endedAt), minutes = num(o.minutes);
  if (startedAt == null || endedAt == null || minutes == null) return null;
  return { startedAt, endedAt, minutes: Math.max(0, Math.round(minutes)), held: Math.max(0, num(o.held) ?? 0), task: str(o.task) || null, completed: o.completed === true };
}

function parseSession(v: unknown): FocusSession | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const lengthMin = num(o.lengthMin), startedAt = num(o.startedAt), doneMs = num(o.doneMs);
  if (lengthMin == null || lengthMin <= 0 || lengthMin > 240 || startedAt == null || doneMs == null) return null;
  return { lengthMin, startedAt, runningSince: num(o.runningSince), doneMs: Math.max(0, doneMs), task: str(o.task) || null, held: parseHeld(o.held) };
}

/** The saved state; anything unreadable is the default, never a crash. */
export function parseFocusSaved(raw: string | null, now: number): FocusSaved {
  const out: FocusSaved = { session: null, log: [], prefs: { ...DEFAULT_FOCUS_PREFS }, ended: null };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    out.session = parseSession(v.session);
    out.log = Array.isArray(v.log) ? v.log.flatMap((e) => { const p = parseEntry(e); return p && now - p.endedAt <= LOG_KEEP_MS ? [p] : []; }) : [];
    const p = (v.prefs && typeof v.prefs === 'object' ? v.prefs : {}) as Record<string, unknown>;
    out.prefs = {
      lengthMin: isFocusLength(p.lengthMin) ? p.lengthMin : DEFAULT_FOCUS_PREFS.lengthMin,
      startShortcut: str(p.startShortcut, 120).trim(),
      endShortcut: str(p.endShortcut, 120).trim(),
    };
    const e = (v.ended && typeof v.ended === 'object' ? v.ended : null) as Record<string, unknown> | null;
    const entry = e ? parseEntry(e.entry) : null;
    out.ended = entry ? { entry, held: parseHeld(e?.held) } : null;
  } catch { /* a corrupt save starts clean */ }
  return out;
}

/** A Shortcut name the Rust side will accept (focus_mode.rs `valid_shortcut_name`), or why not. */
export function checkShortcutName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim();
  if (!name) return { ok: true, name: '' };
  if ([...name].length > 120) return { ok: false, reason: 'That name is longer than any shortcut’s.' };
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: 'A shortcut name cannot contain line breaks.' };
  if (name.startsWith('-')) return { ok: false, reason: 'A name starting with “-” would be read as an option. Rename the shortcut.' };
  return { ok: true, name };
}
