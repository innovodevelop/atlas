// Model routing — the single place that maps a task to a difficulty tier.
//
// Ids stay LOGICAL ("google/gemini-2.5-*"); aiGateway.mapModel() translates them
// for whichever provider is configured. On the Anthropic adapter that means
// flash-lite -> Haiku (cheap), flash -> Sonnet (default), pro -> Opus (hard).
// Never put a provider-native model id here — that would bypass mapModel().

export type ModelTier = "cheap" | "standard" | "hard";

export const TIER_MODELS: Record<ModelTier, string> = {
  cheap: "google/gemini-2.5-flash-lite",
  standard: "google/gemini-2.5-flash",
  hard: "google/gemini-2.5-pro",
};

// Background text work — summarise, classify, condense. Never user-facing prose.
const CHEAP_TASKS = new Set([
  "memory",
  "memory_store",
  "summary",
  "summarization",
  "classification",
  "classify",
  "intent",
  "digest",
  "insights",
  "extraction",
  "title",
]);

// Only what the user explicitly framed as research or hard reasoning — this tier
// is ~8x the cost of standard, so it must not be the fallback.
const HARD_TASKS = new Set([
  "deep_research",
  "research",
  "hard",
  "complex_reasoning",
  "planning",
  "verification",
]);

export function selectTier(task: string): ModelTier {
  const t = task.trim().toLowerCase();
  if (CHEAP_TASKS.has(t)) return "cheap";
  if (HARD_TASKS.has(t)) return "hard";
  return "standard";
}

/** Logical model id for a task. Unknown tasks get the standard chat tier. */
export function selectModel(task: string): string {
  return TIER_MODELS[selectTier(task)];
}
