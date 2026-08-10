// The local mirror: everything the smart-home surface reads comes from these
// five tables, never from a live device call.
//
// WHY A MIRROR AT ALL, when the bridge is on the same LAN
// Three reasons, and the third is the product one. (1) The page renders rooms,
// devices and scenes together; served live that is one HTTP round trip per
// paint, on a hub that runs on a Raspberry Pi. (2) The control port's read tier
// must not put traffic on the user's home network 60 times a minute. (3) When
// the bridge is unreachable, a mirror can still say WHAT the house contains and
// mark it stale — which is a true answer — where a live-only surface has to
// show nothing at all and cannot tell "no devices" from "no bridge".
//
// Staleness is therefore first-class, not an afterthought: every projection
// below carries `available`, and the bridge's own `detail` line says in words
// when Atlas last heard from it. Nothing here ever invents a value for a device
// it has not heard from.

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::{BridgeKind, BridgePull, HomeError};

/// How many devices the "recent" strip carries. The design shows a single row;
/// beyond a dozen it stops being "recent" and becomes a second device list.
const RECENT_LIMIT: usize = 12;

fn store_err(e: rusqlite::Error) -> HomeError {
    HomeError::Store(e.to_string())
}

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

/// A linked bridge as the rest of the module needs it.
#[derive(Debug, Clone)]
pub struct BridgeRow {
    pub id: String,
    pub kind: BridgeKind,
    pub name: String,
    pub base_url: Option<String>,
    pub state: String,
    /// The sentence shown under the bridge name. Carried on the row rather than
    /// recomposed at render time, because it records what happened the last
    /// time Atlas talked to this bridge — including which KIND of failure it
    /// was, which `state` alone flattens away once the surface maps it down to
    /// the mock's two-valued `Bridge.state`.
    pub detail: Option<String>,
}

impl BridgeRow {
    pub fn is_connected(&self) -> bool {
        self.state == "connected"
    }

    /// The detail line, or a plain description of the stored state when a
    /// bridge has none yet. Never an invented status.
    pub fn detail_or_default(&self) -> String {
        match self.detail.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            Some(d) => d.to_string(),
            None if self.is_connected() => "Two-way · local network".to_string(),
            None => "Not linked".to_string(),
        }
    }
}

/// Create or update the bridge row for (user, kind) and return its id.
///
/// The unique index on (user_id, kind) is what makes this an upsert rather than
/// a duplicate: linking the same Home Assistant twice is a mistake, not a
/// second house.
pub fn upsert_bridge(
    conn: &Connection,
    user_id: &str,
    kind: BridgeKind,
    name: &str,
    base_url: Option<&str>,
    state: &str,
    detail: &str,
) -> Result<String, HomeError> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO home_bridges (id, user_id, kind, name, base_url, state, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(user_id, kind) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           state = excluded.state,
           detail = excluded.detail,
           last_error = NULL",
        rusqlite::params![id, user_id, kind.as_str(), name, base_url, state, detail],
    )
    .map_err(store_err)?;
    bridge_of_kind(conn, user_id, kind)?
        .map(|b| b.id)
        .ok_or_else(|| HomeError::Store("the bridge row vanished immediately after upsert".into()))
}

pub fn bridge_of_kind(
    conn: &Connection,
    user_id: &str,
    kind: BridgeKind,
) -> Result<Option<BridgeRow>, HomeError> {
    conn.query_row(
        "SELECT id, kind, name, base_url, state, detail FROM home_bridges WHERE user_id = ?1 AND kind = ?2",
        rusqlite::params![user_id, kind.as_str()],
        read_bridge,
    )
    .optional()
    .map_err(store_err)
}

pub fn bridges(conn: &Connection, user_id: &str) -> Result<Vec<BridgeRow>, HomeError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, name, base_url, state, detail FROM home_bridges WHERE user_id = ?1 ORDER BY kind",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map([user_id], read_bridge)
        .map_err(store_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(store_err)?;
    Ok(rows)
}

fn read_bridge(r: &rusqlite::Row<'_>) -> rusqlite::Result<BridgeRow> {
    let kind: String = r.get(1)?;
    Ok(BridgeRow {
        id: r.get(0)?,
        // An unrecognised kind cannot happen while the CHECK constraint holds;
        // if it ever does, treat it as the companion (which does nothing) rather
        // than as a bridge we would start calling.
        kind: BridgeKind::parse(&kind).unwrap_or(BridgeKind::HomekitCompanion),
        name: r.get(2)?,
        base_url: r.get(3)?,
        state: r.get(4)?,
        detail: r.get(5)?,
    })
}

/// Record what actually happened when Atlas last talked to a bridge.
///
/// `detail` is the sentence the UI shows under the bridge name, and it is
/// composed from a real outcome every time — there is no path here that writes
/// an optimistic "Connected" for a bridge nobody reached.
pub fn set_bridge_health(
    conn: &Connection,
    bridge_id: &str,
    state: &str,
    detail: &str,
    last_error: Option<&str>,
) -> Result<(), HomeError> {
    conn.execute(
        "UPDATE home_bridges SET state = ?2, detail = ?3, last_error = ?4 WHERE id = ?1",
        rusqlite::params![bridge_id, state, detail, last_error],
    )
    .map_err(store_err)?;
    Ok(())
}

pub fn mark_synced(conn: &Connection, bridge_id: &str, at: &str) -> Result<(), HomeError> {
    conn.execute(
        "UPDATE home_bridges SET last_sync_at = ?2 WHERE id = ?1",
        rusqlite::params![bridge_id, at],
    )
    .map_err(store_err)?;
    Ok(())
}

