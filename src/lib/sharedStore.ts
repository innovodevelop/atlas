import { isWindowActive } from '@/hooks/useWindowActivity';

/**
 * One fetch and one interval per data source, shared by every mounted consumer.
 *
 * The incident this exists for (audit findings C6/C7): every data hook was a
 * plain `useState` + `setInterval` per mount, so the cost of a source scaled
 * with how many components happened to draw it. The plain dashboard mounts
 * `useWeather` FIVE times — the hero card, the atmosphere canvas, the expanded
 * view, the widget catalog and the band narration — and each one fired its own
 * `get-weather` on mount and then its own 30-minute timer. Ten real HTTP calls
 * against a rate-limited external API to render one screen, and five timers
 * racing each other for the rest of the session.
 *
 * `useMusicPlayer` had already solved this for the music engine, for the same
 * reason and in the same way: a module-scoped store read through
 * `useSyncExternalStore`. This is that pattern extracted so the data hooks can
 * share it. It is the canonical shape for anything polled — reach for it before
 * writing another per-mount interval.
 *
 * What the store guarantees:
 *  - N subscribers, one fetch. Only the first subscriber starts anything.
 *  - The interval starts with the first subscriber and dies with the last, so
 *    an unmounted surface cannot keep spending requests.
 *  - Ticks are gated on `isWindowActive()` — the non-reactive read, which is
 *    the documented way to consult activity from inside a timer callback
 *    (a hook would re-render every consumer just to decide not to fetch).
 *  - A failed fetch sets `error` and KEEPS the last-good `data`. Clobbering a
 *    good reading with `undefined` because one refresh timed out is how a card
 *    that was showing the real temperature starts showing canned sample data.
 */

export interface SharedPollSnapshot<T> {
  /** `undefined` until the first success. A later failure never clears it. */
  data: T | undefined;
  /** True only until the first attempt settles; background refreshes are silent. */
  isLoading: boolean;
  error: string | null;
}

export interface SharedPoll<T> {
  /** `useSyncExternalStore` subscribe. Starts the poll on the first caller. */
  subscribe(onChange: () => void): () => void;
  /** `useSyncExternalStore` snapshot. Stable reference between real changes. */
  getSnapshot(): SharedPollSnapshot<T>;
  /** Fetch now, ignoring window activity — this is a user-driven refetch. */
  refresh(): Promise<void>;
}

export interface SharedPollOptions<T> {
  /**
   * Identity of the source. Two calls with the same key get the SAME store, so
   * the key must name everything `fetch` closes over (city, symbols, category).
   * A key that under-describes its request silently serves one caller another
   * caller's data.
   */
  key: string;
  fetch: () => Promise<T>;
  intervalMs: number;
  /** Defaults to `isWindowActive`; injected by the tests. */
  isActive?: () => boolean;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => number;
  clear?: (id: number) => void;
}

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  // localClient.functions.invoke rejects with a bare `{ message }` on the local
  // command path, which `String(err)` would render as "[object Object]".
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'An error occurred';
};

function build<T>(options: SharedPollOptions<T>): SharedPoll<T> {
  const {
    fetch: fetchOnce,
    intervalMs,
    isActive = isWindowActive,
    now = Date.now,
    schedule = (fn, ms) => setInterval(fn, ms) as unknown as number,
    clear = (id) => clearInterval(id as unknown as ReturnType<typeof setInterval>),
  } = options;

  const subscribers = new Set<() => void>();
  let snapshot: SharedPollSnapshot<T> = { data: undefined, isLoading: true, error: null };
  let timer: number | null = null;
  let inFlight: Promise<void> | null = null;
  let settledAt = 0;
  let everSettled = false;

  /**
   * The snapshot reference must change on every real change and must NOT change
   * otherwise. `useSyncExternalStore` compares by identity: a fresh object per
   * call re-renders forever, and a mutated-in-place object never re-renders at
   * all. So writes go through here, which builds a new object only when a field
   * actually moved.
   */
  function set(next: Partial<SharedPollSnapshot<T>>): void {
    const merged = { ...snapshot, ...next };
    if (
      Object.is(merged.data, snapshot.data) &&
      merged.isLoading === snapshot.isLoading &&
      merged.error === snapshot.error
    ) {
      return;
    }
    snapshot = merged;
    for (const fn of subscribers) fn();
  }

  /** One flight at a time; a caller arriving mid-flight joins it. */
  function run(): Promise<void> {
    if (inFlight) return inFlight;
    // `Promise.resolve().then` rather than a bare call: the first `run()` of a
    // store happens inside `subscribe`, which React invokes from an effect, so
    // a fetcher that throws BEFORE its first await would take the render tree
    // down instead of landing in `error` like every other failure.
    inFlight = Promise.resolve()
      .then(fetchOnce)
      .then(
        (data) => {
          set({ data, error: null, isLoading: false });
        },
        (err: unknown) => {
          // `data` is deliberately absent from this patch — see the header.
          set({ error: errorMessage(err), isLoading: false });
        },
      )
      .finally(() => {
        // A failed attempt still counts as an attempt: the whole point of the
        // stamp is to not hammer a source, and a failing endpoint is exactly
        // the one a remount loop must not retry on every mount.
        settledAt = now();
        everSettled = true;
        inFlight = null;
      });
    return inFlight;
  }

  function start(): void {
    if (timer !== null) return;
    timer = schedule(() => {
      if (isActive()) void run();
    }, intervalMs);
    // Remounting a surface is not new information. Only fetch on start if there
    // is nothing on hand or what we have is older than the poll interval —
    // otherwise route swaps and focus changes turn into free API calls.
    if (!everSettled || now() - settledAt >= intervalMs) void run();
  }

  function stop(): void {
    if (timer === null) return;
    clear(timer);
    timer = null;
  }

  return {
    subscribe(onChange) {
      subscribers.add(onChange);
      start();
      return () => {
        subscribers.delete(onChange);
        if (subscribers.size === 0) stop();
      };
    },
    // Not `() => ({...snapshot})`. See `set`.
    getSnapshot: () => snapshot,
    refresh: () => run(),
  };
}

// Module-scoped so the sharing survives unmounts: the last consumer leaving
// stops the timer but keeps the data, which is what makes a remount free.
const polls = new Map<string, SharedPoll<unknown>>();

/**
 * Get-or-create the shared poll for `key`. Deliberately NOT one store per
 * call: the second caller with the same key gets the first caller's store,
 * which is the entire point. `fetch`/`intervalMs` are read only when the store
 * is first built.
 */
export function createSharedPoll<T>(options: SharedPollOptions<T>): SharedPoll<T> {
  const existing = polls.get(options.key);
  if (existing) return existing as SharedPoll<T>;
  const poll = build(options);
  polls.set(options.key, poll as SharedPoll<unknown>);
  return poll;
}
