/**
 * Atlas Model Lab — the routing table, mirrored from the gateway source.
 *
 * WHAT THIS IS, EXACTLY. Every value below is transcribed from code that ships
 * in this repo, with the file it came from named in `SOURCES`. It is NOT read
 * from a live registry, and there is no registry to read: model routing is
 * compile-time constants in three modules that run in the brain sidecar (Bun)
 * and the edge runtime (Deno), not in the webview.
 *
 *   supabase/functions/_shared/claudeAdapter.ts   CLAUDE_MODEL_MAP, CLAUDE_DEFAULT_MODEL,
 *                                                 DEFAULT_MAX_TOKENS, adaptive-thinking guard
 *   supabase/functions/_shared/bedrockAdapter.ts  TIER_ENV, TIER_DEFAULT, assertAllowedProfile,
 *                                                 thinkingOverrideFor, entitlement notes
 *   supabase/functions/_shared/aiGateway.ts       getAIConfig, the server-tool bridge
 *
 * So this module is a MIRROR, and the surface says so on screen rather than
 * implying it is live. If someone edits `TIER_DEFAULT` and not this file, the
 * lab is wrong — which is why `SOURCES` carries paths a reader can diff, and
 * why nothing here is presented as a measurement.
 *
 * Why a mirror at all, rather than importing the real modules: `_shared/*` is
 * Deno-flavoured (`Deno.env`, `.ts` specifiers in imports) and reads process
 * env at call time. Pulling it into the Vite graph would either break the build
 * or, worse, half-work and report the *webview's* empty env as the app's
 * routing. A transcription that admits it is a transcription is the honest
 * option; a fake "live" read is not.
 *
 * WHAT IS DELIBERATELY ABSENT: price per token, latency, quality scores,
 * context windows. None of the three exists anywhere in this repo, and a model
 * lab that invents a $/Mtok column is the exact fabrication T4 spent a week
 * deleting. The comparison view says so where the column would have been.
 */

export type Band = 'frontier' | 'balanced' | 'fast';

/** Whether a live `InvokeModel` against this account answered, and when. */
export type Entitlement =
  /** A live InvokeModel answered on this profile. */
  | 'invocable'
  /** A live InvokeModel returned AccessDeniedException for this account. */
  | 'denied'
  /** No `TIER_DEFAULT` entry — mapping the tier throws before any call. */
  | 'unmapped';

export interface BedrockLane {
  /** The env var that overrides this tier (`TIER_ENV`). */
  envOverride: string;
  /** The profile the tier is NAMED for — what you would expect it to invoke. */
  requested: string;
  /** `TIER_DEFAULT`'s actual value. `null` = no default; mapping throws. */
  profile: string | null;
  /** Entitlement of `requested` on this AWS account. */
  requestedState: Entitlement;
  /** Entitlement of `profile` — what the user's call really reaches. */
  profileState: Entitlement;
  /** True when `requested` and `profile` are different models. */
  substituted: boolean;
  /** Routing geography, which on Bedrock IS the profile prefix. */
  geo: 'eea' | 'worldwide' | null;
  /** How `thinking` is sent for the RESOLVED profile (`thinkingOverrideFor`). */
  thinking: 'omitted' | 'explicitly-disabled' | 'unconditional';
  note: string;
}

export interface ModelTier {
  /** The tier id every call site collapses to (claudeAdapter's vocabulary). */
  id: string;
  label: string;
  band: Band;
  blurb: string;
  /** Logical ids that map here (`CLAUDE_MODEL_MAP`). Empty = must be named. */
  aliases: string[];
  /** True for `CLAUDE_DEFAULT_MODEL` — where every unrecognised id lands. */
  isDefault?: boolean;
  /** First-party lane: `mapModelToClaude` passes any `claude-*` id through. */
  firstParty: { model: string; note: string };
  bedrock: BedrockLane;
  capabilities: {
    /** Adaptive thinking + `output_config.effort` (4.6+ features). */
    adaptive: boolean;
    /** Native web_search / web_fetch server tools. */
    serverTools: 'first-party-only';
    note: string;
  };
}

