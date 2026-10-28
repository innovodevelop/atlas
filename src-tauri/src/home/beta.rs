// The Beta Smart Home's commands: the history, today's energy, a camera's
// still frame, the automation switches, and the Home / Away / Night modes.
//
// THE SAME RULES AS mod.rs, ONE BY ONE
//   * Every command is `#[tauri::command(async)]` — LAN and SQLite work stays
//     off the main thread (the test at the bottom scans this file for it).
//   * Network calls go only to the linked Home Assistant on the LAN, with the
//     token read from the Keychain in `ha_for` and never returned.
//   * The lock rule holds: a mode can only run a scene or script Atlas can
//     prove contains no lock (`scene_run_allowed`), checked when the mode is
//     mapped AND again when it runs, since a script can change in between.
//
// NONE OF THESE IS ON THE CONTROL PORT. ops_home.rs names the commands the
// model can reach, and these are not among them: an automation is a standing
// rule that runs unattended, so arming one is the user's click on this
// screen, not something a model decides. The approval policy the bridge
// already has — Actuate for lights, Approval for locks, refusal for anything
// that might reach a lock — is left exactly as it was.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::{
    active_bridge, adapter_for, changed, extras, ha_for, history, now_iso, record_sent, scene_run_allowed, store,
    BridgeKind,
};
use crate::db::DbState;

/// The most history rows one call returns.
const HISTORY_LIMIT_MAX: u32 = 500;

fn check_mode(mode: &str) -> Result<(), String> {
    if history::MODES.contains(&mode) {
        Ok(())
    } else {
        Err(format!("'{mode}' is not a mode. The modes are Home, Away and Night."))
    }
}

/// The history Atlas keeps, newest first: what the devices did and what Atlas
/// told them to do. Optionally one device's, optionally since a moment.
#[tauri::command(async)]
pub fn home_history(
    state: State<'_, DbState>,
    user_id: String,
    device_id: Option<String>,
    since: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let since = match since.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(extras::canonical_ts(s).ok_or_else(|| "'since' must be an ISO timestamp".to_string())?),
        None => None,
    };
    let device_id = device_id.filter(|d| !d.trim().is_empty());
    let limit = limit.unwrap_or(100).clamp(1, HISTORY_LIMIT_MAX) as usize;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let events = history::events(&conn, &user_id, device_id.as_deref(), since.as_deref(), limit).map_err(String::from)?;
    Ok(json!({ "events": events, "keptDays": history::HISTORY_DAYS }))
}

/// Local midnight on this Mac, in UTC, for the statistics query.
fn local_midnight_iso() -> Option<String> {
    let now = chrono::Local::now();
    let midnight = now.date_naive().and_hms_opt(0, 0, 0)?;
    let local = midnight.and_local_timezone(chrono::Local).earliest()?;
    Some(local.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// Today's kWh per energy sensor, from Home Assistant's statistics.
///
/// One WebSocket session to the bridge, only when the mirror holds energy
/// sensors at all — a house without one costs no traffic. Which sensors make
/// the card's headline (the house's meter, or the devices behind it) is the
/// surface's decision, from the roles each sensor carries in the snapshot.
#[tauri::command(async)]
pub fn home_energy_today(state: State<'_, DbState>, user_id: String) -> Result<Value, String> {
    let (bridge, sensors) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let bridge = active_bridge(&conn, &user_id).map_err(String::from)?;
        let sensors = history::energy_sensors(&conn, &user_id, &bridge.id).map_err(String::from)?;
        (bridge, sensors)
    };
    let at = now_iso();
    if bridge.kind != BridgeKind::HomeAssistant || sensors.is_empty() {
        return Ok(json!({ "at": at, "since": Value::Null, "sensors": [] }));
    }
    let midnight = local_midnight_iso().ok_or_else(|| "this Mac's clock has no midnight today".to_string())?;
    let ids: Vec<String> = sensors.iter().map(|(_, ext)| ext.clone()).collect();
    let rows = ha_for(&bridge).and_then(|h| h.energy_today(&ids, &midnight)).map_err(String::from)?;
    let out: Vec<Value> = sensors
        .iter()
        .map(|(device_id, ext)| {
            let row = rows.iter().find(|(id, _, _)| id == ext);
            json!({
                "deviceId": device_id,
                "externalId": ext,
                "kwh": row.and_then(|r| r.1),
                "hours": row.map(|r| extras::hour_buckets(&r.2, &chrono::Local)).unwrap_or_else(|| vec![None; 24]),
            })
        })
        .collect();
    Ok(json!({ "at": at, "since": midnight, "sensors": out }))
}

/// One still frame from a camera, fetched from the hub when asked.
///
/// Never polled and never kept: the image goes to the webview as a data URL
/// and lives as long as the component that asked for it. Recordings stay on
/// the hub; Atlas stores no frame anywhere.
#[tauri::command(async)]
pub fn home_camera_still(state: State<'_, DbState>, user_id: String, device_id: String) -> Result<Value, String> {
    let target = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        store::device_target(&conn, &user_id, &device_id)
            .map_err(String::from)?
            .ok_or_else(|| "that camera is not in Atlas' home store".to_string())?
    };
    if target.kind != "camera" {
        return Err(format!("'{}' is not a camera.", target.name));
    }
    let (bytes, kind) = ha_for(&target.bridge).and_then(|h| h.camera_still(&target.external_id)).map_err(String::from)?;
    // The type goes into a data URL; only a plain media type may.
    let kind = if kind.chars().all(|c| c.is_ascii_alphanumeric() || "/+.-".contains(c)) { kind } else { "image/jpeg".into() };
    Ok(json!({ "dataUrl": format!("data:{kind};base64,{}", STANDARD.encode(bytes)), "at": now_iso() }))
}

