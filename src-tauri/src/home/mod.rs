// Smart home — the backend behind src/pages/atlas/AtlasSmartHome.tsx.
//
// WHAT THIS MODULE IS FOR
// The page and its three components under src/components/atlas-ui/smartHome/
// are bound to the types in `src/lib/mocks/smartHome.ts`. That file is the
// CONTRACT, not a suggestion: `SmartHomeState` names a snapshot, a loading
// flag, an error and five commands, and a real adapter that renamed one field
// would be a redesign wearing a backend's clothes. So everything here exists to
// produce that snapshot from things a bridge actually said.
//
// THE SHAPE
//   HomeAdapter        one trait, two implementations
//   ha.rs              Home Assistant over REST + WebSocket on the LAN
//   companion.rs       HomeKit, spoken directly to the accessory over the LAN
//   hap/               the HomeKit Accessory Protocol itself — LIGHTHOUSE ONLY
//   store.rs           the local SQLite mirror and the snapshot projection
//   ws.rs              a hand-written RFC 6455 client for HA's push channel
//   keys.rs            the "atlas-homekit" Keychain item
//
// THE HOMEKIT PATH IS BEHIND A CARGO FEATURE, AND THAT IS STRUCTURAL.
// `hap` is declared `#[cfg(feature = "homekit")]` below, and every command in
// this file that reaches it carries the same attribute. The gate is a cargo
// feature rather than the existing Vite edition split because the control port
// (src/control) is a REGISTRY, not a webview: whatever is registered is
// reachable by the model in both editions, whichever React screens shipped. A
// frontend gate would leave a working HomeKit controller inside Atlas.app with
// an op the brain could call. `registry.rs` holds the test that fails if a HAP
// op or command becomes reachable without the feature, and the test at the
// bottom of THIS file holds the other half: a `#[tauri::command]` here that
// touches the HAP module must carry the cfg.
//
// ADR 008 IS UNTOUCHED BY ALL OF THAT. It is about Apple's HomeKit FRAMEWORK
// (HMHomeManager), which is Mac Catalyst only; speaking the accessory protocol
// ourselves is a different mechanism and references no framework symbol. See
// the header of `hap/mod.rs`.
//
// EVERY COMMAND IS `#[tauri::command(async)]`, INCLUDING THE SYNC-BODIED ONES.
// That attribute is what moves a command off the MAIN thread onto Tauri's
// worker pool; the body may stay synchronous (mail.rs does the same). These
// commands do LAN HTTP and SQLite work, and the incident write-up at the top of
// src/http.rs records what a blocking call on the main thread cost last time:
// the app painted half a frame and then answered nothing, including the Web
// Inspector. There is a test at the bottom of this file that refuses a command
// in this module that is not declared `async`.
//
// THE ONE SAFETY RULE, AND WHERE IT LIVES
// "Atlas can lock, but only you unlock" is the autonomy rule the design already
// states (smartHome.ts:419). It is enforced in RUST, by the control port's tier
// table — `home.lock_set` is `Tier::Approval`, which never auto-runs on either
// profile — and NOT by a sentence in a prompt or a row in a preferences table
// that a caller could flip. `home.device_set` refuses a lock outright so the
// Actuate tier cannot be used as a way around it. `autonomy()` below reports
// what is actually enforced, so the switches on the Setup screen cannot drift
// away from the code.

pub mod companion;
pub mod ha;
#[cfg(feature = "homekit")]
pub mod hap;
pub mod keys;
pub mod store;
pub mod ws;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DbState;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why a home operation did not happen.
///
/// The variants are distinct because the FIXES are distinct, and collapsing
/// them would leave the surface unable to tell the user which one to apply: a
/// rejected token needs a new token, an unreachable hub needs the hub switched
/// on. `Display` writes the sentence the user reads — no bridge body is ever
/// interpolated into it (see `ha::http_err`), so a hostile integration name
/// cannot reach the screen or the model.
#[derive(Debug)]
pub enum HomeError {
    /// The bridge answered and rejected our credential.
    Unauthorised(String),
    /// Nothing answered, or the answer was an error status.
    Unreachable(String),
    /// Something answered, but not as the protocol it claims to speak.
    Malformed(String),
    /// Atlas refused to make the call. Not a bridge failure — a rule.
    Refused(String),
    /// The local mirror could not be read or written.
    Store(String),
    /// This adapter cannot do anything on this platform yet (companion.rs).
    Unavailable(String),
}

impl std::fmt::Display for HomeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HomeError::Unauthorised(m)
            | HomeError::Unreachable(m)
            | HomeError::Malformed(m)
            | HomeError::Refused(m)
            | HomeError::Unavailable(m) => write!(f, "{m}"),
            HomeError::Store(m) => write!(f, "the local home store failed: {m}"),
        }
    }
}

impl From<HomeError> for String {
    fn from(e: HomeError) -> String {
        e.to_string()
    }
}

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeKind {
    HomeAssistant,
    HomekitCompanion,
}

impl BridgeKind {
    /// The value stored in `home_bridges.kind`. It is in a CHECK constraint, so
    /// these two strings are schema, not labels.
    pub fn as_str(self) -> &'static str {
        match self {
            BridgeKind::HomeAssistant => "home_assistant",
            BridgeKind::HomekitCompanion => "homekit_companion",
        }
    }

    /// Named `parse` rather than `from_str` on purpose: an inherent `from_str`
    /// shadows the `FromStr` trait everyone expects and clippy says so.
    pub fn parse(s: &str) -> Option<BridgeKind> {
        match s {
            "home_assistant" => Some(BridgeKind::HomeAssistant),
            "homekit_companion" => Some(BridgeKind::HomekitCompanion),
            _ => None,
        }
    }
}

/// What a probe learned about a bridge. `connected` is only ever true because a
/// request succeeded — there is no path that fills this in optimistically.
#[derive(Debug)]
pub struct BridgeInfo {
    pub kind: BridgeKind,
    pub name: String,
    pub detail: String,
    pub connected: bool,
}

#[derive(Debug)]
pub struct RoomPull {
    pub external_id: String,
    pub name: String,
}

/// One device as the bridge described it. Every optional field is optional
/// because the bridge may genuinely not have said — `value: None` means "no
/// reading", never "0".
#[derive(Debug)]
pub struct DevicePull {
    pub external_id: String,
    pub name: String,
    pub kind: String,
    pub control: String,
    pub room_external_id: Option<String>,
    pub value: Option<f64>,
    pub state: Option<String>,
    pub colour: Option<String>,
    pub available: bool,
    pub last_changed: Option<String>,
}

#[derive(Debug)]
pub struct ScenePull {
    pub external_id: String,
    pub label: String,
    /// True when Atlas cannot PROVE the scene contains no lock. See the column
    /// comment in db_schema.sql: unknown membership fails closed.
    pub touches_locks: bool,
}

#[derive(Debug)]
pub struct BridgePull {
    pub rooms: Vec<RoomPull>,
    pub devices: Vec<DevicePull>,
    pub scenes: Vec<ScenePull>,
}

