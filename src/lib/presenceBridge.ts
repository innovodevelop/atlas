/**
 * Presence-state helpers for the chrome around the sphere.
 *
 * The file is called a "bridge" for historical reasons: it used to hold
 * `presenceToWebGL`, which folded the eight presence states onto the six the
 * three.js sphere could draw, collapsing `success` and `alert` onto one visual
 * so a failed agent run looked exactly like a finished one. That renderer is
 * deleted; the canvas renderer implements all ten states natively and
 * `AtlasPresenceState` is a strict subset of its `SphereState`, so the mapping
 * function had nothing left to do and went with it.
 *
 * What remains has no renderer coupling at all: the dock's voice indicator and
 * the band's state chip. Kept in `src/lib/` for that reason.
 */
import type { AtlasPresenceState } from '@/hooks/useAtlasPresence';

/**
 * Is the microphone genuinely hot right now?
 *
 * This is the single predicate behind the app's one non-blue accent. Atlas Blue
 * is the interactive colour — buttons, links, active tabs, progress — so if
 * "Atlas is listening to you" were also blue it would read as chrome. The
 * secondary accent `--acc2` (#ff6a00) exists for exactly this state and appears
 * nowhere else in the stylesheet.
 *
 * `thinking` and `working` are deliberately excluded: they are Atlas processing,
 * not Atlas capturing audio, and an indicator that is lit most of the time
 * tells the user nothing. `muted` is excluded for the obvious reason.
 */
export function isVoiceActive(state: AtlasPresenceState): boolean {
  return state === 'listening' || state === 'speaking';
}

/** Text for the state chip. */
export function presenceLabel(state: AtlasPresenceState, wakePhrases: string[]): string {
  switch (state) {
    case 'listening': return 'Listening…';
    case 'thinking': return 'Thinking…';
    case 'speaking': return 'Speaking…';
    case 'working': return 'Working on a task…';
    case 'success': return 'Task finished';
    case 'alert': return 'Something went wrong';
    case 'muted': return 'Microphone off';
    default:
      return wakePhrases.length === 0
        ? 'Listening…'
        : `Listening for ${wakePhrases.map((p) => `"${p}"`).join(' or ')}`;
  }
}
