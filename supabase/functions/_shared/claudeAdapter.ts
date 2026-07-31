// Claude (Anthropic Messages API) behind the OpenAI chat.completions seam.
//
// Every caller in this repo — orchestrator.ts's tool loop, session.ts and
// useUnifiedChat.ts's SSE parsers — speaks OpenAI chat.completions. Rather than
// rewrite ~13 call sites, this module translates in both directions:
//   OpenAI request  -> Messages API request   (toAnthropicRequest)
//   Messages reply  -> OpenAI response shape  (fromAnthropicMessage)
//   Messages SSE    -> OpenAI SSE chunks      (claudeChatCompletion, streaming)
//
// Deliberately written against `fetch`, not `@anthropic-ai/sdk`: `_shared/*` is
// runtime-neutral (Deno edge functions, the Bun brain sidecar, and the Bun
// voice gateway all import it verbatim) and a bare npm specifier would not
// resolve under Deno. The SDK stays available at the repo root for code that
// runs Bun-only.

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Streaming answers are the user-visible ones; give them real headroom.
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_STREAM_MAX_TOKENS = 16000;

// ---------------------------------------------------------------------------
// Model mapping

// Logical (Lovable-gateway style) id -> Claude tier. Keeping the logical ids at
// the call sites means switching providers stays a gateway concern.
const CLAUDE_MODEL_MAP: Record<string, string> = {
  "google/gemini-2.5-flash-lite": "claude-haiku-4-5",
  "openai/gpt-5-nano": "claude-haiku-4-5",
  "google/gemini-2.5-flash": "claude-sonnet-5",
  "openai/gpt-5-mini": "claude-sonnet-5",
  "google/gemini-2.5-pro": "claude-opus-4-8",
  "openai/gpt-5": "claude-opus-4-8",
};

export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5";

export function mapModelToClaude(model: string): string {
  if (model.startsWith("claude-")) return model;
  return CLAUDE_MODEL_MAP[model] ?? CLAUDE_DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Types

export interface OpenAIToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAITool {
  type?: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Non-OpenAI passthrough. Callers may set `claude: {...}` on the body to reach
 * Messages-API-only knobs without the seam growing provider-specific arguments.
 */
export interface ClaudeOverrides {
  /** output_config.effort. Default "medium". */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Force adaptive thinking on/off. Default: on, except when tools are sent. */
  thinking?: boolean;
  /** Skip the cache_control breakpoints (e.g. for one-shot throwaway prompts). */
  cache?: boolean;
  max_tokens?: number;
}

type CacheControl = { type: "ephemeral" };

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: AnthropicTextBlock[];
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
    cache_control?: CacheControl;
  }>;
  tool_choice?: Record<string, unknown>;
  thinking?: { type: "adaptive" };
  output_config?: { effort: string };
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// Request translation (pure)

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  // OpenAI multi-part content: [{type:"text", text}, ...]
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof (p as { text?: string })?.text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return String(content);
}

function mapToolChoice(choice: unknown): Record<string, unknown> | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  const named = choice as { type?: string; function?: { name?: string } };
  if (named?.type === "function" && named.function?.name) {
    return { type: "tool", name: named.function.name };
  }
  return undefined;
}

/**
 * OpenAI chat.completions body -> Messages API body.
 *
 * Notable translations:
 *  - `role:"system"` messages are hoisted to the top-level `system` param.
 *  - `role:"tool"` messages become a user message of `tool_result` blocks;
 *    consecutive ones are merged, because the Messages API requires strictly
 *    alternating roles and the orchestrator emits one message per tool call.
 *  - temperature / top_p / top_k are DROPPED — Sonnet 5 and Opus 4.8 reject
 *    non-default sampling params with a 400.
 */
