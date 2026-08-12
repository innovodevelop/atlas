// The safety net for the R10 split of runChat (audit C14).
//
// runChat used to be one ~460-line function. Wave 2 cut it into
// buildTurnContext / runToolLoop / streamAndCapture. The split was allowed to
// move code and NOTHING else, and the expensive way to get that wrong is the
// system prompt: the adapter puts Claude's cache breakpoint on system[0], so a
// single moved space there is a cache miss on every turn for every user —
// a permanent bill, invisible in every other test in this repo.
//
// So the first test below is a GOLDEN PROMPT TEST. Its snapshot was captured by
// running the PRE-SPLIT runChat against these exact fixtures and intercepting
// the first aiChatCompletion body. It asserts the whole prompt, not a fragment
// and not a length, because a fragment test is precisely what would have let a
// whitespace change through.
//
// If this test fails after an intentional prompt change, re-capture the
// snapshot deliberately and say so in the commit. Do not patch it to match.
//
// RUNS ONLY IF THE CI COMMAND NAMES THIS DIRECTORY. `bun test` resolves paths
// as substrings: the frontend job runs `bun test tests/ ./src` and the brain
// job runs `bun test` from services/atlas-brain, so neither picks a file up
// from supabase/functions/_shared. That is the same reason toolLoop.test.ts
// sits under the brain instead of here — see its header. This file is here
// anyway because a golden prompt test belongs beside the prompt it pins; the
// CI command has to be widened for it to earn its keep.
import { describe, expect, setSystemTime, test } from "bun:test";
import {
  buildTurnContext,
  runToolLoop,
  type ChatDeps,
  type ChatOptions,
  type ToolDecl,
} from "./orchestrator.ts";

// ---------------------------------------------------------------------------
// Fixtures
//
// Chosen to light up EVERY optional section of the prompt at once — memories,
// style notes, summaries, knowledge bank, both event lists, tools — because a
// section that is absent from the fixture is a section the golden does not pin.

const FIXTURES = {
  profile: {
    first_name: "Magnus",
    nickname: "Mag",
    birthday: "1990-03-14",
    timezone: "Europe/Copenhagen",
    communication_style: "direct",
  },
  memories: [
    { key: "lives_in", value: "Sorø, Denmark", category: "identity", importance: 9 },
    { key: "dog", value: { name: "Bruno", breed: "vizsla" }, category: "relationships", importance: 7 },
  ],
  knowledge: [
    { topic: "sqlite-vec", content: "vector search extension used by Atlas recall", category: "engineering" },
  ],
  upcoming: [
    { event_type: "trip", event_date: "2026-08-09", description: "Flight to Lisbon", sentiment: "excited" },
  ],
  recent: [
    { event_type: "work", event_date: "2026-07-29", description: "Shipped Wave 1", sentiment: "proud" },
  ],
  styleNotes: [{ key: "prefers_bullets", value: "short bullets over paragraphs" }],
  summaries: [
    { key: "conversation_2026-08-02", value: "Planned the Wave 2 refactor.", created_at: "2026-08-02T12:00:00.000Z" },
  ],
  contexts: [
    { context_type: "emotion", content: { emotion: "curious", detected_from: "how does the recall work" }, confidence: 0.7 },
    { context_type: "topic", content: { topic: "work", message_excerpt: "how does the recall scoring work" }, confidence: 0.8 },
  ],
  recall: [
    { id: "vec-1", chunk_text: "Magnus prefers refactors that keep the prompt byte-stable.", score: 0.81 },
    { id: "vec-2", chunk_text: "Atlas runs fully local except auth and reasoning.", score: 0.74 },
  ],
};

const MESSAGES = [
  { role: "user", content: "Can you walk me through how the recall scoring actually works end to end?" },
  { role: "assistant", content: "Sure — it is hybrid vector plus FTS, scored by relevance, recency and importance." },
  { role: "user", content: "And what happens when the embedding model changes underneath the stored vectors?" },
];

/**
 * The instant every clock-dependent branch is pinned to.
 *
 * 12:00Z is chosen so the calendar date is 2 August in every real timezone
 * (UTC-12..UTC+11), which keeps the "Recent Conversations" date stable no
 * matter where this runs. Europe/Copenhagen puts the local hour at 14 →
 * "afternoon", and the fixture birthday (14 March) is not today → the birthday
 * line is the empty string, which is itself a load-bearing byte in the prompt.
 */
const FROZEN = new Date("2026-08-02T12:00:00.000Z");

/**
 * A supabase double that answers by (table, accumulated .eq filters).
 *
 * Every builder method returns `this` and the object is thenable, which is all
 * the fan-out needs: it awaits the builder directly for lists and calls
 * .single() for the profile.
 */
