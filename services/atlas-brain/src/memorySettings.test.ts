// "Remember things I share" as the brain reads it (memorySettings.ts), against
// a real copy of the app schema — the same harness as greeting.test.ts.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readRememberShared } from "./memorySettings.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(SRC, "../../../src-tauri/src/db_schema.sql"), "utf8");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

test("no row is the default: remembering on", () => {
  expect(readRememberShared(freshDb(), "u1")).toBe(true);
});

test("the user's row decides, per user", () => {
  const db = freshDb();
  db.query(`INSERT INTO atlas_memory_settings (id, user_id, remember_shared) VALUES ('a', 'u1', 0)`).run();
  db.query(`INSERT INTO atlas_memory_settings (id, user_id, remember_shared) VALUES ('b', 'u2', 1)`).run();
  expect(readRememberShared(db, "u1")).toBe(false);
  expect(readRememberShared(db, "u2")).toBe(true);
  expect(readRememberShared(db, "u3")).toBe(true);
});

test("the schema refuses anything but 0 or 1, and one row per user", () => {
  const db = freshDb();
  expect(() => db.query(`INSERT INTO atlas_memory_settings (id, user_id, remember_shared) VALUES ('a', 'u1', 2)`).run()).toThrow();
  db.query(`INSERT INTO atlas_memory_settings (id, user_id) VALUES ('a', 'u1')`).run();
  expect(() => db.query(`INSERT INTO atlas_memory_settings (id, user_id) VALUES ('b', 'u1')`).run()).toThrow();
});

test("a database without the table reads as on, never as an error", () => {
  expect(readRememberShared(new Database(":memory:"), "u1")).toBe(true);
});
