import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";
import { isLearningEnabled, isLovableAIEnabled } from "../_shared/providerStatus.ts";
import { findOrCreateSession } from "../_shared/learningGuards.ts";

// The one scheduled learning cycle. Runs once a day (cron) and ONLY follows
// up on topics the user actually discussed recently — it never invents topics
// from global knowledge scans. Output is a handful of ai_insights rows, which
// the frontend (useProactiveAI) already subscribes to and speaks.
//
// Invoke with { "dryRun": true } to see which topics would run without
// spending anything.

const MAX_DIGEST_TOPICS = 3;
const LOOKBACK_DAYS = 3;
const DIGEST_BUDGET_CENTS = 10;

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { dryRun = false } = await req.json().catch(() => ({}));
    const supabase = getSupabaseClient();
    const SUPABASE_URL = getSupabaseUrl();
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Gates: master kill switch and learning flag (the budget auto-disable in
    // record-usage-snapshot flips learning_enabled when over budget, so this
    // check covers budget exhaustion too).
    const aiStatus = await isLovableAIEnabled(supabase);
    if (!aiStatus.enabled) {
      return jsonResponse({ success: false, reason: "ai_disabled" });
    }
    const learning = await isLearningEnabled(supabase);
    if (!learning.enabled) {
      return jsonResponse({ success: false, reason: "learning_disabled" });
    }

    // Input: the user's own recent conversation topics — nothing else.
    const lookback = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSessions } = await supabase
      .from("atlas_learning_sessions")
      .select("root_topic, user_id, created_at")
      .gt("created_at", lookback)
      .neq("trigger_type", "daily_digest")
      .not("root_topic", "is", null)
      .order("created_at", { ascending: false });

    const seen = new Set<string>();
    const topics: Array<{ topic: string; userId: string | null }> = [];
    for (const s of recentSessions || []) {
      const t = (s.root_topic || "").trim();
      if (!t || t.toLowerCase() === "general") continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      topics.push({ topic: t, userId: s.user_id });
      if (topics.length >= MAX_DIGEST_TOPICS) break;
    }

    if (topics.length === 0) {
      return jsonResponse({ success: true, insights: 0, reason: "no_recent_topics" });
    }

    if (dryRun) {
      return jsonResponse({ success: true, dryRun: true, plannedTopics: topics.map((t) => t.topic) });
    }

    const userId = topics.find((t) => t.userId)?.userId ?? null;

    // One tightly-budgeted session for the whole digest
    const session = await findOrCreateSession(supabase, {
      userId,
      conversationId: null,
      rootTopic: `daily digest ${new Date().toISOString().slice(0, 10)}`,
      triggerType: "daily_digest",
      budgetCents: DIGEST_BUDGET_CENTS,
    });
    if (!session) {
      return errorResponse("Failed to create digest session", 500);
    }

    const insights: Array<{ topic: string; summary: string }> = [];

    for (const { topic } of topics) {
      // Follow-up framing: we're not re-learning the topic, we're checking
      // what changed. No dedup here (the base topic is known by design) and
      // no auto-deepen (digest is follow-up, not exploration).
      const digestTopic = `Recent developments: ${topic}`;

      const { data: created, error: insertError } = await supabase
        .from("atlas_research_topics")
        .insert({
          user_id: userId,
          topic: digestTopic,
          description: `Daily digest follow-up on the user's recent conversation topic "${topic}". Focus only on new or time-sensitive information.`,
          status: "queued",
          depth_level: 0,
          priority: 5,
          auto_generated: true,
          findings: [],
          sources: [],
          learning_session_id: session.id,
        })
        .select("id")
        .single();

      if (insertError) {
        console.log(`[daily-digest] Topic rejected (session limits): ${insertError.message}`);
        continue;
      }

      const response = await fetch(`${SUPABASE_URL}/functions/v1/atlas-research`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          topicId: created.id,
          action: "start",
          autoDeepen: false,
          learningSessionId: session.id,
        }),
      }).catch((e) => {
        console.error(`[daily-digest] Research failed for ${topic}:`, e);
        return null;
      });

      if (response?.ok) {
        const { data: completedTopic } = await supabase
          .from("atlas_research_topics")
          .select("findings")
          .eq("id", created.id)
          .single();
        const findings = (completedTopic?.findings as Array<{ title?: string; summary?: string }>) || [];
        if (findings.length > 0 && findings[0].summary) {
          insights.push({ topic, summary: findings[0].summary });
        }
      }
    }

    // Speakable insights — capped, deduped against the last 48h
    let insightsCreated = 0;
    if (userId) {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      for (const insight of insights.slice(0, MAX_DIGEST_TOPICS)) {
        const title = `Update on ${insight.topic}`;
        const { data: existing } = await supabase
          .from("ai_insights")
          .select("id")
          .eq("user_id", userId)
          .eq("title", title)
          .gt("created_at", twoDaysAgo)
          .limit(1);
        if (existing && existing.length > 0) continue;

        const { error: insightError } = await supabase.from("ai_insights").insert({
          user_id: userId,
          insight_type: "pattern",
          title,
          content: `You talked about ${insight.topic} recently — here's what's new: ${insight.summary}`,
          priority: 4,
        });
        if (!insightError) insightsCreated++;
      }
    }

    // Same run: memory consolidation + synthesized insights (birthdays,
    // follow-ups, patterns). These functions existed but had no cron.
    await fetch(`${SUPABASE_URL}/functions/v1/memory-scheduler`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation: "full" }),
    }).catch((e) => console.error("[daily-digest] memory-scheduler failed:", e));

    console.log(`[daily-digest] Done: ${insights.length} researched, ${insightsCreated} insights created`);

    return jsonResponse({
      success: true,
      sessionId: session.id,
      topicsResearched: insights.length,
      insights: insightsCreated,
    });
  } catch (error) {
    console.error("[daily-digest] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
