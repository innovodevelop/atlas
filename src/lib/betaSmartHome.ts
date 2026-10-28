/**
 * How a real device becomes a thing the 3D stage can draw, and what the Beta
 * Smart Home says about it — pure, tested here.
 *
 * The numbers these helpers read are the bridge's, in the units
 * `src-tauri/src/home/ha.rs` (`value_of`) gives them, and several of those are
 * not what the design's mock assumed: a thermostat's value is the temperature
 * it MEASURES, not the one it was set to; a speaker's value is its volume,
 * and "off" is a volume of zero; a garage door's value is how far open it is,
 * although it is commanded as a lock. Each helper below says the thing the
 * number actually means.
 */
import type { DeviceKind, SmartDevice } from '@/lib/mocks/smartHome';
import type { StageKind, StageState } from '@/lib/devices3d';

export const SWATCHES: { c: string; l: string }[] = [
  { c: '#ffd9a0', l: 'Warm' }, { c: '#fff1d6', l: 'Soft white' }, { c: '#f4f1ff', l: 'Daylight' }, { c: '#ffb36b', l: 'Candle' }, { c: '#b6a8ff', l: 'Dusk' },
];

/** The design drew seven kinds; everything else is a plug. */
export function stageKindOf(kind: DeviceKind): StageKind {
  switch (kind) {
    case 'floorlamp': case 'pendant': return 'lamp';
    case 'bulb': case 'strip': return 'bulb';
    case 'speaker': case 'tv': return 'speaker';
    case 'thermostat': case 'heater': case 'valve': return 'thermostat';
    case 'lock': case 'garage': return 'lock';
    case 'camera': case 'doorbell': return 'camera';
    case 'blind': case 'curtain': return 'blinds';
    default: return 'plug';
  }
}

/**
 * Whether a lock-domain device is secured. A lock reports 1 when locked; a
 * garage door reports its position, so it is secured when that is zero.
 */
export function isSecured(d: Pick<SmartDevice, 'kind' | 'value'>): boolean {
  return d.kind === 'garage' ? d.value <= 0 : d.value > 0;
}

export function stageStateOf(d: SmartDevice): StageState {
  const sk = stageKindOf(d.kind);
  const on = d.value > 0;
  switch (sk) {
    case 'lamp': case 'bulb': return { on, br: d.control === 'toggle' ? 80 : Math.max(1, Math.min(100, d.value)), color: d.colour ?? undefined };
    case 'speaker': return { on, vol: Math.max(0, Math.min(100, d.value)) };
    case 'thermostat': return { on: true, target: d.control === 'stepper' ? d.value : undefined };
    case 'lock': return { on: true, locked: isSecured(d) };
    case 'camera': return { on };
    case 'blinds': return { on, open: Math.max(0, Math.min(100, d.value)) };
    default: return { on };
  }
}

export function isOn(d: SmartDevice): boolean {
  const sk = stageKindOf(d.kind);
  if (sk === 'lock' || sk === 'camera') return false;
  return d.value > 0;
}

/** The average reading of a room's thermostats, or null. */
export function roomTemp(devices: readonly SmartDevice[]): number | null {
  const t = devices.filter((d) => stageKindOf(d.kind) === 'thermostat' && d.control === 'stepper');
  if (!t.length) return null;
  return t.reduce((a, d) => a + d.value, 0) / t.length;
}

export const fmtTemp = (t: number | null): string => (t == null ? '—' : `${(Math.round(t * 2) / 2).toFixed(1).replace(/\.0$/, '')}°`);

/**
 * The outside temperature in the inside one's unit. The weather command asks
 * OpenWeather for imperial units (`datafetch.rs`), while the home mirror and
 * its stepper are Celsius, and "21° inside · 68° out" in one line would be two
 * scales pretending to be one.
 */
export const fToC = (f: number): number => Math.round(((f - 32) * 5) / 9);