/// The one interface every bridge implements.
///
/// Deliberately narrow. It carries no "discover", no "pair" and no "identify"
/// even though HAP now has all three (`hap/discovery.rs`, `companion::lan::pair`):
/// those belong to ONE adapter, and a trait method that only one implementor
/// can answer is how a fake scanning animation gets written for the other.
/// They live on the concrete adapter, where the honest answer is the only
/// answer available.
pub trait HomeAdapter {
    /// Cheapest call that proves both reachability and credentials. The kind of
    /// bridge is not on this trait: it is already on the `home_bridges` row the
    /// adapter was built from, and a second copy could disagree with it.
    fn probe(&self) -> Result<BridgeInfo, HomeError>;
    /// Everything the bridge knows, in one pass.
    fn pull(&self) -> Result<BridgePull, HomeError>;
    fn set_value(&self, external_id: &str, value: f64) -> Result<(), HomeError>;
    fn set_colour(&self, external_id: &str, colour: &str) -> Result<(), HomeError>;
    /// Separate from `set_value` because it is a different DECISION, not a
    /// different unit: this is the only method the Approval tier can reach.
    fn set_lock(&self, external_id: &str, locked: bool) -> Result<(), HomeError>;
    fn run_scene(&self, external_id: &str) -> Result<(), HomeError>;
}

// ---------------------------------------------------------------------------
// The lock domain
// ---------------------------------------------------------------------------

/// Device kinds Atlas treats as locks.
///
/// `garage` is in here and that is the whole reason this is a list rather than
/// an equality check: an open garage door is an open house, and Home Assistant
/// models it as a `cover` alongside blinds and curtains. `ha::kind_of` is what
/// separates them, using the entity's `device_class`.
pub const LOCK_KINDS: &[&str] = &["lock", "garage"];

pub fn is_lock_kind(kind: &str) -> bool {
    LOCK_KINDS.contains(&kind)
}

/// May the Actuate-tier `home_device_set` touch this device?
///
/// SPLIT OUT FROM THE COMMAND ON PURPOSE, the same way `ops_db::plan` is split
/// from `ops_db::fetch`: this is the whole safety decision, and a function that
/// also needs a live `AppHandle`, an open SQLite file and a Home Assistant on
/// the LAN cannot be unit-tested. Everything below is decided from three
/// strings, so `cargo test` proves it on every run with no app.
///
/// `name` is only in the signature so the refusal can name the thing it
/// refused; it takes no part in the decision.
pub fn device_set_allowed(kind: &str, control: &str, name: &str) -> Result<(), String> {
    if is_lock_kind(kind) {
        return Err(format!(
            "'{name}' is a {kind} — locks are never set this way. Use home_lock_set, which asks \
             you first."
        ));
    }
    if kind == "cover" {
        // A `cover` whose device_class this build has never seen. Home
        // Assistant puts garage doors, gates, front doors and blinds in one
        // domain, so an unrecognised member of that enum could be either, and
        // "probably a blind" is not a safe default for something that might be
        // a way into the house. Named separately from the `status` refusal
        // below because the reason is different and the user can act on it.
        return Err(format!(
            "'{name}' is a cover Atlas cannot identify — your bridge reports a type it does not \
             know, and it will not move something that might be a door. Move it from Home \
             Assistant."
        ));
    }
    if control == "status" {
        // The design draws these as a "No control · reports only" pill rather
        // than a disabled switch. A leak sensor has nothing to set, and calling
        // a service on it would report success for a command with no effect.
        return Err(format!("'{name}' reports only — there is nothing on it to set."));
    }
    Ok(())
}

/// May the Actuate-tier `home_scene_run` apply this scene?
///
/// `touches_locks` is TRUE both when Atlas saw a lock in the scene and when the
/// bridge never published its membership at all (db_schema.sql defaults the
/// column to 1). Those two must produce the same answer: a scene is a bundle of
/// commands an approvals card cannot enumerate, so "there is a lock in it" and
/// "Atlas cannot say what is in it" are equally not-consent.
pub fn scene_run_allowed(touches_locks: bool, label: &str) -> Result<(), String> {
    if touches_locks {
        return Err(format!(
            "'{label}' can change a lock, or Atlas cannot see what is in it. Run it from Home \
             Assistant yourself."
        ));
    }
    Ok(())
}

/// The autonomy rules, composed from what Rust ACTUALLY enforces.
///
/// The mock lists five rules; three of them ("shift appliances to off-peak",
/// "pause irrigation for weather", "grant guest access") describe machinery
/// Atlas does not have — no tariff calendar, no irrigation integration, no
/// guest-access concept. Shipping them as switches would be a promise the code
/// does not keep, so they are absent rather than present-and-inert. What is
/// here maps one-to-one onto the control-port tier table, and
/// `the_autonomy_card_matches_the_tiers_that_enforce_it` in registry.rs is the
/// test that keeps the two from drifting.
pub fn autonomy() -> Value {
    json!([
        {
            "id": "lights",
            "name": "Adjust lights, blinds and climate",
            "note": "Any time, without asking. Recorded in the activity log.",
            "allowed": true,
        },
        {
            "id": "scenes",
            "name": "Run a scene",
            "note": "Only a scene Atlas can prove contains no lock.",
            "allowed": true,
        },
        {
            "id": "lock",
            "name": "Lock doors",
            "note": "Asks you first, every time.",
            "allowed": false,
        },
        {
            "id": "unlock",
            "name": "Unlock doors",
            "note": "Never — Atlas can lock, but only you unlock.",
            "allowed": false,
        },
    ])
}

// ---------------------------------------------------------------------------
// Building an adapter for a linked bridge
// ---------------------------------------------------------------------------

/// The bridge Atlas would talk to, or a sentence saying why there is none.
///
/// The token is read HERE and nowhere else on the command path, so there is
/// exactly one place that touches the Keychain and exactly one place that could
/// leak it. It is moved into the adapter and never returned.
fn adapter_for(bridge: &store::BridgeRow) -> Result<Box<dyn HomeAdapter>, HomeError> {
    match bridge.kind {
        BridgeKind::HomeAssistant => {
            let base_url = bridge.base_url.as_deref().filter(|u| !u.is_empty()).ok_or_else(|| {
                HomeError::Refused(
                    "this Home Assistant bridge has no address stored. Link it again.".into(),
                )
            })?;
            let token = keys::ha_token().ok_or_else(|| {
                HomeError::Unauthorised(
                    "Atlas has no Home Assistant token in the Keychain. Link the bridge again."
                        .into(),
                )
            })?;
            Ok(Box::new(ha::HomeAssistant::new(base_url, &token)))
        }
        // The row carries everything the HomeKit adapter needs to find its
        // accessory; the Keychain half is read inside `for_bridge`, which is
        // the single place that touches it — same rule as the token above.
        BridgeKind::HomekitCompanion => Ok(Box::new(companion::Companion::for_bridge(bridge))),
    }
}

