import { test, expect } from "bun:test";
// Establish the Deno.env shim the brain installs at startup — the adapter reads
// per-tier model overrides via Deno.env.get, exactly as it does in production.
import "./denoShim";
import {
  bedrockEventStreamToOpenAI,
  mapModelToBedrock,
  toBedrockRequest,
} from "../../../supabase/functions/_shared/bedrockAdapter";

// The Bedrock adapter reuses claudeAdapter's Messages<->OpenAI translation, so
// these tests pin only what is Bedrock-specific: the model-id mapping (whose
// `eu.anthropic.` prefix defeats claudeAdapter's `startsWith("claude-")` guard),
// the invoke-body reshaping, and the AWS event-stream frame decoder. The live
// SigV4 signing path is covered by awsSigV4.test.ts; the account cannot invoke
// Bedrock until the one-time Anthropic use-case form is submitted, so the
// streaming test builds a real event-stream frame by hand instead.

// ---------------------------------------------------------------------------
// Model mapping

// Every id asserted below was verified to exist via
// `aws bedrock list-inference-profiles --region eu-central-1` (2026-07-28).
test("mapModelToBedrock: logical ids resolve to EU inference profiles", () => {
  expect(mapModelToBedrock("google/gemini-2.5-flash")).toBe("eu.anthropic.claude-sonnet-5");
  expect(mapModelToBedrock("openai/gpt-5")).toBe("eu.anthropic.claude-opus-5");
});

test("mapModelToBedrock: the cheap tier stays in the EEA (no EU Haiku exists)", () => {
  // Bedrock publishes Haiku 4.5 only as a `global.*` profile, which routes
  // worldwide. Mapping the cheap tier to EU Sonnet is what keeps the privacy
  // policy's residency claim true; if this ever returns a `global.` id, that
  // claim silently breaks — hence the explicit assertion.
  expect(mapModelToBedrock("claude-haiku-4-5")).toBe("eu.anthropic.claude-sonnet-5");
  expect(mapModelToBedrock("google/gemini-2.5-flash-lite")).toBe("eu.anthropic.claude-sonnet-5");
  expect(mapModelToBedrock("claude-sonnet-5")).toBe("eu.anthropic.claude-sonnet-5");
});

test("mapModelToBedrock: every default resolves to an eu. profile", () => {
  for (const logical of [
    "google/gemini-2.5-flash-lite",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-pro",
    "openai/gpt-5-nano",
    "openai/gpt-5-mini",
    "openai/gpt-5",
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
  ]) {
    expect(mapModelToBedrock(logical).startsWith("eu.anthropic.")).toBe(true);
  }
});

test("mapModelToBedrock: an already-resolved Bedrock id passes through untouched", () => {
  // This is the load-bearing guard — without it the `eu.` id (which does not
  // start with "claude-") would collapse to the default tier.
  expect(mapModelToBedrock("eu.anthropic.claude-opus-5")).toBe("eu.anthropic.claude-opus-5");
  expect(mapModelToBedrock("us.anthropic.claude-sonnet-5")).toBe("us.anthropic.claude-sonnet-5");
  expect(mapModelToBedrock("global.anthropic.claude-haiku-4-5-20251001-v1:0"))
    .toBe("global.anthropic.claude-haiku-4-5-20251001-v1:0");
});

// ---------------------------------------------------------------------------
// Request reshaping

test("toBedrockRequest: model leaves the body, anthropic_version enters it", () => {
  const { modelId, stream, invokeBody } = toBedrockRequest({
    model: "google/gemini-2.5-flash",
    messages: [{ role: "user", content: "hi" }],
  });

  expect(modelId).toBe("eu.anthropic.claude-sonnet-5");
  expect(stream).toBe(false);
  expect(invokeBody.anthropic_version).toBe("bedrock-2023-05-31");

  // These four keys must be ABSENT from the invoke body: Bedrock takes the model
  // in the URL and the stream flag in the endpoint, and rejects the first-party
  // thinking / output_config knobs.
  const asRecord = invokeBody as unknown as Record<string, unknown>;
  expect(asRecord.model).toBeUndefined();
  expect(asRecord.stream).toBeUndefined();
  expect(asRecord.thinking).toBeUndefined();
  expect(asRecord.output_config).toBeUndefined();
  expect(invokeBody.max_tokens).toBeGreaterThan(0);
  expect(Array.isArray(invokeBody.messages)).toBe(true);
});

test("toBedrockRequest: stream=true selects the streaming endpoint", () => {
  const { stream } = toBedrockRequest({
    model: "claude-sonnet-5",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(stream).toBe(true);
});

// ---------------------------------------------------------------------------
// AWS event-stream decoder

/** Build one AWS event-stream frame: 12-byte prelude, string headers, payload. */
function buildFrame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const enc = new TextEncoder();

  const headerParts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k);
    const val = enc.encode(v);
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length);
    const dv = new DataView(h.buffer);
    let o = 0;
    dv.setUint8(o, name.length); o += 1;
    h.set(name, o); o += name.length;
    dv.setUint8(o, 7); o += 1; // value type 7 = string
    dv.setUint16(o, val.length); o += 2;
    h.set(val, o);
    headerParts.push(h);
  }
  const headerBytes = headerParts.reduce<Uint8Array>((acc, part) => {
    const out = new Uint8Array(acc.length + part.length);
    out.set(acc);
    out.set(part, acc.length);
    return out;
  }, new Uint8Array(0));

  const payloadBytes = enc.encode(JSON.stringify(payload));
  const totalLen = 12 + headerBytes.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLen);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, totalLen);
  dv.setUint32(4, headerBytes.length);
  dv.setUint32(8, 0); // prelude CRC — the decoder ignores it (TLS is the guard)
  frame.set(headerBytes, 12);
  frame.set(payloadBytes, 12 + headerBytes.length);
  // trailing 4-byte message CRC left as zero — also ignored.
  return frame;
}

/** A Bedrock data frame carries `{"bytes": base64(<Anthropic SSE event>)}`. */
function chunkFrame(anthropicEvent: unknown): Uint8Array {
  const eventJson = JSON.stringify(anthropicEvent);
  return buildFrame(
    { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" },
    { bytes: btoa(eventJson) },
  );
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

test("bedrockEventStreamToOpenAI: unwraps frames into OpenAI SSE deltas", async () => {
  const src = streamOf(
    chunkFrame({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }),
    chunkFrame({ type: "content_block_delta", delta: { type: "text_delta", text: ", world" } }),
    chunkFrame({ type: "message_stop" }),
  );

  const out = await collect(bedrockEventStreamToOpenAI(src, "eu.anthropic.claude-sonnet-5"));

  expect(out).toContain('"content":"Hello"');
  expect(out).toContain('"content":", world"');
  expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
});

test("bedrockEventStreamToOpenAI: a frame split across two reads still decodes", async () => {
  const frame = chunkFrame({ type: "content_block_delta", delta: { type: "text_delta", text: "split" } });
  const mid = Math.floor(frame.length / 2);
  const src = streamOf(frame.subarray(0, mid), frame.subarray(mid));

  const out = await collect(bedrockEventStreamToOpenAI(src, "m"));
  expect(out).toContain('"content":"split"');
});

test("bedrockEventStreamToOpenAI: an exception frame surfaces inside the stream", async () => {
  const exception = buildFrame(
    { ":message-type": "exception", ":exception-type": "throttlingException" },
    { message: "Too many requests" },
  );
  const out = await collect(bedrockEventStreamToOpenAI(streamOf(exception), "m"));

  expect(out).toContain("throttlingException");
  expect(out).toContain("Too many requests");
  expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
});
