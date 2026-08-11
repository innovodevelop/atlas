// Atlas control port — a token-authed loopback HTTP surface that lets the
// out-of-process brain drive the desktop.
//
// WHY THIS EXISTS AT ALL
// The AI brain is a separate OS process (services/atlas-brain, Bun on
// 127.0.0.1:4830). Tauri IPC only exists inside the WKWebView, so the brain
// cannot reach any `#[tauri::command]` — Claude can talk about the desktop but
// not touch it. Routing tool calls through the webview was rejected because the
// proactive scheduler runs HEADLESS: it must be able to use tools with no
// window open. A local HTTP port is the only surface both callers share.
//
// WHY tiny_http AND NOT axum
// tiny_http's dependency tree is 4 crates (ascii, chunked_transfer, httpdate,
// log) that share nothing with the existing graph. axum would pull ~30
// overlapping http/hyper/tower/tokio crates — a disproportionate risk against a
// lockfile that is pinned by librespot's vergen requirement (see Cargo.toml).
// tiny_http also avoids the main-thread trap STRUCTURALLY: it is a blocking
// server we run on threads we own, rather than something whose safety depends
// on everyone remembering to write `#[tauri::command(async)]`. See the incident
// write-up at the top of src/http.rs for what that trap cost last time.
//
// WHAT THE DISPATCHER ENFORCES
// Every invoke passes, in this order: the auth ladder (auth.rs), a per-tier
// rate limit, the tier x profile gate (policy.rs), and — for anything above a
// read — an audit row written BEFORE dispatch (audit.rs). `Tier` is no longer
// a label the dispatcher merely carries: reads run, writes run audited,
// actuations run only when a human is present, and approval-tier calls never
// auto-run at all. What the registry actually declares today is a separate
// question, answered in registry.rs; this file is the policy that applies to
// whatever it declares.
//
// The one execution path that does not start here is `approval_resolve` at the
// bottom of this file: the Tauri command a human's yes/no arrives on. It stays
// in Rust, and the payload it executes never leaves process memory, so the
// webview can answer the question but cannot choose it.

pub mod audit;
pub mod auth;
pub mod policy;
pub mod registry;

use std::io::Read;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

/// Fixed worker count. This IS the concurrency cap for OP EXECUTION: a slow op
/// occupies one worker and the other three keep serving.
///
/// IT IS NOT A CAP ON THREADS, AND THE COMMENT THAT SAID SO WAS WRONG.
/// tiny_http 0.12 accepts connections on its own thread and hands each accepted
/// connection to `util::TaskPool::spawn`, which starts a NEW OS thread whenever
/// no pooled thread is idle (task_pool.rs: `if waiting_tasks == 0 { add_thread }`).
/// The spawned task then runs `for rq in client` for that connection's entire
/// lifetime, so it is never idle and the pool's 5-second idle reaper never
/// collects it. All of that happens BEFORE `recv()` hands us anything, which is
/// where our auth ladder lives — so any local process can hold N threads inside
/// Atlas by opening N sockets, with no token at all.
///
/// That is not fixable from this file: tiny_http exposes no connection limit,
/// no accept hook and no per-socket timeout (`grep set_read_timeout` in the
/// crate finds nothing). Two consequences follow and are stated rather than
/// papered over:
///   * a connection flood costs threads and memory, not desktop capability —
///     nothing past `recv()` runs without the bearer token;
///   * a token-holding caller that declares a Content-Length and then stalls
///     parks one worker indefinitely. The body read is bounded in BYTES
///     (`take(MAX_BODY + 1)`, in `compose` — the panic-containment split moved it
///     out of `handle`, which now only wraps `compose` and answers) but not in
///     TIME, and there is no socket read timeout to bound it with.
///
/// Closing either one means replacing the dependency, which is a decision with
/// its own note at the top of this file.
const WORKERS: usize = 4;

/// A live control port. `token` is the per-launch bearer secret.
pub struct ControlPort {
    pub port: u16,
    pub token: String,
}

// ---------------------------------------------------------------------------
// Types the dispatcher and later tiers build on
// ---------------------------------------------------------------------------

/// Escalating capability classes, and the input to the only gate that matters.
/// `policy::decide` maps (tier, profile) to what the dispatcher does; see the
/// matrix there rather than inferring it from the names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Read,
    Write,
    Actuate,
    Approval,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Read => "read",
            Tier::Write => "write",
            Tier::Actuate => "actuate",
            Tier::Approval => "approval",
        }
    }
}

/// Who is driving. `Interactive` means a human is present in front of a window
/// and can be asked something; `Background` is the headless proactive
/// scheduler, where no prompt can ever be answered — so every actuation it asks
/// for is downgraded to an approval instead (policy::decide).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Interactive,
    Background,
}

/// Per-invocation caller identity, threaded into every op.
///
/// `user_token` is the caller's own upstream credential (the brain's CF-issued
/// JWT). It is deliberately NOT the control-port token: ops that need to reach
/// a remote service on the user's behalf must present the user's credential,
/// not the desktop's.
pub struct Ctx {
    pub user_id: String,
    pub user_token: Option<String>,
    pub profile: Profile,
    /// Correlation key for one dispatch, written to the control port's log.
    ///
    /// WHAT IT TIES, AND WHAT IT DOES NOT. It reaches the LOG, never a row:
    /// neither `tool_calls` nor `approvals` has a column for it, and adding one
    /// is a schema migration that this field is not worth on its own. Inside
    /// the database the rows of one call already find each other —
    /// `approvals.tool_call_id` is a foreign key and `approval_resolve` updates
    /// that same pair — so what the log line buys is the tie ACROSS the process
    /// boundary: which of the brain's requests produced this desktop row.
    ///
    /// That half is latent today, and saying so is the point: the brain's
    /// client (services/atlas-brain/src/control.ts) does not put `request_id`
    /// in the envelope, so every id here is currently one Rust generated.
    ///
    /// It was dead plumbing before this — parsed, threaded into every op, read
    /// nowhere. `the_row_writing_paths_log_their_request_id` is what stops it
    /// quietly becoming that again.
    pub request_id: String,
}

/// One exposed operation. `run` is a plain fn pointer so `OPS` can be a
/// `static` with no lazy initialisation and no allocation at startup.
pub struct Op {
    pub name: &'static str,
    pub tier: Tier,
    /// Declared time budget, surfaced in /v1/capabilities so the brain can
    /// plan around it.
    ///
    /// ADVISORY, NOT ENFORCED — and it stays that way deliberately. The
    /// dispatcher runs each op inline on its worker thread, so the only honest
    /// way to enforce this number would be to run the op on a thread we then
    /// abandon on timeout. Every runner here is blocking (a ureq call, a
    /// SQLite statement); neither can be cancelled, so "enforcement" would mean
    /// leaking a thread that still completes its side effect a minute later,
    /// after we told the caller it did not happen. That is a worse failure than
    /// waiting.
    ///
    /// WHAT ACTUALLY BOUNDS AN OP, and what does not.
    ///
    /// Bounded: outbound HTTP through the shared agent (src/http.rs) has a 20s
    /// total ceiling.
    ///
    /// NOT BOUNDED, despite an earlier version of this comment: SQLite work.
    /// That claim cited the 5s `busy_timeout` in db.rs, which is not the same
    /// statement — `busy_timeout` bounds waiting for a lock held by ANOTHER
    /// connection, and it says nothing about either of the two things that
    /// actually make a control read wait here. First, `DbState` is a single
    /// `std::sync::Mutex<Connection>` (db.rs:665/684/702 and seven more sites)
    /// shared by all four workers AND the entire webview; a plain `lock()` has
    /// no timeout, so it waits as long as the holder takes. Second, statement
    /// duration is unbounded on its own terms: `memory_recall` runs a vector
    /// scan over the whole memory index on that one connection, and nobody has
    /// computed a ceiling for it. So a control read can queue behind webview
    /// work for an unknown time, and the honest statement is that a hung op
    /// costs one of the four workers until it finishes.
    pub timeout_ms: u64,
    pub summary: &'static str,
    /// The argument names, in order, that the approvals card may show — and the
    /// ONLY thing about the caller's arguments that ever reaches it.
    ///
    /// `None` means the op has not declared a card and CANNOT BE QUEUED:
    /// `queue_for_approval` refuses it before writing a row. That is the
    /// fail-closed default on purpose, because the alternative default —
    /// "render whatever the caller sent" — is the defect this field exists to
    /// remove (see `audit::action_summary` for what it did).
    ///
    /// `Some(keys)`: exactly these fields render, in this order, and nothing
    /// else. `keys[0]` is the IDENTIFYING field — the one that ties the card to
    /// a specific object — and is guaranteed to survive truncation. `Some(&[])`
    /// declares an op that legitimately takes no arguments (music.pause).
    ///
    /// Every op whose tier can reach the queue (`Approval` always, `Actuate` on
    /// the background profile) must be `Some`; a read that can never queue may
    /// be `None`. `queueable_ops_declare_a_card` at the bottom of this file is
    /// what enforces that against the live registry.
    pub summary_keys: Option<&'static [&'static str]>,
    pub run: fn(&AppHandle, &Value, &Ctx) -> Result<Value, String>,
}

