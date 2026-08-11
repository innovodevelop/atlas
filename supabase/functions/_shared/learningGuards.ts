// Guards for conversation-scoped learning. Every research entry point goes
// through these before enqueueing work; the DB trigger enforce_session_limits
// is the final backstop, these give friendlier short-circuits (and semantic
// dedup, which SQL can't do).

import { isLearningEnabled } from "./providerStatus.ts";

// Match the codebase convention (providerStatus.ts): loose client type to
// avoid supabase-js version drift between functions.
// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export interface LearningConfig {
  enabled: boolean;
  mode: string;
  maxTopics: number;
  maxDepth: number;
}

export interface LearningSession {
  id: string;
  user_id: string | null;
  conversation_id: string | null;
  root_topic: string | null;
  status: string;
  topic_count: number;
  token_cost: number;
  budget_cents: number | null;
  expires_at: string;
}

/** The ONLY source of learning limits — callers must not hardcode maxDepth. */
export function getLearningConfig(supabase: SupabaseClient): Promise<LearningConfig> {
  return isLearningEnabled(supabase);
}

/**
 * Find the active session for a conversation or create one. Reusing sessions
 * per conversation is what keeps research contained: all topics from one chat
 * share one topic budget.
 */
export async function findOrCreateSession(
  supabase: SupabaseClient,
  opts: {
    userId?: string | null;
    conversationId?: string | null;
    rootTopic: string;
    triggerType?: "voice" | "text" | "manual" | "scheduled" | "daily_digest";
    budgetCents?: number | null;
  },
): Promise<LearningSession | null> {
  if (opts.conversationId) {
    const { data: existing } = await supabase
      .from("atlas_learning_sessions")
      .select("*")
      .eq("conversation_id", opts.conversationId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();
    if (existing) return existing as LearningSession;
  }

  // Default session budget from atlas_budget_settings: 10% of the daily
  // budget so a single conversation can never eat the day's spend.
  let budgetCents = opts.budgetCents ?? null;
  if (budgetCents == null) {
    const { data: budget } = await supabase
      .from("atlas_budget_settings")
      .select("daily_budget_usd")
      .limit(1)
      .maybeSingle();
    if (budget?.daily_budget_usd) {
      budgetCents = Math.max(10, Math.round(budget.daily_budget_usd * 100 * 0.1));
    }
  }

  const { data: created, error } = await supabase
    .from("atlas_learning_sessions")
    .insert({
      user_id: opts.userId ?? null,
      conversation_id: opts.conversationId ?? null,
      topic: opts.rootTopic,
      root_topic: opts.rootTopic,
      trigger_type: opts.triggerType ?? "text",
      status: "active",
      budget_cents: budgetCents,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[learningGuards] Failed to create session:", error);
    return null;
  }
  return created as LearningSession;
}

/**
 * Session budget check. token_cost is accumulated in cents-equivalent by
 * recordSessionCost; when it crosses budget_cents the session flips to
 * budget_exceeded and all further inserts are rejected by the DB trigger.
 */
export async function checkSessionBudget(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const { data: session } = await supabase
    .from("atlas_learning_sessions")
    .select("status, token_cost, budget_cents, expires_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) return { ok: false, reason: "session_not_found" };
  if (session.status !== "active") return { ok: false, reason: `session_${session.status}` };
  if (new Date(session.expires_at) < new Date()) {
    await supabase
      .from("atlas_learning_sessions")
      .update({ status: "expired", ended_at: new Date().toISOString() })
      .eq("id", sessionId);
    return { ok: false, reason: "session_expired" };
  }
  if (session.budget_cents != null && session.token_cost >= session.budget_cents) {
    await supabase
      .from("atlas_learning_sessions")
      .update({ status: "budget_exceeded", ended_at: new Date().toISOString() })
      .eq("id", sessionId);
    return { ok: false, reason: "budget_exceeded" };
  }
  return { ok: true };
}

/** Accumulate estimated cost (in cents) onto the session. */
export async function recordSessionCost(
  supabase: SupabaseClient,
  sessionId: string,
  costCents: number,
): Promise<void> {
  const { data: session } = await supabase
    .from("atlas_learning_sessions")
    .select("token_cost")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return;
  await supabase
    .from("atlas_learning_sessions")
    .update({ token_cost: Number(session.token_cost) + costCents })
    .eq("id", sessionId);
}

/** Mark a session completed when no queued/researching topics remain. */
export async function completeSessionIfDone(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from("atlas_research_topics")
    .select("id", { count: "exact", head: true })
    .eq("learning_session_id", sessionId)
    .in("status", ["queued", "researching", "processing"]);

  if ((count ?? 0) === 0) {
    await supabase
      .from("atlas_learning_sessions")
      .update({ status: "completed", ended_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("status", "active");
    return true;
  }
  return false;
}
