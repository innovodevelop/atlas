/**
 * On-device wake word (WS-B B2) — openWakeWord pipeline over onnxruntime-web.
 *
 * Chained ONNX stages (served from /models, MIT/Apache):
 *   melspectrogram.onnx  raw 16 kHz PCM chunk → mel frames [1,1,T,32]
 *   embedding_model.onnx sliding window of 76 mel frames → 96-dim embedding
 *   <phrase>.onnx        last 16 embeddings → wake probability
 *
 * The phrase stage scores every loaded model in parallel per frame and wakes
 * when ANY crosses its threshold. All WAKE_MODELS candidates are attempted at
 * init; files that are missing or invalid are skipped without error, so
 * dropping trained hey_atlas.onnx / atlas.onnx into public/models/ activates
 * them with zero code changes (scripts/train-wakeword/ packages the training).
 * Stock "Hey Jarvis" is a fallback, not a roommate: the moment any
 * Atlas-branded model loads, jarvis is dropped from the active set so the app
 * never triggers on a phrase the UI no longer advertises — ADR 002.
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
  /** Fallback entries are dropped when any non-fallback model loads. */
  fallback?: boolean;
}

/**
 * Candidate phrase models, tried in order at init. Only hey_jarvis ships
 * today; the two Atlas models activate automatically once trained copies land
 * in public/models/ (see scripts/train-wakeword/README.md).
 */
export const WAKE_MODELS: WakeModelSpec[] = [
  { file: "/models/hey_atlas.onnx", phrase: "Hey Atlas" },
  { file: "/models/atlas.onnx", phrase: "Atlas" },
  { file: "/models/hey_jarvis_v0.1.onnx", phrase: "Hey Jarvis", fallback: true },
];

const FALLBACK_PHRASES = WAKE_MODELS.filter((m) => m.fallback).map((m) => m.phrase);

// Last-known active set. Starts at the fallback (the only model guaranteed to
// ship today) and is corrected as soon as a detector finishes loading.
let activePhrases: string[] = [...FALLBACK_PHRASES];

/**
 * Phrases the detector actually listens for. Fallback phrase(s) until a
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