/** The design's lamp-colour name, when a swatch matches. */
export function colourName(c: string | null | undefined): string | null {
  if (!c) return null;
  return SWATCHES.find((s) => s.c.toLowerCase() === c.toLowerCase())?.l ?? null;
}

/* ── What the stage and the grid say ───────────────────────────────────────── */

/**
 * The slice of a live device these helpers need. `useSmartHome`'s
 * `LiveDevice` has all of the extra fields; a plain `SmartDevice` has none,
 * and reads as available and settled.
 */
export interface StatusSource extends SmartDevice {
  available?: boolean;
  pending?: 'sending' | 'sent' | null;
  note?: { tone: 'bad' | 'warn'; text: string } | null;
  lastKnownState?: string;
}

/**
 * The bridge's own word for the device, when it is a word: Home Assistant's
 * "Heat" or "Playing", not a reading like "21.5 °C" that the value already says.
 */
function wordOf(d: StatusSource): string {
  const w = (d.lastKnownState ?? d.state ?? '').trim();
  return w && !/\d/.test(w) ? w : '';
}

/**
 * The status under a device's name. While the hook has something honest to
 * say about the device — it is not answering, a command is in flight, a
 * command failed — that sentence wins, because it is the one the value under
 * it cannot be trusted without. Otherwise the line is the design's: the value
 * read the way a person would say it.
 */
export function statusOf(d: StatusSource): string {
  if (d.available === false || d.pending || d.note) return d.state;
  const sk = stageKindOf(d.kind);
  const on = d.value > 0;
  const word = wordOf(d);
  if (d.kind === 'garage') return on ? 'Open' : 'Closed';
  switch (sk) {
    case 'lock': return on ? 'Locked' : 'Unlocked';
    case 'camera': return d.state || (on ? 'Live' : 'Idle');
    case 'thermostat':
      // The number is a reading. The design's "Heating to 21.5°" needs a
      // target, which the mirror does not keep.
      if (d.control !== 'stepper') return d.state;
      return `${word ? `${word} · ` : ''}${fmtTemp(d.value)} now`;
    case 'speaker':
      if (d.control !== 'slider') return d.state || (on ? 'On' : 'Off');
      return on ? `${word ? `${word} · ` : 'Volume '}${Math.round(d.value)}%` : word || 'Muted';
    case 'blinds': return d.control === 'slider' ? `${Math.round(d.value)}% open` : d.state;
    case 'lamp': case 'bulb': {
      if (!on) return 'Off';
      if (d.control === 'toggle') return 'On';
      const name = colourName(d.colour);
      return `${Math.round(d.value)}%${name ? ` · ${name.toLowerCase()}` : ''}`;
    }
    default:
      if (d.control === 'toggle') return on ? 'On' : 'Off';
      if (d.control === 'slider') return `${Math.round(d.value)}%`;
      return d.state;
  }
}

/**
 * Which control row the stage draws under a device. One answer per device, so
 * a camera never also gets the generic "reports only" pill and a door sensor
 * (which the bridge files as a doorbell) never gets a camera's sentence.
 */
export type ControlKind = 'light' | 'thermostat' | 'lock' | 'garage' | 'speaker' | 'camera' | 'blinds' | 'level' | 'power' | 'generic';

export function controlKind(d: Pick<SmartDevice, 'kind' | 'control'>): ControlKind {
  const sk = stageKindOf(d.kind);
  if (d.kind === 'garage') return 'garage';
  if (d.kind === 'lock') return 'lock';
  if (d.kind === 'camera') return 'camera';
  if ((sk === 'lamp' || sk === 'bulb') && (d.control === 'slider' || d.control === 'colour')) return 'light';
  if (sk === 'thermostat' && d.control === 'stepper') return 'thermostat';
  if (sk === 'speaker' && d.control === 'slider') return 'speaker';
  if (sk === 'blinds' && d.control === 'slider') return 'blinds';
  if (d.control === 'slider') return 'level';
  if (d.control === 'toggle' && hasPower(d)) return 'power';
  return 'generic';
}

