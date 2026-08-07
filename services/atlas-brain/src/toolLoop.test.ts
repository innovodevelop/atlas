// Tests for the desktop-tool layer in the runtime-neutral orchestrator.
//
// PLACED HERE, NOT BESIDE orchestrator.ts, ON PURPOSE. The edge-functions CI
// job runs `deno check` only — it never executes tests — so a *.test.ts next to
// that file would never run anywhere. The brain's own job runs a bare
// `bun test`, which picks this up.
import { describe, expect, test } from "bun:test";
import {
  ATLAS_TOOLS,
  buildAtlasTools,
  executeTool,
  resolveAtlasOp,
  toolTimeBudgetMs,
  type ToolContext,
} from "../../../supabase/functions/_shared/orchestrator.ts";

const READ_OPS = [
  "music.status", "music.search", "music.library_tracks", "music.playlists",
  "music.playlist_tracks", "music.now_playing",
  "mail.list_threads", "mail.read_thread",
  "portfolio.status", "portfolio.summary", "portfolio.holdings",
  "portfolio.history", "portfolio.allocation",
  "data.weather", "data.stocks", "data.news",
  "tasks.list", "notes.list", "events.list", "watchlist.list",
];

const names = (tools: ReturnType<typeof buildAtlasTools>) => tools.map((t) => t.function.name);

const call = (name: string, args: unknown) => ({
  id: "call-1",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const soon = () => Date.now() + 10_000;

/** Minimal ctx; `control` records what it was asked for. */
function ctxWith(
  impl?: (op: string, args: unknown) => Awaited<ReturnType<NonNullable<ToolContext["control"]>["call"]>>,
): ToolContext & { seen: Array<{ op: string; args: unknown }> } {
  const seen: Array<{ op: string; args: unknown }> = [];
  return {
    userId: "u1",
    supabase: null,
    deadline: soon(),
    seen,
    control: impl
      ? {
          async call(op, args) {
            seen.push({ op, args });
            return impl(op, args);
          },
        }
      : undefined,
  };
}

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
});

describe("executeTool — desktop delegation", () => {
  test("routes to the mapped op and strips `action` from the args", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: { items: [] } }));
    const out = await executeTool(call("atlas_music", { action: "search", query: "aphex" }), ctx);

    expect(ctx.seen).toEqual([{ op: "music.search", args: { query: "aphex" } }]);
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

  test("non-atlas tools are untouched by the delegation branch", async () => {
    const ctx = ctxWith(() => ({ ok: true, data: "should not be used" }));
    const out = await executeTool(call("web_search", { query: "x" }), ctx);
    expect(ctx.seen).toHaveLength(0);
    expect(out.name).toBe("web_search");
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
