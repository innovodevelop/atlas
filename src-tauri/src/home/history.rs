// The Beta extras' half of the local store: device detail, Home Assistant's
// machinery, the history Atlas keeps, and the modes.
//
// THE HISTORY, AND WHY ATLAS KEEPS ONE AT ALL
// Home Assistant has a history of its own, and Atlas does not copy it. What it
// cannot answer is the question the lock note asks — "did ATLAS lock this?" —
// because only Atlas knows which commands it sent. So `home_events` holds two
// things side by side: the changes the mirror saw (from a sync or a push), and
// the commands Atlas sent. A lock that locked within two minutes of Atlas
// telling it to was locked by Atlas; anything else was not, and the screen
// says only "Locked at 08:31".
//
// It is bounded on purpose: thirty days, at most 20 000 rows an account,
// pruned as it is written. Measurements (`sensor.*`) never enter it — a power
// meter reports several times a second, and the energy card reads Home
// Assistant's own statistics instead. A first sighting is not an event either:
// the mirror saw a lamp that was already on, not a lamp turning on.
//
// Every write is keyed to a bridge and cascades with it, so unlinking Home
// Assistant takes its history with it. Nothing here leaves the Mac.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::extras::{canonical_ts, DeviceDetail, HubEntityPull, PullExtras};
use super::ha::domain_of;
use super::store::BridgeRow;
use super::{BridgeKind, BridgePull, HomeError};

/// How long the history is kept.
pub const HISTORY_DAYS: i64 = 30;
/// The most rows one account keeps, whatever their age.
pub const HISTORY_MAX_ROWS: i64 = 20_000;
/// Prune once every this many inserts, not on every one.
const PRUNE_EVERY: i64 = 200;

/// The three modes. In a CHECK constraint, so these strings are schema.
pub const MODES: &[&str] = &["home", "away", "night"];

fn store_err(e: rusqlite::Error) -> HomeError {
    HomeError::Store(e.to_string())
}

