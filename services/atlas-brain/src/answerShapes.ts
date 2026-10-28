/**
 * The Beta Answer screen's structured shapes (`Atlas Answer Views
 * Beta.dc.html`, left-out rows 27 and 28).
 *
 * POST /answer/compare {question, answer} — the comparison table. ONE cheap
 * model call (the "extraction" tier), no tools, no memory writes, no
 * recursion — the same containment as /mail/draft. It is handed the question
 * and the answer Atlas has already composed for it (with memory recall and
 * tools, through /chat-with-memory) and asked to restate that answer as
 * strict JSON. It may not add a fact: the prompt says so, and the webview
 * checks it — src/lib/betaAnswer.ts `parseComparison` re-validates the shape
 * and drops every row carrying a figure the question and answer never stated.
 * Degradation is never an error: no key, a dead gateway or unparseable output
 * answer 200 with `comparison: null`, and the screen keeps the composed answer.
 *
 * POST /answer/person {name} — who someone is to the user, read from this
 * Mac's mail (`mail_messages`, `mail_threads`) and calendar (`user_events`).
 * NO model call and nothing leaves the Mac: plain SQL over atlas.db, scoped to
 * the caller's own rows like every other route here.
 */

import type { Database } from "bun:sqlite";
import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";
import { selectModel } from "../../../supabase/functions/_shared/providerRouting.ts";
import type { LocalDb } from "./localDb.ts";

/** Bumped when the prompt below changes MEANING, not wording (as mailDraft.ts). */
export const COMPARE_PROMPT_VERSION = "answer-compare-v1";

interface Deps {
  db: LocalDb;
  requireUser: (req: Request) => { userId: string; email: string; token: string };
  json: (body: unknown, status?: number) => Response;
  /** Test seams — production (index.ts) omits these and gets the real gateway. */
  complete?: (system: string, user: string) => Promise<{ text: string; model: string } | null>;
  hasKey?: () => boolean;
  now?: () => Date;
}

/* ---- the comparison ------------------------------------------------------ */

const COMPARE_SYSTEM = [
  "You restate a comparison Atlas has already written as strict JSON for a table. Reply with ONE JSON object and nothing else — no prose, no code fence.",
  'Shape: {"items":[{"name":"…","note":"…"}],"rows":[{"attribute":"…","values":["…","…"],"best":0}],"pick":0,"verdict":"…"}',
  "Rules:",
  "- items: the 2 to 4 things being compared, in the order the answer treats them. note is an optional few words that tell the item apart (an address, a model), or omit it.",
  "- rows: 3 to 10 attributes. values has exactly one entry per item, in item order, each under 40 characters. Write \"—\" where the answer says nothing about that item.",
  "- best: the index of the item that is better on that row, or null when neither is or it is a matter of taste.",
  "- pick: the index of the item the answer recommends overall, or null when it does not recommend one.",
  "- verdict: one sentence under 160 characters, the answer's own conclusion.",
  "- Use ONLY facts stated in the question or the answer. Never add a figure, a price, a date or a score that is not in them.",
  '- If the text does not compare at least two things, reply {"items":[],"rows":[]}.',
].join("\n");

/**
 * The first JSON object in a model reply: code fences and stray prose around
 * it are tolerated, anything that does not parse to an object is null.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(unfenced.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function completeLive(system: string, user: string): Promise<{ text: string; model: string } | null> {
  try {
    const res = await aiChatCompletion({
      // Restating text as JSON is extraction, the cheap tier — the reasoning
      // was already paid for by the answer this is handed.
      model: selectModel("extraction"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 900,
      stream: false,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> };
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return null;
    return { text, model: typeof data?.model === "string" && data.model ? data.model : selectModel("extraction") };
  } catch {
    return null;
  }
}

/* ---- the person ---------------------------------------------------------- */

export interface PersonEvent {
  kind: "mail-in" | "mail-out" | "meeting";
  at: string;
  title: string;
  sub: string | null;
  threadId: string | null;
}

export interface PersonResult {
  found: boolean;
  name: string;
  address: string | null;
  emails: number;
  threads: number;
  meetings: number;
  lastContact: string | null;
  nextMeeting: { title: string; start: string; location: string | null } | null;
  recent: PersonEvent[];
}

/** `Name <addr>` or a bare address → its parts. */
export function splitAddress(raw: string): { display: string | null; addr: string | null } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { display: m[1].trim() || null, addr: m[2].trim().toLowerCase() };
  const bare = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(bare) ? { display: null, addr: bare } : { display: raw.trim() || null, addr: null };
}