/// Remove a bridge and, by cascade, everything it contributed.
pub fn delete_bridge(conn: &Connection, user_id: &str, kind: BridgeKind) -> Result<bool, HomeError> {
    let n = conn
        .execute(
            "DELETE FROM home_bridges WHERE user_id = ?1 AND kind = ?2",
            rusqlite::params![user_id, kind.as_str()],
        )
        .map_err(store_err)?;
    Ok(n > 0)
}

// ---------------------------------------------------------------------------
// Applying a pull
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PullReport {
    pub rooms: usize,
    pub devices: usize,
    pub scenes: usize,
    pub removed: usize,
}

/// Fold one bridge pull into the mirror, idempotently.
///
/// IDEMPOTENT IS THE WHOLE REQUIREMENT. A sync runs on a timer, on app launch,
/// and whenever the user asks; running it twice must not duplicate a room,
/// re-key a device, or move a value that did not move at the bridge. Every
/// write is keyed on (bridge_id, external_id), which is the bridge's own
/// identifier and therefore stable across syncs — the local uuid is generated
/// once, on first sight, and never again.
///
/// Anything the bridge no longer reports is REMOVED rather than left behind: a
/// device that was unpaired at the hub is not "offline", it is gone, and
/// showing it as offline forever would be Atlas asserting a device exists on
/// the strength of having once seen it.
pub fn apply_pull(
    conn: &mut Connection,
    user_id: &str,
    bridge_id: &str,
    pull: &BridgePull,
) -> Result<PullReport, HomeError> {
    let tx = conn.transaction().map_err(store_err)?;
    let mut report = PullReport::default();

    for (i, room) in pull.rooms.iter().enumerate() {
        tx.execute(
            "INSERT INTO home_rooms (id, user_id, bridge_id, external_id, name, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(bridge_id, external_id) DO UPDATE SET
               name = excluded.name, sort_order = excluded.sort_order",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                user_id,
                bridge_id,
                room.external_id,
                room.name,
                i as i64
            ],
        )
        .map_err(store_err)?;
        report.rooms += 1;
    }

    for device in &pull.devices {
        let room_id: Option<String> = match &device.room_external_id {
            Some(ext) => tx
                .query_row(
                    "SELECT id FROM home_rooms WHERE bridge_id = ?1 AND external_id = ?2",
                    rusqlite::params![bridge_id, ext],
                    |r| r.get(0),
                )
                .optional()
                .map_err(store_err)?,
            None => None,
        };
        tx.execute(
            "INSERT INTO home_devices (id, user_id, bridge_id, room_id, external_id, name, kind, control)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(bridge_id, external_id) DO UPDATE SET
               room_id = excluded.room_id, name = excluded.name,
               kind = excluded.kind, control = excluded.control",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                user_id,
                bridge_id,
                room_id,
                device.external_id,
                device.name,
                device.kind,
                device.control
            ],
        )
        .map_err(store_err)?;

        let device_id: String = tx
            .query_row(
                "SELECT id FROM home_devices WHERE bridge_id = ?1 AND external_id = ?2",
                rusqlite::params![bridge_id, device.external_id],
                |r| r.get(0),
            )
            .map_err(store_err)?;

        // `value` is only overwritten when the bridge reported one. A pull that
        // says "unavailable" must not erase the last number Atlas knew — the
        // projection marks it stale instead, which is more useful than a blank.
        tx.execute(
            "INSERT INTO home_device_state (device_id, user_id, value, state, colour, available, last_changed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(device_id) DO UPDATE SET
               value = COALESCE(excluded.value, home_device_state.value),
               state = excluded.state,
               colour = COALESCE(excluded.colour, home_device_state.colour),
               available = excluded.available,
               last_changed = excluded.last_changed,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            rusqlite::params![
                device_id,
                user_id,
                device.value,
                device.state,
                device.colour,
                i64::from(device.available),
                device.last_changed
            ],
        )
        .map_err(store_err)?;
        report.devices += 1;
    }

    for scene in &pull.scenes {
        tx.execute(
            "INSERT INTO home_scenes (id, user_id, bridge_id, external_id, label, touches_locks)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(bridge_id, external_id) DO UPDATE SET
               label = excluded.label, touches_locks = excluded.touches_locks",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                user_id,
                bridge_id,
                scene.external_id,
                scene.label,
                i64::from(scene.touches_locks)
            ],
        )
        .map_err(store_err)?;
        report.scenes += 1;
    }

    report.removed += prune(&tx, "home_devices", bridge_id, pull.devices.iter().map(|d| d.external_id.as_str()))?;
    report.removed += prune(&tx, "home_scenes", bridge_id, pull.scenes.iter().map(|s| s.external_id.as_str()))?;
    report.removed += prune(&tx, "home_rooms", bridge_id, pull.rooms.iter().map(|r| r.external_id.as_str()))?;

    tx.commit().map_err(store_err)?;
    Ok(report)
}

/// Delete this bridge's rows in `table` whose external id is not in `keep`.
///
/// `table` is a compile-time literal at every call site — it is never caller
/// text — because it cannot be bound as a parameter.
fn prune<'a>(
    tx: &rusqlite::Transaction<'_>,
    table: &'static str,
    bridge_id: &str,
    keep: impl Iterator<Item = &'a str>,
) -> Result<usize, HomeError> {
    let keep: Vec<&str> = keep.collect();
    let placeholders = if keep.is_empty() {
        // `NOT IN ()` is a syntax error, and `NOT IN (NULL)` is never true —
        // both would silently keep every row. An empty pull means the bridge
        // reports nothing, so everything it once contributed goes.
        String::from("''")
    } else {
        vec!["?"; keep.len()].join(",")
    };
    let sql = format!(
        "DELETE FROM {table} WHERE bridge_id = ?1 AND external_id NOT IN ({placeholders})"
    );
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&bridge_id];
    for k in &keep {
        params.push(k);
    }
    tx.execute(&sql, params.as_slice()).map_err(store_err)
}

