// Smart-home ops: one read, two actuations, and the one that always asks.
//
// WHAT IS DELIBERATELY ABSENT, and why it is not an oversight:
//
//   home.link / home.unlink   Linking a bridge means taking a long-lived Home
//                             Assistant token and writing it to the Keychain.
//                             That is a credential the user types in once, on a
//                             screen, and it is not a capability a model should
//                             have at all — a tool that can re-point the bridge
//                             at another address can point the whole house at
//                             it. Neither command is on ALLOWED_COMMANDS.
//   home.sync                 A sync is a bridge-wide network pull the user
//                             does not see coming. The webview and the link
//                             flow trigger it; nothing here needs to, because
//                             `home.list` reads the mirror the sync fills.
//   home.set_autonomy         There is nothing to set: the autonomy rules are
//                             the tier table read back in words (`autonomy()`
//                             in src/home/mod.rs), and the underlying command
//                             exists only to say so to the UI.
//   home.pair                 Pairing with a HomeKit accessory needs the
//                             8-digit setup code printed on it — a credential
//                             a person reads off a physical label while
//                             standing in front of the thing. A tool that can
//                             pair a controller to an accessory is a tool that
//                             can be talked into pairing with an accessory the
//                             user did not choose, and it earns a permanent key
//                             on the way. The underlying command is on DENIED
//                             in registry.rs and off ALLOWED_COMMANDS; it is
//                             not named here because these two scans read this
//                             file's TEXT, and naming a denied command in a
//                             runner is exactly what they exist to catch.
//
// THE ONE HOMEKIT OP, AND WHY IT IS A READ.
// `home.discover` browses `_hap._tcp` on the local network and reports what
// answered, including whether each accessory is ALREADY PAIRED with somebody
// else. It changes nothing, addresses nothing, and cannot pair. It is also the
// only Read in the whole registry that puts a packet on the user's own network,
// which is worth stating plainly rather than burying: it is one multicast
// query with a hard 2.5-second budget owned by `home::DISCOVER_WINDOW`, not by
// any argument a caller can send. It earns its place because the question it
// answers — "why can't you see my HomeKit lock?" — has an answer the model
// otherwise cannot give, and the answer is usually "because it belongs to
// Apple Home; remove it there first".
//
// IT IS COMPILED ONLY INTO LIGHTHOUSE. Both the runner and its table entry
// carry `#[cfg(feature = "homekit")]`, and
// `no_homekit_op_is_reachable_without_the_cargo_feature` in registry.rs fails
// if either loses it.
//
// THE LOCK RULE, AS CODE
// `home.device_set` is Actuate — the interactive profile runs it without asking
// — so `crate::home::home_device_set` REFUSES a lock or a garage door outright.
// The only way to a lock is `home.lock_set`, which is `Tier::Approval` in
// registry.rs and therefore never auto-runs on either profile. Both halves are
// needed: the tier without the refusal would leave a lock reachable through the
// cheaper op, and the refusal without the tier would leave it reachable at all.
// `home.scene_run` is the third face of the same rule — a scene is a bundle of
// commands an approvals card cannot enumerate, so a scene that touches a lock,
// or whose membership the bridge never published, is refused rather than shown
// as a card nobody could evaluate.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use super::ops_project;
use crate::control::Ctx;
use crate::db::DbState;
use crate::home::card_device;
use crate::home::card_scene;
use crate::home::home_device_set;
#[cfg(feature = "homekit")]
use crate::home::home_homekit_discover;
use crate::home::home_lock_set;
use crate::home::home_scene_run;
use crate::home::home_snapshot;
use crate::home::DEVICE_CARD_COLUMNS;
use crate::home::SCENE_CARD_COLUMNS;

fn db(app: &AppHandle) -> Result<State<'_, DbState>, String> {
    app.try_state::<DbState>()
        .ok_or_else(|| "the local database is not open yet".to_string())
}

