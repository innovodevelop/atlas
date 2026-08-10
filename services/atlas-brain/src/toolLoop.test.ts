// Tests for the desktop-tool layer in the runtime-neutral orchestrator.
//
// PLACED HERE, NOT BESIDE orchestrator.ts, ON PURPOSE. The edge-functions CI
// job runs `deno check` only — it never executes tests — so a *.test.ts next to
// that file would never run anywhere. The brain's own job runs a bare
// `bun test`, which picks this up.
import { describe, expect, test } from "bun:test";
import {
  ATLAS_TOOLS,
  approvalPendingResult,
  atlasToolOpNames,
  buildAtlasTools,
  executeTool,
  isMutatingAtlasOp,
  resolveAtlasOp,
  toolTimeBudgetMs,
  type ToolContext,
} from "../../../supabase/functions/_shared/orchestrator.ts";
import { filterInsights, proactiveToolLoop, PROACTIVE_MAX_AI_CALLS } from "./proactive.ts";

const READ_OPS = [
  "music.status", "music.search", "music.library_tracks", "music.playlists",
  "music.playlist_tracks", "music.now_playing",
  "mail.list_threads", "mail.read_thread",
  "portfolio.status", "portfolio.summary", "portfolio.holdings",
  "portfolio.history", "portfolio.allocation",
  "data.weather", "data.stocks", "data.news",
  "tasks.list", "notes.list", "events.list", "watchlist.list",
];

/** The 11 ops the registry declares above Tier::Read. */
const MUTATING_OPS = [
  "tasks.create", "tasks.update", "notes.create", "notes.update",
  "events.create", "watchlist.add",
  "music.play", "music.pause", "music.volume",
  "mail.archive", "mail.mark_read",
];

const ALL_OPS = [...READ_OPS, ...MUTATING_OPS];

const names = (tools: ReturnType<typeof buildAtlasTools>) => tools.map((t) => t.function.name);

const tool = (tools: ReturnType<typeof buildAtlasTools>, name: string) =>
  tools.find((t) => t.function.name === name)!;

const actionsOf = (tools: ReturnType<typeof buildAtlasTools>, name: string) =>
  (tool(tools, name).function.parameters.properties.action as { enum: string[] }).enum;

