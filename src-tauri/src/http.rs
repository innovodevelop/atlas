// One shared, TIMED HTTP agent for every outbound call from the Rust core.
//
// Why this exists: every call site used bare `ureq::get(...)`, which has no
// connect or read deadline. A slow or black-holed endpoint therefore parked the
// calling thread indefinitely — and because Tauri runs a *synchronous* command
// on the main thread, that thread was the UI. The app painted half a frame and
// then stopped answering anything, including AppleScript and the Web Inspector.
//
// Timeouts alone are not the whole fix (commands must also be `async` so they
// leave the main thread), but they are the half that bounds the damage: nothing
// here can now hang longer than TIMEOUT_TOTAL.
//
// A `ureq::Agent` is an Arc internally — cloning is cheap and it is Send + Sync,
// so one process-wide instance is correct and gives us connection reuse.

use std::sync::OnceLock;
use std::time::Duration;

/// Refuse to wait forever on a TCP handshake (dead host, captive portal).
const TIMEOUT_CONNECT: Duration = Duration::from_secs(5);
/// A responsive API answers well inside this; a slow one must not stall a screen.
const TIMEOUT_READ: Duration = Duration::from_secs(15);
/// Hard ceiling per request, whatever the individual phases do.
const TIMEOUT_TOTAL: Duration = Duration::from_secs(20);

static AGENT: OnceLock<ureq::Agent> = OnceLock::new();

/// The shared agent. Use this instead of `ureq::get` / `ureq::post` / `ureq::request`.
pub fn agent() -> ureq::Agent {
    AGENT
        .get_or_init(|| {
            ureq::AgentBuilder::new()
                .timeout_connect(TIMEOUT_CONNECT)
                .timeout_read(TIMEOUT_READ)
                .timeout_write(TIMEOUT_READ)
                .timeout(TIMEOUT_TOTAL)
                .build()
        })
        .clone()
}