/// Machine-readable failure classes for everything PAST the auth ladder. The
/// wire form is the snake_case string; the brain branches on it rather than on
/// message text.
///
/// THERE IS NO `Forbidden` AND NO `TooLarge` ARM, and the absence is the
/// decision. A 403 or a 413 is answered by `auth::Reject::render()` before the
/// dispatcher is reached, so a request that gets one never touches this enum.
/// Both variants existed here anyway, constructed by nothing but tests, which
/// left the status mapping written down twice — `status()` said 403/413, and
/// auth.rs's `FORBIDDEN_BODY`/`TOO_LARGE_BODY` said it again in hand-written
/// JSON — with nothing checking that the two still agreed.
///
/// Of the two ways to collapse that, deleting these arms is the one that keeps
/// the property auth.rs exists to hold. Routing real rejections through
/// `ControlResult::Err` instead would make "every rejection cause renders an
/// IDENTICAL 403" depend on every present and future call site passing the same
/// message string; as one `&'static str` it is identical by construction and
/// cannot drift. What the split still needs is that auth.rs's hand-written
/// bodies stay the shape the brain's single parser expects, and that is pinned
/// by `the_auth_ladders_bodies_are_the_envelope_the_brain_parses`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrCode {
    BadRequest,
    UnknownOp,
    /// Per-tier budget spent. Deliberately NOT answered with the ladder's 403:
    /// the auth ladder's sameness exists so a caller cannot probe the boundary,
    /// but a throttle is not a security answer — it is scheduling feedback for
    /// the legitimate caller, who has to know to wait rather than to re-check
    /// its token or give up on the tool. The message carries a machine-readable
    /// `retry_after_ms=<n>`.
    RateLimited,
    /// The op ran and failed. The message is the op's own error, verbatim:
    /// Atlas reports what actually went wrong instead of inventing a result.
    OpFailed,
    Internal,
}

impl ErrCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrCode::BadRequest => "bad_request",
            ErrCode::UnknownOp => "unknown_op",
            ErrCode::RateLimited => "rate_limited",
            ErrCode::OpFailed => "op_failed",
            ErrCode::Internal => "internal",
        }
    }
}

/// Uniform envelope for every non-auth response.
pub enum ControlResult {
    Ok(Value),
    Err { code: ErrCode, message: String },
}

impl ControlResult {
    pub fn to_json(&self) -> Value {
        match self {
            ControlResult::Ok(data) => json!({ "ok": true, "data": data }),
            ControlResult::Err { code, message } => json!({
                "ok": false,
                "error": { "code": code.as_str(), "message": message }
            }),
        }
    }

    /// Op-level failures are still HTTP 200: the request was well-formed and
    /// authorised, and the brain reads `ok` to decide. Reserving non-2xx for
    /// transport problems — and, one layer earlier, for the auth ladder's 403
    /// and 413 — keeps those classes distinguishable.
    pub fn status(&self) -> u16 {
        match self {
            ControlResult::Ok(_) => 200,
            ControlResult::Err { code, .. } => match code {
                ErrCode::BadRequest | ErrCode::UnknownOp => 400,
                // 429, the one status whose defined meaning is exactly "you may
                // retry this later". 403 would tell the brain to stop trying,
                // and a 200 with ok:false would put a throttle in the same bin
                // as "the op ran and failed", which is the one thing a caller
                // must not confuse it with: an op that failed should not be
                // retried in a loop, a throttled one should be retried after a
                // wait. No Retry-After header — `respond()` writes a fixed
                // header set and the value is in the message instead.
                ErrCode::RateLimited => 429,
                ErrCode::OpFailed | ErrCode::Internal => 200,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct InvokeBody {
    op: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    user_token: Option<String>,
    #[serde(default)]
    profile: Option<Profile>,
    #[serde(default)]
    request_id: Option<String>,
}

impl InvokeBody {
    /// An ABSENT profile is `Background`.
    ///
    /// This is load-bearing, not a default chosen for tidiness: `Background` is
    /// the profile that cannot actuate, so a caller that forgets the field —
    /// or a request that lost it somewhere — gets the restrictive answer. Note
    /// what serde does with a profile it does not recognise: the whole body
    /// fails to parse and the request is a 400. There is no arm that turns an
    /// unknown string into a permissive value.
    fn profile(&self) -> Profile {
        self.profile.unwrap_or(Profile::Background)
    }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/// Bind the control port and hand back its address and secret.
///
/// Returns immediately: binding is the only synchronous work, and every
/// subsequent `recv()` happens on a worker thread. This is safe to call from
/// Tauri's setup hook on the main thread.
///
/// A failure here is NON-FATAL by design. The caller should log and continue —
/// with no port, the brain simply declares no desktop tools and chat keeps
/// working. Losing tool access is strictly better than failing to launch.
pub fn start(app: &AppHandle) -> Result<ControlPort, String> {
    // Captured BEFORE anything can serve a request, so it is a clean line
    // between "a row a previous process left behind" and "a row we wrote". The
    // reconciliation thread below uses it as its cutoff.
    let cutoff = audit::now_iso();

    // A NEW uuid, deliberately NOT the existing `gateway_token`.
    //
    // This is the whole reason a second secret exists: `atlas_brain_info` hands
    // gateway_token TO THE WEBVIEW, and the mail UI renders provider-supplied
    // HTML. If the control port accepted gateway_token, any mail-body XSS would
    // escalate straight to full desktop control. The control token must
    // therefore never be returned by any `#[tauri::command]`, never be logged,
    // and never be handed to the webview by any future code.
    let token = uuid::Uuid::new_v4().to_string();

    // Port 0 = let the OS pick a free one; loopback only, so nothing off-box
    // can even open a socket to it.
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("control port bind failed: {e}"))?;

    // Read back the port the OS actually assigned.
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "control port bound to a non-IP address".to_string())?
        .port();

    // The exact Host value we will accept — see the DNS-rebinding note in auth.rs.
    let expected_host = format!("127.0.0.1:{port}");

    let server = Arc::new(server);
    for i in 0..WORKERS {
        let server = Arc::clone(&server);
        let app = app.clone();
        let token = token.clone();
        let expected_host = expected_host.clone();
        std::thread::Builder::new()
            .name(format!("atlas-control-{i}"))
            .spawn(move || {
                // `recv()` blocks; tiny_http hands each waiting worker the next
                // connection. Blocking here is fine precisely because this is
                // not the UI thread.
                while let Ok(request) = server.recv() {
                    handle(&app, request, &token, &expected_host);
                }
                // Reached only when recv() itself errors. Nothing respawns a
                // worker, so a silent exit here would quietly shrink the pool;
                // four of these and the port accepts TCP and answers nothing.
                log::error!("[control] worker {i} exited: the server stopped accepting");
            })
            .map_err(|e| format!("control port worker spawn failed: {e}"))?;
    }

    // THE EXPIRY SWEEPER — the clock the queue did not have.
    //
    // `prune_pending` was reachable only from `pending_is_full`/`push_pending`/
    // `take_pending`, and `settle_expired` only from `queue_for_approval`/
    // `approval_resolve`. Every one of those needs somebody to touch the queue, so
    // on an idle app nothing expired anything: one card queued, the user ignores
    // it, the TTL passes, and the entry was not even moved onto `EXPIRED` — the
    // `approvals` row kept `status='pending'`, and `useApprovals` counts exactly
    // that into the badge. The user was left with a card and a lit badge for an
    // action that could no longer run, until the next queue/resolve or a restart.
    // That is the symptom `prune_pending`'s own comment claimed was fixed.
    //
    // Unconditionally safe to run: `sweep_pending` only drops entries already past
    // their window, and every write `settle_expired` makes is a compare-and-set on
    // `status='pending'`, so a human answering in the same instant still wins.
    {
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("atlas-control-expiry".to_string())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(SWEEP_INTERVAL_SECS));
                sweep_pending();
                settle_expired(&app);
            });
        if let Err(e) = spawned {
            log::warn!(
                "[control] expiry sweeper spawn failed: {e}; expired approvals will only be \
                 closed by the next queue, resolve or restart"
            );
        }
    }

    // Reconciliation runs on a thread of its own, and it has to: `DbState` is
    // managed by the NEXT block of lib.rs's setup hook, after this function
    // returns. See `audit::reconcile_in_flight` for what it closes and why the
    // cutoff makes it safe against a request arriving mid-startup.
    {
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("atlas-control-reconcile".to_string())
            .spawn(move || audit::reconcile_in_flight(&app, &cutoff));
        // Non-fatal, like every other failure in this function: a trail nobody
        // reconciled is worse than one that was, not worse than no port at all.
        if let Err(e) = spawned {
            log::warn!("[control] reconciliation thread spawn failed: {e}");
        }
    }

    Ok(ControlPort { port, token })
}

// ---------------------------------------------------------------------------
// Panic containment
// ---------------------------------------------------------------------------

