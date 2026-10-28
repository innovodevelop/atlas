// The Beta Answer shapes (answerShapes.ts): the comparison route's
// containment and degradation, and the person lookup over a real copy of the
// app schema — same harness as greeting.test.ts.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalDb, type LocalDb } from "./localDb.ts";
import { createAnswerShapeHandlers, extractJsonObject, findPerson, splitAddress } from "./answerShapes.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(SRC, "../../../src-tauri/src/db_schema.sql"), "utf8");

function freshDb(): LocalDb {
  const dbPath = join(mkdtempSync(join(tmpdir(), "atlas-answer-")), "atlas.db");
  const seed = new Database(dbPath, { create: true });
  seed.exec(SCHEMA);
  seed.close();
  return createLocalDb(dbPath);
}

const USER = "u-answer";
const authed = () => ({ userId: USER, email: "t@t", token: "jwt" });
const jsonHelper = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const post = (path: string, body: unknown) => new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body) });

const NOW = new Date("2026-10-28T13:00:00.000Z");

function seedMail(db: LocalDb) {
  const d = db._db;
  d.query(`INSERT INTO mail_accounts (id, user_id, provider, email_address) VALUES ('acc', ?, 'gmail', 'me@atlas.dk')`).run(USER);
  d.query(`INSERT INTO mail_threads (id, user_id, account_id, provider_thread_id, subject, participants) VALUES ('t1', ?, 'acc', 'p1', 'Offsite', '["priya@raman.studio","me@atlas.dk"]')`).run(USER);
  const msg = (id: string, from: string, at: string, subject: string, extracted: string) =>
    d.query(
      `INSERT INTO mail_messages (id, user_id, account_id, thread_id, provider_message_id, from_address, subject, snippet, received_at, extracted)
       VALUES (?, ?, 'acc', 't1', ?, ?, ?, ?, ?, ?)`,
    ).run(id, USER, id, from, subject, `${subject} snippet`, at, extracted);
  msg("m1", "Priya Raman <priya@raman.studio>", "2026-10-20T09:00:00.000Z", "Paris deck", '{"direction":"inbound"}');
  msg("m2", "Priya Raman <priya@raman.studio>", "2026-10-28T08:00:00.000Z", "Offsite dates", '{"direction":"inbound"}');
  msg("m3", "Me <me@atlas.dk>", "2026-10-28T09:00:00.000Z", "Re: Offsite dates", '{"direction":"outbound","to_address":"Priya Raman <priya@raman.studio>"}');
  msg("m4", "Peter Andersen <pa@x.dk>", "2026-10-27T09:00:00.000Z", "Unrelated", '{"direction":"inbound"}');
  msg("m5", "Broken <b@x.dk>", "2026-10-27T10:00:00.000Z", "Broken json", "not json");
  const ev = (title: string, start: string, attendees: string) =>
    d.query(`INSERT INTO user_events (id, user_id, title, start_time, attendees) VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), USER, title, start, attendees);
  ev("Lunch with Priya", "2026-10-02T11:00:00.000Z", "[]");
  ev("Design partnership", "2026-10-14T09:00:00.000Z", '["priya@raman.studio"]');
  ev("Offsite planning", "2026-11-03T10:00:00.000Z", '["Priya Raman"]');
  ev("Priyanka's birthday", "2026-11-04T10:00:00.000Z", "[]");
}

describe("findPerson", () => {
  test("finds the address behind the name, the mail both ways, the meetings and the next one", () => {
    const db = freshDb();
    seedMail(db);
    const p = findPerson(db._db, USER, "Priya Raman", NOW);
    expect(p.found).toBe(true);
    expect(p.name).toBe("Priya Raman");
    expect(p.address).toBe("priya@raman.studio");
    expect(p.emails).toBe(3);
    expect(p.threads).toBe(1);
    expect(p.meetings).toBe(2);
    expect(p.nextMeeting?.title).toBe("Offsite planning");
    expect(p.lastContact).toBe("2026-10-28T09:00:00.000Z");
    expect(p.recent[0]).toMatchObject({ kind: "mail-out", title: "Re: Offsite dates", threadId: "t1" });
    expect(p.recent.some((e) => e.kind === "meeting" && e.title === "Design partnership")).toBe(true);
  });
  test("a first name alone finds the same person; a namesake substring does not", () => {
    const db = freshDb();
    seedMail(db);
    expect(findPerson(db._db, USER, "Priya", NOW).address).toBe("priya@raman.studio");
    // "Anders" is inside "Andersen", but not as a word.
    expect(findPerson(db._db, USER, "Anders", NOW).found).toBe(false);
  });
  test("an address works, the user's own mailbox is never the answer, nobody is nobody", () => {
    const db = freshDb();
    seedMail(db);
    expect(findPerson(db._db, USER, "priya@raman.studio", NOW).emails).toBe(3);
    expect(findPerson(db._db, USER, "Me", NOW).address).toBeNull();
    expect(findPerson(db._db, USER, "Zed Nobody", NOW)).toMatchObject({ found: false, emails: 0, recent: [] });
  });
  test("an address inside another address is not that person's mail", () => {
    const db = freshDb();
    seedMail(db);
    db._db.query(
      `INSERT INTO mail_messages (id, user_id, account_id, thread_id, provider_message_id, from_address, subject, snippet, received_at, extracted)
       VALUES ('m9', ?, 'acc', NULL, 'm9', 'Kpriya <kpriya@raman.studio>', 'Other', 's', '2026-10-28T12:00:00.000Z', '{"direction":"inbound"}')`,
    ).run(USER);
    const p = findPerson(db._db, USER, "priya@raman.studio", NOW);
    expect(p.emails).toBe(3);
    expect(p.recent.some((e) => e.title === "Other")).toBe(false);
  });
  test("another user's rows are invisible", () => {
    const db = freshDb();
    seedMail(db);
    expect(findPerson(db._db, "someone-else", "Priya Raman", NOW).found).toBe(false);
  });
});

describe("splitAddress", () => {
  test("headers and bare addresses", () => {
    expect(splitAddress("Priya Raman <Priya@Raman.Studio>")).toEqual({ display: "Priya Raman", addr: "priya@raman.studio" });
    expect(splitAddress('"Raman, Priya" <p@r.s>')).toEqual({ display: "Raman, Priya", addr: "p@r.s" });
    expect(splitAddress("p@r.s")).toEqual({ display: null, addr: "p@r.s" });
  });
});

describe("extractJsonObject", () => {
  test("tolerates fences and prose, refuses the rest", () => {
    expect(extractJsonObject('```json\n{"items":[]}\n```')).toEqual({ items: [] });
    expect(extractJsonObject('Here you go: {"a":1} done')).toEqual({ a: 1 });
    expect(extractJsonObject("[1,2]")).toBeNull();
    expect(extractJsonObject("{not json}")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });
});

describe("routes", () => {
  test("compare: one call with the question and the answer, the object handed back", async () => {
    const db = freshDb();
    const calls: string[] = [];
    const h = createAnswerShapeHandlers({
      db, requireUser: authed, json: jsonHelper, hasKey: () => true,
      complete: async (_s, user) => { calls.push(user); return { text: '{"items":[{"name":"A"},{"name":"B"}],"rows":[],"verdict":"A."}', model: "m" }; },
    });
    const res = await h.compare(post("/answer/compare", { question: "A or B?", answer: "A is cheaper than B." }));
    const body = await res.json();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("A is cheaper than B.");
    expect(body.comparison.items).toHaveLength(2);
    expect(body.promptVersion).toBe("answer-compare-v1");
  });
  test("compare degrades to null, never an error", async () => {
    const db = freshDb();
    const noKey = createAnswerShapeHandlers({ db, requireUser: authed, json: jsonHelper, hasKey: () => false, complete: async () => { throw new Error("must not be called"); } });
    expect(await (await noKey.compare(post("/x", { question: "q", answer: "a" }))).json()).toEqual({ comparison: null, skipped: "no_key" });
    const junk = createAnswerShapeHandlers({ db, requireUser: authed, json: jsonHelper, hasKey: () => true, complete: async () => ({ text: "Sorry, no.", model: "m" }) });
    expect((await (await junk.compare(post("/x", { question: "q", answer: "a" }))).json()).comparison).toBeNull();
    const dead = createAnswerShapeHandlers({ db, requireUser: authed, json: jsonHelper, hasKey: () => true, complete: async () => null });
    expect((await (await dead.compare(post("/x", { question: "q", answer: "a" }))).json()).skipped).toBe("model_unavailable");
    expect((await noKey.compare(post("/x", { question: "q" }))).status).toBe(400);
  });
  test("person: no model, the caller's rows", async () => {
    const db = freshDb();
    seedMail(db);
    const h = createAnswerShapeHandlers({ db, requireUser: authed, json: jsonHelper, now: () => NOW, complete: async () => { throw new Error("no model for this route"); } });
    const body = await (await h.person(post("/answer/person", { name: "Priya Raman" }))).json();
    expect(body.found).toBe(true);
    expect((await h.person(post("/answer/person", { name: "" }))).status).toBe(400);
  });
});
