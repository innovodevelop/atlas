// Tests for the control-port client against a REAL server on a real socket.
//
// Bun.serve on port 0 rather than a mocked fetch, deliberately: the failure
// modes that matter here are wire-level — a non-JSON body, a socket that never
// answers, a 403 with a deliberately uniform body — and a mock would encode my
// assumptions about those instead of testing them.
//
// WHY THE STUB ENFORCES THE LADDER INSTEAD OF JUST RECORDING HEADERS.
// It used to read `x-atlas-control-token` — the header the client happened to
// send — and assert it was present. That is a test of this file against itself.
// Rust never reads that header: auth.rs wants `Authorization: Bearer <token>`,
// and it matches `("GET", "/v1/capabilities")` / `("POST", "/v1/invoke")` and
// nothing else. So every real request 403'd, the client reported "no desktop",
// and this suite stayed green through all of it — the single most expensive
// kind of passing test.
//
// The stub below therefore reimplements auth.rs's rungs 1 and 4 and REFUSES
// anything Rust would refuse. A drift on either side now fails here.
// The mirror of this lives in src-tauri/src/control/auth.rs
// (`the_literals_the_brain_client_sends_are_accepted`); the two must be
// changed together.
import { describe, expect, test } from "bun:test";
import { createControlClient } from "./control.ts";

const TOKEN = "test-control-token";

/** auth.rs `BEARER_PREFIX`, verbatim — trailing space included. */
const BEARER_PREFIX = "Bearer ";

/** auth.rs rung 1: the ONLY two (method, path) pairs that resolve to a route. */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/v1/invoke"],
  ["GET", "/v1/capabilities"],
];

/**
 * Start a stub port that enforces Rust's auth ladder before delegating.
 *
 * `forbidden` counts rejections so a test can prove the client was refused
 * rather than merely getting an unexpected answer.
 */
