// The JSONL file watcher (feat-018): a .jsonl change triggers one debounced
// ingest, other files do not, and a missing directory is not fatal.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJsonlWatcher } from "./jsonlWatcher.ts";

const quiet = () => {};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("ingests once at start, then once per burst of .jsonl writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-watch-"));
  mkdirSync(join(dir, "project"));
  let runs = 0;
  const watcher = startJsonlWatcher({ dir, ingest: () => { runs++; }, debounceMs: 100, sweepMs: 60_000, log: quiet });
  expect(watcher).not.toBeNull();
  try {
    expect(runs).toBe(1);
    await wait(100); // let the watch settle before writing

    for (let i = 0; i < 5; i++) writeFileSync(join(dir, "project", "s.jsonl"), `{"n":${i}}\n`);
    await wait(500);
    expect(runs).toBe(2);

    writeFileSync(join(dir, "project", "notes.txt"), "not a transcript");
    await wait(400);
    expect(runs).toBe(2);
  } finally {
    watcher?.stop();
  }
});

test("the sweep re-runs ingest with no file activity, so quiet sessions settle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-watch-"));
  let runs = 0;
  const watcher = startJsonlWatcher({ dir, ingest: () => { runs++; }, debounceMs: 50, sweepMs: 100, log: quiet });
  try {
    await wait(350);
    expect(runs).toBeGreaterThanOrEqual(3);
  } finally {
    watcher?.stop();
  }
});

test("a missing directory returns null instead of throwing", () => {
  const logs: string[] = [];
  const watcher = startJsonlWatcher({ dir: join(tmpdir(), "atlas-watch-does-not-exist"), ingest: quiet, log: (m) => logs.push(m) });
  expect(watcher).toBeNull();
  expect(logs[0]).toContain("does not exist");
});

test("an ingest that throws is logged, and the watcher keeps going", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-watch-"));
  const logs: string[] = [];
  const watcher = startJsonlWatcher({ dir, ingest: () => { throw new Error("boom"); }, sweepMs: 60_000, log: (m) => logs.push(m) });
  try {
    expect(watcher).not.toBeNull();
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  } finally {
    watcher?.stop();
  }
});