/// Run `f`, turning a panic into an error string.
///
/// WHAT THE ABSENCE OF THIS DID. `handle` runs inside
/// `while let Ok(request) = server.recv()` on each of four worker threads,
/// there was no `catch_unwind` anywhere in src-tauri/src, and `panic = "abort"`
/// is deliberately NOT set (Cargo.toml), so unwinding is live. A panic inside
/// an op therefore unwound out of `handle`, ended the `while let`, and killed
/// that worker for the rest of the process — nothing respawns one. The path is
/// reachable, not theoretical: `music.status`/`search`/`play` reach
/// `crate::music::valid_token`, which does `state.access.lock().unwrap()`
/// (music.rs:173,180) and `state.engine.lock().unwrap()` (music.rs:234,251), and
/// a poisoned `MusicState` mutex panics on every subsequent call. Four of those
/// and the port still completed a TCP handshake but answered nothing, forever:
/// tiny_http keeps queueing requests with nobody calling `recv()`, so every
/// brain tool call hung to its own timeout with no error and no log line.
///
/// Catching also restores the audit trail. The unwind skipped `audit::finish`,
/// so the pre-dispatch `tool_calls` row stayed `running` permanently — a call
/// that crashed and a call still in flight looked identical.
///
/// `AssertUnwindSafe` is asserted rather than proved, and the assertion is
/// narrow: the state that could be left inconsistent is behind mutexes that are
/// now POISONED, and every reader of those either recovers deliberately
/// (`policy::check_rate`, `lock_pending`) or panics again — which now surfaces
/// as another honest `op_failed` instead of another dead worker.
fn catch<T>(what: &str, f: impl FnOnce() -> T) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(value) => Ok(value),
        Err(payload) => {
            let detail = panic_detail(payload.as_ref());
            log::error!("[control] {what} panicked: {detail}");
            Err(format!("{what} panicked: {detail}"))
        }
    }
}

/// The panic message, if it was one of the two payload types `panic!` produces.
fn panic_detail(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panicked with a non-string payload".to_string()
    }
}

/// The ONLY place an op runner may be invoked. Both call sites (the dispatcher
/// and `approval_resolve`) go through here so a panicking runner becomes an
/// `Err` the caller is told about and the audit row is closed either way.
fn run_op(app: &AppHandle, op: &Op, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    catch(op.name, || (op.run)(app, args, ctx)).unwrap_or_else(Err)
}

/// Serve one request. Never panics out of the worker — and now that is the
/// code's doing rather than the comment's: `compose` runs inside `catch`, so a
/// panic anywhere in auth, parsing, redaction or an op becomes a 200 with
/// `ok:false` and the worker goes back to `recv()`.
fn handle(app: &AppHandle, mut request: tiny_http::Request, token: &str, expected_host: &str) {
    let (status, body) = match catch("control request", || {
        compose(app, &mut request, token, expected_host)
    }) {
        Ok(answer) => answer,
        Err(message) => {
            // Answering at all is the point: an unanswered request is a socket
            // the brain waits on until its own timeout, with nothing anywhere
            // saying why.
            let result = ControlResult::Err {
                code: ErrCode::Internal,
                message,
            };
            (result.status(), result.to_json().to_string())
        }
    };
    respond(request, status, &body);
}

/// Everything between reading the request and writing the answer.
fn compose(
    app: &AppHandle,
    request: &mut tiny_http::Request,
    token: &str,
    expected_host: &str,
) -> (u16, String) {
    let head = auth::RequestHead {
        method: request.method().as_str(),
        path: path_only(request.url()),
        origin: header(request, "origin"),
        host: header(request, "host"),
        authorization: header(request, "authorization"),
        // `body_length()` is None for chunked bodies; the read below is capped
        // regardless, so an unknown length is treated as 0 here and caught there.
        content_length: request.body_length().unwrap_or(0),
    };

    let route = match auth::inspect(&head, expected_host, token) {
        Ok(route) => route,
        Err(reject) => {
            let (status, body) = reject.render();
            return (status, body.to_string());
        }
    };

    let result = match route {
        auth::Route::Capabilities => ControlResult::Ok(registry::capabilities()),
        auth::Route::Invoke => {
            let mut buf = Vec::new();
            // Second-line cap: a chunked body reports no length, so bound the
            // read itself. One extra byte lets us tell "exactly at the limit"
            // from "over it". Bounded in bytes only — see the WORKERS comment
            // for the time bound this cannot provide.
            let over = request
                .as_reader()
                .take(auth::MAX_BODY as u64 + 1)
                .read_to_end(&mut buf)
                .map(|_| buf.len() > auth::MAX_BODY)
                .unwrap_or(true);
            if over {
                let (status, body) = auth::Reject::TooLarge.render();
                return (status, body.to_string());
            }
            invoke(app, &buf)
        }
    };

    (result.status(), result.to_json().to_string())
}

/// Ceiling on a caller-supplied `request_id`.
///
/// 64 characters: a uuid is 36, and anything longer than that is not an
/// identifier, it is a payload. The value is an arbitrary string off the wire
/// that ends up in a log line, which is a single-line frame with the same
/// weakness the approvals card has — a newline in it forges a second line — so
/// it is cleaned by the same function the card uses.
const REQUEST_ID_MAX: usize = 64;

/// A usable correlation key: the caller's, cleaned and bounded, or a fresh uuid
/// when it sent nothing that survived cleaning. Never empty — an empty key
/// would group unrelated calls together in whatever reads the log.
fn request_id(supplied: Option<&str>) -> String {
    let cleaned = supplied
        .map(|id| audit::sanitize(id, REQUEST_ID_MAX))
        .unwrap_or_default();
    if cleaned.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        cleaned
    }
}

/// Parse the invoke envelope, resolve the op, run it.
fn invoke(app: &AppHandle, body: &[u8]) -> ControlResult {
    let parsed: InvokeBody = match serde_json::from_slice(body) {
        Ok(p) => p,
        Err(e) => {
            return ControlResult::Err {
                code: ErrCode::BadRequest,
                message: format!("invalid JSON body: {e}"),
            }
        }
    };

    let Some(op) = registry::lookup(&parsed.op) else {
        // Name the op back. It is not a secret — /v1/capabilities lists them —
        // and a caller that mistypes deserves to know rather than guess.
        return ControlResult::Err {
            code: ErrCode::UnknownOp,
            message: format!("no such op: {}", parsed.op),
        };
    };

    let ctx = Ctx {
        user_id: parsed.user_id.clone().unwrap_or_default(),
        user_token: parsed.user_token.clone(),
        profile: parsed.profile(),
        request_id: request_id(parsed.request_id.as_deref()),
    };

    // Rate limit BEFORE the gate, and against the op's DECLARED tier. Queuing
    // an approval is cheap for the caller and expensive for the user — it costs
    // them a card to answer — so a flood of them has to be throttled by the same
    // ceiling as the actuation it stands in for.
    if let Err(retry_after_ms) = policy::check_rate(op.tier) {
        return ControlResult::Err {
            code: ErrCode::RateLimited,
            message: format!(
                "rate limit exceeded for tier '{}' ({}/min); retry_after_ms={}",
                op.tier.as_str(),
                policy::limit_for(op.tier),
                retry_after_ms
            ),
        };
    }

    let decision = policy::decide(op.tier, ctx.profile);

    // Anything past a read is filed under a user id — in the audit trail, and
    // in the approvals queue the UI reads with `.eq('user_id', user.id)`. A row
    // filed under "" is a row no interface ever shows, which for an approval
    // means an op parked forever with nobody able to answer it. Refuse instead.
    if !matches!(decision, policy::Decision::Run) && ctx.user_id.is_empty() {
        return ControlResult::Err {
            code: ErrCode::BadRequest,
            message: format!(
                "op '{}' is tier '{}' and requires a user_id in the request body",
                op.name,
                op.tier.as_str()
            ),
        };
    }

    // Redact once, up front: the same value goes into the audit row, the
    // approvals card and any log line, and none of them should carry the
    // verbatim text (audit.rs explains what the threshold buys).
    let redacted = audit::redact(&parsed.args);

    match decision {
        policy::Decision::Queue(reason) => queue_for_approval(app, &ctx, op, &parsed.args, &redacted, reason),
        _ => execute(app, &ctx, op, &parsed.args, &redacted, decision),
    }
}

/// Run one op, writing the audit row first when the decision calls for it.
fn execute(
    app: &AppHandle,
    ctx: &Ctx,
    op: &'static Op,
    args: &Value,
    redacted: &Value,
    decision: policy::Decision,
) -> ControlResult {
    // BEFORE dispatch, and fail closed. If the trail cannot be written the op
    // does not run: an unauditable write is indistinguishable from one somebody
    // wanted hidden, and the caller here is a model reading attacker-authored
    // text, so "skip the log this once" must not be a reachable state.
    let tool_call_id = if decision.audited() {
        match audit::record_running(app, ctx, op, redacted) {
            Ok(id) => {
                // The ONLY place the request and the row it produced are ever
                // written down together: `tool_calls` has no column for a
                // request id (see `Ctx::request_id`).
                log::info!(
                    "[control] {} audited as tool_call {id} for request {}",
                    op.name,
                    ctx.request_id
                );
                Some(id)
            }
            Err(e) => {
                return ControlResult::Err {
                    code: ErrCode::Internal,
                    message: format!("refusing to run {}: audit write failed: {e}", op.name),
                }
            }
        }
    } else {
        None
    };

    let Some(outcome) = policy::gate(decision, || run_op(app, op, args, ctx)) else {
        // Unreachable while `nothing_is_audited_that_does_not_execute` holds,
        // but a wrong answer beats a panic on a worker thread — and if the
        // matrix ever changes underneath this, the stranded row gets closed.
        let message = format!("{} was not executable after the gate allowed it", op.name);
        if let Some(id) = &tool_call_id {
            audit::finish(app, id, &Err(message.clone()));
        }
        return ControlResult::Err {
            code: ErrCode::Internal,
            message,
        };
    };

    if let Some(id) = &tool_call_id {
        audit::finish(app, id, &outcome);
    }

    match outcome {
        Ok(data) => ControlResult::Ok(data),
        // The op's own message, unaltered. A truthful failure is the product
        // requirement here — never substitute a plausible-looking result.
        Err(message) => ControlResult::Err {
            code: ErrCode::OpFailed,
            message,
        },
    }
}