/// The one linked bridge Atlas can act through, if there is one.
///
/// HOME ASSISTANT FIRST WHEN BOTH EXIST, and that is an ordering rather than a
/// preference: a Home Assistant bridge sees the whole house, a HomeKit pairing
/// sees one accessory. This only decides which bridge a bridge-WIDE operation
/// (`home_sync`, the push channel) acts on; every per-device command resolves
/// the device's own bridge through `store::device_target` and is unaffected.
fn active_bridge(
    conn: &rusqlite::Connection,
    user_id: &str,
) -> Result<store::BridgeRow, HomeError> {
    if let Some(b) = store::bridge_of_kind(conn, user_id, BridgeKind::HomeAssistant)? {
        return Ok(b);
    }
    store::bridge_of_kind(conn, user_id, BridgeKind::HomekitCompanion)?.ok_or_else(|| {
        HomeError::Refused(
            "No home bridge is linked. Link Home Assistant on the Setup screen first.".into(),
        )
    })
}

/// One stored bridge, by its local id, whatever kind it is.
///
/// `store::bridge_of_kind` answers "the HA bridge" and "the HomeKit bridge"
/// separately; a sync is handed an id and must not have to guess which of the
/// two it was, because guessing wrong would build an adapter for the wrong
/// protocol and record the failure on the wrong row.
fn bridge_by_id(
    conn: &rusqlite::Connection,
    user_id: &str,
    bridge_id: &str,
) -> Result<store::BridgeRow, HomeError> {
    store::bridges(conn, user_id)?
        .into_iter()
        .find(|b| b.id == bridge_id)
        .ok_or_else(|| HomeError::Refused("that bridge is not linked to this account".into()))
}

