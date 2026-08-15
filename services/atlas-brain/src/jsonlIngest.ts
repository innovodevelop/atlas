/**
 * JSONL ingestion — reads Claude Code session transcripts from
 * ~/.claude/projects/ and upserts sessions + events into SQLite.
 *
 * Each .jsonl file is one session. The filename (minus extension) is the
 * session UUID. Lines are heterogeneous: metadata (custom-title, ai-title,
 * mode, pr-link) and messages (system, human, assistant with content blocks).
 *
 * We extract:
 * - Session metadata → atlas_agent_sessions
 * - Tool calls → atlas_agent_events (event_type = 'tool_call')
 * - File edits (Edit/Write tools) → atlas_agent_events (event_type = 'file_edit')
 * - Errors → atlas_agent_events (event_type = 'error')
 * - Milestones (compact boundaries, PR links) → atlas_agent_events (event_type = 'milestone')
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { resolve, basename } from "path";
import { homedir } from "os";

interface IngestResult {
  sessions_upserted: number;
  events_inserted: number;
  skipped: number;
  errors: string[];
}

interface JsonlMetaLine {
  type: string;
  customTitle?: string;
  aiTitle?: string;
  sessionId?: string;
  timestamp?: string;
  prUrl?: string;
  prNumber?: number;
}

interface JsonlMessageLine {
  type: string;
  message?: {
    role?: string;
    model?: string;
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }>;
  };
  timestamp?: string;
  uuid?: string;
  subtype?: string;
  compactMetadata?: { trigger?: string; preTokens?: number };
}

const CLAUDE_PROJECTS_DIR = resolve(homedir(), ".claude/projects");

// Only ingest sessions from the helloatlas project directory
const PROJECT_DIR_PATTERN = /Users-magnuspilegaard-Desktop-Vibe-Coding-Projects/;

const MAX_EVENTS_PER_SESSION = 500;

function isToolCall(block: { type: string }): boolean {
  return block.type === "tool_use";
}

function isFileEdit(block: { type: string; name?: string }): boolean {
  return block.type === "tool_use" && (block.name === "Edit" || block.name === "Write");
}

export function ingestJsonlSessions(db: Database, projectFilter?: string): IngestResult {
  const result: IngestResult = { sessions_upserted: 0, events_inserted: 0, skipped: 0, errors: [] };

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    result.errors.push(`${CLAUDE_PROJECTS_DIR} does not exist`);
    return result;
  }

  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR).filter((d) => {
    if (projectFilter) return d.includes(projectFilter);
    return PROJECT_DIR_PATTERN.test(d);
  });

  const upsertSession = db.prepare(`
    INSERT INTO atlas_agent_sessions (id, session_type, source_id, status, task_summary, started_at, ended_at, metadata)
    VALUES (?, 'claude-code', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      task_summary = COALESCE(excluded.task_summary, atlas_agent_sessions.task_summary),
      status = excluded.status,
      ended_at = excluded.ended_at,
      metadata = excluded.metadata
  `);

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO atlas_agent_events (id, session_id, event_type, payload, ts)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Track which sessions we already ingested (by checking last modified time)
  const getSessionMeta = db.prepare(`SELECT metadata FROM atlas_agent_sessions WHERE id = ?`);

  for (const projDir of projectDirs) {
    const projPath = resolve(CLAUDE_PROJECTS_DIR, projDir);
    let entries: string[];
    try {
      entries = readdirSync(projPath);
    } catch {
      continue;
    }

    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const sessionId = basename(file, ".jsonl");
      const filePath = resolve(projPath, file);

      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }

      // Skip if we already ingested this file at this mtime
      const existing = getSessionMeta.get(sessionId) as { metadata: string } | null;
      if (existing) {
        try {
          const meta = JSON.parse(existing.metadata);
          if (meta._ingest_mtime === stat.mtimeMs) {
            result.skipped++;
            continue;
          }
        } catch { /* re-ingest */ }
      }

      try {
        const { session, events } = parseJsonlFile(filePath, sessionId, projDir);
        const tx = db.transaction(() => {
          upsertSession.run(
            sessionId,
            filePath,
            session.status,
            session.title,
            session.startedAt,
            session.endedAt,
            JSON.stringify({ ...session.meta, _ingest_mtime: stat.mtimeMs }),
          );

          const limited = events.slice(0, MAX_EVENTS_PER_SESSION);
          for (const ev of limited) {
            insertEvent.run(ev.id, sessionId, ev.event_type, JSON.stringify(ev.payload), ev.ts);
          }
        });
        tx();

        result.sessions_upserted++;
        result.events_inserted += Math.min(events.length, MAX_EVENTS_PER_SESSION);
      } catch (err) {
        result.errors.push(`${file}: ${String(err).slice(0, 200)}`);
      }
    }
  }

  return result;
}

