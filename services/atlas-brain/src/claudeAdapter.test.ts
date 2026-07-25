/**
 * Translation tests for the OpenAI <-> Messages API seam. Pure functions only —
 * no network, no env. The invariant under test is that orchestrator.ts's tool
 * loop keeps seeing the exact OpenAI shape it has always consumed.
 */
import { describe, expect, it } from "bun:test";
import {
  anthropicSSEToOpenAI,
  fromAnthropicMessage,
  mapModelToClaude,
  mapStopReason,
  toAnthropicRequest,
} from "../../../supabase/functions/_shared/claudeAdapter.ts";

describe("mapModelToClaude", () => {
  it("maps the logical tiers", () => {
    expect(mapModelToClaude("google/gemini-2.5-flash-lite")).toBe("claude-haiku-4-5");
    expect(mapModelToClaude("openai/gpt-5-nano")).toBe("claude-haiku-4-5");
    expect(mapModelToClaude("google/gemini-2.5-flash")).toBe("claude-sonnet-5");
    expect(mapModelToClaude("openai/gpt-5-mini")).toBe("claude-sonnet-5");
    expect(mapModelToClaude("google/gemini-2.5-pro")).toBe("claude-opus-4-8");
    expect(mapModelToClaude("openai/gpt-5")).toBe("claude-opus-4-8");
  });

  it("passes through explicit claude ids", () => {
    expect(mapModelToClaude("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("falls back to the default tier for unknown ids", () => {
    expect(mapModelToClaude("some/unknown-model")).toBe("claude-sonnet-5");
  });
});

describe("toAnthropicRequest — system hoisting", () => {
  it("moves system messages to the top-level param and caches the last block", () => {
    const req = toAnthropicRequest({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "You are Atlas." },
        { role: "system", content: "## Memories\n- likes coffee" },
        { role: "user", content: "hi" },
      ],
    });

    expect(req.system).toEqual([
      { type: "text", text: "You are Atlas." },
      { type: "text", text: "## Memories\n- likes coffee", cache_control: { type: "ephemeral" } },
    ]);
    expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("omits system entirely when there are no system messages", () => {
    const req = toAnthropicRequest({ messages: [{ role: "user", content: "hi" }] });
    expect(req.system).toBeUndefined();
  });

  it("honours claude.cache=false", () => {
    const req = toAnthropicRequest({
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      claude: { cache: false },
    });
    expect(req.system?.[0].cache_control).toBeUndefined();
  });
});

describe("toAnthropicRequest — tool calls and results", () => {
  const toolLoopBody = {
    model: "google/gemini-2.5-flash",
    messages: [
      { role: "system", content: "You are Atlas." },
      { role: "user", content: "what's the weather?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "web_search", arguments: '{"query":"weather"}' } },
          { id: "toolu_2", type: "function", function: { name: "web_scrape", arguments: '{"url":"https://x"}' } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: '{"content":"sunny"}' },
      { role: "tool", tool_call_id: "toolu_2", content: '{"content":"page"}' },
    ],
  };

  it("converts assistant tool_calls to tool_use blocks with parsed input", () => {
    const req = toAnthropicRequest(toolLoopBody);
    expect(req.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "weather" } },
        { type: "tool_use", id: "toolu_2", name: "web_scrape", input: { url: "https://x" } },
      ],
    });
  });

  it("merges consecutive tool messages into ONE user turn of tool_result blocks", () => {
    const req = toAnthropicRequest(toolLoopBody);
    // Messages API requires alternating roles; the orchestrator emits one
    // `role:"tool"` message per call, so they must collapse into a single turn.
    expect(req.messages).toHaveLength(3);
    expect(req.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: '{"content":"sunny"}' },
        { type: "tool_result", tool_use_id: "toolu_2", content: '{"content":"page"}' },
      ],
    });
  });

  it("round-trips tool_calls through the response translation unchanged", () => {
    const openai = fromAnthropicMessage({
      id: "msg_1",
      model: "claude-sonnet-5",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Looking that up." },
        { type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "weather" } },
      ],
    });
    const choice = (openai.choices as any[])[0];
    const back = toAnthropicRequest({
      messages: [{ role: "assistant", ...choice.message }],
    });
    expect(back.messages[0].content).toEqual([
      { type: "text", text: "Looking that up." },
      { type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "weather" } },
    ]);
  });

  it("keeps assistant text alongside tool_use blocks", () => {
    const req = toAnthropicRequest({
      messages: [{
        role: "assistant",
        content: "One sec.",
        tool_calls: [{ id: "t1", type: "function", function: { name: "n", arguments: "{}" } }],
      }],
    });
    expect(req.messages[0].content).toEqual([
      { type: "text", text: "One sec." },
      { type: "tool_use", id: "t1", name: "n", input: {} },
    ]);
  });

  it("never produces an empty conversation", () => {
    const req = toAnthropicRequest({ messages: [{ role: "system", content: "s" }] });
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe("user");
  });
});

