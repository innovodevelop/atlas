/**
 * Voice activity detection over the inbound 16 kHz mono Int16 stream.
 *
 * Primary engine: Silero VAD (ONNX, via onnxruntime-node) — the real deal,
 * robust to noise, runs CONTINUOUSLY including during TTS playback (that is
 * what barge-in is). Fallback engine: RMS energy thresholding, auto-selected
 * if the ONNX runtime or model fails to load (e.g. N-API quirk under Bun),
 * so the gateway always boots. The active engine is reported at startup.
 *
 * Model file: models/silero_vad.onnx — fetched by `bun run fetch-models`.
 *
 * Silero expects 512-sample frames at 16 kHz (32 ms). We re-frame the ~20 ms
 * wire frames internally.
 */

export interface VadEvents {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

export interface VadEngine {
  readonly name: string;
  /** Feed PCM; emits events via the constructor callbacks. */
  process(frame: Int16Array): Promise<void>;
  /** Reset internal state (start of a new turn). */
  reset(): void;
  /**
   * Free whatever the engine allocated. Sessions are created per WebSocket
   * connection and each carries its own VAD (session.ts:82); without a
   * release, every disconnect leaked a live ONNX inference session — and the
   * webview's reconnect bug (audit C1) manufactured disconnects by the dozen,
   * so the two leaks compounded (audit finding C4). Must be safe to call on a
   * half-initialized or already-released engine.
   */
  release(): void;
}

const SILERO_FRAME = 512; // samples @16k
const SPEECH_THRESHOLD = 0.5;
const SILENCE_THRESHOLD = 0.35;
/** Endpointing: constant to start; adaptive tuning is future work (ADR 001). */
export const TRAILING_SILENCE_MS = 700;
/** Debounce: require this much continuous speech before speech-start fires. */
const MIN_SPEECH_MS = 96; // 3 silero frames

abstract class BaseVad implements VadEngine {
  abstract readonly name: string;
  protected speaking = false;
  protected speechMs = 0;
  protected silenceMs = 0;

  constructor(protected events: VadEvents) {}

  abstract scoreFrame(frame: Float32Array): Promise<number>;

  private pending: number[] = [];

  async process(frame: Int16Array): Promise<void> {
    // Accumulate into 512-sample silero frames.
    for (let i = 0; i < frame.length; i++) this.pending.push(frame[i] / 32768);
    while (this.pending.length >= SILERO_FRAME) {
      const chunk = new Float32Array(this.pending.slice(0, SILERO_FRAME));
      this.pending = this.pending.slice(SILERO_FRAME);
      const score = await this.scoreFrame(chunk);
      this.update(score, (SILERO_FRAME / 16000) * 1000);
    }
  }

  private update(score: number, frameMs: number) {
    if (score >= SPEECH_THRESHOLD) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
      if (!this.speaking && this.speechMs >= MIN_SPEECH_MS) {
        this.speaking = true;
        this.events.onSpeechStart();
      }
    } else if (score < SILENCE_THRESHOLD) {
      this.silenceMs += frameMs;
      if (this.speaking && this.silenceMs >= TRAILING_SILENCE_MS) {
        this.speaking = false;
        this.speechMs = 0;
        this.events.onSpeechEnd();
      } else if (!this.speaking) {
        this.speechMs = 0;
      }
    }
  }

  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.pending = [];
  }

  /** Engines that allocate nothing (energy) inherit this no-op. */
  release(): void {}
}

/**
 * Silero VAD v5 (stateful LSTM model) over either ONNX Runtime backend —
 * the node (native) and web (WASM) packages expose the same Tensor/run API.
 */
class SileroVad extends BaseVad {
  readonly name: string;
  private session: any;
  private state: any;
  private sr: any;
  private ort: any;

  private constructor(events: VadEvents, name: string, ort: any, session: any) {
    super(events);
    this.name = name;
    this.ort = ort;
    this.session = session;
    this.state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
  }

  /** Native backend (onnxruntime-node) — fastest, but needs its dylib. */
  static async createNative(events: VadEvents, model: string | Uint8Array): Promise<SileroVad> {
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(model as any, {
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
    return new SileroVad(events, "silero", ort, session);
  }

  /**
   * WASM backend (onnxruntime-web) — no native libraries, survives
   * `bun build --compile`. ~100x realtime for Silero: plenty.
   */
  static async createWasm(
    events: VadEvents,
    modelBytes: Uint8Array,
    wasmDir?: string,
  ): Promise<SileroVad> {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    if (wasmDir) {
      // Compiled binary: extracted embedded runtime under canonical names.
      ort.env.wasm.wasmPaths = wasmDir.endsWith("/") ? wasmDir : `${wasmDir}/`;
    }
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
    });
    return new SileroVad(events, "silero-wasm", ort, session);
  }

  async scoreFrame(frame: Float32Array): Promise<number> {
    // A frame already in flight when release() ran lands here with no
    // session. Silence (score 0) is the right answer for a dying connection —
    // throwing would surface as an unhandled rejection in the WS handler.
    if (!this.session) return 0;
    const input = new this.ort.Tensor("float32", frame, [1, frame.length]);
    const out = await this.session.run({ input, state: this.state, sr: this.sr });
    this.state = out.stateN ?? out.state ?? this.state;
    const prob = out.output?.data?.[0];
    return typeof prob === "number" ? prob : 0;
  }

  reset(): void {
    super.reset();
    this.state = new this.ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  }

  release(): void {
    // Both ORT backends (node and web) expose release() on the session; both
    // return a promise. Fire-and-forget with a catch: release runs from
    // synchronous teardown, and a failed release means the session is dead
    // anyway. Null the reference so a late scoreFrame from an in-flight
    // process() rejects loudly instead of running on a freed session.
    const s = this.session;
    this.session = null;
    void s?.release?.().catch?.(() => {
      /* already dead */
    });
  }
}

/** RMS-energy fallback — crude but keeps the loop functional. */
class EnergyVad extends BaseVad {
  readonly name = "energy";
  private noiseFloor = 0.008;

  async scoreFrame(frame: Float32Array): Promise<number> {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    // Slowly track the noise floor while quiet.
    if (rms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
    }
    return rms > Math.max(0.015, this.noiseFloor * 3) ? 1 : 0;
  }
}

export interface VadAssets {
  /** Model as path (dev) or bytes (compiled). */
  model: string | Uint8Array;
  /** Dir holding the ORT wasm runtime under canonical names (compiled). */
  ortWasmDir?: string;
}

/** Tiered engine selection: native → WASM → energy. Always returns something. */
export async function createVad(events: VadEvents, assets: VadAssets): Promise<VadEngine> {
  try {
    const vad = await SileroVad.createNative(events, assets.model);
    console.log("[vad] Silero VAD loaded (native)");
    return vad;
  } catch (e) {
    console.warn(`[vad] native ORT unavailable (${(e as Error).message}) — trying WASM`);
  }
  try {
    const modelBytes = typeof assets.model === "string"
      ? new Uint8Array(await Bun.file(assets.model).arrayBuffer())
      : assets.model;
    const vad = await SileroVad.createWasm(events, modelBytes, assets.ortWasmDir);
    console.log("[vad] Silero VAD loaded (wasm)");
    return vad;
  } catch (e) {
    console.warn(`[vad] WASM ORT unavailable (${(e as Error).message}) — falling back to energy VAD`);
    return new EnergyVad(events);
  }
}
