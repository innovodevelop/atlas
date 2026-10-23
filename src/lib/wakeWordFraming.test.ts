import { describe, expect, test } from "bun:test";
import { EmbeddingFramer, HOP, WINDOW } from "./wakeWordFraming";

/** A ramp, so every sample's position is recoverable from its value. */
function ramp(from: number, n: number): Int16Array {
  return Int16Array.from({ length: n }, (_, i) => (from + i) % 32768);
}

describe("EmbeddingFramer", () => {
  test("the first window waits for 775 ms of audio, then one per 80 ms", () => {
    const f = new EmbeddingFramer();
    // 9 hops = 11520 samples < WINDOW: nothing yet.
    expect(f.push(ramp(0, HOP * 9))).toHaveLength(0);
    // The 10th hop completes a full window.
    expect(f.push(ramp(HOP * 9, HOP))).toHaveLength(1);
    // A partial hop adds nothing; completing it adds one.
    expect(f.push(ramp(HOP * 10, 100))).toHaveLength(0);
    expect(f.push(ramp(HOP * 10 + 100, HOP - 100))).toHaveLength(1);
  });

  test("each window is the latest 12400 samples, scaled to [-1, 1]", () => {
    const f = new EmbeddingFramer();
    const windows = f.push(ramp(0, HOP * 12));
    expect(windows).toHaveLength(3);
    for (const [k, w] of windows.entries()) {
      expect(w.length).toBe(WINDOW);
      const end = HOP * (10 + k); // samples received when this window was due
      expect(w[WINDOW - 1]).toBeCloseTo((end - 1) / 32768, 8);
      expect(w[0]).toBeCloseTo((end - WINDOW) / 32768, 8);
    }
    // Consecutive windows overlap by WINDOW - HOP samples.
    expect(windows[1][0] - windows[0][0]).toBeCloseTo(HOP / 32768, 8);
  });

  test("frame boundaries don't matter, and reset starts the warm-up over", () => {
    const whole = new EmbeddingFramer().push(ramp(0, HOP * 11));
    const f = new EmbeddingFramer();
    const pieces: Float32Array[] = [];
    for (let i = 0; i < HOP * 11; i += 512) pieces.push(...f.push(ramp(i, Math.min(512, HOP * 11 - i))));
    expect(pieces).toEqual(whole);

    f.reset();
    expect(f.push(ramp(0, HOP * 9))).toHaveLength(0);
  });
});