describe("toAnthropicRequest — tool definitions", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
      { type: "function", function: { name: "memory_store", description: "Store a fact" } },
    ],
    tool_choice: "auto",
  };

  it("rewrites parameters to input_schema and caches the last tool", () => {
    const req = toAnthropicRequest(body);
    expect(req.tools?.[0]).toEqual({
      name: "web_search",
      description: "Search the web",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });
    expect(req.tools?.[1].input_schema).toEqual({ type: "object", properties: {} });
    expect(req.tools?.[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("maps tool_choice", () => {
    expect(toAnthropicRequest(body).tool_choice).toEqual({ type: "auto" });
    expect(toAnthropicRequest({ ...body, tool_choice: "required" }).tool_choice).toEqual({ type: "any" });
    expect(
      toAnthropicRequest({ ...body, tool_choice: { type: "function", function: { name: "web_search" } } }).tool_choice,
    ).toEqual({ type: "tool", name: "web_search" });
  });

  it("drops tools and tool_choice when the caller sends none", () => {
    const req = toAnthropicRequest({ messages: [{ role: "user", content: "hi" }], tools: undefined, tool_choice: undefined });
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
  });
});

describe("toAnthropicRequest — sampling params and knobs", () => {
  it("strips temperature/top_p/top_k (400 on Sonnet 5 / Opus 4.8)", () => {
    const req = toAnthropicRequest({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      frequency_penalty: 1,
    });
    // Assert on the serialized body — that is what reaches the API.
    const wire = JSON.parse(JSON.stringify(req));
    expect(Object.keys(wire).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "thinking"]);
  });

  it("always sets max_tokens, with more headroom for streaming", () => {
    expect(toAnthropicRequest({ messages: [] }).max_tokens).toBe(4096);
    expect(toAnthropicRequest({ messages: [], stream: true }).max_tokens).toBe(16000);
    expect(toAnthropicRequest({ messages: [], claude: { max_tokens: 1024 } }).max_tokens).toBe(1024);
  });

  it("enables adaptive thinking only when no tools are declared", () => {
    // Thinking blocks carry signatures the OpenAI seam cannot replay, so the
    // tool-loop pass must not request them.
    const withTools = toAnthropicRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "n" } }],
    });
    expect(withTools.thinking).toBeUndefined();

    const streaming = toAnthropicRequest({ messages: [{ role: "user", content: "hi" }], stream: true });
    expect(streaming.thinking).toEqual({ type: "adaptive" });
  });

  it("lets callers override thinking and effort via the claude passthrough", () => {
    const req = toAnthropicRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "n" } }],
      claude: { thinking: true, effort: "xhigh" },
    });
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config).toEqual({ effort: "xhigh" });
  });

  it("defaults effort to medium", () => {
    expect(toAnthropicRequest({ messages: [] }).output_config).toEqual({ effort: "medium" });
  });
});

describe("mapStopReason", () => {
  it("maps Anthropic stop reasons onto OpenAI finish reasons", () => {
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("refusal")).toBe("content_filter");
    expect(mapStopReason(null)).toBe("stop");
  });
});