/// File a call in the approvals queue and answer immediately.
///
/// IMMEDIATELY is the requirement. The caller is the brain, mid-chat-stream:
/// blocking a worker until a human clicks something would hang the reply, hold
/// one of four workers for up to an hour, and time out long before any answer
/// arrived. So the queue returns a result the brain can narrate ("I have asked
/// for permission to…") and execution moves to `approval_resolve`.
fn queue_for_approval(
    app: &AppHandle,
    ctx: &Ctx,
    op: &'static Op,
    args: &Value,
    redacted: &Value,
    reason: policy::ApprovalReason,
) -> ControlResult {
    // FAIL CLOSED ON AN OP THAT DECLARES NO CARD. The approvals card is the
    // whole consent mechanism, and `Op::summary_keys: None` means nobody has
    // said which of this op's arguments a human needs to see. Refusing here —
    // before any row is written — is the only answer that is not a guess: the
    // alternative the old code took was to render every key the CALLER sent,
    // which is how an injected argument ended up on the button the user clicks.
    if op.summary_keys.is_none() {
        return ControlResult::Err {
            code: ErrCode::Internal,
            message: format!(
                "{} cannot be queued for approval: it declares no summary_keys, so there is \
                 no card a user could consent to",
                op.name
            ),
        };
    }

    // NAME THE OBJECT, OR DO NOT ASK.
    //
    // WHAT THE CARD SAID BEFORE THIS: for `mail.archive` and `mail.mark_read` —
    // the only two ops that can be queued in any shipped configuration — the
    // entire card was `approval mail.archive with thread_id="9f2c8a1e-…"`. That
    // is a LOCAL uuid: no screen in the app shows it, and mail.rs translates it
    // to a separate `provider_thread_id` before talking to the server. The model
    // picked which one out of a prior `mail.list_threads` read, and the model's
    // context is full of mail written by strangers. So the whole content of the
    // decision was a string the person clicking Approve could not decode, and the
    // honest description of that click was "yes to whatever you had in mind".
    //
    // Resolved BEFORE any row is written, and a `Missing` target REFUSES the
    // queue: an id that names nothing cannot be described to a human, so there is
    // nothing to consent to — and queueing it anyway would show a card for a
    // non-existent object and then fail an hour later, after the yes. It also
    // moves `ops_mail`'s thread lookup to before the card instead of after the
    // approval.
    let target = registry::card_target(app, ctx, op, args);
    match &target {
        registry::CardTarget::Missing { id_arg, shown } => {
            return ControlResult::Err {
                code: ErrCode::BadRequest,
                message: format!(
                    "{}'s {id_arg} '{shown}' does not name anything in Atlas' local store, so \
                     there is no action a user could be shown and asked about",
                    op.name
                ),
            }
        }
        registry::CardTarget::Unreadable(e) => {
            return ControlResult::Err {
                code: ErrCode::OpFailed,
                message: format!(
                    "could not describe what {} would act on, so it was not queued: {e}",
                    op.name
                ),
            }
        }
        registry::CardTarget::None | registry::CardTarget::Found { .. } => {}
    }
    let object = match &target {
        registry::CardTarget::Found { columns, row } => Some(audit::CardObject { columns, row }),
        _ => None,
    };

    // Close out the database rows of anything the in-memory queue has aged out
    // since the last time a thread with an AppHandle came through here.
    settle_expired(app);

    // Checked before the rows are written so the common rejection is cheap and
    // leaves nothing behind; `push_pending` re-checks under the lock.
    if pending_is_full() {
        return ControlResult::Err {
            code: ErrCode::OpFailed,
            message: format!(
                "there are already {MAX_PENDING} approvals waiting; answer or let them expire first"
            ),
        };
    }

    let queued = match audit::queue(app, ctx, op, redacted, object.as_ref(), reason.message()) {
        Ok(q) => q,
        Err(e) => {
            return ControlResult::Err {
                code: ErrCode::Internal,
                message: format!("could not queue {} for approval: {e}", op.name),
            }
        }
    };

    let pending = Pending {
        approval_id: queued.approval_id.clone(),
        tool_call_id: queued.tool_call_id.clone(),
        op,
        // The REAL args, held only here. See `PENDING`.
        args: args.clone(),
        user_id: ctx.user_id.clone(),
        user_token: ctx.user_token.clone(),
        expires_at_ms: policy::monotonic_ms()
            .saturating_add(audit::APPROVAL_TTL_SECS as u64 * 1_000),
    };
    if let Err(e) = push_pending(pending) {
        // The rows exist but nothing can ever execute them; close them out
        // rather than showing the user a card that would fail on yes.
        let _ = audit::expire_approval(
            app,
            &queued.approval_id,
            "the approvals queue was full; nothing was run",
        );
        audit::record_rejected(app, &queued.tool_call_id);
        return ControlResult::Err {
            code: ErrCode::OpFailed,
            message: e,
        };
    }

    // One request, two rows, and a card a human may answer an hour later. This
    // line is what says which request they all belong to. `approval_resolve`
    // logs the APPROVAL id as its key (that is what its `ctx.request_id` is),
    // and the id is in this line too, so one grep on it finds both ends of a
    // card's life.
    log::info!(
        "[control] {} queued as approval {} / tool_call {} for request {}",
        op.name,
        queued.approval_id,
        queued.tool_call_id,
        ctx.request_id
    );

    ControlResult::Ok(json!({
        "status": "awaiting_approval",
        "approval_id": queued.approval_id,
        "tool_call_id": queued.tool_call_id,
        "op": op.name,
        "tier": op.tier.as_str(),
        "risk_level": queued.risk_level,
        // Composed by Rust, never by the model that asked for the action.
        // NOT "from validated args" — an earlier version of this line said so
        // and nothing validates them: a queued call short-circuits before the
        // runner, so the op's own argument checks never run. What makes the
        // sentence trustworthy is that only fields the op DECLARED are in it
        // and every value is JSON-escaped. audit::action_summary has the rest.
        "action_summary": queued.action_summary,
        "reason_code": reason.code(),
        "reason": reason.message(),
        "expires_at": queued.expires_at,
    }))
}

// ---------------------------------------------------------------------------
// The approvals queue's executable half
// ---------------------------------------------------------------------------

/// How many approvals may wait at once.
///
/// Small on purpose. The queue is a list of questions a person has to answer,
/// and a hundred of them is not a queue, it is a denial of service against the
/// user's attention that ends with somebody clicking yes to clear the screen.
/// The rate limiter caps the arrival rate; this caps the standing depth.
const MAX_PENDING: usize = 32;

/// One approved-or-not call, waiting.
struct Pending {
    approval_id: String,
    tool_call_id: String,
    op: &'static Op,
    args: Value,
    user_id: String,
    user_token: Option<String>,
    /// Monotonic, not wall clock: moving the system clock must not extend the
    /// window in which a queued actuation is still executable.
    expires_at_ms: u64,
}

/// The pending calls, IN PROCESS MEMORY AND NOWHERE ELSE.
///
/// This is the load-bearing half of "the webview can only say yes or no, never
/// what runs". The database rows carry the redacted arguments, which is enough
/// to render a card and nothing else; the arguments that would actually be
/// executed live here. So anything that can write `tool_calls`/`approvals` —
/// the generic db commands are reachable from the webview, and the webview
/// renders provider-supplied mail HTML — can change what the card SAYS but
/// cannot substitute what it DOES, and cannot manufacture a new one.
///
/// A relaunch drops the queue. That is the correct behaviour and not a
/// limitation to fix later: an approval that outlives the process is an
/// instruction from a session nobody remembers, and executing it afterwards is
/// exactly the surprise the whole tier exists to prevent.
static PENDING: Mutex<Vec<Pending>> = Mutex::new(Vec::new());

fn lock_pending() -> std::sync::MutexGuard<'static, Vec<Pending>> {
    // Same reasoning as the rate limiter's lock: recovering from poisoning is
    // right because a panic cannot have broken an invariant over a Vec, and the
    // alternative is a control port that stops queueing anything forever.
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Approvals whose in-memory payload has aged out, waiting for a thread that
/// holds an `AppHandle` to close their database rows.
///
/// This queue exists because the pruning happens under the `PENDING` lock, in
/// functions that have no handle, and the fix for "nothing ever expires
/// anything" has to reach the database. Lock order is one-way — `prune_pending`
/// holds `PENDING` and takes `EXPIRED`, `settle_expired` takes only `EXPIRED` —
/// so the pair cannot deadlock.
static EXPIRED: Mutex<Vec<Expired>> = Mutex::new(Vec::new());

struct Expired {
    approval_id: String,
    tool_call_id: String,
}

fn lock_expired() -> std::sync::MutexGuard<'static, Vec<Expired>> {
    EXPIRED.lock().unwrap_or_else(|e| e.into_inner())
}

/// How often the sweeper thread drains the queue. A minute: the TTL is an hour
/// (`audit::APPROVAL_TTL_SECS`), so a card's row is closed within a minute of
/// becoming unexecutable, and the cost of the thread is one wakeup a minute.
const SWEEP_INTERVAL_SECS: u64 = 60;

