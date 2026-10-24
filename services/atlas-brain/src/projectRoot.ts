// Where the Atlas repo checkout is, for the routes that read it (plan,
// changelog, design manifest, tests, self-repair).
//
// From source it is three levels above this file. In the compiled sidecar
// `import.meta.dir` is Bun's virtual filesystem, so that resolved to `/` and
// every repo-reading route had nothing to read. There the app passes the
// checkout it was built from as ATLAS_REPO_DIR (src-tauri/src/lib.rs, only when
// that path holds a .git), and that wins. An ATLAS_REPO_DIR that is not a git
// checkout is ignored rather than trusted.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveProjectRoot(repoDir: string | undefined, here: string): string {
  if (repoDir && existsSync(join(repoDir, ".git"))) return resolve(repoDir);
  return resolve(here, "../../..");
}

export const PROJECT_ROOT = resolveProjectRoot(process.env.ATLAS_REPO_DIR, import.meta.dir);

/**
 * True only when this brain runs from a source checkout, whatever
 * ATLAS_REPO_DIR says. Gates what a compiled sidecar must never start on its
 * own (the ~/.claude watcher in index.ts): knowing where the repo is does not
 * make the installed app a dev build.
 */
export const RUNNING_FROM_SOURCE = existsSync(resolve(import.meta.dir, "../../..", ".git"));
