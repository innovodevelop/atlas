/**
 * Assets embedded into the compiled sidecar binary. Bun's compiler inlines
 * files imported with `with { type: "file" }`; at runtime the imports resolve
 * to extracted file paths (dev: the original on-disk paths — see assets.d.ts
 * for the ambient string typing).
 *
 * Mirrors services/voice-gateway/src/embeddedAssets.ts. Two things live here:
 *
 *  - the ONNX Runtime **web** (WASM) build. onnxruntime-node ships a .dylib
 *    that does not survive `bun build --compile`, so the sidecar uses the WASM
 *    backend and points `ort.env.wasm.wasmPaths` at an extracted directory —
 *    ORT resolves its loaders by CANONICAL filename, hence the rename.
 *  - the multilingual-e5-base weights + tokenizer (see scripts/fetch-models.ts).
 *
 * NOTE: models/ is gitignored — run `bun run fetch-models` before
 * `bun run compile`, or the file-loader imports below will fail to resolve.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Relative paths bypass the package exports map (which doesn't expose the
// loader .mjs files as subpath exports). The plain (non-asyncify) pair is the
// one ORT selects here; embedding only that pair keeps ~23 MB out of the binary.
import ortWasm from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" with { type: "file" };
import ortMjs from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs" with { type: "file" };

import tokenizerPath from "../models/multilingual-e5-base/tokenizer.json" with { type: "file" };
import tokenizerConfigPath from "../models/multilingual-e5-base/tokenizer_config.json" with { type: "file" };
import onnxPath from "../models/multilingual-e5-base/model_quantized.onnx" with { type: "file" };

export const EMBED_TOKENIZER = tokenizerPath;
export const EMBED_TOKENIZER_CONFIG = tokenizerConfigPath;
export const EMBED_ONNX = onnxPath;

const CANONICAL: Array<[string, string]> = [
  [ortWasm, "ort-wasm-simd-threaded.wasm"],
  [ortMjs, "ort-wasm-simd-threaded.mjs"],
];

let cachedDir: string | null = null;

/** Extract the ORT wasm runtime into a canonical-named dir; returns its path. */
export async function prepareOrtWasmDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  const dir = mkdtempSync(join(tmpdir(), "atlas-brain-ort-"));
  for (const [src, name] of CANONICAL) {
    await Bun.write(join(dir, name), Bun.file(src));
  }
  cachedDir = dir;
  return dir;
}
