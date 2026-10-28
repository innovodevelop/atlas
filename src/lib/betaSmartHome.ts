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

/**
 * The average reading of a room's thermostats, or null.
 *
 * A water heater is a `thermostat` to the stage (it has a stepper and a
 * temperature) but its 55° is the tank, not the room, so the Home Assistant
 * domain the mirror carries keeps it out. A device with no domain (HomeKit,
 * or one synced before the domain was kept) counts as before.
 */
export function roomTemp(devices: readonly (SmartDevice & { domain?: string | null })[]): number | null {
  const t = devices.filter((d) => stageKindOf(d.kind) === 'thermostat' && d.control === 'stepper' && d.domain !== 'water_heater');
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
  /** The Home Assistant domain, when the bridge said (`climate`, `water_heater`…). */
  domain?: string | null;
  /** What a thermostat is SET to; null when the bridge did not say. */
  target?: number | null;
  /** The thermostat's own word for what it is doing: `heating`, `idle`, `off`. */
  hvacAction?: string | null;
}

/** "heating" → "Heating", "fan_only" → "Fan only". The bridge's word, capitalised. */
export function actionWord(a: string | null | undefined): string {
  const w = (a ?? '').trim().replace(/_/g, ' ');
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
}

/** The number the stepper shows and steps from: the target when there is one. */
export const stepperValue = (d: StatusSource): number => (d.target != null ? d.target : d.value);

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
    case 'thermostat': {
      if (d.control !== 'stepper') return d.state;
      // The design's "Heating to 21.5°", but only from the bridge's own two
      // facts: what the thermostat is doing and what it is set to. Without a
      // target the number is the room's reading and is said as one.
      const act = (d.hvacAction ?? '').toLowerCase();
      if (d.target != null) {
        if (act === 'heating' || act === 'preheating') return `Heating to ${fmtTemp(d.target)}`;
        if (act === 'cooling') return `Cooling to ${fmtTemp(d.target)}`;
        if (act === 'off') return 'Off';
        return `${actionWord(d.hvacAction) || word || 'Set'} · set to ${fmtTemp(d.target)}`;
      }
      if (act === 'off') return 'Off';
      return `${word ? `${word} · ` : ''}${fmtTemp(d.value)} now`;
    }
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
  if (d.target != null) {
    return `${fmtTemp(d.value)} in the room now. − and + move what it is set to by half a degree.`;
  }
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

/* ── The Beta extras: history, locks, cameras, energy, tips, modes ──────────── */

/**
 * The slice of a mirrored device the extras read. `useSmartHome`'s
 * `LiveDevice` has all of it; everything past `SmartDevice` is optional, and
 * absent means "the bridge did not say", never zero.
 */
export interface ExtraDevice extends StatusSource {
  deviceClass?: string | null;
  unit?: string | null;
  hubDeviceId?: string | null;
  energyRole?: string | null;
  /** The raw ISO of the device's last state change. */
  lastChangedAt?: string | null;
}

/** One row of the history Atlas keeps (`home_events`), as the hook decodes it. */
export interface HistoryEvent {
  deviceId: string | null;
  kind: 'state' | 'command';
  value: number | null;
  state: string | null;
  available: boolean | null;
  detail: string | null;
  at: string;
}

const MINUTE = 60_000;
const pad2 = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "08:31" for a moment today, "yesterday 22:10" or "27 Oct 22:10" before that.
 * Local time, because the house is where the Mac is.
 */
