/**
 * POST /greeting — the launch greeting, STAGE 2.
 *
 * Stage 1 is deterministic and lives in the frontend ("Good morning, Magnus").
 * It always renders. This route is the OPTIONAL second stage: one cheap model
 * call that turns real, already-stored signal into one or two sentences, plus
 * the salience it drew on so the UI can show WHY Atlas spoke.
 *
 * THE WHOLE RISK IS FABRICATION. This is the first thing the user hears on
 * launch; a greeting that invents a meeting, a message or a health figure sets
 * their trust for the entire session, and one invented meeting is worse than a
 * thousand honest "Good morning"s. So the route is built to fail CLOSED, and
 * every layer below is a separate refusal:
 *
 *   1. No signal, no call. `gatherSalience` reads atlas.db and returns typed
 *      facts. Zero facts ⇒ the route returns greeting:null WITHOUT calling the
 *      model at all. A user with nothing going on cannot be given a plausible
 *      invention because no model ever runs for them.
 *   2. The model is handed the facts and told it may state nothing else.
 *   3. It must name which facts it used, by index. Indices that don't exist are
 *      dropped; if nothing real survives, the greeting is discarded.
 *   4. Numeric grounding: every digit-run in the greeting must appear in the
 *      facts block. A time, a count or a figure that is not in the facts is the
 *      signature of an invented detail, and it is refused. This can reject a
 *      true-but-unquotable greeting ("2 things today" when no fact contains
 *      "2"); that is the intended direction of the trade — the cost of a false
 *      refusal is the deterministic greeting, the cost of a false accept is the
 *      user's trust.
 *
 * DEGRADATION IS NEVER AN ERROR. Every failure path — no key, no signal, dead
 * gateway, unusable output — answers HTTP 200 with `greeting: null` and a
 * `skipped` reason. The frontend keeps its deterministic greeting; it must
 * never show an error where a hello belongs.
 *
 * NOT the proactive digest. `filterInsights` in proactive.ts:95-96 has a
 * GENERIC_RE that explicitly REJECTS greeting-shaped output ("hope you're",
 * "have a great", "happy monday", …) — correct there, fatal here. This module
 * imports nothing from proactive.ts and its output never passes through that
 * filter; the "greeting output would be destroyed by the insight filter" test
 * runs a real greeting through filterInsights to show what would happen, and
 * asserts this module never imports it — so the separation stays deliberate
 * rather than incidental.
 */

import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";
import { selectModel } from "../../../supabase/functions/_shared/providerRouting.ts";
import type { LocalDb } from "./localDb.ts";

/** Bumped when the prompt below changes MEANING, not wording (as mailDraft.ts). */
const GREETING_PROMPT_VERSION = "greeting-v1";

/**
 * How many facts reach the model.
 *
 * FOUR, because this is a greeting, not a briefing: one or two sentences cannot
 * honestly carry more, and every extra fact is prompt tokens paid on every
 * single launch for a line the model will not write.
 */
const MAX_FACTS = 4;

/** Salience horizon for "coming up": the rest of the user's day, near enough. */
const EVENT_WINDOW_HOURS = 12;

export interface SalienceFact {
  /** Which signal this came from. The UI groups by this. */
  kind: "birthday" | "event" | "task" | "insight";
  /** Human-readable, and the ONLY text the model is allowed to draw on. */
  text: string;
}

interface Deps {
  db: LocalDb;
  requireUser: (req: Request) => { userId: string; email: string; token: string };
  json: (body: unknown, status?: number) => Response;
  /** Test seams — production (index.ts) omits these and gets the real gateway. */
  complete?: (system: string, user: string) => Promise<{ text: string; model: string } | null>;
  hasKey?: () => boolean;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Clock helpers
//
// DUPLICATED FROM orchestrator.ts ON PURPOSE, and it should not stay that way.
// `getTimeOfDay` and `isBirthday` are module-private there (they back the
// "It's ${timeOfDay} for them, greet appropriately" and birthday lines inside
// buildPersonalizedPrompt), and this module does not own that file, so it
// cannot export them. Calling buildPersonalizedPrompt instead was considered
// and rejected twice over: it returns a multi-thousand-token system prompt —
// memories, knowledge bank, tool instructions, the whole memory-capture
// contract — which is the wrong bill to pay on every launch, and it exposes the
// composed STRING, not the time-of-day value this route needs to reason about.
// The required orchestrator change is reported to the orchestrator's owner.

function getTimeOfDay(timezone: string): string {
  try {
    const hour = parseInt(
      new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: timezone }),
    );
    if (hour >= 5 && hour < 12) return "morning";
    if (hour >= 12 && hour < 17) return "afternoon";
    if (hour >= 17 && hour < 21) return "evening";
    return "night";
  } catch {
    return "day";
  }
}