/// Map an adapter failure onto the `home_bridges.state` value that records it,
/// so the Setup screen can say which of the two very different problems it was.
fn health_of(e: &HomeError) -> (&'static str, String) {
    match e {
        HomeError::Unauthorised(m) => ("unauthorised", m.clone()),
        HomeError::Unreachable(m) => ("unreachable", m.clone()),
        HomeError::Unavailable(m) => ("unavailable", m.clone()),
        other => ("unreachable", other.to_string()),
    }
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// The universal realtime signal. Every mutation in this module ends with one.
fn changed(app: &AppHandle, table: &str) {
    let _ = app.emit("db:changed", json!({ "table": table, "op": "upsert" }));
}

// ---------------------------------------------------------------------------
// The live channel
// ---------------------------------------------------------------------------

/// Coalescing window for `db:changed` while the push socket is open.
///
/// Home Assistant pushes a `state_changed` for every entity that moves, and a
/// house with a power meter moves several times a second. One event per push
/// would put the webview into a re-render loop for no added truth, which is the
/// failure mode the perf review of the dashboard's timers was written about.
/// The mirror is still written on EVERY push; only the notification is damped.
const PUSH_NOTIFY_WINDOW: Duration = Duration::from_millis(1000);

/// Backoff between reconnect attempts. The supervisor owns this, not the read
/// loop in ha.rs — a retry policy inside the loop cannot be told to stop.
const RECONNECT_BACKOFF: [u64; 4] = [2, 5, 15, 60];

struct Live {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

/// Managed state: at most one push socket, and the flag that stops it.
#[derive(Default)]
pub struct HomeState {
    live: Mutex<Option<Live>>,
}

impl HomeState {
    pub fn new() -> HomeState {
        HomeState::default()
    }

    /// Stop the push socket and wait for its thread. Idempotent.
    pub fn stop(&self) {
        let taken = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(mut live) = taken {
            live.stop.store(true, Ordering::SeqCst);
            if let Some(h) = live.handle.take() {
                // The read loop wakes at most every ws::READ_POLL seconds to
                // re-check the flag, so this join is bounded by that, not open.
                let _ = h.join();
            }
        }
    }
}

/// Run the push subscription until told to stop.
///
/// Owns a thread of its own. Everything it does is blocking: a WebSocket read,
/// a SQLite write, a Tauri emit. None of it may happen on the main thread.
fn live_loop(app: AppHandle, user_id: String, stop: Arc<AtomicBool>) {
    let mut attempt = 0usize;
    let mut last_notify = Instant::now() - PUSH_NOTIFY_WINDOW;

    while !stop.load(Ordering::SeqCst) {
        let bridge = {
            let Some(db) = app.try_state::<DbState>() else { return };
            let Ok(conn) = db.conn.lock() else { return };
            match active_bridge(&conn, &user_id) {
                Ok(b) => b,
                // No bridge is not a transient failure, so there is nothing to
                // back off from: stop and let a later link restart the channel.
                Err(e) => {
                    log::info!("[home] live channel not started: {e}");
                    return;
                }
            }
        };
        // THERE IS NO PUSH CHANNEL FOR HOMEKIT YET. HAP does have one — an
        // accessory sends `EVENT/1.0` frames on a subscribed session, and
        // `hap/http.rs` already parses them — but it needs a session held open
        // by a supervisor thread with its own reconnect policy, which is the
        // machinery `ws.rs` provides for Home Assistant and nothing provides
        // here. Returning is the honest behaviour: the surface polls a mirror
        // that a sync refreshes, rather than a live one that is quietly dead.
        if bridge.kind != BridgeKind::HomeAssistant {
            log::info!("[home] live channel not started: {} has no push channel", bridge.kind.as_str());
            return;
        }
        let Some(base_url) = bridge.base_url.clone() else { return };
        let Some(token) = keys::ha_token() else {
            log::warn!("[home] live channel has no token; not retrying");
            return;
        };

        let client = ha::HomeAssistant::new(&base_url, &token);
        let keep_going = || !stop.load(Ordering::SeqCst);
        let mut on_state = |p: ha::PushedState| {
            let Some(db) = app.try_state::<DbState>() else { return };
            let Ok(conn) = db.conn.lock() else { return };
            let applied = store::apply_pushed_state(
                &conn,
                &bridge.id,
                &p.external_id,
                p.value,
                Some(p.state.as_str()),
                p.colour.as_deref(),
                p.available,
                p.last_changed.as_deref(),
            );
            // The lock is held across the emit decision but not across the
            // emit itself: `changed` goes to the webview, which may be busy.
            drop(conn);
            if matches!(applied, Ok(true)) && last_notify.elapsed() >= PUSH_NOTIFY_WINDOW {
                last_notify = Instant::now();
                changed(&app, "home_device_state");
            }
        };

        match client.subscribe(&keep_going, &mut on_state) {
            // A clean return means `keep_going` said stop.
            Ok(()) => return,
            Err(e) => {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                log::warn!("[home] live channel dropped: {e}");
                let wait = RECONNECT_BACKOFF[attempt.min(RECONNECT_BACKOFF.len() - 1)];
                attempt += 1;
                // Sleep in one-second slices so a stop request is honoured
                // within a second even during the longest backoff.
                for _ in 0..wait {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
//
// Every one of these is `#[tauri::command(async)]`. See the header.
// ---------------------------------------------------------------------------

/// The whole surface, in the field names `src/lib/mocks/smartHome.ts` declares.
#[tauri::command(async)]
pub fn home_snapshot(state: State<'_, DbState>, user_id: String) -> Result<Value, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    // The synthetic HomeKit row is for the case where there is no stored one.
    // Once an accessory is paired the real `home_bridges` row exists and
    // `store::snapshot` renders it; adding the placeholder as well would show
    // the user two HomeKit bridges, one of them permanently "not linked".
    let stored_homekit = store::bridge_of_kind(&conn, &user_id, BridgeKind::HomekitCompanion)
        .map_err(String::from)?
        .is_some();
    let extra = if stored_homekit { vec![] } else { vec![companion::bridge_entry()] };
    store::snapshot(&conn, &user_id, chrono::Utc::now(), autonomy(), extra).map_err(String::from)
}

/// Link a Home Assistant bridge: probe it, keep the token, sync it once.
///
/// THE TOKEN IS NEVER PERSISTED ANYWHERE BUT THE KEYCHAIN, and it is stored
/// only AFTER the probe succeeded — a token that does not work is not written,
/// so a failed link leaves nothing behind to be confused about later.
#[tauri::command(async)]
pub fn home_link_home_assistant(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    base_url: String,
    token: String,
) -> Result<Value, String> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("A bridge needs an address, e.g. http://homeassistant.local:8123".into());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("A bridge address must start with http:// or https://".into());
    }
    if token.trim().is_empty() {
        return Err("A bridge needs a long-lived access token from your Home Assistant profile."
            .into());
    }

    let probe = ha::HomeAssistant::new(&base_url, token.trim())
        .probe()
        .map_err(String::from)?;
    keys::set_ha_token(token.trim())?;

    let bridge_id = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        store::upsert_bridge(
            &conn,
            &user_id,
            // The adapter's own answer, not the constant this branch implies —
            // if a probe ever reports a kind this code did not expect, the row
            // must record what actually answered.
            probe.kind,
            &probe.name,
            Some(&base_url),
            // A probe that came back Ok but not connected is not a link.
            if probe.connected { "connected" } else { "not-linked" },
            &probe.detail,
        )
        .map_err(String::from)?
    };
    changed(&app, "home_bridges");

    // Sync inline: a bridge that is "linked" with no devices behind it is a
    // screen that says nothing, and the user is standing right here.
    let report = sync_bridge(&app, &state, &user_id, &bridge_id)?;
    Ok(json!({ "bridgeId": bridge_id, "name": probe.name, "sync": report }))
}

/// Forget a bridge, its devices, and its credential.
#[tauri::command(async)]
pub fn home_unlink(
    app: AppHandle,
    home: State<'_, HomeState>,
    state: State<'_, DbState>,
    user_id: String,
    kind: String,
) -> Result<Value, String> {
    let kind = BridgeKind::parse(&kind).ok_or_else(|| format!("'{kind}' is not a bridge kind"))?;
    // ONLY THE HOME ASSISTANT BRIDGE OWNS THE SOCKET, so only unlinking it may
    // stop it. `live_loop` returns immediately for every other kind (see
    // `home_live_start`), and this call was unconditional back when Home
    // Assistant was the only thing that could be unlinked. With HomeKit as a
    // second unlinkable kind it became a Home Assistant regression: unlinking
    // HomeKit killed HA's push channel, and nothing restarted it — the
    // frontend's restart effect is keyed on `raw.bridgeConnected`
    // (useSmartHome.ts), which does not change when a DIFFERENT bridge goes
    // away, so HA stayed dead until the screen was remounted.
    if kind == BridgeKind::HomeAssistant {
        // Stop the socket BEFORE the rows go, or the live loop writes state
        // for a bridge that no longer exists and then logs a confusing failure.
        home.stop();
    }
    // Read the row BEFORE deleting it: for HomeKit it carries the accessory id
    // the Keychain item is keyed on, and once the row is gone there is no way
    // left to name the credential — it would sit in the login keychain forever,
    // for an accessory Atlas no longer knows about.
    let doomed = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        store::bridge_of_kind(&conn, &user_id, kind).map_err(String::from)?
    };
    let removed = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        store::delete_bridge(&conn, &user_id, kind).map_err(String::from)?
    };
    if kind == BridgeKind::HomeAssistant {
        keys::clear_ha_token()?;
    }
    #[cfg(feature = "homekit")]
    if kind == BridgeKind::HomekitCompanion {
        if let Some(t) = doomed.as_ref().and_then(|b| b.base_url.as_deref()).and_then(companion::lan::Target::parse) {
            // Best effort, and missing is success: unlinking must not fail
            // because the credential was already gone. NOTE FOR THE USER, not
            // for the code: this forgets Atlas' half. The ACCESSORY still holds
            // the pairing, so it will keep reporting itself as paired until it
            // is reset — `PairingStatus::StalePairing` in hap/discovery.rs is
            // what says so on the next browse.
            let _ = hap::keystore::forget_pairing(&t.accessory_id);
        }
    }
    // The row is only READ by the HomeKit arm above, which the consumer build
    // does not compile. Without this the same source is a warning in one build
    // and clean in the other, which is how a real warning gets ignored.
    let _ = &doomed;
    changed(&app, "home_bridges");
    Ok(json!({ "removed": removed }))
}

// ---------------------------------------------------------------------------
// HomeKit over the LAN — LIGHTHOUSE ONLY
//
// Both commands below carry `#[cfg(feature = "homekit")]`, and the test
// `every_homekit_command_is_behind_the_cargo_feature` at the bottom of this
// file refuses one that does not. NEITHER IS ON THE CONTROL PORT'S
// ALLOWED_COMMANDS: pairing takes a credential the user reads off a physical
// label, which is not a capability a model should have — the same reasoning
// that keeps `home_link_home_assistant` off it. The read-only browse IS
// reachable, through `home.discover`, via `home_homekit_discover`.
// ---------------------------------------------------------------------------

/// How long a browse listens. Long enough for a sleepy accessory to answer,
/// short enough that a person watching a spinner does not give up. Bounded
/// here rather than by the caller so no argument can turn a discovery op into
/// a thread that holds the LAN open.
#[cfg(feature = "homekit")]
pub const DISCOVER_WINDOW: Duration = Duration::from_millis(2500);

/// What `_hap._tcp` says is on this network, and whether each one can be
/// paired.
///
/// THE PAIRING STATUS IS THE POINT. An accessory holds exactly one pairing
/// owner, so a lock already in Apple Home cannot also be in Atlas, and the
/// useful instruction is "remove it from that home first" rather than "enter
/// its setup code". `hap::discovery::PairingStatus` decides that from the
/// accessory's own `sf` flag plus whether the Keychain holds a record for it,
/// and it carries the sentence — this command only joins the two.
#[cfg(feature = "homekit")]
#[tauri::command(async)]
pub fn home_homekit_discover() -> Result<Value, String> {
    let found = hap::discovery::browse(DISCOVER_WINDOW).map_err(HomeError::from)?;
    let rows: Vec<Value> = found
        .iter()
        .map(|a| {
            let status = a.pairing_status(hap::keystore::pairing(&a.id).is_some());
            json!({
                "id": a.id,
                "name": a.display_name(),
                "model": a.model,
                "host": a.host,
                "port": a.port,
                "category": a.category,
                "status": status.as_str(),
                "detail": status.explain(),
                "pairable": status.can_attempt_pairing(),
                "problem": a.reports_a_problem(),
            })
        })
        .collect();
    Ok(json!({ "found": rows, "windowMs": DISCOVER_WINDOW.as_millis() as u64 }))
}

/// Pair with one accessory and sync it.
///
/// THE SETUP CODE IS NEVER PERSISTED. It goes into the SRP exchange and out of
/// scope; what survives is the accessory's long-term PUBLIC key in the
/// Keychain. And the Keychain is written only AFTER pair-setup succeeded, so a
/// failed attempt leaves nothing behind to be confused about later — the same
/// discipline `home_link_home_assistant` follows with its token.
#[cfg(feature = "homekit")]
#[tauri::command(async)]
pub fn home_homekit_pair(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    accessory_id: String,
    host: String,
    port: u16,
    setup_code: String,
) -> Result<Value, String> {
    let target = companion::lan::Target {
        accessory_id: accessory_id.trim().to_string(),
        host: host.trim().to_string(),
        port,
    };
    if target.accessory_id.is_empty() || target.host.is_empty() || port == 0 {
        return Err("Atlas needs the accessory's id, address and port to pair with it.".into());
    }

    // ONE HOMEKIT ACCESSORY AT A TIME, AND THE REFUSAL COMES FIRST.
    // `home_bridges` has a UNIQUE(user_id, kind) index and `upsert_bridge`
    // does ON CONFLICT DO UPDATE, so pairing a second accessory would not add
    // a row — it would REPLACE the first one's locator. After that,
    // `home_unlink` can only name the accessory in the current `base_url`, so
    // the first accessory's Keychain item is orphaned with nothing left able
    // to name it — exactly what the comment above `home_unlink` says it reads
    // the row to prevent. Worse, `external_id` is `<aid>.<iid>` with no
    // accessory namespace and `apply_pull` never prunes, so the first
    // accessory's device rows stay `available` and resolve against the SECOND
    // accessory's attribute database, where low aid/iid values collide freely.
    //
    // Refusing costs the user a sentence. The alternative costs them a device
    // row that actuates something they did not name. Widening this to several
    // accessories needs a per-accessory bridge row AND the accessory id inside
    // `external_id`; neither is a change to make on the way past.
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let existing = store::bridge_of_kind(&conn, &user_id, BridgeKind::HomekitCompanion)
            .map_err(String::from)?;
        if let Some(other) = existing
            .as_ref()
            .and_then(|b| b.base_url.as_deref())
            .and_then(companion::lan::Target::parse)
            .filter(|t| t.accessory_id != target.accessory_id)
        {
            return Err(format!(
                "Atlas is already paired with HomeKit accessory {}, and it can hold one at a \
                 time. Unlink that one first, then pair this one.",
                other.accessory_id
            ));
        }
    }

    let record = companion::lan::pair(&target, setup_code.trim()).map_err(String::from)?;
    // THE ACCESSORY'S OWN ID WINS over the one discovery reported. M6 carries
    // the identifier the accessory signed, and that is the key pair-verify will
    // be run against; storing the Bonjour one instead would work until the two
    // ever disagreed, and then fail with an authentication error nobody could
    // explain.
    let target = companion::lan::Target { accessory_id: record.accessory_pairing_id.clone(), ..target };
    hap::keystore::set_pairing(&record)?;

    let bridge_id = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        store::upsert_bridge(
            &conn,
            &user_id,
            BridgeKind::HomekitCompanion,
            "HomeKit",
            Some(&target.locator()),
            "connected",
            "Paired over the local network",
        )
        .map_err(String::from)?
    };
    changed(&app, "home_bridges");

    // Sync inline: a bridge that is "linked" with no devices behind it is a
    // screen that says nothing, and the user is standing right here.
    let report = sync_bridge(&app, &state, &user_id, &bridge_id)?;
    Ok(json!({
        "bridgeId": bridge_id,
        "accessoryId": record.accessory_pairing_id,
        "sync": report,
    }))
}