export function toAnthropicRequest(body: Record<string, unknown>): AnthropicRequest {
  const overrides = (body.claude ?? {}) as ClaudeOverrides;
  const stream = body.stream === true;
  const rawMessages = (body.messages ?? []) as OpenAIMessage[];
  const useCache = overrides.cache !== false;

  // System blocks, in caller order.
  //
  // CONTRACT: system[0] is the STABLE prefix and is the only block inside the
  // cache breakpoint. Every block after it is treated as per-turn volatile and
  // deliberately sits OUTSIDE the cached prefix.
  //
  // Anthropic renders `tools` -> `system` -> `messages`, so a breakpoint on
  // system[0] covers `tools ++ system[0]` — byte-identical turn to turn, which
  // is what actually produces `cache_read_input_tokens`.
  //
  // Putting the breakpoint on the LAST block instead (the previous behaviour)
  // is worse than having no breakpoint at all as soon as any caller appends
  // per-turn context: the tail of the cached prefix then differs every turn,
  // the prefix match always fails, and the entire system prompt is re-written
  // at the 1.25x cache-write rate on every single turn with a permanent
  // `cache_read_input_tokens: 0`.
  //
  // Callers must therefore emit volatile per-turn context — recalled memories,
  // session/working-memory blocks, anything derived from the latest user
  // message — as a SEPARATE system message after the stable one, never
  // concatenated onto it. Single-block callers are unaffected: system[0] is
  // then also the last block.
  const systemTexts = rawMessages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .filter((t) => t.length > 0);
  let system: AnthropicTextBlock[] | undefined;
  if (systemTexts.length > 0) {
    system = systemTexts.map((text) => ({ type: "text" as const, text }));
    if (useCache) system[0].cache_control = { type: "ephemeral" };
  }

  const messages: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const msg of rawMessages) {
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: String(msg.tool_call_id ?? ""),
        content: textOf(msg.content),
      }]);
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      const text = textOf(msg.content);
      if (text.trim().length > 0) blocks.push({ type: "text", text });
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          // A model that emitted unparseable args still needs a valid block;
          // hand the raw string through so the tool sees what was produced.
          input = { _raw: tc.function?.arguments ?? "" };
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input });
      }
      push("assistant", blocks);
      continue;
    }

    const text = textOf(msg.content);
    if (text.length > 0) push("user", [{ type: "text", text }]);
  }

  // The Messages API rejects an empty conversation.
  if (messages.length === 0) {
    messages.push({ role: "user", content: [{ type: "text", text: "." }] });
  }

  const rawTools = (body.tools ?? []) as OpenAITool[] | undefined;
  let tools: AnthropicRequest["tools"];
  if (Array.isArray(rawTools) && rawTools.length > 0) {
    tools = rawTools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));
    // Deliberately NO cache_control here. Tools render before system, so the
    // system[0] breakpoint above already covers the whole tool block; a second
    // breakpoint on the last tool would only add an earlier boundary. At ~515
    // tokens (ATLAS_TOOLS, measured: 1803 JSON chars) the tools-only prefix is
    // below the minimum cacheable size on every tier this repo routes to —
    // 1024 on Sonnet 5 / Opus 4.8, 4096 on Opus 4.6 / Haiku 4.5 — so such a
    // breakpoint is silently ignored (no error, `cache_creation_input_tokens:
    // 0`) while still consuming one of the 4 breakpoints per request. Re-add
    // one here only if the tool set ALONE grows past the target model's
    // minimum, and verify with `cache_creation_input_tokens` before trusting it.
  }

  // Anthropic server-side tools (currently web_search_20260209) ride in on a
  // separate body field: they have no OpenAI equivalent, run on Anthropic's
  // side, and must be appended to the same `tools` array.
  const serverTools = body.anthropicTools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(serverTools) && serverTools.length > 0) {
    tools = [...(tools ?? []), ...serverTools] as AnthropicRequest["tools"];
  }

  // The Messages API rejects tool_use/tool_result content blocks when the
  // request carries no tool definitions — which is exactly the shape of the
  // orchestrator's final streaming call after a tool round. Re-declare the
  // tools those blocks reference so the history stays valid.
  if (!tools) {
    const historical = new Map<string, { name: string }>();
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if ((b as { type?: string }).type === "tool_use") {
          const name = String((b as { name?: string }).name ?? "");
          if (name) historical.set(name, { name });
        }
      }
    }
    if (historical.size > 0) {
      tools = [...historical.values()].map((t) => ({
        name: t.name,
        description: "Previously used tool (definition replayed for history validity).",
        input_schema: { type: "object", properties: {} } as Record<string, unknown>,
      }));
    }
  }

  const request: AnthropicRequest = {
    model: mapModelToClaude(String(body.model ?? CLAUDE_DEFAULT_MODEL)),
    max_tokens: Number(
      overrides.max_tokens ??
        body.max_tokens ??
        (stream ? DEFAULT_STREAM_MAX_TOKENS : DEFAULT_MAX_TOKENS),
    ),
    messages,
  };
  if (system) request.system = system;
  if (tools) {
    request.tools = tools;
    const toolChoice = mapToolChoice(body.tool_choice);
    if (toolChoice) request.tool_choice = toolChoice;
  }
  if (stream) request.stream = true;

  // Adaptive thinking + output_config.effort are 4.6+ features: Haiku 4.5
  // rejects both (it predates them), so the cheap tier — reached constantly by
  // summarisation/classification — must send neither or every call 400s.
  const supportsAdaptive = request.model !== "claude-haiku-4-5";

  // Extended thinking blocks carry signatures that must be replayed verbatim on
  // the next turn. The OpenAI seam cannot carry them — orchestrator.ts rebuilds
  // the assistant turn from `content` + `tool_calls` only — so thinking is off
  // whenever tool blocks are in play (as definitions OR already in history),
  // and on for the final tool-free answer.
  const hasToolHistory = messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => {
        const t = (b as { type?: string }).type;
        return t === "tool_use" || t === "tool_result";
      }),
  );
  const wantThinking = overrides.thinking ?? (!tools && !hasToolHistory);
  if (supportsAdaptive) {
    if (wantThinking) request.thinking = { type: "adaptive" };
    request.output_config = { effort: overrides.effort ?? "medium" };
  }

  return request;
}

