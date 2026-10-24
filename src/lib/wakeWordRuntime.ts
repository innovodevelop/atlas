/**
 * The wake-word inference engine — the HALF of wakeWord.ts that costs money
 * to import.
 *
 * Split from wakeWord.ts (audit finding C9): the `import * as ort` below pulls
 * the entire onnxruntime-web runtime into whatever chunk imports it, and
 * wakeWord.ts is imported by eager dashboard code (atlasHelpers →
 * getActiveWakePhrases, a pure string list). That put the ONNX runtime in the
 * main chunk, paid on every cold start whether or not voice ever initializes.
 * This module is reached ONLY via the dynamic import in wakeWord.ts's
 * `WakeWordDetector.create`, so the runtime loads when the first detector is
 * actually created — which already happens well after first paint, on mic
 * activation.
 *
 * Pipeline documentation and model provenance live in wakeWord.ts, which
 * owns the public surface. This file owns execution.
 */
// The wasm-only entry, matching the two files in public/ort. The package's
// default entry is the WebGPU build, which asks /ort/ for
// ort-wasm-simd-threaded.jsep.mjs; that file left public/ort in 50b9cab and
// every detector failed to start from then until this import changed.
import * as ort from "onnxruntime-web/wasm";
import { DEFAULT_THRESHOLD, WAKE_MODELS, _setActivePhrases, type WakeModelSpec } from "./wakeWord";
import { EmbeddingFramer, WINDOW } from "./wakeWordFraming";

const EMB_WINDOW = 16;       // embeddings per wake-model inference
const REFRACTORY_MS = 1500;  // ignore re-triggers right after a detection

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
  consecutive: number;
  score: number;
  /** Scores in a row at or above `threshold`, up to now. */
  run: number;
}

export class WakeWordDetectorImpl {
  /** Google speech_embedding: 12400-sample window → one 96-dim embedding. */
  private backbone!: ort.InferenceSession;
  private models: LoadedWakeModel[] = [];

  private framer = new EmbeddingFramer();
  private embeddings: number[][] = [];  // each [96]
  private lastFire = 0;
  private running = false;

  private constructor(public readonly onWake: (phrase: string) => void) {}

  static async create(
    onWake: (phrase: string) => void,
    opts?: { threshold?: number; modelUrl?: string },
  ): Promise<WakeWordDetectorImpl> {
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

    const d = new WakeWordDetectorImpl(onWake);
    // The backbone is mandatory — without it nothing can run.
    d.backbone = await load("/models/speech_embedding.onnx");

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
    const loaded = attempts.filter((a): a is NonNullable<typeof a> => a !== null);
    if (loaded.length === 0) throw new Error("no wake-word phrase model available under /models/");

    d.models = loaded.map((a) => ({
      session: a.session,
      phrase: a.spec.phrase,
      threshold: opts?.threshold ?? a.spec.threshold ?? DEFAULT_THRESHOLD,
      consecutive: a.spec.consecutive ?? 1,
      score: 0,
      run: 0,
    }));
    _setActivePhrases(d.models.map((m) => m.phrase));
    d.running = true;
    return d;
  }

  /** Latest wake score across all models (for debugging/level UIs). */
  score = 0;

  /** Feed a capture frame (Int16, 16 kHz mono). */
  async push(frame: Int16Array): Promise<void> {
    if (!this.running) return;
    for (const window of this.framer.push(frame)) await this.processWindow(window);
  }

  private async processWindow(window: Float32Array): Promise<void> {
    // 1) one embedding for the latest 775 ms (the model computes its own
    //    log-mel features internally).
    const out = await this.backbone.run({
      [this.backbone.inputNames[0]]: new ort.Tensor("float32", window, [1, WINDOW]),
    });
    this.embeddings.push(Array.from(out[this.backbone.outputNames[0]].data as Float32Array)); // [96]
    if (this.embeddings.length < EMB_WINDOW) return;

    // 2) wake scores over the last 16 embeddings — all models in parallel.
    const win = this.embeddings.slice(-EMB_WINDOW);
    const flatE = new Float32Array(EMB_WINDOW * 96);
    for (let i = 0; i < EMB_WINDOW; i++) flatE.set(win[i], i * 96);
    const input = new ort.Tensor("float32", flatE, [1, EMB_WINDOW, 96]);
    await Promise.all(
      this.models.map(async (m) => {
        const res = await m.session.run({ [m.session.inputNames[0]]: input });
        m.score = (res[m.session.outputNames[0]].data as Float32Array)[0];
        m.run = m.score >= m.threshold ? m.run + 1 : 0;
      }),
    );
    this.score = Math.max(...this.models.map((m) => m.score));
    if (this.embeddings.length > EMB_WINDOW * 4) this.embeddings.splice(0, EMB_WINDOW);

    const now = performance.now();
    // Same rule the training evaluation scores (hey_atlas.py, `fires`).
    const hit = this.models.find((m) => m.run >= m.consecutive);
    if (hit && now - this.lastFire > REFRACTORY_MS) {
      this.lastFire = now;
      this.onWake(hit.phrase);
    }
  }

  reset(): void {
    this.framer.reset();
    this.embeddings = [];
    this.score = 0;
    for (const m of this.models) {
      m.score = 0;
      m.run = 0;
    }
  }

  destroy(): void {
    this.running = false;
    this.reset();
    // Release the ONNX sessions (audit finding C3): onnxruntime-web holds the
    // model's WASM memory until release() — destroy() without it leaked every
    // session's allocation each time the detector was retired (which the
    // capture path does on any inference failure, up to once per session
    // cycle). Fire-and-forget with individual catches: destroy() is called
    // from synchronous teardown, and one failed release must not strand the
    // rest.
    const release = (s: ort.InferenceSession | undefined) => {
      void s?.release().catch(() => {
        /* session already dead — the memory is gone either way */
      });
    };
    release(this.backbone);
    for (const m of this.models) release(m.session);
    this.models = [];
  }
}
