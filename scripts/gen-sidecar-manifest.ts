// gen-sidecar-manifest.ts — emit src-tauri/binaries/manifest.json after the
// sidecars are compiled (chained onto `build:sidecar` / `build:brain`).
//
// The manifest maps each sidecar's RUNTIME name (the target triple stripped,
// exactly how Tauri lays externalBin next to the app executable in
// Contents/MacOS/) to its SHA-256 digest + byte size:
//
//   { "atlas-brain": { "sha256": "…", "size": 372087904 }, … }
//
// src-tauri/build.rs bakes this file into the Rust binary at COMPILE time
// (include_str! from OUT_DIR), and src-tauri/src/integrity.rs verifies each
// sidecar against it before every spawn. Baking at compile time is the point:
// an attacker who can swap a sidecar inside the .app bundle cannot also edit
// the expected digest, because that lives inside the signed app executable.
//
// The file is derived output (binaries/ is gitignored) — never commit it.
// `tauri build`'s beforeBuildCommand runs build:sidecar && build:brain, so
// release builds always regenerate it before cargo compiles.

import { join, dirname } from "node:path";
import { readdirSync, statSync, writeFileSync, existsSync } from "node:fs";

const root = dirname(import.meta.dir); // scripts/ -> repo root
const binDir = join(root, "src-tauri", "binaries");

if (!existsSync(binDir)) {
  console.error(`[gen-sidecar-manifest] ${binDir} does not exist — nothing to do`);
  process.exit(0);
}

// Strip a rust target triple suffix: atlas-brain-aarch64-apple-darwin -> atlas-brain
const TRIPLE = /-(aarch64|x86_64|arm64|i686)-(apple|pc|unknown)-[a-z0-9_-]+$/;

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

const manifest: Record<string, { sha256: string; size: number }> = {};

for (const entry of readdirSync(binDir).sort()) {
  if (!TRIPLE.test(entry)) continue; // manifest.json, dotfiles, etc.
  const path = join(binDir, entry);
  const st = statSync(path);
  if (!st.isFile()) continue;
  const runtimeName = entry.replace(TRIPLE, "");
  const t0 = performance.now();
  const digest = await sha256(path);
  const ms = Math.round(performance.now() - t0);
  manifest[runtimeName] = { sha256: digest, size: st.size };
  console.log(
    `[gen-sidecar-manifest] ${runtimeName}: sha256=${digest.slice(0, 16)}… size=${st.size} (${ms}ms)`
  );
}

const out = join(binDir, "manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`[gen-sidecar-manifest] wrote ${out} (${Object.keys(manifest).length} entries)`);