fn device_id_of(conn: &Connection, bridge_id: &str, external_id: &str) -> Result<Option<(String, String)>, HomeError> {
    conn.query_row(
        "SELECT id, user_id FROM home_devices WHERE bridge_id = ?1 AND external_id = ?2",
        rusqlite::params![bridge_id, external_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(store_err)
}

// ---------------------------------------------------------------------------
// Device detail
// ---------------------------------------------------------------------------

/// Write the detail a sync read. A sync is the whole truth, so every column is
/// replaced — a thermostat switched off since the last sync loses its target.
pub fn upsert_details(conn: &Connection, bridge_id: &str, details: &[(String, DeviceDetail)]) -> Result<(), HomeError> {
    for (ext, d) in details {
        let Some((device_id, user_id)) = device_id_of(conn, bridge_id, ext)? else { continue };
        conn.execute(
            "INSERT INTO home_device_detail
               (device_id, user_id, domain, device_class, unit, state_class, target, hvac_action, hub_device_id, energy_role)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(device_id) DO UPDATE SET
               domain = excluded.domain, device_class = excluded.device_class, unit = excluded.unit,
               state_class = excluded.state_class, target = excluded.target, hvac_action = excluded.hvac_action,
               hub_device_id = excluded.hub_device_id, energy_role = excluded.energy_role,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            rusqlite::params![
                device_id, user_id, d.domain, d.device_class, d.unit, d.state_class, d.target, d.hvac_action,
                d.hub_device_id, d.energy_role
            ],
        )
        .map_err(store_err)?;
    }
    Ok(())
}

/// Write the detail a push carried: the target and the action, which a push
/// can change. The registry facts (device, energy role) only a sync knows, so
/// they are kept as the last sync left them.
pub fn update_pushed_detail(conn: &Connection, bridge_id: &str, external_id: &str, d: &DeviceDetail) -> Result<(), HomeError> {
    let Some((device_id, user_id)) = device_id_of(conn, bridge_id, external_id)? else { return Ok(()) };
    conn.execute(
        "INSERT INTO home_device_detail (device_id, user_id, domain, device_class, unit, state_class, target, hvac_action)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(device_id) DO UPDATE SET
           target = excluded.target, hvac_action = excluded.hvac_action,
           device_class = COALESCE(excluded.device_class, home_device_detail.device_class),
           unit = COALESCE(excluded.unit, home_device_detail.unit),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        rusqlite::params![device_id, user_id, d.domain, d.device_class, d.unit, d.state_class, d.target, d.hvac_action],
    )
    .map_err(store_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Readings, and which changes are history
// ---------------------------------------------------------------------------

/// What a device was doing, as far as the history cares.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Reading {
    pub value: Option<f64>,
    pub state: Option<String>,
    pub available: bool,
    pub target: Option<f64>,
    pub hvac_action: Option<String>,
}

const READING_SQL: &str = "SELECT d.external_id, s.value, s.state, COALESCE(s.available, 1), x.target, x.hvac_action
       FROM home_devices d
       LEFT JOIN home_device_state s ON s.device_id = d.id
       LEFT JOIN home_device_detail x ON x.device_id = d.id
      WHERE d.bridge_id = ?1";

fn read_reading(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, Reading)> {
    Ok((
        r.get(0)?,
        Reading {
            value: r.get(1)?,
            state: r.get(2)?,
            available: r.get::<_, i64>(3)? != 0,
            target: r.get(4)?,
            hvac_action: r.get(5)?,
        },
    ))
}

/// Every device's last reading on one bridge, by entity id.
pub fn readings(conn: &Connection, bridge_id: &str) -> Result<HashMap<String, Reading>, HomeError> {
    let mut stmt = conn.prepare(READING_SQL).map_err(store_err)?;
    let rows = stmt
        .query_map([bridge_id], read_reading)
        .map_err(store_err)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(store_err)?;
    Ok(rows)
}

pub fn reading_of(conn: &Connection, bridge_id: &str, external_id: &str) -> Result<Option<Reading>, HomeError> {
    conn.query_row(
        &format!("{READING_SQL} AND d.external_id = ?2"),
        rusqlite::params![bridge_id, external_id],
        read_reading,
    )
    .optional()
    .map(|o| o.map(|(_, r)| r))
    .map_err(store_err)
}

/// Is the step from `before` to `after` something the history keeps?
///
/// Never for a first sighting (nothing was seen to change) and never for a
/// `sensor` (a measurement, not an event). A thermostat's reading drifts by a
/// tenth of a degree all day, so for the two thermal domains only the mode,
/// the target and the action count; for everything else the value does too —
/// a lamp dimmed from 62% to 12% is something that happened.
pub fn history_worthy(domain: &str, before: Option<&Reading>, after: &Reading) -> bool {
    let Some(b) = before else { return false };
    if domain == "sensor" {
        return false;
    }
    if b.available != after.available {
        return true;
    }
    if !after.available {
        return false;
    }
    if b.state != after.state {
        return true;
    }
    match domain {
        "climate" | "water_heater" => b.target != after.target || b.hvac_action != after.hvac_action,
        _ => match (b.value, after.value) {
            (Some(x), Some(y)) => (x - y).abs() > 1e-6,
            (None, Some(_)) => true,
            _ => false,
        },
    }
}

/// When the change happened. The bridge's `last_changed` is exact for a change
/// of state or availability — that is the moment Home Assistant moved its
/// state word. A brightness or target change does not move `last_changed`, so
/// it is dated by when Atlas saw it.
pub fn event_time(before: Option<&Reading>, after: &Reading, last_changed: Option<&str>, now: &str) -> String {
    let moved = before.map(|b| b.state != after.state || b.available != after.available).unwrap_or(false);
    if moved {
        if let Some(t) = last_changed.and_then(canonical_ts) {
            return t;
        }
    }
    now.to_string()
}

/// The number an event carries: a thermostat's target, anything else's value.
fn event_value(domain: &str, r: &Reading) -> Option<f64> {
    match domain {
        "climate" | "water_heater" => r.target,
        _ => r.value,
    }
}

// ---------------------------------------------------------------------------
// Writing the history
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn insert_event(
    conn: &Connection,
    user_id: &str,
    bridge_id: &str,
    external_id: &str,
    kind: &str,
    value: Option<f64>,
    state: Option<&str>,
    available: Option<bool>,
    detail: Option<&str>,
    at: &str,
) -> Result<(), HomeError> {
    conn.execute(
        "INSERT INTO home_events (user_id, bridge_id, external_id, kind, value, state, available, detail, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![user_id, bridge_id, external_id, kind, value, state, available.map(i64::from), detail, at],
    )
    .map_err(store_err)?;
    if conn.last_insert_rowid() % PRUNE_EVERY == 0 {
        prune_events(conn, user_id, Utc::now())?;
    }
    Ok(())
}

/// One change the mirror saw.
pub fn record_state(
    conn: &Connection,
    user_id: &str,
    bridge_id: &str,
    external_id: &str,
    domain: &str,
    r: &Reading,
    at: &str,
) -> Result<(), HomeError> {
    insert_event(
        conn, user_id, bridge_id, external_id, "state", event_value(domain, r), r.state.as_deref(), Some(r.available), None, at,
    )
}

/// One command Atlas sent, whether from this screen or from the model.
#[allow(clippy::too_many_arguments)]
pub fn record_command(
    conn: &Connection,
    user_id: &str,
    bridge_id: &str,
    external_id: &str,
    value: Option<f64>,
    verb: &str,
    at: &str,
) -> Result<(), HomeError> {
    insert_event(conn, user_id, bridge_id, external_id, "command", value, None, None, Some(verb), at)
}

/// The changes one sync saw, against the readings taken before it applied.
pub fn record_pull(
    conn: &Connection,
    user_id: &str,
    bridge_id: &str,
    before: &HashMap<String, Reading>,
    pull: &BridgePull,
    extras: &PullExtras,
    now: &str,
) -> Result<usize, HomeError> {
    let details: HashMap<&str, &DeviceDetail> = extras.details.iter().map(|(k, d)| (k.as_str(), d)).collect();
    let mut n = 0;
    for d in &pull.devices {
        let prior = before.get(&d.external_id);
        let detail = details.get(d.external_id.as_str());
        let after = Reading {
            // The mirror keeps the last value when a pull reports none.
            value: d.value.or(prior.and_then(|p| p.value)),
            state: d.state.clone(),
            available: d.available,
            target: detail.and_then(|x| x.target),
            hvac_action: detail.and_then(|x| x.hvac_action.clone()),
        };
        let domain = detail.map(|x| x.domain.as_str()).unwrap_or_else(|| domain_of(&d.external_id));
        if history_worthy(domain, prior, &after) {
            let at = event_time(prior, &after, d.last_changed.as_deref(), now);
            record_state(conn, user_id, bridge_id, &d.external_id, domain, &after, &at)?;
            n += 1;
        }
    }
    Ok(n)
}

/// Apply one pushed device change: the mirror row, the detail, and the history.
///
/// Returns whether the entity was in the mirror at all — the same answer
/// `store::apply_pushed_state` gives, because a push for a device no sync has
/// named yet is not a device.
#[allow(clippy::too_many_arguments)]
pub fn apply_push(
    conn: &Connection,
    bridge_id: &str,
    external_id: &str,
    value: Option<f64>,
    state: &str,
    colour: Option<&str>,
    available: bool,
    last_changed: Option<&str>,
    detail: &DeviceDetail,
    now: &str,
) -> Result<bool, HomeError> {
    let before = reading_of(conn, bridge_id, external_id)?;
    let applied = super::store::apply_pushed_state(
        conn, bridge_id, external_id, value, Some(state), colour, available, last_changed,
    )?;
    if !applied {
        return Ok(false);
    }
    update_pushed_detail(conn, bridge_id, external_id, detail)?;
    let after = Reading {
        value: value.or(before.as_ref().and_then(|b| b.value)),
        state: Some(state.to_string()),
        available,
        target: detail.target,
        hvac_action: detail.hvac_action.clone(),
    };
    let domain = if detail.domain.is_empty() { domain_of(external_id) } else { detail.domain.as_str() };
    if history_worthy(domain, before.as_ref(), &after) {
        if let Some((_, user_id)) = device_id_of(conn, bridge_id, external_id)? {
            let at = event_time(before.as_ref(), &after, last_changed, now);
            record_state(conn, &user_id, bridge_id, external_id, domain, &after, &at)?;
        }
    }
    Ok(true)
}

/// Drop what is past the window, then what is past the row cap.
pub fn prune_events(conn: &Connection, user_id: &str, now: DateTime<Utc>) -> Result<usize, HomeError> {
    let cutoff = (now - Duration::days(HISTORY_DAYS)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let old = conn
        .execute("DELETE FROM home_events WHERE user_id = ?1 AND at < ?2", rusqlite::params![user_id, cutoff])
        .map_err(store_err)?;
    let over = conn
        .execute(
            "DELETE FROM home_events WHERE user_id = ?1 AND id NOT IN (
               SELECT id FROM home_events WHERE user_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2)",
            rusqlite::params![user_id, HISTORY_MAX_ROWS],
        )
        .map_err(store_err)?;
    Ok(old + over)
}

/// The history, newest first. `device_id` narrows it to one device (its
/// changes and the commands Atlas sent it); `since` to a window.
pub fn events(
    conn: &Connection,
    user_id: &str,
    device_id: Option<&str>,
    since: Option<&str>,
    limit: usize,
) -> Result<Vec<Value>, HomeError> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.external_id, e.kind, e.value, e.state, e.available, e.detail, e.at, d.id
               FROM home_events e
               LEFT JOIN home_devices d ON d.bridge_id = e.bridge_id AND d.external_id = e.external_id
              WHERE e.user_id = ?1
                AND (?2 IS NULL OR d.id = ?2)
                AND (?3 IS NULL OR e.at >= ?3)
              ORDER BY e.at DESC, e.id DESC
              LIMIT ?4",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map(rusqlite::params![user_id, device_id, since, limit as i64], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "externalId": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "value": r.get::<_, Option<f64>>(3)?,
                "state": r.get::<_, Option<String>>(4)?,
                "available": r.get::<_, Option<i64>>(5)?.map(|v| v != 0),
                "detail": r.get::<_, Option<String>>(6)?,
                "at": r.get::<_, String>(7)?,
                "deviceId": r.get::<_, Option<String>>(8)?,
            }))
        })
        .map_err(store_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(store_err)?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Hub entities
// ---------------------------------------------------------------------------

/// Fold a sync's automations, scripts and people in, and drop the ones the
/// bridge no longer reports — the same rule `store::apply_pull` keeps.
pub fn apply_hub(conn: &Connection, user_id: &str, bridge_id: &str, hub: &[HubEntityPull]) -> Result<(), HomeError> {
    for h in hub {
        conn.execute(
            "INSERT INTO home_hub_entities
               (id, user_id, bridge_id, external_id, domain, label, state, available, touches_locks, last_changed, last_triggered)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(bridge_id, external_id) DO UPDATE SET
               domain = excluded.domain, label = excluded.label, state = excluded.state,
               available = excluded.available, touches_locks = excluded.touches_locks,
               last_changed = excluded.last_changed, last_triggered = excluded.last_triggered,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(), user_id, bridge_id, h.external_id, h.domain, h.label, h.state,
                i64::from(h.available), i64::from(h.touches_locks), h.last_changed, h.last_triggered
            ],
        )
        .map_err(store_err)?;
    }
    let keep: Vec<&str> = hub.iter().map(|h| h.external_id.as_str()).collect();
    let placeholders = if keep.is_empty() { "''".to_string() } else { vec!["?"; keep.len()].join(",") };
    let sql = format!("DELETE FROM home_hub_entities WHERE bridge_id = ?1 AND external_id NOT IN ({placeholders})");
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&bridge_id];
    for k in &keep {
        params.push(k);
    }
    conn.execute(&sql, params.as_slice()).map_err(store_err)?;
    Ok(())
}

