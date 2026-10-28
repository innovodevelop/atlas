/**
 * Push to talk, the gateway's half: whether the VAD's end of speech may close
 * the utterance (not while the client holds its key), and two guards that
 * keep a held key from leaving the microphone streaming to speech-to-text.
 *
 *  - A cap. A held turn is closed after MAX_HOLD_MS whatever the client says,
 *    so a release that never arrives costs one minute of listening, not an
 *    open microphone until somebody notices.
 *  - The release that overtakes its hold. The client sends `activate{hold}`
 *    only once its microphone is open, which on the first press waits for the
 *    permission, the capture worklet and the wake model. A release in that
 *    wait can reach the gateway first, while it is idle, where there is
 *    nothing to close. A hold that follows such a release within
 *    RELEASED_HOLD_WINDOW_MS is not held: the turn starts as a plain
 *    activation, which the VAD closes. (The client also sends that late hold
 *    with its own `end_speech` straight after; this guard is for a client that
 *    does not.)
 *
 * Kept apart from session.ts, which needs a VAD model to construct, so these
 * rules are tested on their own with a fake clock and fake timers.
 */

/** The longest a held key keeps a turn listening. */
export const MAX_HOLD_MS = 60_000;
/** How long a release that found nothing to close cancels the hold that follows it. */
export const RELEASED_HOLD_WINDOW_MS = 5_000;

export interface HoldTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: HoldTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PttHold {
  private held = false;
  /** When an `end_speech` last arrived with the session idle, until a turn starts. */
  private idleReleaseAt: number | null = null;
  private cap: unknown = null;

  /**
   * `onCap` runs when a held turn reaches MAX_HOLD_MS: the session closes the
   * utterance as if the key had been released.
   */
  constructor(
    private onCap: () => void,
    private now: () => number = () => performance.now(),
    private timers: HoldTimers = realTimers,
  ) {}

  /** The client is holding its key: the VAD's end of speech does not close the utterance. */
  get isHeld(): boolean {
    return this.held;
  }

  /**
   * A turn is starting: `activate` (with `hold` when the client says its key
   * is down) or `wake`. Returns whether the turn is held.
   */
  start(hold: boolean): boolean {
    this.stopCap();
    const releasedFirst =
      this.idleReleaseAt !== null && this.now() - this.idleReleaseAt < RELEASED_HOLD_WINDOW_MS;
    // A release cancels at most the one activation after it.
    this.idleReleaseAt = null;
    this.held = hold && !releasedFirst;
    if (this.held) {
      this.cap = this.timers.set(() => {
        this.cap = null;
        if (!this.held) return;
        this.held = false;
        this.onCap();
      }, MAX_HOLD_MS);
    }
    return this.held;
  }

  /** `end_speech`. `idle`: the session was idle, so the release had nothing to close. */
  release(idle: boolean): void {
    this.stopCap();
    this.held = false;
    this.idleReleaseAt = idle ? this.now() : null;
  }

  /** The turn is over some other way (cancel, a failed start, a disconnect). */
  clear(): void {
    this.stopCap();
    this.held = false;
    this.idleReleaseAt = null;
  }

  private stopCap(): void {
    if (this.cap !== null) this.timers.clear(this.cap);
    this.cap = null;
  }
}
