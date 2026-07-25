/**
 * Personality as bounded state (MVP Phase 4).
 *
 * Replaces the hardcoded "## Your Personality" prose in orchestrator.ts with a
 * block composed from a small trait vector + a learned lexicon, both persisted
 * in atlas_personality (traits_json / lexicon_json). Runtime-neutral like the
 * orchestrator: no Deno/Bun APIs, no imports.
 *
 * The composed block is part of the prompt-cache prefix (Claude caches the
 * stable system prefix), so everything here is deterministic and quantized:
 * traits render through three buckets (low/mid/high) — a drifting trait only
 * changes the prompt when it crosses a bucket edge, and the humour gates are
 * discrete booleans that flip rarely within a session. No timestamps, no
 * per-message text.
 */

export interface Traits {
  warmth: number;
  playfulness: number;
  formality: number;
  verbosity: number;
  directness: number;
}

export const DEFAULT_TRAITS: Traits = {
  warmth: 0.5,
  playfulness: 0.5,
  formality: 0.5,
  verbosity: 0.5,
  directness: 0.5,
};

export interface PersonalityState {
  traits: Traits;
  /** Learned nicknames / in-jokes, e.g. { "what you call them": "Boss" }. */
  lexicon: Record<string, string>;
  /**
   * Trait names the user set by hand. Drift must never move these — an
   * explicit choice outranks inferred behaviour until the user resets.
   * Optional: only the persistence layer tracks pins; composePersonality and
   * callers that don't store state (voice gateway, edge fns) ignore it.
   */
  pinned?: string[];
}

export const DEFAULT_PERSONALITY: PersonalityState = {
  traits: { ...DEFAULT_TRAITS },
  lexicon: {},
  pinned: [],
};

export interface PersonalityContext {
  /** Latest session_context emotion for this user ("stressed", "sad", …). */
  emotion?: string | null;
  /** The user's recent messages are short/clipped — they want efficiency. */
  terse?: boolean;
  /** The latest message touches an unambiguously heavy topic. */
  seriousTopic?: boolean;
}

/** Max per-trait movement per applyDrift invocation. */
export const DRIFT_STEP = 0.02;

const TRAIT_KEYS = Object.keys(DEFAULT_TRAITS) as Array<keyof Traits>;
const MAX_LEXICON_ENTRIES = 8;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Merge a (possibly partial/dirty) trait object over defaults, clamped to [0,1]. */
export function clampTraits(input: Partial<Traits> | null | undefined): Traits {
  const out = { ...DEFAULT_TRAITS };
  for (const k of TRAIT_KEYS) {
    const v = input?.[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = clamp01(v);
  }
  return out;
}

/** Drop non-string entries, trim, cap entry count + lengths (prompt hygiene). */
export function sanitizeLexicon(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const key = k.trim().slice(0, 40);
    const val = v.trim().slice(0, 80);
    if (!key || !val) continue;
    out[key] = val;
    if (Object.keys(out).length >= MAX_LEXICON_ENTRIES) break;
  }
  return out;
}

/**
 * Serious-topic gate. Deliberately narrow and literal: unambiguous heavy-topic
 * words only, no sentiment inference. A false positive just means fewer jokes
 * (so ambiguity like "died" in a gaming context is accepted and biases toward
 * suppression); ordinary negativity ("this bug is annoying") must NOT match.
 */
const SERIOUS_TOPIC_RE = new RegExp(
  "\\b(died?|dying|death|funeral|grief|grieving|mourning|suicide|suicidal|self-harm|" +
    "cancer|tumou?r|diagnos(is|ed)|chemo|hospitali[sz]ed|surgery|emergency|" +
    "divorce|break-?up|broke up|miscarriage|assault(ed)?|abus(e|ed|ive)|" +
    "laid off|lost (my|her|his|their) job|got fired|fired me|overdose|relapse[ds]?|passed away)\\b",
  "i",
);

export function detectSeriousTopic(text: string): boolean {
  return SERIOUS_TOPIC_RE.test(text);
}

