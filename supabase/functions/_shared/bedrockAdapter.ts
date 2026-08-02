// Amazon Bedrock (Claude, on AWS Activate credits) behind the same OpenAI
// chat.completions seam as the first-party path.
//
// Bedrock speaks the *same* Anthropic Messages API as api.anthropic.com, so the
// hard translation work — OpenAI <-> Messages, and Messages SSE -> OpenAI SSE —
// is reused verbatim from claudeAdapter.ts. Only three things differ on Bedrock:
//
//   1. AUTH is AWS SigV4 (awsSigV4.ts), not an x-api-key header.
//   2. The MODEL lives in the URL path, not the body, and its id is an EU
//      cross-region inference profile (`eu.anthropic.claude-*`) — which crucially
//      does NOT start with "claude-", so claudeAdapter's `startsWith("claude-")`
//      model guard would miss it. Hence a separate `mapModelToBedrock()`.
//   3. STREAMING is the AWS event-stream binary framing
//      (application/vnd.amazon.eventstream), not text/event-stream. Each frame
//      wraps a base64 Anthropic SSE event, so a small frame decoder unwraps them
//      back into the events claudeAdapter already knows how to translate.
//
// WHY THIS SHAPE MATTERS FOR THE A->B MIGRATION: Claude Platform on AWS ("Path
// B") uses the SAME SigV4 auth + AWS creds and the SAME Messages API. Migrating
// is: change `service`/host and drop the `eu.anthropic.` model prefix. Nothing
// in the translation or auth below changes — that is the whole point of building
// on the shared signer.

import {
  CLAUDE_DEFAULT_MODEL,
  fromAnthropicMessage,
  mapModelToClaude,
  toAnthropicRequest,
  type AnthropicMessageResponse,
} from "./claudeAdapter.ts";
import { amzDateParts, signRequest, type AwsCredentials } from "./awsSigV4.ts";

// Bedrock pins the Anthropic schema version in the body (not a header).
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
const DEFAULT_REGION = "eu-central-1";

// ---------------------------------------------------------------------------
// Model mapping

/**
 * Per-tier env override names. Every tier stays overridable so an entitlement
 * change is a config change, not a deploy — see the entitlement note below.
 *
 * NB: `src-tauri/src/lib.rs` currently forwards only AWS_* + ATLAS_AI_PROVIDER
 * to the brain sidecar, and a Finder-launched .app inherits no shell env, so
 * these overrides are a dev/CI lever today, NOT a knob a shipped desktop build
 * can turn. For the Fable entry that is the desired property, not a gap.
 */
const TIER_ENV: Record<string, string> = {
  "claude-haiku-4-5": "BEDROCK_MODEL_HAIKU",
  "claude-sonnet-5": "BEDROCK_MODEL_SONNET",
  "claude-opus-4-8": "BEDROCK_MODEL_OPUS",
  "claude-opus-5": "BEDROCK_MODEL_OPUS_5",
  "claude-fable-5": "BEDROCK_MODEL_FABLE_5",
};