interface ParsedSession {
  title: string | null;
  status: 'completed' | 'active';
  startedAt: string;
  endedAt: string | null;
  meta: Record<string, unknown>;
}

interface ParsedEvent {
  id: string;
  event_type: 'file_edit' | 'tool_call' | 'milestone' | 'error' | 'log';
  payload: Record<string, unknown>;
  ts: string;
}

function parseJsonlFile(filePath: string, sessionId: string, projDir: string): { session: ParsedSession; events: ParsedEvent[] } {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);

  let title: string | null = null;
  let model: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let prUrl: string | null = null;
  const events: ParsedEvent[] = [];
  let eventIdx = 0;

  for (const line of lines) {
    let parsed: JsonlMetaLine & JsonlMessageLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Track timestamps
    const ts = parsed.timestamp;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    // Metadata lines
    if (parsed.type === "custom-title" && parsed.customTitle) {
      title = parsed.customTitle;
      continue;
    }
    if (parsed.type === "ai-title" && parsed.aiTitle && !title) {
      title = parsed.aiTitle;
      continue;
    }
    if (parsed.type === "pr-link" && parsed.prUrl) {
      prUrl = parsed.prUrl;
      events.push({
        id: `${sessionId}-pr-${parsed.prNumber ?? eventIdx}`,
        event_type: "milestone",
        payload: { kind: "pr-link", url: parsed.prUrl, number: parsed.prNumber },
        ts: ts ?? new Date().toISOString(),
      });
      eventIdx++;
      continue;
    }

    // Compact boundary = a milestone (session got long enough to compact)
    if (parsed.subtype === "compact_boundary") {
      events.push({
        id: `${sessionId}-compact-${eventIdx}`,
        event_type: "milestone",
        payload: { kind: "compact", preTokens: parsed.compactMetadata?.preTokens },
        ts: ts ?? new Date().toISOString(),
      });
      eventIdx++;
      continue;
    }

    // Assistant messages with tool calls
    if (parsed.message?.role === "assistant" && parsed.message.content) {
      if (!model && parsed.message.model) model = parsed.message.model;

      for (const block of parsed.message.content) {
        if (isFileEdit(block)) {
          events.push({
            id: `${sessionId}-ev-${eventIdx}`,
            event_type: "file_edit",
            payload: { tool: block.name, file: (block.input as Record<string, unknown>)?.file_path ?? (block.input as Record<string, unknown>)?.path ?? null },
            ts: ts ?? new Date().toISOString(),
          });
          eventIdx++;
        } else if (isToolCall(block)) {
          events.push({
            id: `${sessionId}-ev-${eventIdx}`,
            event_type: "tool_call",
            payload: { tool: block.name },
            ts: ts ?? new Date().toISOString(),
          });
          eventIdx++;
        }
      }
    }
  }

  const now = new Date().toISOString();
  const session: ParsedSession = {
    title,
    status: "completed",
    startedAt: firstTs ?? now,
    endedAt: lastTs ?? now,
    meta: { model, prUrl, project: projDir, lines: lines.length },
  };

  return { session, events };
}