/// Pull everything from the linked bridge into the mirror.
#[tauri::command(async)]
pub fn home_sync(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
) -> Result<Value, String> {
    let bridge_id = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        active_bridge(&conn, &user_id)?.id
    };
    sync_bridge(&app, &state, &user_id, &bridge_id)
}

/// The body of a sync, shared by `home_sync` and the inline sync in link.
///
/// A FAILURE IS RECORDED, NOT SWALLOWED: the bridge's `state` and `detail`
/// columns are written with what actually went wrong, so the Setup screen shows
/// "the token was rejected" rather than a stale "Connected" from last week.
fn sync_bridge(
    app: &AppHandle,
    state: &State<'_, DbState>,
    user_id: &str,
    bridge_id: &str,
) -> Result<Value, String> {
    let bridge = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        bridge_by_id(&conn, user_id, bridge_id).map_err(String::from)?
    };

    // The network call happens with NO database lock held. Holding the single
    // shared WAL connection across a LAN round trip would block the webview's
    // own reads for as long as the hub takes to answer.
    let pull = match adapter_for(&bridge).and_then(|a| a.pull()) {
        Ok(p) => p,
        Err(e) => {
            let (health, detail) = health_of(&e);
            let conn = state.conn.lock().map_err(|err| err.to_string())?;
            let _ = store::set_bridge_health(&conn, bridge_id, health, &detail, Some(&detail));
            drop(conn);
            changed(app, "home_bridges");
            return Err(e.to_string());
        }
    };

    let report = {
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        let report = store::apply_pull(&mut conn, user_id, bridge_id, &pull).map_err(String::from)?;
        store::mark_synced(&conn, bridge_id, &now_iso()).map_err(String::from)?;
        store::set_bridge_health(&conn, bridge_id, "connected", &bridge.detail_or_default(), None)
            .map_err(String::from)?;
        report
    };
    changed(app, "home_devices");
    Ok(json!({
        "rooms": report.rooms,
        "devices": report.devices,
        "scenes": report.scenes,
        "removed": report.removed,
    }))
}

/// Set a device's primary value: brightness, position, volume, temperature.
///
/// REFUSES A LOCK. `home.device_set` is `Tier::Actuate`, which the interactive
/// profile runs without asking; routing a lock through it would make the
/// approval tier on `home_lock_set` decorative. The refusal names the command
/// that CAN do it, so a model that tried is told what to do instead of guessing.
#[tauri::command(async)]
pub fn home_device_set(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    device_id: String,
    value: f64,
) -> Result<Value, String> {
    let target = resolve_device(&state, &user_id, &device_id)?;
    device_set_allowed(&target.kind, &target.control, &target.name)?;
    if !value.is_finite() {
        return Err("a device value must be a real number".into());
    }
    adapter_for(&target.bridge)
        .and_then(|a| a.set_value(&target.external_id, value))
        .map_err(String::from)?;

    // The bridge is the source of truth for what the device is now doing, and
    // it pushes that on the live channel. Atlas records the ATTEMPT's effect
    // optimistically nowhere: the mirror is left alone and the next push or
    // sync writes the real number. Emitting the signal is still right — the
    // audit trail and the activity strip both changed.
    changed(&app, "home_devices");
    Ok(json!({ "device_id": target.id, "device": target.name, "requested": value }))
}

