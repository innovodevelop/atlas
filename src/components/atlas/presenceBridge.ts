/**
 * Bridge from the 8-state Atlas presence onto the 6 states the WebGL sphere
 * can actually render.
 *
 * This exists only while both renderers are mounted. The canvas renderer
 * (src/lib/atlasSphere.ts) implements all ten states natively with their own
 * tints and motion; the older three.js sphere predates that contract and has
 * no red, no torus migration and no peel-off. When the canvas/WebGL decision is
 * made (docs/design-sync/2026-07-26-audit-sphere-mail-header.md §P0-1) one of
 * these two paths disappears and this file goes with it.
 *
 * Two of the mappings are a genuine improvement rather than a compromise:
 * `dormant` (morph 0.2, intensity 0.1 — barely alive) and `activated`
 * (morph 1.0, intensity 0.8 — a bright flare) both had full visual configs in
 * stateConfigs.ts and were never assigned by any code path. They were dead
 * visuals; muted and success give them a reason to exist.
 *
 * KNOWN LOSS, stated rather than hidden: `success` and `alert` both land on
 * `activated`, because the WebGL palette has no red and nothing else reads as
 * urgent. On this renderer the two are distinguished only by the text label
 * beside the sphere. That is the single strongest argument in favour of the
 * canvas renderer, which tints alert `208,69,58` and pulses it.
 */
import type { WakeWordState } from '@/types';
import type { AtlasPresenceState } from '@/hooks/useAtlasPresence';

const MAP: Record<AtlasPresenceState, WakeWordState> = {
  idle: 'passive',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  // Sustained processing, cool and busy — the closest honest match.
  working: 'thinking',
  // A bright flare. Shares its visual with `alert`; see the note above.
  success: 'activated',
  alert: 'activated',
  // Barely-there motion and the lowest intensity in the set.
  muted: 'dormant',
};

export function presenceToWebGL(state: AtlasPresenceState): WakeWordState {
  return MAP[state];
}

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

/**
 * Text for the state chip. Unlike the visual, this can express all eight
 * truthfully — which is why `alert` and `success` are still distinguishable on
 * the WebGL renderer.
 */
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
