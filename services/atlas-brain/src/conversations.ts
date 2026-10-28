/**
 * Earlier conversations, read back for the Beta Voice and Answer screens
 * (`Atlas Voice Beta.dc.html`, left-out row 29).
 *
 * `chat_turns` already holds every turn this brain has answered — the user's
 * message, the tool loop, the reply — grouped by the conversation id the
 * caller sent (one per voice session, per Talk session, per text chat). It
 * was written for fine-tuning capture (see localDb.ts `captureChatTurn`), so
 * it also holds what a person reading their history must not be handed: the
 * composed system prompt and the raw tool traffic. These routes return only
 * what was said — the user's words and Atlas's final replies.
 *
 * POST /conversations/list {limit?}  → { conversations: [{ id, source, title, turns, startedAt, lastAt }] }
 * POST /conversations/get  {id}      → { id, source, turns: [{ role, content, at }] }
 *
 * Read-only SQL, scoped to the caller, no model call; nothing leaves the Mac.
 */

import type { Database } from "bun:sqlite";
import type { LocalDb } from "./localDb.ts";

interface Deps {
  db: LocalDb;
  requireUser: (req: Request) => { userId: string; email: string; token: string };
  json: (body: unknown, status?: number) => Response;
}

export interface ConversationSummary {
  id: string;
  source: string;
  title: string;
  turns: number;
  startedAt: string;
  lastAt: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

const MAX_LIST = 50;
const MAX_TURN_CHARS = 6000;

/**
 * The rows a reader sees: the user's messages and Atlas's FINAL replies. A
 * tool-loop assistant row carries `tool_calls` (and usually no text); a
 * `tool` or `system` row is plumbing.
 */
const SPOKEN = `(role = 'user' OR (role = 'assistant' AND tool_calls IS NULL AND trim(content) != ''))`;

// Ordering note: `created_at` is stamped to the millisecond by SQLite, so two
// turns captured in the same millisecond tie, and `seq` restarts at 0 for
// every turn — sorting on it would interleave them. The rowid is insertion
// order, which is the order the turns happened in.

export function listConversations(db: Database, userId: string, limit = 12): ConversationSummary[] {
  const n = Math.max(1, Math.min(MAX_LIST, Math.floor(limit) || 12));
  const groups = db
    .query(
      `SELECT conversation_id AS id, MIN(created_at) AS startedAt, MAX(created_at) AS lastAt,
              SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS turns
         FROM chat_turns
        WHERE user_id = ? AND conversation_id IS NOT NULL AND conversation_id != '' AND ${SPOKEN}
        GROUP BY conversation_id
       HAVING turns > 0
        ORDER BY lastAt DESC
        LIMIT ?`,
    )
    .all(userId, n) as Array<{ id: string; startedAt: string; lastAt: string; turns: number }>;
  const firstQuestion = db.query(
    `SELECT substr(content, 1, 240) AS content FROM chat_turns
      WHERE user_id = ? AND conversation_id = ? AND role = 'user' AND trim(content) != ''
      ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  );
  const lastSource = db.query(
    `SELECT source FROM chat_turns WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  return groups.flatMap((g) => {
    const q = firstQuestion.get(userId, g.id) as { content: string } | null;
    if (!q) return [];
    const s = lastSource.get(userId, g.id) as { source: string | null } | null;
    return [{
      id: g.id,
      source: s?.source ?? "",
      title: q.content.replace(/\s+/g, " ").trim(),
      turns: g.turns,
      startedAt: g.startedAt,
      lastAt: g.lastAt,
    }];
  });
}

export function readConversation(db: Database, userId: string, id: string): { id: string; source: string; turns: ConversationTurn[] } | null {
  const rows = db
    .query(
      `SELECT role, content, created_at AS at, source FROM chat_turns
        WHERE user_id = ? AND conversation_id = ? AND ${SPOKEN}
        ORDER BY created_at ASC, rowid ASC LIMIT 400`,
    )
    .all(userId, id) as Array<{ role: "user" | "assistant"; content: string; at: string; source: string | null }>;
  if (!rows.length) return null;
  return {
    id,
    source: rows[rows.length - 1].source ?? "",
    turns: rows.map((r) => ({
      role: r.role,
      content: r.content.length > MAX_TURN_CHARS ? `${r.content.slice(0, MAX_TURN_CHARS - 1)}…` : r.content,
      at: r.at,
    })),
  };
}

export function createConversationHandlers({ db, requireUser, json }: Deps) {
  async function list(req: Request): Promise<Response> {
    const { userId } = requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { limit?: unknown };
    const limit = typeof body.limit === "number" ? body.limit : 12;
    return json({ conversations: listConversations(db._db, userId, limit) });
  }

  async function get(req: Request): Promise<Response> {
    const { userId } = requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id || id.length > 200) return json({ error: "id is required" }, 400);
    const convo = readConversation(db._db, userId, id);
    return convo ? json(convo) : json({ error: "Conversation not found" }, 404);
  }

  return { list, get };
}