export function clockLabel(iso: string, nowMs: number): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, new Date(nowMs))) return hm;
  const y = new Date(nowMs);
  y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return `yesterday ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

/** How close a command must sit to a change for Atlas to claim it. */
export const ATTRIBUTE_BEFORE_MS = 2 * MINUTE;
export const ATTRIBUTE_AFTER_MS = MINUTE;

/** Did Atlas send one of `verbs` to this device close enough to `atMs` to have caused it? */
export function atlasCaused(events: readonly HistoryEvent[], deviceId: string, verbs: readonly string[], atMs: number): boolean {
  return events.some((e) => {
    if (e.kind !== 'command' || e.deviceId !== deviceId || !e.detail || !verbs.includes(e.detail)) return false;
    const t = Date.parse(e.at);
    return !Number.isNaN(t) && t >= atMs - ATTRIBUTE_BEFORE_MS && t <= atMs + ATTRIBUTE_AFTER_MS;
  });
}

/**
 * The lock note: "Locked by Atlas at 08:31" when Atlas sent the lock that did
 * it, "Locked at 08:31" otherwise, and null when Atlas has no moment to name.
 *
 * The moment is the newest change the history holds for the lock, when it
 * agrees with what the lock says now; failing that (the history is younger
 * than the lock's last change), the bridge's own `last_changed`. "By Atlas"
 * needs a lock or unlock command from Atlas within two minutes before it, or
 * one after, since the bridge can report before Atlas finishes writing.
 */
export function lockNote(d: ExtraDevice, events: readonly HistoryEvent[], nowMs: number): string | null {
  if (d.available === false) return null;
  const secured = isSecured(d);
  const garage = d.kind === 'garage';
  const word = secured ? (garage ? 'Closed' : 'Locked') : (garage ? 'Opened' : 'Unlocked');
  const change = events
    .filter((e) => e.deviceId === d.id && e.kind === 'state' && e.available !== false && e.value != null)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  let at: string | null = null;
  if (change && isSecured({ kind: d.kind, value: change.value ?? 0 }) === secured) at = change.at;
  else if (d.lastChangedAt) at = d.lastChangedAt;
  if (!at) return null;
  const label = clockLabel(at, nowMs);
  if (!label) return null;
  return atlasCaused(events, d.id, secured ? ['lock'] : ['unlock'], Date.parse(at)) ? `${word} by Atlas at ${label}` : `${word} at ${label}`;
}

const COMMAND_WORDS: Record<string, string> = {
  lock: 'Atlas locked it', unlock: 'Atlas unlocked it', colour: 'Atlas changed its colour', run: 'Atlas ran it',
  turn_on: 'Atlas switched it on', turn_off: 'Atlas switched it off',
};

/** One history row in words, for a device's history list. */
export function historyLine(e: HistoryEvent, d: Pick<SmartDevice, 'kind' | 'control'>): string {
  if (e.kind === 'command') {
    if (e.detail === 'set') {
      if (e.value == null) return 'Atlas set it';
      if (d.control === 'stepper') return `Atlas set it to ${fmtTemp(e.value)}`;
      if (d.control === 'toggle') return e.value > 0 ? 'Atlas switched it on' : 'Atlas switched it off';
      return e.value > 0 ? `Atlas set it to ${Math.round(e.value)}%` : 'Atlas switched it off';
    }
    if (stageKindOf(d.kind) === 'lock' && d.kind === 'garage' && (e.detail === 'lock' || e.detail === 'unlock')) {
      return e.detail === 'lock' ? 'Atlas closed it' : 'Atlas opened it';
    }
    return COMMAND_WORDS[e.detail ?? ''] ?? 'Atlas sent a command';
  }
  if (e.available === false) return 'Stopped responding';
  if (stageKindOf(d.kind) === 'lock' && e.value != null) {
    const s = isSecured({ kind: d.kind, value: e.value });
    return d.kind === 'garage' ? (s ? 'Closed' : 'Opened') : (s ? 'Locked' : 'Unlocked');
  }
  return e.state || (e.value != null ? String(e.value) : 'Changed');
}

/** The binary sensor classes that say somebody or something moved. */
export const MOTION_CLASSES: readonly string[] = ['motion', 'occupancy', 'presence', 'person'];

export const isMotionSensor = (d: ExtraDevice): boolean =>
  !!d.deviceClass && MOTION_CLASSES.includes(d.deviceClass) && (d.domain == null || d.domain === 'binary_sensor');

/**
 * The motion sensors that belong to a camera: the ones on the camera's own
 * Home Assistant device (a doorbell's person sensor), else the ones in its
 * room. Never every motion sensor in the house.
 */
export function cameraSensors(camera: ExtraDevice, devices: readonly ExtraDevice[]): ExtraDevice[] {
  const motion = devices.filter((d) => d.id !== camera.id && isMotionSensor(d));
  const own = camera.hubDeviceId ? motion.filter((d) => d.hubDeviceId === camera.hubDeviceId) : [];
  if (own.length) return own;
  return camera.roomId ? motion.filter((d) => d.roomId === camera.roomId) : [];
}

export interface MotionMark {
  at: string;
  now: boolean;
  cls: string;
}

/**
 * When something last moved in front of these sensors: now, while one of
 * them reports motion; else the newest time one turned on in the history.
 */
export function lastMotion(sensors: readonly ExtraDevice[], events: readonly HistoryEvent[]): MotionMark | null {
  if (!sensors.length) return null;
  const live = sensors.find((s) => s.available !== false && s.value > 0);
  if (live) return { at: live.lastChangedAt ?? '', now: true, cls: live.deviceClass ?? 'motion' };
  const ids = new Set(sensors.map((s) => s.id));
  const on = events
    .filter((e) => e.kind === 'state' && !!e.deviceId && ids.has(e.deviceId) && (e.value ?? 0) > 0)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!on) return null;
  const s = sensors.find((x) => x.id === on.deviceId);
  return { at: on.at, now: false, cls: s?.deviceClass ?? 'motion' };
}

/** "Motion at 10:42", "Person now · since 10:40", or null when nothing has been seen. */
export function cameraEventLine(m: MotionMark | null, nowMs: number): string | null {
  if (!m) return null;
  const what = m.cls === 'person' ? 'Person' : m.cls === 'occupancy' || m.cls === 'presence' ? 'Someone there' : 'Motion';
  if (m.now) {
    const since = m.at ? clockLabel(m.at, nowMs) : null;
    return since ? `${what} now · since ${since}` : `${what} now`;
  }
  const at = clockLabel(m.at, nowMs);
  return at ? `${what} at ${at}` : null;
}

/* ── Energy ─────────────────────────────────────────────────────────────── */

export interface EnergySensorReading {
  deviceId: string;
  kwh: number | null;
  hours: readonly (number | null)[];
}

export interface EnergyRow {
  key: string;
  name: string;
  watts: number | null;
  kwh: number | null;
}

export interface EnergyView {
  /** Live watts for the headline, and whose they are. */
  watts: number | null;
  wattsFrom: string;
  /** Today's kWh for the headline, and whose they are. */
  kwh: number | null;
  kwhFrom: string;
  /** 24 local hours of the headline's kWh; null is an hour nobody reported. */
  hours: (number | null)[];
  rows: EnergyRow[];
  /** True when the mirror holds no power and no energy sensor at all. */
  none: boolean;
  /** How many energy sensors there are — whether today's kWh is worth asking for. */
  energySensors: number;
}

/** Watts from a power sensor's reading, or null for a unit Atlas does not know. */
export function wattsOf(d: ExtraDevice): number | null {
  if (d.available === false || !Number.isFinite(d.value)) return null;
  const u = (d.unit ?? 'W').trim();
  if (u === 'W') return d.value;
  if (u === 'kW') return d.value * 1000;
  return null;
}

const sumOrNull = (xs: readonly (number | null)[]): number | null => {
  const real = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return real.length ? real.reduce((a, b) => a + b, 0) : null;
};

const isSensorOf = (d: ExtraDevice, cls: string) => d.deviceClass === cls && (d.domain == null || d.domain === 'sensor');

/**
 * The energy card, from the mirror's power sensors (live watts) and Home
 * Assistant's statistics for its energy sensors (today's kWh).
 *
 * The headline never adds a whole-house meter to the devices behind it. The
 * Energy dashboard's own roles decide: the grid sensors when there are any,
 * else the per-device ones; only when the user has set up neither are all the
 * energy sensors added, and the card says that is what it did. Watts follow
 * the same rule through the Home Assistant device the grid meter sits on.
 */
export function energyView(devices: readonly ExtraDevice[], today: readonly EnergySensorReading[] | null): EnergyView {
  const power = devices.filter((d) => isSensorOf(d, 'power'));
  const energy = devices.filter((d) => isSensorOf(d, 'energy'));
  const byId = new Map((today ?? []).map((r) => [r.deviceId, r]));
  const grid = energy.filter((d) => d.energyRole === 'grid');
  const perDevice = energy.filter((d) => d.energyRole === 'device');

  const headline = grid.length ? grid : perDevice.length ? perDevice : energy.filter((d) => d.energyRole !== 'solar');
  const kwhFrom = grid.length
    ? 'from the grid, as your Energy dashboard counts it'
    : perDevice.length
      ? 'the devices your Energy dashboard counts'
      : headline.length === 1
        ? headline[0].name
        : `${headline.length} energy sensors added together — your Energy dashboard does not say which one is the meter`;
  const readings = headline.map((d) => byId.get(d.id)).filter((r): r is EnergySensorReading => !!r);
  const kwh = sumOrNull(readings.map((r) => r.kwh));
  const hours = Array.from({ length: 24 }, (_, h) => sumOrNull(readings.map((r) => r.hours[h] ?? null)));

  const meterHubs = new Set(grid.map((d) => d.hubDeviceId).filter((x): x is string => !!x));
  const meterPower = power.filter((d) => !!d.hubDeviceId && meterHubs.has(d.hubDeviceId));
  const wattSources = meterPower.length ? meterPower : power;
  const watts = sumOrNull(wattSources.map(wattsOf));
  const wattsFrom = meterPower.length
    ? 'the house meter'
    : wattSources.length === 1
      ? wattSources[0].name
      : `${wattSources.length} power sensors added together`;

  // Per device: a plug's power and energy sensors make one row, under the
  // name of the device they belong to when the mirror has it.
  const owner = (d: ExtraDevice): { key: string; name: string } => {
    if (d.hubDeviceId) {
      const host = devices.find((x) => x.hubDeviceId === d.hubDeviceId && x.control !== 'status');
      return { key: d.hubDeviceId, name: host?.name ?? d.name };
    }
    return { key: d.id, name: d.name };
  };
  const rows = new Map<string, EnergyRow>();
  const row = (d: ExtraDevice): EnergyRow => {
    const o = owner(d);
    const r = rows.get(o.key) ?? { key: o.key, name: o.name, watts: null, kwh: null };
    rows.set(o.key, r);
    return r;
  };
  for (const d of power) {
    if (meterPower.includes(d)) continue;
    const r = row(d);
    const w = wattsOf(d);
    if (w != null) r.watts = (r.watts ?? 0) + w;
  }
  for (const d of energy) {
    if (d.energyRole === 'grid' || d.energyRole === 'solar') continue;
    const r = row(d);
    const k = byId.get(d.id)?.kwh ?? null;
    if (k != null) r.kwh = (r.kwh ?? 0) + k;
  }
  const list = [...rows.values()];
  list.sort((a, b) => (b.kwh ?? -1) - (a.kwh ?? -1) || (b.watts ?? -1) - (a.watts ?? -1) || a.name.localeCompare(b.name));
  return { watts, wattsFrom, kwh, kwhFrom, hours, rows: list, none: power.length + energy.length === 0, energySensors: energy.length };
}

/** "8.2", "0.45", "112" — kWh the way the card prints it. */
export function fmtKwh(k: number | null): string {
  if (k == null) return '—';
  if (k < 1) return k.toFixed(2);
  if (k < 100) return k.toFixed(1);
  return String(Math.round(k));
}

/** "240 W", "1.4 kW". */
export function fmtWatts(w: number | null): string {
  if (w == null) return '—';
  return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;
}

/* ── Modes and presence ──────────────────────────────────────────────────── */

export type ModeKey = 'home' | 'away' | 'night';

export const MODE_LABEL: Record<ModeKey, string> = { home: 'Home', away: 'Away', night: 'Night' };

export interface PresenceSource {
  name: string;
  kind: 'person' | 'device_tracker';
  state: string | null;
  available: boolean;
}

/**
 * Home or Away, from where Home Assistant says people are — a suggestion,
 * never a switch: Atlas proposes the mode and the user's tap runs it. People
 * (`person.*`) when there are any, since each one already merges that
 * person's trackers; a phone's GPS tracker only when there are no people.
 * Night is never suggested: nobody's location says it is bedtime.
 */
export function presenceSuggestion(people: readonly PresenceSource[], current: ModeKey | null): { mode: ModeKey; text: string } | null {
  const persons = people.filter((p) => p.kind === 'person' && p.available && p.state);
  const pool = persons.length ? persons : people.filter((p) => p.kind === 'device_tracker' && p.available && p.state);
  if (!pool.length) return null;
  const home = pool.filter((p) => p.state === 'home');
  if (home.length && current === 'away') {
    const who = home.length === 1 ? `${home[0].name} is` : `${home.length} people are`;
    return { mode: 'home', text: `${who} home, Home Assistant says.` };
  }
  if (!home.length && current !== 'away') {
    return { mode: 'away', text: pool.length === 1 ? `${pool[0].name} is not home, Home Assistant says.` : 'Nobody is home, Home Assistant says.' };
  }
  return null;
}

/* ── Tips ────────────────────────────────────────────────────────────────── */

export type TipAction =
  | { kind: 'set'; label: string; deviceIds: string[]; value: number }
  | { kind: 'open'; label: string; deviceId: string };

export interface Tip {
  id: string;
  text: string;
  action: TipAction | null;
}

/** When "late at night" starts for lights, and for a door; both end at 05:00. */
export const LIGHTS_LATE_FROM = 22;
export const DOOR_LATE_FROM = 23;
export const NIGHT_ENDS = 5;
/** How long a room must have been still before a light in it reads as forgotten. */
export const STILL_FOR_MS = 60 * MINUTE;
/** Above this target, a thermostat in an Away house is worth a word. */
export const AWAY_TARGET_MAX = 18;

const lateFrom = (hour: number, from: number) => hour >= from || hour < NIGHT_ENDS;

/**
 * Atlas' tips, by rule, from what the mirror says now and the history Atlas
 * keeps. Each names the device and the fact, and offers only an action the
 * screen already has (switching a light off, locking through the approval
 * card, showing the thermostat). No rule fires on a device Atlas cannot
 * reach, and none guesses where it lacks a sensor: a room with no motion
 * sensor never gets the "nothing has moved" tip.
 */
export function homeTips(input: {
  devices: readonly ExtraDevice[];
  events: readonly HistoryEvent[];
  mode: ModeKey | null;
  nowMs: number;
}): Tip[] {
  const { devices, events, mode, nowMs } = input;
  const hour = new Date(nowMs).getHours();
  const tips: Tip[] = [];

  if (lateFrom(hour, LIGHTS_LATE_FROM)) {
    const rooms = new Map<string, ExtraDevice[]>();
    for (const d of devices) {
      if (!d.roomId) continue;
      rooms.set(d.roomId, [...(rooms.get(d.roomId) ?? []), d]);
    }
    for (const [roomId, list] of rooms) {
      const sensors = list.filter((d) => isMotionSensor(d) && d.available !== false);
      if (!sensors.length || sensors.some((s) => s.value > 0)) continue;
      const lights = list.filter((d) => isLightDevice(d) && d.available !== false && d.value > 0);
      if (!lights.length) continue;
      // The last sign of life: the newest turn-on in the history, or the
      // moment a sensor last changed (to clear, since none is on now).
      const marks = [
        ...events
          .filter((e) => e.kind === 'state' && !!e.deviceId && sensors.some((s) => s.id === e.deviceId) && (e.value ?? 0) > 0)
          .map((e) => Date.parse(e.at)),
        ...sensors.map((s) => (s.lastChangedAt ? Date.parse(s.lastChangedAt) : NaN)),
      ].filter((t) => !Number.isNaN(t));
      if (!marks.length) continue;
      const last = Math.max(...marks);
      if (nowMs - last < STILL_FOR_MS) continue;
      const roomName = lights[0].roomName || 'a room';
      const names = lights.length === 1 ? `${lights[0].name} is` : `${lights[0].name} and ${lights.length - 1} more are`;
      tips.push({
        id: `still:${roomId}`,
        text: `${names} on in ${roomName}, and nothing has moved there since ${clockLabel(new Date(last).toISOString(), nowMs)}.`,
        action: { kind: 'set', label: lights.length === 1 ? 'Turn it off' : 'Turn them off', deviceIds: lights.map((l) => l.id), value: 0 },
      });
    }
  }

  if (lateFrom(hour, DOOR_LATE_FROM)) {
    for (const d of devices) {
      if (d.kind !== 'lock' || d.available === false || isSecured(d)) continue;
      tips.push({
        id: `door:${d.id}`,
        text: `${d.name} is unlocked, and it is past ${pad2(DOOR_LATE_FROM)}:00.`,
        action: { kind: 'set', label: 'Lock it', deviceIds: [d.id], value: 1 },
      });
    }
  }

  if (mode === 'away') {
    for (const d of devices) {
      if (stageKindOf(d.kind) !== 'thermostat' || d.control !== 'stepper' || d.available === false) continue;
      if (d.domain === 'water_heater') continue;
      const act = (d.hvacAction ?? '').toLowerCase();
      const high = d.target != null && d.target > AWAY_TARGET_MAX;
      if (act !== 'heating' && !(high && act !== 'off')) continue;
      tips.push({
        id: `away:${d.id}`,
        text: d.target != null
          ? `${d.name} is ${act === 'heating' ? 'heating' : 'set'} to ${fmtTemp(d.target)} while the house is set to Away.`
          : `${d.name} is heating while the house is set to Away.`,
        action: { kind: 'open', label: 'Show it', deviceId: d.id },
      });
    }
  }
  return tips;
}

/* ── Home widgets: which light, which camera ─────────────────────────────── */

export type LightWidget = 'lamp' | 'bulb' | 'floorlamp';

export function isLightDevice(d: Pick<SmartDevice, 'kind' | 'control'>): boolean {
  const sk = stageKindOf(d.kind);
  return (sk === 'lamp' || sk === 'bulb') && d.control !== 'status';
}

/**
 * The light a lamp widget drives. Home Assistant files every light as a
 * bulb, so only a name can say "floor lamp": the Floor lamp widget takes a
 * light whose kind or name says so, or none, rather than passing some other
 * light off as one.
 *   lamp      — the first colour light (the swatches need one), else any light
 *   bulb      — a light named a bulb, else a plain (not colour) bulb, else any light
 *   floorlamp — a floor lamp by kind or name, else nothing
 */
export function pickLight<T extends Pick<SmartDevice, 'kind' | 'control' | 'name'>>(devices: readonly T[], which: LightWidget): T | null {
  const lights = devices.filter(isLightDevice);
  switch (which) {
    case 'lamp':
      return lights.find((d) => d.control === 'colour') ?? lights[0] ?? null;
    case 'bulb':
      return lights.find((d) => /\bbulb\b/i.test(d.name)) ?? lights.find((d) => d.kind === 'bulb' && d.control !== 'colour') ?? lights[0] ?? null;
    case 'floorlamp':
      return lights.find((d) => d.kind === 'floorlamp' || /floor\s*lamp|standing lamp/i.test(d.name)) ?? null;
  }
}

/** The camera the Front door widget shows: one named for the door, else the first. */
export function pickDoorCamera<T extends Pick<SmartDevice, 'kind' | 'name'>>(devices: readonly T[]): T | null {
  const cams = devices.filter((d) => d.kind === 'camera');
  return cams.find((d) => /front|door|entr|porch/i.test(d.name)) ?? cams[0] ?? null;
}

/** The Lights widget's figures: how many lights are on, in how many rooms, how bright. */
export function lightsSummary<T extends StatusSource>(devices: readonly T[]): { total: number; on: T[]; rooms: number; brightness: number | null } {
  const lights = devices.filter((d) => isLightDevice(d) && d.available !== false);
  const on = lights.filter((d) => d.value > 0);
  const dimmable = on.filter((d) => d.control === 'slider' || d.control === 'colour');
  return {
    total: lights.length,
    on,
    rooms: new Set(on.map((d) => d.roomId)).size,
    brightness: dimmable.length ? Math.round(dimmable.reduce((a, d) => a + d.value, 0) / dimmable.length) : null,
  };
}
