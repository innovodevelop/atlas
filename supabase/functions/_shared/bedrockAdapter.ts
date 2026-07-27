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
 * Logical/first-party model id -> Bedrock EU inference-profile id.
 *
 * The exact Bedrock model-id strings can be confirmed in the console (Model
 * catalog → the model's detail page), so each tier is env-overridable
 * (`BEDROCK_MODEL_{HAIKU,SONNET,OPUS}`) — a wrong id fails with an opaque 404,
 * and we do NOT want a code edit + redeploy to correct a string. The defaults
 * follow the documented EU cross-region profile naming (`eu.` prefix keeps the
 * request inside the EEA — the residency guarantee the privacy policy leans on).
 */
function bedrockIdForTier(tier: string): string {
  const overrides: Record<string, string | undefined> = {
    "claude-haiku-4-5": Deno.env.get("BEDROCK_MODEL_HAIKU"),
    "claude-sonnet-5": Deno.env.get("BEDROCK_MODEL_SONNET"),
    "claude-opus-4-8": Deno.env.get("BEDROCK_MODEL_OPUS"),
  };
  const defaults: Record<string, string> = {
    "claude-haiku-4-5": "eu.anthropic.claude-haiku-4-5",
    "claude-sonnet-5": "eu.anthropic.claude-sonnet-5",
    "claude-opus-4-8": "eu.anthropic.claude-opus-4-8",
  };
  return overrides[tier] ?? defaults[tier] ?? `eu.anthropic.${tier}`;
}

/** A value that is already a Bedrock/inference-profile id (region-prefixed). */
const BEDROCK_ID = /^(eu|us|apac|anthropic)\./;

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
  if (BEDROCK_ID.test(model)) return model;
  return bedrockIdForTier(mapModelToClaude(model));
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
 *  - `thinking` and `output_config` are dropped: `output_config.effort` is a
 *    first-party knob with no confirmed Bedrock parity, and adaptive `thinking`
 *    predates Bedrock's Anthropic runtime schema — sending either risks a 400.
 *    The Bedrock tier is the *background* workload (summarise/classify/memory/
 *    digest), which does not need extended thinking, so dropping it is free.
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
  if (anthropic.system) invokeBody.system = anthropic.system;
  if (anthropic.tools) invokeBody.tools = anthropic.tools;
  if (anthropic.tool_choice) invokeBody.tool_choice = anthropic.tool_choice;

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
