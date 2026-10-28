import { describe, expect, test } from 'bun:test';
import type { Alarm } from './betaClock';
import { AWAKE_TAIL_MS, awakeLabel, awakeTarget, settleAwake, showAwakeSwitch } from './betaClockAwake';

// 2026-01-14 22:00:00 UTC — a Wednesday evening.
const NOW = Date.UTC(2026, 0, 14, 22, 0, 0);
const SEVEN_TOMORROW = Date.UTC(2026, 0, 15, 7, 0, 0);

const alarm = (over: Partial<Alarm> = {}): Alarm => ({ id: 'a1', time: '07:00', label: 'Wake up', days: [], on: true, snoozedUntil: null, ...over });

describe('the hold the switch asks for', () => {
  test('until the alarm rings, plus a short tail', () => {
    const hold = awakeTarget({ awake: { alarmId: 'a1' }, alarms: [alarm()] }, NOW, 'UTC');
    expect(hold).toEqual({ alarmId: 'a1', at: SEVEN_TOMORROW, until: SEVEN_TOMORROW + AWAKE_TAIL_MS });
  });
  test('none when the switch is off, or its alarm is off or gone', () => {
    expect(awakeTarget({ awake: null, alarms: [alarm()] }, NOW, 'UTC')).toBeNull();
    expect(awakeTarget({ awake: { alarmId: 'a1' }, alarms: [alarm({ on: false })] }, NOW, 'UTC')).toBeNull();
    expect(awakeTarget({ awake: { alarmId: 'x' }, alarms: [alarm()] }, NOW, 'UTC')).toBeNull();
  });
  test('a snooze moves the hold with it', () => {
    const snoozed = NOW + 9 * 60000;
    expect(awakeTarget({ awake: { alarmId: 'a1' }, alarms: [alarm({ snoozedUntil: snoozed })] }, NOW, 'UTC')?.at).toBe(snoozed);
  });
});

describe('settling the switch', () => {
  const prefs = { awake: { alarmId: 'a1' }, alarms: [alarm()] };
  test('kept while its alarm is still to come; the same object back', () => {
    expect(settleAwake(prefs, NOW, 'UTC')).toBe(prefs);
  });
  test('cleared when the alarm has rung, been switched off or deleted', () => {
    expect(settleAwake(prefs, NOW, 'UTC', ['a1']).awake).toBeNull();
    expect(settleAwake({ ...prefs, alarms: [alarm({ on: false })] }, NOW, 'UTC').awake).toBeNull();
    expect(settleAwake({ ...prefs, alarms: [] }, NOW, 'UTC').awake).toBeNull();
  });
  test('nothing to settle without a switch', () => {
    const off = { awake: null, alarms: [] };
    expect(settleAwake(off, NOW, 'UTC')).toBe(off);
  });
});

describe('the switch row', () => {
  test('shows for an early alarm, and whenever it is on so it can be turned off', () => {
    expect(showAwakeSwitch(true, false)).toBe(true);
    expect(showAwakeSwitch(false, true)).toBe(true);
    expect(showAwakeSwitch(false, false)).toBe(false);
  });
  test('says what it does, and only claims a hold macOS confirmed', () => {
    const hold = awakeTarget({ awake: { alarmId: 'a1' }, alarms: [alarm()] }, NOW, 'UTC');
    expect(awakeLabel(false, null, null, 'UTC', NOW)).toBe('Keep this Mac awake until then');
    expect(awakeLabel(true, hold, null, 'UTC', NOW)).toContain('Asking macOS');
    expect(awakeLabel(true, hold, SEVEN_TOMORROW, 'UTC', NOW)).toBe('Keeping this Mac awake until Thu 07:00. Closing the lid still puts it to sleep.');
  });
});
