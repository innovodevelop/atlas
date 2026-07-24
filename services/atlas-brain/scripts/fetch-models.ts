/**
 * Downloads the multilingual-e5-base embedding model (int8-quantized ONNX,
 * ~265 MB + a 17 MB tokenizer) into models/. Run once before `bun run compile`:
 * `bun run fetch-models`.
 *
 * Source: Xenova/multilingual-e5-base — the transformers.js ONNX export of
 * intfloat/multilingual-e5-base (MIT). 768 dims, which is what
 * memory_vectors.embedding / EMBEDDING_DIMENSIONS require.
 */
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, "../models/multilingual-e5-base");
const BASE = "https://huggingface.co/Xenova/multilingual-e5-base/resolve/main/";

// [remote path, local filename]
const FILES: Array<[string, string]> = [
  ["tokenizer.json", "tokenizer.json"],
  ["tokenizer_config.json", "tokenizer_config.json"],
  ["onnx/model_quantized.onnx", "model_quantized.onnx"],
];

mkdirSync(MODELS_DIR, { recursive: true });

for (const [remote, local] of FILES) {
  const target = join(MODELS_DIR, local);
  if (existsSync(target) && Bun.file(target).size > 0) {
    console.log(`[fetch-models] already present: ${local}`);
    continue;
  }
  console.log(`[fetch-models] downloading ${remote} …`);
  const res = await fetch(BASE + remote);
  if (!res.ok) {
    console.error(`[fetch-models] HTTP ${res.status} for ${remote}`);
    process.exit(1);
  }
  await Bun.write(target, await res.arrayBuffer());
  console.log(`[fetch-models] saved ${local} (${(Bun.file(target).size / 1024 / 1024).toFixed(1)} MB)`);
}