function makeSupabase(spy?: { upserts: unknown[]; rpcs: string[] }) {
  const rows = (table: string, filters: Record<string, unknown>) => {
    switch (table) {
      case "profiles": return FIXTURES.profile;
      case "ai_memory":
        if (filters.category === "communication_style") return FIXTURES.styleNotes;
        if (filters.category === "conversation_summary") return FIXTURES.summaries;
        return FIXTURES.memories;
      case "atlas_knowledge_entries": return FIXTURES.knowledge;
      case "user_life_events":
        return filters.should_follow_up === true ? FIXTURES.recent : FIXTURES.upcoming;
      case "session_context": return FIXTURES.contexts;
      default: return [];
    }
  };
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters[c] = v; return b; },
        gt: () => b, gte: () => b, lt: () => b, lte: () => b,
        order: () => b, limit: () => b,
        insert: () => Promise.resolve({ error: null }),
        upsert: (payload: unknown) => { spy?.upserts.push(payload); return Promise.resolve({ error: null }); },
        single: () => Promise.resolve({ data: rows(table, filters), error: null }),
        then: (ok: any, err: any) =>
          Promise.resolve({ data: rows(table, filters), error: null }).then(ok, err),
      };
      return b;
    },
    rpc(name: string) {
      spy?.rpcs.push(name);
      return name === "recall_memories"
        ? Promise.resolve({ data: FIXTURES.recall, error: null })
        : Promise.resolve({ data: null, error: null });
    },
  };
}

/** provider-status writes are fire-and-forget bookkeeping; swallow them. */
const systemDb = {
  from() {
    const b: any = {
      select: () => b, eq: () => b, limit: () => b, order: () => b,
      update: () => b,
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (ok: any, err: any) => Promise.resolve({ data: null, error: null }).then(ok, err),
    };
    return b;
  },
};

function makeDeps(supabase: unknown): ChatDeps {
  return {
    supabase,
    systemDb,
    userId: "user-1",
    userToken: "jwt-1",
    supabaseUrl: "local",
    sessionId: "sess-1",
    // Injected so the fan-out never reaches for the gateway embedder — the
    // recall arm would otherwise make a network call from a unit test.
    embed: async () => [0.1, 0.2, 0.3],
  };
}

const OPTS: ChatOptions = { messages: MESSAGES, source: "text_chat", conversationId: "conv-1" };

// ---------------------------------------------------------------------------
// The golden prompt

const GOLDEN_SYSTEM_PROMPT = `You are Atlas, a genuinely caring AI assistant who knows Mag personally.

## Your Personality
- You're like a trusted friend who happens to be incredibly knowledgeable
- You use their name naturally (but not every sentence - that's weird)
- You remember what they've shared and bring it up when relevant
- You're genuinely interested in their life, not just their tasks
- You celebrate their wins and offer support during tough times
- A light touch of humor is welcome when the moment invites it - never forced

## Communication Style
- Use contractions naturally ("you're", "I'd", "let's"); emoji occasionally but don't overdo it
- Match the length of your reply to the weight of the question
- Offer a clear take while leaving room for their view
- If they seem stressed, acknowledge it gently
- Use direct tone
- It's afternoon for them, greet appropriately if starting a conversation


## Tools Available
You have access to powerful tools that you SHOULD USE ACTIVELY:

1. **web_search**: Search the web for current information.
   - USE THIS when asked about: recent events, news, current prices, today's weather, sports scores, stock prices, anything time-sensitive
   - USE THIS when the user says: "search", "look up", "find out", "what's happening", "latest", "current", "today"
   - USE THIS when you're not 100% certain about a fact
   - USE THIS to read a specific link the user gives you — search for the page and use what it returns

2. **deep_research**: Comprehensive research with multiple sources.
   - USE THIS when asked to: research, investigate, analyze, compare, "tell me everything about"
   - USE THIS for complex questions requiring thorough analysis

3. **memory_store**: Save important facts about the user.
   - USE THIS when they share: personal details, preferences, names, dates, important events

CRITICAL INSTRUCTIONS:
- DO NOT make up information. If you're unsure, USE web_search.
- DO NOT say "I don't have access to current information" - you DO have access via web_search.
- When asked about anything current, recent, or real-time, ALWAYS use web_search first.
- Be proactive about using tools - don't wait to be explicitly asked.

## What You Remember About Mag
- lives_in: "Sorø, Denmark"
- dog: {"name":"Bruno","breed":"vizsla"}

## Communication Preferences You've Learned
Adapt how you talk based on these observations:
- prefers_bullets: "short bullets over paragraphs"

## Recent Conversations (for continuity — reference naturally, don't recite)
- 8/2/2026: "Planned the Wave 2 refactor."

## Knowledge Bank (Things You've Learned)
- [engineering] sqlite-vec: "vector search extension used by Atlas recall"

## Life Events to Be Aware Of
Upcoming:
- 2026-08-09: Flight to Lisbon (excited)
Recent (follow up on these):
- Shipped Wave 1

## What You Can Help With
- Email management and organization
- Calendar and scheduling
- Stock market and investments
- Travel planning
- Document management
- General knowledge and conversation
- Remembering personal details and following up on life events
- Research and deep learning on topics (use tools when needed!)

## Memory Instructions
Pay deep attention to what Mag shares. Use memory_store to capture:

**Identity & Soul:**
- Who they are at their core (identity)
- Personality traits they reveal ("I'm usually the one who...", "I tend to...")
- Values and what matters to them ("That's important to me because...")
- Beliefs and worldview ("I believe that...")

**Emotional Depth:**
- Feelings behind facts ("I love X" → category: joys, "I worry about" → category: fears)
- Dreams and aspirations ("I've always wanted...", "Someday I hope...")
- Fears and anxieties ("I'm afraid of...", "What keeps me up at night...")
- Sources of joy ("Nothing makes me happier than...")

**Life & Relationships:**
- Names, relationships, and the stories behind them
- Work challenges and career dreams
- Health concerns and wellness goals
- Habits, routines, and why they matter

**Importance Scoring:**
- identity/personality/values/beliefs → importance: 9
- feelings/fears/dreams/joys → importance: 8
- relationships → importance: 7
- work/health/events → importance: 6
- preferences/habits → importance: 5

Be genuine, warm, and emotionally attentive. You're not just storing data - you're truly getting to know a person.`;

