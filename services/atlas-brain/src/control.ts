// Client for the Rust control port (src-tauri/src/control/).
//
// WHY THIS EXISTS. The brain is a separate OS process. Tauri IPC lives only
// inside the WKWebView, so until milestone 1 there was no path at all from a
// chat turn to any of the app's 39 #[tauri::command] functions — Claude could
// describe the desktop but never read it. Rust now runs a token-authed loopback
// HTTP port; this is the other end of that wire.
//
// TWO PROPERTIES THIS MODULE GUARANTEES, and both are load-bearing for the tool
// loop that calls it:
//
//   1. IT NEVER THROWS. Connection refused, a non-JSON body, an abort, a
//      malformed envelope, missing env — every one becomes a ControlResult.
//      The loop in orchestrator.ts turns tool results into model-visible text;
//      an exception there discards the whole turn, including work already paid
//      for. A failure the model can read ("the music engine is not connected")
//      is strictly better than a turn that dies.
//
//   2. IT DEGRADES TO ABSENT. With no port, `available()` is false and the
//      caller declares NO desktop tools. That is the honest direction: offering
//      a model a tool that cannot run produces a confident lie about what it
//      just did.

/** The port's own codes, translated. See CODE_MAP for the mapping and why. */
export type ErrCode =
  | "invalid_args"
  | "not_permitted"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "internal";

export type ControlResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: ErrCode; message: string; retryable: boolean } };

/**
 * Which caller the port should assume. Mirrors Rust's `Profile`.
 *
 * `interactive` is a claim about the WORLD, not about this process: it means a
 * human is in front of a window right now and can answer a question. Only a
 * live chat or voice turn may claim it. The scheduler's digest must say
 * `background`, and an omitted profile is read as `background` by Rust — the
 * restrictive direction — so forgetting the field costs an actuation, never
 * grants one.
 */
export type ControlProfile = "interactive" | "background";

export interface CallOpts {
  /** ABSOLUTE epoch-ms timestamp, not a duration. */
  deadline: number;
  /**
   * The account every op is scoped to. Rust rejects a non-Read op outright
   * without it, and `ops_db.rs` refuses to build a read query without it
   * either, so this is required in practice for everything except `data.*`.
   */
  userId?: string;
  /**
   * The user's own CF-issued JWT. Only `mail.*` needs it — the mail worker
   * authenticates the USER, not the desktop — but it is passed uniformly
   * rather than special-cased at every call site.
   */
  userToken?: string;
  profile?: ControlProfile;
}

export interface ControlClient {
  /** False when no port was handed to this process. Check before declaring tools. */
  available(): boolean;
  /** Op names the port advertises. Cached for the process; [] on any failure. */
  capabilities(): Promise<string[]>;
  call(op: string, args: unknown, opts: CallOpts): Promise<ControlResult>;
}

/**
 * Rust's seven codes -> ours, with the retry semantics the model will act on.
 *
 * `retryable` is not decoration: it is the difference between the model saying
 * "let me try that again" and "that will not work, here is why". Getting it
 * backwards makes Atlas either give up on a transient blip or loop on a
 * permanent refusal.
 *
 * `op_failed` is the interesting one. It means the op RAN and the world said no
 * — Spotify is not connected, the weather provider 500'd. That is genuinely
 * worth one retry, unlike a rejected argument, which will be rejected the same
 * way forever.
 *
 * `rate_limited` is marked NOT retryable, and that is a deliberate lie about
 * the long run in exchange for the truth about this turn. A token bucket does
 * refill — eventually — but the smallest bucket is 10/min, so the wait is tens
 * of seconds, while the whole turn budget is 8s (voice) to 20s (text). Every
 * retry inside that window is guaranteed to fail, and each one costs a tool
 * iteration and a model round trip that could have gone into an answer.
 * `retryable: false` makes the model do the only useful thing available: stop,
 * and tell the user it hit a limit. Rust's message carries `retry_after_ms`, so
 * the model can even say how long. Retrying is the job of the NEXT turn, when
 * the user has decided it is still worth doing.
 */