function isBirthday(birthday: string | null, now: Date): boolean {
  if (!birthday) return false;
  const bday = new Date(birthday);
  if (Number.isNaN(bday.getTime())) return false;
  return now.getMonth() === bday.getMonth() && now.getDate() === bday.getDate();
}

/**
 * Local clock time for an ISO instant, e.g. "10:00".
 *
 * Formatted rather than passed through as ISO because the numeric-grounding
 * gate below allows exactly the digit-runs present in the facts: a raw
 * `2026-08-08T08:00:00.000Z` would whitelist "2026", "08" and "00" and let a
 * fabricated figure slip through on a coincidence. A short local time keeps the
 * allowed set as small as the fact actually is.
 */
function localTime(iso: string, timezone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  } catch {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
}

// ---------------------------------------------------------------------------
// Signal

interface Profile {
  first_name: string | null;
  nickname: string | null;
  birthday: string | null;
  timezone: string | null;
}

export interface Salience {
  facts: SalienceFact[];
  userName: string;
  timeOfDay: string;
  timezone: string;
}

/**
 * Everything the greeting is allowed to know, read from atlas.db.
 *
 * Only rows the user (or their own synced data) put there. Nothing is derived,
 * inferred or estimated: if it is not a row, it is not a fact, and if there are
 * no facts the caller must not call a model.
 */