const call = (name: string, args: unknown) => ({
  id: "call-1",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const soon = () => Date.now() + 10_000;

type ControlOpts = Parameters<NonNullable<ToolContext["control"]>["call"]>[2];

/** Minimal ctx; `control` records what it was asked for. */
function ctxWith(
  impl?: (op: string, args: unknown) => Awaited<ReturnType<NonNullable<ToolContext["control"]>["call"]>>,
  extra: Partial<ToolContext> = {},
): ToolContext & { seen: Array<{ op: string; args: unknown; opts: ControlOpts }> } {
  const seen: Array<{ op: string; args: unknown; opts: ControlOpts }> = [];
  return {
    userId: "u1",
    supabase: null,
    deadline: soon(),
    seen,
    control: impl
      ? {
          async call(op, args, opts) {
            seen.push({ op, args, opts });
            return impl(op, args);
          },
        }
      : undefined,
    ...extra,
  };
}

/** `seen` without the opts, for the assertions that predate them. */
const opsOf = (ctx: { seen: Array<{ op: string; args: unknown }> }) =>
  ctx.seen.map(({ op, args }) => ({ op, args }));

describe("buildAtlasTools", () => {
  test("with no capabilities it declares exactly today's tools and no desktop ones", () => {
    expect(names(buildAtlasTools(null))).toEqual(names(ATLAS_TOOLS));
    expect(names(buildAtlasTools([]))).toEqual(names(ATLAS_TOOLS));
    // The honest-degradation property: a model must never be shown a desktop
    // tool when there is no desktop to run it on.
    expect(names(buildAtlasTools(null)).some((n) => n.startsWith("atlas_"))).toBe(false);
  });

  test("declares five domain tools for the full read set, not twenty", () => {
    const desktop = names(buildAtlasTools(READ_OPS)).filter((n) => n.startsWith("atlas_"));
    expect(desktop.sort()).toEqual([
      "atlas_data", "atlas_finance", "atlas_lists", "atlas_mail", "atlas_music",
    ]);
  });

  test("progressive disclosure: only domains whose ops are advertised", () => {
    const declared = names(buildAtlasTools(["music.status", "music.now_playing"]));
    expect(declared).toContain("atlas_music");
    expect(declared).not.toContain("atlas_mail");
    expect(declared).not.toContain("atlas_finance");
  });

  test("the action enum lists only the advertised actions", () => {
    const music = buildAtlasTools(["music.status", "music.search"]).find(
      (t) => t.function.name === "atlas_music",
    );
    const action = music!.function.parameters.properties.action as { enum: string[] };
    expect(action.enum.sort()).toEqual(["search", "status"]);
    // Not the ops it cannot reach.
    expect(action.enum).not.toContain("playlists");
  });

  // -------------------------------------------------------------------------
  // The write tier

  test("the five-domain shape survives the write tier — still five tools, not sixteen", () => {
    const desktop = names(buildAtlasTools(ALL_OPS)).filter((n) => n.startsWith("atlas_"));
    expect(desktop.sort()).toEqual([
      "atlas_data", "atlas_finance", "atlas_lists", "atlas_mail", "atlas_music",
    ]);
  });

  test("write actions appear inside the existing domains' enums", () => {
    const tools = buildAtlasTools(ALL_OPS);
    expect(actionsOf(tools, "atlas_music")).toEqual(
      expect.arrayContaining(["play", "pause", "volume"]),
    );
    expect(actionsOf(tools, "atlas_mail")).toEqual(
      expect.arrayContaining(["archive", "mark_read"]),
    );
    expect(actionsOf(tools, "atlas_lists")).toEqual(
      expect.arrayContaining([
        "create_task", "update_task", "create_note", "update_note",
        "create_event", "add_to_watchlist",
      ]),
    );
  });

  test("progressive disclosure holds for writes: an unadvertised write is not in the enum", () => {
    // A port that advertises the reads but not music.play — a real state, since
    // registry entries are per-op.
    const tools = buildAtlasTools(READ_OPS);
    expect(actionsOf(tools, "atlas_music")).not.toContain("play");
    expect(actionsOf(tools, "atlas_lists")).not.toContain("create_task");
    expect(actionsOf(tools, "atlas_mail")).not.toContain("archive");
  });

  test("no oneOf anywhere: every domain is one flat object with an action enum", () => {
    for (const t of buildAtlasTools(ALL_OPS).filter((x) => x.function.name.startsWith("atlas_"))) {
      const p = t.function.parameters;
      expect(p.type).toBe("object");
      expect(p.required).toEqual(["action"]);
      expect(JSON.stringify(p)).not.toContain("oneOf");
      expect(JSON.stringify(p)).not.toContain("anyOf");
    }
  });

  // A parameter the model can fill in for an operation it cannot invoke is the
  // same lie progressive disclosure exists to stop, one level down.
  test("parameters follow their actions: no write params on a read-only port", () => {
    const readOnly = tool(buildAtlasTools(READ_OPS), "atlas_lists").function.parameters.properties;
    expect(Object.keys(readOnly).sort()).toEqual(["action", "limit"]);

    const full = tool(buildAtlasTools(ALL_OPS), "atlas_lists").function.parameters.properties;
    expect(Object.keys(full)).toEqual(expect.arrayContaining(["symbol", "due_date", "start_time"]));

    // And the other direction: no `uri`/`level` unless play/volume are reachable.
    expect(Object.keys(tool(buildAtlasTools(READ_OPS), "atlas_music").function.parameters.properties))
      .not.toContain("uri");
  });

  // The read-only descriptions are load-bearing claims, not flavour text.
  test("the description stops saying read-only exactly when it stops being true", () => {
    const readDesc = tool(buildAtlasTools(READ_OPS), "atlas_music").function.description;
    expect(readDesc).toContain("Read-only");

    const writeDesc = tool(buildAtlasTools(ALL_OPS), "atlas_music").function.description;
    expect(writeDesc).not.toContain("Read-only");
    expect(writeDesc).toContain("pause");
  });

  test("mail's writable description warns that archiving needs confirmation", () => {
    const desc = tool(buildAtlasTools(ALL_OPS), "atlas_mail").function.description;
    expect(desc).toContain("confirm");
  });

  test("allowMutating:false yields a strictly read-only surface", () => {
    const tools = buildAtlasTools(ALL_OPS, { allowMutating: false });
    expect(actionsOf(tools, "atlas_music").sort()).toEqual(
      ["library", "now_playing", "playlist_tracks", "playlists", "search", "status"],
    );
    expect(actionsOf(tools, "atlas_lists").sort()).toEqual(["events", "notes", "tasks", "watchlist"]);
    expect(actionsOf(tools, "atlas_mail").sort()).toEqual(["list_threads", "read_thread"]);
    // ...and the description reverts to the honest read-only sentence.
    expect(tool(tools, "atlas_music").function.description).toContain("Read-only");
  });

  // Non-vacuity: the assertion above would pass just as well if buildAtlasTools
  // returned nothing at all.
  test("allowMutating:false still declares the read surface", () => {
    const desktop = names(buildAtlasTools(ALL_OPS, { allowMutating: false })).filter((n) =>
      n.startsWith("atlas_"),
    );
    expect(desktop).toHaveLength(5);
  });

  // A new op must land on one side of the mutating line, not neither.
  test("is_a_read_or_a_write_and_never_neither", () => {
    const reads = new Set(READ_OPS);
    const ops = atlasToolOpNames();
    expect(ops.length).toBe(ALL_OPS.length);
    for (const op of ops) {
      const classified = isMutatingAtlasOp(op) !== reads.has(op);
      expect(classified, `${op} is neither classified read nor classified mutating`).toBe(true);
    }
  });
});

describe("resolveAtlasOp", () => {
  test("maps one action per domain to its op", () => {
    expect(resolveAtlasOp("atlas_music", "now_playing")).toEqual({ op: "music.now_playing" });
    expect(resolveAtlasOp("atlas_mail", "list_threads")).toEqual({ op: "mail.list_threads" });
    expect(resolveAtlasOp("atlas_finance", "holdings")).toEqual({ op: "portfolio.holdings" });
    expect(resolveAtlasOp("atlas_data", "weather")).toEqual({ op: "data.weather" });
    expect(resolveAtlasOp("atlas_lists", "tasks")).toEqual({ op: "tasks.list" });
  });

  // The schema is permissive and the validator strict, so the error has to
  // teach — a model that is told the valid actions corrects in one iteration
  // instead of guessing and burning another.
  test("an unknown action names the valid ones", () => {
    const r = resolveAtlasOp("atlas_music", "delete_everything");
    expect(r).toHaveProperty("error");
    if ("error" in r) {
      expect(r.error).toContain("now_playing");
      expect(r.error).toContain("search");
    }
  });

  test("a missing action is reported as such, not as an unknown op", () => {
    const r = resolveAtlasOp("atlas_music", undefined);
    expect(r).toHaveProperty("error");
    if ("error" in r) expect(r.error).toContain("action");
  });

  test("every write action maps to the op the registry declares", () => {
    expect(resolveAtlasOp("atlas_lists", "create_task")).toEqual({ op: "tasks.create" });
    expect(resolveAtlasOp("atlas_lists", "update_task")).toEqual({ op: "tasks.update" });
    expect(resolveAtlasOp("atlas_lists", "create_note")).toEqual({ op: "notes.create" });
    expect(resolveAtlasOp("atlas_lists", "update_note")).toEqual({ op: "notes.update" });
    expect(resolveAtlasOp("atlas_lists", "create_event")).toEqual({ op: "events.create" });
    expect(resolveAtlasOp("atlas_lists", "add_to_watchlist")).toEqual({ op: "watchlist.add" });
    expect(resolveAtlasOp("atlas_music", "play")).toEqual({ op: "music.play" });
    expect(resolveAtlasOp("atlas_music", "pause")).toEqual({ op: "music.pause" });
    expect(resolveAtlasOp("atlas_music", "volume")).toEqual({ op: "music.volume" });
    expect(resolveAtlasOp("atlas_mail", "archive")).toEqual({ op: "mail.archive" });
    expect(resolveAtlasOp("atlas_mail", "mark_read")).toEqual({ op: "mail.mark_read" });
  });
});

describe("executeTool — desktop delegation", () => {
  test("routes to the mapped op and strips `action` from the args", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: { items: [] } }));
    const out = await executeTool(call("atlas_music", { action: "search", query: "aphex" }), ctx);

    expect(opsOf(ctx)).toEqual([{ op: "music.search", args: { query: "aphex" } }]);
    expect(out.result).toEqual({ items: [] });
  });

  test("with no control client it returns a result rather than throwing", async () => {
    const ctx = ctxWith(undefined);
    const out = await executeTool(call("atlas_music", { action: "status" }), ctx);
    expect(out.result).toHaveProperty("error");
    expect(ctx.seen).toHaveLength(0);
  });

  test("a control error becomes a readable result carrying retryability", async () => {
    const ctx = ctxWith(() => ({
      ok: false,
      error: { code: "unavailable", message: "Spotify is not connected", retryable: true },
    }));
    const out = await executeTool(call("atlas_music", { action: "status" }), ctx);
    expect(out.result).toEqual({ error: "Spotify is not connected", retryable: true });
  });

  test("an unknown action never reaches the port", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: null }));
    const out = await executeTool(call("atlas_music", { action: "nope" }), ctx);
    expect(ctx.seen).toHaveLength(0);
    expect(out.result).toHaveProperty("error");
  });

  test("malformed arguments degrade to an error, not an exception", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: null }));
    const bad = { id: "c", type: "function", function: { name: "atlas_music", arguments: "{not json" } };
    const out = await executeTool(bad, ctx);
    // args parse to {} -> no action -> resolve error. The turn survives.
    expect(out.result).toHaveProperty("error");
  });

  test("the turn deadline is passed through to the client", async () => {
    let saw = 0;
    const ctx: ToolContext = {
      userId: "u1",
      supabase: null,
      deadline: 1_234_567,
      control: {
        async call(_op, _args, opts) {
          saw = opts.deadline;
          return { ok: true, data: null };
        },
      },
    };
    await executeTool(call("atlas_data", { action: "news" }), ctx);
    expect(saw).toBe(1_234_567);
  });

  // -------------------------------------------------------------------------
  // Writes

  test("a write action reaches its op with identity in the envelope and NOT in the args", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: { action: "created" } }), {
      userId: "u-42",
      userToken: "cf.jwt",
      profile: "interactive",
    });
    await executeTool(
      call("atlas_lists", { action: "create_task", title: "Book the dentist", priority: "high" }),
      ctx,
    );

    expect(ctx.seen[0].op).toBe("tasks.create");
    // The model's arguments carry the task and nothing about whose task it is.
    expect(ctx.seen[0].args).toEqual({ title: "Book the dentist", priority: "high" });
    expect(ctx.seen[0].args).not.toHaveProperty("user_id");
    expect(ctx.seen[0].args).not.toHaveProperty("action");
    // Identity rides alongside, where Rust reads it.
    expect(ctx.seen[0].opts.userId).toBe("u-42");
    expect(ctx.seen[0].opts.userToken).toBe("cf.jwt");
    expect(ctx.seen[0].opts.profile).toBe("interactive");
  });

  // Omitting the profile is not neutral — Rust reads absent as background,
  // which cannot actuate. A chat turn that forgot it would turn every "play
  // this" into an approval card for a user already sitting in front of the app.
  test("an interactive caller's profile survives to the port for an actuation", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: { requested: "play" } }), { profile: "interactive" });
    await executeTool(call("atlas_music", { action: "play", uri: "spotify:track:x" }), ctx);
    expect(ctx.seen[0].opts.profile).toBe("interactive");
  });

  test("a read-only context refuses a mutating op structurally, before the port", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: "must not happen" }), {
      allowMutating: false,
      profile: "background",
    });
    // The action was never declared to this model — but a model can emit a name
    // it was never shown, and "the schema did not mention it" is not a guarantee.
    const out = await executeTool(call("atlas_lists", { action: "create_task", title: "x" }), ctx);
    expect(ctx.seen).toHaveLength(0);
    expect(out.result).toHaveProperty("error");
    expect((out.result as { retryable: boolean }).retryable).toBe(false);
  });

  test("a read-only context still performs reads", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: { items: [] } }), { allowMutating: false });
    await executeTool(call("atlas_lists", { action: "tasks" }), ctx);
    expect(ctx.seen[0].op).toBe("tasks.list");
  });

  // -------------------------------------------------------------------------
  // awaiting_approval
  //
  // The worst failure mode of the whole milestone is Claude saying "done, I
  // archived it" about a thread still sitting in the inbox. The port answers a
  // queued call with ok:true — queueing SUCCEEDED — so nothing about the
  // transport says "did not happen"; only this payload does.

  test("a queued approval round trip is reported as not-done, not as a result", async () => {
    const ctx = ctxWith(() => ({
      ok: true,
      data: {
        status: "awaiting_approval",
        approval_id: "a-1",
        tool_call_id: "tc-1",
        op: "mail.archive",
        tier: "approval",
        risk_level: "medium",
        action_summary: 'approval mail.archive with thread_id="t-9"',
        reason_code: "approval_tier",
        reason: "this operation always requires the user to confirm it",
        expires_at: "2026-08-07T21:51:12.345Z",
      },
    }));
    const out = await executeTool(call("atlas_mail", { action: "archive", thread_id: "t-9" }), ctx);
    const r = out.result as Record<string, unknown>;

    expect(r.status).toBe("awaiting_approval");
    expect(r.performed).toBe(false);
    expect(r.changed_anything).toBe(false);
    expect(r.approval_id).toBe("a-1");
    // Not an error, and NOT retryable in either direction — a retry would just
    // put a second identical card in front of the user.
    expect(r).not.toHaveProperty("retryable");
    expect(r).not.toHaveProperty("error");

    const message = r.message as string;
    expect(message.startsWith("NOT DONE.")).toBe(true);
    expect(message).toContain("Nothing has happened yet");
    expect(message).toContain("waiting on them");
    expect(message).toContain('approval mail.archive with thread_id="t-9"');
    expect(message).toContain("2026-08-07T21:51:12.345Z");
    // The specific words the failure mode is made of, named rather than implied.
    for (const verb of ["archived", "marked", "sent", "played", "changed", "updated", "handled"]) {
      expect(message).toContain(verb);
    }
    expect(message).toContain("Do not call this tool again");
  });

  test("a queued approval survives a port that omits the optional fields", () => {
    const r = approvalPendingResult({ status: "awaiting_approval" });
    expect(r.performed).toBe(false);
    expect((r.message as string).startsWith("NOT DONE.")).toBe(true);
    // No expiry sentence rather than "expires at undefined".
    expect(r.message).not.toContain("undefined");
  });

  // A successful write must NOT be dressed up as pending — the honest-narration
  // property has to hold in both directions or the model learns to ignore it.
  test("an ordinary write result passes through untouched", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: { action: "created", row: { id: "t1" } } }));
    const out = await executeTool(call("atlas_lists", { action: "create_task", title: "x" }), ctx);
    expect(out.result).toEqual({ action: "created", row: { id: "t1" } });
  });

  test("a rate-limited write is reported as not retryable", async () => {
    const ctx = ctxWith(() => ({
      ok: false,
      error: {
        code: "rate_limited",
        message: "rate limit exceeded for tier 'write' (20/min); retry_after_ms=2400",
        retryable: false,
      },
    }));
    const out = await executeTool(call("atlas_lists", { action: "create_task", title: "x" }), ctx);
    expect(out.result).toEqual({
      error: "rate limit exceeded for tier 'write' (20/min); retry_after_ms=2400",
      retryable: false,
    });
  });

  test("non-atlas tools are untouched by the delegation branch", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: "should not be used" }));
    const out = await executeTool(call("web_search", { query: "x" }), ctx);
    expect(ctx.seen).toHaveLength(0);
    expect(out.name).toBe("web_search");
  });
});

