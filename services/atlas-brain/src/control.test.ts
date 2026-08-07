// Tests for the control-port client against a REAL server on a real socket.
//
// Bun.serve on port 0 rather than a mocked fetch, deliberately: the failure
// modes that matter here are wire-level — a non-JSON body, a socket that never
// answers, a 403 with a deliberately uniform body — and a mock would encode my
// assumptions about those instead of testing them.
import { describe, expect, test } from "bun:test";
import { createControlClient } from "./control.ts";

const TOKEN = "test-control-token";

/** Start a stub port. Returns the env the client expects plus a request log. */
function stub(handler: (req: Request) => Response | Promise<Response>) {
  const seen: Array<{ path: string; token: string | null; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({
        path: new URL(req.url).pathname,
        token: req.headers.get("x-atlas-control-token"),
        body: await req.clone().text(),
      });
      return handler(req);
    },
  });
  return {
    env: { ATLAS_CONTROL_PORT: String(server.port), ATLAS_CONTROL_TOKEN: TOKEN },
    seen,
    stop: () => server.stop(true),
  };
}

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
const fail = (code: string, message = "nope") =>
  new Response(JSON.stringify({ ok: false, error: { code, message } }), { status: 200 });

const soon = () => Date.now() + 5_000;

describe("createControlClient", () => {
  test("unwraps data from a successful call and sends the token", async () => {
    const s = stub(() => ok({ temp: 12 }));
    try {
      const c = createControlClient(s.env);
      expect(c.available()).toBe(true);
      const r = await c.call("data.weather", { city: "Copenhagen" }, { deadline: soon() });
      expect(r).toEqual({ ok: true, data: { temp: 12 } });
      expect(s.seen[0].token).toBe(TOKEN);
      expect(s.seen[0].path).toBe("/v1/invoke");
      expect(JSON.parse(s.seen[0].body)).toEqual({ op: "data.weather", args: { city: "Copenhagen" } });
    } finally {
      s.stop();
    }
  });

  // The retryable flag decides whether the model tries again or explains why it
  // cannot. Getting it backwards means looping on a permanent refusal, or
  // giving up on a blip.
  test.each([
    ["forbidden", "not_permitted", false],
    ["too_large", "invalid_args", false],
    ["bad_request", "invalid_args", false],
    ["unknown_op", "invalid_args", false],
    ["op_failed", "unavailable", true],
    ["internal", "internal", true],
  ])("maps the Rust code %s -> %s (retryable %p)", async (rust, mapped, retryable) => {
    const s = stub(() => fail(rust, "detail from rust"));
    try {
      const r = await createControlClient(s.env).call("music.status", {}, { deadline: soon() });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe(mapped as never);
        expect(r.error.retryable).toBe(retryable);
        expect(r.error.message).toBe("detail from rust");
      }
    } finally {
      s.stop();
    }
  });

  test("an unrecognised code degrades to internal rather than throwing", async () => {
    const s = stub(() => fail("some_future_code"));
    try {
      const r = await createControlClient(s.env).call("x.y", {}, { deadline: soon() });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("internal");
    } finally {
      s.stop();
    }
  });

  test("a non-JSON body becomes internal, not an exception", async () => {
    const s = stub(() => new Response("<html>gateway exploded</html>", { status: 502 }));
    try {
      const r = await createControlClient(s.env).call("data.news", {}, { deadline: soon() });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("internal");
        expect(r.error.message).toContain("502");
      }
    } finally {
      s.stop();
    }
  });

  test("a valid-JSON but wrong-shaped body becomes internal", async () => {
    const s = stub(() => new Response(JSON.stringify({ surprise: true }), { status: 200 }));
    try {
      const r = await createControlClient(s.env).call("data.news", {}, { deadline: soon() });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("internal");
    } finally {
      s.stop();
    }
  });

  test("403 is reported as not_permitted without parsing the uniform body", async () => {
    const s = stub(() => new Response("forbidden", { status: 403 }));
    try {
      const r = await createControlClient(s.env).call("music.status", {}, { deadline: soon() });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("not_permitted");
        expect(r.error.retryable).toBe(false);
      }
    } finally {
      s.stop();
    }
  });

  test("a server that never answers hits the deadline and returns timeout", async () => {
    const s = stub(() => new Promise<Response>(() => {})); // never resolves
    try {
      const r = await createControlClient(s.env).call("music.status", {}, { deadline: Date.now() + 150 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("timeout");
        expect(r.error.retryable).toBe(false);
      }
    } finally {
      s.stop();
    }
  });

  test("an already-passed deadline returns timeout and makes NO request", async () => {
    const s = stub(() => ok({ never: "reached" }));
    try {
      const r = await createControlClient(s.env).call("music.status", {}, { deadline: Date.now() - 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("timeout");
      // The point of the check: a turn that is out of time must not also pay
      // for a round trip.
      expect(s.seen).toHaveLength(0);
    } finally {
      s.stop();
    }
  });

  test("with no env it is unavailable and attempts nothing", async () => {
    const c = createControlClient({});
    expect(c.available()).toBe(false);
    const r = await c.call("music.status", {}, { deadline: soon() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unavailable");
    expect(await c.capabilities()).toEqual([]);
  });

  // A port with no token would be an unauthenticated surface. Half-configured
  // must mean off, not "off by one header".
  test("a port with no token counts as unavailable", () => {
    expect(createControlClient({ ATLAS_CONTROL_PORT: "1234" }).available()).toBe(false);
    expect(createControlClient({ ATLAS_CONTROL_TOKEN: "t" }).available()).toBe(false);
  });

  test("capabilities returns op names and caches them", async () => {
    let hits = 0;
    const s = stub(() => {
      hits++;
      return ok({ ops: [{ name: "music.status", tier: "read" }, { name: "data.news", tier: "read" }] });
    });
    try {
      const c = createControlClient(s.env);
      expect(await c.capabilities()).toEqual(["music.status", "data.news"]);
      expect(await c.capabilities()).toEqual(["music.status", "data.news"]);
      expect(hits).toBe(1);
    } finally {
      s.stop();
    }
  });

  test("a failed capabilities call yields [] and is NOT cached", async () => {
    let hits = 0;
    const s = stub(() => {
      hits++;
      return hits === 1 ? fail("internal", "boot race") : ok({ ops: [{ name: "data.news" }] });
    });
    try {
      const c = createControlClient(s.env);
      // [] is the safe direction: no capabilities means no tools declared.
      expect(await c.capabilities()).toEqual([]);
      // Not cached — a blip at boot must not blind the process for its lifetime.
      expect(await c.capabilities()).toEqual(["data.news"]);
    } finally {
      s.stop();
    }
  });
});