// Bucketing is what keeps the composed block byte-stable under slow drift: a
// trait must cross an edge (±0.02/turn ⇒ many consistent turns) to change the
// prompt, so the cache prefix survives ordinary drift.
type Level = "low" | "mid" | "high";
const level = (x: number): Level => (x < 0.34 ? "low" : x > 0.66 ? "high" : "mid");

/**
 * Compose the "## Your Personality" + "## Communication Style" block.
 *
 * Humour gating is the point: the old constant mandated jokes unconditionally,
 * so Atlas cracked wise at the worst moments. When the user is stressed/sad,
 * terse, or on a serious topic, humour is explicitly forbidden (not merely
 * unmentioned — models treat silence as permission) and the block shifts to
 * steady, plain support.
 *
 * Ends inside the Communication Style bullet list on purpose — the orchestrator
 * appends its contextual bullets (tone, time of day, birthday) directly after.
 */
export function composePersonality(state: PersonalityState, ctx: PersonalityContext = {}): string {
  const t = clampTraits(state.traits);
  const suppressHumor =
    ctx.seriousTopic === true ||
    ctx.terse === true ||
    ctx.emotion === "stressed" ||
    ctx.emotion === "sad";

  const lines: string[] = ["## Your Personality"];
  lines.push("- You're like a trusted friend who happens to be incredibly knowledgeable");
  lines.push("- You use their name naturally (but not every sentence - that's weird)");
  lines.push("- You remember what they've shared and bring it up when relevant");
  lines.push("- You're genuinely interested in their life, not just their tasks");

  switch (level(t.warmth)) {
    case "high":
      lines.push("- You're openly caring: celebrate their wins, check in on the hard things, and say so plainly");
      break;
    case "mid":
      lines.push("- You celebrate their wins and offer support during tough times");
      break;
    case "low":
      lines.push("- You care through usefulness more than sentiment - supportive, but understated");
      break;
  }

  if (suppressHumor) {
    lines.push("- Right now is NOT the moment for humor: no jokes, no playful teasing, no puns, no witty asides");
    lines.push("- Be steady and plain instead - acknowledge what they're dealing with, keep replies grounded, and focus on being genuinely helpful");
  } else {
    switch (level(t.playfulness)) {
      case "high":
        lines.push("- You have a good sense of humor - light jokes, playful teasing, the occasional pun, even a self-deprecating AI joke now and then");
        break;
      case "mid":
        lines.push("- A light touch of humor is welcome when the moment invites it - never forced");
        break;
      case "low":
        lines.push("- Keep humor rare and gentle - warmth over wit");
        break;
    }
  }

  const lexEntries = Object.entries(sanitizeLexicon(state.lexicon));
  if (lexEntries.length > 0) {
    lines.push("- Things you call each other (use them when they fit naturally, never force them):");
    for (const [k, v] of lexEntries) lines.push(`  - ${k}: ${v}`);
  }

  lines.push("", "## Communication Style");
  switch (level(t.formality)) {
    case "high":
      lines.push("- Keep phrasing measured and polished - contractions sparingly, no emoji");
      break;
    case "mid":
      lines.push('- Use contractions naturally ("you\'re", "I\'d", "let\'s"); emoji occasionally but don\'t overdo it');
      break;
    case "low":
      lines.push("- Be casual and easygoing - contractions always, emoji occasionally but don't overdo it");
      break;
  }
  switch (level(t.verbosity)) {
    case "low":
      lines.push("- Keep replies brief - a few sentences unless they explicitly ask for depth");
      break;
    case "mid":
      lines.push("- Match the length of your reply to the weight of the question");
      break;
    case "high":
      lines.push("- Feel free to be expansive when a topic deserves it - just stay structured");
      break;
  }
  switch (level(t.directness)) {
    case "high":
      lines.push("- Lead with the answer or a clear recommendation, then the reasoning");
      break;
    case "mid":
      lines.push("- Offer a clear take while leaving room for their view");
      break;
    case "low":
      lines.push("- Think through options with them before landing on a recommendation");
      break;
  }
  lines.push("- If they seem stressed, acknowledge it gently");

  return lines.join("\n");
}

