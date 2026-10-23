/**
 * Where the e5 embedding model lives, and how it gets there (feat-045).
 *
 * The weights (~266 MB) and tokenizer (~17 MB) used to be compiled into the
 * brain binary, which made them most of every download and every update. Now
 * they are fetched once, on first use, into Atlas's Application Support folder
 * (next to atlas.db), and every later launch — and every update — reuses them.
 *
 * Integrity: the files are pinned to one Hugging Face revision and to their
 * SHA-256 (derived by .github/workflows/e5-model-pin.yml). A download goes to a
 * temporary name, is hashed, and only then renamed into place, so a partial or
 * tampered file is never loaded. Files already on disk are checked by size on
 * every launch and by hash once per process before they are trusted.
 *
 * Until the model is present, embedText() throws; every caller already
 * degrades on that (chat recall falls back to static context, the post-turn
 * sweep retries next turn), so chat keeps working while it downloads.
 *
 * The download carries no user data: it is a plain GET of a public model.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_DB_PATH } from "./localMemory.ts";

export const MODEL_REPO = "Xenova/multilingual-e5-base";
export const MODEL_REVISION = "1ec9243030a27d1a115d5c340572074c125b58b2";

export interface ModelFile {
  /** Path in the Hugging Face repo. */
  remote: string;
  /** File name in the local model directory. */
  local: string;
  size: number;
  sha256: string;
}

export const MODEL_FILES: ModelFile[] = [
  {
    remote: "tokenizer.json",
    local: "tokenizer.json",
    size: 17082660,
    sha256: "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626",
  },
  {
    remote: "tokenizer_config.json",
    local: "tokenizer_config.json",
    size: 418,
    sha256: "efb5c0d09722e5fe59a462cd2a9976ee216d55b037597d997cd3fe833216da15",
  },
  {
    remote: "onnx/model_quantized.onnx",
    local: "model_quantized.onnx",
    size: 278647662,
    sha256: "df7a9a29309e3ad491e1783adf8baee710262cc06079c7cbab63c630277fac94",
  },
];

/**
 * ATLAS_MODELS_DIR overrides; otherwise `models/multilingual-e5-base` beside
 * the database the brain opens, so a test or second bundle pointed at another
 * ATLAS_DB_PATH also keeps its own copy.
 */
export function modelDir(env: Record<string, string | undefined> = process.env): string {
  if (env.ATLAS_MODELS_DIR) return join(env.ATLAS_MODELS_DIR, "multilingual-e5-base");
  return join(dirname(env.ATLAS_DB_PATH || DEFAULT_DB_PATH), "models", "multilingual-e5-base");
}

export function fileUrl(f: ModelFile): string {
  return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${f.remote}`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest("hex");
}

export type Fetcher = (url: string) => Promise<Response>;

export interface EnsureOptions {
  dir?: string;
  fetcher?: Fetcher;
  files?: ModelFile[];
  log?: (msg: string) => void;
}

/** Paths of the verified files, keyed by local name. */
export type ModelPaths = Record<string, string>;

/**
 * Make every model file present and verified, downloading what is missing or
 * wrong. Concurrent callers share one run (see ensureModel).
 */
export async function ensureModelFiles({
  dir = modelDir(),
  fetcher = fetch,
  files = MODEL_FILES,
  log = (m) => console.log(m),
}: EnsureOptions = {}): Promise<ModelPaths> {
  mkdirSync(dir, { recursive: true });
  const paths: ModelPaths = {};
  for (const f of files) {
    const target = join(dir, f.local);
    if (existsSync(target) && statSync(target).size === f.size && (await sha256File(target)) === f.sha256) {
      paths[f.local] = target;
      continue;
    }
    const tmp = `${target}.download`;
    rmSync(tmp, { force: true });
    log(`[brain] downloading embedding model file ${f.remote} (${(f.size / 1024 / 1024).toFixed(1)} MB)…`);
    const res = await fetcher(fileUrl(f));
    if (!res.ok || !res.body) throw new Error(`embedding model download failed: HTTP ${res.status} for ${f.remote}`);
    // Streamed to disk: holding 266 MB in memory would add to the ~1.4 GiB the
    // loaded model already costs.
    const writer = Bun.file(tmp).writer();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
    }
    await writer.end();
    const size = statSync(tmp).size;
    const digest = await sha256File(tmp);
    if (size !== f.size || digest !== f.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`embedding model file ${f.remote} failed verification (size ${size}, sha256 ${digest.slice(0, 12)}…)`);
    }
    renameSync(tmp, target);
    paths[f.local] = target;
  }
  return paths;
}

let inFlight: Promise<ModelPaths> | null = null;

/**
 * The verified model files, downloading them once if needed. A failure
 * (offline, Hugging Face down) is not cached: the next call tries again.
 */
export function ensureModel(opts?: EnsureOptions): Promise<ModelPaths> {
  inFlight ??= ensureModelFiles(opts).catch((e) => {
    inFlight = null;
    throw e;
  });
  return inFlight;
}
