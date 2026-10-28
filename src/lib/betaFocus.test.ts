import { describe, expect, test } from 'bun:test';
import {
  HELD_MAX, LOG_KEEP_MS, appendLog, checkShortcutName, dayStats, elapsedMs, endsAt, fmtClock, fmtFocusMinutes, heldBySource,
  heldLabel, holdNote, leftMs, logEntry, parseFocusSaved, pauseSession, progress, resumeSession, shouldHold, startSession,
} from './betaFocus';
import { endFocus, focusSnapshot, holdForFocus, startFocus } from './focusGate';

const T0 = new Date(2026, 9, 28, 10, 0, 0).getTime();
const MIN = 60000;

describe('the session clock', () => {
  test('counts while running, stands still while paused', () => {
    let s = startSession(25, T0, ' Budget notes ');
    expect(s.task).toBe('Budget notes');
    expect(leftMs(s, T0 + 5 * MIN)).toBe(20 * MIN);
    s = pauseSession(s, T0 + 5 * MIN);
    expect(endsAt(s)).toBeNull();
    expect(elapsedMs(s, T0 + 60 * MIN)).toBe(5 * MIN);
    s = resumeSession(s, T0 + 30 * MIN);
    expect(endsAt(s)).toBe(T0 + 50 * MIN);
    expect(progress(s, T0 + 50 * MIN)).toBe(1);
    expect(progress(null, T0)).toBe(0);
  });

  test('only messages are held, and only while a session runs', () => {
    const s = startSession(25, T0);
    expect(shouldHold(s, 'message', T0 + MIN)).toBe(true);
    expect(shouldHold(s, 'alarm', T0 + MIN)).toBe(false);
    expect(shouldHold(s, 'approval', T0 + MIN)).toBe(false);
    expect(shouldHold(pauseSession(s, T0 + MIN), 'message', T0 + 2 * MIN)).toBe(false);
    expect(shouldHold(s, 'message', T0 + 26 * MIN)).toBe(false);
    expect(shouldHold(null, 'message', T0)).toBe(false);
  });

  test('held notes are capped', () => {
    let s = startSession(25, T0);
    for (let i = 0; i < HELD_MAX + 5; i++) s = holdNote(s, { source: 'Mail', title: `n${i}`, at: T0 + i });
    expect(s.held).toHaveLength(HELD_MAX);
    expect(s.held[0].title).toBe('n5');
  });

  test('the log line counts focused minutes and whether it ran out', () => {
    const s = startSession(25, T0);
    expect(logEntry(s, T0 + 25 * MIN)).toMatchObject({ minutes: 25, completed: true });
    expect(logEntry(s, T0 + 10 * MIN)).toMatchObject({ minutes: 10, completed: false });
  });
});

describe('the day and the log', () => {
  test('today counts sessions that ended today; the log keeps a fortnight', () => {
    const yesterday = { startedAt: T0 - 24 * 60 * MIN, endedAt: T0 - 24 * 60 * MIN + 25 * MIN, minutes: 25, held: 2, task: null, completed: true };
    const a = { startedAt: T0, endedAt: T0 + 25 * MIN, minutes: 25, held: 3, task: null, completed: true };
    const b = { startedAt: T0 + 30 * MIN, endedAt: T0 + 80 * MIN, minutes: 50, held: 1, task: 'x', completed: true };
    const d = dayStats([yesterday, a, b], T0 + 90 * MIN);
    expect(d).toMatchObject({ minutes: 75, sessions: 2, longest: 50, held: 4 });
    const old = { ...a, endedAt: T0 - LOG_KEEP_MS - 1 };
    expect(appendLog([old], a, T0 + 25 * MIN)).toEqual([a]);
  });

  test('words and numbers', () => {
    expect(fmtClock(25 * MIN)).toBe('25:00');
    expect(fmtClock(61_500)).toBe('1:02');
    expect(fmtClock(3_727_000)).toBe('1:02:07');
    expect(fmtFocusMinutes(160)).toBe('2h 40m');
    expect(fmtFocusMinutes(45)).toBe('45m');
    expect(heldLabel(0)).toBe('Nothing held');
    expect(heldLabel(1)).toBe('1 notification held');
    expect(heldBySource([{ source: 'Mail', title: 'a', at: 1 }, { source: 'Mail', title: 'b', at: 2 }, { source: 'Research', title: 'c', at: 3 }]))
      .toBe('2 from Mail, 1 from Research');
  });
});

describe('the saved state', () => {
  test('parses what it wrote and refuses what it did not', () => {
    const s = startSession(50, T0);
    const saved = parseFocusSaved(JSON.stringify({ session: s, log: [], prefs: { lengthMin: 50, startShortcut: ' Focus on ', endShortcut: '' }, ended: null }), T0);
    expect(saved.session).toEqual(s);
    expect(saved.prefs).toEqual({ lengthMin: 50, startShortcut: 'Focus on', endShortcut: '' });
    expect(parseFocusSaved(JSON.stringify({ session: { lengthMin: 9999, startedAt: 1, doneMs: 0 }, prefs: { lengthMin: 90 } }), T0))
      .toMatchObject({ session: null, prefs: { lengthMin: 25 } });
    expect(parseFocusSaved('{', T0).session).toBeNull();
  });

  test('a shortcut name is checked the way the Rust side checks it', () => {
    expect(checkShortcutName('  Focus on ')).toEqual({ ok: true, name: 'Focus on' });
    expect(checkShortcutName('')).toEqual({ ok: true, name: '' });
    expect(checkShortcutName('--help')).toMatchObject({ ok: false });
    expect(checkShortcutName('two\nlines')).toMatchObject({ ok: false });
    expect(checkShortcutName('x'.repeat(121))).toMatchObject({ ok: false });
  });
});

describe('the gate', () => {
  test('holds messages during a session, lets alarms through, and reports at the end', () => {
    expect(holdForFocus({ source: 'Mail', title: 'before' })).toBe(false);
    startFocus('Write');
    expect(holdForFocus({ source: 'Mail', title: 'Invoice due' })).toBe(true);
    expect(holdForFocus({ source: 'Clock', title: 'Alarm', kind: 'alarm' })).toBe(false);
    expect(focusSnapshot().session?.held.map((h) => h.title)).toEqual(['Invoice due']);
    endFocus();
    const snap = focusSnapshot();
    expect(snap.session).toBeNull();
    expect(snap.ended?.held).toHaveLength(1);
    expect(snap.ended?.entry.completed).toBe(false);
    expect(holdForFocus({ source: 'Mail', title: 'after' })).toBe(false);
  });
});