/** LIKE needs its own wildcards escaped; the pattern is still bound, never spliced. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const like = (s: string) => `%${likeEscape(s.toLowerCase())}%`;
const wordRe = (s: string) => new RegExp(`(^|[^\\p{L}])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu");

/** The JSON fields of mail_messages.extracted, safe against a malformed row (json_extract would throw). */
const EXTRACTED = "(CASE WHEN json_valid(extracted) THEN extracted ELSE '{}' END)";
const DIRECTION = `json_extract(${EXTRACTED}, '$.direction')`;
const TO_ADDRESS = `lower(coalesce(json_extract(${EXTRACTED}, '$.to_address'), ''))`;

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const NOBODY = (name: string): PersonResult => ({
  found: false, name, address: null, emails: 0, threads: 0, meetings: 0, lastContact: null, nextMeeting: null, recent: [],
});

/**
 * Everything this Mac knows about one person from mail and calendar.
 *
 * The person is the address most often behind the name: messages FROM a
 * "Priya Raman <…>" header or an address shaped like priya.raman@, and
 * messages the user sent TO one. The user's own mailboxes are never the
 * answer. Meetings match on that address or the name among the attendees,
 * or on the first name as a whole word in the title ("Lunch with Priya").
 */
export function findPerson(db: Database, userId: string, asked: string, now: Date = new Date()): PersonResult {
  const name = asked.trim().replace(/\s+/g, " ").slice(0, 80);
  if (name.length < 2) return NOBODY(name);
  const lower = name.toLowerCase();
  const own = new Set(
    (db.query(`SELECT lower(email_address) AS a FROM mail_accounts WHERE user_id = ?`).all(userId) as Array<{ a: string }>).map((r) => r.a),
  );

  // Candidate addresses, by how often they carry the name.
  let address: string | null = null;
  let display: string | null = null;
  if (lower.includes("@")) {
    address = lower;
  } else {
    const parts = lower.split(" ");
    // "priya raman" also as the local part of an address: priya.raman@, priyaraman@, …
    const joined = parts.length > 1 ? [".", "", "_", "-"].map((j) => parts.join(j)) : [];
    const patterns = [like(lower), ...joined.map((j) => `%${likeEscape(j)}%@%`)];
    const where = patterns.map(() => `lower(from_address) LIKE ? ESCAPE '\\'`).join(" OR ");
    const fromRows = db
      .query(`SELECT from_address AS a, COUNT(*) AS n FROM mail_messages WHERE user_id = ? AND from_address IS NOT NULL AND (${where}) GROUP BY lower(from_address) ORDER BY n DESC LIMIT 20`)
      .all(userId, ...patterns) as Array<{ a: string; n: number }>;
    const toWhere = patterns.map(() => `${TO_ADDRESS} LIKE ? ESCAPE '\\'`).join(" OR ");
    const toRows = db
      .query(`SELECT json_extract(${EXTRACTED}, '$.to_address') AS a, COUNT(*) AS n FROM mail_messages WHERE user_id = ? AND ${DIRECTION} = 'outbound' AND (${toWhere}) GROUP BY ${TO_ADDRESS} ORDER BY n DESC LIMIT 20`)
      .all(userId, ...patterns) as Array<{ a: string | null; n: number }>;
    // The name as whole words in a display name, so "Anders" is not "Andersen".
    const nameRe = wordRe(lower);
    const tally = new Map<string, { n: number; display: string | null }>();
    for (const row of [...fromRows, ...toRows]) {
      // A To header can name several people; keep the one that carries the name.
      for (const one of (row.a ?? "").split(/,(?![^<]*>)/)) {
        const { display: d, addr } = splitAddress(one);
        if (!addr || own.has(addr)) continue;
        const local = addr.split("@")[0];
        const carries = (d !== null && nameRe.test(d)) || local === lower || local.startsWith(`${lower}.`) || joined.some((j) => local.includes(j));
        if (!carries) continue;
        const cur = tally.get(addr) ?? { n: 0, display: null };
        tally.set(addr, { n: cur.n + row.n, display: cur.display ?? d });
      }
    }
    const best = [...tally.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    if (best) { address = best[0]; display = best[1].display; }
  }

  let emails = 0;
  let threads = 0;
  const recent: PersonEvent[] = [];
  let lastMail: string | null = null;
  if (address) {
    // The LIKE only narrows: "anna@x.dk" is inside "hanna@x.dk", so every
    // candidate is parsed and kept only when one of its addresses IS this one.
    const a = like(address);
    const rows = db
      .query(
        `SELECT thread_id, subject, snippet, received_at, from_address, ${DIRECTION} AS direction,
                json_extract(${EXTRACTED}, '$.to_address') AS to_address
           FROM mail_messages
          WHERE user_id = ? AND (lower(from_address) LIKE ? ESCAPE '\\' OR (${DIRECTION} = 'outbound' AND ${TO_ADDRESS} LIKE ? ESCAPE '\\'))
          ORDER BY received_at DESC
          LIMIT 5000`,
      )
      .all(userId, a, a) as Array<{
        thread_id: string | null; subject: string | null; snippet: string | null; received_at: string | null;
        from_address: string | null; direction: string | null; to_address: unknown;
      }>;
    const addrsOf = (raw: unknown) =>
      typeof raw === "string" ? raw.split(/,(?![^<]*>)/).map((one) => splitAddress(one).addr).filter((x): x is string => !!x) : [];
    const mine = rows.filter((m) =>
      splitAddress(m.from_address ?? "").addr === address || (m.direction === "outbound" && addrsOf(m.to_address).includes(address as string)),
    );
    emails = mine.length;
    threads = new Set(mine.map((m) => m.thread_id).filter((t): t is string => !!t)).size;
    const dated = mine.filter((m): m is typeof m & { received_at: string } => !!m.received_at && Number.isFinite(Date.parse(m.received_at)));
    for (const m of dated.slice(0, 4)) {
      recent.push({
        kind: m.direction === "outbound" ? "mail-out" : "mail-in",
        at: m.received_at,
        title: clip(m.subject, 120) || "(no subject)",
        sub: clip(m.snippet, 140) || null,
        threadId: m.thread_id,
      });
    }
    lastMail = dated[0]?.received_at ?? null;
  }

  // Meetings: the address or the name among the attendees, or the first name
  // as a whole word in the title. The LIKE narrows; the regex decides.
  const first = (display ?? name).split(/[\s@.]/)[0].toLowerCase();
  // Two reads, so a long calendar history cannot push the next meeting out
  // of a single LIMIT: the most recent past ones and the upcoming ones.
  const eventSql = (cmp: "<" | ">=", order: "ASC" | "DESC") =>
    `SELECT title, start_time, location, attendees FROM user_events
      WHERE user_id = ? AND start_time ${cmp} ? AND (lower(attendees) LIKE ? ESCAPE '\\' OR lower(attendees) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\')
      ORDER BY start_time ${order} LIMIT 200`;
  const nowIso = now.toISOString();
  const eventArgs = [userId, nowIso, like(address ?? lower), like(display ?? lower), like(first)] as const;
  type EventRow = { title: string; start_time: string; location: string | null; attendees: string | null };
  const eventRows = [
    ...(db.query(eventSql("<", "DESC")).all(...eventArgs) as EventRow[]).reverse(),
    ...(db.query(eventSql(">=", "ASC")).all(...eventArgs) as EventRow[]),
  ];
  const fullRe = wordRe(lower);
  const firstRe = first.length >= 2 ? wordRe(first) : null;
  const events = eventRows.filter((e) => {
    const att = (e.attendees ?? "").toLowerCase();
    return (address && att.includes(address)) || fullRe.test(att) || (display && att.includes(display.toLowerCase())) || fullRe.test(e.title) || (firstRe?.test(e.title) ?? false);
  });
  const t = now.getTime();
  const past = events.filter((e) => Date.parse(e.start_time) < t);
  const upcoming = events.find((e) => Date.parse(e.start_time) >= t) ?? null;
  for (const e of past.slice(-2).reverse()) {
    recent.push({ kind: "meeting", at: e.start_time, title: clip(e.title, 120), sub: e.location ? clip(e.location, 140) : null, threadId: null });
  }
  recent.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));

  const lastMeeting = past.length ? past[past.length - 1].start_time : null;
  const lastContact = [lastMail, lastMeeting].filter((x): x is string => !!x).sort((x, y) => Date.parse(y) - Date.parse(x))[0] ?? null;
  const found = emails > 0 || events.length > 0;
  if (!found) return NOBODY(name);
  return {
    found,
    name: display ?? name,
    address,
    emails,
    threads,
    meetings: past.length,
    lastContact,
    nextMeeting: upcoming ? { title: clip(upcoming.title, 120), start: upcoming.start_time, location: upcoming.location } : null,
    recent: recent.slice(0, 5),
  };
}

/* ---- the routes ---------------------------------------------------------- */

export function createAnswerShapeHandlers({ db, requireUser, json, complete = completeLive, hasKey = hasAIKey, now = () => new Date() }: Deps) {
  async function compare(req: Request): Promise<Response> {
    requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { question?: unknown; answer?: unknown };
    const question = typeof body.question === "string" ? body.question.trim().slice(0, 500) : "";
    const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 8000) : "";
    if (!question || !answer) return json({ error: "question and answer are required" }, 400);
    if (!hasKey()) return json({ comparison: null, skipped: "no_key" });
    const out = await complete(COMPARE_SYSTEM, `Question: ${question}\n\nAtlas's answer:\n${answer}`);
    if (!out) return json({ comparison: null, skipped: "model_unavailable" });
    const comparison = extractJsonObject(out.text);
    if (!comparison) return json({ comparison: null, skipped: "unparseable", model: out.model });
    return json({ comparison, model: out.model, promptVersion: COMPARE_PROMPT_VERSION });
  }

  async function person(req: Request): Promise<Response> {
    const { userId } = requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 80) return json({ error: "name is required" }, 400);
    return json(findPerson(db._db, userId, name, now()));
  }

  return { compare, person };
}
