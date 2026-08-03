/**
 * Smart-home device glyphs and readouts.
 *
 * The design draws every device with a canvas model from `atlas-models.js`.
 * README §8 lists that file under "do not port", and the app has no
 * device-model renderer of any kind, so a device's visual identity here is a
 * glyph chosen from its `kind` — an interface illustration, not a rendering of
 * the hardware standing in the room.
 *
 * The readout strings are the design's own switch, moved out of the mock: they
 * are presentation (how a value reads to a person), and a real adapter returns
 * the same numeric `value` this formats.
 */
import {
  Lightbulb, Volume2, Tv, Thermometer, Flame, Fan, Blinds, WashingMachine,
  Refrigerator, Bot, Plug, Radio, Siren, Router, Lock, Bell, Camera, Car,
  BatteryCharging, Sun, Droplets,
  type LucideIcon,
} from 'lucide-react';
import type { DeviceKind, SmartDevice } from '@/lib/mocks/smartHome';

const GLYPH: Record<DeviceKind, LucideIcon> = {
  bulb: Lightbulb,
  pendant: Lightbulb,
  floorlamp: Lightbulb,
  strip: Lightbulb,
  speaker: Volume2,
  tv: Tv,
  thermostat: Thermometer,
  valve: Thermometer,
  heater: Flame,
  purifier: Fan,
  blind: Blinds,
  curtain: Blinds,
  kettle: Flame,
  washer: WashingMachine,
  fridge: Refrigerator,
  vacuum: Bot,
  plug: Plug,
  sensor: Radio,
  smoke: Siren,
  router: Router,
  lock: Lock,
  doorbell: Bell,
  camera: Camera,
  garage: Car,
  ev: BatteryCharging,
  solar: Sun,
  sprinkler: Droplets,
};

export const deviceGlyph = (kind: DeviceKind): LucideIcon => GLYPH[kind] ?? Plug;

/** The design's four-step fan/purifier scale. */
export const SEGMENT_LABELS = ['Off', 'Quiet', 'Auto', 'Turbo'] as const;

const LAMPS: DeviceKind[] = ['bulb', 'pendant', 'floorlamp', 'strip'];
export const isLampKind = (kind: DeviceKind) => LAMPS.includes(kind);
export const isLockKind = (kind: DeviceKind) => kind === 'lock' || kind === 'garage';

/** "On" for a lamp is brightness above zero; for a lock it is *secured*. */
export const deviceOn = (device: SmartDevice) => device.value > 0;

export function deviceReadout(device: SmartDevice): string {
  const on = deviceOn(device);
  switch (device.control) {
    case 'stepper':
      return `${device.value.toFixed(1)}°`;
    case 'segmented':
      return SEGMENT_LABELS[Math.round(device.value)] ?? SEGMENT_LABELS[0];
    case 'toggle':
      if (device.kind === 'lock') return on ? 'Locked' : 'Unlocked';
      if (device.kind === 'garage') return on ? 'Closed' : 'Open';
      if (device.kind === 'camera') return on ? 'Live' : 'Paused';
      return on ? 'On' : 'Off';
    case 'status':
      // A status device reports a percentage when it has one (a wash cycle),
      // and otherwise only whether it is reporting at all.
      return device.value > 1 ? `${Math.round(device.value)}%` : on ? 'OK' : 'Idle';
    default:
      return `${Math.round(device.value)}%`;
  }
}

/** Clamped 0–100, for tracks and fills. */
export const devicePct = (device: SmartDevice) =>
  Math.max(0, Math.min(100, Number.isFinite(device.value) ? device.value : 0));