/**
 * Logical/first-party model id -> Bedrock EU inference-profile id.
 *
 * Every default below was verified by an ACTUAL InvokeModel call against
 * eu-central-1, signing as the atlas-brain IAM user (2026-07-28) — not read off
 * a docs page and not inferred from naming.
 *
 * That distinction turned out to matter twice:
 *
 * 1. **Listing a profile proves it exists, NOT that this account may invoke it.**
 *    `list-inference-profiles` happily returns `eu.anthropic.claude-sonnet-5`,
 *    `…opus-4-8` and `…opus-4-7`, but invoking any of them fails with
 *    `AccessDeniedException: <model> is not available for this account`. The
 *    newest tier is simply not entitled here yet. So each tier maps to the
 *    newest model that actually *answers*.
 *
 * 2. **The id shapes are not derivable.** Some carry a date+version suffix
 *    (`-20251001-v1:0`), some do not (`sonnet-4-6`). Hence literal strings.
 *
 * Verified invocable: haiku-4-5-20251001-v1:0, sonnet-4-6,
 * sonnet-4-5-20250929-v1:0, opus-4-6-v1.
 * Verified DENIED: sonnet-5, opus-4-8, opus-4-7, opus-5.
 *
 * **`eu.anthropic.claude-opus-5` is deliberately NOT a default.** It is the
 * newest EU Opus profile and would be the obvious upgrade, but on 2026-07-30 it
 * was denied to the ROOT account as well as to atlas-brain, which rules IAM out:
 * the newest Anthropic tier needs a separate model-access request on the AWS
 * side. Pointing a default at it would put `[AccessDeniedException: …]` straight
 * into the user's transcript, because on a streaming call the error is injected
 * into the stream rather than merely logged (see `bedrockEventStreamToOpenAI`).
 * It stays reachable via `BEDROCK_MODEL_OPUS_5` or as an already-resolved id;
 * promoting it into the table below belongs in a follow-up commit whose message
 * cites a successful live InvokeModel.
 *
 * SUBSCRIPTIONS ARE PER-MODEL. Bedrock auto-subscribes an account to a model on
 * first invoke via AWS Marketplace, and a least-privilege caller cannot complete
 * that: it fails with "not authorized to perform the required AWS Marketplace
 * actions" until an identity holding `aws-marketplace:Subscribe` invokes that
 * SPECIFIC model once. Adding a new profile here therefore needs a one-time
 * bootstrap invoke by an admin — the IAM policy alone is not enough.
 *
 * All defaults are still `eu.` profiles. That is now a PREFERENCE rather than a
 * hard guarantee: as of 2026-08-02 non-EEA profiles are permitted (see
 * `assertAllowedProfile`), so the published policy describes a split rather than
 * EEA-confinement. Keeping every *default* on `eu.` means the residency posture
 * only changes where a model genuinely has no EU profile — it never drifts by
 * accident.
 */
const TIER_DEFAULT: Record<string, string> = {
  "claude-haiku-4-5": "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  // Sonnet 5 exists as a profile but is not entitled on this account yet.
  "claude-sonnet-5": "eu.anthropic.claude-sonnet-4-6",
  // Opus 4.8 and 4.7 are likewise unentitled; 4.6 is the newest that answers.
  "claude-opus-4-8": "eu.anthropic.claude-opus-4-6-v1",
  // Same tier, newer name: a caller asking for Opus 5 gets the newest Opus that
  // is actually entitled, exactly as `claude-sonnet-5` resolves to Sonnet 4.6.
  "claude-opus-5": "eu.anthropic.claude-opus-4-6-v1",
  // NO entry for "claude-fable-5" — that is the whole point. See below.
};

/**
 * Fable 5 has NO `eu.` inference profile. The only way to reach it on Bedrock is
 * `global.anthropic.claude-fable-5`, and a `global.` cross-region profile routes
 * to whichever region has capacity, WORLDWIDE. Bedrock has no `inference_geo`
 * escape hatch (that parameter is Claude-Platform-on-AWS only), so on Bedrock the
 * routing geography IS the profile prefix.
 *
 * **Both blockers were lifted deliberately on 2026-08-02** (decision: reach the
 * frontier tier; see docs/aws-migration-decision.md, "UPDATE 2026-08-02"):
 *
 *   1. IAM — `AtlasBedrockInvoke` was widened to the global profile ARN plus the
 *      underlying `arn:aws:bedrock:*::foundation-model/anthropic.*` wildcard the
 *      global profile needs in each region it can route to. See
 *      `docs/aws-iam-bedrock-invoke-policy.json`. The policy is now a name
 *      filter, not a containment mechanism — that is the accepted cost.
 *   2. PRIVACY POLICY — §4.3/§6/§7 no longer claim EEA-confinement for the
 *      background tier; AWS is listed as a third-country transfer on an SCC
 *      basis, and §8 discloses Fable's mandatory 30-day retention (it is
 *      unavailable under zero-data-retention).
 *
 * What has NOT changed: Fable still has no `TIER_DEFAULT` entry, so mapping a
 * bare `claude-fable-5` still throws. Reaching it takes one deliberate act —
 * setting `BEDROCK_MODEL_FABLE_5` — rather than two. That is not residency
 * caution any more; it is the same rule every other tier obeys, that a default
 * may only name a profile a live `InvokeModel` has answered on (see
 * `TIER_DEFAULT` above). Promote it in a commit that cites one.
 */
