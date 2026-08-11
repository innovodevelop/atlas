/**
 * Countdowns, count-ups and alarms — measured against the wall clock, never
 * counted down.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * A timer here holds an ABSOLUTE INSTANT and subtracts `Date.now()` from it.
 * Nothing in this file decrements a counter, and nothing accumulates elapsed
 * ticks, because both of those are wrong in ways that do not announce
 * themselves:
 *
 *   • WKWebView throttles timers hard when the window is not key — the same
 *     throttle that left the dashboard unclickable and produced
 *     `lib/commitAfter.ts`. A decrementing timer simply loses every tick it did
 *     not get: a 10-minute countdown backgrounded for 10 minutes comes back
 *     still showing minutes left.
 *   • The Mac sleeps. On wake, no interval fired for the missing hours.
 *   • DST and a manual clock change move `Date.now()` by an hour in one step.
 *     A subtraction absorbs that; an accumulator has no idea it happened.
 *
 * A wrong subtraction is visible on the first render. A drifted accumulator is
 * invisible until the alarm is badly, unarguably late — which for a timer is
 * the entire failure. So the interval in this file carries NO state at all: it
 * exists only to make React re-read the clock and paint.
 *
 * The primitive is lifted from the only correct timer the app had, the undo
 * window in `components/atlas-ui/mail/MailDraftComposer.tsx` — including the
 * `setNow(Date.now())` on entry, which is not a nicety: `now` is otherwise
 * whatever it was when the PREVIOUS deadline expired, so the first paint of a
 * new countdown shows a stale figure until the first tick lands.
 *
 * ── WHY THE PURE FUNCTION IS EXPORTED ───────────────────────────────────────
 *
 * `deadlineState` takes `now` as an argument instead of reading the clock, so
 * the tests own time and can jump it forwards and backwards. That is the same
 * convention as `resolvePresence` (useAtlasPresence.ts) and the greeting gate:
 * the logic worth testing is tested without a renderer. `useDeadline.test.ts`
 * tests only that function, and the clock-jump case in it is the reason this
 * design was chosen over a decrementing one.
 */
import { useEffect, useState } from 'react';

export interface DeadlineState {
  /**
   * Milliseconds until the deadline, and NEGATIVE once it has passed.
   *
   * Overrun is a real state, not an error: a kitchen timer that has been
   * ringing for 40 seconds should be able to say so, and the alarm surface
   * renders "+0:40" from exactly this number. Clamping it at zero here would
   * throw away the only information the surface has about how late it is.
   */
  readonly remaining: number;
  /** True at the deadline and after it — the instant something should fire. */
  readonly elapsed: boolean;
}

/**
 * The whole calculation, as a pure function of the two inputs.
 *
 * `elapsed` is `remaining <= 0`, so the boundary instant counts as elapsed —
 * the same `now >= sendsAt` test the mail undo window fires on. A timer that
 * hits 0:00 and has not gone off yet is a bug report.
 *
 * A null deadline means "nothing is running", which is NOT the same as an
 * expired one: `elapsed` stays false so a caller cannot fire an alarm for a
 * timer that was never set. `remaining` is 0 because there is no interval and
 * therefore no number to show.
 */
export function deadlineState(deadline: number | null, now: number): DeadlineState {
  if (deadline === null) return { remaining: 0, elapsed: false };
  const remaining = deadline - now;
  return { remaining, elapsed: remaining <= 0 };
}

export interface UseDeadline extends DeadlineState {
  /** The clock reading this render was derived from. */
  readonly now: number;
}

/**
 * Re-render `tickMs` apart while a deadline is pending, and report where the
 * wall clock stands against it.
 *
 * A null deadline starts NO interval — a Clock surface with nothing running
 * must not wake the webview four times a second forever. The interval is torn
 * down on unmount and re-created whenever the deadline changes, so a restarted
 * timer cannot leave the old one ticking behind it.
 */
export function useDeadline(deadline: number | null, tickMs = 250): UseDeadline {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return;
    // Immediately, not on the first tick — see the header.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [deadline, tickMs]);

  return { now, ...deadlineState(deadline, now) };
}

/**
 * The same primitive for counting UP: a repainting clock, no deadline.
 *
 * A stopwatch is `now - startedAt` and nothing else, so it needs a fresh `now`
 * rather than a duration — anchor on the start instant and this survives sleep
 * and throttling for the same reason the countdown does. `active` false stops
 * the interval; the last reading is kept so a paused stopwatch keeps showing
 * the time it was paused at instead of collapsing to zero.
 */
export function useWallClock(active: boolean, tickMs = 250): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [active, tickMs]);

  return now;
}