/// Apply one pushed state change from the live channel.
///
/// Returns false when the entity is not in the mirror. That is not an error: a
/// newly paired device pushes state before any sync has named it, and inventing
/// a device row from a state event would create a device with no room, no kind
/// and no control affordance. The next sync picks it up properly.
#[allow(clippy::too_many_arguments)]
pub fn apply_pushed_state(
    conn: &Connection,
    bridge_id: &str,
    external_id: &str,
    value: Option<f64>,
    state: Option<&str>,
    colour: Option<&str>,
    available: bool,
    last_changed: Option<&str>,
) -> Result<bool, HomeError> {
    let device: Option<(String, String)> = conn
        .query_row(
            "SELECT id, user_id FROM home_devices WHERE bridge_id = ?1 AND external_id = ?2",
            rusqlite::params![bridge_id, external_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(store_err)?;
    let Some((device_id, user_id)) = device else {
        return Ok(false);
    };
    conn.execute(
        "INSERT INTO home_device_state (device_id, user_id, value, state, colour, available, last_changed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(device_id) DO UPDATE SET
           value = COALESCE(excluded.value, home_device_state.value),
           state = excluded.state,
           colour = COALESCE(excluded.colour, home_device_state.colour),
           available = excluded.available,
           last_changed = excluded.last_changed,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        rusqlite::params![
            device_id,
            user_id,
            value,
            state,
            colour,
            i64::from(available),
            last_changed
        ],
    )
    .map_err(store_err)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Targets — resolving a local id to something a bridge can be told about
// ---------------------------------------------------------------------------

/// Everything needed to command one device: which bridge, which entity, and
/// what kind of thing it is (which is what the lock rule turns on).
#[derive(Debug, Clone)]
pub struct DeviceTarget {
    pub id: String,
    pub name: String,
    pub external_id: String,
    pub kind: String,
    pub control: String,
    pub bridge: BridgeRow,
}

pub fn device_target(
    conn: &Connection,
    user_id: &str,
    device_id: &str,
) -> Result<Option<DeviceTarget>, HomeError> {
    conn.query_row(
        "SELECT d.id, d.name, d.external_id, d.kind, d.control,
                b.id, b.kind, b.name, b.base_url, b.state, b.detail
           FROM home_devices d JOIN home_bridges b ON b.id = d.bridge_id
          WHERE d.id = ?1 AND d.user_id = ?2",
        rusqlite::params![device_id, user_id],
        |r| {
            let bridge_kind: String = r.get(6)?;
            Ok(DeviceTarget {
                id: r.get(0)?,
                name: r.get(1)?,
                external_id: r.get(2)?,
                kind: r.get(3)?,
                control: r.get(4)?,
                bridge: BridgeRow {
                    id: r.get(5)?,
                    kind: BridgeKind::parse(&bridge_kind).unwrap_or(BridgeKind::HomekitCompanion),
                    name: r.get(7)?,
                    base_url: r.get(8)?,
                    state: r.get(9)?,
                    detail: r.get(10)?,
                },
            })
        },
    )
    .optional()
    .map_err(store_err)
}

#[derive(Debug, Clone)]
pub struct SceneTarget {
    pub id: String,
    pub label: String,
    pub external_id: String,
    pub touches_locks: bool,
    pub bridge: BridgeRow,
}

pub fn scene_target(
    conn: &Connection,
    user_id: &str,
    scene_id: &str,
) -> Result<Option<SceneTarget>, HomeError> {
    conn.query_row(
        "SELECT s.id, s.label, s.external_id, s.touches_locks,
                b.id, b.kind, b.name, b.base_url, b.state, b.detail
           FROM home_scenes s JOIN home_bridges b ON b.id = s.bridge_id
          WHERE s.id = ?1 AND s.user_id = ?2",
        rusqlite::params![scene_id, user_id],
        |r| {
            let bridge_kind: String = r.get(5)?;
            Ok(SceneTarget {
                id: r.get(0)?,
                label: r.get(1)?,
                external_id: r.get(2)?,
                touches_locks: r.get::<_, i64>(3)? != 0,
                bridge: BridgeRow {
                    id: r.get(4)?,
                    kind: BridgeKind::parse(&bridge_kind).unwrap_or(BridgeKind::HomekitCompanion),
                    name: r.get(6)?,
                    base_url: r.get(7)?,
                    state: r.get(8)?,
                    detail: r.get(9)?,
                },
            })
        },
    )
    .optional()
    .map_err(store_err)
}

// ---------------------------------------------------------------------------
// The approvals card
// ---------------------------------------------------------------------------

/// The device row an approvals card may show. `room_name` is joined rather than
/// stored on the device so the two can never disagree — the card has to be able
/// to say WHICH front door, and two houses' worth of "Ceiling light" is exactly
/// the case where a name alone is not consent.
pub fn device_card(
    conn: &Connection,
    user_id: &str,
    device_id: &str,
) -> Result<Option<Value>, HomeError> {
    conn.query_row(
        "SELECT d.name, COALESCE(r.name, 'No room')
           FROM home_devices d LEFT JOIN home_rooms r ON r.id = d.room_id
          WHERE d.id = ?1 AND d.user_id = ?2",
        rusqlite::params![device_id, user_id],
        |r| {
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "room_name": r.get::<_, String>(1)?,
            }))
        },
    )
    .optional()
    .map_err(store_err)
}

pub fn scene_card(
    conn: &Connection,
    user_id: &str,
    scene_id: &str,
) -> Result<Option<Value>, HomeError> {
    conn.query_row(
        "SELECT label FROM home_scenes WHERE id = ?1 AND user_id = ?2",
        rusqlite::params![scene_id, user_id],
        |r| Ok(json!({ "label": r.get::<_, String>(0)? })),
    )
    .optional()
    .map_err(store_err)
}

// ---------------------------------------------------------------------------
// The snapshot the surface renders
// ---------------------------------------------------------------------------