export interface DriftObservations {
  /** Mean length (chars) of the user's recent messages this turn. */
  avgUserMessageChars?: number;
  /** Positive evidence of formal register (full sentences, no slang/emoji). */
  formalRegister?: boolean;
  /** Positive evidence of playfulness (laughter tokens, playful emoji). */
  playfulRegister?: boolean;
  /**
   * Share of recent assistant turns the user followed up on
   * (chat_turns.followed_up_at), 0..1. Engagement, not approval.
   */
  followUpRate?: number;
}

/**
 * Pure style observation over the user's recent messages (testable, no DB).
 * Registers are evidence-based: `undefined` means "no evidence either way",
 * and only positive evidence produces a boolean — otherwise every quiet
 * workday would drain playfulness to zero one step at a time.
 */
export function observeUserStyle(userMessages: string[]): DriftObservations {
  const msgs = userMessages.filter((m) => typeof m === "string" && m.trim().length > 0);
  if (msgs.length === 0) return {};
  const avg = msgs.reduce((s, m) => s + m.length, 0) / msgs.length;
  const joined = msgs.join("\n");

  const playful = /\b(haha+|hehe+|lol|lmao|rofl)\b|[\u{1F600}-\u{1F64F}\u{1F923}]/iu.test(joined);
  const slang = /\b(gonna|wanna|gotta|dunno|yeah|yep|nah|btw|omg)\b/i.test(joined);
  // Formal needs positive evidence across ALL messages, not just absent slang.
  const fullSentences = msgs.every((m) => /^[A-ZÆØÅ]/.test(m.trim()) && /[.?!]$/.test(m.trim()));

  const obs: DriftObservations = { avgUserMessageChars: avg };
  if (playful) obs.playfulRegister = true;
  if (playful || slang) obs.formalRegister = false;
  else if (fullSentences && avg > 60) obs.formalRegister = true;
  return obs;
}

/**
 * Bounded, slow drift: each invocation moves every trait at most DRIFT_STEP
 * (±0.02) toward a target implied by behavioural observations, clamped to
 * [0,1]. Crossing a whole render bucket takes ~17 consistent turns —
 * deliberate: personality should settle, not flap.
 *
 * Driven ONLY by how the user actually behaves (message length, register) plus
 * one engagement signal (followed_up_at). NEVER by approval-shaped signals
 * (thumbs-up, praise, sentiment about Atlas itself): optimizing traits on
 * approval makes the objective "say what earns praise", which converges on
 * flattery — the most predictable failure mode of a learned personality.
 * followed_up_at is therefore only allowed to push toward LESS (shorter, more
 * direct replies when follow-ups are rare); it never rewards a style upward,
 * so there is no gradient toward ingratiating behaviour. Warmth never drifts:
 * it is a user-set dial (POST /personality), not something to learn from
 * reactions.
 */
export function applyDrift(current: Traits, obs: DriftObservations): Traits {
  const cur = clampTraits(current);
  const targets: Partial<Record<keyof Traits, number>> = {};

  if (typeof obs.avgUserMessageChars === "number") {
    if (obs.avgUserMessageChars > 400) targets.verbosity = 1;
    else if (obs.avgUserMessageChars < 80) targets.verbosity = 0;
  }
  if (obs.formalRegister === true) targets.formality = 1;
  else if (obs.formalRegister === false) targets.formality = 0;

  if (obs.playfulRegister === true) targets.playfulness = 1;
  // Formal-and-unplayful turns cool playfulness toward reserved, not to zero.
  else if (obs.formalRegister === true) targets.playfulness = 0.3;

  // Disengagement back-off overrides mirroring (see doc comment above).
  if (typeof obs.followUpRate === "number" && obs.followUpRate < 0.3) {
    targets.verbosity = 0;
    targets.directness = 1;
  }

  const next = { ...cur };
  for (const k of TRAIT_KEYS) {
    const target = targets[k];
    if (typeof target !== "number") continue;
    const delta = Math.max(-DRIFT_STEP, Math.min(DRIFT_STEP, clamp01(target) - cur[k]));
    next[k] = clamp01(cur[k] + delta);
  }
  return next;
}