/// Switch one Home Assistant automation on or off — the user's click on the
/// Smart Home screen, which is the consent. See the header for why the model
/// has no way here.
#[tauri::command(async)]
pub fn home_automation_set(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    automation_id: String,
    on: bool,
) -> Result<Value, String> {
    let target = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        history::hub_target(&conn, &user_id, &automation_id)
            .map_err(String::from)?
            .filter(|h| h.domain == "automation")
            .ok_or_else(|| "that automation is not in Atlas' home store".to_string())?
    };
    let client = ha_for(&target.bridge).map_err(String::from)?;
    client.set_automation(&target.external_id, on).map_err(String::from)?;
    // Read it back, so the switch shows what Home Assistant now says rather
    // than what was asked. A failed read is not a failed command: the push
    // channel or the next sync will bring the state.
    let fresh = client.state_of(&target.external_id);
    record_sent(&state, &user_id, &target.bridge.id, &target.external_id, Some(if on { 1.0 } else { 0.0 }), if on { "turn_on" } else { "turn_off" });
    if let Ok(v) = fresh {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        if let Err(e) = history::refresh_hub_state(&conn, &target.bridge.id, &target.external_id, &v) {
            log::warn!("[home] the automation switched but its row did not refresh: {e}");
        }
    }
    changed(&app, "home_hub_entities");
    Ok(json!({ "automation": target.label, "on": on }))
}

/// Map a mode to a scene or script (`routine_id`, a local id), or clear it.
///
/// A routine Atlas may not run is refused HERE, when it is chosen, rather
/// than on the evening you switch to Night and nothing happens.
#[tauri::command(async)]
pub fn home_mode_map(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    mode: String,
    routine_id: Option<String>,
) -> Result<Value, String> {
    check_mode(&mode)?;
    let label = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        match routine_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None => {
                history::set_mode_map(&conn, &user_id, &mode, None).map_err(String::from)?;
                None
            }
            Some(id) => {
                let r = history::routine_by_id(&conn, &user_id, id)
                    .map_err(String::from)?
                    .ok_or_else(|| "that scene or script is not in Atlas' home store".to_string())?;
                scene_run_allowed(r.touches_locks, &r.label)?;
                history::set_mode_map(&conn, &user_id, &mode, Some(&r)).map_err(String::from)?;
                Some(r.label)
            }
        }
    };
    changed(&app, "home_modes");
    Ok(json!({ "mode": mode, "routine": label }))
}

/// Switch the house to a mode, running the scene or script mapped to it.
///
/// The mode is recorded only once the routine ran (or when there is none to
/// run): "Away" on the screen while the lights stayed on would be the screen
/// claiming something the house did not do.
#[tauri::command(async)]
pub fn home_mode_set(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    mode: String,
) -> Result<Value, String> {
    check_mode(&mode)?;
    let routine = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        match history::mode_routine(&conn, &user_id, &mode).map_err(String::from)? {
            Some((kind, ext, label)) => Some(
                history::routine_by_external(&conn, &user_id, &kind, &ext)
                    .map_err(String::from)?
                    .ok_or_else(|| format!("'{label}' is no longer reported by your bridge. Choose another for this mode."))?,
            ),
            None => None,
        }
    };
    if let Some(r) = &routine {
        scene_run_allowed(r.touches_locks, &r.label)?;
        match r.kind.as_str() {
            "scene" => adapter_for(&r.bridge).and_then(|a| a.run_scene(&r.external_id)),
            _ => ha_for(&r.bridge).and_then(|h| h.run_script(&r.external_id)),
        }
        .map_err(String::from)?;
        record_sent(&state, &user_id, &r.bridge.id, &r.external_id, None, "run");
    }
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        history::set_current_mode(&conn, &user_id, &mode, &now_iso()).map_err(String::from)?;
    }
    changed(&app, "home_modes");
    Ok(json!({ "mode": mode, "ran": routine.as_ref().map(|r| r.label.clone()) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same check mod.rs makes of itself: every command here leaves the
    /// main thread, because every one does LAN or SQLite work.
    #[test]
    fn every_command_in_this_file_leaves_the_main_thread() {
        let src = include_str!("beta.rs");
        let mut commands = 0usize;
        for (i, line) in src.lines().enumerate() {
            let trimmed = line.trim();
            if !trimmed.starts_with("#[tauri::command") {
                continue;
            }
            commands += 1;
            assert_eq!(trimmed, "#[tauri::command(async)]", "line {}: runs on the main thread", i + 1);
        }
        assert!(commands >= 6, "only {commands} commands found; the scan is not looking at the file");
    }

    /// None of these may be reachable from the control port. ops_home.rs is
    /// the only runner file that reaches the home module; it must not name them.
    #[test]
    fn no_beta_command_is_on_the_control_port() {
        let ops = include_str!("../control/ops_home.rs");
        for cmd in ["home_history", "home_energy_today", "home_camera_still", "home_automation_set", "home_mode_map", "home_mode_set"] {
            assert!(!ops.contains(cmd), "{cmd} is reachable from the control port");
        }
    }

    #[test]
    fn only_the_three_modes_are_modes() {
        for m in ["home", "away", "night"] {
            assert!(check_mode(m).is_ok());
        }
        for bad in ["Home", "vacation", "", "away; DROP TABLE"] {
            assert!(check_mode(bad).is_err());
        }
    }
}
