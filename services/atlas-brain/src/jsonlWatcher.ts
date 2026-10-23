/**
 * JSONL ingestion file watcher (feat-018).
 *
 * Ingestion (`jsonlIngest.ts`) only ran when someone pressed Ingest on the
 * admin surface, so /agent-view was a snapshot of whenever that last
 * happened — not the live view its name promises. This watches the Claude Code
 * transcript directory and re-runs the same ingestion when a .jsonl changes.
 *
 * - Debounced: Claude Code appends to the transcript on every turn, often
 *   several times a second while streaming tool calls. One ingest per quiet
 *   period is enough; ingestion itself skips files whose mtime it has seen.
 * - Swept: a session that stops writing produces no event, so nothing would
 *   ever move it from active to completed. A slow periodic ingest settles it
 *   (see ACTIVE_WINDOW_MS in jsonlIngest.ts).
 * - Never fatal: a missing directory or a failing watch is logged and the
 *   brain carries on; the on-demand Ingest button keeps working regardless.
 *
 * Disable with ATLAS_JSONL_WATCH=0.
 */

import { watch, existsSync, type FSWatcher } from "node:fs";

export interface JsonlWatcherOptions {
  dir: string;
  ingest: () => void;
  debounceMs?: number;
  sweepMs?: number;
  log?: (msg: string) => void;
}

export interface JsonlWatcher {
  stop: () => void;
}

export function startJsonlWatcher({
  dir,
  ingest,
  debounceMs = 2_000,
  sweepMs = 60_000,
  log = (m) => console.log(`[jsonl-watch] ${m}`),
}: JsonlWatcherOptions): JsonlWatcher | null {
  if (!existsSync(dir)) {
    log(`${dir} does not exist — not watching (on-demand ingest still works)`);
    return null;
  }

  const run = () => {
    try {
      ingest();
    } catch (err) {
      log(`ingest failed: ${String(err).slice(0, 200)}`);
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, debounceMs);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      // `filename` can be null on some platforms; ingest anyway rather than
      // miss a change — ingestion is idempotent and skips unchanged files.
      if (!filename || String(filename).endsWith(".jsonl")) schedule();
    });
  } catch (err) {
    log(`could not watch ${dir}: ${String(err).slice(0, 200)}`);
    return null;
  }
  watcher.on("error", (err) => log(`watch error: ${String(err).slice(0, 200)}`));

  const sweep = setInterval(run, sweepMs);
  run();
  log(`watching ${dir}`);

  return {
    stop() {
      if (timer) clearTimeout(timer);
      clearInterval(sweep);
      watcher.close();
    },
  };
}