function bedrockIdForTier(tier: string): string {
  // Guard the lookup rather than passing `?? ""` to Deno.env.get: real Deno
  // rejects an empty key with `TypeError: Key is an empty string`, which would
  // replace the deliberate error below with an opaque one for any unknown tier.
  // The Bun shim in the brain sidecar does not validate, so this only bites in
  // the edge runtime — i.e. exactly where it would be hardest to read.
  const envName = TIER_ENV[tier];
  const id = (envName ? Deno.env.get(envName) : undefined) || TIER_DEFAULT[tier];
  if (!id) {
    // Never synthesise `eu.anthropic.${tier}`. The old fallback did, which meant
    // an unknown tier became a plausible-looking profile id that may not exist
    // at all (`claude-fable-5` -> `eu.anthropic.claude-fable-5`, which does not)
    // and only failed per-request as a ValidationException. Failing at map time
    // is louder and cheaper.
    throw new Error(
      `[bedrock] no inference profile mapped for tier "${tier}"` +
        (TIER_ENV[tier] ? ` (set ${TIER_ENV[tier]} to opt in)` : ""),
    );
  }
  return id;
}

/**
 * A value that is already a resolved Bedrock/inference-profile id. Non-`eu.`
 * prefixes are RECOGNISED here (so an explicit env override is passed through
 * verbatim rather than being re-prefixed into nonsense) but not AUTHORISED —
 * `assertAllowedProfile` is the authorisation step.
 */
const BEDROCK_ID = /^(eu|us|apac|global|anthropic)\./;

/**
 * A non-`eu.` profile routes OUTSIDE the EEA.
 *
 * Until 2026-08-02 this refused outright unless `ATLAS_BEDROCK_ALLOW_NON_EEA=1`,
 * because the published policy committed the background tier to the EEA. That
 * commitment was deliberately relaxed so the frontier tier (Fable 5, which has no
 * `eu.` profile at all) is reachable, and §4.3/§6/§7 of the privacy policy were
 * rewritten to describe a split instead. So the default flipped: non-EEA profiles
 * are ALLOWED, and `ATLAS_BEDROCK_EEA_ONLY=1` restores containment.
 *
 * The inverse flag is kept rather than deleting the check, for two reasons. It is
 * the one-line revert if the policy position changes back, and it is the switch a
 * future EEA-only deployment (an enterprise tenant, a DPA that demands it) turns
 * on without a code change. Deleting the guard would make that a rewrite.
 *
 * NOTE the asymmetry with IAM: `AtlasBedrockInvoke` is now a name filter rather
 * than a containment mechanism, so this function is no longer a second line of
 * defence over it — it is the only one. Setting `ATLAS_BEDROCK_EEA_ONLY=1` is
 * therefore a real control, not belt-and-braces.
 */
function assertAllowedProfile(id: string): string {
  if (id.startsWith("eu.")) return id;
  if (Deno.env.get("ATLAS_BEDROCK_EEA_ONLY") !== "1") return id;
  throw new Error(
    `[bedrock] refusing to invoke non-EEA inference profile "${id}": ` +
      `ATLAS_BEDROCK_EEA_ONLY=1 confines this deployment to the EEA, and "${id}" ` +
      `routes outside it. Unset the flag, or map this tier to an eu. profile.`,
  );
}