/// "40 seconds ago" / "2 hours ago". Pure, and `now` is a parameter so the test
/// does not depend on the wall clock.
fn relative(iso: &str, now: DateTime<Utc>) -> Option<String> {
    let then = DateTime::parse_from_rfc3339(iso).ok()?.with_timezone(&Utc);
    let secs = (now - then).num_seconds();
    if secs < 0 {
        // A clock that ran backwards is not a duration anyone should read.
        return None;
    }
    Some(match secs {
        0..=1 => "just now".to_string(),
        2..=59 => format!("{secs} seconds ago"),
        60..=119 => "a minute ago".to_string(),
        120..=3599 => format!("{} minutes ago", secs / 60),
        3600..=7199 => "an hour ago".to_string(),
        7200..=86399 => format!("{} hours ago", secs / 3600),
        86400..=172_799 => "yesterday".to_string(),
        _ => format!("{} days ago", secs / 86400),
    })
}

struct DeviceRow {
    id: String,
    name: String,
    room_id: Option<String>,
    kind: String,
    control: String,
    value: Option<f64>,
    state: Option<String>,
    colour: Option<String>,
    available: bool,
    last_changed: Option<String>,
}

/// Build the payload `useSmartHome()` turns into `SmartHomeState.snapshot`.
///
/// The field names here are the ones in `src/lib/mocks/smartHome.ts`, because
/// the mock IS the contract: the page and its three components are bound to
/// those names, and a real adapter that renamed one would be a redesign wearing
/// a backend's clothes.
///
/// THREE FIELDS ARE HONESTLY EMPTY AND STAY THAT WAY:
///   `widgets`   — a widget is an editorial summary ("Energy · 4.1 kWh today"),
///                 and nothing in these tables is an energy history. Emitting a
///                 plausible one is the fabrication this product refuses, so the
///                 list is empty and the page renders its own empty state.
///   `discovery` — Atlas has no discovery stack: no mDNS responder, no Matter
///                 commissioner, no Thread border router. `live: false` with no
///                 results is the true answer, and it is what the mock says too.
///   `autonomy`  — composed in mod.rs from what Rust actually enforces, not
///                 from a preferences table, so it cannot drift from the tiers.
pub fn snapshot(
    conn: &Connection,
    user_id: &str,
    now: DateTime<Utc>,
    autonomy: Value,
    extra_bridges: Vec<Value>,
) -> Result<Value, HomeError> {
    let bridge_rows = bridges(conn, user_id)?;

    let mut rooms_stmt = conn
        .prepare(
            "SELECT id, name FROM home_rooms WHERE user_id = ?1 ORDER BY sort_order, name",
        )
        .map_err(store_err)?;
    let room_list: Vec<(String, String)> = rooms_stmt
        .query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(store_err)?
        .collect::<Result<_, _>>()
        .map_err(store_err)?;

    let mut dev_stmt = conn
        .prepare(
            "SELECT d.id, d.name, d.room_id, d.kind, d.control,
                    s.value, s.state, s.colour, COALESCE(s.available, 0), s.last_changed
               FROM home_devices d LEFT JOIN home_device_state s ON s.device_id = d.id
              WHERE d.user_id = ?1
              ORDER BY d.name",
        )
        .map_err(store_err)?;
    let devices: Vec<DeviceRow> = dev_stmt
        .query_map([user_id], |r| {
            Ok(DeviceRow {
                id: r.get(0)?,
                name: r.get(1)?,
                room_id: r.get(2)?,
                kind: r.get(3)?,
                control: r.get(4)?,
                value: r.get(5)?,
                state: r.get(6)?,
                colour: r.get(7)?,
                available: r.get::<_, i64>(8)? != 0,
                last_changed: r.get(9)?,
            })
        })
        .map_err(store_err)?
        .collect::<Result<_, _>>()
        .map_err(store_err)?;

    let mut scene_stmt = conn
        .prepare("SELECT id, label, touches_locks FROM home_scenes WHERE user_id = ?1 ORDER BY label")
        .map_err(store_err)?;
    let scenes: Vec<Value> = scene_stmt
        .query_map([user_id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "label": r.get::<_, String>(1)?,
                // Not part of the mock's `Scene`, and extra fields are harmless
                // to it. It is here so the surface can say why a scene the
                // model asked for needed the user instead.
                "touchesLocks": r.get::<_, i64>(2)? != 0,
            }))
        })
        .map_err(store_err)?
        .collect::<Result<_, _>>()
        .map_err(store_err)?;

    let connected = bridge_rows.iter().find(|b| b.is_connected());

    // THREE STATES, NOT TWO. "No bridge has ever been linked" and "the bridge is
    // linked and is not answering" are different facts with different next
    // steps, and `bridgeConnected` alone flattens them into one — which sent a
    // user whose hub had rebooted to the day-one "connect a home" screen, on top
    // of a store holding their entire house.
    let bridge_state: &str = match (connected, bridge_rows.first()) {
        (Some(_), _) => "connected",
        // Whatever `set_bridge_health` last wrote: "unreachable" when the hub
        // did not answer, "unauthorised" when it rejected the token.
        (None, Some(b)) => b.state.as_str(),
        (None, None) => "none",
    };
    let answering = connected.is_some();

    // A device's `available` column is written per entity, and only by a pull or
    // a push that SUCCEEDED. Nothing writes it when the bridge itself stops
    // answering, so after a hub reboot every row still said `available = 1` and
    // the whole staleness treatment — the dimmed card, the "this is the last
    // reading, not a claim about now" line — never fired. The bridge-level
    // outage has to reach the device level, or a lamp that may well be on is
    // drawn, undimmed and unqualified, as off.
    let unavailable = if answering {
        devices.iter().filter(|d| !d.available).count()
    } else {
        devices.len()
    };

    let rooms_json: Vec<Value> = room_list
        .iter()
        .map(|(room_id, room_name)| {
            let members: Vec<&DeviceRow> = devices
                .iter()
                .filter(|d| d.room_id.as_deref() == Some(room_id.as_str()))
                .collect();
            let offline: Vec<&&DeviceRow> = members.iter().filter(|d| !d.available).collect();
            let (status, tone) = room_health(&offline, answering);
            json!({
                "id": room_id,
                "name": room_name,
                "status": status,
                "tone": tone,
                "devices": members
                    .iter()
                    .map(|d| device_json(d, room_id, room_name, answering))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();

    // Devices the bridge reports with no area. Dropping them would hide real
    // hardware; inventing a room for them would be worse.
    let orphans: Vec<&DeviceRow> = devices.iter().filter(|d| d.room_id.is_none()).collect();
    let mut rooms_json = rooms_json;
    if !orphans.is_empty() {
        let offline: Vec<&&DeviceRow> = orphans.iter().filter(|d| !d.available).collect();
        let (status, tone) = room_health(&offline, answering);
        rooms_json.push(json!({
            "id": "unassigned",
            "name": "No room",
            "status": status,
            "tone": tone,
            "devices": orphans.iter().map(|d| device_json(d, "unassigned", "No room", answering)).collect::<Vec<_>>(),
        }));
    }

    let mut recent: Vec<&DeviceRow> = devices.iter().filter(|d| d.last_changed.is_some()).collect();
    recent.sort_by(|a, b| b.last_changed.cmp(&a.last_changed));
    let recent_ids: Vec<Value> = recent
        .iter()
        .take(RECENT_LIMIT)
        .map(|d| json!(d.id))
        .collect();

    // Read for the stored bridge whether or not it is answering: "last reached
    // 40 minutes ago" is the single most useful thing to say about a hub that
    // has gone quiet, and it is only available here.
    let last_sync: Option<String> = match connected.or_else(|| bridge_rows.first()) {
        Some(b) => conn
            .query_row(
                "SELECT last_sync_at FROM home_bridges WHERE id = ?1",
                [&b.id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(store_err)?
            .flatten(),
        None => None,
    };
    let last_sync_rel = last_sync.as_deref().and_then(|iso| relative(iso, now));

    let hub = connected.map(|b| {
        json!({
            "name": b.name,
            "accessories": devices.len(),
            "lastSyncLabel": last_sync_rel
                .as_deref()
                .map(|rel| format!("Last sync {rel}"))
                // "Never synced" is a real state (the bridge authenticated but
                // the first pull has not finished), and it is not "just now".
                .unwrap_or_else(|| "Not synced yet".to_string()),
        })
    });

    Ok(json!({
        "bridgeConnected": answering,
        // The three-valued answer `bridgeConnected` cannot give. Additive, so
        // the mock's `SmartHomeSnapshot` still type-checks against it.
        "bridgeState": bridge_state,
        "lastReachedLabel": last_sync_rel,
        "hub": hub,
        "headline": headline(
            bridge_state,
            devices.len(),
            room_list.len(),
            unavailable,
            last_sync_rel.as_deref(),
        ),
        "scenes": scenes,
        // Which scene is "active" is a claim no bridge makes: Home Assistant
        // applies a scene and forgets it. Reporting one would be Atlas guessing
        // that nothing has changed since.
        "activeSceneId": Value::Null,
        "widgets": Value::Array(vec![]),
        "rooms": rooms_json,
        "recentIds": recent_ids,
        "discovery": { "live": false, "scope": "", "found": [] },
        // Stored bridges first, then the ones that exist as a platform fact
        // rather than as a row (companion::bridge_entry). Both are true; only
        // the first kind can ever be linked from this build.
        "bridges": bridge_rows
            .iter()
            .map(bridge_json)
            .chain(extra_bridges)
            .collect::<Vec<_>>(),
        "autonomy": autonomy,
        "counts": {
            "devices": devices.len(),
            "rooms": room_list.len(),
            "scenes": scenes.len(),
            "unavailable": unavailable,
        },
    }))
}

/// `bridge_answering` is false when the bridge itself is not reachable. Every
/// device it owns is then unavailable regardless of what its row last said —
/// see the note in `snapshot`. The row's own `state` words are KEPT, because
/// they are the last thing Atlas actually heard and the surface presents them
/// in the past tense; only the claim that they are current is withdrawn.
fn device_json(d: &DeviceRow, room_id: &str, room_name: &str, bridge_answering: bool) -> Value {
    let available = d.available && bridge_answering;
    let mut obj = Map::new();
    obj.insert("id".into(), json!(d.id));
    obj.insert("name".into(), json!(d.name));
    obj.insert("roomId".into(), json!(room_id));
    obj.insert("roomName".into(), json!(room_name));
    obj.insert("kind".into(), json!(d.kind));
    obj.insert("control".into(), json!(d.control));
    // The mock's `value` is a plain number and the sliders read it directly, so
    // a device Atlas has never had a reading for still needs one. 0 is the only
    // defensible filler — and it never stands alone: `available: false` plus a
    // `state` line that says so travel with it, and the surface shows both.
    obj.insert("value".into(), json!(d.value.unwrap_or(0.0)));
    obj.insert(
        "state".into(),
        json!(d.state.clone().unwrap_or_else(|| {
            if available {
                "No reading yet".to_string()
            } else {
                "Not responding".to_string()
            }
        })),
    );
    obj.insert("available".into(), json!(available));
    if let Some(c) = &d.colour {
        obj.insert("colour".into(), json!(c));
    }
    if let Some(t) = &d.last_changed {
        obj.insert("lastChanged".into(), json!(t));
    }
    Value::Object(obj)
}

/// A room's one-line status, from the devices actually in it.
fn room_health(offline: &[&&DeviceRow], bridge_connected: bool) -> (String, &'static str) {
    if !bridge_connected {
        return ("Last known state — the bridge is not answering".to_string(), "warn");
    }
    match offline.len() {
        0 => ("All responding".to_string(), "ok"),
        1 => (format!("{} not responding", offline[0].name), "error"),
        n => (format!("{n} devices not responding"), "error"),
    }
}

/// The headline, entirely from counts. No adjective here is a claim about the
/// house that the numbers do not carry.
///
/// `bridge_state` rather than a boolean, because "nothing is linked" and "what
/// is linked is not answering" are two different sentences with two different
/// next steps, and the second one must not offer to connect a home that is
/// already connected.
fn headline(
    bridge_state: &str,
    devices: usize,
    rooms: usize,
    unavailable: usize,
    last_reached: Option<&str>,
) -> Value {
    if bridge_state == "none" {
        return json!({
            "lead": "No home is ",
            "accent": "connected.",
            "subline": "Atlas has no bridge to your house yet. Link Home Assistant and your rooms, devices and scenes appear here.",
            "metaBig": "0",
            "metaSmall": "devices linked",
        });
    }
    if bridge_state != "connected" {
        // Linked, and silent. The counts are real — they are what the mirror
        // holds — so they are shown; what is withdrawn is the present tense.
        let why = if bridge_state == "unauthorised" {
            "Your bridge rejected Atlas' token."
        } else {
            "Atlas cannot reach your bridge."
        };
        let when = match last_reached {
            Some(rel) => format!(" Last reached {rel}."),
            None => String::new(),
        };
        return json!({
            "lead": "Home Assistant is ",
            "accent": "not answering.",
            "subline": format!(
                "{why}{when} The {devices} device{} below are the last thing it reported — not a \
                 claim about your house now.",
                plural(devices),
            ),
            "metaBig": devices.to_string(),
            "metaSmall": "devices, last known",
        });
    }
    let subline = if devices == 0 {
        "The bridge is linked, but it reports no devices yet.".to_string()
    } else if unavailable == 0 {
        format!(
            "{devices} device{} across {rooms} room{}, all responding.",
            plural(devices),
            plural(rooms)
        )
    } else {
        format!(
            "{devices} device{} across {rooms} room{}. {unavailable} {} not responding.",
            plural(devices),
            plural(rooms),
            if unavailable == 1 { "is" } else { "are" }
        )
    };
    json!({
        "lead": "Your home is ",
        "accent": if unavailable == 0 { "responding." } else { "mostly responding." },
        "subline": subline,
        "metaBig": devices.to_string(),
        "metaSmall": "devices linked",
    })
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// The mock's `Bridge` carries exactly two states. The richer column is mapped
/// down here and the difference moves into `detail`, in words the user can act
/// on — "unreachable" and "unauthorised" need different fixes and must not
/// arrive at the surface as the same grey pill.
fn bridge_json(b: &BridgeRow) -> Value {
    json!({
        "id": b.id,
        "name": b.name,
        "kind": b.kind.as_str(),
        "detail": b.detail_or_default(),
        "state": if b.is_connected() { "connected" } else { "not-linked" },
        "health": b.state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::{DevicePull, RoomPull, ScenePull};

    /// The real schema, applied to a scratch database. Using db_schema.sql
    /// itself rather than a hand-written CREATE TABLE is deliberate: it means
    /// these tests fail if the SQL that ships is invalid, which is the one
    /// property a hand-written copy could never check.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(include_str!("../db_schema.sql")).unwrap();
        conn
    }

    fn pull(devices: Vec<DevicePull>) -> BridgePull {
        BridgePull {
            rooms: vec![RoomPull { external_id: "living".into(), name: "Living room".into() }],
            devices,
            scenes: vec![ScenePull {
                external_id: "scene.evening".into(),
                label: "Evening".into(),
                touches_locks: false,
            }],
        }
    }

    fn lamp() -> DevicePull {
        DevicePull {
            external_id: "light.arc".into(),
            name: "Arc floor lamp".into(),
            kind: "floorlamp".into(),
            control: "slider".into(),
            room_external_id: Some("living".into()),
            value: Some(62.0),
            state: Some("Warm white".into()),
            colour: None,
            available: true,
            last_changed: Some("2026-08-08T10:00:00.000Z".into()),
        }
    }

    fn linked(conn: &Connection) -> String {
        upsert_bridge(
            conn,
            "u1",
            BridgeKind::HomeAssistant,
            "Home Assistant",
            Some("http://hub.local:8123"),
            "connected",
            "Linked",
        )
        .unwrap()
    }

    #[test]
    fn the_schema_block_is_valid_sql_and_creates_all_five_tables() {
        let conn = db();
        for table in [
            "home_bridges",
            "home_rooms",
            "home_devices",
            "home_scenes",
            "home_device_state",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} is missing from db_schema.sql");
        }
    }

    #[test]
    fn a_second_pull_updates_rather_than_duplicates() {
        let mut conn = db();
        let bridge = linked(&conn);

        let first = apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();
        assert_eq!(first, PullReport { rooms: 1, devices: 1, scenes: 1, removed: 0 });
        let id_after_first: String = conn
            .query_row("SELECT id FROM home_devices", [], |r| r.get(0))
            .unwrap();

        let mut renamed = lamp();
        renamed.name = "Arc lamp".into();
        renamed.value = Some(10.0);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![renamed])).unwrap();

        let (count, id, name, value): (i64, String, String, f64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM home_devices), d.id, d.name, s.value
                   FROM home_devices d JOIN home_device_state s ON s.device_id = d.id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(count, 1, "the second pull duplicated the device");
        assert_eq!(id, id_after_first, "the local id must survive a sync");
        assert_eq!(name, "Arc lamp");
        assert_eq!(value, 10.0);
    }

    #[test]
    fn a_device_the_bridge_stops_reporting_is_removed_not_left_offline() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();

        let report = apply_pull(&mut conn, "u1", &bridge, &pull(vec![])).unwrap();
        assert_eq!(report.devices, 0);
        assert!(report.removed >= 1);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM home_devices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        // The cascade took its state row with it, rather than orphaning it.
        let s: i64 = conn
            .query_row("SELECT COUNT(*) FROM home_device_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(s, 0);
    }

    /// An empty pull is the case a naive `NOT IN ()` gets exactly backwards.
    #[test]
    fn an_empty_pull_clears_everything_the_bridge_contributed() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();
        apply_pull(
            &mut conn,
            "u1",
            &bridge,
            &BridgePull { rooms: vec![], devices: vec![], scenes: vec![] },
        )
        .unwrap();
        for table in ["home_rooms", "home_devices", "home_scenes"] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} still has rows");
        }
    }

    #[test]
    fn an_unavailable_device_keeps_its_last_known_value_and_is_marked() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();

        let mut gone = lamp();
        gone.available = false;
        gone.value = None;
        gone.state = Some("Not responding".into());
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![gone])).unwrap();

        let (value, available): (f64, i64) = conn
            .query_row("SELECT value, available FROM home_device_state", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(value, 62.0, "the last known value must survive");
        assert_eq!(available, 0);
    }

    #[test]
    fn a_pushed_state_for_an_unknown_entity_does_not_invent_a_device() {
        let conn = db();
        let bridge = linked(&conn);
        let applied = apply_pushed_state(
            &conn,
            &bridge,
            "light.never_seen",
            Some(50.0),
            Some("On"),
            None,
            true,
            None,
        )
        .unwrap();
        assert!(!applied);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM home_devices", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn a_pushed_state_updates_a_known_entity() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();
        assert!(apply_pushed_state(
            &conn,
            &bridge,
            "light.arc",
            Some(5.0),
            Some("Dimmed"),
            None,
            true,
            Some("2026-08-08T11:00:00.000Z")
        )
        .unwrap());
        let (v, s): (f64, String) = conn
            .query_row("SELECT value, state FROM home_device_state", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((v, s.as_str()), (5.0, "Dimmed"));
    }

    #[test]
    fn the_snapshot_reports_a_day_one_house_as_empty_and_says_so() {
        let conn = db();
        let now = DateTime::parse_from_rfc3339("2026-08-08T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let snap = snapshot(&conn, "u1", now, json!([]), vec![]).unwrap();
        assert_eq!(snap["bridgeConnected"], json!(false));
        assert_eq!(snap["hub"], Value::Null);
        assert_eq!(snap["headline"]["metaBig"], json!("0"));
        assert_eq!(snap["rooms"].as_array().unwrap().len(), 0);
        // Never a fabricated widget or a fake scan.
        assert_eq!(snap["widgets"], json!([]));
        assert_eq!(snap["discovery"]["live"], json!(false));
        assert_eq!(snap["discovery"]["found"], json!([]));
        // Day one is "none", not "unreachable". Nothing has failed yet.
        assert_eq!(snap["bridgeState"], json!("none"));
    }

    /// The failure that read as day one. A bridge that IS linked and is not
    /// answering used to come back `bridgeConnected: false`, which is the same
    /// answer as "you have never connected a home" — so the page offered to
    /// connect Home Assistant while holding the user's entire house, and the
    /// headline said "Atlas has no bridge to your house yet".
    #[test]
    fn a_linked_bridge_that_is_not_answering_is_not_the_day_one_house() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();
        mark_synced(&conn, &bridge, "2026-08-08T11:20:00.000Z").unwrap();
        set_bridge_health(&conn, &bridge, "unreachable", "No route to the hub", Some("timeout"))
            .unwrap();

        let now = DateTime::parse_from_rfc3339("2026-08-08T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let snap = snapshot(&conn, "u1", now, json!([]), vec![]).unwrap();

        assert_eq!(snap["bridgeState"], json!("unreachable"));
        let head = &snap["headline"];
        assert_eq!(head["accent"], json!("not answering."));
        let subline = head["subline"].as_str().unwrap();
        assert!(
            !subline.contains("no bridge"),
            "a linked house must never be described as unlinked: {subline}"
        );
        assert!(subline.contains("not a claim about your house now"), "{subline}");
        assert!(subline.contains("40 minutes ago"), "say when it was last reached: {subline}");
        // The mirror is still shown — that is the whole point of having one.
        assert_eq!(snap["rooms"].as_array().unwrap().len(), 1);
        assert_eq!(head["metaBig"], json!("1"));

        // A rejected token is a different sentence, because it needs a
        // different thing from the user.
        set_bridge_health(&conn, &bridge, "unauthorised", "Token rejected", Some("401")).unwrap();
        let snap = snapshot(&conn, "u1", now, json!([]), vec![]).unwrap();
        assert_eq!(snap["bridgeState"], json!("unauthorised"));
        assert!(snap["headline"]["subline"].as_str().unwrap().contains("rejected Atlas' token"));
    }

    /// `home_device_state.available` is only ever written by a pull or a push
    /// that succeeded, so nothing marked these devices stale when the bridge
    /// itself went quiet — every card kept `available: true` and its last
    /// reading, and the surface drew it undimmed and unqualified. A lamp that
    /// may well be on, shown as off.
    #[test]
    fn a_silent_bridge_marks_every_device_it_owns_as_not_responding() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-08T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        // While it is answering, the lamp is available and reads as itself.
        let snap = snapshot(&conn, "u1", now, json!([]), vec![]).unwrap();
        assert_eq!(snap["rooms"][0]["devices"][0]["available"], json!(true));
        assert_eq!(snap["counts"]["unavailable"], json!(0));

        set_bridge_health(&conn, &bridge, "unreachable", "No route to the hub", Some("timeout"))
            .unwrap();
        let snap = snapshot(&conn, "u1", now, json!([]), vec![]).unwrap();
        let device = &snap["rooms"][0]["devices"][0];
        assert_eq!(
            device["available"],
            json!(false),
            "a device behind a silent bridge is not responding, whatever its row says"
        );
        // The last known reading is KEPT — withdrawing the claim is not the
        // same as deleting the evidence. The surface prints it in the past
        // tense next to "not responding".
        assert_eq!(device["state"], json!("Warm white"));
        assert_eq!(device["value"], json!(62.0));
        assert_eq!(snap["counts"]["unavailable"], json!(1));
    }

    #[test]
    fn the_snapshot_carries_the_field_names_the_page_binds_to() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();
        mark_synced(&conn, &bridge, "2026-08-08T11:59:20.000Z").unwrap();
        let now = DateTime::parse_from_rfc3339("2026-08-08T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);

        let snap = snapshot(&conn, "u1", now, json!([]), vec![]).unwrap();
        assert_eq!(snap["bridgeConnected"], json!(true));
        assert_eq!(snap["hub"]["accessories"], json!(1));
        assert_eq!(snap["hub"]["lastSyncLabel"], json!("Last sync 40 seconds ago"));
        let device = &snap["rooms"][0]["devices"][0];
        for key in ["id", "name", "roomId", "roomName", "kind", "control", "value", "state"] {
            assert!(!device[key].is_null(), "SmartDevice.{key} is missing");
        }
        assert_eq!(device["roomName"], json!("Living room"));
        assert_eq!(device["value"], json!(62.0));
        assert_eq!(snap["rooms"][0]["status"], json!("All responding"));
        assert_eq!(snap["rooms"][0]["tone"], json!("ok"));
        assert_eq!(snap["recentIds"].as_array().unwrap().len(), 1);
        assert_eq!(snap["scenes"][0]["label"], json!("Evening"));
        // No bridge claims a scene is still applied, so Atlas does not either.
        assert_eq!(snap["activeSceneId"], Value::Null);
    }

    #[test]
    fn a_room_with_a_silent_device_names_it_instead_of_saying_all_is_well() {
        let mut conn = db();
        let bridge = linked(&conn);
        let mut camera = lamp();
        camera.external_id = "camera.side_gate".into();
        camera.name = "Side gate camera".into();
        camera.kind = "camera".into();
        camera.control = "status".into();
        camera.available = false;
        camera.value = None;
        camera.state = None;
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp(), camera])).unwrap();

        let now = Utc::now();
        let snap = snapshot(&conn, "u1", now, json!([]), vec![]).unwrap();
        assert_eq!(snap["rooms"][0]["tone"], json!("error"));
        assert_eq!(snap["rooms"][0]["status"], json!("Side gate camera not responding"));
        let silent = snap["rooms"][0]["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["name"] == json!("Side gate camera"))
            .unwrap();
        // The filler 0 never travels alone.
        assert_eq!(silent["value"], json!(0.0));
        assert_eq!(silent["available"], json!(false));
        assert_eq!(silent["state"], json!("Not responding"));
    }

    #[test]
    fn a_device_with_no_area_gets_a_room_that_is_not_invented() {
        let mut conn = db();
        let bridge = linked(&conn);
        let mut orphan = lamp();
        orphan.room_external_id = None;
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![orphan])).unwrap();
        let snap = snapshot(&conn, "u1", Utc::now(), json!([]), vec![]).unwrap();
        let rooms = snap["rooms"].as_array().unwrap();
        let unassigned = rooms.iter().find(|r| r["id"] == json!("unassigned")).unwrap();
        assert_eq!(unassigned["name"], json!("No room"));
        assert_eq!(unassigned["devices"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn another_users_house_is_invisible() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();
        let snap = snapshot(&conn, "someone-else", Utc::now(), json!([]), vec![]).unwrap();
        assert_eq!(snap["bridgeConnected"], json!(false));
        assert_eq!(snap["rooms"].as_array().unwrap().len(), 0);

        let device_id: String = conn
            .query_row("SELECT id FROM home_devices", [], |r| r.get(0))
            .unwrap();
        assert!(device_target(&conn, "someone-else", &device_id).unwrap().is_none());
        assert!(device_card(&conn, "someone-else", &device_id).unwrap().is_none());
    }

    #[test]
    fn the_card_names_the_device_and_its_room() {
        let mut conn = db();
        let bridge = linked(&conn);
        apply_pull(&mut conn, "u1", &bridge, &pull(vec![lamp()])).unwrap();
        let device_id: String = conn
            .query_row("SELECT id FROM home_devices", [], |r| r.get(0))
            .unwrap();
        let card = device_card(&conn, "u1", &device_id).unwrap().unwrap();
        assert_eq!(card["name"], json!("Arc floor lamp"));
        assert_eq!(card["room_name"], json!("Living room"));
        assert!(device_card(&conn, "u1", "no-such-id").unwrap().is_none());
    }

    #[test]
    fn relative_time_reads_the_way_the_design_writes_it() {
        let now = DateTime::parse_from_rfc3339("2026-08-08T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let at = |iso: &str| relative(iso, now);
        assert_eq!(at("2026-08-08T11:59:20Z").as_deref(), Some("40 seconds ago"));
        assert_eq!(at("2026-08-08T11:58:00Z").as_deref(), Some("2 minutes ago"));
        assert_eq!(at("2026-08-08T09:00:00Z").as_deref(), Some("3 hours ago"));
        assert_eq!(at("2026-08-05T12:00:00Z").as_deref(), Some("3 days ago"));
        // A future timestamp is a broken clock, not a duration.
        assert_eq!(at("2026-08-09T12:00:00Z"), None);
        assert_eq!(at("not a timestamp"), None);
    }
}