const CODE_MAP: Record<string, { code: ErrCode; retryable: boolean }> = {
  forbidden: { code: "not_permitted", retryable: false },
  too_large: { code: "invalid_args", retryable: false },
  bad_request: { code: "invalid_args", retryable: false },
  unknown_op: { code: "invalid_args", retryable: false },
  rate_limited: { code: "rate_limited", retryable: false },
  op_failed: { code: "unavailable", retryable: true },
  internal: { code: "internal", retryable: true },
};

// `timeout` is the one code with no Rust counterpart, and that is not an
// oversight: it is produced here, client-side, by the turn deadline. Rust has
// no view of the turn, so it could not emit it.
//
// (`rate_limited` used to sit in this note as "reserved". It is live now — the
// write tier's per-tier token buckets emit it with HTTP 429 — so it has a real
// CODE_MAP row above. Without one it would have fallen through to `internal`
// and been marked retryable, which is exactly the loop described there.)
const UNKNOWN_CODE = { code: "internal" as ErrCode, retryable: true };

const err = (code: ErrCode, message: string, retryable: boolean): ControlResult => ({
  ok: false,
  error: { code, message, retryable },
});

export function createControlClient(env: Record<string, string | undefined> = process.env): ControlClient {
  const port = env.ATLAS_CONTROL_PORT;
  const token = env.ATLAS_CONTROL_TOKEN;
  // Both or neither. A port with no token would be an unauthenticated surface,
  // so treat a half-configured environment as no environment at all.
  const ready = Boolean(port && token);
  const base = ready ? `http://127.0.0.1:${port}` : "";

  let capsCache: string[] | null = null;

  /**
   * One request against the port.
   *
   * THE METHOD AND THE HEADER ARE PART OF A CROSS-LANGUAGE CONTRACT, and getting
   * either wrong is silent: the port answers every auth failure with the same
   * 403, so a mismatch does not look like a bug, it looks like "no desktop".
   *
   * The contract, as enforced by src-tauri/src/control/auth.rs `inspect`:
   *   rung 1  POST /v1/invoke  and  GET /v1/capabilities  — any other
   *           (method, path) pair is Forbidden. A GET to /v1/invoke, or a POST
   *           to /v1/capabilities, is rejected before the token is even read.
   *   rung 4  Authorization: Bearer <token>. It reads the `authorization`
   *           header and strips the literal prefix "Bearer "; a request without
   *           that header presents the empty string and fails the compare.
   *
   * This shipped wrong once. The client sent `x-atlas-control-token` on a POST
   * to both paths, so /v1/capabilities failed at rung 1 and /v1/invoke at rung
   * 4 — every call 403'd, capabilities() returned [], the orchestrator declared
   * zero desktop tools, and Claude silently had no desktop at all. Both test
   * suites were green throughout, because the stub in control.test.ts read the
   * same wrong header the client wrote: it pinned this side to itself instead
   * of to Rust. The tests now assert Rust's literals on both sides, and
   * auth.rs carries the mirror test.
   */
  async function request(
    method: "GET" | "POST",
    path: string,
    body: unknown | null,
    deadline: number,
  ): Promise<ControlResult> {
    if (!ready) {
      return err("unavailable", "the desktop control port is not available in this process", false);
    }

    // Check the deadline BEFORE spending a connection. A turn that has already
    // run out of time should not also pay for a round trip, and
    // AbortSignal.timeout() with a negative value is not a defined way to say
    // "already too late".
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return err("timeout", "the turn's time budget was exhausted before this call", false);
    }

    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          // "Bearer " with the trailing space is auth.rs's BEARER_PREFIX
          // verbatim. Nothing else is sent: a second, unread token header
          // would be a false clue for the next reader and a second place for
          // the secret to leak from.
          Authorization: `Bearer ${token as string}`,
          ...(body === null ? {} : { "Content-Type": "application/json" }),
        },
        // A GET carries no body. fetch rejects outright if one is supplied.
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(remaining),
      });
    } catch (e) {
      // AbortSignal.timeout rejects with a TimeoutError DOMException; anything
      // else here is a transport failure (the port died, the app quit).
      const timedOut = e instanceof DOMException && e.name === "TimeoutError";
      return timedOut
        ? err("timeout", `the desktop did not answer within the turn's budget`, false)
        : err("unavailable", `could not reach the desktop control port`, true);
    }

    // The port answers 403 with a deliberately uniform body for every auth
    // failure, so there is nothing to parse out of it — say what is true.
    if (res.status === 403) {
      return err("not_permitted", "the desktop refused this request", false);
    }

    let envelope: unknown;
    try {
      envelope = await res.json();
    } catch {
      return err("internal", `the desktop returned a non-JSON response (HTTP ${res.status})`, true);
    }

    if (typeof envelope !== "object" || envelope === null || !("ok" in envelope)) {
      return err("internal", "the desktop returned an unrecognised response shape", true);
    }

    const e = envelope as { ok: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
    if (e.ok === true) return { ok: true, data: e.data };

    const rawCode = typeof e.error?.code === "string" ? e.error.code : "internal";
    const mapped = CODE_MAP[rawCode] ?? UNKNOWN_CODE;
    const message =
      typeof e.error?.message === "string" && e.error.message.length > 0
        ? e.error.message
        : `the desktop reported "${rawCode}"`;
    return err(mapped.code, message, mapped.retryable);
  }

  return {
    available: () => ready,

    async capabilities(): Promise<string[]> {
      if (!ready) return [];
      if (capsCache) return capsCache;
      // Its own short budget, independent of any turn: this runs once at
      // startup, and a hung capabilities call must not stall the first chat.
      // GET, and no body. auth.rs matches ("GET", "/v1/capabilities") and
      // nothing else for this path — a POST here is Forbidden at rung 1,
      // before the token is read, which is exactly how this went unnoticed.
      const r = await request("GET", "/v1/capabilities", null, Date.now() + 3_000);
      if (!r.ok) {
        // [] rather than a throw, and NOT cached — a transient failure at boot
        // should not permanently blind the process to its own desktop.
        console.warn(`[control] capabilities unavailable: ${r.error.message}`);
        return [];
      }
      const ops = (r.data as { ops?: Array<{ name?: unknown }> })?.ops;
      capsCache = Array.isArray(ops)
        ? ops.map((o) => o?.name).filter((n): n is string => typeof n === "string")
        : [];
      return capsCache;
    },

    call(op, args, opts) {
      // IDENTITY GOES IN THE ENVELOPE, NEVER IN `args`. Rust reads `user_id`
      // off the body and injects it into every query itself; `ops_db.rs`
      // rejects a caller-supplied `user_id` inside args on purpose. Keeping the
      // two apart is what makes "the model chose which account to read" an
      // unreachable state rather than a validation rule.
      //
      // This was also a live defect until the write tier landed: the body
      // carried only {op, args}, so `ctx.user_id` was always "" and every
      // op that reads the local database — tasks.list, notes.list, events.list,
      // watchlist.list, both mail reads — failed with "this request carries no
      // user identity". Only the `data.*` ops, which take no account, worked.
      //
      // Fields are omitted rather than sent as null/"" so that Rust's own
      // "non-Read ops require a non-empty user_id" check is the thing that
      // refuses, with its message, instead of a blank string sliding through.
      const envelope: Record<string, unknown> = { op, args: args ?? {} };
      if (opts.userId) envelope.user_id = opts.userId;
      if (opts.userToken) envelope.user_token = opts.userToken;
      if (opts.profile) envelope.profile = opts.profile;
      return request("POST", "/v1/invoke", envelope, opts.deadline);
    },
  };
}
