/**
 * Whether Atlas says its Entry lines out loud — the Beta sign-in and
 * onboarding's "Voice on / Voice off" pill (`Atlas Entry Beta.dc.html`).
 *
 * OFF BY DEFAULT, and a separate key from the Workshop's `atlas-auth-voice`
 * (voicePreference.ts, default on). The greeting read out loud was the most
 * complained-about thing on the old Entry — a laptop announcing "And your
 * password?" in a quiet room — so the Beta stays silent until someone asks it
 * to speak, and remembers that they did. The Workshop keeps its own default;
 * one choice does not silently flip the other.
 *
 * Remembered in localStorage because these screens run before there is an
 * account to hang a setting on. The value is a preference, never a secret.
 */

export const ENTRY_VOICE_KEY = 'atlas:entry_voice';

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function store(): KV | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readEntryVoice(kv: KV | null = store()): boolean {
  try { return kv?.getItem(ENTRY_VOICE_KEY) === 'on'; } catch { return false; }
}

export function writeEntryVoice(on: boolean, kv: KV | null = store()): void {
  try { kv?.setItem(ENTRY_VOICE_KEY, on ? 'on' : 'off'); } catch { /* holds for this session only */ }
}

/**
 * How long after the last sound a transcript is still treated as Atlas's own
 * voice coming back through the microphone (the Workshop's ECHO_TAIL_MS):
 * the lag between the last audio frame and the transcriber committing the
 * sentence it built from it.
 */
export const ECHO_TAIL_MS = 700;

/** Whether a transcript arriving now could be Atlas hearing itself. */
export function mayBeEcho(playing: boolean, quietSince: number, now: number = Date.now()): boolean {
  return playing || now - quietSince < ECHO_TAIL_MS;
}

/** The pill's words, from the design. */
export function voicePillCopy(on: boolean): { label: string; aria: string; title: string } {
  return on
    ? {
        label: 'Voice on',
        aria: 'Turn Atlas’s voice off',
        title: 'Atlas is speaking. Click to silence. Its lines are voiced by ElevenLabs, so their text leaves this Mac — never what you type.',
      }
    : {
        label: 'Voice off',
        aria: 'Turn Atlas’s voice on',
        title: 'Atlas is silent. Click to hear it. Its lines would be voiced by ElevenLabs, so their text would leave this Mac — never what you type.',
      };
}