const GOLDEN_VOLATILE = `## Relevant memories for this message
- Magnus prefers refactors that keep the prompt byte-stable.
- Atlas runs fully local except auth and reasoning.
## Current Conversation Context (Working Memory)
[emotion] {"emotion":"curious","detected_from":"how does the recall work"}
[topic] {"topic":"work","message_excerpt":"how does the recall scoring work"}`;

describe("buildTurnContext", () => {
  test("assembles the exact system prompt the pre-split runChat sent", async () => {
    // Named precondition, so a locale difference reads as a locale difference
    // instead of looking like prompt drift. The summary line interpolates
    // `toLocaleDateString()` with no explicit locale, so the golden encodes the
    // runner's default — en-US on every machine and runner this project uses.
    expect(new Date("2026-08-02T12:00:00.000Z").toLocaleDateString()).toBe("8/2/2026");

    setSystemTime(FROZEN);
    try {
      const ctx = await buildTurnContext(makeDeps(makeSupabase()), OPTS);
      expect(ctx.systemPrompt).toBe(GOLDEN_SYSTEM_PROMPT);
    } finally {
      setSystemTime();
    }
  });

  test("per-turn context is a SEPARATE system message, never appended to system[0]", async () => {
    setSystemTime(FROZEN);
    try {
      const ctx = await buildTurnContext(makeDeps(makeSupabase()), OPTS);

      expect(ctx.volatileContext).toBe(GOLDEN_VOLATILE);
      // The whole point of the split: recall and working memory must not touch
      // the cached prefix.
      expect(ctx.systemPrompt).not.toContain("Relevant memories for this message");
      expect(ctx.systemPrompt).not.toContain("Current Conversation Context");

      expect(ctx.conversationMessages.map((m) => m.role)).toEqual([
        "system", "system", "user", "assistant", "user",
      ]);
      expect(ctx.conversationMessages[0].content).toBe(GOLDEN_SYSTEM_PROMPT);
      expect(ctx.conversationMessages[1].content).toBe(GOLDEN_VOLATILE);
      expect(ctx.conversationMessages.slice(2)).toEqual(MESSAGES);

      // TurnCapture records what the model actually saw — both halves, joined.
      expect(ctx.capturedSystemPrompt).toBe(`${GOLDEN_SYSTEM_PROMPT}\n\n${GOLDEN_VOLATILE}`);
    } finally {
      setSystemTime();
    }
  });

  test("no volatile context means no second system message and no join", async () => {
    setSystemTime(FROZEN);
    try {
      // A first turn with nothing recalled and no working memory yet.
      const bare = {
        ...makeSupabase(),
        from(table: string) {
          const b: any = {
            select: () => b, eq: () => b, gt: () => b, gte: () => b, lt: () => b, lte: () => b,
            order: () => b, limit: () => b,
            single: () => Promise.resolve({ data: table === "profiles" ? FIXTURES.profile : null, error: null }),
            then: (ok: any, err: any) => Promise.resolve({ data: [], error: null }).then(ok, err),
          };
          return b;
        },
        rpc: () => Promise.resolve({ data: [], error: null }),
      };
      const ctx = await buildTurnContext(makeDeps(bare), OPTS);

      expect(ctx.volatileContext).toBe("");
      expect(ctx.conversationMessages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
      expect(ctx.capturedSystemPrompt).toBe(ctx.systemPrompt);
    } finally {
      setSystemTime();
    }
  });

  test("systemPromptOverride replaces system[0] and nothing else", async () => {
    setSystemTime(FROZEN);
    try {
      const ctx = await buildTurnContext(makeDeps(makeSupabase()), {
        ...OPTS,
        systemPromptOverride: "You are a test harness.",
      });
      expect(ctx.systemPrompt).toBe("You are a test harness.");
      // The override does not suppress recall or working memory.
      expect(ctx.volatileContext).toBe(GOLDEN_VOLATILE);
    } finally {
      setSystemTime();
    }
  });

  test("teachingMode drops the tool section from the prompt", async () => {
    setSystemTime(FROZEN);
    try {
      const ctx = await buildTurnContext(makeDeps(makeSupabase()), { ...OPTS, teachingMode: true });
      expect(ctx.hasTools).toBe(false);
      expect(ctx.systemPrompt).not.toContain("## Tools Available");
    } finally {
      setSystemTime();
    }
  });
});

// ---------------------------------------------------------------------------
// The tool loop's bounds
//
// These are the reason runToolLoop is separately callable at all. Before the
// split neither bound could be exercised without a live gateway and a slow
// tool, so "6 iterations" and "20s / 8s" were claims in a comment.

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** One assistant turn that calls `name`, i.e. the loop must iterate again. */
const wantsTool = (name: string, args: Record<string, unknown> = {}) =>
  ok({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  });

/** One assistant turn with no tool calls, i.e. the loop must stop. */
const done = () => ok({ choices: [{ finish_reason: "stop", message: { content: "All set." } }] });

const CONVERSATION = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
];