/// The account whose house this is.
///
/// Required rather than defaulted, even on the Read tier. `store::snapshot`
/// scopes every query by user_id, so an empty one returns a house with no
/// devices in it — which reads exactly like "you have no smart home" and is not
/// the same statement as "this request carried no identity".
fn user(ctx: &Ctx) -> Result<String, String> {
    if ctx.user_id.is_empty() {
        return Err("this request carries no user identity, so there is no home to read".into());
    }
    Ok(ctx.user_id.clone())
}

/// Project the surface snapshot down to what a model can act on.
///
/// The snapshot is built for a page: it carries a headline, a discovery block
/// and per-room grouping, none of which a model can do anything with and all of
/// which it pays for. What survives is the device list (with the local id,
/// because that is what every mutating op takes), the scenes, and whether the
/// bridge is actually answering.
fn project(snap: &Value) -> Value {
    let mut devices: Vec<Value> = Vec::new();
    for room in snap["rooms"].as_array().unwrap_or(&Vec::new()) {
        for d in room["devices"].as_array().unwrap_or(&Vec::new()) {
            devices.push(json!({
                "device_id": d["id"],
                "name": d["name"],
                "room": d["roomName"],
                "kind": d["kind"],
                "control": d["control"],
                "value": d["value"],
                "state": d["state"],
                // Carried, never hidden: a model that cannot see this would
                // report a stale reading as the current one.
                "available": d["available"],
            }));
        }
    }

    let scenes: Vec<Value> = snap["scenes"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|s| {
            let touches = s["touchesLocks"].as_bool().unwrap_or(true);
            json!({
                "scene_id": s["id"],
                "label": s["label"],
                // Told UP FRONT rather than discovered by being refused: a
                // model that knows which scenes it may run does not spend a
                // turn being told no.
                "runnable_by_atlas": !touches,
            })
        })
        .collect();

    json!({
        "bridge_connected": snap["bridgeConnected"],
        "hub": snap["hub"],
        "counts": snap["counts"],
        "devices": ops_project::capped(devices),
        "scenes": ops_project::capped(scenes),
        "autonomy": snap["autonomy"],
    })
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/// The house as of the last sync or push. Reads the local mirror only — this op
/// puts no traffic on the user's home network.
pub fn list(app: &AppHandle, _args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let snap = home_snapshot(db(app)?, user(ctx)?)?;
    Ok(project(&snap))
}

/// What HomeKit accessories are on this network, and whether each is free to
/// pair. Reads nothing of the user's; it listens to the LAN.
///
/// IDENTITY IS STILL REQUIRED, even though no row is read. The result names
/// devices in the user's home and says which ones Atlas holds a key for, and
/// "this request carried no identity" is not the same statement as "your
/// network is empty" — the distinction `user()` above exists to keep.
#[cfg(feature = "homekit")]
pub fn discover(_app: &AppHandle, _args: &Value, ctx: &Ctx) -> Result<Value, String> {
    if ctx.user_id.is_empty() {
        return Err("this request carries no user identity, so there is no home to search".into());
    }
    home_homekit_discover()
}

/// Set a device's primary value. Refuses a lock — see the header.
pub fn device_set(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let device_id = args
        .get("device_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "home.device_set needs a 'device_id' from home.list".to_string())?
        .to_string();
    let value = args
        .get("value")
        .and_then(Value::as_f64)
        .ok_or_else(|| "home.device_set needs 'value', a number in the unit its control implies".to_string())?;
    home_device_set(app.clone(), db(app)?, user(ctx)?, device_id, value)
}

/// Apply a scene. Refuses one that can reach a lock, including one whose
/// contents the bridge never published.
pub fn scene_run(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let scene_id = args
        .get("scene_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "home.scene_run needs a 'scene_id' from home.list".to_string())?
        .to_string();
    home_scene_run(app.clone(), db(app)?, user(ctx)?, scene_id)
}

/// Lock or unlock a door. `Tier::Approval` — this never runs without a click.
pub fn lock_set(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let device_id = args
        .get("device_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "home.lock_set needs a 'device_id' from home.list".to_string())?
        .to_string();
    // No default. "Lock or unlock?" is the entire content of the decision the
    // user is being asked to approve, and a defaulted direction would put a
    // guess on the card.
    let locked = args
        .get("locked")
        .and_then(Value::as_bool)
        .ok_or_else(|| "home.lock_set needs 'locked': true to lock, false to unlock".to_string())?;
    home_lock_set(app.clone(), db(app)?, user(ctx)?, device_id, locked)
}

// ---------------------------------------------------------------------------
// The approvals card
//
// registry.rs' `card_target` calls these. They live HERE rather than in
// registry.rs on purpose: registry.rs is excluded from the ALLOWED_COMMANDS
// scan (it has to be able to NAME every denied command), so any `crate::…` call
// written there would be capability nothing checks. Written in a runner module,
// `crate::home::card_device` has to be on the allowlist like everything else.
// ---------------------------------------------------------------------------

/// The columns a device card may show. Re-exported from the home module so the
/// declaration in registry.rs and the query in home/store.rs cannot drift —
/// `the_card_columns_are_the_ones_the_store_returns` proves the other half.
pub const DEVICE_CARD: &[&str] = DEVICE_CARD_COLUMNS;
pub const SCENE_CARD: &[&str] = SCENE_CARD_COLUMNS;

/// The account a card may be resolved against, or `None` for a caller with no
/// identity.
///
/// `None` rather than a query with an empty `user_id`. An empty string matches
/// no row today, but only because no row happens to carry one — that is data
/// luck, not a rule, and the approvals path is the last place to rely on it.
/// Split out from the two functions below so it is testable without an app.
fn card_user(ctx: &Ctx) -> Option<&str> {
    Some(ctx.user_id.as_str()).filter(|u| !u.is_empty())
}

/// Resolve the device an approval would act on. `Ok(None)` means "not this
/// user's device, or no such device" — the two are indistinguishable by design,
/// and both make `queue_for_approval` refuse rather than show a card for
/// something nobody can identify.
pub fn card_for_device(app: &AppHandle, ctx: &Ctx, id: &str) -> Result<Option<Value>, String> {
    let Some(user) = card_user(ctx) else { return Ok(None) };
    card_device(app, user, id)
}

pub fn card_for_scene(app: &AppHandle, ctx: &Ctx, id: &str) -> Result<Option<Value>, String> {
    let Some(user) = card_user(ctx) else { return Ok(None) };
    card_scene(app, user, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_fixture() -> Value {
        json!({
            "bridgeConnected": true,
            "hub": { "name": "Home", "accessories": 2, "lastSyncLabel": "Last sync 40 seconds ago" },
            "headline": { "lead": "Your home is ", "accent": "responding." },
            "counts": { "devices": 2, "rooms": 1, "scenes": 2, "unavailable": 1 },
            "scenes": [
                { "id": "s1", "label": "Evening", "touchesLocks": false },
                { "id": "s2", "label": "Away lock-up", "touchesLocks": true },
            ],
            "discovery": { "live": false, "scope": "", "found": [] },
            "rooms": [{
                "id": "r1", "name": "Hall", "status": "All responding", "tone": "ok",
                "devices": [
                    { "id": "d1", "name": "Front door lock", "roomId": "r1", "roomName": "Hall",
                      "kind": "lock", "control": "toggle", "value": 1.0, "state": "Locked",
                      "available": true },
                    { "id": "d2", "name": "Hall light", "roomId": "r1", "roomName": "Hall",
                      "kind": "bulb", "control": "slider", "value": 0.0, "state": "Not responding",
                      "available": false },
                ],
            }],
            "autonomy": [{ "id": "unlock", "allowed": false }],
        })
    }

    #[test]
    fn the_read_carries_the_id_every_mutating_op_needs() {
        let out = project(&snapshot_fixture());
        let devices = out["devices"]["items"].as_array().expect("a device list");
        assert_eq!(devices.len(), 2);
        // Without this the model can describe the house and command nothing.
        assert_eq!(devices[0]["device_id"], json!("d1"));
        assert_eq!(devices[0]["name"], json!("Front door lock"));
        assert_eq!(devices[0]["room"], json!("Hall"));
    }

    /// A stale reading must never reach the model as a current one.
    #[test]
    fn a_device_that_is_not_answering_says_so_in_the_projection() {
        let out = project(&snapshot_fixture());
        let devices = out["devices"]["items"].as_array().unwrap();
        let silent = devices.iter().find(|d| d["name"] == json!("Hall light")).unwrap();
        assert_eq!(silent["available"], json!(false));
        assert_eq!(silent["state"], json!("Not responding"));
    }

    /// The model is told which scenes it may run before it tries one.
    #[test]
    fn a_lock_touching_scene_is_marked_unrunnable_rather_than_hidden() {
        let out = project(&snapshot_fixture());
        let scenes = out["scenes"]["items"].as_array().unwrap();
        let evening = scenes.iter().find(|s| s["label"] == json!("Evening")).unwrap();
        let away = scenes.iter().find(|s| s["label"] == json!("Away lock-up")).unwrap();
        assert_eq!(evening["runnable_by_atlas"], json!(true));
        assert_eq!(away["runnable_by_atlas"], json!(false));
        // Hiding it would make Atlas unable to even mention the scene the user
        // asked about; marking it lets Atlas say why it will not run it.
        assert_eq!(away["scene_id"], json!("s2"));
    }

    /// A scene whose membership the bridge never published carries no
    /// `touchesLocks` at all. The projection must read that absence as "not
    /// runnable", the same way the column defaults to 1 in db_schema.sql.
    #[test]
    fn an_unknown_scene_membership_fails_closed_in_the_projection() {
        let snap = json!({
            "rooms": [], "scenes": [{ "id": "s9", "label": "Mystery" }],
        });
        let scenes = project(&snap);
        assert_eq!(scenes["scenes"]["items"][0]["runnable_by_atlas"], json!(false));
    }

    /// The page's own furniture is not worth a token to a model.
    #[test]
    fn the_ui_only_parts_of_the_snapshot_are_not_forwarded() {
        let out = project(&snapshot_fixture());
        for ui_only in ["headline", "discovery", "widgets", "rooms", "recentIds"] {
            assert!(out.get(ui_only).is_none(), "{ui_only} reached the model");
        }
    }

    #[test]
    fn a_request_with_no_identity_reads_nobodys_house() {
        let ctx = Ctx {
            user_id: String::new(),
            user_token: None,
            profile: crate::control::Profile::Background,
            request_id: "t".into(),
        };
        let err = user(&ctx).expect_err("an empty user_id is not an empty house");
        assert!(err.contains("identity"), "{err}");
    }

    /// The card readers must refuse an unidentified caller rather than fall
    /// through to a query with an empty user_id.
    #[test]
    fn a_card_for_an_unidentified_caller_resolves_to_nothing() {
        let ctx = |user: &str| Ctx {
            user_id: user.to_string(),
            user_token: None,
            profile: crate::control::Profile::Background,
            request_id: "t".into(),
        };
        assert_eq!(card_user(&ctx("")), None);
        assert_eq!(card_user(&ctx("u1")), Some("u1"));
    }

    /// The column lists registry.rs declares in OBJECT_LOOKUPS come through
    /// here, so a rename in the home module cannot silently change what an
    /// approvals card renders.
    #[test]
    fn the_card_columns_are_the_ones_the_registry_declares() {
        assert_eq!(DEVICE_CARD, ["name", "room_name"]);
        assert_eq!(SCENE_CARD, ["label"]);
    }
}