/**
 * Resolve any model id the call sites use to a Bedrock invocation id. Reuses
 * `mapModelToClaude()` for the logical-id -> claude-tier step so tier routing
 * has a single source of truth, then maps the tier to its EU profile.
 *
 * The `BEDROCK_ID` short-circuit is load-bearing: an already-resolved Bedrock id
 * does not start with "claude-", so without it `mapModelToClaude()` would treat
 * it as unknown and collapse everything to the default tier.
 */
export function mapModelToBedrock(model: string): string {
  if (BEDROCK_ID.test(model)) return assertAllowedProfile(model);
  return assertAllowedProfile(bedrockIdForTier(mapModelToClaude(model)));
}

/**
 * Whether the resolved profile needs `thinking` stated EXPLICITLY rather than by
 * omission — and if so, what to send.
 *
 * `toBedrockRequest` drops `thinking` entirely (see its comment). On Opus 4.6 —
 * today's default everywhere — omitting the field means NO thinking, so dropping
 * it is free. That stops being true for the newer models:
 *
 *  - Opus 5 THINKS when `thinking` is omitted. Combined with
 *    `DEFAULT_MAX_TOKENS = 4096` (which caps thinking + text *together*),
 *    background summary/classify/title calls would start truncating mid-answer
 *    and cost materially more. So a silent model swap is a behaviour change, not
 *    a model swap — send `{type:"disabled"}` explicitly. Bedrock accepts that at
 *    the default effort (`high`); it 400s only at `xhigh`/`max`, which this path
 *    never sends.
 *  - Fable 5 thinks UNCONDITIONALLY and 400s on `{type:"disabled"}` at any
 *    effort, so it must be left omitted — there is nothing to opt out of.
 */
function thinkingOverrideFor(modelId: string): { type: "disabled" } | undefined {
  if (modelId.includes("claude-fable-")) return undefined;
  if (modelId.includes("claude-opus-5")) return { type: "disabled" };
  return undefined;
}

// ---------------------------------------------------------------------------
// Request translation (pure)

/** The Bedrock InvokeModel body: an Anthropic Messages body minus `model`. */
export interface BedrockInvokeBody {
  anthropic_version: string;
  max_tokens: number;
  messages: unknown[];
  system?: unknown[];
  tools?: unknown[];
  tool_choice?: Record<string, unknown>;
  /** Only ever set for models that think by DEFAULT — see `thinkingOverrideFor`. */
  thinking?: { type: "disabled" };
}

export interface BedrockRequest {
  modelId: string;
  stream: boolean;
  invokeBody: BedrockInvokeBody;
}

/**
 * OpenAI chat.completions body -> Bedrock InvokeModel request.
 *
 * Delegates the whole translation to `toAnthropicRequest()`, then adapts the
 * result to Bedrock's wire shape:
 *  - `model` moves to the URL (returned as `modelId`), not the body.
 *  - `stream` selects the endpoint, so it is stripped from the body too.
 *  - `output_config` is dropped: `output_config.effort` is a first-party knob
 *    with no confirmed Bedrock parity, so sending it risks a 400.
 *  - adaptive `thinking` is dropped too — it predates Bedrock's Anthropic
 *    runtime schema, and the Bedrock tier is the *background* workload
 *    (summarise/classify/memory/digest), which does not need it. But "dropped"
 *    is not the same as "off": on models that think by default, omission means
 *    thinking is ON. `thinkingOverrideFor` states it explicitly for those rather
 *    than leaving the background tier's cost and truncation behaviour implicit.
 */
