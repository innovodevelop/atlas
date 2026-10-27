import { describe, expect, test } from 'bun:test';
import type { SmartDevice } from '@/lib/mocks/smartHome';
import { colourName, fmtTemp, isOn, roomTemp, stageKindOf, stageStateOf } from './betaSmartHome';

const dev = (kind: SmartDevice['kind'], control: SmartDevice['control'], value: number, colour?: string): SmartDevice => ({
  id: 'd', name: 'Device', roomId: 'r', roomName: 'Room', kind, control, value, state: '', colour,
} as SmartDevice);

describe('stage mapping', () => {
  test('kinds fold onto the seven the design drew, else a plug', () => {
    expect(stageKindOf('floorlamp')).toBe('lamp');
    expect(stageKindOf('strip')).toBe('bulb');
    expect(stageKindOf('tv')).toBe('speaker');
    expect(stageKindOf('heater')).toBe('thermostat');
    expect(stageKindOf('garage')).toBe('lock');
    expect(stageKindOf('doorbell')).toBe('camera');
    expect(stageKindOf('curtain')).toBe('blinds');
    expect(stageKindOf('kettle')).toBe('plug');
  });
  test('state follows the control', () => {
    expect(stageStateOf(dev('bulb', 'slider', 62, '#ffd9a0'))).toEqual({ on: true, br: 62, color: '#ffd9a0' });
    expect(stageStateOf(dev('bulb', 'toggle', 1))).toEqual({ on: true, br: 80, color: undefined });
    expect(stageStateOf(dev('thermostat', 'stepper', 21.5))).toEqual({ on: true, target: 21.5 });
    expect(stageStateOf(dev('lock', 'toggle', 1))).toEqual({ on: true, locked: true });
    expect(stageStateOf(dev('blind', 'slider', 40))).toEqual({ on: true, open: 40 });
  });
  test('a lock or a camera never counts as "on"', () => {
    expect(isOn(dev('lock', 'toggle', 1))).toBe(false);
    expect(isOn(dev('bulb', 'slider', 0))).toBe(false);
    expect(isOn(dev('bulb', 'slider', 5))).toBe(true);
  });
});

describe('room figures', () => {
  test('averages the thermostats', () => {
    expect(roomTemp([dev('thermostat', 'stepper', 21), dev('heater', 'stepper', 22), dev('bulb', 'slider', 50)])).toBe(21.5);
    expect(roomTemp([dev('bulb', 'slider', 50)])).toBeNull();
    expect(fmtTemp(21.5)).toBe('21.5°');
    expect(fmtTemp(21)).toBe('21°');
    expect(fmtTemp(null)).toBe('—');
  });
  test('swatch names', () => {
    expect(colourName('#FFD9A0')).toBe('Warm');
    expect(colourName('#123456')).toBeNull();
  });
});