/// Set a colour light's colour. `#rrggbb`, the swatches the surface draws.
#[tauri::command(async)]
pub fn home_device_colour(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    device_id: String,
    colour: String,
) -> Result<Value, String> {
    let target = resolve_device(&state, &user_id, &device_id)?;
    adapter_for(&target.bridge)
        .and_then(|a| a.set_colour(&target.external_id, &colour))
        .map_err(String::from)?;
    changed(&app, "home_devices");
    Ok(json!({ "device_id": target.id, "device": target.name, "colour": colour }))
}

/// Lock or unlock a door. The only path to a lock, and it is Approval-tier at
/// the control port for BOTH directions.
///
/// Why both, when the design's rule only forbids unlocking: a card the user
/// clicks is cheap, and an Atlas that can lock the house unattended can lock
/// somebody out of it. The design's sentence is the floor, not the ceiling.
#[tauri::command(async)]
pub fn home_lock_set(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    device_id: String,
    locked: bool,
) -> Result<Value, String> {
    let target = resolve_device(&state, &user_id, &device_id)?;
    if !is_lock_kind(&target.kind) {
        return Err(format!(
            "'{}' is a {}, not a lock.",
            target.name, target.kind
        ));
    }
    adapter_for(&target.bridge)
        .and_then(|a| a.set_lock(&target.external_id, locked))
        .map_err(String::from)?;
    changed(&app, "home_devices");
    Ok(json!({ "device_id": target.id, "device": target.name, "locked": locked }))
}

/// Apply a scene.
///
/// REFUSES A SCENE THAT MIGHT TOUCH A LOCK, including one whose membership the
/// bridge never published — `touches_locks` defaults to 1 for exactly that
/// case. A scene is a bundle of commands an approvals card cannot enumerate, so
/// "Atlas does not know what is in it" has to fail the same way "there is a
/// lock in it" does.
#[tauri::command(async)]
pub fn home_scene_run(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    scene_id: String,
) -> Result<Value, String> {
    let target = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        store::scene_target(&conn, &user_id, &scene_id)
            .map_err(String::from)?
            .ok_or_else(|| "that scene is not in Atlas' home store".to_string())?
    };
    scene_run_allowed(target.touches_locks, &target.label)?;
    adapter_for(&target.bridge)
        .and_then(|a| a.run_scene(&target.external_id))
        .map_err(String::from)?;
    changed(&app, "home_devices");
    Ok(json!({ "scene_id": target.id, "scene": target.label }))
}

/// The Setup screen's autonomy switches.
///
/// This deliberately CANNOT be set. The rules `autonomy()` reports are the
/// control port's tier table read back in words, and a stored preference that
/// disagreed with the table would be a switch that does nothing — which is
/// worse than a switch that explains itself. Returning the reason is the honest
/// answer the surface can show.
#[tauri::command(async)]
pub fn home_set_autonomy(rule_id: String, _allowed: bool) -> Result<Value, String> {
    Err(format!(
        "'{rule_id}' is not a stored preference. Atlas' home autonomy is enforced by the control \
         port's approval tiers in Rust — locks always ask you, and nothing here can turn that off."
    ))
}

/// Open the push channel so the surface updates when somebody else touches a
/// switch. Off by default: an open socket is LAN traffic and a live thread, and
/// neither should exist while nobody is looking at the page.
#[tauri::command(async)]
pub fn home_live_start(
    app: AppHandle,
    home: State<'_, HomeState>,
    state: State<'_, DbState>,
    user_id: String,
) -> Result<Value, String> {
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        // Fail here rather than inside the thread, so the caller learns why.
        active_bridge(&conn, &user_id)?;
    }
    let mut guard = home.live.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        return Ok(json!({ "running": true, "started": false }));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let handle = {
        let app = app.clone();
        let stop = stop.clone();
        std::thread::spawn(move || live_loop(app, user_id, stop))
    };
    *guard = Some(Live { stop, handle: Some(handle) });
    Ok(json!({ "running": true, "started": true }))
}

#[tauri::command(async)]
pub fn home_live_stop(home: State<'_, HomeState>) -> Result<Value, String> {
    home.stop();
    Ok(json!({ "running": false }))
}

/// Resolve a local device id to something a bridge can be told about.
fn resolve_device(
    state: &State<'_, DbState>,
    user_id: &str,
    device_id: &str,
) -> Result<store::DeviceTarget, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    store::device_target(&conn, user_id, device_id)
        .map_err(String::from)?
        .ok_or_else(|| "that device is not in Atlas' home store".to_string())
}

// ---------------------------------------------------------------------------
// What the control port's approvals card is allowed to say
//
// These two are the ONLY reads the control port makes outside its own ops, and
// they exist so an approval can name the front door instead of a uuid. They
// return exactly the columns declared in registry.rs' OBJECT_LOOKUPS and are
// scoped to the caller's user_id in SQL.
// ---------------------------------------------------------------------------

/// The columns `card_device` returns, in card order. `name` first: it is the
/// identifying field and the one guaranteed to survive truncation.
pub const DEVICE_CARD_COLUMNS: &[&str] = &["name", "room_name"];
pub const SCENE_CARD_COLUMNS: &[&str] = &["label"];

pub fn card_device(app: &AppHandle, user_id: &str, device_id: &str) -> Result<Option<Value>, String> {
    let db = app
        .try_state::<DbState>()
        .ok_or_else(|| "the local database is not open yet".to_string())?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    store::device_card(&conn, user_id, device_id).map_err(String::from)
}