export function toBedrockRequest(body: Record<string, unknown>): BedrockRequest {
  const anthropic = toAnthropicRequest(body);
  const modelId = mapModelToBedrock(String(body.model ?? CLAUDE_DEFAULT_MODEL));
  const stream = anthropic.stream === true;

  const invokeBody: BedrockInvokeBody = {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    max_tokens: anthropic.max_tokens,
    messages: anthropic.messages,
  };
  // `system` and `tools` are forwarded VERBATIM, cache_control breakpoints
  // included — Bedrock honours them and they are what make
  // `cache_read_input_tokens` non-zero on this path (see logBedrockUsage
  // below). Do not rebuild or filter these arrays: dropping the breakpoint set
  // by toAnthropicRequest() silently turns every turn into a full-price
  // uncached prompt, with no error to notice it by.
  if (anthropic.system) invokeBody.system = anthropic.system;
  if (anthropic.tools) invokeBody.tools = anthropic.tools;
  if (anthropic.tool_choice) invokeBody.tool_choice = anthropic.tool_choice;
  const thinking = thinkingOverrideFor(modelId);
  if (thinking) invokeBody.thinking = thinking;

  return { modelId, stream, invokeBody };
}

// ---------------------------------------------------------------------------
// Streaming: AWS event-stream framing -> OpenAI SSE

/**
 * Parse the header block of one AWS event-stream frame. Every header on a
 * Bedrock chunk/exception frame is a string (type 7): `:message-type`,
 * `:event-type`, `:content-type`, and — on failures — `:exception-type`. Any
 * other value type stops the parse, which is safe because we only read those
 * string headers; the payload carries everything else.
 */
function parseEventStreamHeaders(
  bytes: Uint8Array,
  decoder: TextDecoder,
): Record<string, string> {
  const out: Record<string, string> = {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i < bytes.length) {
    const nameLen = dv.getUint8(i);
    i += 1;
    const name = decoder.decode(bytes.subarray(i, i + nameLen));
    i += nameLen;
    const type = dv.getUint8(i);
    i += 1;
    if (type !== 7) break; // string headers only; bail on anything else
    const valLen = dv.getUint16(i);
    i += 2;
    out[name] = decoder.decode(bytes.subarray(i, i + valLen));
    i += valLen;
  }
  return out;
}

