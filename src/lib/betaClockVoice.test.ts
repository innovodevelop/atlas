import { describe, expect, test } from 'bun:test';
import type { Alarm } from './betaClock';
import {
  NOTHING_RINGING, mergeVoiceAlarm, parseVoiceDays, parseVoiceTime, readCommand, repeatPhrase, setReply, snoozeMinutes,
  voiceAlarm,
} from './betaClockVoice';

// 2026-01-14 10:30:00 UTC — a Wednesday.
const NOW = Date.UTC(2026, 0, 14, 10, 30, 0);

const alarm = (over: Partial<Alarm> = {}): Alarm => ({ id: 'a1', time: '07:00', label: 'Alarm', days: [], on: true, snoozedUntil: null, ringOn: null, ...over });

describe('the clock:command payload', () => {
  test('reads an id, an action and the arguments', () => {
    expect(readCommand({ id: 'ck1', action: 'stop_alarm' })).toEqual({ id: 'ck1', action: 'stop_alarm', args: {} });
    expect(readCommand({ id: 'ck1', action: 'set_alarm', args: { time: '07:00' } })?.args).toEqual({ time: '07:00' });
  });
  test('refuses anything that is not one', () => {
    for (const bad of [null, 'stop', [], { action: 'stop_alarm' }, { id: '', action: 'stop_alarm' }, { id: 'x', action: 3 }]) {
      expect(readCommand(bad)).toBeNull();
    }
  });
});

describe('times and days', () => {
  test('24-hour HH:MM, and am/pm leniently', () => {
    expect(parseVoiceTime('07:00')).toBe('07:00');
    expect(parseVoiceTime('7:05')).toBe('07:05');
    expect(parseVoiceTime('19:30')).toBe('19:30');
    expect(parseVoiceTime('7am')).toBe('07:00');
    expect(parseVoiceTime('7:30 pm')).toBe('19:30');
    expect(parseVoiceTime('12 am')).toBe('00:00');
    expect(parseVoiceTime('12pm')).toBe('12:00');
  });
  test('a bare hour is ambiguous and anything else is not a time', () => {
    for (const bad of ['7', '24:00', '07:60', '13pm', 'seven', '', 7, null]) expect(parseVoiceTime(bad)).toBeNull();
  });
  test('weekday words become the store\'s day numbers, Monday first', () => {
    expect(parseVoiceDays(undefined)).toEqual([]);
    expect(parseVoiceDays(['fri', 'mon', 'Monday'])).toEqual([1, 5]);
    expect(parseVoiceDays(['sun', 'sat'])).toEqual([6, 0]);
    expect(parseVoiceDays(['mo'])).toBeNull();
    expect(parseVoiceDays(['monkey'])).toBeNull();
    expect(parseVoiceDays('weekdays')).toBeNull();
  });
});

describe('setting an alarm by voice', () => {
  test('"wake me at seven" is a one-off at 07:00 named Alarm, ringing on this Mac', () => {
    const r = voiceAlarm({ time: '07:00' }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alarm).toMatchObject({ time: '07:00', days: [], label: 'Alarm', on: true, ringOn: null, snoozedUntil: null });
  });
  test('a label and repeat days are kept', () => {
    const r = voiceAlarm({ time: '06:45', label: '  Gym ', days: ['mon', 'wed'] }, NOW);
    expect(r.ok && r.alarm).toMatchObject({ time: '06:45', label: 'Gym', days: [1, 3] });
  });
  test('what it cannot read is said, not guessed', () => {
    expect(voiceAlarm({}, NOW).ok).toBe(false);
    expect(voiceAlarm({ time: 'seven' }, NOW).ok).toBe(false);
    expect(voiceAlarm({ time: '07:00', days: ['someday'] }, NOW).ok).toBe(false);
  });
  test('asking twice switches the same alarm on instead of adding a second', () => {
    const saved = alarm({ id: 'keep', on: false, label: 'Wake up', snoozedUntil: 5, ringOn: { id: 'd1', name: 'Bedroom' } });
    const fresh = alarm({ id: 'new' });
    const { alarm: out, existed } = mergeVoiceAlarm([saved], fresh, false);
    expect(existed).toBe(true);
    expect(out).toMatchObject({ id: 'keep', on: true, snoozedUntil: null, label: 'Wake up', ringOn: { id: 'd1', name: 'Bedroom' } });
    expect(mergeVoiceAlarm([saved], { ...fresh, label: 'Run' }, true).alarm.label).toBe('Run');
    // Different days are a different alarm.
    expect(mergeVoiceAlarm([saved], { ...fresh, days: [1] }, false)).toEqual({ alarm: { ...fresh, days: [1] }, existed: false });
  });
  test('the reply says when, how often, where, and the limits', () => {
    const at = NOW + 3 * 3600000 + 15 * 60000;
    const msg = setReply(alarm({ label: 'Gym', days: [1, 2, 3, 4, 5] }), at, NOW, 'UTC', false, 'This Mac');
    expect(msg).toBe('Set the alarm “Gym” for 13:45 (in 3 h 15 min), on weekdays. It rings on This Mac while Atlas is running and this Mac is awake.');
    expect(setReply(alarm(), null, NOW, 'UTC', true, 'Bedroom')).toContain('Switched on the alarm “Alarm” for 07:00. It rings on Bedroom');
  });
  test('repeat phrases', () => {
    expect(repeatPhrase([])).toBe('');
    expect(repeatPhrase([0, 1, 2, 3, 4, 5, 6])).toBe(', every day');
    expect(repeatPhrase([0, 6])).toBe(', on weekends');
    expect(repeatPhrase([1, 3])).toBe(', on Mon, Wed');
  });
});

describe('snooze', () => {
  test('nine minutes unless told, bounded to 1–30', () => {
    expect(snoozeMinutes({})).toBe(9);
    expect(snoozeMinutes(null)).toBe(9);
    expect(snoozeMinutes({ minutes: 10.4 })).toBe(10);
    expect(snoozeMinutes({ minutes: 0 })).toBe(1);
    expect(snoozeMinutes({ minutes: 90 })).toBe(30);
    expect(snoozeMinutes({ minutes: 'ten' })).toBe(9);
  });
  test('nothing ringing is said plainly', () => {
    expect(NOTHING_RINGING).toContain('No alarm is ringing');
  });
});