// ---------------------------------------------------------------------------
// The digest's own loop
//
// It is here rather than in proactive.test.ts because it IS a tool loop, and
// because it is the one part of proactive.ts that needs no database: every
// clock, model and tool is an argument, which is what makes a 60-second bound
// testable in milliseconds.

describe("proactiveToolLoop", () => {
  const toolCall = (id: string) => ({
    id,
    type: "function",
    function: { name: "atlas_data", arguments: JSON.stringify({ action: "weather" }) },
  });

  const messages = [
    { role: "system", content: "digest" },
    { role: "user", content: "signal" },
  ];

  test("stops on the ANSWER when the model finally writes prose", async () => {
    let n = 0;
    const out = await proactiveToolLoop({
      messages,
      tools: [],
      complete: async () =>
        n++ === 0
          ? { content: null, toolCalls: [toolCall("c1")] }
          : { content: "[]", toolCalls: [] },
      runTool: async () => ({ temp: 12 }),
      deadline: Date.now() + 60_000,
    });
    expect(out).toEqual({ content: "[]", aiCalls: 2, toolCalls: 1, stoppedBy: "answer" });
  });

  test("stops on the ITERATION bound: a model that only ever calls tools", async () => {
    let calls = 0;
    const out = await proactiveToolLoop({
      messages,
      tools: [],
      complete: async () => (calls++, { content: null, toolCalls: [toolCall(`c${calls}`)] }),
      runTool: async () => ({ ok: true }),
      deadline: Date.now() + 60_000,
    });
    expect(out.stoppedBy).toBe("iterations");
    expect(out.aiCalls).toBe(PROACTIVE_MAX_AI_CALLS);
    expect(calls).toBe(PROACTIVE_MAX_AI_CALLS);
    // The last turn's tools are NOT run: no model call is left to read them,
    // so executing them would be pure cost.
    expect(out.toolCalls).toBe(PROACTIVE_MAX_AI_CALLS - 1);
  });

  test("stops on the WALL CLOCK even with model calls left", async () => {
    const start = 1_000_000;
    let t = start;
    let calls = 0;
    const out = await proactiveToolLoop({
      messages,
      tools: [],
      // One model call, then the clock jumps past the deadline — a hung port,
      // compressed into a fake clock so the test does not take a minute.
      complete: async () => (calls++, { content: null, toolCalls: [toolCall("c1")] }),
      runTool: async () => {
        t = start + 61_000;
        return { slow: true };
      },
      deadline: start + 60_000,
      clock: () => t,
    });
    expect(out.stoppedBy).toBe("deadline");
    expect(calls).toBe(1);
    expect(out.content).toBeNull();
  });

  test("an already-expired deadline makes no model call at all", async () => {
    let calls = 0;
    const out = await proactiveToolLoop({
      messages,
      tools: [],
      complete: async () => (calls++, { content: "[]", toolCalls: [] }),
      runTool: async () => ({}),
      deadline: Date.now() - 1,
    });
    expect(out).toEqual({ content: null, aiCalls: 0, toolCalls: 0, stoppedBy: "deadline" });
    expect(calls).toBe(0);
  });

  test("a dead gateway ends the cycle quietly rather than throwing", async () => {
    const out = await proactiveToolLoop({
      messages,
      tools: [],
      complete: async () => null,
      runTool: async () => ({}),
      deadline: Date.now() + 60_000,
    });
    expect(out.stoppedBy).toBe("no-response");
    expect(out.content).toBeNull();
  });

  // A tool call past the deadline is answered rather than executed, so a slow
  // first op cannot drag the loop arbitrarily far past its budget.
  test("a tool whose turn comes after the deadline is refused, not run", async () => {
    const start = 2_000_000;
    let t = start;
    let ran = 0;
    await proactiveToolLoop({
      messages,
      tools: [],
      complete: async () => ({ content: null, toolCalls: [toolCall("a"), toolCall("b")] }),
      runTool: async () => {
        ran++;
        t = start + 61_000; // the FIRST tool blows the budget
        return {};
      },
      deadline: start + 60_000,
      clock: () => t,
    });
    expect(ran).toBe(1); // the second was answered with the budget message
  });
});

