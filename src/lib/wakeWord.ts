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
 * is both the latency and the GDPR story. The detector consumes the same
 * 20 ms Int16 frames the capture worklet produces; internally it re-chunks to
 * openWakeWord's 1280-sample (80 ms) hop.
 *
 * This module has no side effects at import time (ORT env config happens
 * lazily in create()) — pure modules like atlasHelpers import
 * getActiveWakePhrases() from here.
 */
import * as ort from "onnxruntime-web";

const CHUNK = 1280;          // 80 ms @ 16 kHz — openWakeWord's native hop
const MEL_WINDOW = 76;       // mel frames per embedding
const MEL_HOP = 8;           // mel frames advanced per embedding
const EMB_WINDOW = 16;       // embeddings per wake-model inference
const DEFAULT_THRESHOLD = 0.5;
const REFRACTORY_MS = 1500;  // ignore re-triggers right after a detection

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

let ortConfigured = false;
function configureOrt(): void {
  if (ortConfigured) return;
  ortConfigured = true;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "/ort/";
}

interface LoadedWakeModel {
  session: ort.InferenceSession;
  phrase: string;
  threshold: number;
  score: number;
}

export class WakeWordDetector {
  private mel!: ort.InferenceSession;
  private emb!: ort.InferenceSession;
  private models: LoadedWakeModel[] = [];

  private raw: number[] = [];
  private melFrames: number[][] = [];   // each [32]
  private embeddings: number[][] = [];  // each [96]
  private lastFire = 0;
  private running = false;

  private constructor(public readonly onWake: (phrase: string) => void) {}

  static async create(
    onWake: (phrase: string) => void,
    opts?: { threshold?: number; modelUrl?: string },
  ): Promise<WakeWordDetector> {
    configureOrt();
    const load = async (url: string): Promise<ort.InferenceSession> => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      const buf = await r.arrayBuffer();
      // A missing model behind an SPA fallback comes back 200 text/html;
      // session creation rejects it as invalid ONNX, so every failure mode
      // (network reject, 404, HTML-as-200, bad model) ends up in the caller's
      // catch below.
      return ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ["wasm"] });
    };

    const d = new WakeWordDetector(onWake);
    // Feature models are mandatory — without them nothing can run.
    [d.mel, d.emb] = await Promise.all([
      load("/models/melspectrogram.onnx"),
      load("/models/embedding_model.onnx"),
    ]);

    // Phrase models are best-effort: try every candidate, skip the missing.
    const specs: WakeModelSpec[] = opts?.modelUrl
      ? [WAKE_MODELS.find((m) => m.file === opts.modelUrl) ?? { file: opts.modelUrl, phrase: "custom" }]
      : WAKE_MODELS;
    const attempts = await Promise.all(
      specs.map(async (spec) => {
        try {
          return { spec, session: await load(spec.file) };
        } catch {
          return null; // model not shipped (yet) — skipped, not an error
        }
      }),
    );
    let loaded = attempts.filter((a): a is NonNullable<typeof a> => a !== null);
    // Drop the fallback once any Atlas-branded model is live — keeping jarvis
    // active alongside would trigger on a phrase the UI no longer advertises.
    if (loaded.some((a) => !a.spec.fallback)) loaded = loaded.filter((a) => !a.spec.fallback);
    if (loaded.length === 0) throw new Error("no wake-word phrase model available under /models/");

    d.models = loaded.map((a) => ({
      session: a.session,
      phrase: a.spec.phrase,
      threshold: opts?.threshold ?? a.spec.threshold ?? DEFAULT_THRESHOLD,
      score: 0,
    }));
    activePhrases = d.models.map((m) => m.phrase);
    d.running = true;
    return d;
  }

  /** Latest wake score across all models (for debugging/level UIs). */
  score = 0;

  /** Feed a capture frame (Int16, 16 kHz mono). */
  async push(frame: Int16Array): Promise<void> {
    if (!this.running) return;
    for (let i = 0; i < frame.length; i++) this.raw.push(frame[i]);
    while (this.raw.length >= CHUNK) {
      const chunk = new Float32Array(this.raw.splice(0, CHUNK));
      await this.processChunk(chunk);
    }
  }

  private async processChunk(chunk: Float32Array): Promise<void> {
    // 1) mel spectrogram. openWakeWord's model expects raw int16-range floats.
    const melOut = await this.mel.run({
      [this.mel.inputNames[0]]: new ort.Tensor("float32", chunk, [1, CHUNK]),
    });
    const melTensor = melOut[this.mel.outputNames[0]];
    const md = melTensor.data as Float32Array;
    const frames = melTensor.dims[2] as number; // [1,1,T,32]
    for (let f = 0; f < frames; f++) {
      const row = new Array<number>(32);
      for (let m = 0; m < 32; m++) row[m] = md[f * 32 + m] / 10 + 2; // oww scaling
      this.melFrames.push(row);
    }

    // 2) embeddings over a sliding 76-frame window, hop 8.
    while (this.melFrames.length >= MEL_WINDOW) {
      const windowFrames = this.melFrames.slice(0, MEL_WINDOW);
      const flat = new Float32Array(MEL_WINDOW * 32);
      for (let f = 0; f < MEL_WINDOW; f++) flat.set(windowFrames[f], f * 32);
      const embOut = await this.emb.run({
        [this.emb.inputNames[0]]: new ort.Tensor("float32", flat, [1, MEL_WINDOW, 32, 1]),
      });
      const e = embOut[this.emb.outputNames[0]].data as Float32Array;
      this.embeddings.push(Array.from(e)); // [96]
      this.melFrames.splice(0, MEL_HOP);

      // 3) wake scores over the last 16 embeddings — all models in parallel.
      if (this.embeddings.length >= EMB_WINDOW) {
        const win = this.embeddings.slice(-EMB_WINDOW);
        const flatE = new Float32Array(EMB_WINDOW * 96);
        for (let i = 0; i < EMB_WINDOW; i++) flatE.set(win[i], i * 96);
        const input = new ort.Tensor("float32", flatE, [1, EMB_WINDOW, 96]);
        await Promise.all(
          this.models.map(async (m) => {
            const out = await m.session.run({ [m.session.inputNames[0]]: input });
            m.score = (out[m.session.outputNames[0]].data as Float32Array)[0];
          }),
        );
        this.score = Math.max(...this.models.map((m) => m.score));
        if (this.embeddings.length > EMB_WINDOW * 4) this.embeddings.splice(0, EMB_WINDOW);

        const now = performance.now();
        const hit = this.models.find((m) => m.score >= m.threshold);
        if (hit && now - this.lastFire > REFRACTORY_MS) {
          this.lastFire = now;
          this.onWake(hit.phrase);
        }
      }
    }
  }

  reset(): void {
    this.raw = [];
    this.melFrames = [];
    this.embeddings = [];
    this.score = 0;
    for (const m of this.models) m.score = 0;
  }

  destroy(): void {
    this.running = false;
    this.reset();
  }
}