/** Whether the control row gets the design's On/Off pill at all. */
export function hasPower(d: Pick<SmartDevice, 'kind' | 'control'>): boolean {
  const sk = stageKindOf(d.kind);
  if (sk === 'lock' || sk === 'camera' || sk === 'blinds' || sk === 'thermostat') return false;
  return d.control === 'toggle' || d.control === 'slider' || d.control === 'colour';
}

/**
 * The pill's words. A speaker has no power command — Home Assistant's
 * `volume_set` is the only thing its slider maps to — so its pill is a mute,
 * and says so, rather than a power switch that leaves the speaker playing.
 */
export function powerLabel(d: Pick<SmartDevice, 'kind' | 'value'>): { name: string; text: string } {
  const on = d.value > 0;
  if (stageKindOf(d.kind) === 'speaker') return { name: 'Sound', text: on ? 'Sound on' : 'Muted' };
  return { name: 'Power', text: on ? 'On' : 'Off' };
}

/**
 * The value "Off" or "On" sends. Off is always zero. On restores the level the
 * device last ran at, when this session saw one — a lamp dimmed to 12% comes
 * back at 12%, not at full — and otherwise the control's own full value.
 */
export function powerValue(d: Pick<SmartDevice, 'value' | 'control'>, lastOn?: number): number {
  if (d.value > 0) return 0;
  if (d.control === 'toggle') return 1;
  return lastOn && lastOn > 0 ? lastOn : 100;
}

/**
 * One stepper press: half a degree from the reading, on the half-degree grid.
 * No range clamp: the starting point is the bridge's own number, not something
 * typed, and a clamp written in Celsius would yank a Fahrenheit house to 35.
 */
export function stepTemp(value: number, delta: number): number {
  return Math.round((value + delta) * 2) / 2;
}

/**
 * The line beside the stepper. It says what the number is, because the
 * buttons act on it: the mirror keeps what the thermostat measures, so "+"
 * asks for half a degree above the room, not above an earlier setting.
 */
export function thermNote(d: StatusSource): string {
  const word = wordOf(d);
  return `${word ? `${word}. ` : ''}The number is the room’s reading; − and + ask for half a degree either side of it.`;
}

/**
 * The grid's dot: lit for something running, a lock or garage that is shut, a
 * camera that is streaming. Never for a device Atlas cannot reach, a sensor
 * (a reading is not "on"), or a thermostat the bridge says is off.
 */
export function lit(d: StatusSource): boolean {
  if (d.available === false) return false;
  const sk = stageKindOf(d.kind);
  if (sk === 'lock') return isSecured(d);
  if (d.kind === 'camera') return d.value > 0 || /stream|record|live/i.test(d.lastKnownState ?? d.state ?? '');
  if (d.control === 'status') return false;
  if (sk === 'thermostat') return !/^off$/i.test(wordOf(d));
  return d.value > 0;
}

/**
 * Whether the header's "N on" counts this device. The design's count, minus
 * what a number cannot honestly call "on": a device that is not answering (its
 * value is history), a sensor, and a thermostat, whose value is a temperature.
 */
export function countsAsOn(d: StatusSource): boolean {
  if (d.available === false || d.control === 'status') return false;
  if (stageKindOf(d.kind) === 'thermostat') return false;
  return isOn(d);
}

export const countOn = (devices: readonly StatusSource[]): number => devices.filter(countsAsOn).length;

/** "6 devices · 2 on" — the line under a room's name. */
export function roomSub(devices: readonly StatusSource[]): string {
  const n = devices.length;
  return `${n} ${n === 1 ? 'device' : 'devices'} · ${countOn(devices)} on`;
}

/** The letter in a scene's circle — the first of its label, or a spark. */
export const sceneInitial = (label: string): string => (label.trim().charAt(0) || '✦').toUpperCase();