function stub(handler: (req: Request) => Response | Promise<Response>) {
  const seen: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body: string;
  }> = [];
  let forbidden = 0;

  // auth.rs answers every rung with this exact body, so a caller cannot tell
  // WHICH rung refused it. Reproducing the uniformity matters: a test that
  // could distinguish them would let the client start branching on something
  // Rust deliberately does not expose.
  const FORBIDDEN = '{"ok":false,"error":{"code":"forbidden","message":"forbidden"}}';

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const authorization = req.headers.get("authorization");
      seen.push({ method: req.method, path, authorization, body: await req.clone().text() });
      const refuse = () => {
        forbidden++;
        return new Response(FORBIDDEN, { status: 403 });
      };

      // Rung 1 — method AND path. An unlisted pair never reaches the token.
      if (!ROUTES.some(([m, p]) => m === req.method && p === path)) return refuse();

      // Rung 2 — ANY Origin header at all is disqualifying. The port has no
      // browser clients; a page always has one attached by the browser, so its
      // mere presence identifies a caller that must not be here.
      if (req.headers.get("origin") !== null) return refuse();

      // Rung 3 — Host pinned to the exact literal address:port. This is the
      // DNS-rebinding defence, and it is the rung that silently binds Rust to
      // `control.ts`'s `http://127.0.0.1:${port}` base URL. Changing that one
      // word to `localhost` would make fetch send `Host: localhost:<port>`,
      // Rust would refuse every request, and — before this check existed —
      // both suites would still have been green. That is the identical failure
      // shape that already shipped once via the Authorization header, so it is
      // pinned here rather than left to be discovered again.
      if (req.headers.get("host") !== `127.0.0.1:${server.port}`) return refuse();

      // Rung 4 — bearer token. A missing header presents "" in Rust, which
      // fails the compare; reproduce that rather than short-circuiting on null.
      const presented = authorization?.startsWith(BEARER_PREFIX)
        ? authorization.slice(BEARER_PREFIX.length)
        : "";
      if (presented !== TOKEN) return refuse();

      return handler(req);
    },
  });

  return {
    env: { ATLAS_CONTROL_PORT: String(server.port), ATLAS_CONTROL_TOKEN: TOKEN },
    seen,
    forbiddenCount: () => forbidden,
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
      expect(s.seen[0].authorization).toBe(`${BEARER_PREFIX}${TOKEN}`);
      expect(s.seen[0].method).toBe("POST");
      expect(s.seen[0].path).toBe("/v1/invoke");
      expect(s.forbiddenCount()).toBe(0);
      expect(JSON.parse(s.seen[0].body)).toEqual({ op: "data.weather", args: { city: "Copenhagen" } });
    } finally {
      s.stop();
    }
  });

  // ---------------------------------------------------------------------
  // The wire contract with auth.rs. These are the tests that would have
  // caught the shipped defect where nothing worked and everything was green.
  // ---------------------------------------------------------------------

  test("capabilities uses GET with no body — a POST here is Forbidden at rung 1", async () => {
    const s = stub(() => ok({ ops: [{ name: "data.news", tier: "read" }] }));
    try {
      const caps = await createControlClient(s.env).capabilities();
      expect(caps).toEqual(["data.news"]);
      expect(s.seen[0].method).toBe("GET");
      expect(s.seen[0].path).toBe("/v1/capabilities");
      // A GET must carry no body at all: fetch rejects outright if one is set,
      // and Rust reads none.
      expect(s.seen[0].body).toBe("");
      // The real proof: the ladder let it through.
      expect(s.forbiddenCount()).toBe(0);
    } finally {
      s.stop();
    }
  });

  test("the token travels as Authorization: Bearer, and nowhere else", async () => {
    const s = stub(() => ok(null));
    try {
      await createControlClient(s.env).call("music.status", {}, { deadline: soon() });
      expect(s.seen[0].authorization).toBe(`${BEARER_PREFIX}${TOKEN}`);
      // The secret must not also be sent under the old custom header: a second
      // copy is a second place to leak from and a false clue for the reader.
      expect(s.seen[0].body).not.toContain(TOKEN);
    } finally {
      s.stop();
    }
  });

  test("the base URL is the literal 127.0.0.1 that rung 3 pins, and no Origin is sent", async () => {
    const s = stub(() => ok(null));
    try {
      const r = await createControlClient(s.env).call("music.status", {}, { deadline: soon() });
      // Passing the ladder at all is the assertion: the stub refuses on Host
      // mismatch and on any Origin, so a green call proves the client sent
      // `Host: 127.0.0.1:<port>` and no Origin. `localhost` would fail here.
      expect(r.ok).toBe(true);
      expect(s.forbiddenCount()).toBe(0);
    } finally {
      s.stop();
    }
  });

  test("a client with the wrong token is refused by the ladder, not answered", async () => {
    const s = stub(() => ok({ never: "reached" }));
    try {
      const wrong = createControlClient({ ...s.env, ATLAS_CONTROL_TOKEN: "not-the-token" });
      const r = await wrong.call("music.status", {}, { deadline: soon() });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("not_permitted");
      expect(s.forbiddenCount()).toBe(1);
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
    // NOT retryable on purpose: the smallest bucket is 10/min and the whole
    // turn budget is 8-20s, so every in-turn retry is guaranteed to fail while
    // costing an iteration. See CODE_MAP.
    ["rate_limited", "rate_limited", false],
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

  // Rust answers a throttled call with HTTP 429, not 200. The client must read
  // the envelope on any status except the deliberately-opaque 403 — a status
  // check that only tolerated 200 would flatten this to "non-JSON response".
  test("a 429 is read as rate_limited and keeps Rust's retry_after_ms message", async () => {
    const s = stub(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "rate_limited",
              message: "rate limit exceeded for tier 'write' (20/min); retry_after_ms=2400",
            },
          }),
          { status: 429 },
        ),
    );
    try {
      const r = await createControlClient(s.env).call("tasks.create", { title: "x" }, { deadline: soon() });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("rate_limited");
        expect(r.error.retryable).toBe(false);
        // The model can only tell the user how long to wait if the number survives.
        expect(r.error.message).toContain("retry_after_ms=2400");
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

  // ---------------------------------------------------------------------
  // Identity in the envelope
  //
  // Rust reads user_id/user_token/profile off the BODY, never out of `args`,
  // and injects the user id into every query itself. These tests pin that the
  // client puts them where Rust looks and nowhere else.

  test("user_id, user_token and profile travel in the envelope, never inside args", async () => {
    const s = stub(() => ok({ action: "created" }));
    try {
      await createControlClient(s.env).call(
        "tasks.create",
        { title: "Call the dentist" },
        { deadline: soon(), userId: "u-42", userToken: "cf.jwt", profile: "interactive" },
      );
      const body = JSON.parse(s.seen[0].body);
      expect(body).toEqual({
        op: "tasks.create",
        args: { title: "Call the dentist" },
        user_id: "u-42",
        user_token: "cf.jwt",
        profile: "interactive",
      });
      // The whole point: the model's arguments never carry an account.
      expect(body.args).not.toHaveProperty("user_id");
    } finally {
      s.stop();
    }
  });

  test("absent identity fields are omitted, not sent empty", async () => {
    const s = stub(() => ok({}));
    try {
      // Rust's own "non-Read ops require a non-empty user_id" check should be
      // what refuses, with its message — not a blank string sliding past it.
      await createControlClient(s.env).call("data.news", {}, { deadline: soon() });
      expect(JSON.parse(s.seen[0].body)).toEqual({ op: "data.news", args: {} });
    } finally {
      s.stop();
    }
  });

  test("the background profile is sent explicitly when asked for", async () => {
    const s = stub(() => ok({}));
    try {
      await createControlClient(s.env).call("data.weather", { city: "Sorø" }, {
        deadline: soon(),
        userId: "u-42",
        profile: "background",
      });
      expect(JSON.parse(s.seen[0].body).profile).toBe("background");
    } finally {
      s.stop();
    }
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
