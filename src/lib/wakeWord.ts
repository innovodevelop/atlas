/**
 * On-device wake word (WS-B B2) — openWakeWord-style pipeline over
 * onnxruntime-web.
 *
 * Chained ONNX stages (served from /models):
 *   speech_embedding.onnx  latest 12400 samples (775 ms), every 1280 (80 ms)
 *                          → 96-dim embedding. Google's speech_embedding,
 *                          Apache-2.0, converted by scripts/wakeword-backbone/.
 *                          It replaced openWakeWord's melspectrogram +
 *                          embedding_model pair (CC BY-NC-SA) with no
 *                          retraining: same features, same phrase models.
 *   hey_atlas.onnx         last 16 embeddings → "Hey Atlas" probability.
 *                          Atlas's own model, trained on permissively licensed
 *                          data by scripts/train-wakeword/hey_atlas.py.
 *
 * The phrase stage scores every loaded model in parallel per frame and wakes
 * when ANY crosses its threshold. A WAKE_MODELS entry whose file is missing or
 * invalid is skipped without error, so a new phrase is one entry plus its
 * .onnx in public/models/. The stock "Hey Jarvis" model that stood in before
 * hey_atlas.onnx was trained is gone: it is CC BY-NC-SA — ADR 002.
 *
 * Everything runs client-side: pre-wake audio never leaves the process, which
 * is both the latency and the GDPR story.
 *
 * ── THE SPLIT ───────────────────────────────────────────────────────────────
 * This module is the EAGER half and must stay free of onnxruntime-web. It is
 * imported by dashboard-path code (atlasHelpers → getActiveWakePhrases, a pure
 * string list), and when it carried `import * as ort` the entire ONNX runtime
 * rode the main chunk on every cold start, voice or not (audit finding C9).
 * The inference engine lives in wakeWordRuntime.ts, reached only through the
 * dynamic import in `WakeWordDetector.create` below — the runtime chunk loads
 * when a detector is actually created, which happens after first paint on mic
 * activation. Adding a static import of wakeWordRuntime (or of
 * onnxruntime-web) to THIS file undoes the split silently; don't.
 */

export const DEFAULT_THRESHOLD = 0.5;

export interface WakeModelSpec {
  file: string;
  phrase: string;
  /** Per-model trigger threshold (defaults to DEFAULT_THRESHOLD). */
  threshold?: number;
  /**
   * Scores in a row (80 ms apart) that must reach the threshold before waking;
   * defaults to 1. A real "Hey Atlas" holds a high score for several hops,
   * while most false wakes are a single-hop spike.
   */
  consecutive?: number;
}

/**
 * The phrase models Atlas ships, tried at init. Threshold and `consecutive`
 * come from the held-out evaluation in scripts/train-wakeword/README.md
 * (91% recall, one false wake in 21 h of speech); retune them against that
 * table, not by feel.
 */
export const WAKE_MODELS: WakeModelSpec[] = [
  { file: "/models/hey_atlas.onnx", phrase: "Hey Atlas", threshold: 0.5, consecutive: 2 },
];

// Last-known active set. Starts at everything that ships and is corrected as
// soon as a detector finishes loading (a model that failed to load drops out).
let activePhrases: string[] = WAKE_MODELS.map((m) => m.phrase);

/**
 * Phrases the detector actually listens for. Every shipped phrase until a
 * detector has been created; the real loaded set afterwards. UI labels should
 * derive from this instead of hardcoding a phrase.
 */
export function getActiveWakePhrases(): string[] {
  return [...activePhrases];
}

/** Internal: the runtime reports the loaded set here. Not for UI use. */
export function _setActivePhrases(phrases: string[]): void {
  activePhrases = [...phrases];
}

/**
 * The detector's public identity. The type is the runtime class (type-only
 * import — erased at build time, pulls no code); the value is a factory that
 * loads the runtime chunk on first use. Callers keep writing
 * `WakeWordDetector.create(...)` and `useRef<WakeWordDetector | null>` exactly
 * as before the split.
 */
export type WakeWordDetector = import("./wakeWordRuntime").WakeWordDetectorImpl;

export const WakeWordDetector = {
  async create(
    onWake: (phrase: string) => void,
    opts?: { threshold?: number; modelUrl?: string },
  ): Promise<WakeWordDetector> {
    const runtime = await import("./wakeWordRuntime");
    return runtime.WakeWordDetectorImpl.create(onWake, opts);
  },
};
