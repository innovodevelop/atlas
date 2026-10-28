/**
 * How Atlas listens — Settings → Voice → Voice input, read by the voice
 * session (src/hooks/useVoiceSession.ts).
 *
 * Three switches, stored on this Mac in localStorage ('atlas:voice_input'):
 *
 *   - wakeWord: "Listen for Hey Atlas". Off, the on-device detector is not
 *     loaded at all and idle microphone frames go nowhere; the mic button and
 *     push to talk still start a turn.
 *   - pushToTalk: hold the right ⌥ Option key to speak, release to send. The
 *     design's "hold fn" is not possible from a web view: macOS keeps the fn
 *     (Globe) key for itself (emoji, dictation) and does not deliver it to
 *     pages, so the right Option key — which macOS does deliver, and which
 *     dictation apps use for the same job — stands in.
 *   - muteWhenLocked: the microphone is gated off while the screen is locked,
 *     exactly like the mute button: no frame reaches the wake detector or the
 *     gateway. Rust observes macOS's own lock and unlock notifications and
 *     tells the webview at once (`mac:screen-lock`, src-tauri/src/mac_controls.rs).
 *
 * Settings writes through `setVoiceInput`, which also tells this window at
 * once (a `storage` event reaches other documents only), so the voice session
 * picks a change up without a reload.
 *
 * The push-to-talk key handling is a small pure state machine, `pttStep`, so
 * the rules are tested here rather than in a hook: a hold only counts after
 * HOLD_MS with no other key pressed (⌥ is also the Talk shortcut's modifier,
 * ⌥ Space, and how many keyboards type @, € or |), never while typing in a
 * field, and losing the window ends it like a release.
 *
 * What one press tells the gateway is a second small machine, `pttPressed` /
 * `pttReleased` / `pttActivated`, because the release and the activation can
 * come in either order: the session sends `activate{hold}` only once the
 * microphone is open, and the first press after launch waits for the
 * permission, the capture worklet and the wake model.
 */

export const VOICE_INPUT_KEY = 'atlas:voice_input';
/** Sent on `window` after a write in this document. */
export const VOICE_INPUT_EVENT = 'atlas:voice-input';

export interface VoiceInputPrefs {
  wakeWord: boolean;
  pushToTalk: boolean;
  muteWhenLocked: boolean;
}

/** The design's defaults: listening for the wake word, no push to talk, muted while locked. */
export const DEFAULT_VOICE_INPUT: VoiceInputPrefs = { wakeWord: true, pushToTalk: false, muteWhenLocked: true };

/** Stored JSON → prefs. Anything missing or malformed falls back to the default for that switch. */
export function parseVoiceInput(raw: string | null | undefined): VoiceInputPrefs {
  let v: Record<string, unknown> = {};
  try { v = raw ? (JSON.parse(raw) as Record<string, unknown>) ?? {} : {}; } catch { v = {}; }
  const pick = (k: keyof VoiceInputPrefs) => (typeof v[k] === 'boolean' ? (v[k] as boolean) : DEFAULT_VOICE_INPUT[k]);
  return { wakeWord: pick('wakeWord'), pushToTalk: pick('pushToTalk'), muteWhenLocked: pick('muteWhenLocked') };
}

export function readVoiceInput(): VoiceInputPrefs {
  try {
    return parseVoiceInput(typeof window === 'undefined' ? null : window.localStorage.getItem(VOICE_INPUT_KEY));
  } catch {
    return { ...DEFAULT_VOICE_INPUT }; // blocked storage: the defaults
  }
}

/** Write one or more switches and tell this window. Returns the stored prefs. */
export function setVoiceInput(patch: Partial<VoiceInputPrefs>): VoiceInputPrefs {
  const next = { ...readVoiceInput(), ...patch };
  if (typeof window === 'undefined') return next;
  try { window.localStorage.setItem(VOICE_INPUT_KEY, JSON.stringify(next)); } catch { /* private window: this session only */ }
  try { window.dispatchEvent(new CustomEvent(VOICE_INPUT_EVENT, { detail: next })); } catch { /* no CustomEvent: the next read sees it */ }
  return next;
}

