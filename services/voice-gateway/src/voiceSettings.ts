/**
 * User-tunable voice settings, and the one place that knows ElevenLabs' ranges.
 *
 * These four numbers used to be a hard-coded literal inside the TTS request, so
 * nothing the user did could change how Atlas sounded. They now travel from the
 * app (persisted in useAtlasSettings) through the `hello` message or the /tts
 * body, and land here to be validated.
 *
 * IMPORTANT — there is no pitch parameter. ElevenLabs does not expose one, so
 * "make it deeper" cannot be a slider: timbre comes from choosing a different
 * VOICE. What these control is how that voice performs:
 *
 *   stability       consistency of delivery. Low = more variation and emotion,
 *                   high = flatter and more predictable.
 *   similarityBoost how closely to adhere to the original voice recording.
 *   style           expressiveness / exaggeration. Costs latency above 0.
 *   speed           pace of speech. 1.0 is the voice's natural rate.
 *   speakerBoost    slight clarity/presence boost. Costs a little latency.
 *
 * Everything is optional and clamped rather than rejected: a client sending a
 * nonsense value gets sane audio instead of a failed turn, and an older client
 * that sends nothing at all keeps exactly today's behaviour.
 */

export interface VoiceSettings {
  /** 0–1 */
  stability?: number;
  /** 0–1 */
  similarityBoost?: number;
  /** 0–1 */
  style?: number;
  /** 0.7–1.2 */
  speed?: number;
  speakerBoost?: boolean;
}

/** The values shipped before any of this was tunable. Changing them changes
 *  how Atlas sounds for every user who has not chosen otherwise. */
export const DEFAULT_VOICE_SETTINGS: Required<VoiceSettings> = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0.3,
  speed: 1.0,
  speakerBoost: true,
};

const RANGES = {
  stability: [0, 1],
  similarityBoost: [0, 1],
  style: [0, 1],
  speed: [0.7, 1.2],
} as const;

function clamp(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Validate and fill in a partial settings object from an untrusted client. */
export function resolveVoiceSettings(input?: VoiceSettings | null): Required<VoiceSettings> {
  const d = DEFAULT_VOICE_SETTINGS;
  if (!input || typeof input !== "object") return { ...d };
  return {
    stability: clamp(input.stability, ...RANGES.stability, d.stability),
    similarityBoost: clamp(input.similarityBoost, ...RANGES.similarityBoost, d.similarityBoost),
    style: clamp(input.style, ...RANGES.style, d.style),
    speed: clamp(input.speed, ...RANGES.speed, d.speed),
    speakerBoost: typeof input.speakerBoost === "boolean" ? input.speakerBoost : d.speakerBoost,
  };
}

/** Convert to ElevenLabs' snake_case wire shape. */
export function toElevenLabsVoiceSettings(input?: VoiceSettings | null): Record<string, number | boolean> {
  const s = resolveVoiceSettings(input);
  return {
    stability: s.stability,
    similarity_boost: s.similarityBoost,
    style: s.style,
    speed: s.speed,
    use_speaker_boost: s.speakerBoost,
  };
}
