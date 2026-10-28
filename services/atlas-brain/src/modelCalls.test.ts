import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// The gateway reads its provider and keys through Deno.env, as in production.
import "./denoShim";
import {
  aiChatCompletion,
  probeAIProvider,
  setModelCallObserver,
  type ModelCallRecord,
} from "../../../supabase/functions/_shared/aiGateway";
import { STREAM_CANCELLED, createStreamTally, type StreamOutcome } from "../../../supabase/functions/_shared/claudeAdapter";
import {
  MAX_ROWS,
  clampDays,
  ensureModelCallsTable,
  estimateCost,
  percentile,
  priceKey,
  priceOf,
  pruneModelCalls,
  readModelCallsSummary,
  recordModelCall,
  startOfLocalDay,
} from "./modelCalls";
import { aiProviderService, createProviderProbeCache } from "./providerProbe";

const NOW = new Date(2026, 9, 28, 12, 0, 0);

function record(over: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    lane: "anthropic",
    provider: "anthropic",
    requestedModel: "google/gemini-2.5-flash",
    model: "claude-sonnet-5",
    stream: false,
    status: 200,
    ok: true,
    error: null,
    latencyMs: 400,
    durationMs: 400,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    startedAt: NOW.getTime() - 60_000,
    ...over,
  };
}

