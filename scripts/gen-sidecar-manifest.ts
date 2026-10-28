// gen-sidecar-manifest.ts — emit src-tauri/binaries/manifest.json after the
// sidecars are compiled (chained onto `build:sidecar` / `build:brain`).
//
// The manifest maps each sidecar's RUNTIME name (the target triple stripped,
// exactly how Tauri lays externalBin next to the app executable in
// Contents/MacOS/) to its SHA-256 digest + byte size, and to the bytes of the
// model files compiled into it:
//
//   { "atlas-brain": { "sha256": "…", "size": 372087904, "model_bytes": 288… }, … }
//
// src-tauri/build.rs bakes this file into the Rust binary at COMPILE time
// (include_str! from OUT_DIR), and src-tauri/src/integrity.rs verifies each
// sidecar against it before every spawn. Baking at compile time is the point:
// an attacker who can swap a sidecar inside the .app bundle cannot also edit
// the expected digest, because that lives inside the signed app executable.
//
// `model_bytes` is for System Status's "Models on device" (system_status.rs):
// a sidecar is a Bun runtime plus app code plus the models its
// embeddedAssets.ts imports, so its size is not its models' size, and the
// models can only be counted here, while they are still files. A sidecar whose
// model folder is missing gets no count (rather than a zero).
//
// The file is derived output (binaries/ is gitignored) — never commit it.
// `tauri build`'s beforeBuildCommand runs build:sidecar && build:brain, so
// release builds always regenerate it before cargo compiles.

import { join, dirname } from "node:path";
import { readdirSync, lstatSync, statSync, writeFileSync, existsSync } from "node:fs";

// Strip a rust target triple suffix: atlas-brain-aarch64-apple-darwin -> atlas-brain
const TRIPLE = /-(aarch64|x86_64|arm64|i686)-(apple|pc|unknown)-[a-z0-9_-]+$/;

/**
 * The folder (from the repo root) each sidecar's models are compiled from:
 * what its src/embeddedAssets.ts imports from `../models/`, and all that
 * `bun run fetch-models` puts there. src-tauri/src/system_status.rs measures
 * the same folders in a source checkout.
 */
export const MODEL_DIRS: Readonly<Record<string, string>> = {
  "atlas-brain": "services/atlas-brain/models",
  "atlas-voice-gateway": "services/voice-gateway/models",
};

export interface ManifestEntry {
  sha256: string;
  size: number;
  model_bytes?: number;
}

/** Every regular file under `dir`, in bytes; symlinks are not followed. */
export function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = lstatSync(path);
    if (st.isDirectory()) total += dirBytes(path);
    else if (st.isFile()) total += st.size;
  }
  return total;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** The manifest for the sidecars in `<root>/src-tauri/binaries`, with each one's model bytes from `<root>`. */
export async function buildManifest(root: string, log: (line: string) => void = () => {}): Promise<Record<string, ManifestEntry>> {
  const binDir = join(root, "src-tauri", "binaries");
  const manifest: Record<string, ManifestEntry> = {};
  for (const entry of readdirSync(binDir).sort()) {
    if (!TRIPLE.test(entry)) continue; // manifest.json, dotfiles, etc.
    const path = join(binDir, entry);
    const st = statSync(path);
    if (!st.isFile()) continue;
    const runtimeName = entry.replace(TRIPLE, "");
    const t0 = performance.now();
    const digest = await sha256(path);
    const ms = Math.round(performance.now() - t0);
    const modelDir = MODEL_DIRS[runtimeName] ? join(root, MODEL_DIRS[runtimeName]) : null;
    const modelBytes = modelDir && existsSync(modelDir) ? dirBytes(modelDir) : undefined;
    manifest[runtimeName] = { sha256: digest, size: st.size, ...(modelBytes !== undefined ? { model_bytes: modelBytes } : {}) };
    log(
      `[gen-sidecar-manifest] ${runtimeName}: sha256=${digest.slice(0, 16)}… size=${st.size} models=${modelBytes ?? "not counted"} (${ms}ms)`
    );
  }
  return manifest;
}

if (import.meta.main) {
  const root = dirname(import.meta.dir); // scripts/ -> repo root
  const binDir = join(root, "src-tauri", "binaries");
  if (!existsSync(binDir)) {
    console.error(`[gen-sidecar-manifest] ${binDir} does not exist — nothing to do`);
    process.exit(0);
  }
  const manifest = await buildManifest(root, (line) => console.log(line));
  const out = join(binDir, "manifest.json");
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[gen-sidecar-manifest] wrote ${out} (${Object.keys(manifest).length} entries)`);
}
