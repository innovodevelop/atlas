/**
 * The countdown maths, with the tests holding the clock.
 *
 * Only `deadlineState` is exercised — the hooks around it are an interval and a
 * `setNow`, and there is nothing in them a renderer would prove that this does
 * not. Same split as `useAtlasPresence.test.ts` (which tests `resolvePresence`,
 * not the hook) and `greetingGate.test.ts`.
 *
 * The jumping-clock case is the point of the whole file. A decrementing timer
 * passes every other test here and fails that one silently in production —
 * WKWebView throttling, a sleeping Mac, DST, a manual clock change. Deleting it
 * would leave a suite that cannot tell the two designs apart.
 *
 * A timezone change has no case of its own because there is nothing for it to
 * do: both operands are epoch milliseconds and no zone offset touches those. A
 * timer set in Copenhagen is unmoved by the device switching to Tokyo time —
 * which is the reason the hook takes an instant and never a local wall time.
 */
import { describe, expect, test } from 'bun:test';
import { deadlineState } from '@/hooks/useDeadline';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('deadlineState', () => {
  test('before the deadline, remaining counts down and nothing has elapsed', () => {
    expect(deadlineState(NOW + 90_000, NOW)).toEqual({ remaining: 90_000, elapsed: false });
    expect(deadlineState(NOW + 1, NOW)).toEqual({ remaining: 1, elapsed: false });
  });

  test('AT the deadline it has elapsed', () => {
    // The boundary belongs to `elapsed`: a timer showing 0:00 that has not gone
    // off yet is the bug this assertion exists to prevent.
    expect(deadlineState(NOW, NOW)).toEqual({ remaining: 0, elapsed: true });
  });

  test('after the deadline remaining goes negative rather than clamping', () => {
    // Overrun is a state the alarm surface renders ("+0:40"), not an error.
    expect(deadlineState(NOW - 40_000, NOW)).toEqual({ remaining: -40_000, elapsed: true });
    expect(deadlineState(NOW - 3 * HOUR, NOW).remaining).toBe(-3 * HOUR);
  });

  test('a null deadline is idle, not expired', () => {
    // Distinct from an expired one on purpose: `elapsed` false is what stops a
    // caller firing an alarm for a timer nobody set.
    expect(deadlineState(null, NOW)).toEqual({ remaining: 0, elapsed: false });
    expect(deadlineState(null, NOW + 10 * HOUR)).toEqual({ remaining: 0, elapsed: false });
  });

  test('the answer is a function of the passed clock, not of how it got there', () => {
    // The same instants, read in two different orders. Anything that remembered
    // the previous reading — a latched `elapsed`, an accumulated duration —
    // would answer differently depending on the history, and that is exactly
    // what a timer must never do.
    const deadline = NOW + 10 * MINUTE;
    const instants = [NOW, NOW + 5 * MINUTE, NOW - HOUR, NOW + 2 * HOUR, NOW + 10 * MINUTE];
    const forwards = instants.map((t) => deadlineState(deadline, t));
    const backwards = [...instants].reverse().map((t) => deadlineState(deadline, t)).reverse();
    expect(backwards).toEqual(forwards);
  });

  test('a clock that JUMPS FORWARD — sleep, throttling, spring DST', () => {
    // 25-minute timer. The lid closes at t+1min and the machine wakes an hour
    // later: no interval fired in between, so an accumulator would still be
    // showing ~24 minutes left. Subtraction reports the truth on the first
    // paint after wake — the timer is 36 minutes overdue.
    const deadline = NOW + 25 * MINUTE;

    expect(deadlineState(deadline, NOW + MINUTE)).toEqual({ remaining: 24 * MINUTE, elapsed: false });

    const afterWake = deadlineState(deadline, NOW + MINUTE + HOUR);
    expect(afterWake.elapsed).toBe(true);
    expect(afterWake.remaining).toBe(-36 * MINUTE);

    // Spring DST is the same jump by another cause, and must NOT move a
    // deadline: both sides are absolute instants, so a +1h shift of the wall
    // clock is +1h of elapsed time and nothing more.
    expect(deadlineState(deadline, NOW + HOUR).remaining).toBe(25 * MINUTE - HOUR);
  });

  test('a clock that JUMPS BACKWARD — autumn DST, NTP correction, timezone change', () => {
    // The clock moving back means the deadline is further away again. That is
    // the correct reading of the machine's own time, and it recovers by itself
    // the moment the clock settles: nothing here latched the earlier value.
    const deadline = NOW + 10 * MINUTE;

    expect(deadlineState(deadline, NOW + 9 * MINUTE)).toEqual({ remaining: MINUTE, elapsed: false });

    const back = deadlineState(deadline, NOW + 9 * MINUTE - HOUR);
    expect(back.remaining).toBe(MINUTE + HOUR);
    expect(back.elapsed).toBe(false);

    // …and a deadline already passed does not un-elapse unless the clock really
    // did go back past it — the state is re-derived, never remembered.
    expect(deadlineState(NOW - MINUTE, NOW - 30_000).elapsed).toBe(true);
    expect(deadlineState(NOW - MINUTE, NOW - 2 * MINUTE).elapsed).toBe(false);
  });
});