pub fn card_scene(app: &AppHandle, user_id: &str, scene_id: &str) -> Result<Option<Value>, String> {
    let db = app
        .try_state::<DbState>()
        .ok_or_else(|| "the local database is not open yet".to_string())?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    store::scene_card(&conn, user_id, scene_id).map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The attribute that keeps this module off the main thread.
    ///
    /// `#[tauri::command]` without `(async)` runs the body on the MAIN thread.
    /// Every command here does LAN HTTP or SQLite work, so a plain
    /// `#[tauri::command]` would reintroduce exactly the freeze documented at
    /// the top of src/http.rs — and it would do it silently, because the code
    /// compiles and works on a fast local hub. A text scan is the only check
    /// available: the attribute is erased by the macro before anything else can
    /// see it.
    #[test]
    fn every_command_in_this_module_leaves_the_main_thread() {
        let src = include_str!("mod.rs");
        let mut commands = 0usize;
        for (i, line) in src.lines().enumerate() {
            let trimmed = line.trim();
            if !trimmed.starts_with("#[tauri::command") {
                continue;
            }
            commands += 1;
            assert_eq!(
                trimmed, "#[tauri::command(async)]",
                "line {}: `{trimmed}` runs on the main thread. Every home command does network \
                 or database I/O — see the incident note at the top of src/http.rs.",
                i + 1
            );
        }
        assert!(commands >= 9, "only {commands} commands found; the scan is not looking at the file");
    }

    /// THE FEATURE GATE, AS A STRUCTURAL FACT RATHER THAN A REVIEW QUESTION.
    ///
    /// A `#[tauri::command]` compiled into the crate is present in Atlas.app as
    /// well as Lighthouse — both bundles are built from this one crate — and
    /// the control port is a registry, so anything a runner can name is
    /// reachable by the model in both editions. A HomeKit command that lost its
    /// `#[cfg(feature = "homekit")]` would therefore ship a working accessory
    /// controller to consumers with no screen, no consent and no notice.
    ///
    /// A TEXT SCAN, for the same reason the test above is one: cfg attributes
    /// are resolved by the compiler long before anything can ask a function
    /// which ones it carried. What is checked is that every command whose name
    /// says HomeKit has the attribute IMMEDIATELY above its `#[tauri::command]`
    /// line — and, in the other direction, that the scan found some, so a
    /// rename cannot make it vacuous.
    ///
    /// RUNS IN BOTH BUILDS. The source text is the same either way, which is
    /// what makes this a fact about the file rather than about the profile it
    /// was compiled under.
    #[test]
    fn every_homekit_command_is_behind_the_cargo_feature() {
        let src = include_str!("mod.rs");
        let lines: Vec<&str> = src.lines().collect();
        let mut gated = 0usize;
        for (i, line) in lines.iter().enumerate() {
            if !line.trim().starts_with("pub fn home_homekit") {
                continue;
            }
            gated += 1;
            // The two lines above a command are `#[cfg(...)]` then
            // `#[tauri::command(async)]`.
            let attrs: Vec<&str> = lines[i.saturating_sub(3)..i].iter().map(|l| l.trim()).collect();
            assert!(
                attrs.contains(&"#[tauri::command(async)]"),
                "{}: a home command must leave the main thread",
                line.trim()
            );
            assert!(
                attrs.contains(&"#[cfg(feature = \"homekit\")]"),
                "{} is not behind `#[cfg(feature = \"homekit\")]`, so it would be compiled into \
                 Atlas.app and reachable from the control port in the consumer build",
                line.trim()
            );
        }
        assert_eq!(gated, 2, "expected exactly the discover and pair commands, found {gated}");

        // And the module itself: `hap` must never be declared unconditionally.
        assert!(
            src.contains("#[cfg(feature = \"homekit\")]\npub mod hap;"),
            "the hap module declaration lost its feature gate"
        );
    }

    /// Without the feature there is no HAP module to reach, and the HomeKit
    /// bridge row says the controller is absent rather than that the house is
    /// empty. This is the runtime half of the gate.
    #[cfg(not(feature = "homekit"))]
    #[test]
    fn a_build_without_the_feature_has_no_homekit_controller_at_all() {
        let row = companion::bridge_entry();
        assert_eq!(row["health"], json!("unavailable"));
        assert_eq!(row["detail"], json!(companion::NO_CONTROLLER));
        // And the adapter refuses rather than answering with an empty house.
        let adapter = companion::Companion::Unavailable(companion::NO_CONTROLLER.into());
        assert!(matches!(adapter.pull(), Err(HomeError::Unavailable(_))));
    }

    /// A HomeKit bridge row must not make `home_snapshot` show two HomeKit
    /// bridges — the stored one and the placeholder that exists for the case
    /// where there is none.
    #[test]
    fn the_placeholder_homekit_row_disappears_once_a_real_one_exists() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../db_schema.sql")).unwrap();
        let none = store::bridge_of_kind(&conn, "u1", BridgeKind::HomekitCompanion).unwrap();
        assert!(none.is_none());

        store::upsert_bridge(
            &conn,
            "u1",
            BridgeKind::HomekitCompanion,
            "HomeKit",
            Some("hap://AA:BB@lock-1.local:51826"),
            "connected",
            "Paired over the local network",
        )
        .unwrap();
        let stored = store::bridge_of_kind(&conn, "u1", BridgeKind::HomekitCompanion).unwrap();
        assert!(stored.is_some(), "the row the snapshot suppresses the placeholder for");

        // The snapshot with NO extra rows shows exactly one HomeKit bridge.
        let snap = store::snapshot(&conn, "u1", chrono::Utc::now(), autonomy(), vec![]).unwrap();
        let homekit: Vec<&Value> = snap["bridges"]
            .as_array()
            .expect("bridges")
            .iter()
            .filter(|b| b["kind"] == json!("homekit_companion"))
            .collect();
        assert_eq!(homekit.len(), 1, "{:#?}", snap["bridges"]);
    }

    /// A bridge lookup by id must find either kind. Before this existed, a
    /// sync of the HomeKit bridge searched the Home Assistant row and reported
    /// "that bridge is not linked to this account" for a bridge that was.
    #[test]
    fn a_bridge_is_found_by_its_id_whichever_kind_it_is() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../db_schema.sql")).unwrap();
        let ha = store::upsert_bridge(
            &conn,
            "u1",
            BridgeKind::HomeAssistant,
            "Home Assistant",
            Some("http://hub.local:8123"),
            "connected",
            "Linked",
        )
        .unwrap();
        let hk = store::upsert_bridge(
            &conn,
            "u1",
            BridgeKind::HomekitCompanion,
            "HomeKit",
            Some("hap://AA:BB@lock-1.local:51826"),
            "connected",
            "Paired",
        )
        .unwrap();
        assert_eq!(bridge_by_id(&conn, "u1", &ha).unwrap().kind, BridgeKind::HomeAssistant);
        assert_eq!(bridge_by_id(&conn, "u1", &hk).unwrap().kind, BridgeKind::HomekitCompanion);
        // Another account's bridge is not this account's, and neither is a
        // bridge that does not exist.
        assert!(bridge_by_id(&conn, "u2", &hk).is_err());
        assert!(bridge_by_id(&conn, "u1", "nope").is_err());

        // Home Assistant wins when both are linked: it sees the whole house.
        assert_eq!(active_bridge(&conn, "u1").unwrap().kind, BridgeKind::HomeAssistant);
        store::delete_bridge(&conn, "u1", BridgeKind::HomeAssistant).unwrap();
        assert_eq!(active_bridge(&conn, "u1").unwrap().kind, BridgeKind::HomekitCompanion);
        store::delete_bridge(&conn, "u1", BridgeKind::HomekitCompanion).unwrap();
        assert!(active_bridge(&conn, "u1").is_err());
    }

    /// A garage door is a lock. This is the one classification with a physical
    /// consequence, and `ha::kind_of` is what decides it from a `device_class`.
    #[test]
    fn the_lock_domain_includes_the_garage_and_excludes_the_blinds() {
        assert!(is_lock_kind("lock"));
        assert!(is_lock_kind("garage"));
        for not_a_lock in ["blind", "curtain", "bulb", "plug", "camera", "sensor", ""] {
            assert!(!is_lock_kind(not_a_lock), "{not_a_lock} must not be a lock");
        }
    }

    /// THE LOCK RULE. `home.device_set` is Actuate — the interactive profile
    /// runs it without asking anybody — so if it accepted a lock, the
    /// `Tier::Approval` on `home.lock_set` would be decoration and Atlas could
    /// open a front door on its own initiative.
    #[test]
    fn the_actuate_path_refuses_every_lock_it_can_be_handed() {
        for (kind, control) in [("lock", "toggle"), ("garage", "toggle"), ("lock", "slider")] {
            let err = device_set_allowed(kind, control, "Front door lock")
                .expect_err("a lock must never be settable through the Actuate op");
            assert!(err.contains("home_lock_set"), "the refusal must name the op that can: {err}");
            assert!(err.contains("Front door lock"), "{err}");
        }
    }

    /// Everything that is not a lock still has to work, or the guard is just a
    /// way of turning the feature off.
    #[test]
    fn the_actuate_path_allows_the_things_it_is_for() {
        for (kind, control) in [
            ("bulb", "slider"),
            ("strip", "colour"),
            ("blind", "slider"),
            ("thermostat", "stepper"),
            ("speaker", "slider"),
            ("plug", "toggle"),
        ] {
            assert!(device_set_allowed(kind, control, "x").is_ok(), "{kind}/{control}");
        }
    }

    /// A device that reports and cannot be commanded is refused rather than
    /// called: a service call on a leak sensor would come back 200 and Atlas
    /// would report having done something it did not do.
    #[test]
    fn a_reports_only_device_is_refused_instead_of_reported_as_set() {
        let err = device_set_allowed("sensor", "status", "Leak sensor").unwrap_err();
        assert!(err.contains("reports only"), "{err}");
    }

    /// The two cases that must NOT be told apart. `touches_locks` is true both
    /// for "Atlas saw a lock in it" and for "the bridge never said what is in
    /// it", and an approvals card cannot enumerate a scene either way.
    #[test]
    fn a_scene_fails_closed_whether_the_lock_is_seen_or_merely_possible() {
        let seen = scene_run_allowed(true, "Away lock-up").unwrap_err();
        let unknown = scene_run_allowed(true, "Mystery").unwrap_err();
        assert!(seen.contains("Away lock-up"));
        assert!(unknown.contains("cannot see what is in it"), "{unknown}");
        // And a scene proven to be lights-only still runs, or the feature is
        // gone rather than gated.
        assert!(scene_run_allowed(false, "Evening").is_ok());
    }

    /// Every rule reported to the user must be one the code enforces. The three
    /// the mock lists that Atlas cannot do are absent on purpose; if somebody
    /// adds one back as a decorative switch, this fails.
    #[test]
    fn autonomy_reports_only_rules_that_are_enforced() {
        let rules = autonomy();
        let ids: Vec<&str> = rules
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["lights", "scenes", "lock", "unlock"]);

        for r in rules.as_array().unwrap() {
            for key in ["id", "name", "note", "allowed"] {
                assert!(!r[key].is_null(), "AutonomyRule.{key} is missing");
            }
        }
        let allowed = |id: &str| {
            rules
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == json!(id))
                .unwrap()["allowed"]
                .as_bool()
                .unwrap()
        };
        // The design's sentence, as a assertion rather than as prose.
        assert!(!allowed("unlock"), "Atlas must never claim it may unlock a door");
        assert!(!allowed("lock"), "locking is approval-gated too");
        assert!(allowed("lights"));
    }

    #[test]
    fn bridge_kinds_round_trip_through_the_column_they_are_stored_in() {
        for kind in [BridgeKind::HomeAssistant, BridgeKind::HomekitCompanion] {
            assert_eq!(BridgeKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(BridgeKind::parse("hue"), None);
        assert_eq!(BridgeKind::parse(""), None);
    }

    #[test]
    fn a_bridge_failure_is_recorded_as_the_kind_of_failure_it_was() {
        let (state, _) = health_of(&HomeError::Unauthorised("token".into()));
        assert_eq!(state, "unauthorised");
        let (state, _) = health_of(&HomeError::Unreachable("off".into()));
        assert_eq!(state, "unreachable");
        let (state, _) = health_of(&HomeError::Unavailable("companion".into()));
        assert_eq!(state, "unavailable");
        // Anything else is still recorded, never dropped.
        let (state, detail) = health_of(&HomeError::Malformed("not a hub".into()));
        assert_eq!(state, "unreachable");
        assert_eq!(detail, "not a hub");
    }

    /// The card columns this module publishes have to be the ones it actually
    /// returns, because registry.rs declares them and the approvals card
    /// renders exactly that list. A mismatch shows the user a blank field.
    #[test]
    fn the_card_columns_are_the_ones_the_store_returns() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../db_schema.sql")).unwrap();
        let bridge = store::upsert_bridge(
            &conn,
            "u1",
            BridgeKind::HomeAssistant,
            "Home Assistant",
            Some("http://hub.local:8123"),
            "connected",
            "Linked",
        )
        .unwrap();
        let mut conn = conn;
        store::apply_pull(
            &mut conn,
            "u1",
            &bridge,
            &BridgePull {
                rooms: vec![RoomPull { external_id: "hall".into(), name: "Hall".into() }],
                devices: vec![DevicePull {
                    external_id: "lock.front_door".into(),
                    name: "Front door lock".into(),
                    kind: "lock".into(),
                    control: "toggle".into(),
                    room_external_id: Some("hall".into()),
                    value: Some(1.0),
                    state: Some("Locked".into()),
                    colour: None,
                    available: true,
                    last_changed: None,
                }],
                scenes: vec![ScenePull {
                    external_id: "scene.evening".into(),
                    label: "Evening".into(),
                    touches_locks: false,
                }],
            },
        )
        .unwrap();

        let device_id: String = conn
            .query_row("SELECT id FROM home_devices", [], |r| r.get(0))
            .unwrap();
        let card = store::device_card(&conn, "u1", &device_id).unwrap().unwrap();
        let keys: Vec<&str> = card.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, DEVICE_CARD_COLUMNS.to_vec());
        // The whole point: the card says which door, not which uuid.
        assert_eq!(card["name"], json!("Front door lock"));
        assert_eq!(card["room_name"], json!("Hall"));

        let scene_id: String = conn
            .query_row("SELECT id FROM home_scenes", [], |r| r.get(0))
            .unwrap();
        let scene_card = store::scene_card(&conn, "u1", &scene_id).unwrap().unwrap();
        let keys: Vec<&str> = scene_card.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, SCENE_CARD_COLUMNS.to_vec());

        // AND THE CONTAINMENT HALF, which is what registry.rs' guard for the
        // `Db` sources gets from ops_db's column matrix and has no matrix to
        // get here: everything the card shows is already published by the
        // Read-tier op (`home.list` projects this same snapshot), so a queued
        // call's card cannot become a second, wider read surface.
        let snap = store::snapshot(&conn, "u1", chrono::Utc::now(), autonomy(), vec![]).unwrap();
        let device = &snap["rooms"][0]["devices"][0];
        assert_eq!(device["name"], card["name"]);
        assert_eq!(device["roomName"], card["room_name"]);
        assert_eq!(snap["scenes"][0]["label"], scene_card["label"]);
    }
}