/// Drop everything past its window, without needing a caller.
///
/// Exists because every other entry point into `prune_pending` requires somebody
/// to touch the queue — see the sweeper in `start`.
fn sweep_pending() {
    let mut queue = lock_pending();
    prune_pending(&mut queue);
}

/// Drop everything past its window. Called on every touch AND once a minute by
/// the sweeper thread, so an abandoned queue drains itself whether or not
/// anything else is happening.
///
/// WHAT THIS USED TO LEAVE BEHIND. Dropping the payload made the card
/// unexecutable but changed nothing in the database, and nothing else did
/// either: `useApprovals` counts `status === 'pending'` and never looks at
/// `expires_at`, so the user kept a card and a badge for an action that could
/// no longer run, with no way to clear it. The ids go on `EXPIRED` here and the
/// rows are settled by the next caller that has a handle — the sweeper
/// guarantees there is one, which is what an idle app did not have.
fn prune_pending(queue: &mut Vec<Pending>) {
    let now = policy::monotonic_ms();
    let mut dropped = Vec::new();
    queue.retain(|p| {
        if p.expires_at_ms > now {
            true
        } else {
            dropped.push(Expired {
                approval_id: p.approval_id.clone(),
                tool_call_id: p.tool_call_id.clone(),
            });
            false
        }
    });
    if !dropped.is_empty() {
        lock_expired().extend(dropped);
    }
}

/// Settle the database rows of every card the queue has aged out.
fn settle_expired(app: &AppHandle) {
    let drained: Vec<Expired> = std::mem::take(&mut *lock_expired());
    for entry in drained {
        match audit::expire_approval(
            app,
            &entry.approval_id,
            "this request was not answered in time. Nothing was run.",
        ) {
            // Only the winner of the compare-and-set touches the tool_calls
            // row: if a human answered it in the same instant, that answer owns
            // the outcome, not this sweep.
            Ok(true) => audit::record_rejected(app, &entry.tool_call_id),
            Ok(false) => {}
            Err(e) => log::warn!(
                "[control] could not expire approval {}: {e}",
                entry.approval_id
            ),
        }
    }
}

fn pending_is_full() -> bool {
    let mut queue = lock_pending();
    prune_pending(&mut queue);
    queue.len() >= MAX_PENDING
}

fn push_pending(pending: Pending) -> Result<(), String> {
    let mut queue = lock_pending();
    prune_pending(&mut queue);
    if queue.len() >= MAX_PENDING {
        return Err(format!(
            "there are already {MAX_PENDING} approvals waiting; answer or let them expire first"
        ));
    }
    queue.push(pending);
    Ok(())
}

/// Remove and return one pending call. Taking it OUT is what makes a double
/// resolve a no-op: two clicks race for the same entry and only one wins, so an
/// approved action cannot execute twice.
fn take_pending(approval_id: &str) -> Option<Pending> {
    let mut queue = lock_pending();
    prune_pending(&mut queue);
    let idx = queue.iter().position(|p| p.approval_id == approval_id)?;
    Some(queue.swap_remove(idx))
}

/// The human's answer to one queued call.
///
/// `#[tauri::command(async)]` on a sync fn, matching mail.rs and music.rs: this
/// runs a real op, which may block on HTTP or SQLite, and a plain sync command
/// would run that on the MAIN thread and freeze the window (see the incident
/// note at the top of src/http.rs).
///
/// NOT rate limited. The limiter exists to bound a machine in a loop; this is a
/// person clicking a button, and every entry it can act on was already charged
/// against the actuation budget when it was queued.
///
/// Returns `Ok` even when the op fails, with the failure in `error` — the
/// webview asked "what happened", and "the approval resolved and the action
/// then failed" is a different answer from "the approval could not be
/// resolved", which is what an `Err` means here.
///
/// THIS IS THE ONLY WAY TO ANSWER A CARD. A frontend that writes
/// `approvals.status` itself (the generic db commands can) wins the
/// compare-and-set below and this command then refuses to run anything —
/// correctly, since it can no longer tell an answer from a replay. The row is
/// the record of the decision, not the mechanism for making it.
#[tauri::command(async)]
pub fn approval_resolve(
    app: AppHandle,
    approval_id: String,
    approved: bool,
) -> Result<Value, String> {
    // Housekeeping first: anything the queue aged out gets its rows closed
    // whether or not this particular id is still answerable.
    settle_expired(&app);

    // CLAIM FIRST, ASK QUESTIONS SECOND. The old order was read the row, then
    // claim, then write — and every step between the read and the write was a
    // window. Two resolves could both read `pending`; A won `take_pending` and
    // started an op that takes seconds, B got `None`, fell into the
    // expired-or-restarted branch, wrote `rejected` over the rows A was using,
    // and told the user "Nothing was run; ask again" while the mailbox change
    // was in flight. The final status depended on which write landed last, so a
    // call that completed could be recorded as rejected. `approval_resolve` is
    // `#[tauri::command(async)]`, so two webview invocations really are two
    // threads. `take_pending` is the single-winner primitive; making it the
    // FIRST step is the fix, and the compare-and-set below is the second line.
    let Some(pending) = take_pending(&approval_id) else {
        return Err(unclaimable(&app, &approval_id));
    };

    if !approved {
        if !audit::settle_approval(&app, &approval_id, false, "user")? {
            return Err(format!(
                "approval {approval_id} had already been answered elsewhere; nothing was run"
            ));
        }
        audit::record_rejected(&app, &pending.tool_call_id);
        return Ok(json!({
            "approval_id": approval_id,
            "tool_call_id": pending.tool_call_id,
            "op": pending.op.name,
            "status": "rejected",
            "executed": false,
            "result": Value::Null,
            "error": Value::Null,
        }));
    }

    // Compare-and-set. Losing it means somebody else already answered this card
    // in the database — the frontend writing the row directly, a second window,
    // or the expiry sweep — and the only safe answer is to run nothing. We hold
    // the only executable payload, so refusing here means it is now gone and
    // the action genuinely did not happen, which is what we then say.
    if !audit::settle_approval(&app, &approval_id, true, "user")? {
        return Err(format!(
            "approval {approval_id} had already been answered elsewhere; nothing was run"
        ));
    }
    // Keeps the pre-dispatch-audit rule true on this path too: the row says
    // `running` before anything runs, so a crash mid-op leaves evidence.
    if let Err(e) = audit::record_resumed(&app, &pending.tool_call_id) {
        return Err(format!("refusing to run {}: audit write failed: {e}", pending.op.name));
    }

    let ctx = Ctx {
        user_id: pending.user_id.clone(),
        user_token: pending.user_token.clone(),
        // Interactive, whatever profile queued it. A human just answered, which
        // is the exact fact `Interactive` asserts — and the fact whose absence
        // sent the call here in the first place.
        profile: Profile::Interactive,
        // The approval id, so this execution's log line carries the same key
        // the queue's did — however long the card sat there. It is in neither
        // row: see `Ctx::request_id` for why the tie is a log line and not a
        // column.
        request_id: approval_id.clone(),
    };

    let outcome = run_op(&app, pending.op, &pending.args, &ctx);
    audit::finish(&app, &pending.tool_call_id, &outcome);
    log::info!(
        "[control] {} executed for request {} (tool_call {})",
        pending.op.name,
        ctx.request_id,
        pending.tool_call_id
    );

    Ok(match outcome {
        Ok(data) => json!({
            "approval_id": approval_id,
            "tool_call_id": pending.tool_call_id,
            "op": pending.op.name,
            "status": "completed",
            "executed": true,
            "result": data,
            "error": Value::Null,
        }),
        Err(message) => json!({
            "approval_id": approval_id,
            "tool_call_id": pending.tool_call_id,
            "op": pending.op.name,
            "status": "failed",
            "executed": true,
            "result": Value::Null,
            "error": message,
        }),
    })
}

