import { describe, expect, test } from 'bun:test';
import type { SmartDevice } from '@/lib/mocks/smartHome';
import {
  colourName, controlKind, countOn, countsAsOn, fToC, fmtTemp, hasPower, isOn, isSecured, lit, powerLabel, powerValue, roomSub, roomTemp,
  sceneInitial, stageKindOf, stageStateOf, statusOf, stepTemp, thermNote,
  actionWord, cameraEventLine, cameraSensors, clockLabel, energyView, fmtKwh, fmtWatts, historyLine, homeTips, lastMotion, lightsSummary,
  lockNote, pickDoorCamera, pickLight, presenceSuggestion, stepperValue,
  type ExtraDevice, type HistoryEvent, type StatusSource,
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

/* ── The Beta extras ──────────────────────────────────────────────────────── */

/** A local moment, so the clock labels do not depend on the machine's zone. */
const at = (h: number, m = 0, dayOffset = 0): string => new Date(2026, 9, 28 + dayOffset, h, m).toISOString();
const nowAt = (h: number, m = 0): number => new Date(2026, 9, 28, h, m).getTime();

const xdev = (over: Partial<ExtraDevice> & Pick<ExtraDevice, 'id' | 'kind' | 'control' | 'value'>): ExtraDevice => ({
  name: over.id, roomId: 'hall', roomName: 'Hall', state: '', available: true, pending: null, note: null, lastKnownState: '', ...over,
} as ExtraDevice);
const ev = (over: Partial<HistoryEvent> & Pick<HistoryEvent, 'kind' | 'at'>): HistoryEvent => ({
  deviceId: 'lock', value: null, state: null, available: true, detail: null, ...over,
});

describe('the thermostat target (row 46)', () => {
  const t = (over: Partial<StatusSource>): StatusSource => ({ ...live(dev('thermostat', 'stepper', 20.8), 'Heat'), ...over });
  test('"Heating to" only from the bridge’s own action and target', () => {
    expect(statusOf(t({ target: 21.5, hvacAction: 'heating' }))).toBe('Heating to 21.5°');
    expect(statusOf(t({ target: 21.5, hvacAction: 'idle' }))).toBe('Idle · set to 21.5°');
    expect(statusOf(t({ target: 21.5, hvacAction: 'off' }))).toBe('Off');
    expect(statusOf(t({ target: 21.5, hvacAction: null }))).toBe('Heat · set to 21.5°');
    // No target: still the reading, said as one.
    expect(statusOf(t({ target: null, hvacAction: 'heating' }))).toBe('Heat · 21° now');
  });
  test('the stepper moves the target when there is one', () => {
    expect(stepperValue(t({ target: 21.5 }))).toBe(21.5);
    expect(stepperValue(t({ target: null }))).toBe(20.8);
    expect(thermNote(t({ target: 21 }))).toMatch(/in the room now/);
    expect(actionWord('fan_only')).toBe('Fan only');
  });
});

describe('water heaters stay out of the inside temperature (row 47)', () => {
  test('a tank at 55° does not warm the house', () => {
    const room = { ...dev('thermostat', 'stepper', 21), domain: 'climate' };
    const tank = { ...dev('thermostat', 'stepper', 55), domain: 'water_heater' };
    expect(roomTemp([room, tank])).toBe(21);
    expect(roomTemp([tank])).toBeNull();
    // A device with no domain (HomeKit) still counts.
    expect(roomTemp([dev('thermostat', 'stepper', 20), room])).toBe(20.5);
  });
});

describe('the lock note and its history (row 44)', () => {
  const lock = xdev({ id: 'lock', kind: 'lock', control: 'toggle', value: 1, lastChangedAt: at(8, 31) });
  test('"by Atlas" only when Atlas sent the lock just before', () => {
    const events = [ev({ kind: 'state', at: at(8, 31), value: 1, state: 'Locked' }), ev({ kind: 'command', at: at(8, 30), detail: 'lock', value: 1 })];
    expect(lockNote(lock, events, nowAt(9))).toBe('Locked by Atlas at 08:31');
    expect(lockNote(lock, events.slice(0, 1), nowAt(9))).toBe('Locked at 08:31');
    // An unlock command does not explain a lock; nor does one an hour earlier.
    expect(lockNote(lock, [events[0], ev({ kind: 'command', at: at(8, 30), detail: 'unlock' })], nowAt(9))).toBe('Locked at 08:31');
    expect(lockNote(lock, [events[0], ev({ kind: 'command', at: at(7, 20), detail: 'lock' })], nowAt(9))).toBe('Locked at 08:31');
  });
  test('falls back to the bridge’s last change, and says the day when it is not today', () => {
    expect(lockNote({ ...lock, lastChangedAt: at(22, 10, -1) }, [], nowAt(9))).toBe('Locked at yesterday 22:10');
    expect(lockNote({ ...lock, lastChangedAt: null }, [], nowAt(9))).toBeNull();
    expect(lockNote({ ...lock, available: false }, [], nowAt(9))).toBeNull();
    // A history row that disagrees with the lock now is not the moment it changed.
    const unlocked = { ...lock, value: 0, lastChangedAt: at(8, 45) };
    expect(lockNote(unlocked, [ev({ kind: 'state', at: at(8, 31), value: 1 })], nowAt(9))).toBe('Unlocked at 08:45');
  });
  test('a garage door is closed and opened, not locked', () => {
    const g = xdev({ id: 'lock', kind: 'garage', control: 'slider', value: 0, lastChangedAt: at(7, 5) });
    expect(lockNote(g, [], nowAt(9))).toBe('Closed at 07:05');
    expect(historyLine(ev({ kind: 'command', at: at(7), detail: 'unlock' }), g)).toBe('Atlas opened it');
  });
  test('history rows read as sentences', () => {
    expect(historyLine(ev({ kind: 'state', at: at(7), value: 0 }), lock)).toBe('Unlocked');
    expect(historyLine(ev({ kind: 'command', at: at(7), detail: 'lock' }), lock)).toBe('Atlas locked it');
    expect(historyLine(ev({ kind: 'state', at: at(7), available: false }), lock)).toBe('Stopped responding');
    const lamp = dev('bulb', 'slider', 40);
    expect(historyLine(ev({ kind: 'command', at: at(7), detail: 'set', value: 40 }), lamp)).toBe('Atlas set it to 40%');
    expect(historyLine(ev({ kind: 'command', at: at(7), detail: 'set', value: 0 }), lamp)).toBe('Atlas switched it off');
    expect(historyLine(ev({ kind: 'command', at: at(7), detail: 'set', value: 21.5 }), dev('thermostat', 'stepper', 20))).toBe('Atlas set it to 21.5°');
    expect(historyLine(ev({ kind: 'state', at: at(7), state: 'Heat' }), lamp)).toBe('Heat');
  });
  test('clock labels', () => {
    expect(clockLabel(at(8, 5), nowAt(9))).toBe('08:05');
    expect(clockLabel('not a time', nowAt(9))).toBeNull();
    expect(clockLabel(at(8, 5, -3), nowAt(9))).toBe('25 Oct 08:05');
  });
});

describe('camera events (row 45)', () => {
  const cam = xdev({ id: 'cam', kind: 'camera', control: 'status', value: 0, hubDeviceId: 'doorbell' });
  const own = xdev({ id: 'm1', kind: 'sensor', control: 'status', value: 0, domain: 'binary_sensor', deviceClass: 'person', hubDeviceId: 'doorbell', roomId: 'porch' });
  const roomMotion = xdev({ id: 'm2', kind: 'sensor', control: 'status', value: 0, domain: 'binary_sensor', deviceClass: 'motion' });
  const leak = xdev({ id: 'leak', kind: 'sensor', control: 'status', value: 1, domain: 'binary_sensor', deviceClass: 'moisture' });
  test('a camera’s own sensors first, else the room’s; never a leak sensor', () => {
    expect(cameraSensors(cam, [cam, own, roomMotion, leak]).map((d) => d.id)).toEqual(['m1']);
    expect(cameraSensors({ ...cam, hubDeviceId: null }, [cam, roomMotion, leak]).map((d) => d.id)).toEqual(['m2']);
    expect(cameraSensors({ ...cam, hubDeviceId: null, roomId: 'attic' }, [cam, roomMotion])).toEqual([]);
  });
  test('"Motion at 10:42" from the history, "now" while it reports', () => {
    const events = [ev({ kind: 'state', deviceId: 'm2', at: at(10, 42), value: 1 }), ev({ kind: 'state', deviceId: 'm2', at: at(10, 44), value: 0 })];
    expect(cameraEventLine(lastMotion([roomMotion], events), nowAt(11))).toBe('Motion at 10:42');
    expect(cameraEventLine(lastMotion([{ ...own, value: 1, lastChangedAt: at(10, 50) }], []), nowAt(11))).toBe('Person now · since 10:50');
    expect(cameraEventLine(lastMotion([roomMotion], []), nowAt(11))).toBeNull();
    expect(cameraEventLine(lastMotion([], events), nowAt(11))).toBeNull();
  });
});

describe('energy (row 41)', () => {
  const sensor = (id: string, cls: 'power' | 'energy', over: Partial<ExtraDevice> = {}) =>
    xdev({ id, kind: 'sensor', control: 'status', value: 0, domain: 'sensor', deviceClass: cls, unit: cls === 'power' ? 'W' : 'kWh', ...over });
  const plug = xdev({ id: 'plug', name: 'Kettle plug', kind: 'plug', control: 'toggle', value: 1, hubDeviceId: 'p1' });
  const hours = (h: number, v: number | null) => Array.from({ length: 24 }, (_, i) => (i === h ? v : null));
  test('the grid meter is the headline and never summed with the devices behind it', () => {
    const devices = [
      plug,
      sensor('meterW', 'power', { value: 640, hubDeviceId: 'meter' }),
      sensor('meterKwh', 'energy', { energyRole: 'grid', hubDeviceId: 'meter' }),
      sensor('plugW', 'power', { value: 1.8, unit: 'kW', hubDeviceId: 'p1' }),
      sensor('plugKwh', 'energy', { energyRole: 'device', hubDeviceId: 'p1' }),
    ];
    const v = energyView(devices, [
      { deviceId: 'meterKwh', kwh: 8.2, hours: hours(9, 0.6) },
      { deviceId: 'plugKwh', kwh: 0.4, hours: hours(9, 0.4) },
    ]);
    expect(v.kwh).toBe(8.2);
    expect(v.kwhFrom).toMatch(/grid/);
    expect(v.watts).toBe(640);
    expect(v.wattsFrom).toBe('the house meter');
    expect(v.hours[9]).toBe(0.6);
    expect(v.hours[3]).toBeNull();
    expect(v.rows).toEqual([{ key: 'p1', name: 'Kettle plug', watts: 1800, kwh: 0.4 }]);
  });
  test('with no Energy dashboard the card adds every sensor and says so', () => {
    const v = energyView([sensor('a', 'energy'), sensor('b', 'energy')], [
      { deviceId: 'a', kwh: 1, hours: hours(1, 1) },
      { deviceId: 'b', kwh: null, hours: hours(1, null) },
    ]);
    expect(v.kwh).toBe(1);
    expect(v.kwhFrom).toMatch(/2 energy sensors added together/);
    expect(energyView([], null).none).toBe(true);
    expect(energyView([sensor('w', 'power', { value: 5, unit: 'mW' })], null).watts).toBeNull();
  });
  test('formats', () => {
    expect(fmtKwh(8.24)).toBe('8.2');
    expect(fmtKwh(0.456)).toBe('0.46');
    expect(fmtKwh(null)).toBe('—');
    expect(fmtWatts(240.4)).toBe('240 W');
    expect(fmtWatts(1400)).toBe('1.4 kW');
  });
});

describe('modes and presence (row 40)', () => {
  const p = (name: string, state: string, kind: 'person' | 'device_tracker' = 'person') => ({ name, kind, state, available: true });
  test('suggests Away when nobody is home, Home when someone is back', () => {
    expect(presenceSuggestion([p('Marcus', 'not_home'), p('Ida', 'work')], 'home')?.mode).toBe('away');
    expect(presenceSuggestion([p('Marcus', 'not_home')], null)?.text).toBe('Marcus is not home, Home Assistant says.');
    expect(presenceSuggestion([p('Marcus', 'home')], 'away')).toEqual({ mode: 'home', text: 'Marcus is home, Home Assistant says.' });
    expect(presenceSuggestion([p('Marcus', 'home')], 'home')).toBeNull();
    expect(presenceSuggestion([p('Marcus', 'not_home')], 'away')).toBeNull();
    expect(presenceSuggestion([], 'home')).toBeNull();
  });
  test('people outrank phone trackers; an unavailable person says nothing', () => {
    expect(presenceSuggestion([p('Marcus', 'home'), p('Pixel', 'not_home', 'device_tracker')], 'away')?.mode).toBe('home');
    expect(presenceSuggestion([p('Pixel', 'not_home', 'device_tracker')], 'home')?.mode).toBe('away');
    expect(presenceSuggestion([{ ...p('Marcus', 'not_home'), available: false }], 'home')).toBeNull();
  });
});

describe('tips (row 43)', () => {
  const motion = xdev({ id: 'pir', kind: 'sensor', control: 'status', value: 0, domain: 'binary_sensor', deviceClass: 'motion', roomId: 'lr', roomName: 'Living room', lastChangedAt: at(21, 50) });
  const lamp = xdev({ id: 'lamp', name: 'Arc lamp', kind: 'bulb', control: 'slider', value: 40, roomId: 'lr', roomName: 'Living room' });
  test('a light on in a still room late at night', () => {
    const tips = homeTips({ devices: [motion, lamp], events: [], mode: null, nowMs: nowAt(23, 10) });
    expect(tips).toHaveLength(1);
    expect(tips[0].text).toBe('Arc lamp is on in Living room, and nothing has moved there since 21:50.');
    expect(tips[0].action).toEqual({ kind: 'set', label: 'Turn it off', deviceIds: ['lamp'], value: 0 });
    // Not before 22:00, not within the hour, not while the sensor sees someone, not without a sensor.
    expect(homeTips({ devices: [motion, lamp], events: [], mode: null, nowMs: nowAt(21, 59) })).toEqual([]);
    expect(homeTips({ devices: [{ ...motion, lastChangedAt: at(22, 40) }, lamp], events: [], mode: null, nowMs: nowAt(23, 10) })).toEqual([]);
    expect(homeTips({ devices: [{ ...motion, value: 1 }, lamp], events: [], mode: null, nowMs: nowAt(23, 10) })).toEqual([]);
    expect(homeTips({ devices: [lamp], events: [], mode: null, nowMs: nowAt(23, 10) })).toEqual([]);
    // A turn-on in the history counts as movement.
    const recent = [ev({ kind: 'state', deviceId: 'pir', at: at(22, 50), value: 1 })];
    expect(homeTips({ devices: [motion, lamp], events: recent, mode: null, nowMs: nowAt(23, 10) })).toEqual([]);
  });
  test('a door unlocked after 23:00', () => {
    const door = xdev({ id: 'door', name: 'Front door', kind: 'lock', control: 'toggle', value: 0 });
    expect(homeTips({ devices: [door], events: [], mode: null, nowMs: nowAt(23, 5) })[0]).toEqual({
      id: 'door:door', text: 'Front door is unlocked, and it is past 23:00.', action: { kind: 'set', label: 'Lock it', deviceIds: ['door'], value: 1 },
    });
    expect(homeTips({ devices: [door], events: [], mode: null, nowMs: nowAt(22, 50) })).toEqual([]);
    expect(homeTips({ devices: [{ ...door, value: 1 }], events: [], mode: null, nowMs: nowAt(23, 5) })).toEqual([]);
    expect(homeTips({ devices: [{ ...door, available: false }], events: [], mode: null, nowMs: nowAt(23, 5) })).toEqual([]);
  });
  test('heating while Away, and never a water heater', () => {
    const th = xdev({ id: 'th', name: 'Hall thermostat', kind: 'thermostat', control: 'stepper', value: 20, domain: 'climate', target: 21.5, hvacAction: 'heating' });
    expect(homeTips({ devices: [th], events: [], mode: 'away', nowMs: nowAt(12) })[0].text).toBe('Hall thermostat is heating to 21.5° while the house is set to Away.');
    expect(homeTips({ devices: [th], events: [], mode: 'home', nowMs: nowAt(12) })).toEqual([]);
    expect(homeTips({ devices: [{ ...th, hvacAction: 'idle', target: 17 }], events: [], mode: 'away', nowMs: nowAt(12) })).toEqual([]);
    expect(homeTips({ devices: [{ ...th, domain: 'water_heater' }], events: [], mode: 'away', nowMs: nowAt(12) })).toEqual([]);
  });
});

describe('the lamp and camera widgets (rows 3 and 16)', () => {
  const l = (name: string, kind: SmartDevice['kind'], control: SmartDevice['control']) => ({ ...dev(kind, control, 0), name, id: name });
  test('each widget takes the light it names, and a floor lamp is never guessed', () => {
    const plain = l('Desk', 'bulb', 'slider');
    const colour = l('Arc', 'bulb', 'colour');
    const named = l('Hall bulb', 'bulb', 'colour');
    expect(pickLight([plain, colour], 'lamp')?.name).toBe('Arc');
    expect(pickLight([plain], 'lamp')?.name).toBe('Desk');
    expect(pickLight([colour, plain], 'bulb')?.name).toBe('Desk');
    expect(pickLight([colour, named], 'bulb')?.name).toBe('Hall bulb');
    expect(pickLight([plain, colour], 'floorlamp')).toBeNull();
    expect(pickLight([plain, l('Floor lamp', 'bulb', 'slider')], 'floorlamp')?.name).toBe('Floor lamp');
    expect(pickLight([l('Corner', 'floorlamp', 'slider')], 'floorlamp')?.name).toBe('Corner');
    expect(pickLight([l('Smoke', 'smoke', 'status')], 'lamp')).toBeNull();
  });
  test('the door camera, and the lights summary', () => {
    const cams = [l('Garden', 'camera', 'status'), l('Front door', 'camera', 'status')];
    expect(pickDoorCamera(cams)?.name).toBe('Front door');
    expect(pickDoorCamera([cams[0]])?.name).toBe('Garden');
    expect(pickDoorCamera([])).toBeNull();
    const s = lightsSummary([
      live({ ...dev('bulb', 'slider', 60), id: 'a', roomId: 'r1' }),
      live({ ...dev('bulb', 'colour', 20), id: 'b', roomId: 'r2' }),
      live({ ...dev('bulb', 'toggle', 1), id: 'c', roomId: 'r2' }),
      live({ ...dev('bulb', 'slider', 0), id: 'd', roomId: 'r1' }),
      { ...live({ ...dev('bulb', 'slider', 90), id: 'e' }), available: false },
    ]);
    expect(s.total).toBe(4);
    expect(s.on.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(s.rooms).toBe(2);
    expect(s.brightness).toBe(40);
  });
});
