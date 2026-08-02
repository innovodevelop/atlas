/**
 * How Atlas's voice performs — the app-side half of voice tuning.
 *
 * Mirrors `services/voice-gateway/src/voiceSettings.ts`. It is duplicated
 * rather than imported because the webview and the Bun sidecar are separate
 * TypeScript projects; the gateway remains the authority and re-clamps
 * everything it receives, so a drift here can only produce slightly wrong UI,
 * never bad audio.
 *
 * WHAT THESE DO NOT DO: none of them changes pitch. ElevenLabs exposes no pitch
 * parameter, so "make it deeper" is not a slider — depth and timbre belong to
 * the VOICE. Switching voice is the only way to change how deep Atlas sounds,
 * which is why the tuner has to present voice selection and these dials as two
 * different kinds of control.
 */

export interface VoiceSettings {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  speakerBoost?: boolean;
}

/** Slider bounds, matching what the gateway will clamp to. */
export const VOICE_RANGES = {
  stability: { min: 0, max: 1, step: 0.05 },
  similarity: { min: 0, max: 1, step: 0.05 },
  style: { min: 0, max: 1, step: 0.05 },
  speed: { min: 0.7, max: 1.2, step: 0.05 },
} as const;

/** The shape useAtlasSettings stores. */
export interface TunableVoiceFields {
  voiceStability: number;
  voiceSimilarity: number;
  voiceStyle: number;
  voiceSpeed: number;
  voiceSpeakerBoost: boolean;
}

/** Settings blob → the wire shape the gateway expects. */
export function toVoiceSettings(s: Partial<TunableVoiceFields> | undefined): VoiceSettings | undefined {
  if (!s) return undefined;
  return {
    stability: s.voiceStability,
    similarityBoost: s.voiceSimilarity,
    style: s.voiceStyle,
    speed: s.voiceSpeed,
    speakerBoost: s.voiceSpeakerBoost,
  };
}

/**
 * Human-readable labels for each dial. Written for someone tuning by ear, not
 * for someone reading the ElevenLabs API reference — "steadier ↔ more varied"
 * is actionable; "stability" alone is not.
 */
export const VOICE_DIAL_COPY = {
  stability: {
    label: 'Consistency',
    low: 'More varied',
    high: 'Steadier',
    hint: 'How much Atlas varies its delivery between sentences.',
  },
  style: {
    label: 'Expressiveness',
    low: 'Plain',
    high: 'Animated',
    hint: 'How much colour Atlas puts into a line. Higher is slower to start.',
  },
  speed: {
    label: 'Pace',
    low: 'Slower',
    high: 'Faster',
    hint: 'How quickly Atlas speaks.',
  },
  similarity: {
    label: 'Fidelity',
    low: 'Looser',
    high: 'Closer',
    hint: 'How closely Atlas sticks to the original voice.',
  },
} as const;
