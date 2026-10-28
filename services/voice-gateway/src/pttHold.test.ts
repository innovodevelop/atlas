import { describe, expect, test } from "bun:test";
import { MAX_HOLD_MS, PttHold, RELEASED_HOLD_WINDOW_MS, type HoldTimers } from "./pttHold.ts";

/** A clock and a timer queue the test moves by hand. */
function fakeTime() {
  let t = 1_000;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: HoldTimers = {
    set: (fn, ms) => { const id = next++; pending.set(id, { at: t + ms, fn }); return id; },
    clear: (id) => { pending.delete(id as number); },
  };
  const advance = (ms: number) => {
    t += ms;
    for (const [id, p] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (p.at <= t) { pending.delete(id); p.fn(); }
    }
  };
  return { now: () => t, timers, advance, pending: () => pending.size };
}

function setup() {
  const time = fakeTime();
  let capped = 0;
  const hold = new PttHold(() => { capped++; }, time.now, time.timers);
  return { hold, time, capped: () => capped };
}

describe("push to talk on the gateway", () => {
  test("a hold keeps the turn until its release", () => {
    const { hold, time } = setup();
    expect(hold.start(true)).toBe(true);
    time.advance(20_000);
    expect(hold.isHeld).toBe(true);
    hold.release(false);
    expect(hold.isHeld).toBe(false);
    expect(time.pending()).toBe(0);
  });

  test("wake and the mic button are never held", () => {
    const { hold } = setup();
    expect(hold.start(false)).toBe(false);
    expect(hold.isHeld).toBe(false);
  });

  test("a held turn is closed after a minute when no release comes", () => {
    const { hold, time, capped } = setup();
    hold.start(true);
    time.advance(MAX_HOLD_MS - 1);
    expect(capped()).toBe(0);
    time.advance(1);
    expect(capped()).toBe(1);
    expect(hold.isHeld).toBe(false);
  });

  test("a release, a cancel or a new turn stops the cap", () => {
    for (const end of ["release", "clear", "start"] as const) {
      const { hold, time, capped } = setup();
      hold.start(true);
      time.advance(30_000);
      if (end === "release") hold.release(false);
      else if (end === "clear") hold.clear();
      else hold.start(false);
      time.advance(MAX_HOLD_MS);
      expect(capped()).toBe(0);
    }
  });

  test("the release that overtakes its hold: the hold is not held", () => {
    // The first press after launch: the key went up while the client was
    // still opening the microphone, so its end_speech reached an idle session
    // before the activate{hold} it belongs to.
    const { hold, time, capped } = setup();
    hold.release(true);
    time.advance(1_500);
    expect(hold.start(true)).toBe(false);
    expect(hold.isHeld).toBe(false);
    time.advance(MAX_HOLD_MS);
    expect(capped()).toBe(0);
  });

  test("a release cancels only the one hold after it, and only for a few seconds", () => {
    const { hold, time } = setup();
    hold.release(true);
    expect(hold.start(true)).toBe(false);
    hold.release(false);
    expect(hold.start(true)).toBe(true); // the next press holds again

    const late = setup();
    late.hold.release(true);
    late.time.advance(RELEASED_HOLD_WINDOW_MS);
    expect(late.hold.start(true)).toBe(true);
  });

  test("a release while a turn listens leaves the next hold alone", () => {
    const { hold } = setup();
    hold.start(true);
    hold.release(false);
    expect(hold.start(true)).toBe(true);
  });

  test("a wake after a stray release uses it up", () => {
    const { hold } = setup();
    hold.release(true);
    hold.start(false);
    expect(hold.start(true)).toBe(true);
  });
});
