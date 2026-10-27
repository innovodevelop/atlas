/**
 * How a real device becomes a thing the 3D stage can draw, and what the Beta
 * Smart Home says about it — pure, tested here.
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

export function stageStateOf(d: SmartDevice): StageState {
  const sk = stageKindOf(d.kind);
  const on = d.value > 0;
  switch (sk) {
    case 'lamp': case 'bulb': return { on, br: d.control === 'toggle' ? 80 : Math.max(1, Math.min(100, d.value)), color: d.colour ?? undefined };
    case 'speaker': return { on, vol: Math.max(0, Math.min(100, d.value)) };
    case 'thermostat': return { on: true, target: d.control === 'stepper' ? d.value : undefined };
    case 'lock': return { on: true, locked: d.value > 0 };
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

/** The average target of a room's thermostats, or null. */
export function roomTemp(devices: readonly SmartDevice[]): number | null {
  const t = devices.filter((d) => stageKindOf(d.kind) === 'thermostat' && d.control === 'stepper');
  if (!t.length) return null;
  return t.reduce((a, d) => a + d.value, 0) / t.length;
}

export const fmtTemp = (t: number | null): string => (t == null ? '—' : `${(Math.round(t * 2) / 2).toFixed(1).replace(/\.0$/, '')}°`);

/** The design's lamp-colour name, when a swatch matches. */
export function colourName(c: string | null | undefined): string | null {
  if (!c) return null;
  return SWATCHES.find((s) => s.c.toLowerCase() === c.toLowerCase())?.l ?? null;
}
