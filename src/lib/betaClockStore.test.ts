import { describe, expect, test } from 'bun:test';
import { NOTHING_RINGING } from './betaClockVoice';
import { handleCommand } from './betaClockStore';

// The store's answers to the brain's clock tools that need no window: what is
// refused is refused before anything is saved or rung.
describe('the clock store answering the brain', () => {
  test('stop and snooze with nothing ringing change nothing and say so', () => {
    expect(handleCommand('stop_alarm', {})).toEqual({ ok: false, message: NOTHING_RINGING });
    expect(handleCommand('snooze_alarm', { minutes: 5 })).toEqual({ ok: false, message: NOTHING_RINGING });
  });
  test('a time it cannot read is refused before anything is saved', () => {
    const r = handleCommand('set_alarm', { time: 'seven' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('could not read that time');
  });
  test('an action it does not have is refused', () => {
    expect(handleCommand('delete_alarm', {}).ok).toBe(false);
  });
});
