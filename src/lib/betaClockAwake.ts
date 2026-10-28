/**
 * "Keep this Mac awake until then" (`Atlas Clock Beta.dc.html`, the switch in
 * the alarm note) — which hold should exist, and what the switch says.
 *
 * The switch is stored per alarm (`ClockPrefs.awake`). The hold itself is a
 * `caffeinate -i` the Rust side runs with a timeout and Atlas' own pid
 * (src-tauri/src/clock.rs), so it lapses on its own at the alarm or when
 * Atlas quits. Pure: the store (betaClockStore.ts) asks `awakeTarget` after
 * every change and moves or releases the hold to match.
 */
import { nextFire, whenLabel, type ClockPrefs } from './betaClock';

/**
 * How long the hold outlasts the ring: the chime, the notification and the
 * first minute of the dialog happen on an awake Mac. The store releases the
 * hold as soon as the alarm rings, so this only matters if it cannot.
 */
export const AWAKE_TAIL_MS = 2 * 60000;

export interface AwakeHold {
  alarmId: string;
  /** When the alarm rings. */
  at: number;
  /** When the hold should end: the ring plus the tail. */
  until: number;
}

/** The hold the switch asks for right now, or null when there should be none. */
export function awakeTarget(prefs: Pick<ClockPrefs, 'awake' | 'alarms'>, nowMs: number, tz: string): AwakeHold | null {
  if (!prefs.awake) return null;
  const alarm = prefs.alarms.find((a) => a.id === prefs.awake?.alarmId);
  if (!alarm || !alarm.on) return null;
  const at = nextFire(alarm, nowMs, tz);
  return at == null ? null : { alarmId: alarm.id, at, until: at + AWAKE_TAIL_MS };
}

/**
 * Prefs with a spent or orphaned switch cleared: the alarm it was for was
 * deleted or switched off, or has rung (`rung` lists the ids that just did).
 * Returns the same object when nothing changes, so the store can tell.
 */
export function settleAwake<P extends Pick<ClockPrefs, 'awake' | 'alarms'>>(prefs: P, nowMs: number, tz: string, rung: readonly string[] = []): P {
  if (!prefs.awake) return prefs;
  if (rung.includes(prefs.awake.alarmId) || !awakeTarget(prefs, nowMs, tz)) return { ...prefs, awake: null };
  return prefs;
}

/**
 * Whether the note shows the switch: for an early alarm far enough away that
 * the Mac would otherwise go to sleep (the design's `showAwake`), and for as
 * long as a hold is on, so it can always be switched off again.
 */
export function showAwakeSwitch(early: boolean, on: boolean): boolean {
  return early || on;
}

/** The switch's line. `held` is the instant the Rust side confirmed, null while it has not. */
export function awakeLabel(on: boolean, hold: AwakeHold | null, held: number | null, tz: string, nowMs: number): string {
  if (!on || !hold) return 'Keep this Mac awake until then';
  const at = whenLabel(tz, hold.at, nowMs);
  if (held == null) return `Asking macOS to keep this Mac awake until ${at}…`;
  return `Keeping this Mac awake until ${at}. Closing the lid still puts it to sleep.`;
}
