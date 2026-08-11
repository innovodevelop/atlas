import { describe, expect, it } from 'bun:test';
import { createSharedPoll } from './sharedStore';

/**
 * The sharing rules, with the tests holding the clock and the network.
 *
 * There is no DOM in this suite (and none in this repo's test setup), which is
 * the point: everything worth proving about a shared poll — how many fetches N
 * consumers cause, whether the timer dies with the last of them, what a failure
 * does to good data — is logic, not rendering.
 *
 * Every test uses a fresh `key`. `createSharedPoll` is get-or-create by key, so
 * a reused key would hand the next test the previous test's store.
 */

let nextKey = 0;
const uniqueKey = () => `test:${nextKey++}`;

function fakeClock() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  let time = 1_000_000;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
    schedule: (fn: () => void, _ms: number) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clear: (id: number) => {
      pending.delete(id);
    },
    /** Fire every armed timer, as the event loop eventually would. */
    tick() {
      [...pending.values()].forEach((fn) => fn());
    },
    get armed() {
      return pending.size;
    },
  };
}

const INTERVAL = 30_000;

/** Let the fetch promise chain settle without forcing a fetch of our own. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSharedPoll', () => {
  it('serves N subscribers from one fetch', async () => {
    const clock = fakeClock();
    const data = { temp: 21 };
    let calls = 0;
    const poll = createSharedPoll({
      key: uniqueKey(),
      fetch: async () => {
        calls++;
        return data;
      },
      intervalMs: INTERVAL,
      isActive: () => true,
      now: clock.now,
      schedule: clock.schedule,
      clear: clock.clear,
    });

    const off = [poll.subscribe(() => {}), poll.subscribe(() => {}), poll.subscribe(() => {})];
    // Joins the flight the first subscriber started rather than adding one.
    await poll.refresh();

    expect(calls).toBe(1);
    expect(clock.armed).toBe(1);
    expect(poll.getSnapshot().data).toBe(data);
    off.forEach((fn) => fn());
  });

  it('clears the interval when the last subscriber leaves, and re-arms for the next', async () => {
    const clock = fakeClock();
    const poll = createSharedPoll({
      key: uniqueKey(),
      fetch: async () => 1,
      intervalMs: INTERVAL,
      isActive: () => true,
      now: clock.now,
      schedule: clock.schedule,
      clear: clock.clear,
    });

    const a = poll.subscribe(() => {});
    const b = poll.subscribe(() => {});
    await poll.refresh();
    expect(clock.armed).toBe(1);

    a();
    expect(clock.armed).toBe(1); // one consumer left — still polling

    b();
    expect(clock.armed).toBe(0); // nobody is looking — stop spending requests

    const c = poll.subscribe(() => {});
    expect(clock.armed).toBe(1);
    c();
  });

  it('does not re-fetch on a remount inside the interval, but does once it has lapsed', async () => {
    const clock = fakeClock();
    let calls = 0;
    const poll = createSharedPoll({
      key: uniqueKey(),
      fetch: async () => ++calls,
      intervalMs: INTERVAL,
      isActive: () => true,
      now: clock.now,
      schedule: clock.schedule,
      clear: clock.clear,
    });

    // `refresh()` is deliberately not used here — it forces a fetch by design.
    // What is under test is what SUBSCRIBING alone costs.
    const a = poll.subscribe(() => {});
    await flush();
    expect(calls).toBe(1);
    a();

    clock.advance(INTERVAL - 1);
    const b = poll.subscribe(() => {});
    await flush();
    expect(calls).toBe(1); // the reading on hand is still fresh
    b();

    clock.advance(1);
    const c = poll.subscribe(() => {});
    await flush();
    expect(calls).toBe(2);
    c();
  });

  it('skips a tick while the window is inactive', async () => {
    const clock = fakeClock();
    let calls = 0;
    let active = false;
    const poll = createSharedPoll({
      key: uniqueKey(),
      fetch: async () => ++calls,
      intervalMs: INTERVAL,
      isActive: () => active,
      now: clock.now,
      schedule: clock.schedule,
      clear: clock.clear,
    });

    const off = poll.subscribe(() => {});
    await poll.refresh(); // the initial load is not gated — 1
    clock.tick();
    await Promise.resolve();
    expect(calls).toBe(1);

    active = true;
    clock.tick();
    await poll.refresh();
    expect(calls).toBe(2);
    off();
  });

  it('keeps the last good data when a refresh fails, and reports the error', async () => {
    const clock = fakeClock();
    const good = { temp: 21 };
    let fail = false;
    const poll = createSharedPoll({
      key: uniqueKey(),
      fetch: async () => {
        if (fail) throw new Error('get-weather did not answer');
        return good;
      },
      intervalMs: INTERVAL,
      isActive: () => true,
      now: clock.now,
      schedule: clock.schedule,
      clear: clock.clear,
    });

    const off = poll.subscribe(() => {});
    await poll.refresh();
    expect(poll.getSnapshot()).toEqual({ data: good, isLoading: false, error: null });

    fail = true;
    await poll.refresh();
    const after = poll.getSnapshot();
    expect(after.data).toBe(good); // NOT undefined, and not swapped for a sample
    expect(after.error).toBe('get-weather did not answer');
    off();
  });

  it('keeps the snapshot reference stable across a no-op refresh', async () => {
    const clock = fakeClock();
    const data = { temp: 21 };
    const poll = createSharedPoll({
      key: uniqueKey(),
      fetch: async () => data,
      intervalMs: INTERVAL,
      isActive: () => true,
      now: clock.now,
      schedule: clock.schedule,
      clear: clock.clear,
    });

    const off = poll.subscribe(() => {});
    await poll.refresh();
    const first = poll.getSnapshot();

    await poll.refresh();
    // Same data, same error, same loading flag — a new object here is an
    // infinite render loop in every useSyncExternalStore consumer.
    expect(poll.getSnapshot()).toBe(first);
    off();
  });

  it('notifies subscribers exactly once per real change', async () => {
    const clock = fakeClock();
    const data = { temp: 21 };
    let notifications = 0;
    const poll = createSharedPoll({
      key: uniqueKey(),
      fetch: async () => data,
      intervalMs: INTERVAL,
      isActive: () => true,
      now: clock.now,
      schedule: clock.schedule,
      clear: clock.clear,
    });

    const off = poll.subscribe(() => notifications++);
    await poll.refresh();
    expect(notifications).toBe(1); // undefined+loading -> data

    await poll.refresh();
    expect(notifications).toBe(1); // nothing moved
    off();
  });

  it('hands the same store to the same key and separate stores to different keys', async () => {
    const clock = fakeClock();
    const key = uniqueKey();
    const opts = {
      fetch: async () => 1,
      intervalMs: INTERVAL,
      isActive: () => true,
      now: clock.now,
      schedule: clock.schedule,
      clear: clock.clear,
    };
    expect(createSharedPoll({ key, ...opts })).toBe(createSharedPoll({ key, ...opts }));
    expect(createSharedPoll({ key: uniqueKey(), ...opts })).not.toBe(
      createSharedPoll({ key, ...opts }),
    );
  });
});