/** Run `fn` with env vars set, restoring the prior values afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Prices

describe("prices", () => {
  test("first-party ids and Bedrock profiles of one model share a row", () => {
    expect(priceKey("claude-opus-4-6")).toBe("opus 4.6");
    expect(priceKey("eu.anthropic.claude-opus-4-6-v1")).toBe("opus 4.6");
    expect(priceKey("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("haiku 4.5");
    expect(priceKey("claude-sonnet-5")).toBe("sonnet 5");
    expect(priceKey("gemini-2.5-flash")).toBeNull();
    expect(priceOf("eu.anthropic.claude-sonnet-4-6")?.input).toBe(3);
    expect(priceOf("claude-fable-5")?.output).toBe(50);
    expect(priceOf("claude-opus-9")).toBeNull();
  });

  test("a profile a Keychain override points at is priced as its own model", () => {
    expect(priceKey("eu.anthropic.claude-opus-5-5")).toBe("opus 5.5");
    expect(priceOf("eu.anthropic.claude-opus-5-5")).toMatchObject({ input: 4, output: 20 });
    expect(priceOf("claude-fable-5-1")?.cacheRead).toBe(0.25);
    // Fable 5.1 is not Fable 5: the minor version picks the row.
    expect(priceOf("claude-fable-5")?.cacheRead).toBe(1);
    // Priced by prompt length, so no single rate: stored without a cost.
    expect(priceOf("claude-haiku-5-5")).toBeNull();
    expect(estimateCost("claude-haiku-5-5", { inputTokens: 10, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null })).toBeNull();
  });

  test("cost adds the uncached input, the output and both cache sides", () => {
    // Sonnet 5: $2 in, $10 out, $0.20 cache read, $2.50 cache write per MTok.
    const cost = estimateCost("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 200_000 });
    expect(cost).toBeCloseTo(2 + 1 + 0.1 + 0.5, 10);
  });

  test("no tokens or no price is no cost, never zero", () => {
    expect(estimateCost("claude-sonnet-5", { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null })).toBeNull();
    expect(estimateCost("gemini-2.5-flash", { inputTokens: 10, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null })).toBeNull();
  });
});

describe("percentile", () => {
  test("nearest rank; with few calls p95 is the slowest", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([300, 100, 200], 95)).toBe(300);
    expect(percentile([300, 100, 200], 50)).toBe(200);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 50)).toBe(50);
  });

  test("the route's day window is clamped", () => {
    expect(clampDays(null)).toBe(30);
    expect(clampDays("7")).toBe(7);
    expect(clampDays("0")).toBe(30);
    expect(clampDays("9999")).toBe(365);
  });
});

// ---------------------------------------------------------------------------
// The ledger

describe("ledger", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    ensureModelCallsTable(db);
  });

  test("a recorded call is priced and stored", () => {
    recordModelCall(db, record(), "a");
    const row = db.query("SELECT * FROM atlas_model_calls WHERE id = 'a'").get() as Record<string, unknown>;
    expect(row.model).toBe("claude-sonnet-5");
    expect(row.ok).toBe(1);
    expect(row.latency_ms).toBe(400);
    expect(row.cost_usd as number).toBeCloseTo((1000 * 2 + 200 * 10) / 1_000_000, 12);
    expect(row.started_at).toBe(new Date(NOW.getTime() - 60_000).toISOString());
  });

  test("the summary groups per model and per lane, and counts today", () => {
    recordModelCall(db, record({ latencyMs: 100 }), "1");
    recordModelCall(db, record({ latencyMs: 300 }), "2");
    recordModelCall(db, record({ ok: false, status: 529, error: "HTTP 529", latencyMs: 9000, inputTokens: null, outputTokens: null }), "3");
    recordModelCall(db, record({ lane: "bedrock", provider: "bedrock", model: "eu.anthropic.claude-haiku-4-5-20251001-v1:0", inputTokens: 50, outputTokens: 5, latencyMs: 1800 }), "4");
    // Yesterday, inside the window: counted in the window, not today.
    recordModelCall(db, record({ startedAt: new Date(2026, 9, 27, 10, 0).getTime() }), "5");
    // Outside a seven-day window.
    recordModelCall(db, record({ startedAt: new Date(2026, 8, 1).getTime() }), "6");

    const s = readModelCallsSummary(db, 7, NOW, "anthropic");
    expect(s.running_lane).toBe("anthropic");
    expect(s.recording_since).toBe(new Date(2026, 8, 1).toISOString());
    expect(s.today).toEqual({ since: startOfLocalDay(NOW), calls: 4, failed: 1 });
    expect(s.total.calls).toBe(5);
    expect(s.total.failed).toBe(1);

    const sonnet = s.models.find((m) => m.model === "claude-sonnet-5")!;
    expect(sonnet.calls).toBe(4);
    expect(sonnet.failed).toBe(1);
    expect(sonnet.input_tokens).toBe(3000);
    expect(sonnet.unpriced_calls).toBe(1);
    expect(sonnet.cost_usd).toBeCloseTo(3 * 0.004, 12);
    expect(s.models[0].model).toBe("claude-sonnet-5");

    const first = s.lanes.find((l) => l.lane === "anthropic")!;
    // The failed call's nine seconds are not the provider's speed.
    expect(first).toMatchObject({ calls: 4, ok: 3, p95_ms: 400, p50_ms: 300 });
    expect(s.lanes.find((l) => l.lane === "bedrock")).toMatchObject({ calls: 1, ok: 1, p95_ms: 1800 });
  });

  test("an empty ledger says nothing was recorded rather than zero cost", () => {
    const s = readModelCallsSummary(db, 30, NOW, null);
    expect(s.models).toEqual([]);
    expect(s.lanes).toEqual([]);
    expect(s.total.cost_usd).toBeNull();
    expect(s.recording_since).toBeNull();
  });

  test("pruning drops old rows and keeps the newest under the cap", () => {
    recordModelCall(db, record({ startedAt: new Date(2026, 3, 1).getTime() }), "old");
    for (let i = 0; i < 5; i++) recordModelCall(db, record({ startedAt: NOW.getTime() - i * 1000 }), `n${i}`);
    expect(pruneModelCalls(db, NOW, 90, 3)).toBe(3);
    const ids = (db.query("SELECT id FROM atlas_model_calls ORDER BY started_at DESC").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["n0", "n1", "n2"]);
    expect(MAX_ROWS).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// The gateway seam: every aiChatCompletion call reaches the observer

describe("gateway recording", () => {
  const realFetch = globalThis.fetch;
  let seen: ModelCallRecord[] = [];
  beforeEach(() => {
    seen = [];
    setModelCallObserver((r) => seen.push(r));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    setModelCallObserver(null);
  });

  const firstParty = { ATLAS_AI_PROVIDER: undefined, ANTHROPIC_API_KEY: "test-key", ATLAS_ALLOW_LEGACY_PROVIDERS: undefined };

  test("a blocking call is reported with its tokens and the model it invoked", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "end_turn",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await withEnv(firstParty, async () => {
      const res = await aiChatCompletion({ model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] });
      // The caller's body is untouched by the recorder's read of a clone.
      expect((await res.json()).choices[0].message.content).toBe("hi");
    });
    await Bun.sleep(5);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      lane: "anthropic", provider: "anthropic", requestedModel: "google/gemini-2.5-flash", model: "claude-sonnet-5",
      stream: false, status: 200, ok: true, inputTokens: 12, outputTokens: 3, cacheReadTokens: 40,
    });
    expect(seen[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("a stream is reported once, when it ends, with the usage it carried", async () => {
    const enc = new TextEncoder();
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 1 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        c.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    await withEnv(firstParty, async () => {
      const res = await aiChatCompletion({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }], stream: true });
      expect(seen.length).toBe(0);
      expect(await res.text()).toContain("Hello");
    });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ lane: "anthropic", model: "claude-haiku-4-5", stream: true, ok: true, inputTokens: 20, outputTokens: 9 });
    expect(seen[0].durationMs).not.toBeNull();
  });

  test("a stream whose connection drops mid-answer is a failed call, and the reader still sees the error", async () => {
    const enc = new TextEncoder();
    const start = { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 1 } } };
    const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } };
    globalThis.fetch = (async () => {
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent) {
            c.error(new Error("socket hang up"));
            return;
          }
          sent = true;
          c.enqueue(enc.encode(`data: ${JSON.stringify(start)}\n\ndata: ${JSON.stringify(delta)}\n\n`));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    await withEnv(firstParty, async () => {
      const res = await aiChatCompletion({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], stream: true });
      await expect(res.text()).rejects.toThrow("socket hang up");
    });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ lane: "anthropic", stream: true, status: 200, ok: false, error: "socket hang up", inputTokens: 30 });
  });

  test("an error answer is a failed call with its status", async () => {
    globalThis.fetch = (async () => new Response('{"error":{"type":"invalid_request_error"}}', { status: 400 })) as unknown as typeof fetch;
    await withEnv(firstParty, async () => {
      const res = await aiChatCompletion({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(400);
    });
    await Bun.sleep(5);
    expect(seen[0]).toMatchObject({ ok: false, status: 400, model: "claude-opus-4-8", inputTokens: null });
    expect(seen[0].error).toContain("HTTP 400");
  });

  test("a network failure is reported and still thrown to the caller", async () => {
    globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    await withEnv(firstParty, async () => {
      await expect(aiChatCompletion({ model: "claude-sonnet-5", messages: [] })).rejects.toThrow("ECONNREFUSED");
    });
    expect(seen[0]).toMatchObject({ ok: false, status: null, error: "connect ECONNREFUSED" });
  });

  test("an observer that throws never fails the answer", async () => {
    setModelCallObserver(() => { throw new Error("disk full"); });
    globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await withEnv(firstParty, async () => {
      const res = await aiChatCompletion({ model: "claude-sonnet-5", messages: [] });
      expect(res.ok).toBe(true);
    });
  });
});

describe("stream tally", () => {
  test("ends exactly once; a reader's cancel is marked as such", () => {
    const ends: StreamOutcome[] = [];
    const t = createStreamTally((o) => ends.push(o));
    t.observe({ type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 7 } } });
    t.observe({ type: "message_delta", usage: { output_tokens: 3 } });
    t.observe({ type: "message_delta", usage: { output_tokens: 8 } });
    t.end(STREAM_CANCELLED);
    t.end();
    expect(ends).toEqual([{ inputTokens: 5, outputTokens: 8, cacheReadTokens: 7, cacheWriteTokens: null, error: STREAM_CANCELLED }]);
  });

  test("Bedrock's own count is only a fallback", () => {
    const ends: StreamOutcome[] = [];
    const t = createStreamTally((o) => ends.push(o));
    t.observe({ type: "message_stop", "amazon-bedrock-invocationMetrics": { inputTokenCount: 11, outputTokenCount: 4 } });
    t.end();
    expect(ends[0]).toMatchObject({ inputTokens: 11, outputTokens: 4, error: null });
  });
});

// ---------------------------------------------------------------------------
// The provider probe

describe("provider probe", () => {
  const answer = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response("{}", { status, headers })) as unknown as typeof fetch;

  test("first-party: a listed model is reachable, a 401 is a refused key", async () => {
    await withEnv({ ATLAS_AI_PROVIDER: undefined, ANTHROPIC_API_KEY: "test-key" }, async () => {
      const ok = await probeAIProvider(answer(200));
      expect(ok).toMatchObject({ lane: "anthropic", ok: true, error: null });
      expect(ok.latencyMs).not.toBeNull();
      expect(await probeAIProvider(answer(401))).toMatchObject({ ok: false, detail: "Claude first-party · key refused", error: "HTTP 401" });
      const thrown = await probeAIProvider((async () => { throw new Error("offline"); }) as unknown as typeof fetch);
      expect(thrown).toMatchObject({ ok: false, latencyMs: null, detail: "Not reachable from this Mac", error: "offline" });
    });
  });

  test("Bedrock: an invoke-only key refused the listing still proves the key works", async () => {
    await withEnv({ ATLAS_AI_PROVIDER: "bedrock", AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "eu-central-1" }, async () => {
      const denied = await probeAIProvider(answer(403, { "x-amzn-errortype": "AccessDeniedException:http://internal" }));
      expect(denied).toMatchObject({ lane: "bedrock", ok: true });
      const bad = await probeAIProvider(answer(403, { "x-amzn-errortype": "UnrecognizedClientException:http://internal" }));
      expect(bad).toMatchObject({ lane: "bedrock", ok: false });
    });
  });

  test("no key is a down row that says so", async () => {
    await withEnv({ ATLAS_AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined, ATLAS_ALLOW_LEGACY_PROVIDERS: undefined }, async () => {
      const p = await probeAIProvider(answer(200));
      expect(p).toMatchObject({ lane: null, ok: false, detail: "No AI key on this Mac" });
      expect(aiProviderService({ probe: p, at: 0, cached: false }).status).toBe("down");
    });
  });

  test("the cache answers for a minute, shares a probe in flight, and re-probes on request", async () => {
    let clock = 1_000;
    let calls = 0;
    const cache = createProviderProbeCache(async () => {
      calls++;
      await Bun.sleep(1);
      return { lane: "anthropic", ok: true, latencyMs: 80, detail: "Claude first-party · key accepted", error: null };
    }, 60_000, () => clock);

    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(calls).toBe(1);
    expect(a.cached || b.cached).toBe(false);
    clock += 30_000;
    expect((await cache.get()).cached).toBe(true);
    expect(calls).toBe(1);
    expect((await cache.get(true)).cached).toBe(false);
    expect(calls).toBe(2);
    clock += 61_000;
    await cache.get();
    expect(calls).toBe(3);

    const row = aiProviderService(await cache.get());
    expect(row).toMatchObject({ name: "ai-provider", status: "healthy", latency_ms: 80, cached: true });
  });
});
