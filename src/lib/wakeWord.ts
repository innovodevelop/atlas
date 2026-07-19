/**
 * On-device wake word (WS-B B2) — openWakeWord pipeline over onnxruntime-web.
 *
 * Three chained ONNX models (served from /models, ~3.7 MB total, MIT/Apache):
 *   melspectrogram.onnx  raw 16 kHz PCM chunk → mel frames [1,1,T,32]
 *   embedding_model.onnx sliding window of 76 mel frames → 96-dim embedding
 *   hey_jarvis_v0.1.onnx last 16 embeddings → wake probability
 *
 * Stock "hey jarvis" model is the placeholder until a custom "Hey Atlas"
 * model is trained (openWakeWord supports custom phrases) — ADR 002.
 *
 * Everything runs client-side: pre-wake audio never leaves the process, which
 * is both the latency and the GDPR story. The detector consumes the same
 * 20 ms Int16 frames the capture worklet produces; internally it re-chunks to
 * openWakeWord's 1280-sample (80 ms) hop.
 */
import * as ort from "onnxruntime-web";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = "/ort/";

const CHUNK = 1280;          // 80 ms @ 16 kHz — openWakeWord's native hop
const MEL_WINDOW = 76;       // mel frames per embedding
const MEL_HOP = 8;           // mel frames advanced per embedding
const EMB_WINDOW = 16;       // embeddings per wake-model inference
const DEFAULT_THRESHOLD = 0.5;
const REFRACTORY_MS = 1500;  // ignore re-triggers right after a detection

export class WakeWordDetector {
  private mel!: ort.InferenceSession;
  private emb!: ort.InferenceSession;
  private wake!: ort.InferenceSession;

  private raw: number[] = [];
  private melFrames: number[][] = [];   // each [32]
  private embeddings: number[][] = [];  // each [96]
  private lastFire = 0;
  private running = false;

  private constructor(
    private threshold: number,
    public readonly onWake: () => void,
  ) {}

  static async create(onWake: () => void, opts?: { threshold?: number; modelUrl?: string }): Promise<WakeWordDetector> {
    const d = new WakeWordDetector(opts?.threshold ?? DEFAULT_THRESHOLD, onWake);
    const load = (url: string) =>
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${url}: ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ["wasm"] }));
    [d.mel, d.emb, d.wake] = await Promise.all([
      load("/models/melspectrogram.onnx"),
      load("/models/embedding_model.onnx"),
      load(opts?.modelUrl ?? "/models/hey_jarvis_v0.1.onnx"),
    ]);
    d.running = true;
    return d;
  }

  /** Latest wake score (for debugging/level UIs). */
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

      // 3) wake score over the last 16 embeddings.
      if (this.embeddings.length >= EMB_WINDOW) {
        const win = this.embeddings.slice(-EMB_WINDOW);
        const flatE = new Float32Array(EMB_WINDOW * 96);
        for (let i = 0; i < EMB_WINDOW; i++) flatE.set(win[i], i * 96);
        const wakeOut = await this.wake.run({
          [this.wake.inputNames[0]]: new ort.Tensor("float32", flatE, [1, EMB_WINDOW, 96]),
        });
        this.score = (wakeOut[this.wake.outputNames[0]].data as Float32Array)[0];
        if (this.embeddings.length > EMB_WINDOW * 4) this.embeddings.splice(0, EMB_WINDOW);

        const now = performance.now();
        if (this.score >= this.threshold && now - this.lastFire > REFRACTORY_MS) {
          this.lastFire = now;
          this.onWake();
        }
      }
    }
  }

  reset(): void {
    this.raw = [];
    this.melFrames = [];
    this.embeddings = [];
    this.score = 0;
  }

  destroy(): void {
    this.running = false;
    this.reset();
  }
}