/** Facts about the gateway itself, not about one model. */
export const GATEWAY = {
  /** `ATLAS_AI_PROVIDER`, read at brain-sidecar spawn from the Keychain. */
  switchEnv: 'ATLAS_AI_PROVIDER',
  switchKeychain: 'atlas_ai_provider (service atlas-core)',
  lanes: [
    {
      id: 'anthropic' as const,
      label: 'First-party',
      host: 'api.anthropic.com',
      auth: 'x-api-key',
      streaming: 'text/event-stream',
      detail: 'Claude tiers pass through unchanged. This is the only lane that can run the native web_search / web_fetch server tools.',
    },
    {
      id: 'bedrock' as const,
      label: 'Bedrock',
      host: 'bedrock-runtime.eu-central-1.amazonaws.com',
      auth: 'AWS SigV4',
      streaming: 'application/vnd.amazon.eventstream',
      detail: 'The credit-funded background tier. Same Messages API, but the model id lives in the URL path and must be an inference profile this account is entitled to.',
    },
  ],
  /** claudeAdapter.ts */
  maxTokens: { blocking: 4096, streaming: 16000 },
  /** aiGateway.ts — the one capability branch. */
  serverToolBridge:
    'A turn carrying web_search / web_fetch is re-routed to api.anthropic.com, because Bedrock has no server-tool runtime. With no first-party key it is served on Bedrock WITHOUT those tools — degraded, not refused.',
  /** aiGateway.ts — fail-closed rule. */
  failClosed:
    'With no key for the selected provider the gateway returns null and callers surface "no AI key configured". It never falls through to another processor.',
  /** bedrockAdapter.ts — assertAllowedProfile. */
  eeaFlag: 'ATLAS_BEDROCK_EEA_ONLY',
  eeaNote:
    'Non-EEA profiles are permitted since 2026-08-02; ATLAS_BEDROCK_EEA_ONLY=1 restores containment. Every default is still an eu. profile, so residency only moves where a model has no EU profile at all.',
  /** aiGateway.ts — embeddings never moved to Claude. */
  embeddings:
    'Embeddings are not part of this routing table: Anthropic has no embeddings endpoint, so recall vectors come from a separate local path.',
} as const;

/**
 * Where an id nobody mapped ends up. `mapModelToClaude` returns
 * `CLAUDE_MODEL_MAP[model] ?? CLAUDE_DEFAULT_MODEL` — silently, with no warning
 * at the call site. Worth stating on screen because it means a typo in a model
 * id is invisible: it just quietly runs on the default tier.
 */
export const UNKNOWN_ID_FALLBACK = 'claude-sonnet-5';

/**
 * The five tiers. Entitlement values are the live-call results recorded in
 * bedrockAdapter.ts's own comments — invocable: haiku-4-5-20251001-v1:0,
 * sonnet-4-6, sonnet-4-5-20250929-v1:0, opus-4-6-v1; denied: sonnet-5,
 * opus-4-8, opus-4-7, opus-5. Verified 2026-07-28 by signed InvokeModel as the
 * atlas-brain IAM user; opus-5 re-checked 2026-07-30 as the root account, which
 * is what rules IAM out as the cause.
 */
export const VERIFIED_ON = '2026-07-28';
export const OPUS5_RECHECK_ON = '2026-07-30';

export const TIERS: ModelTier[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    band: 'fast',
    blurb: 'Summarisation, classification, titles — the constant background traffic.',
    aliases: ['google/gemini-2.5-flash-lite', 'openai/gpt-5-nano'],
    firstParty: { model: 'claude-haiku-4-5', note: 'Passed through unchanged.' },
    bedrock: {
      envOverride: 'BEDROCK_MODEL_HAIKU',
      requested: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      profile: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      requestedState: 'invocable',
      profileState: 'invocable',
      substituted: false,
      geo: 'eea',
      thinking: 'omitted',
      note: 'The one tier whose Bedrock profile is the model the tier is named for.',
    },
    capabilities: {
      adaptive: false,
      serverTools: 'first-party-only',
      note: 'Haiku 4.5 predates adaptive thinking and output_config.effort and rejects both, so the adapter sends neither — otherwise every call on the cheap tier 400s.',
    },
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    band: 'balanced',
    blurb: 'The default tier. Every unrecognised model id lands here.',
    aliases: ['google/gemini-2.5-flash', 'openai/gpt-5-mini'],
    isDefault: true,
    firstParty: { model: 'claude-sonnet-5', note: 'Passed through unchanged — the frontier problem below is Bedrock-only.' },
    bedrock: {
      envOverride: 'BEDROCK_MODEL_SONNET',
      requested: 'eu.anthropic.claude-sonnet-5',
      profile: 'eu.anthropic.claude-sonnet-4-6',
      requestedState: 'denied',
      profileState: 'invocable',
      substituted: true,
      geo: 'eea',
      thinking: 'omitted',
      note: 'The profile is listed by list-inference-profiles but invoking it returns AccessDeniedException, so the default is the newest Sonnet that actually answers.',
    },
    capabilities: {
      adaptive: true,
      serverTools: 'first-party-only',
      note: 'Adaptive thinking is on for tool-free turns and off whenever tool blocks are in play — the OpenAI seam cannot replay thinking-block signatures.',
    },
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    band: 'frontier',
    blurb: 'The strong tier the logical "pro" ids map to.',
    aliases: ['google/gemini-2.5-pro', 'openai/gpt-5'],
    firstParty: { model: 'claude-opus-4-8', note: 'Passed through unchanged.' },
    bedrock: {
      envOverride: 'BEDROCK_MODEL_OPUS',
      requested: 'eu.anthropic.claude-opus-4-8',
      profile: 'eu.anthropic.claude-opus-4-6-v1',
      requestedState: 'denied',
      profileState: 'invocable',
      substituted: true,
      geo: 'eea',
      thinking: 'omitted',
      note: 'Opus 4.8 and 4.7 are both unentitled on this account; 4.6 is the newest Opus that answers.',
    },
    capabilities: {
      adaptive: true,
      serverTools: 'first-party-only',
      note: 'Same adaptive-thinking rule as Sonnet.',
    },
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    band: 'frontier',
    blurb: 'Reachable only by naming it — no logical alias maps here.',
    aliases: [],
    firstParty: { model: 'claude-opus-5', note: 'Passed through unchanged. On this lane Opus 5 IS Opus 5.' },
    bedrock: {
      envOverride: 'BEDROCK_MODEL_OPUS_5',
      requested: 'eu.anthropic.claude-opus-5',
      profile: 'eu.anthropic.claude-opus-4-6-v1',
      requestedState: 'denied',
      profileState: 'invocable',
      substituted: true,
      geo: 'eea',
      thinking: 'omitted',
      note: 'Denied to the ROOT account as well as to atlas-brain, which rules IAM out — the newest tier needs a separate model-access request on the AWS side. Pointing the default at it would put AccessDeniedException straight into the transcript, because on a streaming call the error is injected into the stream.',
    },
    capabilities: {
      adaptive: true,
      serverTools: 'first-party-only',
      note: 'Opus 5 thinks when `thinking` is omitted, so the adapter sends {type:"disabled"} explicitly. That override keys on the RESOLVED profile id — while this tier resolves to Opus 4.6 it never fires.',
    },
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    band: 'frontier',
    blurb: 'No EU profile exists. Two deliberate acts stand between it and a call.',
    aliases: [],
    firstParty: { model: 'claude-fable-5', note: 'Passed through unchanged.' },
    bedrock: {
      envOverride: 'BEDROCK_MODEL_FABLE_5',
      requested: 'global.anthropic.claude-fable-5',
      profile: null,
      requestedState: 'denied',
      profileState: 'unmapped',
      substituted: false,
      geo: 'worldwide',
      thinking: 'unconditional',
      note: 'No TIER_DEFAULT entry, so mapping a bare claude-fable-5 throws at map time rather than failing per request. The only reachable profile is global., which routes to whichever region has capacity, worldwide — Bedrock has no inference_geo escape hatch.',
    },
    capabilities: {
      adaptive: true,
      serverTools: 'first-party-only',
      note: 'Fable thinks unconditionally and 400s on {type:"disabled"} at any effort, so thinking is left omitted. It is also unavailable under zero-data-retention: 30-day retention is mandatory.',
    },
  },
];

