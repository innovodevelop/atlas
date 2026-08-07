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

export interface ControlClient {
  /** False when no port was handed to this process. Check before declaring tools. */
  available(): boolean;
  /** Op names the port advertises. Cached for the process; [] on any failure. */
  capabilities(): Promise<string[]>;
  /** `deadline` is an ABSOLUTE epoch-ms timestamp, not a duration. */
  call(op: string, args: unknown, opts: { deadline: number }): Promise<ControlResult>;
}

/**
 * Rust's six codes -> ours, with the retry semantics the model will act on.
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
 */
const CODE_MAP: Record<string, { code: ErrCode; retryable: boolean }> = {
  forbidden: { code: "not_permitted", retryable: false },
  too_large: { code: "invalid_args", retryable: false },
  bad_request: { code: "invalid_args", retryable: false },
  unknown_op: { code: "invalid_args", retryable: false },
  op_failed: { code: "unavailable", retryable: true },
  internal: { code: "internal", retryable: true },
};

// `timeout` and `rate_limited` have no Rust counterpart TODAY and that is not
// an oversight: timeout is produced here, client-side, by the turn deadline,
// and rate_limited is reserved for the write tier's token buckets, which do not
// exist yet. When Rust starts emitting a rate-limit code, add it to CODE_MAP —
// the fallback below will otherwise flatten it to `internal` and mark it
// retryable, which for a rate limit is true but unhelpfully vague.
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

  async function post(path: string, body: unknown, deadline: number): Promise<ControlResult> {
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
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-atlas-control-token": token as string,
        },
        body: JSON.stringify(body),
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
      const r = await post("/v1/capabilities", {}, Date.now() + 3_000);
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
      return post("/v1/invoke", { op, args: args ?? {} }, opts.deadline);
    },
  };
}
