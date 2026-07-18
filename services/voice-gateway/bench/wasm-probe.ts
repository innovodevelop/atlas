// Probe: does onnxruntime-web (pure WASM) run Silero under Bun?
import * as ort from "onnxruntime-web";
import { fileURLToPath } from "node:url";

ort.env.wasm.numThreads = 1;

const modelPath = fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url));
const modelBytes = new Uint8Array(await Bun.file(modelPath).arrayBuffer());

const t0 = performance.now();
const session = await ort.InferenceSession.create(modelBytes, {
  executionProviders: ["wasm"],
});
console.log(`session created in ${(performance.now() - t0).toFixed(0)}ms; inputs:`, session.inputNames, "outputs:", session.outputNames);

let state: any = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
const frame = new Float32Array(512).map(() => (Math.random() - 0.5) * 0.01);

const t1 = performance.now();
let prob = 0;
for (let i = 0; i < 100; i++) {
  const out = await session.run({ input: new ort.Tensor("float32", frame, [1, 512]), state, sr });
  state = out.stateN ?? out.state;
  prob = (out.output!.data as Float32Array)[0];
}
const ms = performance.now() - t1;
console.log(`100 frames (3.2s audio) in ${ms.toFixed(0)}ms (${(3200 / ms).toFixed(1)}x realtime); last prob=${prob.toFixed(3)}`);