/// A pushed change to a hub entity Atlas already knows. The script's lock
/// verdict is NOT touched: a push carries the state, not the config.
pub fn apply_pushed_hub(conn: &Connection, bridge_id: &str, h: &HubEntityPull) -> Result<bool, HomeError> {
    let n = conn
        .execute(
            "UPDATE home_hub_entities SET state = ?3, available = ?4, label = ?5, last_changed = ?6,
               last_triggered = COALESCE(?7, last_triggered)
             WHERE bridge_id = ?1 AND external_id = ?2",
            rusqlite::params![
                bridge_id, h.external_id, h.state, i64::from(h.available), h.label, h.last_changed, h.last_triggered
            ],
        )
        .map_err(store_err)?;
    Ok(n > 0)
}

/// One hub entity of the caller's, with the bridge it lives on.
pub struct HubTarget {
    pub id: String,
    pub external_id: String,
    pub domain: String,
    pub label: String,
    pub touches_locks: bool,
    pub bridge: BridgeRow,
}

fn bridge_cols(r: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<BridgeRow> {
    let kind: String = r.get(at + 1)?;
    Ok(BridgeRow {
        id: r.get(at)?,
        kind: BridgeKind::parse(&kind).unwrap_or(BridgeKind::HomekitCompanion),
        name: r.get(at + 2)?,
        base_url: r.get(at + 3)?,
        state: r.get(at + 4)?,
        detail: r.get(at + 5)?,
    })
}

pub fn hub_target(conn: &Connection, user_id: &str, id: &str) -> Result<Option<HubTarget>, HomeError> {
    conn.query_row(
        "SELECT h.id, h.external_id, h.domain, h.label, h.touches_locks,
                b.id, b.kind, b.name, b.base_url, b.state, b.detail
           FROM home_hub_entities h JOIN home_bridges b ON b.id = h.bridge_id
          WHERE h.id = ?1 AND h.user_id = ?2",
        rusqlite::params![id, user_id],
        |r| {
            Ok(HubTarget {
                id: r.get(0)?,
                external_id: r.get(1)?,
                domain: r.get(2)?,
                label: r.get(3)?,
                touches_locks: r.get::<_, i64>(4)? != 0,
                bridge: bridge_cols(r, 5)?,
            })
        },
    )
    .optional()
    .map_err(store_err)
}

/// Refresh one hub entity's row from a state the bridge just returned.
pub fn refresh_hub_state(conn: &Connection, bridge_id: &str, external_id: &str, state: &Value) -> Result<(), HomeError> {
    if let Some(h) = super::extras::hub_entity_from_state(state, &HashMap::new(), &HashMap::new()) {
        if h.external_id == external_id {
            apply_pushed_hub(conn, bridge_id, &h)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/// A scene or a script a mode runs, resolved to something a bridge can run.
pub struct RoutineTarget {
    pub kind: String,
    pub id: String,
    pub external_id: String,
    pub label: String,
    pub touches_locks: bool,
    pub bridge: BridgeRow,
}

/// Resolve a routine by its LOCAL id: a row of `home_scenes`, or a script row
/// of `home_hub_entities`.
pub fn routine_by_id(conn: &Connection, user_id: &str, id: &str) -> Result<Option<RoutineTarget>, HomeError> {
    if let Some(s) = super::store::scene_target(conn, user_id, id)? {
        return Ok(Some(RoutineTarget {
            kind: "scene".into(),
            id: s.id,
            external_id: s.external_id,
            label: s.label,
            touches_locks: s.touches_locks,
            bridge: s.bridge,
        }));
    }
    Ok(hub_target(conn, user_id, id)?.filter(|h| h.domain == "script").map(|h| RoutineTarget {
        kind: "script".into(),
        id: h.id,
        external_id: h.external_id,
        label: h.label,
        touches_locks: h.touches_locks,
        bridge: h.bridge,
    }))
}

/// Resolve a routine by its Home Assistant id — how a mode remembers it.
pub fn routine_by_external(conn: &Connection, user_id: &str, kind: &str, external_id: &str) -> Result<Option<RoutineTarget>, HomeError> {
    let local: Option<String> = match kind {
        "scene" => conn
            .query_row(
                "SELECT id FROM home_scenes WHERE user_id = ?1 AND external_id = ?2 LIMIT 1",
                rusqlite::params![user_id, external_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)?,
        "script" => conn
            .query_row(
                "SELECT id FROM home_hub_entities WHERE user_id = ?1 AND domain = 'script' AND external_id = ?2 LIMIT 1",
                rusqlite::params![user_id, external_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_err)?,
        _ => None,
    };
    match local {
        Some(id) => routine_by_id(conn, user_id, &id),
        None => Ok(None),
    }
}

/// Map a mode to a routine, or clear it with `None`.
pub fn set_mode_map(conn: &Connection, user_id: &str, mode: &str, routine: Option<&RoutineTarget>) -> Result<(), HomeError> {
    conn.execute(
        "INSERT INTO home_modes (user_id, mode, routine_kind, routine_external_id, routine_label)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, mode) DO UPDATE SET
           routine_kind = excluded.routine_kind, routine_external_id = excluded.routine_external_id,
           routine_label = excluded.routine_label, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        rusqlite::params![
            user_id,
            mode,
            routine.map(|r| r.kind.as_str()),
            routine.map(|r| r.external_id.as_str()),
            routine.map(|r| r.label.as_str())
        ],
    )
    .map_err(store_err)?;
    Ok(())
}

/// (kind, external id, label) a mode is mapped to, if any.
pub fn mode_routine(conn: &Connection, user_id: &str, mode: &str) -> Result<Option<(String, String, String)>, HomeError> {
    conn.query_row(
        "SELECT routine_kind, routine_external_id, COALESCE(routine_label, routine_external_id)
           FROM home_modes WHERE user_id = ?1 AND mode = ?2
            AND routine_kind IS NOT NULL AND routine_external_id IS NOT NULL",
        rusqlite::params![user_id, mode],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(store_err)
}

pub fn set_current_mode(conn: &Connection, user_id: &str, mode: &str, since: &str) -> Result<(), HomeError> {
    conn.execute(
        "INSERT INTO home_mode_state (user_id, mode, since) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, since = excluded.since",
        rusqlite::params![user_id, mode, since],
    )
    .map_err(store_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The snapshot's extra fields
// ---------------------------------------------------------------------------

/// The fields `store::snapshot` adds for the Beta screen. Additive: the
/// mock's `SmartHomeSnapshot` ignores them, and the control port's projection
/// (ops_home.rs) names the fields it passes on, so none of this — who is home,
/// which automations run — reaches the model.
pub fn snapshot_extras(conn: &Connection, user_id: &str) -> Result<Map<String, Value>, HomeError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, external_id, domain, label, state, available, touches_locks, last_changed, last_triggered
               FROM home_hub_entities WHERE user_id = ?1 ORDER BY domain, label",
        )
        .map_err(store_err)?;
    struct Row {
        id: String,
        external_id: String,
        domain: String,
        label: String,
        state: Option<String>,
        available: bool,
        touches_locks: bool,
        last_changed: Option<String>,
        last_triggered: Option<String>,
    }
    let rows: Vec<Row> = stmt
        .query_map([user_id], |r| {
            Ok(Row {
                id: r.get(0)?,
                external_id: r.get(1)?,
                domain: r.get(2)?,
                label: r.get(3)?,
                state: r.get(4)?,
                available: r.get::<_, i64>(5)? != 0,
                touches_locks: r.get::<_, i64>(6)? != 0,
                last_changed: r.get(7)?,
                last_triggered: r.get(8)?,
            })
        })
        .map_err(store_err)?
        .collect::<Result<_, _>>()
        .map_err(store_err)?;

    let automations: Vec<Value> = rows
        .iter()
        .filter(|r| r.domain == "automation")
        .map(|r| {
            json!({
                "id": r.id, "externalId": r.external_id, "label": r.label,
                "on": r.state.as_deref() == Some("on"), "available": r.available,
                "lastTriggered": r.last_triggered,
            })
        })
        .collect();
    let scripts: Vec<Value> = rows
        .iter()
        .filter(|r| r.domain == "script")
        .map(|r| json!({ "id": r.id, "externalId": r.external_id, "label": r.label, "runnable": !r.touches_locks, "available": r.available }))
        .collect();
    let presence: Vec<Value> = rows
        .iter()
        .filter(|r| r.domain == "person" || r.domain == "device_tracker")
        .map(|r| {
            json!({
                "id": r.id, "name": r.label, "kind": r.domain, "state": r.state,
                "available": r.available, "lastChanged": r.last_changed,
            })
        })
        .collect();

    let current: Option<(String, String)> = conn
        .query_row("SELECT mode, since FROM home_mode_state WHERE user_id = ?1", [user_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(store_err)?;
    let mut map = Vec::new();
    for mode in MODES {
        let routine = mode_routine(conn, user_id, mode)?;
        let resolved = match &routine {
            Some((kind, ext, _)) => routine_by_external(conn, user_id, kind, ext)?,
            None => None,
        };
        map.push(json!({
            "mode": mode,
            "kind": routine.as_ref().map(|r| r.0.clone()),
            "externalId": routine.as_ref().map(|r| r.1.clone()),
            "label": routine.as_ref().map(|r| r.2.clone()),
            // The local id, so the picker can show the choice; null when the
            // routine is mapped but the bridge no longer reports it.
            "routineId": resolved.as_ref().map(|r| r.id.clone()),
            "runnable": resolved.as_ref().map(|r| !r.touches_locks),
        }));
    }

    let mut out = Map::new();
    out.insert("automations".into(), Value::Array(automations));
    out.insert("scripts".into(), Value::Array(scripts));
    out.insert("presence".into(), Value::Array(presence));
    out.insert(
        "modes".into(),
        json!({
            "current": current.as_ref().map(|c| c.0.clone()),
            "since": current.as_ref().map(|c| c.1.clone()),
            "map": map,
        }),
    );
    Ok(out)
}

/// The energy sensors on one bridge: (local device id, entity id).
pub fn energy_sensors(conn: &Connection, user_id: &str, bridge_id: &str) -> Result<Vec<(String, String)>, HomeError> {
    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.external_id FROM home_devices d JOIN home_device_detail x ON x.device_id = d.id
              WHERE d.user_id = ?1 AND d.bridge_id = ?2 AND x.domain = 'sensor' AND x.device_class = 'energy'
              ORDER BY d.name LIMIT 60",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map(rusqlite::params![user_id, bridge_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(store_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(store_err)?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::extras::{DeviceDetail, HubEntityPull};
    use crate::home::store::{apply_pull, upsert_bridge};
    use crate::home::{DevicePull, RoomPull, ScenePull};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(include_str!("../db_schema.sql")).unwrap();
        conn
    }

    fn linked(conn: &Connection) -> String {
        upsert_bridge(conn, "u1", BridgeKind::HomeAssistant, "Home Assistant", Some("http://hub.local:8123"), "connected", "Linked").unwrap()
    }

    fn device(ext: &str, value: Option<f64>, state: &str) -> DevicePull {
        DevicePull {
            external_id: ext.into(),
            name: ext.into(),
            kind: if ext.starts_with("lock.") { "lock".into() } else { "bulb".into() },
            control: if ext.starts_with("lock.") { "toggle".into() } else { "slider".into() },
            room_external_id: Some("hall".into()),
            value,
            state: Some(state.into()),
            colour: None,
            available: true,
            last_changed: Some("2026-10-28T06:31:00.000000+00:00".into()),
        }
    }

    fn pull_of(devices: Vec<DevicePull>) -> BridgePull {
        BridgePull {
            rooms: vec![RoomPull { external_id: "hall".into(), name: "Hall".into() }],
            devices,
            scenes: vec![ScenePull { external_id: "scene.evening".into(), label: "Evening".into(), touches_locks: false }],
        }
    }

    fn reading(value: Option<f64>, state: &str) -> Reading {
        Reading { value, state: Some(state.into()), available: true, ..Reading::default() }
    }

    #[test]
    fn a_first_sighting_and_a_measurement_are_not_history() {
        assert!(!history_worthy("light", None, &reading(Some(60.0), "On")));
        assert!(!history_worthy("sensor", Some(&reading(Some(100.0), "100 W")), &reading(Some(240.0), "240 W")));
        assert!(history_worthy("light", Some(&reading(Some(60.0), "On")), &reading(Some(12.0), "On")));
        assert!(history_worthy("lock", Some(&reading(Some(0.0), "Unlocked")), &reading(Some(1.0), "Locked")));
        assert!(!history_worthy("light", Some(&reading(Some(60.0), "On")), &reading(Some(60.0), "On")));
    }

    #[test]
    fn a_thermostats_drifting_reading_is_not_history_but_its_target_is() {
        let before = Reading { value: Some(20.8), state: Some("Heat".into()), available: true, target: Some(21.0), hvac_action: Some("heating".into()) };
        let drift = Reading { value: Some(20.9), ..before.clone() };
        assert!(!history_worthy("climate", Some(&before), &drift));
        let retarget = Reading { target: Some(21.5), ..before.clone() };
        assert!(history_worthy("climate", Some(&before), &retarget));
        let idle = Reading { hvac_action: Some("idle".into()), ..before.clone() };
        assert!(history_worthy("climate", Some(&before), &idle));
    }

    #[test]
    fn going_unreachable_is_history_and_staying_unreachable_is_not() {
        let up = reading(Some(1.0), "Locked");
        let down = Reading { available: false, state: Some("Not responding".into()), ..up.clone() };
        assert!(history_worthy("lock", Some(&up), &down));
        assert!(!history_worthy("lock", Some(&down), &down.clone()));
    }

    #[test]
    fn a_state_change_is_dated_by_the_bridge_and_a_dim_by_atlas() {
        let now = "2026-10-28T09:00:00.000Z";
        let before = reading(Some(0.0), "Unlocked");
        let after = reading(Some(1.0), "Locked");
        assert_eq!(event_time(Some(&before), &after, Some("2026-10-28T06:31:00+00:00"), now), "2026-10-28T06:31:00.000Z");
        let dim = reading(Some(12.0), "Unlocked");
        assert_eq!(event_time(Some(&before), &dim, Some("2026-10-28T06:31:00+00:00"), now), now);
    }

    #[test]
    fn a_sync_records_what_changed_and_the_command_that_caused_it() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull_of(vec![device("lock.front_door", Some(0.0), "Unlocked"), device("light.hall", Some(40.0), "On")])).unwrap();
        // The first sync sees nothing change.
        let before = readings(&conn, &bridge).unwrap();
        assert_eq!(before.len(), 2);

        record_command(&conn, "u1", &bridge, "lock.front_door", Some(1.0), "lock", "2026-10-28T06:30:30.000Z").unwrap();
        let second = pull_of(vec![device("lock.front_door", Some(1.0), "Locked"), device("light.hall", Some(40.0), "On")]);
        let n = record_pull(&conn, "u1", &bridge, &before, &second, &PullExtras::default(), "2026-10-28T09:00:00.000Z").unwrap();
        assert_eq!(n, 1, "only the lock moved");
        apply_pull(&mut conn, "u1", &bridge, &second).unwrap();

        let lock_id: String = conn.query_row("SELECT id FROM home_devices WHERE external_id = 'lock.front_door'", [], |r| r.get(0)).unwrap();
        let ev = events(&conn, "u1", Some(&lock_id), None, 10).unwrap();
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0]["kind"], json!("state"));
        assert_eq!(ev[0]["at"], json!("2026-10-28T06:31:00.000Z"));
        assert_eq!(ev[0]["value"], json!(1.0));
        assert_eq!(ev[1]["kind"], json!("command"));
        assert_eq!(ev[1]["detail"], json!("lock"));
        // Another account sees none of it.
        assert!(events(&conn, "u2", None, None, 10).unwrap().is_empty());
    }

    #[test]
    fn a_push_writes_the_mirror_the_target_and_the_history() {
        let mut conn = db();
        let bridge = linked(&conn);
        let mut thermostat = device("climate.hall", Some(20.8), "Heat");
        thermostat.kind = "thermostat".into();
        thermostat.control = "stepper".into();
        apply_pull(&mut conn, "u1", &bridge, &pull_of(vec![thermostat])).unwrap();
        let detail = DeviceDetail { domain: "climate".into(), target: Some(21.0), hvac_action: Some("idle".into()), hub_device_id: Some("dev-1".into()), ..DeviceDetail::default() };
        upsert_details(&conn, &bridge, &[("climate.hall".into(), detail)]).unwrap();

        let pushed = DeviceDetail { domain: "climate".into(), target: Some(21.5), hvac_action: Some("heating".into()), ..DeviceDetail::default() };
        let applied = apply_push(&conn, &bridge, "climate.hall", Some(20.9), "Heat", None, true, Some("2026-10-28T06:00:00+00:00"), &pushed, "2026-10-28T09:00:00.000Z").unwrap();
        assert!(applied);
        let (target, action, hub): (f64, String, String) = conn
            .query_row("SELECT target, hvac_action, hub_device_id FROM home_device_detail", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!((target, action.as_str()), (21.5, "heating"));
        assert_eq!(hub, "dev-1", "a push does not erase what only a sync knows");
        let ev = events(&conn, "u1", None, None, 10).unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0]["value"], json!(21.5), "a thermostat's event carries its target");

        // A push for an entity no sync has named is not a device.
        assert!(!apply_push(&conn, &bridge, "light.unknown", Some(1.0), "On", None, true, None, &DeviceDetail::default(), "2026-10-28T09:00:00.000Z").unwrap());
    }

    #[test]
    fn the_history_is_pruned_by_age_and_by_count() {
        let conn = db();
        let bridge = linked(&conn);
        let now = DateTime::parse_from_rfc3339("2026-10-28T12:00:00Z").unwrap().with_timezone(&Utc);
        record_command(&conn, "u1", &bridge, "light.a", Some(1.0), "turn_on", "2026-09-01T00:00:00.000Z").unwrap();
        record_command(&conn, "u1", &bridge, "light.a", Some(0.0), "turn_off", "2026-10-27T00:00:00.000Z").unwrap();
        assert_eq!(prune_events(&conn, "u1", now).unwrap(), 1);
        assert_eq!(events(&conn, "u1", None, None, 10).unwrap().len(), 1);
    }

    #[test]
    fn unlinking_the_bridge_takes_its_history_and_machinery_with_it() {
        let conn = db();
        let bridge = linked(&conn);
        record_command(&conn, "u1", &bridge, "light.a", Some(1.0), "turn_on", "2026-10-27T00:00:00.000Z").unwrap();
        apply_hub(&conn, "u1", &bridge, &[HubEntityPull {
            external_id: "automation.morning".into(), domain: "automation".into(), label: "Morning".into(), state: "on".into(),
            available: true, touches_locks: true, last_changed: None, last_triggered: None,
        }]).unwrap();
        crate::home::store::delete_bridge(&conn, "u1", BridgeKind::HomeAssistant).unwrap();
        let n: i64 = conn.query_row("SELECT (SELECT COUNT(*) FROM home_events) + (SELECT COUNT(*) FROM home_hub_entities)", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn hub_entities_sync_push_and_prune() {
        let conn = db();
        let bridge = linked(&conn);
        let auto = |state: &str| HubEntityPull {
            external_id: "automation.morning".into(), domain: "automation".into(), label: "Morning".into(), state: state.into(),
            available: true, touches_locks: true, last_changed: None, last_triggered: Some("2026-10-28T06:30:00+00:00".into()),
        };
        let script = HubEntityPull {
            external_id: "script.lights_out".into(), domain: "script".into(), label: "Lights out".into(), state: "off".into(),
            available: true, touches_locks: false, last_changed: None, last_triggered: None,
        };
        apply_hub(&conn, "u1", &bridge, &[auto("on"), script.clone()]).unwrap();
        let snap = snapshot_extras(&conn, "u1").unwrap();
        assert_eq!(snap["automations"][0]["on"], json!(true));
        assert_eq!(snap["scripts"][0]["runnable"], json!(true));

        // A push flips the automation and keeps the script's verdict.
        assert!(apply_pushed_hub(&conn, &bridge, &auto("off")).unwrap());
        let pushed_script = HubEntityPull { touches_locks: true, state: "on".into(), ..script.clone() };
        apply_pushed_hub(&conn, &bridge, &pushed_script).unwrap();
        let snap = snapshot_extras(&conn, "u1").unwrap();
        assert_eq!(snap["automations"][0]["on"], json!(false));
        assert_eq!(snap["scripts"][0]["runnable"], json!(true));

        // A sync that no longer reports the automation drops it.
        apply_hub(&conn, "u1", &bridge, &[script]).unwrap();
        let snap = snapshot_extras(&conn, "u1").unwrap();
        assert!(snap["automations"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_mode_remembers_its_routine_by_home_assistant_id_and_resolves_it() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull_of(vec![])).unwrap();
        let scene_id: String = conn.query_row("SELECT id FROM home_scenes", [], |r| r.get(0)).unwrap();
        let routine = routine_by_id(&conn, "u1", &scene_id).unwrap().unwrap();
        assert_eq!((routine.kind.as_str(), routine.external_id.as_str()), ("scene", "scene.evening"));
        set_mode_map(&conn, "u1", "night", Some(&routine)).unwrap();
        set_current_mode(&conn, "u1", "night", "2026-10-28T22:00:00.000Z").unwrap();

        let snap = snapshot_extras(&conn, "u1").unwrap();
        assert_eq!(snap["modes"]["current"], json!("night"));
        let night = snap["modes"]["map"].as_array().unwrap().iter().find(|m| m["mode"] == json!("night")).unwrap().clone();
        assert_eq!(night["label"], json!("Evening"));
        assert_eq!(night["routineId"], json!(scene_id));
        assert_eq!(night["runnable"], json!(true));
        let home = snap["modes"]["map"].as_array().unwrap().iter().find(|m| m["mode"] == json!("home")).unwrap().clone();
        assert_eq!(home["kind"], Value::Null);

        // Another account's scene is not a routine this one can map.
        assert!(routine_by_id(&conn, "u2", &scene_id).unwrap().is_none());
        set_mode_map(&conn, "u1", "night", None).unwrap();
        assert!(mode_routine(&conn, "u1", "night").unwrap().is_none());
    }
}
