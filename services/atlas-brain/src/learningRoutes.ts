/**
 * Learning / research / memory-maintenance routes (Phase 1 local cut).
 *
 * Local, contained replacements for the atlas-control, atlas-research and
 * memory-maintenance edge functions. HARD CONTAINMENT: /research performs
 * exactly ONE AI pass per call — no recursion, no self-fetch, no sub-topics.
 * Phase 2 swaps the provider (Claude + web_search); the route contract stays.
 */

import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";
import type { LocalDb } from "./localDb.ts";

interface Deps {
  db: LocalDb;
  requireUser: (req: Request) => { userId: string; email: string; token: string };
  json: (body: unknown, status?: number) => Response;
}

const nowIso = () => new Date().toISOString();

// Keys the app may change via update_settings — mirrors atlas-control's
// allowlist plus the toggles the local UI owns. Everything else is server-side.
const SETTINGS_UPDATABLE = new Set([
  "learning_enabled",
  "learning_mode",
  "max_topics_per_session",
  "max_research_depth",
  "auto_validation",
  "auto_knowledge_extraction",
  "auto_switch_enabled",
  "budget_switch_threshold_pct",
  "preferred_cheap_provider",
  "global_discovery_enabled",
]);

/** One non-streaming completion; returns the raw text content or null. */
async function completeText(system: string, user: string): Promise<string | null> {
  try {
    const res = await aiChatCompletion({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** Extract the first JSON object/array from model output (fenced or bare). */
function parseModelJson(content: string | null): unknown | null {
  if (!content) return null;
  const match = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// atlas_system_settings is a single-row table (no user_id column); the row id
// is seeded from the JWT userId so re-seeding stays idempotent per user.
async function getOrSeedSettings(db: LocalDb, userId: string): Promise<Record<string, unknown>> {
  const read = async () => {
    const { data } = await db.from("atlas_system_settings").select().limit(1);
    return (data as Record<string, unknown>[] | null)?.[0] ?? null;
  };
  let row = await read();
  if (!row) {
    // Only the id — every other column takes its db_schema.sql default.
    db._db.query(`INSERT OR IGNORE INTO atlas_system_settings (id) VALUES (?)`).run(userId);
    row = await read();
  }
  return row ?? {};
}

function countActiveSessions(db: LocalDb, userId: string): number {
  const row = db._db
    .query(`SELECT COUNT(*) AS c FROM atlas_learning_sessions WHERE user_id = ? AND status IN ('active','researching')`)
    .get(userId) as { c: number } | null;
  return row?.c ?? 0;
}

/** sqlite changes() for the last statement on this connection. */
function lastChanges(db: LocalDb): number {
  const row = db._db.query(`SELECT changes() AS c`).get() as { c: number } | null;
  return row?.c ?? 0;
}

// The single research pass shared by create/resume. Summarises what the model
// already knows (no web in Phase 1), writes findings + one knowledge entry,
// marks topic + session completed. Exactly one AI call — never recurses.
async function runResearchPass(
  db: LocalDb,
  userId: string,
  topicRow: { id: string; topic: string; learning_session_id?: string | null },
  sessionId: string,
): Promise<"completed" | "queued"> {
  const content = await completeText(
    "You are Atlas's local research process. Summarise what you know about the topic in 2-4 dense paragraphs. " +
      'Respond ONLY with JSON: {"summary": "..."}',
    `Topic: ${topicRow.topic}`,
  );
  if (!content) {
    // No usable completion — leave the work queued for a later pass.
    await db.from("atlas_research_topics").update({ status: "queued", updated_at: nowIso() }).eq("id", topicRow.id);
    await db.from("atlas_learning_sessions").update({ status: "queued" }).eq("id", sessionId);
    return "queued";
  }
  const parsed = parseModelJson(content) as { summary?: unknown } | null;
  const summary = typeof parsed?.summary === "string" ? parsed.summary : content;

  await db
    .from("atlas_research_topics")
    .update({
      findings: [{ summary, created_at: nowIso() }],
      status: "completed",
      completed_at: nowIso(),
      updated_at: nowIso(),
    })
    .eq("id", topicRow.id);

  await db.from("atlas_knowledge_entries").insert({
    user_id: userId,
    category: "research",
    topic: topicRow.topic,
    content: { summary },
    source: "local-research",
    confidence: 0.5,
    research_topic_id: topicRow.id,
    learning_session_id: sessionId,
  });

  await db.from("atlas_learning_sessions").update({ status: "completed", ended_at: nowIso() }).eq("id", sessionId);
  return "completed";
}

export function createLearningHandlers({ db, requireUser, json }: Deps) {
  // POST /learning/control — start/stop/status/update for the learning system.
  async function control(req: Request): Promise<Response> {
    const { userId } = requireUser(req);
    const { action, settings: patch } = (await req.json().catch(() => ({}))) as {
      action?: string;
      settings?: Record<string, unknown>;
    };

    let settings = await getOrSeedSettings(db, userId);
    const settingsId = settings.id as string;

    if (action === "start_learning" || action === "stop_learning") {
      await db
        .from("atlas_system_settings")
        .update({ learning_enabled: action === "start_learning", updated_at: nowIso() })
        .eq("id", settingsId);
      settings = await getOrSeedSettings(db, userId);
    } else if (action === "update_settings") {
      const update: Record<string, unknown> = {};
      for (const k in patch ?? {}) {
        if (SETTINGS_UPDATABLE.has(k)) update[k] = (patch as Record<string, unknown>)[k];
      }
      if (Object.keys(update).length) {
        update.updated_at = nowIso();
        await db.from("atlas_system_settings").update(update).eq("id", settingsId);
        settings = await getOrSeedSettings(db, userId);
      }
    } else if (action !== "get_status") {
      return json({ error: `Unknown action: ${action}` }, 400);
    }

    return json({ ok: true, settings, activeSessions: countActiveSessions(db, userId) });
  }

  // POST /learning/cycle — one minimal local brain cycle: recent memories +
  // knowledge in, 1-3 proactive insights out (ai_insights rows).
  async function cycle(req: Request): Promise<Response> {
    const { userId } = requireUser(req);
    await req.json().catch(() => ({}));
    if (!hasAIKey()) return json({ ok: false, insightsCreated: 0, error: "No AI key" });

    const mems = db._db
      .query(`SELECT key, value FROM ai_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`)
      .all(userId) as Array<{ key: string; value: string }>;
    const knowledge = db._db
      .query(`SELECT topic, content FROM atlas_knowledge_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`)
      .all(userId) as Array<{ topic: string; content: string }>;

    const context = [
      ...mems.map((m) => `memory ${m.key}: ${String(m.value).slice(0, 300)}`),
      ...knowledge.map((k) => `knowledge ${k.topic}: ${String(k.content).slice(0, 300)}`),
    ].join("\n");
    if (!context) return json({ ok: true, insightsCreated: 0 });

    const parsed = parseModelJson(
      await completeText(
        "You are Atlas's background learning process. From the user's recent memories and knowledge, produce 1-3 short, " +
          "genuinely useful proactive insights (connections, follow-ups, things worth surfacing). " +
          'Respond ONLY with a JSON array: [{"title": "...", "content": "..."}]',
        context,
      ),
    );

    let insightsCreated = 0;
    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(0, 3)) {
        const title = typeof item?.title === "string" ? item.title.slice(0, 200) : null;
        const content = typeof item?.content === "string" ? item.content : null;
        if (!title || !content) continue;
        await db.from("ai_insights").insert({
          user_id: userId,
          insight_type: "learning",
          title,
          content,
          is_spoken: false,
          created_at: nowIso(),
        });
        insightsCreated++;
      }
    }
    return json({ ok: true, insightsCreated });
  }

  // POST /learning/intent — classify whether a chat message asks Atlas to learn.
  async function intent(req: Request): Promise<Response> {
    requireUser(req);
    const { message } = (await req.json().catch(() => ({}))) as { message?: string };
    if (!message || typeof message !== "string" || !hasAIKey()) {
      return json({ isLearningRequest: false, topic: null });
    }

    const parsed = parseModelJson(
      await completeText(
        "Classify whether the user's message explicitly asks the assistant to learn about, research, or study a topic. " +
          'Respond ONLY with JSON: {"isLearningRequest": true|false, "topic": "the topic"|null}',
        message,
      ),
    ) as { isLearningRequest?: unknown; topic?: unknown } | null;

    return json({
      isLearningRequest: parsed?.isLearningRequest === true,
      topic: typeof parsed?.topic === "string" && parsed.topic ? parsed.topic : null,
    });
  }

  // POST /research — create a topic (or resume one) and run the single pass.
  async function research(req: Request): Promise<Response> {
    const { userId } = requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      topic?: string;
      topicId?: string;
    };

    if (body.action === "create") {
      if (!body.topic || typeof body.topic !== "string") return json({ error: "topic is required" }, 400);
      const queued = !hasAIKey();

      const { data: session } = await db
        .from("atlas_learning_sessions")
        .insert({ user_id: userId, topic: body.topic, status: queued ? "queued" : "active", trigger_type: "text" })
        .select()
        .single();
      const sessionId = (session as { id: string }).id;

      const { data: topicRow } = await db
        .from("atlas_research_topics")
        .insert({
          user_id: userId,
          topic: body.topic,
          status: queued ? "queued" : "researching",
          depth_level: 0,
          learning_session_id: sessionId,
        })
        .select()
        .single();
      const topic = topicRow as { id: string; topic: string };

      const status = queued ? "queued" : await runResearchPass(db, userId, topic, sessionId);
      return json({ ok: true, topicId: topic.id, sessionId, status });
    }

    if (body.action === "resume") {
      if (!body.topicId) return json({ error: "topicId is required" }, 400);
      const { data } = await db
        .from("atlas_research_topics")
        .select()
        .eq("id", body.topicId)
        .eq("user_id", userId)
        .maybeSingle();
      const topic = data as { id: string; topic: string; learning_session_id?: string | null } | null;
      if (!topic) return json({ error: "topic not found" }, 404);

      let sessionId = topic.learning_session_id ?? null;
      if (!sessionId) {
        const { data: session } = await db
          .from("atlas_learning_sessions")
          .insert({ user_id: userId, topic: topic.topic, status: "active", trigger_type: "text" })
          .select()
          .single();
        sessionId = (session as { id: string }).id;
        await db.from("atlas_research_topics").update({ learning_session_id: sessionId }).eq("id", topic.id);
      }

      if (!hasAIKey()) {
        await db.from("atlas_research_topics").update({ status: "queued", updated_at: nowIso() }).eq("id", topic.id);
        return json({ ok: true, topicId: topic.id, sessionId, status: "queued" });
      }
      await db.from("atlas_research_topics").update({ status: "researching", updated_at: nowIso() }).eq("id", topic.id);
      const status = await runResearchPass(db, userId, topic, sessionId);
      return json({ ok: true, topicId: topic.id, sessionId, status });
    }

    return json({ error: `Unknown action: ${body.action}` }, 400);
  }

  // POST /memory/maintenance — consolidate duplicates, prune stale low-value
  // memories, and (full) extract communication-style insights. User-scoped.
  async function memoryMaintenance(req: Request): Promise<Response> {
    const { userId } = requireUser(req);
    const { operation = "full" } = (await req.json().catch(() => ({}))) as { operation?: string };

    let consolidated = 0;
    let pruned = 0;
    let insights = 0;

    if (operation === "full" || operation === "consolidate") {
      // Duplicate keys: keep the newest row per (user_id, key), drop the rest.
      db._db
        .query(
          `DELETE FROM ai_memory
           WHERE user_id = $user
             AND id NOT IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC, id DESC) AS rn
                 FROM ai_memory WHERE user_id = $user
               ) WHERE rn = 1
             )`,
        )
        .run({ $user: userId });
      consolidated = lastChanges(db);
    }

    if (operation === "full" || operation === "prune") {
      db._db
        .query(
          `DELETE FROM ai_memory
           WHERE user_id = ?
             AND importance <= 2
             AND mention_count <= 1
             AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')`,
        )
        .run(userId);
      pruned = lastChanges(db);
    }

    if (operation === "full" && hasAIKey()) {
      const recent = db._db
        .query(`SELECT key, value FROM ai_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30`)
        .all(userId) as Array<{ key: string; value: string }>;
      if (recent.length) {
        const parsed = parseModelJson(
          await completeText(
            "From the user's recent memories, extract up to 2 communication-style or preference insights " +
              "(tone, format, language, recurring preferences). " +
              'Respond ONLY with a JSON array: [{"key": "style_...", "value": "..."}]',
            recent.map((m) => `${m.key}: ${String(m.value).slice(0, 300)}`).join("\n"),
          ),
        );
        if (Array.isArray(parsed)) {
          for (const item of parsed.slice(0, 2)) {
            const key = typeof item?.key === "string" ? item.key.slice(0, 100) : null;
            const value = typeof item?.value === "string" ? item.value : null;
            if (!key || !value) continue;
            await db.from("ai_memory").insert({
              user_id: userId,
              key,
              value,
              category: "communication_style",
              memory_type: "insight",
              importance: 6,
            });
            insights++;
          }
        }
      }
    }

    return json({ ok: true, consolidated, pruned, insights });
  }

  return { control, cycle, intent, research, memoryMaintenance };
}