// ---------------------------------------------------------------------------
// Response translation (pure)

export function mapStopReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    default:
      return "stop";
  }
}

export interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: Array<Record<string, unknown>>;
  usage?: Record<string, number>;
}

/** Messages API response -> the `{choices:[{message,finish_reason}],usage}` shape. */
export function fromAnthropicMessage(data: AnthropicMessageResponse): Record<string, unknown> {
  const blocks = data.content ?? [];

  // `thinking` blocks are intentionally skipped: callers treat `content` as the
  // user-visible answer.
  const content = blocks
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");

  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: String(b.id ?? ""),
      type: "function",
      function: {
        name: String(b.name ?? ""),
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const u = data.usage ?? {};
  return {
    id: data.id ?? "",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model ?? "",
    choices: [{ index: 0, message, finish_reason: mapStopReason(data.stop_reason) }],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      // Cache-hit proof — the whole point of the cache_control breakpoints.
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}

function logCacheUsage(usage: Record<string, number> | undefined, model: string) {
  if (!usage) return;
  console.log(
    `[claudeAdapter] ${model} in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`,
  );
}

// ---------------------------------------------------------------------------
// Streaming translation

/**
 * Messages API SSE -> OpenAI `chat.completion.chunk` SSE. session.ts and
 * useUnifiedChat.ts parse `data: {choices:[{delta:{content}}]}` lines followed
 * by `data: [DONE]`, so that framing is reproduced exactly.
 */
export function anthropicSSEToOpenAI(
  source: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = source.getReader();
  let buffer = "";

  const chunk = (delta: Record<string, unknown>) =>
    encoder.encode(
      `data: ${JSON.stringify({
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });

        let emitted = false;
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data:")) continue; // skip `event:` lines and blanks

          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event: Record<string, any>;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          if (event.type === "message_start") {
            logCacheUsage(event.message?.usage, model);
          } else if (event.type === "error") {
            // Mid-stream failure (e.g. overloaded_error) arrives after headers,
            // so the only way to surface it is inside the stream — otherwise the
            // UI shows a silently truncated answer.
            const message = String(event.error?.message ?? "Claude stream error");
            console.error("[claude] stream error:", message);
            controller.enqueue(chunk({ content: `\n\n[${message}]` }));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            // thinking_delta / input_json_delta never reach the transcript.
            controller.enqueue(chunk({ content: String(event.delta.text ?? "") }));
            emitted = true;
          }
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

/**
 * OpenAI-shaped request in, OpenAI-shaped `Response` out. Non-OK upstream
 * responses are returned untouched so callers keep reading `.status` (429/402)
 * and `.text()` the way they always have.
 */
export async function claudeChatCompletion(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Response> {
  const request = toAnthropicRequest(body);
  const upstream = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!upstream.ok) return upstream;

  if (request.stream) {
    return new Response(anthropicSSEToOpenAI(upstream.body!, request.model), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const data = (await upstream.json()) as AnthropicMessageResponse;
  logCacheUsage(data.usage, request.model);
  return new Response(JSON.stringify(fromAnthropicMessage(data)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Document understanding via native Claude content blocks. PDFs go through a
 * `document` block, images through an `image` block; anything else is rejected
 * so the caller can fall back.
 */
export async function claudeDocumentExtract(
  prompt: string,
  mimeType: string,
  base64Data: string,
  apiKey: string,
): Promise<string> {
  const isPdf = mimeType === "application/pdf";
  const isImage = mimeType.startsWith("image/");
  if (!isPdf && !isImage) {
    throw new Error(`Unsupported document type for Claude extraction: ${mimeType}`);
  }

  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_DEFAULT_MODEL,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: [{
        role: "user",
        content: [
          {
            type: isPdf ? "document" : "image",
            source: { type: "base64", media_type: mimeType, data: base64Data },
          },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Document extraction failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const data = (await response.json()) as AnthropicMessageResponse;
  logCacheUsage(data.usage, CLAUDE_DEFAULT_MODEL);
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("");
}

export { ANTHROPIC_MESSAGES_URL };
