// Earlier conversations (conversations.ts): what a reader is handed out of
// chat_turns — the words, never the system prompt or the tool traffic — over
// turns written by the real capture path (localDb.ts captureChatTurn).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureChatTurn, createLocalDb, type LocalDb } from "./localDb.ts";
import { createConversationHandlers, listConversations, readConversation } from "./conversations.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(SRC, "../../../src-tauri/src/db_schema.sql"), "utf8");

function freshDb(): LocalDb {
  const dbPath = join(mkdtempSync(join(tmpdir(), "atlas-convo-")), "atlas.db");
  const seed = new Database(dbPath, { create: true });
  seed.exec(SCHEMA);
  seed.close();
  return createLocalDb(dbPath);
}

const USER = "u-convo";
const authed = () => ({ userId: USER, email: "t@t", token: "jwt" });
const jsonHelper = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const post = (body: unknown) => new Request("http://127.0.0.1/conversations", { method: "POST", body: JSON.stringify(body) });

function turn(db: LocalDb, conversationId: string | null, source: string, user: string, reply: string, userId = USER) {
  captureChatTurn(db._db, {
    userId,
    conversationId,
    source,
    model: "m",
    systemPrompt: "SECRET SYSTEM PROMPT",
    userMessage: user,
    toolMessages: [
      { role: "assistant", content: "", tool_calls: [{ id: "1", function: { name: "weather" } }] },
      { role: "tool", content: '{"raw":"tool output"}' },
    ],
    assistantText: reply,
  });
}

/** captureChatTurn stamps created_at in SQL; spread the turns so ordering is real. */
function backdate(db: LocalDb, conversationId: string, iso: string) {
  db._db.query(`UPDATE chat_turns SET created_at = ? WHERE conversation_id = ?`).run(iso, conversationId);
}

describe("listConversations", () => {
  test("one row per conversation, newest first, titled by the first question", () => {
    const db = freshDb();
    turn(db, "voice_1", "voice_chat", "Help me pack for Paris", "Start with layers.");
    turn(db, "voice_1", "voice_chat", "And shoes?", "Two pairs.");
    backdate(db, "voice_1", "2026-10-27T09:00:00.000Z");
    turn(db, "talk_1", "talk:Answer", "Do I need an umbrella?", "Yes, from 15:00.");
    backdate(db, "talk_1", "2026-10-28T08:00:00.000Z");
    turn(db, null, "proactive", "orphan", "no conversation id");
    turn(db, "other", "voice_chat", "not mine", "hidden", "someone-else");

    const list = listConversations(db._db, USER);
    expect(list.map((c) => c.id)).toEqual(["talk_1", "voice_1"]);
    expect(list[1]).toMatchObject({ source: "voice_chat", title: "Help me pack for Paris", turns: 2 });
    expect(list[0].source).toBe("talk:Answer");
    expect(listConversations(db._db, USER, 1)).toHaveLength(1);
  });
});

describe("readConversation", () => {
  test("the words only: no system prompt, no tool calls, no tool output", () => {
    const db = freshDb();
    turn(db, "voice_1", "voice_chat", "Help me pack for Paris", "Start with layers.");
    turn(db, "voice_1", "voice_chat", "And shoes?", "Two pairs.");
    const c = readConversation(db._db, USER, "voice_1")!;
    expect(c.turns.map((t) => `${t.role}:${t.content}`)).toEqual([
      "user:Help me pack for Paris",
      "assistant:Start with layers.",
      "user:And shoes?",
      "assistant:Two pairs.",
    ]);
    expect(JSON.stringify(c)).not.toContain("SECRET SYSTEM PROMPT");
    expect(JSON.stringify(c)).not.toContain("tool output");
    expect(readConversation(db._db, "someone-else", "voice_1")).toBeNull();
  });
});

describe("routes", () => {
  test("list and get, with a 404 for an unknown id", async () => {
    const db = freshDb();
    turn(db, "talk_1", "talk", "Hello", "Hi.");
    const h = createConversationHandlers({ db, requireUser: authed, json: jsonHelper });
    const list = await (await h.list(post({ limit: 5 }))).json();
    expect(list.conversations).toHaveLength(1);
    const one = await (await h.get(post({ id: "talk_1" }))).json();
    expect(one.turns).toHaveLength(2);
    expect((await h.get(post({ id: "nope" }))).status).toBe(404);
    expect((await h.get(post({}))).status).toBe(400);
  });
});
