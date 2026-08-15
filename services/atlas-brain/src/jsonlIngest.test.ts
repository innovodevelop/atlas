import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ingestJsonlSessions } from "./jsonlIngest.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "path";
import { homedir } from "os";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS atlas_agent_sessions (
  id TEXT PRIMARY KEY, session_type TEXT NOT NULL, source_id TEXT,
  version_id TEXT, feature_id TEXT, status TEXT NOT NULL DEFAULT 'active',
  task_summary TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS atlas_agent_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  event_type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

describe("jsonlIngest", () => {
  test("ingests a minimal .jsonl file", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);

    // Create a temp project dir that matches the filter
    const testDir = resolve(homedir(), ".claude/projects/_test_atlas_ingest_");
    mkdirSync(testDir, { recursive: true });

    const sessionId = "test-session-abc123";
    const lines = [
      JSON.stringify({ type: "custom-title", customTitle: "Test Session", sessionId }),
      JSON.stringify({ type: "ai-title", aiTitle: "Fallback title", sessionId }),
      JSON.stringify({
        parentUuid: null, type: "assistant", timestamp: "2026-08-15T10:00:00.000Z",
        message: { role: "assistant", model: "claude-opus-4-6", content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/src/foo.ts" } },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ] },
      }),
      JSON.stringify({ type: "pr-link", prUrl: "https://github.com/test/pr/1", prNumber: 1, timestamp: "2026-08-15T11:00:00.000Z", sessionId }),
    ];
    writeFileSync(resolve(testDir, `${sessionId}.jsonl`), lines.join("\n"));

    try {
      const result = ingestJsonlSessions(db, "_test_atlas_ingest_");
      expect(result.sessions_upserted).toBe(1);
      expect(result.events_inserted).toBeGreaterThanOrEqual(3); // 1 file_edit + 1 tool_call + 1 milestone

      const session = db.query("SELECT * FROM atlas_agent_sessions WHERE id = ?").get(sessionId) as Record<string, unknown>;
      expect(session).not.toBeNull();
      expect(session.task_summary).toBe("Test Session");
      expect(session.session_type).toBe("claude-code");

      const events = db.query("SELECT * FROM atlas_agent_events WHERE session_id = ?").all(sessionId) as Array<Record<string, unknown>>;
      expect(events.length).toBeGreaterThanOrEqual(3);

      const fileEdits = events.filter(e => e.event_type === "file_edit");
      expect(fileEdits.length).toBe(1);

      const toolCalls = events.filter(e => e.event_type === "tool_call");
      expect(toolCalls.length).toBe(1);

      const milestones = events.filter(e => e.event_type === "milestone");
      expect(milestones.length).toBe(1);

      // Re-ingestion with same mtime should skip
      const result2 = ingestJsonlSessions(db, "_test_atlas_ingest_");
      expect(result2.skipped).toBe(1);
      expect(result2.sessions_upserted).toBe(0);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
