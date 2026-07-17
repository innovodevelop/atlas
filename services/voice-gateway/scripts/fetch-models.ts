/**
 * Downloads the Silero VAD ONNX model (~2 MB, MIT licence) into models/.
 * Run once: `bun run fetch-models`.
 */
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, "../models");
const TARGET = join(MODELS_DIR, "silero_vad.onnx");
const URL_ = "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx";

if (existsSync(TARGET)) {
  console.log(`[fetch-models] already present: ${TARGET}`);
  process.exit(0);
}

mkdirSync(MODELS_DIR, { recursive: true });
console.log(`[fetch-models] downloading ${URL_} …`);
const res = await fetch(URL_);
if (!res.ok) {
  console.error(`[fetch-models] HTTP ${res.status}`);
  process.exit(1);
}
await Bun.write(TARGET, await res.arrayBuffer());
console.log(`[fetch-models] saved ${TARGET} (${(Bun.file(TARGET).size / 1024 / 1024).toFixed(1)} MB)`);
