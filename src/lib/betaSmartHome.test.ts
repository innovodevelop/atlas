import { describe, expect, test } from 'bun:test';
import type { SmartDevice } from '@/lib/mocks/smartHome';
import {
  colourName, controlKind, countOn, countsAsOn, fToC, fmtTemp, hasPower, isOn, isSecured, lit, powerLabel, powerValue, roomSub, roomTemp,
  sceneInitial, stageKindOf, stageStateOf, statusOf, stepTemp, thermNote,
  type StatusSource,
} from './betaSmartHome';

const dev = (kind: SmartDevice['kind'], control: SmartDevice['control'], value: number, colour?: string): SmartDevice => ({
  id: 'd', name: 'Device', roomId: 'r', roomName: 'Room', kind, control, value, state: '', colour,
} as SmartDevice);

/** A device as `useSmartHome` hands it over: available, settled, with the bridge's own word. */
const live = (d: SmartDevice, word = ''): StatusSource => ({ ...d, state: word || 'No reading yet', lastKnownState: word, available: true, pending: null, note: null });

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
  test('a garage door is shut at position zero, a lock at one', () => {
    expect(isSecured(dev('lock', 'toggle', 1))).toBe(true);
    expect(isSecured(dev('lock', 'toggle', 0))).toBe(false);
    expect(isSecured(dev('garage', 'slider', 0))).toBe(true);
    expect(isSecured(dev('garage', 'slider', 100))).toBe(false);
    expect(stageStateOf(dev('garage', 'slider', 100))).toEqual({ on: true, locked: false });
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
  test('the outside reading arrives in Fahrenheit and is shown in Celsius', () => {
    expect(fToC(68)).toBe(20);
    expect(fToC(32)).toBe(0);
    expect(fToC(14)).toBe(-10);
  });
  test('swatch names', () => {
    expect(colourName('#FFD9A0')).toBe('Warm');
    expect(colourName('#123456')).toBeNull();
  });
  test('counts what is on and says so', () => {
    const devices = [dev('bulb', 'slider', 40), dev('bulb', 'slider', 0), dev('lock', 'toggle', 1)];
    expect(countOn(devices)).toBe(1);
    expect(roomSub(devices)).toBe('3 devices · 1 on');
    expect(roomSub([dev('plug', 'toggle', 1)])).toBe('1 device · 1 on');
  });
  test('"on" leaves out what a number cannot call on', () => {
    expect(countsAsOn(dev('thermostat', 'stepper', 21))).toBe(false);
    expect(countsAsOn(dev('sensor', 'status', 45))).toBe(false);
    expect(countsAsOn({ ...dev('bulb', 'slider', 60), available: false })).toBe(false);
    expect(countsAsOn(dev('blind', 'slider', 60))).toBe(true);
  });
});

describe('statusOf', () => {
  test('reads the value the way the design does', () => {
    expect(statusOf(dev('floorlamp', 'colour', 62, '#ffd9a0'))).toBe('62% · warm');
    expect(statusOf(dev('bulb', 'slider', 40))).toBe('40%');
    expect(statusOf(dev('bulb', 'slider', 0))).toBe('Off');
    expect(statusOf(dev('bulb', 'toggle', 1))).toBe('On');
    expect(statusOf(dev('lock', 'toggle', 1))).toBe('Locked');
    expect(statusOf(dev('lock', 'toggle', 0))).toBe('Unlocked');
    expect(statusOf(dev('garage', 'slider', 0))).toBe('Closed');
    expect(statusOf(dev('garage', 'slider', 40))).toBe('Open');
    expect(statusOf(dev('blind', 'slider', 60))).toBe('60% open');
    expect(statusOf(dev('plug', 'toggle', 0))).toBe('Off');
  });
  test('a thermostat’s number is a reading, not a target', () => {
    expect(statusOf(dev('thermostat', 'stepper', 21.5))).toBe('21.5° now');
    expect(statusOf(live(dev('thermostat', 'stepper', 20.8), 'Heat'))).toBe('Heat · 21° now');
    // A reading in the state words is not a mode word.
    expect(statusOf(live(dev('thermostat', 'stepper', 21.5), '21.5 °C'))).toBe('21.5° now');
    expect(thermNote(live(dev('thermostat', 'stepper', 21), 'Heat'))).toMatch(/^Heat\. The number is the room’s reading/);
  });
  test('a speaker’s number is its volume, and zero is muted', () => {
    expect(statusOf(dev('speaker', 'slider', 46))).toBe('Volume 46%');
    expect(statusOf(live(dev('speaker', 'slider', 46), 'Playing'))).toBe('Playing · 46%');
    expect(statusOf(dev('speaker', 'slider', 0))).toBe('Muted');
    expect(statusOf(live(dev('speaker', 'slider', 30), 'Off'))).toBe('Off · 30%');
  });
  test('falls back to the device’s own words where there is nothing to read', () => {
    expect(statusOf({ ...dev('sensor', 'status', 1), state: 'Dry · under sink' })).toBe('Dry · under sink');
    expect(statusOf({ ...dev('camera', 'status', 1), state: '' })).toBe('Live');
    expect(statusOf({ ...dev('camera', 'status', 0), state: 'Streaming' })).toBe('Streaming');
    expect(statusOf({ ...dev('doorbell', 'status', 1), state: 'On' })).toBe('On');
  });
  test('the hook’s honesty line outranks the value', () => {
    const stale: StatusSource = { ...dev('bulb', 'slider', 62), state: 'Not responding · last seen 2 hours ago', available: false };
    expect(statusOf(stale)).toBe('Not responding · last seen 2 hours ago');
    const sending: StatusSource = { ...dev('bulb', 'slider', 62), state: 'Sending…', pending: 'sending' };
    expect(statusOf(sending)).toBe('Sending…');
    const failed: StatusSource = { ...dev('lock', 'toggle', 1), state: 'Did not go through', note: { tone: 'bad', text: 'Refused' } };
    expect(statusOf(failed)).toBe('Did not go through');
  });
});

