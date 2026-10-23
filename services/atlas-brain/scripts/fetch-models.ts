/**
 * Prefetch the multilingual-e5-base embedding model into the brain's model
 * store (modelStore.ts: next to atlas.db, or ATLAS_MODELS_DIR), verified
 * against the pinned SHA-256s. Optional: the brain downloads it on first use
 * anyway. Useful to warm a dev machine, or before going offline.
 *
 * The model is no longer compiled into the sidecar binary, so `bun run
 * compile` does not need this.
 */
import { ensureModelFiles, modelDir } from "../src/modelStore.ts";

const dir = modelDir();
console.log(`[fetch-models] model store: ${dir}`);
const paths = await ensureModelFiles({ dir, log: (m) => console.log(m.replace("[brain]", "[fetch-models]")) });
for (const [name, path] of Object.entries(paths)) {
  console.log(`[fetch-models] verified ${name} (${(Bun.file(path).size / 1024 / 1024).toFixed(1)} MB)`);
}