export const tierById = (id: string): ModelTier | undefined => TIERS.find((t) => t.id === id);

/** What a call on this tier actually invokes, per lane. */
export function resolvedOn(tier: ModelTier, lane: 'anthropic' | 'bedrock'): string | null {
  return lane === 'anthropic' ? tier.firstParty.model : tier.bedrock.profile;
}

/** Rows for the comparison view. Order is the reading order. */
export const COMPARE_FIELDS: { key: string; label: string; read: (t: ModelTier) => string }[] = [
  { key: 'band', label: 'Band', read: (t) => t.band },
  { key: 'default', label: 'Default tier', read: (t) => (t.isDefault ? 'yes — unknown ids land here' : 'no') },
  { key: 'aliases', label: 'Reached by', read: (t) => (t.aliases.length ? t.aliases.join(', ') : 'its own id only') },
  { key: 'fp', label: 'First-party model', read: (t) => t.firstParty.model },
  { key: 'requested', label: 'Bedrock profile named', read: (t) => t.bedrock.requested },
  { key: 'resolved', label: 'Bedrock profile invoked', read: (t) => t.bedrock.profile ?? 'none — mapping throws' },
  { key: 'entitle', label: 'Entitlement', read: (t) => (t.bedrock.requestedState === 'invocable' ? 'entitled' : t.bedrock.profileState === 'unmapped' ? 'unmapped' : 'not entitled — substituted') },
  { key: 'geo', label: 'Routing geography', read: (t) => (t.bedrock.geo === 'eea' ? 'EEA (eu. profile)' : t.bedrock.geo === 'worldwide' ? 'worldwide (global. profile)' : 'n/a') },
  { key: 'override', label: 'Override env var', read: (t) => t.bedrock.envOverride },
  { key: 'adaptive', label: 'Adaptive thinking / effort', read: (t) => (t.capabilities.adaptive ? 'supported' : 'not sent — the model rejects both') },
  { key: 'thinking', label: 'Thinking on Bedrock', read: (t) => (t.bedrock.thinking === 'omitted' ? 'omitted (no thinking)' : t.bedrock.thinking === 'explicitly-disabled' ? 'explicitly disabled' : 'unconditional') },
  { key: 'tools', label: 'Native server tools', read: () => 'first-party lane only' },
];

/** Every file this page is a transcription of. Shown in the footer. */
export const SOURCES = [
  { path: 'supabase/functions/_shared/claudeAdapter.ts', what: 'logical id → tier, default tier, token ceilings, adaptive-thinking guard' },
  { path: 'supabase/functions/_shared/bedrockAdapter.ts', what: 'tier → inference profile, env overrides, entitlement results, geo guard' },
  { path: 'supabase/functions/_shared/aiGateway.ts', what: 'provider selection, fail-closed rule, server-tool bridge' },
];
