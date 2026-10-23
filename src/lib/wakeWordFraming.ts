/**
 * Audio framing for the wake-word backbone — pure, so it can be tested
 * without onnxruntime-web (wakeWordRuntime.ts owns execution).
 *
 * Google's speech_embedding model (public/models/speech_embedding.onnx) turns
 * one 12400-sample window (775 ms at 16 kHz) into one 96-dim embedding, and
 * openWakeWord's phrase models expect one embedding per 1280 samples (80 ms).
 * So: keep the last WINDOW samples, and every HOP new samples hand out that
 * window, scaled from Int16 to [-1, 1] as the model expects.
 *
 * Sliding the window by whole hops reproduces the model's own full-length
 * output (checked in scripts/wakeword-backbone/convert.py), which is what
 * makes streaming one window at a time faithful.
 */

export const WINDOW = 12400;
export const HOP = 1280;

export class EmbeddingFramer {
  /** The last WINDOW samples, oldest first. */
  private ring = new Float32Array(WINDOW);
  /** Samples of the hop being collected. */
  private hop = new Float32Array(HOP);
  private hopFill = 0;
  /** Real samples in `ring` (it starts as silence). */
  private filled = 0;

  /**
   * Feed captured Int16 PCM; returns the windows that became due, oldest
   * first (zero or one per 80 ms of audio). Each is a fresh copy.
   */
  push(frame: Int16Array): Float32Array[] {
    const due: Float32Array[] = [];
    for (let i = 0; i < frame.length; i++) {
      this.hop[this.hopFill++] = frame[i] / 32768;
      if (this.hopFill < HOP) continue;
      this.hopFill = 0;
      this.ring.copyWithin(0, HOP);
      this.ring.set(this.hop, WINDOW - HOP);
      this.filled = Math.min(WINDOW, this.filled + HOP);
      // The first window needs a full 775 ms of audio; after that, one per hop.
      if (this.filled === WINDOW) due.push(this.ring.slice());
    }
    return due;
  }

  reset(): void {
    this.ring.fill(0);
    this.hopFill = 0;
    this.filled = 0;
  }
}