/** base64 (Bedrock's `bytes` field) -> UTF-8 string, safe for multibyte text. */
function base64ToUtf8(b64: string, decoder: TextDecoder): string {
  const raw = atob(b64);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return decoder.decode(bytes);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Bedrock event-stream (application/vnd.amazon.eventstream) -> OpenAI
 * `chat.completion.chunk` SSE, the exact framing session.ts / useUnifiedChat.ts
 * already parse. Frames may straddle network reads, so bytes are buffered until
 * a whole frame (declared by its 4-byte total-length prelude) is available.
 *
 * Each data frame's payload is `{"bytes": base64(<Anthropic SSE event JSON>)}`;
 * the inner event is the same shape claudeAdapter translates, so only the
 * text_delta / error / stop cases are handled here.
 */
export function bedrockEventStreamToOpenAI(
  source: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // Annotated (not inferred): the reader hands back ArrayBufferLike-backed
  // arrays, so an inferred ArrayBuffer-backed accumulator would not accept them.
  let buf: Uint8Array = new Uint8Array(0);

  const chunk = (delta: Record<string, unknown>) =>
    encoder.encode(
      `data: ${JSON.stringify({
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
  const done = () => encoder.encode("data: [DONE]\n\n");

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) {
          controller.enqueue(done());
          controller.close();
          return;
        }
        buf = concatBytes(buf, value);

        let emitted = false;
        while (buf.length >= 12) {
          const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const totalLen = dv.getUint32(0);
          if (buf.length < totalLen) break; // frame incomplete — wait for more
          const headersLen = dv.getUint32(4);
          const headerBytes = buf.subarray(12, 12 + headersLen);
          const payloadBytes = buf.subarray(12 + headersLen, totalLen - 4);
          buf = buf.subarray(totalLen);

          const hdrs = parseEventStreamHeaders(headerBytes, decoder);
          const payloadText = decoder.decode(payloadBytes);

          // A frame-level exception (throttling, validation) arrives after the
          // 200 headers, so the only place to surface it is inside the stream.
          if (hdrs[":message-type"] === "exception" || hdrs[":exception-type"]) {
            let detail = payloadText;
            try {
              detail = String(JSON.parse(payloadText).message ?? payloadText);
            } catch { /* keep raw */ }
            const label = hdrs[":exception-type"] ?? "bedrock error";
            console.error("[bedrock] stream exception:", label, detail);
            controller.enqueue(chunk({ content: `\n\n[${label}: ${detail}]` }));
            controller.enqueue(done());
            controller.close();
            return;
          }

          let inner: Record<string, any>;
          try {
            const wrapper = JSON.parse(payloadText);
            if (typeof wrapper.bytes !== "string") continue;
            inner = JSON.parse(base64ToUtf8(wrapper.bytes, decoder));
          } catch {
            continue;
          }

          if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
            controller.enqueue(chunk({ content: String(inner.delta.text ?? "") }));
            emitted = true;
          } else if (inner.type === "error") {
            const message = String(inner.error?.message ?? "Bedrock stream error");
            console.error("[bedrock] stream error:", message);
            controller.enqueue(chunk({ content: `\n\n[${message}]` }));
            controller.enqueue(done());
            controller.close();
            return;
          }
          // message_start/_stop, content_block_start/_stop, thinking_delta,
          // input_json_delta: not part of the visible transcript — skipped.
        }
        if (emitted) return;
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

// ---------------------------------------------------------------------------
// Transport

/** AWS credentials from the environment. Never hardcoded, never committed. */
export function awsCredentialsFromEnv(): AwsCredentials | null {
  const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = Deno.env.get("AWS_SESSION_TOKEN") || undefined;
  return { accessKeyId, secretAccessKey, sessionToken };
}

export function bedrockRegion(): string {
  return Deno.env.get("AWS_REGION") ?? DEFAULT_REGION;
}

function logBedrockUsage(usage: Record<string, number> | undefined, model: string) {
  if (!usage) return;
  console.log(
    `[bedrockAdapter] ${model} in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`,
  );
}

/**
 * OpenAI-shaped request in, OpenAI-shaped `Response` out — a drop-in twin of
 * `claudeChatCompletion` that talks to Bedrock. Non-OK upstream responses are
 * returned untouched so callers keep reading `.status` / `.text()` unchanged.
 */
export async function bedrockChatCompletion(body: Record<string, unknown>): Promise<Response> {
  const credentials = awsCredentialsFromEnv();
  if (!credentials) {
    return new Response(
      JSON.stringify({ error: { message: "AWS credentials not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)" } }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const region = bedrockRegion();
  const { modelId, stream, invokeBody } = toBedrockRequest(body);
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const action = stream ? "invoke-with-response-stream" : "invoke";
  const url = `https://${host}/model/${encodeURIComponent(modelId)}/${action}`;
  const payload = JSON.stringify(invokeBody);

  const signed = await signRequest({
    method: "POST",
    url,
    region,
    service: "bedrock",
    credentials,
    now: amzDateParts(new Date()),
    headers: { "content-type": "application/json" },
    body: payload,
  });
  // `accept` need not be signed (extra headers are allowed); it selects the
  // response framing.
  const headers: Record<string, string> = {
    ...signed,
    accept: stream ? "application/vnd.amazon.eventstream" : "application/json",
  };

  const upstream = await fetch(url, { method: "POST", headers, body: payload });
  if (!upstream.ok) return upstream;

  if (stream) {
    return new Response(bedrockEventStreamToOpenAI(upstream.body!, modelId), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const data = (await upstream.json()) as AnthropicMessageResponse;
  logBedrockUsage(data.usage, modelId);
  // Bedrock omits `model` from the invoke response; stamp it so downstream
  // logging/telemetry sees which profile answered.
  return new Response(JSON.stringify(fromAnthropicMessage({ ...data, model: data.model ?? modelId })), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
