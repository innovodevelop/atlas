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
// SCOPE OF THIS MILESTONE: READ-ONLY.
// The registry (control/registry.rs) exposes exactly three data-fetch reads.
// There is no write path, no actuation, no approval flow, and no state
// mutation of any kind here. Those tiers land in later commits; the `Tier`
// enum below exists so the dispatcher already carries the label, not because
// anything currently honours it.

pub mod auth;
pub mod registry;

use std::io::Read;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

/// Fixed worker count. This IS the concurrency cap for the whole control
/// surface: a slow op occupies one worker and the other three keep serving.
/// A bounded pool (rather than thread-per-request) means a misbehaving caller
/// cannot spawn unbounded threads inside the app process.
const WORKERS: usize = 4;

/// A live control port. `token` is the per-launch bearer secret.
pub struct ControlPort {
    pub port: u16,
    pub token: String,
}

// ---------------------------------------------------------------------------
// Types the dispatcher and later tiers build on
// ---------------------------------------------------------------------------

/// Escalating capability classes. Only `Read` is reachable today — nothing in
/// registry.rs declares anything else, and there is no gate that treats the
/// other variants differently yet. They exist so a later commit adds policy in
/// one place instead of re-labelling every op.
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
/// scheduler, where no prompt can ever be answered. Later tiers will refuse
/// approval-requiring ops under `Background` for exactly that reason.
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
    pub request_id: String,
}

/// One exposed operation. `run` is a plain fn pointer so `OPS` can be a
/// `static` with no lazy initialisation and no allocation at startup.
pub struct Op {
    pub name: &'static str,
    pub tier: Tier,
    /// Declared time budget, surfaced in /v1/capabilities so the brain can
    /// plan around it. NOT ENFORCED BY THIS MILESTONE — the dispatcher runs
    /// ops inline on the worker thread. The three registered ops are bounded
    /// in practice by the shared ureq agent's 20s hard ceiling (src/http.rs);
    /// a real per-op kill lands with the write tier.
    pub timeout_ms: u64,
    pub summary: &'static str,
    pub run: fn(&AppHandle, &Value, &Ctx) -> Result<Value, String>,
}

/// Machine-readable failure classes. The wire form is the snake_case string;
/// the brain branches on it rather than on message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrCode {
    /// Auth ladder rejection. Deliberately undifferentiated — see auth.rs.
    Forbidden,
    TooLarge,
    BadRequest,
    UnknownOp,
    /// The op ran and failed. The message is the op's own error, verbatim:
    /// Atlas reports what actually went wrong instead of inventing a result.
    OpFailed,
    Internal,
}

impl ErrCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrCode::Forbidden => "forbidden",
            ErrCode::TooLarge => "too_large",
            ErrCode::BadRequest => "bad_request",
            ErrCode::UnknownOp => "unknown_op",
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
    /// transport/auth problems keeps those two classes distinguishable.
    pub fn status(&self) -> u16 {
        match self {
            ControlResult::Ok(_) => 200,
            ControlResult::Err { code, .. } => match code {
                ErrCode::BadRequest | ErrCode::UnknownOp => 400,
                ErrCode::TooLarge => 413,
                ErrCode::Forbidden => 403,
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
            })
            .map_err(|e| format!("control port worker spawn failed: {e}"))?;
    }

    Ok(ControlPort { port, token })
}

/// Serve one request. Never panics out of the worker: any op error becomes an
/// error envelope so a bad op cannot silently kill a quarter of the pool.
fn handle(app: &AppHandle, mut request: tiny_http::Request, token: &str, expected_host: &str) {
    let head = auth::RequestHead {
        method: request.method().as_str(),
        path: path_only(request.url()),
        origin: header(&request, "origin"),
        host: header(&request, "host"),
        authorization: header(&request, "authorization"),
        // `body_length()` is None for chunked bodies; the read below is capped
        // regardless, so an unknown length is treated as 0 here and caught there.
        content_length: request.body_length().unwrap_or(0),
    };

    let route = match auth::inspect(&head, expected_host, token) {
        Ok(route) => route,
        Err(reject) => {
            let (status, body) = reject.render();
            respond(request, status, body);
            return;
        }
    };

    let result = match route {
        auth::Route::Capabilities => ControlResult::Ok(registry::capabilities()),
        auth::Route::Invoke => {
            let mut buf = Vec::new();
            // Second-line cap: a chunked body reports no length, so bound the
            // read itself. One extra byte lets us tell "exactly at the limit"
            // from "over it".
            let over = request
                .as_reader()
                .take(auth::MAX_BODY as u64 + 1)
                .read_to_end(&mut buf)
                .map(|_| buf.len() > auth::MAX_BODY)
                .unwrap_or(true);
            if over {
                let (status, body) = auth::Reject::TooLarge.render();
                respond(request, status, body);
                return;
            }
            invoke(app, &buf)
        }
    };

    let status = result.status();
    let body = result.to_json().to_string();
    respond(request, status, &body);
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
        user_id: parsed.user_id.unwrap_or_default(),
        user_token: parsed.user_token,
        // Absent profile is treated as Background: the conservative default is
        // the one that cannot assume a human is available to answer anything.
        profile: parsed.profile.unwrap_or(Profile::Background),
        request_id: parsed
            .request_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
    };

    match (op.run)(app, &parsed.args, &ctx) {
        Ok(data) => ControlResult::Ok(data),
        // The op's own message, unaltered. A truthful failure is the product
        // requirement here — never substitute a plausible-looking result.
        Err(message) => ControlResult::Err {
            code: ErrCode::OpFailed,
            message,
        },
    }
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
}
