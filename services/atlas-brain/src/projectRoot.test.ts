import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT, RUNNING_FROM_SOURCE, resolveProjectRoot } from "./projectRoot.ts";

test("the compiled sidecar's virtual path resolves to / without ATLAS_REPO_DIR", () => {
  // Bun's compiled binaries report import.meta.dir under /$bunfs/root: the bug.
  expect(resolveProjectRoot(undefined, "/$bunfs/root")).toBe("/");
});

test("ATLAS_REPO_DIR wins when it is a git checkout", () => {
  const repo = mkdtempSync(join(tmpdir(), "atlas-repo-"));
  mkdirSync(join(repo, ".git"));
  expect(resolveProjectRoot(repo, "/$bunfs/root")).toBe(repo);
});

test("an ATLAS_REPO_DIR that is not a git checkout is ignored", () => {
  const notRepo = mkdtempSync(join(tmpdir(), "atlas-not-repo-"));
  expect(resolveProjectRoot(notRepo, "/src/services/atlas-brain/src")).toBe("/src");
});

test("from this source checkout, the root is the repo and the brain knows it runs from source", () => {
  expect(existsSync(join(PROJECT_ROOT, "src-tauri", "tauri.conf.json"))).toBe(true);
  expect(RUNNING_FROM_SOURCE).toBe(true);
});
