// Smoke: does Silero VAD load and score under Bun (N-API)? Falls back to
// energy VAD if not — the engine name printed is the result.
import { createVad } from "../src/vad.ts";
import { fileURLToPath } from "node:url";
let starts = 0, ends = 0;
const vad = await createVad(
  { onSpeechStart: () => { starts++; }, onSpeechEnd: () => { ends++; } },
  fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url)),
);
console.log("engine:", vad.name);
const frame = (fill: (i: number) => number) => Int16Array.from({ length: 320 }, (_, i) => fill(i));
const t0 = performance.now();
for (let f = 0; f < 50; f++) await vad.process(frame(() => 0));
for (let f = 0; f < 50; f++) await vad.process(frame((i) => Math.round(12000 * Math.sin(i * 0.35) * (0.6 + 0.4 * Math.random()))));
for (let f = 0; f < 60; f++) await vad.process(frame(() => 0));
const ms = performance.now() - t0;
console.log(`processed 3.2s of audio in ${ms.toFixed(0)}ms (${(3200 / ms).toFixed(1)}x realtime)`);
console.log("speechStarts:", starts, "speechEnds:", ends);