// The filler gate's blind spot, which only exists once the digest has tools.
// (Here rather than in proactive.test.ts because the failure is a consequence
// of tool-derived content, and this is the file that owns that seam.)
describe("filterInsights with tool-derived content", () => {
  test("a pleasantry inside a QUOTED span is somebody else's voice, and is kept", () => {
    const kept = filterInsights([
      {
        title: "Unanswered since Tuesday",
        content: 'The thread "Hope your week is going well" from Mette has been sitting unanswered since Tuesday.',
      },
    ]);
    expect(kept).toHaveLength(1);
  });

  test("the same words unquoted are Atlas padding, and are still dropped", () => {
    expect(
      filterInsights([
        { title: "A note", content: "Hope your week is going well — nothing much to add today." },
      ]),
    ).toEqual([]);
  });

  test("a filler TITLE is dropped even when it is quoted", () => {
    // A title is Atlas speaking in its own voice whatever punctuation it wears.
    expect(
      filterInsights([
        { title: '"Just checking in"', content: "The report you asked about on Monday is still open." },
      ]),
    ).toEqual([]);
  });
});

describe("toolTimeBudgetMs", () => {
  // Voice gets far less: a spoken turn that stalls for twenty seconds is a
  // broken conversation, where a text turn merely feels slow.
  test("voice is tighter than text", () => {
    expect(toolTimeBudgetMs("voice")).toBe(8_000);
    expect(toolTimeBudgetMs("text_chat")).toBe(20_000);
    expect(toolTimeBudgetMs(undefined)).toBe(20_000);
  });
});
