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

/** Every logical id a call site can hand the gateway, plus the tier names. */
const ALL_MAPPED_IDS = [
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "openai/gpt-5-nano",
  "openai/gpt-5-mini",
  "openai/gpt-5",
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-5",
];

/** Run `fn` with env vars set, restoring the prior values afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Every id asserted below was verified by an actual InvokeModel call against
// eu-central-1 as the atlas-brain IAM user (2026-07-28) — existence in
// `list-inference-profiles` was NOT sufficient, since sonnet-5 / opus-4-8 /
// opus-4-7 all list fine yet fail with "not available for this account".
test("mapModelToBedrock: logical ids resolve to invocable EU profiles", () => {
  expect(mapModelToBedrock("google/gemini-2.5-flash")).toBe("eu.anthropic.claude-sonnet-4-6");
  expect(mapModelToBedrock("openai/gpt-5")).toBe("eu.anthropic.claude-opus-4-6-v1");
  expect(mapModelToBedrock("claude-haiku-4-5"))
    .toBe("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
  expect(mapModelToBedrock("google/gemini-2.5-flash-lite"))
    .toBe("eu.anthropic.claude-haiku-4-5-20251001-v1:0");
});

test("mapModelToBedrock: never targets a model this account cannot invoke", () => {
  // Guards the exact regression that a well-meaning "upgrade to the newest
  // model" edit would introduce: these profiles exist but are denied (or, for
  // opus-5, have never returned a successful InvokeModel), so mapping to one
  // turns every background call into an AccessDeniedException — which on a
  // streaming call is injected into the user's transcript, not just logged.
  // Promote an entry out of this list only alongside a live invocation.
  const notProvenInvocable = [
    "eu.anthropic.claude-sonnet-5",
    "eu.anthropic.claude-opus-4-8",
    "eu.anthropic.claude-opus-4-7",
    // Confirmed DENIED 2026-07-30, and denied to the ROOT account too — so this
    // is an Anthropic-side entitlement, not an IAM gap. Reachable via
    // BEDROCK_MODEL_OPUS_5 once access is granted; never a default until then.
    "eu.anthropic.claude-opus-5",
  ];
  for (const logical of ALL_MAPPED_IDS) {
    expect(notProvenInvocable).not.toContain(mapModelToBedrock(logical));
  }
});

test("mapModelToBedrock: every default still resolves to an eu. profile", () => {
  // Non-EEA profiles became PERMITTED on 2026-08-02, but no default was moved to
  // one. That distinction is the whole point of this test surviving the change:
  // reaching outside the EEA must stay an explicit per-tier override, so the
  // residency posture of an ordinary install cannot drift by accident.
  for (const logical of ALL_MAPPED_IDS) {
    expect(mapModelToBedrock(logical).startsWith("eu.anthropic.")).toBe(true);
  }
});

test("mapModelToBedrock: claude-opus-5 is reachable only via its env override", () => {
  // The tier key exists so callers can ask for Opus 5 by name, but until a live
  // InvokeModel proves entitlement it resolves to the newest Opus that answers.
  expect(mapModelToBedrock("claude-opus-5")).toBe("eu.anthropic.claude-opus-4-6-v1");
  withEnv({ BEDROCK_MODEL_OPUS_5: "eu.anthropic.claude-opus-5" }, () => {
    expect(mapModelToBedrock("claude-opus-5")).toBe("eu.anthropic.claude-opus-5");
  });
});

test("mapModelToBedrock: Fable 5 is reachable via its override, never by default", () => {
  // There is no `eu.` Fable profile at all, so Fable can only be reached through
  // a worldwide-routing `global.` id. Since 2026-08-02 that is permitted, so the
  // second gate (ATLAS_BEDROCK_ALLOW_NON_EEA) is gone — but the tier still has no
  // default, because no live InvokeModel has answered on it yet.
  expect(() => mapModelToBedrock("claude-fable-5")).toThrow(/no inference profile mapped/);

  withEnv({ BEDROCK_MODEL_FABLE_5: "global.anthropic.claude-fable-5" }, () => {
    expect(mapModelToBedrock("claude-fable-5")).toBe("global.anthropic.claude-fable-5");
  });
});

test("ATLAS_BEDROCK_EEA_ONLY=1 restores EEA confinement", () => {
  // The inverse of the flag this replaced. It is the one-line revert if the
  // policy position changes back, and the switch an EEA-only deployment turns on
  // — so it has to keep working even though nothing sets it today.
  withEnv(
    {
      BEDROCK_MODEL_FABLE_5: "global.anthropic.claude-fable-5",
      ATLAS_BEDROCK_EEA_ONLY: "1",
    },
    () => {
      expect(() => mapModelToBedrock("claude-fable-5")).toThrow(/non-EEA/);
      // An already-resolved non-eu. id is refused on the passthrough path too,
      // not just the tier path.
      expect(() => mapModelToBedrock("us.anthropic.claude-opus-4-6-v1")).toThrow(/non-EEA/);
      // eu. profiles are unaffected.
      expect(mapModelToBedrock("claude-haiku-4-5")).toBe(
        "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      );
    },
  );
});

test("a non-EEA profile passes through by default", () => {
  // The behaviour change itself: before 2026-08-02 this threw.
  expect(mapModelToBedrock("global.anthropic.claude-fable-5")).toBe(
    "global.anthropic.claude-fable-5",
  );
  expect(mapModelToBedrock("us.anthropic.claude-opus-4-6-v1")).toBe(
    "us.anthropic.claude-opus-4-6-v1",
  );
});

test("mapModelToBedrock: an unknown tier throws instead of synthesising an id", () => {
  // The old fallback returned `eu.anthropic.${tier}`, inventing profile ids that
  // may not exist. A map-time throw beats a per-request ValidationException.
  expect(() => mapModelToBedrock("claude-imaginary-9")).toThrow(/no inference profile mapped/);
});

test("mapModelToBedrock: an already-resolved eu. id passes through untouched", () => {
  // This is the load-bearing guard — without it the `eu.` id (which does not
  // start with "claude-") would collapse to the default tier.
  expect(mapModelToBedrock("eu.anthropic.claude-opus-5")).toBe("eu.anthropic.claude-opus-5");
  expect(mapModelToBedrock("eu.anthropic.claude-sonnet-4-6")).toBe("eu.anthropic.claude-sonnet-4-6");
});

test("mapModelToBedrock: a non-EEA passthrough id is permitted, and confinable", () => {
  // Inverted on 2026-08-02 along with the published policy. The old flag name
  // (ATLAS_BEDROCK_ALLOW_NON_EEA) is dead and must NOT re-enable confinement —
  // a leftover copy of it in someone's env should be inert, not load-bearing.
  expect(mapModelToBedrock("us.anthropic.claude-sonnet-5")).toBe("us.anthropic.claude-sonnet-5");
  expect(mapModelToBedrock("global.anthropic.claude-haiku-4-5-20251001-v1:0"))
    .toBe("global.anthropic.claude-haiku-4-5-20251001-v1:0");

  withEnv({ ATLAS_BEDROCK_ALLOW_NON_EEA: "0" }, () => {
    expect(mapModelToBedrock("us.anthropic.claude-sonnet-5")).toBe("us.anthropic.claude-sonnet-5");
  });

  withEnv({ ATLAS_BEDROCK_EEA_ONLY: "1" }, () => {
    expect(() => mapModelToBedrock("us.anthropic.claude-sonnet-5")).toThrow(/non-EEA/);
  });
});

// ---------------------------------------------------------------------------
// Request reshaping

test("toBedrockRequest: model leaves the body, anthropic_version enters it", () => {
  const { modelId, stream, invokeBody } = toBedrockRequest({
    model: "google/gemini-2.5-flash",
    messages: [{ role: "user", content: "hi" }],
  });

  expect(modelId).toBe("eu.anthropic.claude-sonnet-4-6");
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

test("toBedrockRequest: thinking is stated explicitly for models that think by default", () => {
  // Omitting `thinking` means NO thinking on Opus 4.6 but thinking ON on Opus 5.
  // Since max_tokens caps thinking + text together, a silent swap would truncate
  // background summaries mid-answer, so the background tier opts out explicitly.
  const onDefault = toBedrockRequest({
    model: "openai/gpt-5",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(onDefault.modelId).toBe("eu.anthropic.claude-opus-4-6-v1");
  expect(onDefault.invokeBody.thinking).toBeUndefined();

  const onOpus5 = toBedrockRequest({
    model: "eu.anthropic.claude-opus-5",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(onOpus5.invokeBody.thinking).toEqual({ type: "disabled" });

  // Fable 5 thinks unconditionally and 400s on {type:"disabled"} — leave it off.
  const onFable = toBedrockRequest({
    model: "global.anthropic.claude-fable-5",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(onFable.invokeBody.thinking).toBeUndefined();
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