export function gatherSalience(db: LocalDb, userId: string, now: Date): Salience {
  const profile = db._db
    .query(`SELECT first_name, nickname, birthday, timezone FROM profiles WHERE user_id = ?`)
    .get(userId) as Profile | null;

  const timezone = profile?.timezone || "UTC";
  const userName = profile?.nickname || profile?.first_name || "there";
  const facts: SalienceFact[] = [];

  if (isBirthday(profile?.birthday ?? null, now)) {
    facts.push({ kind: "birthday", text: "Today is their birthday." });
  }

  const iso = now.toISOString();
  const horizon = new Date(now.getTime() + EVENT_WINDOW_HOURS * 3600 * 1000).toISOString();
  const events = db._db
    .query(
      `SELECT title, start_time FROM user_events
        WHERE user_id = ? AND start_time >= ? AND start_time <= ?
        ORDER BY start_time LIMIT 2`,
    )
    .all(userId, iso, horizon) as Array<{ title: string; start_time: string }>;
  for (const e of events) {
    const at = localTime(e.start_time, timezone);
    facts.push({ kind: "event", text: at ? `"${e.title}" at ${at}` : `"${e.title}" coming up` });
  }

  // Overdue and due-today first — an undated task is not news at launch.
  const endOfWindow = horizon;
  const tasks = db._db
    .query(
      `SELECT title FROM user_tasks
        WHERE user_id = ? AND completed = 0 AND due_date IS NOT NULL AND due_date <= ?
        ORDER BY due_date LIMIT 2`,
    )
    .all(userId, endOfWindow) as Array<{ title: string }>;
  for (const t of tasks) facts.push({ kind: "task", text: `open task "${t.title}", due today or overdue` });

  // The digest already decided this was worth surfacing; unread means unseen.
  const insight = db._db
    .query(
      `SELECT title FROM ai_insights
        WHERE user_id = ? AND is_read = 0
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId) as { title: string } | null;
  if (insight?.title) facts.push({ kind: "insight", text: `unread note from Atlas: "${insight.title}"` });

  return { facts: facts.slice(0, MAX_FACTS), userName, timeOfDay: getTimeOfDay(timezone), timezone };
}

// ---------------------------------------------------------------------------
// Prompting and grounding

export function greetingSystemPrompt(): string {
  return (
    "You write Atlas's spoken greeting when the user opens the app. One or two short sentences, " +
    "warm and plain, second person, no emoji, no questions stacked on questions.\n\n" +
    "GROUNDING IS ABSOLUTE. You will be given a numbered FACTS list. You may state ONLY what those " +
    "facts say. Do not add a meeting, a message, a number, a time, a name or a figure that is not " +
    "written there — not as a guess, not as a likely detail, not as a rounded version of one. If a " +
    "fact is thin, say less. Referring to the time of day is fine; inventing anything is not.\n\n" +
    'Respond ONLY with JSON: {"greeting": "...", "used": [0, 2]} where "used" lists the indices of ' +
    "the facts you actually referred to. If you cannot write something worth saying from these " +
    'facts alone, respond {"greeting": null, "used": []}.'
  );
}

export function greetingUserPrompt(s: Salience): string {
  const lines = s.facts.map((f, i) => `${i}. [${f.kind}] ${f.text}`);
  return (
    `Their name: ${s.userName}\n` +
    `It is ${s.timeOfDay} where they are.\n\n` +
    `FACTS:\n${lines.join("\n")}`
  );
}

interface Parsed {
  greeting: string | null;
  used: number[];
}

/** First JSON object in the model's output; null when there isn't one. */
function parseModelJson(content: string | null): Parsed | null {
  if (!content) return null;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]) as { greeting?: unknown; used?: unknown };
    const greeting = typeof v?.greeting === "string" && v.greeting.trim() ? v.greeting.trim() : null;
    const used = Array.isArray(v?.used)
      ? v.used.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
      : [];
    return { greeting, used };
  } catch {
    return null;
  }
}

/**
 * Does every number in the greeting appear in the facts it was built from?
 *
 * The cheapest reliable fabrication tell. Free prose ("your morning looks
 * light") cannot be checked mechanically, but an invented SPECIFIC almost
 * always carries a digit — a time, a count, a figure — and a digit-run absent
 * from the facts cannot have been read from them. Exported so the test can hold
 * it directly.
 */
export function numbersAreGrounded(greeting: string, factsText: string): boolean {
  const inFacts = new Set(factsText.match(/\d+/g) ?? []);
  for (const n of greeting.match(/\d+/g) ?? []) {
    if (!inFacts.has(n)) return false;
  }
  return true;
}

/**
 * One non-streaming cheap-tier call. Returns null on ANY failure — a launch
 * greeting has no one to report an exception to, and the caller's answer to
 * null is the deterministic greeting the user already has on screen.
 */
async function completeLive(system: string, user: string): Promise<{ text: string; model: string } | null> {
  try {
    const res = await aiChatCompletion({
      // Cheap tier (providerRouting "summary" ⇒ Haiku 4.5 on the Claude
      // adapter). This runs on EVERY launch, so the tier is the cost decision,
      // not a quality one — a greeting is not a reasoning task.
      model: selectModel("summary"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // Two sentences plus the JSON envelope. A ceiling here is also a latency
      // ceiling on the first thing the user sees.
      max_tokens: 200,
      stream: false,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return null;
    return { text, model: typeof data?.model === "string" && data.model ? data.model : selectModel("summary") };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route

export function createGreetingHandlers({
  db,
  requireUser,
  json,
  complete = completeLive,
  hasKey = hasAIKey,
  now = () => new Date(),
}: Deps) {
  // POST /greeting {} → {ok, greeting, salience, model?, promptVersion, skipped?}
  async function greeting(req: Request): Promise<Response> {
    const { userId } = requireUser(req);

    const salience = gatherSalience(db, userId, now());

    // Every early return is a 200 with greeting:null. See the header: the
    // frontend's deterministic greeting is the fallback, and an error status
    // here would put a failure banner where a hello belongs.
    const skip = (reason: string) =>
      json({ ok: true, greeting: null, salience: [], promptVersion: GREETING_PROMPT_VERSION, skipped: reason });

    if (salience.facts.length === 0) return skip("no-salience");
    if (!hasKey()) return skip("no-key");

    const userPrompt = greetingUserPrompt(salience);
    const result = await complete(greetingSystemPrompt(), userPrompt);
    if (!result) return skip("model-failed");

    const parsed = parseModelJson(result.text);
    if (!parsed?.greeting) return skip("no-greeting");

    // Indices the model invented are not evidence of anything; drop them, then
    // require that something real survives. A greeting citing no real fact is
    // exactly the shape a fabricated one takes.
    const used = parsed.used
      .filter((i) => i >= 0 && i < salience.facts.length)
      .map((i) => salience.facts[i]);
    if (used.length === 0) return skip("ungrounded");

    if (!numbersAreGrounded(parsed.greeting, userPrompt)) return skip("ungrounded-number");

    return json({
      ok: true,
      greeting: parsed.greeting,
      salience: used,
      // The provider's own echo of what answered, same reasoning as
      // mailDraft.ts: the logical routing id stops being true the moment
      // providerRouting's mapping moves on.
      model: result.model,
      promptVersion: GREETING_PROMPT_VERSION,
    });
  }

  return { greeting };
}