/** Call `fn` with the prefs whenever they change, here or in another window. Returns the unsubscribe. */
export function onVoiceInputChange(fn: (prefs: VoiceInputPrefs) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const here = () => fn(readVoiceInput());
  const there = (e: StorageEvent) => { if (e.key === null || e.key === VOICE_INPUT_KEY) fn(readVoiceInput()); };
  window.addEventListener(VOICE_INPUT_EVENT, here);
  window.addEventListener('storage', there);
  return () => { window.removeEventListener(VOICE_INPUT_EVENT, here); window.removeEventListener('storage', there); };
}

/* ── Push to talk ────────────────────────────────────────────────────────── */

/** `KeyboardEvent.code` of the push-to-talk key. */
export const PTT_CODE = 'AltRight';
/** How long the key must be held, alone, before Atlas starts listening. */
export const PTT_HOLD_MS = 300;

/** idle → armed (key down, waiting out HOLD_MS) → talking (listening) → idle. */
export type PttState = 'idle' | 'armed' | 'talking';

export type PttEvent =
  | { type: 'down'; code: string; typing: boolean; repeat?: boolean }
  | { type: 'up'; code: string }
  /** HOLD_MS passed since the key went down. */
  | { type: 'held' }
  /** The window lost focus: a release may never arrive. */
  | { type: 'blur' };

export interface PttStep {
  state: PttState;
  /** `start`: begin a held turn. `end`: close it and send. `arm`: start the HOLD_MS timer. `disarm`: stop it. */
  action: 'start' | 'end' | 'arm' | 'disarm' | null;
}

export function pttStep(state: PttState, e: PttEvent): PttStep {
  switch (e.type) {
    case 'down':
      if (e.code === PTT_CODE) {
        if (state !== 'idle' || e.repeat) return { state, action: null };
        return e.typing ? { state, action: null } : { state: 'armed', action: 'arm' };
      }
      // Another key while waiting: it was a shortcut or a character, not a hold.
      return state === 'armed' ? { state: 'idle', action: 'disarm' } : { state, action: null };
    case 'held':
      return state === 'armed' ? { state: 'talking', action: 'start' } : { state, action: null };
    case 'up':
      if (e.code !== PTT_CODE) return { state, action: null };
      if (state === 'talking') return { state: 'idle', action: 'end' };
      if (state === 'armed') return { state: 'idle', action: 'disarm' };
      return { state, action: null };
    case 'blur':
      if (state === 'talking') return { state: 'idle', action: 'end' };
      if (state === 'armed') return { state: 'idle', action: 'disarm' };
      return { state, action: null };
    default:
      return { state, action: null };
  }
}

/* ── One press, as the gateway hears it ─────────────────────────────────── */

export type PttControl = { type: 'activate'; hold: true } | { type: 'end_speech' };

const HOLD: PttControl = { type: 'activate', hold: true };
const RELEASE: PttControl = { type: 'end_speech' };

/** The key is down (`down`), and this press's `activate{hold}` has gone out (`activated`). */
export interface PttPress {
  down: boolean;
  activated: boolean;
}

export const PTT_NO_PRESS: PttPress = { down: false, activated: false };

/** pttStep said `start`: a hold began; the session is opening the microphone. */
export function pttPressed(): PttPress {
  return { down: true, activated: false };
}

/**
 * pttStep said `end`. The release goes out now only when the hold has: before
 * that the gateway has nothing to close, and a hold arriving after its own
 * release would keep the turn listening with nobody holding the key.
 * `pttActivated` sends that release instead.
 */
export function pttReleased(p: PttPress): { press: PttPress; send: PttControl[] } {
  return { press: { down: false, activated: p.activated }, send: p.activated ? [RELEASE] : [] };
}

/**
 * The microphone is open: send the hold — and, when the key came up while it
 * opened, its release straight after, so the gateway closes the turn at once.
 */
export function pttActivated(p: PttPress): { press: PttPress; send: PttControl[] } {
  return { press: { down: p.down, activated: true }, send: p.down ? [HOLD] : [HOLD, RELEASE] };
}
