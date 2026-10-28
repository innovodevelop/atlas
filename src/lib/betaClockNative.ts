/**
 * The Clock's calls into the Mac app (src-tauri/src/clock.rs), one function
 * each, so the store and the editor never spell a command name or its
 * argument casing themselves. Outside the app every call refuses with a
 * sentence the screen can show; nothing here pretends to have worked.
 *
 * Tauri v2 camelCases Rust parameter names on the wire: `until_ms` is sent as
 * `untilMs`, `user_id` as `userId`. Getting that wrong fails deserialisation,
 * which looks exactly like a command that did nothing.
 */
import { getSession } from './authClient';
import { decodeSpeakers, type SpeakerList } from './betaClockSpeakers';

export const CLOCK_COMMANDS = {
  keepAwake: 'clock_keep_awake',
  releaseAwake: 'clock_release_awake',
  speakers: 'clock_speakers',
  ringSpeaker: 'clock_ring_speaker',
  reply: 'clock_command_reply',
} as const;

/** The event the brain's clock tools arrive on (clock.rs `run_voice_command`). */
export const CLOCK_EVENT = 'clock:command';

export const NOT_NATIVE = 'This needs the Atlas Mac app.';

export const isNative = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Rust rejects with a plain string, not an Error. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'the Mac app did not say why';
}

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isNative()) throw new Error(NOT_NATIVE);
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args);
}

/** The signed-in account the smart-home mirror is scoped to, or null. */
export const sessionUserId = (): string | null => getSession()?.userId ?? null;

export interface AwakeState {
  active: boolean;
  untilMs: number | null;
}

const readAwake = (raw: unknown): AwakeState => {
  const r = (raw ?? {}) as { active?: unknown; untilMs?: unknown };
  return { active: r.active === true, untilMs: typeof r.untilMs === 'number' ? r.untilMs : null };
};

/** Hold the Mac awake until `untilMs`; replaces any earlier hold. */
export async function keepAwake(untilMs: number): Promise<AwakeState> {
  return readAwake(await invoke(CLOCK_COMMANDS.keepAwake, { untilMs }));
}

export async function releaseAwake(): Promise<AwakeState> {
  return readAwake(await invoke(CLOCK_COMMANDS.releaseAwake));
}

/** The Home Assistant speakers the smart-home mirror knows. Local; no bridge is asked. */
export async function listSpeakers(): Promise<SpeakerList> {
  const userId = sessionUserId();
  if (!userId) throw new Error('sign in to see your speakers');
  return decodeSpeakers(await invoke(CLOCK_COMMANDS.speakers, { userId }));
}

/** How long a ring may take before the Mac rings instead. Rust bounds each request to six seconds. */
export const SPEAKER_WAIT_MS = 9000;

/**
 * Speak `message` on one speaker. Resolves with the reason when it did not —
 * never throws — so the store can fall back to this Mac in one place.
 */
export async function ringSpeaker(deviceId: string, message: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = sessionUserId();
  if (!userId) return { ok: false, error: 'nobody is signed in to Atlas' };
  let timer: number | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('Home Assistant took too long')), SPEAKER_WAIT_MS);
    });
    await Promise.race([invoke(CLOCK_COMMANDS.ringSpeaker, { userId, deviceId, message }), late]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  } finally {
    if (timer != null) window.clearTimeout(timer);
  }
}

/** Answer one `clock:command`. A reply that cannot be delivered is dropped: Rust has already timed the call out. */
export async function replyToCommand(id: string, ok: boolean, message: string, data: Record<string, unknown> | null): Promise<void> {
  try {
    await invoke(CLOCK_COMMANDS.reply, { id, ok, message, data });
  } catch {
    /* the tool call has reported "no answer" already */
  }
}

/** Listen for the brain's clock commands. Resolves to the unlisten function, or null outside the app. */
export async function listenForCommands(onCommand: (payload: unknown) => void): Promise<(() => void) | null> {
  if (!isNative()) return null;
  const { listen } = await import('@tauri-apps/api/event');
  return listen(CLOCK_EVENT, (e) => onCommand(e.payload));
}
