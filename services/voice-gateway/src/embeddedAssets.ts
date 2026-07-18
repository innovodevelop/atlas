/**
 * Assets embedded into the compiled sidecar binary. Bun's compiler inlines
 * files imported with `with { type: "file" }`; at runtime the imports resolve
 * to extracted file paths (dev: the original on-disk paths).
 *
 * `prepareOrtWasmDir()` lays the ORT runtime files out in a temp directory
 * under their CANONICAL names so `ort.env.wasm.wasmPaths` can point at it —
 * onnxruntime-web resolves loaders by well-known filename.
 *
 * NOTE: models/silero_vad.onnx is gitignored — run `bun run fetch-models`
 * before `bun run compile`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error Bun file-loader import (path string at runtime)
import sileroModelPath from "../models/silero_vad.onnx" with { type: "file" };
// Relative paths bypass the package exports map (which doesn't expose the
// loader .mjs files as subpath exports). Under Bun, ORT loads the plain .mjs
// which asyncifies and fetches the .asyncify.wasm — embed all four so either
// loader/wasm pairing resolves.
// @ts-expect-error Bun file-loader import
import ortWasm from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" with { type: "file" };
// @ts-expect-error Bun file-loader import
import ortWasmAsyncify from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm" with { type: "file" };
// @ts-expect-error Bun file-loader import
import ortMjs from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs" with { type: "file" };
// @ts-expect-error Bun file-loader import
import ortMjsAsyncify from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs" with { type: "file" };

export { sileroModelPath };

const CANONICAL: Array<[string, string]> = [
  [ortWasm as string, "ort-wasm-simd-threaded.wasm"],
  [ortWasmAsyncify as string, "ort-wasm-simd-threaded.asyncify.wasm"],
  [ortMjs as string, "ort-wasm-simd-threaded.mjs"],
  [ortMjsAsyncify as string, "ort-wasm-simd-threaded.asyncify.mjs"],
];

let cachedDir: string | null = null;

/** Extract the ORT wasm runtime into a canonical-named dir; returns its path. */
export async function prepareOrtWasmDir(): Promise<string> {
  if (cachedDir) return cachedDir;
  const dir = mkdtempSync(join(tmpdir(), "atlas-ort-"));
  for (const [src, name] of CANONICAL) {
    await Bun.write(join(dir, name), Bun.file(src));
  }
  cachedDir = dir;
  return dir;
}