describe("fromAnthropicMessage", () => {
  it("concatenates text blocks and ignores thinking blocks", () => {
    const out = fromAnthropicMessage({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "hmm, internal" },
        { type: "text", text: "Hello " },
        { type: "text", text: "there." },
      ],
    });
    const choice = (out.choices as any[])[0];
    expect(choice.message.content).toBe("Hello there.");
    expect(choice.message.tool_calls).toBeUndefined();
    expect(choice.finish_reason).toBe("stop");
  });

  it("emits tool_calls with JSON-stringified arguments", () => {
    const out = fromAnthropicMessage({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_9", name: "memory_store", input: { key: "k", value: "v" } }],
    });
    const choice = (out.choices as any[])[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.tool_calls).toEqual([{
      id: "toolu_9",
      type: "function",
      function: { name: "memory_store", arguments: '{"key":"k","value":"v"}' },
    }]);
    // orchestrator.ts does JSON.parse(toolCall.function.arguments)
    expect(JSON.parse(choice.message.tool_calls[0].function.arguments)).toEqual({ key: "k", value: "v" });
  });

  it("preserves cache-hit usage", () => {
    const out = fromAnthropicMessage({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 2400,
        cache_creation_input_tokens: 0,
      },
    });
    expect(out.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      cache_read_input_tokens: 2400,
      cache_creation_input_tokens: 0,
    });
  });

  it("yields an empty string when the model returned no text", () => {
    const out = fromAnthropicMessage({ stop_reason: "end_turn", content: [] });
    expect((out.choices as any[])[0].message.content).toBe("");
  });
});

describe("anthropicSSEToOpenAI", () => {
  // Mirrors the parser in src/hooks/useUnifiedChat.ts, which is the contract.
  async function collect(sse: string): Promise<{ text: string; done: boolean }> {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-payload to prove the buffer survives chunk boundaries.
        const half = Math.floor(sse.length / 2);
        controller.enqueue(encoder.encode(sse.slice(0, half)));
        controller.enqueue(encoder.encode(sse.slice(half)));
        controller.close();
      },
    });

    const decoder = new TextDecoder();
    const reader = anthropicSSEToOpenAI(source, "claude-sonnet-5").getReader();
    let raw = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }

    let text = "";
    let sawDone = false;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") { sawDone = true; continue; }
      text += JSON.parse(payload).choices?.[0]?.delta?.content ?? "";
    }
    return { text, done: sawDone };
  }

  it("re-emits text_delta as OpenAI chunks and terminates with [DONE]", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":2048}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hej "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Magnus"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join("\n");

    expect(await collect(sse)).toEqual({ text: "Hej Magnus", done: true });
  });

  it("never leaks thinking or tool-argument deltas into the transcript", async () => {
    const sse = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"internal"}}',
      '',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
      '',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"visible"}}',
      '',
    ].join("\n");

    expect((await collect(sse)).text).toBe("visible");
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the four integration blockers caught in Phase-2 review.
// Each of these produced a guaranteed 400 or a silently broken capability.

describe("regressions: request validity", () => {
  it("forwards anthropicTools (native web_search) into tools", () => {
    const req = toAnthropicRequest({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      anthropicTools: [{ type: "web_search_20260209", name: "web_search" }],
    });
    expect(req.tools?.some((t) => (t as { name?: string }).name === "web_search")).toBe(true);
  });

  it("never sends output_config/thinking to Haiku (it rejects both)", () => {
    const req = toAnthropicRequest({
      model: "google/gemini-2.5-flash-lite", // -> claude-haiku-4-5
      messages: [{ role: "user", content: "summarise" }],
    });
    expect(req.model).toBe("claude-haiku-4-5");
    expect(req.output_config).toBeUndefined();
    expect(req.thinking).toBeUndefined();
  });

  it("re-declares tools when history carries tool blocks but none are passed", () => {
    // The orchestrator's final streaming call sends tool history with no
    // `tools` — the Messages API rejects that combination.
    const req = toAnthropicRequest({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t1", type: "function", function: { name: "web_scrape", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
    });
    expect(req.tools?.some((t) => (t as { name?: string }).name === "web_scrape")).toBe(true);
  });

  it("disables thinking when tool blocks are in history (signatures can't replay)", () => {
    const req = toAnthropicRequest({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t1", type: "function", function: { name: "web_scrape", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
    });
    expect(req.thinking).toBeUndefined();
  });

  it("strips sampling params rejected by Sonnet 5 / Opus 4.8", () => {
    const req = toAnthropicRequest({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
    }) as unknown as Record<string, unknown>;
    expect(req.temperature).toBeUndefined();
    expect(req.top_p).toBeUndefined();
    expect(req.top_k).toBeUndefined();
    expect(typeof req.max_tokens).toBe("number"); // required by the Messages API
  });
});