/// Explain — and where appropriate settle — an approval whose payload this
/// caller did not get.
///
/// Reached only after `take_pending` returned `None`, which is the one thing
/// that makes the answer safe: this thread is definitively NOT the executor, so
/// nothing it writes here can contradict a call in flight. It reads the row
/// only now, to tell the four cases apart:
///   * no row at all — a wrong id;
///   * a row already settled — somebody answered it (possibly the resolver that
///     beat us to the payload a microsecond ago, which is the honest answer);
///   * a row still pending and NEWER than every live instance's start — another
///     running Atlas holds the payload and can still execute it. Touch nothing
///     and say where to answer it. This case only exists because Atlas.app and
///     Lighthouse.app share one atlas.db;
///   * a row still pending and older than that — the queueing process is gone,
///     so nothing can ever execute it. Settle it, with a compare-and-set so we
///     do not overwrite an answer that lands meanwhile.
fn unclaimable(app: &AppHandle, approval_id: &str) -> String {
    let row = match audit::load_approval(app, approval_id) {
        Ok(Some(row)) => row,
        Ok(None) => return format!("no such approval: {approval_id}"),
        Err(e) => return format!("could not read approval {approval_id}: {e}"),
    };

    let status = row["status"].as_str().unwrap_or("");
    if status != "pending" {
        return format!("approval {approval_id} was already {status}");
    }

    // STILL PENDING, BUT WE DO NOT HOLD THE PAYLOAD. There are two very
    // different reasons for that, and expiring the row is only right for one:
    //
    //   (a) a PREVIOUS launch queued it and died. The executable payload lived
    //       in that process's memory, so it is genuinely gone. Closing the row
    //       is the honest thing to do.
    //   (b) ANOTHER LIVE INSTANCE queued it and is holding the payload right
    //       now. Atlas.app and Lighthouse.app share one atlas.db, so this is
    //       ordinary once both are installed.
    //
    // The old code could not tell them apart and always expired. In case (b)
    // that DESTROYED a card the other app was still showing, and told the user
    // "it expired or the app restarted" — false on both counts, about an action
    // they had just tried to approve.
    //
    // `effective_sweep_cutoff` is the same primitive the startup sweep uses: it
    // pulls the cutoff back behind every instance that is alive right now, so a
    // row newer than it belongs to a live peer. Asking the question in one
    // place means the two paths cannot disagree about who owns a card.
    let cutoff = crate::instance::effective_sweep_cutoff(&audit::now_iso());
    let orphaned = audit::stale_ids(&json!([row.clone()]), &cutoff)
        .iter()
        .any(|id| id == approval_id);
    if !orphaned {
        // Touch NOTHING. The instance that owns it can still execute it, and
        // the sweep will close it if that instance later dies.
        return format!(
            "approval {approval_id} is being handled by another Atlas window — answer it there. \
             Nothing was run here."
        );
    }

    match audit::expire_approval(
        app,
        approval_id,
        "Atlas could no longer act on this request. Nothing was run.",
    ) {
        Ok(true) => {
            if let Some(tool_call_id) = row["tool_call_id"].as_str() {
                audit::record_rejected(app, tool_call_id);
            }
        }
        Ok(false) => {
            return format!("approval {approval_id} had already been answered elsewhere")
        }
        Err(e) => log::warn!("[control] could not expire approval {approval_id}: {e}"),
    }

    format!(
        "approval {approval_id} can no longer be acted on — it expired or the app \
         restarted since it was requested. Nothing was run; ask again."
    )
}

/// Strip any query string; the auth ladder matches on the path alone.
fn path_only(url: &str) -> &str {
    match url.find('?') {
        Some(i) => &url[..i],
        None => url,
    }
}

/// Case-insensitive header lookup (HTTP field names are case-insensitive).
fn header<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

