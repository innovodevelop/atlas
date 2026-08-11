/**
 * Owns a reconnect timer that must die with its owner.
 *
 * The incident this exists for (audit finding C1): useVoiceSession's
 * `ws.onclose` armed a bare `setTimeout(connect, 3000)`. The unmount cleanup
 * closed the WebSocket — which FIRES onclose — so cleanup itself armed the
 * timer it had no handle to clear, and every navigation away from a
 * voice-holding page spawned a fresh, `hello`-authenticated gateway session
 * three seconds after the page was gone. Nothing ever closed those.
 *
 * Two guards, both needed:
 *  - `cancel()` clears an armed timer — covers the timer that already exists.
 *  - `arm()` after `cancel()` is a no-op — covers the onclose that fires
 *    DURING teardown, after cancel ran but before the socket finished dying.
 *
 * Pure over injected schedule/clear so the test owns time (the same
 * convention as deadlineState and the greeting gate: the logic worth testing
 * is testable without a renderer or real timers).
 */
export interface ReconnectGovernor {
  /** Schedule `fn` after `ms`, replacing any armed timer. No-op if cancelled. */
  arm(fn: () => void, ms: number): void;
  /** Clear any armed timer and refuse all future arms. Idempotent. */
  cancel(): void;
  readonly cancelled: boolean;
}

export function createReconnectGovernor(
  schedule: (fn: () => void, ms: number) => number = (fn, ms) => window.setTimeout(fn, ms),
  clear: (id: number) => void = (id) => window.clearTimeout(id),
): ReconnectGovernor {
  let id: number | null = null;
  let cancelled = false;
  return {
    arm(fn, ms) {
      if (cancelled) return;
      if (id !== null) clear(id);
      id = schedule(() => {
        id = null;
        // Re-checked at fire time: cancel() can land between scheduling and
        // firing, and a cleared flag must win over an already-queued callback.
        if (!cancelled) fn();
      }, ms);
    },
    cancel() {
      cancelled = true;
      if (id !== null) {
        clear(id);
        id = null;
      }
    },
    get cancelled() {
      return cancelled;
    },
  };
}
