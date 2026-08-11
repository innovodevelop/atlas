import { describe, expect, it } from 'bun:test';
import { createReconnectGovernor } from './reconnectGovernor';

/**
 * A fake scheduler the tests own completely — no real timers, so the
 * cancel-vs-queued races are exercised deterministically.
 */
function fakeClock() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  return {
    schedule: (fn: () => void, _ms: number) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clear: (id: number) => {
      pending.delete(id);
    },
    /** Fire every armed timer, as the event loop eventually would. */
    fireAll() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    get armed() {
      return pending.size;
    },
  };
}

describe('reconnectGovernor', () => {
  it('fires an armed reconnect when not cancelled', () => {
    const clock = fakeClock();
    const gov = createReconnectGovernor(clock.schedule, clock.clear);
    let fired = 0;
    gov.arm(() => fired++, 3000);
    clock.fireAll();
    expect(fired).toBe(1);
  });

  it('cancel clears an armed timer — nothing fires later', () => {
    const clock = fakeClock();
    const gov = createReconnectGovernor(clock.schedule, clock.clear);
    let fired = 0;
    gov.arm(() => fired++, 3000);
    gov.cancel();
    expect(clock.armed).toBe(0);
    clock.fireAll();
    expect(fired).toBe(0);
  });

  /**
   * THE incident case: cleanup cancels, then closes the socket, and the
   * close handler tries to arm a reconnect during teardown. That arm must be
   * a no-op — this exact sequence is how the zombie sessions were born.
   */
  it('arm after cancel is a no-op', () => {
    const clock = fakeClock();
    const gov = createReconnectGovernor(clock.schedule, clock.clear);
    let fired = 0;
    gov.cancel();
    gov.arm(() => fired++, 3000);
    expect(clock.armed).toBe(0);
    clock.fireAll();
    expect(fired).toBe(0);
  });

  /**
   * Cancel landing between scheduling and firing: the callback is already in
   * the queue when cancel runs (a real event loop can do this if clear and
   * the timer race). The fire-time cancelled check must win.
   */
  it('a queued callback does not fire if cancel landed first', () => {
    const clock = fakeClock();
    // A clear() that does nothing simulates the timer having already left
    // the timer queue for the task queue — the worst-case interleaving.
    const gov = createReconnectGovernor(clock.schedule, () => {});
    let fired = 0;
    gov.arm(() => fired++, 3000);
    gov.cancel();
    clock.fireAll();
    expect(fired).toBe(0);
  });

  it('re-arming replaces the previous timer instead of stacking', () => {
    const clock = fakeClock();
    const gov = createReconnectGovernor(clock.schedule, clock.clear);
    let fired = 0;
    gov.arm(() => fired++, 3000);
    gov.arm(() => fired++, 3000);
    expect(clock.armed).toBe(1);
    clock.fireAll();
    expect(fired).toBe(1);
  });

  it('cancel is idempotent and reports state', () => {
    const clock = fakeClock();
    const gov = createReconnectGovernor(clock.schedule, clock.clear);
    expect(gov.cancelled).toBe(false);
    gov.cancel();
    gov.cancel();
    expect(gov.cancelled).toBe(true);
  });
});