/// Write a JSON response.
///
/// NOTE THE ABSENCE: no `Access-Control-Allow-*` header is ever emitted, on any
/// path, including errors. This deliberately diverges from the brain sidecar,
/// whose wildcard CORS is defensible because every request there carries a
/// bearer JWT the browser will not attach automatically. The control port has
/// no such second factor, so the only correct answer to a browser preflight is
/// silence — a page that cannot read the response cannot use the port.
fn respond(request: tiny_http::Request, status: u16, body: &str) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header is well-formed");
    let response = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header);
    // A dropped connection is the client's problem, not ours; log and move on
    // rather than taking the worker down.
    if let Err(e) = request.respond(response) {
        log::debug!("[control] respond failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_only_strips_query() {
        assert_eq!(path_only("/v1/invoke"), "/v1/invoke");
        assert_eq!(path_only("/v1/invoke?x=1"), "/v1/invoke");
        assert_eq!(path_only("/v1/invoke?"), "/v1/invoke");
    }

    #[test]
    fn ok_envelope_shape() {
        let v = ControlResult::Ok(json!({"a": 1})).to_json();
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["data"]["a"], json!(1));
    }

    #[test]
    fn err_envelope_shape() {
        let v = ControlResult::Err {
            code: ErrCode::UnknownOp,
            message: "no such op: nope".into(),
        }
        .to_json();
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["error"]["code"], json!("unknown_op"));
        assert_eq!(v["error"]["message"], json!("no such op: nope"));
    }

    // --- profile defaulting ------------------------------------------------

    fn body(json_text: &str) -> InvokeBody {
        serde_json::from_str(json_text).expect("body should parse")
    }

    /// The conservative default, pinned. If this ever flips, a proactive cycle
    /// with a malformed body silently gains the ability to actuate.
    #[test]
    fn an_absent_profile_is_background() {
        assert_eq!(body(r#"{"op":"music.status"}"#).profile(), Profile::Background);
        assert_eq!(
            body(r#"{"op":"music.status","profile":null}"#).profile(),
            Profile::Background
        );
        assert_eq!(
            policy::decide(Tier::Actuate, body(r#"{"op":"x"}"#).profile()),
            policy::Decision::Queue(policy::ApprovalReason::BackgroundProfileDowngrade),
            "a body with no profile must not be able to actuate"
        );
    }

    #[test]
    fn an_explicit_profile_is_honoured() {
        assert_eq!(
            body(r#"{"op":"x","profile":"interactive"}"#).profile(),
            Profile::Interactive
        );
        assert_eq!(
            body(r#"{"op":"x","profile":"background"}"#).profile(),
            Profile::Background
        );
    }

    /// An unrecognised profile must fail the whole parse (a 400), not fall back
    /// to a value. "Interactive" is one typo away from being the permissive
    /// answer to a request nobody validated.
    #[test]
    fn an_unknown_profile_is_a_parse_error() {
        for text in [
            r#"{"op":"x","profile":"Interactive"}"#,
            r#"{"op":"x","profile":"INTERACTIVE"}"#,
            r#"{"op":"x","profile":"admin"}"#,
            r#"{"op":"x","profile":true}"#,
            r#"{"op":"x","profile":1}"#,
        ] {
            assert!(
                serde_json::from_str::<InvokeBody>(text).is_err(),
                "{text} should not have parsed"
            );
        }
    }

    // --- rate-limit wire form ----------------------------------------------

    /// A throttle must not be mistakable for an auth rejection or for an op
    /// that ran and failed — the caller's correct response differs in all three.
    ///
    /// The rejection side is compared against `auth::Reject::Forbidden`, which
    /// is what actually goes on the wire. It used to be compared against
    /// `ErrCode::Forbidden`, a variant nothing outside this test constructed —
    /// so the test could have passed while the REAL 403 collided with the
    /// throttle.
    #[test]
    fn rate_limited_is_distinguishable_from_forbidden_and_op_failure() {
        let throttled = ControlResult::Err {
            code: ErrCode::RateLimited,
            message: "rate limit exceeded for tier 'actuate' (10/min); retry_after_ms=4200".into(),
        };
        assert_eq!(throttled.status(), 429);
        assert_eq!(throttled.to_json()["error"]["code"], json!("rate_limited"));

        let (forbidden_status, forbidden_body) = auth::Reject::Forbidden.render();
        let failed = ControlResult::Err {
            code: ErrCode::OpFailed,
            message: "spotify said no".into(),
        };
        assert_ne!(throttled.status(), forbidden_status);
        assert_ne!(throttled.status(), failed.status());
        assert!(
            !forbidden_body.contains("rate_limited"),
            "the auth ladder's body and the throttle share a code: {forbidden_body}"
        );
    }

    /// The 403 and 413 bodies are hand-written constants in auth.rs; every
    /// other error body is generated here. The brain parses both with ONE
    /// parser (services/atlas-brain/src/control.ts reads `ok`, then
    /// `error.code`, then maps that code), and since `ErrCode` stopped carrying
    /// `forbidden`/`too_large` there is no shared Rust type left to make the
    /// two agree by construction. This is what agrees them instead.
    ///
    /// It asserts nothing about WHICH rung produced a 403 — auth.rs owns that
    /// property and the sameness is deliberate.
    #[test]
    fn the_auth_ladders_bodies_are_the_envelope_the_brain_parses() {
        let generated = ControlResult::Err {
            code: ErrCode::Internal,
            message: "x".into(),
        }
        .to_json();

        for (reject, expect_status, expect_code) in [
            (auth::Reject::Forbidden, 403u16, "forbidden"),
            (auth::Reject::TooLarge, 413, "too_large"),
        ] {
            let (status, body) = reject.render();
            assert_eq!(status, expect_status, "{body}");
            let parsed: Value =
                serde_json::from_str(body).unwrap_or_else(|e| panic!("{body} is not JSON: {e}"));
            assert_eq!(parsed["ok"], json!(false), "{body}");
            assert_eq!(parsed["error"]["code"], json!(expect_code), "{body}");
            // An empty message sends the brain to a synthetic one, which is a
            // worse answer than the honest short string.
            assert!(
                parsed["error"]["message"]
                    .as_str()
                    .is_some_and(|m| !m.is_empty()),
                "{body}"
            );
            assert_eq!(
                parsed.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                generated.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                "the ladder's body no longer has the shape the dispatcher emits: {body}"
            );
        }
    }

    /// The backoff has to be machine-readable: the brain retries on it.
    #[test]
    fn the_rate_limit_message_carries_a_parseable_backoff() {
        let message = format!(
            "rate limit exceeded for tier '{}' ({}/min); retry_after_ms={}",
            Tier::Actuate.as_str(),
            policy::limit_for(Tier::Actuate),
            4200
        );
        let parsed: u64 = message
            .split("retry_after_ms=")
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("retry_after_ms should be parseable out of the message");
        assert_eq!(parsed, 4200);
    }

    /// Every code the DISPATCHER can emit. `forbidden` and `too_large` are not
    /// in the list because they are not in the enum — they are auth.rs's
    /// constants, checked against these by the test above.
    #[test]
    fn every_err_code_has_a_distinct_wire_string() {
        let codes = [
            ErrCode::BadRequest,
            ErrCode::UnknownOp,
            ErrCode::RateLimited,
            ErrCode::OpFailed,
            ErrCode::Internal,
        ];
        for (i, code) in codes.iter().enumerate() {
            for other in codes.iter().take(i) {
                assert_ne!(code.as_str(), other.as_str(), "{code:?} collides with {other:?}");
            }
        }
    }

    // --- the pending queue -------------------------------------------------

    fn test_op() -> &'static Op {
        static OP: Op = Op {
            name: "test.pending",
            tier: Tier::Actuate,
            timeout_ms: 1_000,
            summary: "an op that exists only inside this module's tests",
            summary_keys: Some(&["id"]),
            run: |_app, _args, _ctx| Ok(Value::Null),
        };
        &OP
    }

    fn pending(id: &str, ttl_ms: u64) -> Pending {
        Pending {
            approval_id: id.to_string(),
            tool_call_id: format!("tc-{id}"),
            op: test_op(),
            args: json!({}),
            user_id: "u1".into(),
            user_token: None,
            expires_at_ms: policy::monotonic_ms().saturating_add(ttl_ms),
        }
    }

    /// Taking the entry out is what makes a double-yes a no-op: only one
    /// resolver can ever get the payload, so an approved action runs once.
    #[test]
    fn a_pending_entry_can_only_be_taken_once() {
        let id = format!("once-{}", uuid::Uuid::new_v4());
        push_pending(pending(&id, 60_000)).expect("queue has room");
        assert!(take_pending(&id).is_some());
        assert!(take_pending(&id).is_none(), "a second resolve got the payload too");
    }

    #[test]
    fn an_expired_entry_is_unreachable() {
        let id = format!("expired-{}", uuid::Uuid::new_v4());
        // Already past its window when it goes in.
        push_pending(pending(&id, 0)).expect("queue has room");
        assert!(
            take_pending(&id).is_none(),
            "an expired approval must not be executable"
        );
    }

    #[test]
    fn the_queue_has_a_ceiling_and_drains_itself() {
        let tag = uuid::Uuid::new_v4().to_string();
        // Fill it with entries that are already expired, then confirm a fresh
        // push still succeeds — the prune on every touch is what keeps an
        // abandoned queue from wedging the tier permanently.
        for i in 0..MAX_PENDING {
            let _ = push_pending(pending(&format!("stale-{tag}-{i}"), 0));
        }
        let id = format!("fresh-{tag}");
        push_pending(pending(&id, 60_000)).expect("stale entries should have been pruned");
        assert!(take_pending(&id).is_some());
    }

    /// Dropping the payload used to be the END of an expired approval's story:
    /// its `approvals` row stayed `pending` and `useApprovals` — which counts
    /// `status === 'pending'` and never reads `expires_at` — kept showing the
    /// user a card and a badge for something that could no longer run. The
    /// pruned ids now land here for the next caller with an `AppHandle` to
    /// settle. (`settle_expired` itself needs a live database, so what is
    /// pinned is the handoff, which is the part that was missing entirely.)
    #[test]
    fn an_expired_entry_is_handed_over_for_its_rows_to_be_closed() {
        let id = format!("expiry-{}", uuid::Uuid::new_v4());
        push_pending(pending(&id, 0)).expect("queue has room");
        // Any touch of the queue prunes; this is the cheapest one.
        let _ = pending_is_full();
        let queued: Vec<String> = lock_expired()
            .iter()
            .map(|e| e.approval_id.clone())
            .collect();
        assert!(
            queued.contains(&id),
            "an expired approval left no instruction to close its database rows"
        );
        // And it carries the tool_call id, or the audit row could not be closed
        // even by a caller that has a handle.
        let entry_has_call_id = lock_expired()
            .iter()
            .any(|e| e.approval_id == id && e.tool_call_id == format!("tc-{id}"));
        assert!(entry_has_call_id);
    }

    // --- panic containment -------------------------------------------------

    /// Before this existed, a panic from an op unwound through `handle`, ended
    /// the worker's `while let Ok(request) = server.recv()` loop and killed a
    /// quarter of the pool permanently. Four of those and the port accepted
    /// connections and answered nothing, forever.
    #[test]
    fn a_panic_becomes_an_error_instead_of_unwinding_past_the_worker() {
        let boom = catch("test.boom", || -> u8 { panic!("mutex poisoned") });
        let message = boom.expect_err("a panic must not propagate out of catch");
        assert!(message.contains("test.boom"), "{message}");
        assert!(message.contains("mutex poisoned"), "{message}");

        // A String payload (the `panic!("{x}")` form) reads back too.
        let owned = catch("test.boom", || -> u8 {
            panic!("{}", String::from("poisoned by a formatted message"))
        });
        assert!(owned.unwrap_err().contains("formatted message"));

        // And a non-string payload does not itself panic on the way out.
        let odd = catch("test.boom", || -> u8 { std::panic::panic_any(7u32) });
        assert!(odd.unwrap_err().contains("non-string payload"));

        // The happy path is untouched.
        assert_eq!(catch("test.fine", || 1 + 1), Ok(2));
    }

    /// The containment above is only worth anything if every runner invocation
    /// goes through it. A text scan, because a unit test cannot build an
    /// `AppHandle` to call a runner with — so what is checked is the property a
    /// reviewer would check by eye, and it fails when somebody reintroduces a
    /// direct call.
    #[test]
    fn no_op_runner_is_invoked_outside_the_panic_guard() {
        // Assembled so this literal does not itself match the scan.
        let call = concat!(".run", ")(");
        let source = include_str!("mod.rs");
        let direct = source.matches(call).count();
        assert_eq!(
            direct, 1,
            "an op runner is invoked in {direct} places; exactly one (inside `run_op`) may \
             call it directly, everything else must go through `run_op` so a panicking \
             runner cannot kill a worker or strand its audit row in `running`"
        );
        assert!(
            body_of(source, "fn run_op").contains(call),
            "the one direct invocation moved out of run_op"
        );
    }

    // --- approval resolution ordering --------------------------------------

    /// The body of a top-level `fn`, from its signature to the first
    /// column-zero closing brace.
    fn body_of<'a>(source: &'a str, signature: &str) -> &'a str {
        let start = source
            .find(signature)
            .unwrap_or_else(|| panic!("{signature} not found in the source"));
        let rest = &source[start..];
        let end = rest.find("\n}\n").unwrap_or(rest.len());
        &rest[..end]
    }

    /// FINDING: `approval_resolve` claimed non-atomically. It read the row,
    /// then claimed the payload, then wrote the settlement — so two concurrent
    /// resolves could both see `pending`, the loser could write `rejected` and
    /// return "Nothing was run; ask again" over an op the winner had already
    /// started, and the recorded status came down to which write landed last.
    ///
    /// The fix is an ORDER, which is why this test reads the order. There is no
    /// `AppHandle` in a unit test, so the alternative was no test at all.
    #[test]
    fn the_payload_is_claimed_before_anything_is_read_or_written() {
        let body = body_of(include_str!("mod.rs"), "pub fn approval_resolve");
        let claim = body
            .find("take_pending(")
            .expect("approval_resolve must claim the payload");
        for later in ["load_approval(", "settle_approval(", "record_rejected("] {
            if let Some(at) = body.find(later) {
                assert!(
                    claim < at,
                    "`{later}` runs before take_pending: a resolver that has NOT claimed the \
                     payload can write over the rows the resolver that did is using"
                );
            }
        }
        // And the read that decides which failure message to give happens only
        // on the branch that lost the claim.
        assert!(
            body_of(include_str!("mod.rs"), "fn unclaimable").contains("load_approval("),
            "the row read belongs on the lost-claim branch"
        );
    }

    /// A card another LIVE Atlas is holding must never be expired from here.
    ///
    /// Atlas.app and Lighthouse.app share one atlas.db, so `take_pending`
    /// missing no longer implies the payload is gone — it may simply live in
    /// the other app's memory. `unclaimable` used to expire the row anyway,
    /// which destroyed a card the other window was still showing and told the
    /// user "it expired or the app restarted": false on both counts, about an
    /// action they had just tried to approve.
    ///
    /// A source-ordering assertion rather than a behavioural one, deliberately:
    /// reproducing this needs two processes sharing a database, and the defect
    /// is entirely one of ORDER — the liveness question has to be asked, and
    /// answered with a return, before anything settles a row.
    #[test]
    fn a_card_held_by_a_live_instance_is_never_expired_here() {
        let body = body_of(include_str!("mod.rs"), "fn unclaimable");

        let cutoff = body
            .find("effective_sweep_cutoff")
            .expect("unclaimable must ask which instances are live before settling anything");
        let expire = body
            .find("audit::expire_approval(")
            .expect("unclaimable still has to close genuinely orphaned rows");
        assert!(
            cutoff < expire,
            "the liveness check must come BEFORE expire_approval — after it, the other \
             instance's card is already destroyed"
        );

        // And the not-orphaned branch must LEAVE, not fall through. A check
        // whose answer is ignored is the same defect wearing a condition.
        let guard = body
            .find("if !orphaned")
            .expect("the live-peer case needs its own branch");
        assert!(
            guard < expire && body[guard..expire].contains("return"),
            "the live-peer branch must return before reaching expire_approval"
        );
    }

    /// The settle must be a compare-and-set, and its answer must be checked.
    /// A settle that ignores its result is the same defect wearing a return
    /// value.
    #[test]
    fn every_settle_checks_whether_it_won_the_claim() {
        let body = body_of(include_str!("mod.rs"), "pub fn approval_resolve");
        for line in body.lines() {
            let trimmed = line.trim_start();
            if !trimmed.contains("audit::settle_approval(") {
                continue;
            }
            assert!(
                trimmed.starts_with("if !audit::settle_approval("),
                "`{trimmed}` ignores whether it won the compare-and-set"
            );
        }
    }

    /// The card must be able to NAME its object before any row exists.
    ///
    /// FINDING: the card for the only two queueable ops was
    /// `approval mail.archive with thread_id="9f2c…"` — a local uuid no screen
    /// shows, chosen by a model whose context is full of mail written by
    /// strangers. So `queue_for_approval` now resolves the object against the
    /// local mirror and refuses the queue when the id names nothing.
    ///
    /// A source-structure test, because a unit test cannot build an `AppHandle`
    /// and every branch here needs one. What it pins is the ORDER — resolve
    /// before writing — and the refusal, which are the two things that make the
    /// fix a fix rather than an extra sentence on the card.
    #[test]
    fn a_card_that_cannot_name_its_object_is_never_queued() {
        let body = body_of(include_str!("mod.rs"), "fn queue_for_approval");
        let resolve = body
            .find("registry::card_target(")
            .expect("queue_for_approval must resolve the object it is asking about");
        let write = body
            .find("audit::queue(")
            .expect("queue_for_approval must write the rows");
        assert!(
            resolve < write,
            "the object is resolved AFTER the rows are written, so a card naming nothing \
             would already exist by the time anyone noticed"
        );
        // Each failing arm must refuse INSIDE ITS OWN ARM. Scanning from the arm
        // to `audit::queue` would have accepted a refusal that belongs to the
        // other arm — it did, on the first attempt at this test: deleting the
        // `Missing` refusal left it green because `Unreadable`'s `return` sat in
        // the scanned span.
        for arm in ["CardTarget::Missing", "CardTarget::Unreadable"] {
            let at = body
                .find(arm)
                .unwrap_or_else(|| panic!("{arm} must be handled explicitly"));
            assert!(
                at < write,
                "{arm} is handled after the rows are written, so a card for an object nobody \
                 could describe already exists — and a human then approves it"
            );
            // Up to the next arm, so the span is this arm's body alone.
            let end = body[at + arm.len()..]
                .find("CardTarget::")
                .map(|i| at + arm.len() + i)
                .unwrap_or(write);
            assert!(
                body[at..end].contains("return ControlResult::Err"),
                "{arm} does not refuse the queue, so a card that cannot say what it would do \
                 gets raised anyway"
            );
        }
    }

    // --- expiry has a clock of its own -------------------------------------

    /// FINDING: expiry could not reach the database on an idle app. Everything
    /// that pruned the queue or settled its rows needed a caller — a queue, a
    /// resolve, or a restart — so an ignored card sat past its TTL with its
    /// `approvals` row still `pending` and the badge still lit, which is the exact
    /// symptom the expiry work was supposed to remove.
    ///
    /// This half is a real behavioural test: `sweep_pending` takes no
    /// `AppHandle`, which is what makes a timer able to call it, and it must hand
    /// the aged-out entry over on its own.
    #[test]
    fn the_queue_drains_without_anybody_touching_it() {
        let id = format!("sweep-{}", uuid::Uuid::new_v4());
        push_pending(pending(&id, 0)).expect("queue has room");
        // No queue_for_approval, no approval_resolve, no take_pending: exactly
        // what an idle app does.
        sweep_pending();
        let handed_over = lock_expired().iter().any(|e| e.approval_id == id);
        assert!(
            handed_over,
            "an expired card was not handed over for its rows to be closed, so the badge \
             stays lit until the next restart"
        );
    }

    /// And the sweep must actually be wired to a clock. Structural, because
    /// `start` binds a socket and needs an `AppHandle`.
    #[test]
    fn a_thread_calls_the_sweep_on_a_timer() {
        let body = body_of(include_str!("mod.rs"), "pub fn start(");
        assert!(
            body.contains("atlas-control-expiry"),
            "nothing spawns the expiry sweeper, so expiry is back to needing a caller"
        );
        let spawn = body.find("atlas-control-expiry").expect("checked above");
        let tail = &body[spawn..];
        assert!(tail.contains("sweep_pending()"), "the sweeper does not prune the queue");
        assert!(
            tail.contains("settle_expired(&app)"),
            "the sweeper prunes memory but never closes the database rows, which is the \
             half the user can see"
        );
    }

    // --- the approvals card's declared fields ------------------------------

    /// `summary_keys: None` is the fail-closed default, and it only means
    /// anything if an op that can actually reach the queue is forbidden to keep
    /// it. Approval tier queues on every profile; Actuate queues on the
    /// background one.
    #[test]
    fn queueable_ops_declare_a_card() {
        for op in registry::OPS {
            let queueable = [Profile::Interactive, Profile::Background]
                .into_iter()
                .any(|profile| !policy::decide(op.tier, profile).executes_now());
            if !queueable {
                continue;
            }
            assert!(
                op.summary_keys.is_some(),
                "{} can be queued for approval but declares no summary_keys, so the card a \
                 user consents to would have no fields — queue_for_approval refuses it at \
                 runtime, which means this op is simply unusable",
                op.name
            );
        }
    }

    /// Each declared card field is usable on its own terms, and no field is
    /// listed twice.
    ///
    /// RENAMED FROM `a_declared_card_names_its_identifying_field_first`, which is
    /// what it never checked: the body reads `keys` as a set, never `keys[0]` and
    /// never an index, so reordering `mail.archive`'s card to
    /// `["filler", "thread_id"]` left it green while spending
    /// `audit::action_summary`'s "position 0 survives truncation" guarantee on a
    /// field that identifies nothing. A test whose name states a property it does
    /// not test is worse than no test, because the next reader stops looking.
    ///
    /// The positional guarantee IS pinned — by `registry::tests::
    /// every_declared_card_is_the_one_a_human_reviewed`, which compares each
    /// op's `summary_keys` to `EXPECTED_CARDS` with `assert_eq!` on the slice, so
    /// the order is fixed per op by a hand review. Re-deriving that here would be
    /// a second copy of the same list, which is the thing that drifts.
    #[test]
    fn a_declared_card_field_is_usable_and_not_repeated() {
        for op in registry::OPS {
            let Some(keys) = op.summary_keys else { continue };
            assert!(
                keys.len() <= 6,
                "{} declares {} card fields; a card is one line a person reads before \
                 clicking, not a form",
                op.name,
                keys.len()
            );
            for key in keys {
                assert!(
                    !key.is_empty() && key.len() <= 40,
                    "{} declares an unusable card field {key:?}",
                    op.name
                );
            }
            let mut seen = std::collections::BTreeSet::new();
            for key in keys {
                assert!(
                    seen.insert(*key),
                    "{} declares {key:?} twice, so the card would render it twice",
                    op.name
                );
            }
        }
    }

    // --- the correlation key -----------------------------------------------

    /// The caller picks this string and it is written into a log line, so it
    /// gets the card's treatment: a newline in it would forge a second line in
    /// the one place a reader reconstructs what the port did.
    #[test]
    fn a_caller_supplied_request_id_cannot_forge_a_log_line() {
        let hostile = "r1\n[control] mail.send executed for request r2";
        let cleaned = request_id(Some(hostile));
        assert!(!cleaned.contains('\n'), "{cleaned}");
        assert!(!cleaned.contains('\u{2028}'), "{cleaned}");
        assert!(cleaned.chars().count() <= REQUEST_ID_MAX, "{cleaned}");

        assert!(request_id(Some(&"a".repeat(500))).chars().count() <= REQUEST_ID_MAX);

        // An ordinary id passes through untouched — the cleaning must not make
        // the brain's key and ours differ.
        assert_eq!(request_id(Some("req-42")), "req-42");
    }

    /// Never empty, whatever the caller sent. An empty key would file unrelated
    /// calls under the same non-value in whatever reads the log.
    #[test]
    fn an_absent_or_blank_request_id_still_yields_a_usable_key() {
        assert!(!request_id(None).is_empty());
        assert!(!request_id(Some("")).is_empty());
        assert!(!request_id(Some("   ")).is_empty());
        assert_ne!(
            request_id(None),
            request_id(None),
            "two calls with no id must not be given the same key"
        );
    }

    /// FINDING: `request_id` was parsed off every request and threaded into
    /// every op while being read NOWHERE. Neither audit table has a column for
    /// it, so the log is the only place it can tie a brain request to the rows
    /// that request produced.
    ///
    /// A source scan, because asserting on log output means installing a logger
    /// for the whole test binary; what is pinned is that the two paths which
    /// write rows still name the key, which is the part that regressed.
    #[test]
    fn the_row_writing_paths_log_their_request_id() {
        for f in ["fn execute", "fn queue_for_approval"] {
            assert!(
                body_of(include_str!("mod.rs"), f).contains("ctx.request_id"),
                "{f} writes an audit row without recording which request produced it — \
                 that is exactly what made request_id dead plumbing the first time"
            );
        }
    }
}