function loopArgs(over: Partial<Parameters<typeof runToolLoop>[0]> = {}) {
  return {
    supabase: makeSupabase(),
    systemDb,
    userId: "user-1",
    model: "test/model",
    tools: undefined as ToolDecl[] | undefined,
    conversationMessages: CONVERSATION,
    maxIterations: 6,
    deadline: Date.now() + 60_000,
    ...over,
  };
}

describe("runToolLoop bounds", () => {
  test("stops at six iterations when the model never stops asking for tools", async () => {
    let calls = 0;
    const out = await runToolLoop(loopArgs({
      chat: (async () => { calls++; return wantsTool("nonexistent_tool"); }) as any,
    }));

    expect(out.ok).toBe(true);
    // Six model calls, not seven: the loop must not make the call it cannot use.
    expect(calls).toBe(6);
    if (!out.ok) throw new Error("unreachable");
    // One assistant message + one tool result per iteration.
    expect(out.toolMessages).toHaveLength(12);
    // The original conversation is returned intact, with the loop appended.
    expect(out.messages.slice(0, CONVERSATION.length)).toEqual(CONVERSATION);
    expect(out.messages).toHaveLength(CONVERSATION.length + 12);
  });

  test("an expired deadline refuses the tool instead of running it", async () => {
    const spy = { upserts: [] as unknown[], rpcs: [] as string[] };
    let calls = 0;
    const out = await runToolLoop(loopArgs({
      supabase: makeSupabase(spy),
      deadline: Date.now() - 1,
      chat: (async () => {
        calls++;
        // First pass asks for a WRITE; if the deadline were not honoured the
        // spy below would have caught the upsert.
        return calls === 1 ? wantsTool("memory_store", { key: "k", value: "v", category: "fact" }) : done();
      }) as any,
    }));

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(spy.upserts).toHaveLength(0);
    expect(out.toolMessages[1].content).toContain("time budget ran out");
    // Still a normal turn: the model gets the refusal as a result and narrates
    // it, rather than the stream hanging.
    expect(calls).toBe(2);
  });

  test("maxIterations 0 (teaching mode) never calls the model at all", async () => {
    let calls = 0;
    const out = await runToolLoop(loopArgs({
      maxIterations: 0,
      chat: (async () => { calls++; return done(); }) as any,
    }));

    expect(calls).toBe(0);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.toolMessages).toEqual([]);
    expect(out.messages).toEqual(CONVERSATION);
  });

  test("a gateway 429 ends the turn with 429, not a generic 500", async () => {
    const out = await runToolLoop(loopArgs({
      chat: (async () => new Response("slow down", { status: 429 })) as any,
    }));

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error.status).toBe(429);
  });

  test("citations bridged onto the check response survive to the caller", async () => {
    let calls = 0;
    const out = await runToolLoop(loopArgs({
      chat: (async () => {
        calls++;
        return ok({
          citations: calls === 1 ? ["https://example.com/a"] : [],
          choices: [{ finish_reason: "stop", message: { content: "done" } }],
        });
      }) as any,
    }));

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.citations).toEqual(["https://example.com/a"]);
  });
});