describe('the dot', () => {
  test('lit for running, shut or streaming; dark for the rest', () => {
    expect(lit(dev('bulb', 'slider', 10))).toBe(true);
    expect(lit(dev('bulb', 'slider', 0))).toBe(false);
    expect(lit(dev('lock', 'toggle', 1))).toBe(true);
    expect(lit(dev('garage', 'slider', 0))).toBe(true);
    expect(lit({ ...dev('camera', 'status', 0), state: 'Streaming' })).toBe(true);
    expect(lit({ ...dev('camera', 'status', 0), state: 'Idle' })).toBe(false);
    expect(lit(dev('sensor', 'status', 1))).toBe(false);
    expect(lit(live(dev('thermostat', 'stepper', 21), 'Heat'))).toBe(true);
    expect(lit(live(dev('thermostat', 'stepper', 21), 'Off'))).toBe(false);
    expect(lit({ ...dev('lock', 'toggle', 1), available: false })).toBe(false);
  });
});

describe('the control row', () => {
  test('one row per device, by what it is and what it takes', () => {
    expect(controlKind(dev('floorlamp', 'colour', 1))).toBe('light');
    expect(controlKind(dev('bulb', 'slider', 1))).toBe('light');
    expect(controlKind(dev('bulb', 'toggle', 1))).toBe('power');
    expect(controlKind(dev('thermostat', 'stepper', 21))).toBe('thermostat');
    expect(controlKind(dev('lock', 'toggle', 1))).toBe('lock');
    expect(controlKind(dev('garage', 'slider', 0))).toBe('garage');
    expect(controlKind(dev('speaker', 'slider', 30))).toBe('speaker');
    expect(controlKind(dev('camera', 'status', 0))).toBe('camera');
    // A door sensor is filed as a doorbell; it is not a camera.
    expect(controlKind(dev('doorbell', 'status', 1))).toBe('generic');
    expect(controlKind(dev('blind', 'slider', 50))).toBe('blinds');
    expect(controlKind(dev('plug', 'toggle', 1))).toBe('power');
    expect(controlKind(dev('purifier', 'segmented', 1))).toBe('generic');
    expect(controlKind(dev('sensor', 'status', 1))).toBe('generic');
  });
  test('only switchable kinds get the power pill', () => {
    expect(hasPower(dev('floorlamp', 'slider', 1))).toBe(true);
    expect(hasPower(dev('strip', 'colour', 1))).toBe(true);
    expect(hasPower(dev('speaker', 'slider', 1))).toBe(true);
    expect(hasPower(dev('plug', 'toggle', 1))).toBe(true);
    expect(hasPower(dev('lock', 'toggle', 1))).toBe(false);
    expect(hasPower(dev('camera', 'toggle', 1))).toBe(false);
    expect(hasPower(dev('blind', 'slider', 1))).toBe(false);
    expect(hasPower(dev('thermostat', 'stepper', 21))).toBe(false);
    expect(hasPower(dev('sensor', 'status', 1))).toBe(false);
    expect(hasPower(dev('purifier', 'segmented', 1))).toBe(false);
  });
  test('a speaker’s pill is a mute, and says so', () => {
    expect(powerLabel(dev('speaker', 'slider', 30))).toEqual({ name: 'Sound', text: 'Sound on' });
    expect(powerLabel(dev('speaker', 'slider', 0))).toEqual({ name: 'Sound', text: 'Muted' });
    expect(powerLabel(dev('bulb', 'slider', 0))).toEqual({ name: 'Power', text: 'Off' });
  });
  test('power restores the last level, or goes full, or flips the toggle', () => {
    expect(powerValue(dev('bulb', 'slider', 62))).toBe(0);
    expect(powerValue(dev('bulb', 'slider', 0), 12)).toBe(12);
    expect(powerValue(dev('bulb', 'slider', 0))).toBe(100);
    expect(powerValue(dev('bulb', 'slider', 0), 0)).toBe(100);
    expect(powerValue(dev('plug', 'toggle', 0))).toBe(1);
    expect(powerValue(dev('plug', 'toggle', 1))).toBe(0);
  });
  test('the stepper moves by half a degree on the half-degree grid', () => {
    expect(stepTemp(21, 0.5)).toBe(21.5);
    expect(stepTemp(21.5, -0.5)).toBe(21);
    expect(stepTemp(21.3, 0.5)).toBe(22);
    // No Celsius clamp: a Fahrenheit house steps from where it is.
    expect(stepTemp(70, 0.5)).toBe(70.5);
  });
  test('scene initials', () => {
    expect(sceneInitial('morning')).toBe('M');
    expect(sceneInitial('  ')).toBe('✦');
  });
});
