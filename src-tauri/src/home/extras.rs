// What Home Assistant says beyond a device's one number — parsed, pure, and
// tested here.
//
// WHY THIS FILE EXISTS
// The mirror (store.rs) keeps what a device IS and the one value its control
// moves. The Beta Smart Home needs more of what the bridge already says, and
// none of it may be invented:
//
//   * a thermostat's TARGET and what it is doing about it (`hvac_action`), so
//     "Heating to 21.5°" is the bridge's sentence and not Atlas guessing from
//     the room's reading;
//   * the HA domain, so a water heater's 55° stays out of "21° inside";
//   * a sensor's device_class and unit, so the energy card can tell watts from
//     kilowatt-hours and a motion sensor from a leak sensor;
//   * which HA DEVICE an entity belongs to, so a plug's power sensor is filed
//     under the plug and a doorbell's motion sensor under the camera;
//   * the Energy dashboard's own roles (grid, solar, per-device), so the card
//     never sums a whole-house meter with the plugs behind it;
//   * the automations, scripts and people Home Assistant runs — its machinery,
//     which ha.rs deliberately keeps out of the device list.
//
// Every function below reads a payload and either produces a value from it or
// produces nothing. Nothing here talks to a socket; ha.rs fetches, this parses.

use std::collections::HashMap;

use chrono::{DateTime, TimeZone, Timelike, Utc};
use serde_json::Value;

use super::ha::{domain_of, is_available, kind_of};
use super::RoomPull;

/// The domains of Home Assistant's own machinery that the Beta screen reads.
/// They never become devices — see `RENDERED_DOMAINS` in ha.rs — and they are
/// stored in their own table, `home_hub_entities`.
pub const HUB_DOMAINS: &[&str] = &["automation", "script", "person", "device_tracker"];

/// The part of an entity's attributes the mirror's one value cannot carry.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeviceDetail {
    /// The HA domain, from the entity id: `climate`, `water_heater`, `sensor`.
    pub domain: String,
    pub device_class: Option<String>,
    pub unit: Option<String>,
    pub state_class: Option<String>,
    /// What a thermostat or water heater is SET to. `None` when the bridge did
    /// not say — a thermostat that is off has no target, and that is not 0°.
    pub target: Option<f64>,
    /// `heating`, `cooling`, `idle`, `off`… the climate entity's own word.
    pub hvac_action: Option<String>,
    /// The HA device-registry id the entity belongs to.
    pub hub_device_id: Option<String>,
    /// `grid`, `solar` or `device`, when the HA Energy dashboard counts it.
    pub energy_role: Option<String>,
}

/// One automation, script or person, as the bridge described it.
#[derive(Debug, Clone, PartialEq)]
pub struct HubEntityPull {
    pub external_id: String,
    pub domain: String,
    pub label: String,
    /// The raw state word: `on`/`off` for an automation, `home`/`not_home` or a
    /// zone's name for a person.
    pub state: String,
    pub available: bool,
    /// For a script: whether Atlas can PROVE it reaches no lock. True for
    /// everything else, so nothing that was never checked reads as safe.
    pub touches_locks: bool,
    pub last_changed: Option<String>,
    pub last_triggered: Option<String>,
}

/// What the WebSocket registry pass learned. Every map may be empty: a bridge
/// that answers REST but not the WebSocket still syncs, with less known.
#[derive(Debug, Default)]
pub struct Registry {
    pub rooms: Vec<RoomPull>,
    /// entity id → area id, the entity's own area or else its device's.
    pub area_of: HashMap<String, String>,
    /// entity id → HA device id.
    pub device_of: HashMap<String, String>,
    /// entity id → `grid` | `solar` | `device`.
    pub energy_roles: HashMap<String, String>,
    /// script entity id → its raw config.
    pub script_configs: HashMap<String, Value>,
}

/// The extras of one pull, beside the `BridgePull` the mirror already takes.
#[derive(Debug, Default)]
pub struct PullExtras {
    /// external id → detail, for every device the pull reported.
    pub details: Vec<(String, DeviceDetail)>,
    pub hub: Vec<HubEntityPull>,
}

/// `domain.object_id`, both halves lower-case HA identifiers.
///
/// Every entity id that reaches a URL path or a service body passes through
/// this first. They come from the bridge's own payload, so this is defence in
/// depth rather than the only gate — but a path is a bad place to find out an
/// id contained a slash.
pub fn is_entity_id(s: &str) -> bool {
    let Some((d, o)) = s.split_once('.') else { return false };
    !d.is_empty()
        && !o.is_empty()
        && d.chars().all(|c| c.is_ascii_lowercase() || c == '_')
        && o.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

// ---------------------------------------------------------------------------
// The registries
// ---------------------------------------------------------------------------

/// Rooms, and which entity sits in which room and on which device.
///
/// An entity with no area of its own INHERITS its device's area — that is how
/// Home Assistant itself places it, and the most common way a house is set up
/// (you put the lamp in the living room, not each of its three entities).
/// Reading only the entity's own area filed those under "No room".
pub fn parse_registry_full(
    areas: &Value,
    entities: &Value,
    devices: &Value,
) -> (Vec<RoomPull>, HashMap<String, String>, HashMap<String, String>) {
    let rooms = areas
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    Some(RoomPull {
                        external_id: a["area_id"].as_str()?.to_string(),
                        name: a["name"].as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let device_area: HashMap<&str, &str> = devices
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|d| Some((d["id"].as_str()?, d["area_id"].as_str()?)))
                .collect()
        })
        .unwrap_or_default();

    let mut area_of = HashMap::new();
    let mut device_of = HashMap::new();
    for e in entities.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let Some(id) = e["entity_id"].as_str() else { continue };
        let device = e["device_id"].as_str();
        if let Some(d) = device {
            device_of.insert(id.to_string(), d.to_string());
        }
        let area = e["area_id"].as_str().or_else(|| device.and_then(|d| device_area.get(d).copied()));
        if let Some(a) = area {
            area_of.insert(id.to_string(), a.to_string());
        }
    }
    (rooms, area_of, device_of)
}

/// The HA Energy dashboard's configuration, read as roles per statistic id.
///
/// This is what keeps the energy card from double counting: the user already
/// told Home Assistant which sensor is the house's meter and which ones are
/// devices behind it. A statistic id that is not an entity (an external
/// statistic such as `tibber:energy`) is skipped; there is no sensor to read.
pub fn energy_roles(prefs: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut put = |id: Option<&str>, role: &str| {
        if let Some(id) = id.filter(|i| is_entity_id(i)) {
            out.entry(id.to_string()).or_insert_with(|| role.to_string());
        }
    };
    for src in prefs["energy_sources"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        match src["type"].as_str() {
            Some("grid") => {
                for f in src["flow_from"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                    put(f["stat_energy_from"].as_str(), "grid");
                }
            }
            Some("solar") => put(src["stat_energy_from"].as_str(), "solar"),
            _ => {}
        }
    }
    for d in prefs["device_consumption"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        put(d["stat_consumption"].as_str(), "device");
    }
    out
}

// ---------------------------------------------------------------------------
// Device detail
// ---------------------------------------------------------------------------

/// The detail of one rendered entity.
///
/// The target is `attributes.temperature`, which Home Assistant sets for a
/// single-setpoint climate entity and a water heater. A heat-cool range
/// (`target_temp_low`/`high`) has no single target, so it is `None` rather
/// than one end of the range presented as the whole.
pub fn detail_of(entity_id: &str, attrs: &Value, reg: &Registry) -> DeviceDetail {
    let domain = domain_of(entity_id).to_string();
    let thermal = matches!(domain.as_str(), "climate" | "water_heater");
    DeviceDetail {
        target: if thermal { attrs["temperature"].as_f64() } else { None },
        hvac_action: if domain == "climate" { str_of(&attrs["hvac_action"]) } else { None },
        device_class: str_of(&attrs["device_class"]),
        unit: str_of(&attrs["unit_of_measurement"]),
        state_class: str_of(&attrs["state_class"]),
        hub_device_id: reg.device_of.get(entity_id).cloned(),
        energy_role: reg.energy_roles.get(entity_id).cloned(),
        domain,
    }
}

// ---------------------------------------------------------------------------
// Scripts — whether one can reach a lock
// ---------------------------------------------------------------------------

/// The cover services. They are names, not targets; what they act on is the
/// entity ids beside them, which are judged on their own.
const COVER_SERVICES: &[&str] = &[
    "open_cover", "close_cover", "set_cover_position", "stop_cover", "toggle",
    "open_cover_tilt", "close_cover_tilt", "set_cover_tilt_position", "stop_cover_tilt", "toggle_cover_tilt",
];

/// Can this script config reach a lock, as far as Atlas can tell?
///
/// The same fail-closed rule `ha::scene_from_state` applies to a scene, over a
/// richer document. TRUE — "Atlas cannot rule it out" — when anything in it:
///
///   * names a `lock.` entity or calls a `lock.` service;
///   * names a cover whose own `device_class` makes it a door, gate or garage,
///     or a cover the bridge did not describe at all;
///   * hands off to another script, scene or automation (whose contents are
///     not in this document);
///   * targets an area, device, floor or label, or `entity_id: all` — a target
///     Atlas cannot enumerate;
///   * is a template (`{{ … }}`), which can target anything at run time;
///   * is a device action in the lock domain (`domain: lock`).
///
/// A script that passes is one Atlas can run for you; one that does not is
/// one the screen says to run from Home Assistant, exactly as for a scene.
pub fn config_touches_locks(config: &Value, attrs_of: &HashMap<&str, &Value>) -> bool {
    fn walk(v: &Value, key: Option<&str>, attrs_of: &HashMap<&str, &Value>) -> bool {
        match v {
            Value::String(s) => {
                if s.contains("{{") || s.contains("{%") {
                    return true;
                }
                if key == Some("domain") && s == "lock" {
                    return true;
                }
                if key == Some("entity_id") && s == "all" {
                    return true;
                }
                if !is_entity_id(s) {
                    return false;
                }
                let (domain, rest) = s.split_once('.').unwrap_or(("", ""));
                match domain {
                    "lock" | "script" | "scene" | "automation" => true,
                    "cover" => match attrs_of.get(s.as_str()) {
                        Some(a) => super::is_lock_kind(kind_of(s, a)),
                        None => !COVER_SERVICES.contains(&rest),
                    },
                    _ => false,
                }
            }
            Value::Object(map) => map.iter().any(|(k, x)| {
                (matches!(k.as_str(), "area_id" | "device_id" | "floor_id" | "label_id") && !x.is_null())
                    || walk(x, Some(k.as_str()), attrs_of)
            }),
            Value::Array(list) => list.iter().any(|x| walk(x, key, attrs_of)),
            _ => false,
        }
    }
    walk(config, None, attrs_of)
}

// ---------------------------------------------------------------------------
// Hub entities: automations, scripts, people
// ---------------------------------------------------------------------------

/// One `/api/states` entry as a hub entity, or `None`.
///
/// A `device_tracker` is kept only when it is a phone's GPS (the companion
/// app): Home Assistant's router integrations file every laptop and TV on the
/// network as a tracker too, and "the printer is away" is not presence.
pub fn hub_entity_from_state(
    entry: &Value,
    script_configs: &HashMap<String, Value>,
    member_attrs: &HashMap<&str, &Value>,
) -> Option<HubEntityPull> {
    let id = entry["entity_id"].as_str()?;
    let domain = domain_of(id);
    if !HUB_DOMAINS.contains(&domain) {
        return None;
    }
    let attrs = &entry["attributes"];
    if domain == "device_tracker" && attrs["source_type"].as_str() != Some("gps") {
        return None;
    }
    let state = entry["state"].as_str().unwrap_or("").to_string();
    let touches_locks = match domain {
        "script" => script_configs.get(id).map(|c| config_touches_locks(c, member_attrs)).unwrap_or(true),
        _ => true,
    };
    Some(HubEntityPull {
        external_id: id.to_string(),
        domain: domain.to_string(),
        label: str_of(&attrs["friendly_name"]).unwrap_or_else(|| id.to_string()),
        available: is_available(&state),
        state,
        touches_locks,
        last_changed: entry["last_changed"].as_str().map(str::to_string),
        last_triggered: attrs["last_triggered"].as_str().map(str::to_string),
    })
}

/// Everything beyond the `BridgePull` in one `/api/states` payload.
pub fn parse_extras(states: &Value, reg: &Registry, rendered: &[&str]) -> PullExtras {
    let list = states.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let member_attrs: HashMap<&str, &Value> = list
        .iter()
        .filter_map(|e| Some((e["entity_id"].as_str()?, &e["attributes"])))
        .collect();
    let mut out = PullExtras::default();
    for e in list {
        let Some(id) = e["entity_id"].as_str() else { continue };
        if rendered.contains(&domain_of(id)) {
            out.details.push((id.to_string(), detail_of(id, &e["attributes"], reg)));
        } else if let Some(h) = hub_entity_from_state(e, &reg.script_configs, &member_attrs) {
            out.hub.push(h);
        }
    }
    out
}

/// A pushed `state_changed` about a hub entity. `touches_locks` is left true
/// here and the store never overwrites the stored verdict from a push: a push
/// carries the state, not the script's config.
pub fn pushed_hub_entity(event: &Value) -> Option<HubEntityPull> {
    let new_state = &event["event"]["data"]["new_state"];
    hub_entity_from_state(new_state, &HashMap::new(), &HashMap::new())
}

/// The script entity ids in a states payload — the ones whose config the
/// registry pass asks for.
pub fn script_ids(states: &Value) -> Vec<String> {
    states
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|e| e["entity_id"].as_str())
        .filter(|id| domain_of(id) == "script" && is_entity_id(id))
        .map(str::to_string)
        .collect()
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/// Home Assistant writes `2026-08-08T10:00:00.123456+00:00`; the mirror writes
/// `2026-08-08T10:00:00.123Z`. History is ordered and pruned by comparing the
/// text, so every timestamp that enters it is rewritten to the mirror's form.
pub fn canonical_ts(s: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|t| t.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

// ---------------------------------------------------------------------------
// Energy statistics
// ---------------------------------------------------------------------------

/// `recorder/statistic_during_period`'s answer: the change over the period,
/// or `None` when the recorder holds no statistics for the sensor.
pub fn stat_change(result: &Value) -> Option<f64> {
    result["change"].as_f64().filter(|v| v.is_finite())
}

/// One sensor's hourly rows from `recorder/statistics_during_period`, as 24
/// buckets by LOCAL hour of the day. A bucket with no row is `None`, not 0:
/// an hour the recorder did not compile is not an hour that used nothing.
///
/// `start` arrives as epoch milliseconds on current Home Assistant and as an
/// ISO string on older versions; both are read.
pub fn hour_buckets<Tz: TimeZone>(rows: &Value, tz: &Tz) -> Vec<Option<f64>> {
    let mut out = vec![None; 24];
    for r in rows.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let Some(change) = r["change"].as_f64().filter(|v| v.is_finite()) else { continue };
        let start = match &r["start"] {
            Value::Number(n) => n.as_f64().and_then(|ms| DateTime::<Utc>::from_timestamp_millis(ms as i64)),
            Value::String(s) => DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc)),
            _ => None,
        };
        let Some(start) = start else { continue };
        // `hour()` rather than `format("%H")`: formatting needs `Tz::Offset: Display`,
        // which a bare `TimeZone` bound does not promise.
        let hour = start.with_timezone(tz).hour() as usize;
        if hour < 24 {
            out[hour] = Some(out[hour].unwrap_or(0.0) + change);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    use serde_json::json;

    #[test]
    fn an_entity_inherits_its_devices_area_when_it_has_none_of_its_own() {
        let areas = json!([{ "area_id": "living", "name": "Living room" }, { "area_id": "hall", "name": "Hall" }]);
        let devices = json!([{ "id": "dev-lamp", "area_id": "living" }, { "id": "dev-cam", "area_id": "hall" }]);
        let entities = json!([
            { "entity_id": "light.arc", "device_id": "dev-lamp", "area_id": null },
            { "entity_id": "sensor.arc_power", "device_id": "dev-lamp", "area_id": "hall" },
            { "entity_id": "binary_sensor.door_motion", "device_id": "dev-cam" },
            { "entity_id": "light.loose", "area_id": null },
        ]);
        let (rooms, area_of, device_of) = parse_registry_full(&areas, &entities, &devices);
        assert_eq!(rooms.len(), 2);
        assert_eq!(area_of.get("light.arc").map(String::as_str), Some("living"));
        // The entity's own area wins over its device's.
        assert_eq!(area_of.get("sensor.arc_power").map(String::as_str), Some("hall"));
        assert_eq!(area_of.get("binary_sensor.door_motion").map(String::as_str), Some("hall"));
        assert!(!area_of.contains_key("light.loose"));
        assert_eq!(device_of.get("sensor.arc_power").map(String::as_str), Some("dev-lamp"));
        assert!(!device_of.contains_key("light.loose"));
    }

    #[test]
    fn energy_roles_come_from_the_energy_dashboard_and_skip_external_statistics() {
        let prefs = json!({
            "energy_sources": [
                { "type": "grid", "flow_from": [{ "stat_energy_from": "sensor.meter_import" }, { "stat_energy_from": "tibber:energy" }], "flow_to": [] },
                { "type": "solar", "stat_energy_from": "sensor.solar_total" },
                { "type": "gas", "stat_energy_from": "sensor.gas" },
            ],
            "device_consumption": [{ "stat_consumption": "sensor.plug_energy" }],
        });
        let roles = energy_roles(&prefs);
        assert_eq!(roles.get("sensor.meter_import").map(String::as_str), Some("grid"));
        assert_eq!(roles.get("sensor.solar_total").map(String::as_str), Some("solar"));
        assert_eq!(roles.get("sensor.plug_energy").map(String::as_str), Some("device"));
        assert!(!roles.contains_key("sensor.gas"), "gas is not electricity");
        assert!(!roles.contains_key("tibber:energy"), "an external statistic is not a sensor");
        assert!(energy_roles(&Value::Null).is_empty());
    }

    #[test]
    fn a_thermostat_carries_its_target_and_action_and_a_range_carries_neither_end() {
        let reg = Registry::default();
        let d = detail_of("climate.hall", &json!({ "temperature": 21.5, "current_temperature": 20.8, "hvac_action": "heating" }), &reg);
        assert_eq!(d.domain, "climate");
        assert_eq!(d.target, Some(21.5));
        assert_eq!(d.hvac_action.as_deref(), Some("heating"));

        let range = detail_of("climate.hall", &json!({ "target_temp_low": 19, "target_temp_high": 24, "hvac_action": "idle" }), &reg);
        assert_eq!(range.target, None, "a range has no single target");

        let off = detail_of("climate.hall", &json!({ "temperature": null, "hvac_action": "off" }), &reg);
        assert_eq!(off.target, None, "an off thermostat is not set to 0°");

        let tank = detail_of("water_heater.tank", &json!({ "temperature": 55 }), &reg);
        assert_eq!(tank.domain, "water_heater");
        assert_eq!(tank.target, Some(55.0));
        assert_eq!(tank.hvac_action, None);

        // A light has no target even if some integration sets `temperature`.
        assert_eq!(detail_of("light.arc", &json!({ "temperature": 3000 }), &reg).target, None);
    }

    #[test]
    fn a_sensor_carries_its_class_unit_device_and_energy_role() {
        let mut reg = Registry::default();
        reg.device_of.insert("sensor.plug_power".into(), "dev-plug".into());
        reg.energy_roles.insert("sensor.plug_energy".into(), "device".into());
        let p = detail_of("sensor.plug_power", &json!({ "device_class": "power", "unit_of_measurement": "W", "state_class": "measurement" }), &reg);
        assert_eq!(p.device_class.as_deref(), Some("power"));
        assert_eq!(p.unit.as_deref(), Some("W"));
        assert_eq!(p.hub_device_id.as_deref(), Some("dev-plug"));
        assert_eq!(p.energy_role, None);
        let e = detail_of("sensor.plug_energy", &json!({ "device_class": "energy", "unit_of_measurement": "kWh" }), &reg);
        assert_eq!(e.energy_role.as_deref(), Some("device"));
    }

    fn attrs(pairs: &[(&'static str, Value)]) -> Vec<(&'static str, Value)> {
        pairs.to_vec()
    }

    #[test]
    fn a_script_that_names_a_lock_or_cannot_be_read_fails_closed() {
        let owned = attrs(&[
            ("cover.garage_door", json!({ "device_class": "garage" })),
            ("cover.blinds", json!({ "device_class": "blind" })),
        ]);
        let member: HashMap<&str, &Value> = owned.iter().map(|(k, v)| (*k, v)).collect();

        let lights = json!({ "sequence": [{ "service": "light.turn_off", "target": { "entity_id": ["light.arc", "light.hall"] } }] });
        assert!(!config_touches_locks(&lights, &member));

        let blinds = json!({ "sequence": [{ "action": "cover.close_cover", "target": { "entity_id": "cover.blinds" } }] });
        assert!(!config_touches_locks(&blinds, &member), "a blind behind a cover service is not a door");

        for touches in [
            json!({ "sequence": [{ "service": "lock.lock", "target": { "entity_id": "lock.front_door" } }] }),
            json!({ "sequence": [{ "action": "cover.open_cover", "target": { "entity_id": "cover.garage_door" } }] }),
            json!({ "sequence": [{ "action": "cover.open_cover", "target": { "entity_id": "cover.never_described" } }] }),
            json!({ "sequence": [{ "action": "light.turn_off", "target": { "area_id": "hall" } }] }),
            json!({ "sequence": [{ "action": "cover.close_cover", "target": { "entity_id": "all" } }] }),
            json!({ "sequence": [{ "action": "script.turn_on", "target": { "entity_id": "script.other" } }] }),
            json!({ "sequence": [{ "action": "light.turn_on", "target": { "entity_id": "{{ states('input_text.x') }}" } }] }),
            json!({ "sequence": [{ "type": "lock", "domain": "lock", "device_id": "abc" }] }),
        ] {
            assert!(config_touches_locks(&touches, &member), "{touches}");
        }
    }

    #[test]
    fn hub_entities_are_read_and_a_router_tracker_is_not_a_person() {
        let mut configs = HashMap::new();
        configs.insert("script.lights_out".to_string(), json!({ "sequence": [{ "service": "light.turn_off", "target": { "entity_id": "light.arc" } }] }));
        let member = HashMap::new();
        let auto = hub_entity_from_state(
            &json!({ "entity_id": "automation.morning", "state": "on", "attributes": { "friendly_name": "Morning", "last_triggered": "2026-10-28T06:30:00+00:00" } }),
            &configs, &member,
        ).unwrap();
        assert_eq!((auto.domain.as_str(), auto.label.as_str(), auto.state.as_str()), ("automation", "Morning", "on"));
        assert_eq!(auto.last_triggered.as_deref(), Some("2026-10-28T06:30:00+00:00"));

        let script = hub_entity_from_state(&json!({ "entity_id": "script.lights_out", "state": "off", "attributes": {} }), &configs, &member).unwrap();
        assert!(!script.touches_locks);
        let unread = hub_entity_from_state(&json!({ "entity_id": "script.mystery", "state": "off", "attributes": {} }), &configs, &member).unwrap();
        assert!(unread.touches_locks, "a script whose config Atlas never read is not proven lock-free");

        let person = hub_entity_from_state(&json!({ "entity_id": "person.marcus", "state": "not_home", "attributes": { "friendly_name": "Marcus" } }), &configs, &member).unwrap();
        assert_eq!(person.state, "not_home");
        let phone = hub_entity_from_state(&json!({ "entity_id": "device_tracker.pixel", "state": "home", "attributes": { "source_type": "gps" } }), &configs, &member);
        assert!(phone.is_some());
        let printer = hub_entity_from_state(&json!({ "entity_id": "device_tracker.printer", "state": "home", "attributes": { "source_type": "router" } }), &configs, &member);
        assert!(printer.is_none());
        // A device is not a hub entity.
        assert!(hub_entity_from_state(&json!({ "entity_id": "light.arc", "state": "on", "attributes": {} }), &configs, &member).is_none());
    }

    #[test]
    fn extras_split_a_payload_into_details_and_hub_entities() {
        let states = json!([
            { "entity_id": "climate.hall", "state": "heat", "attributes": { "temperature": 21, "hvac_action": "heating" } },
            { "entity_id": "automation.morning", "state": "on", "attributes": {} },
            { "entity_id": "sun.sun", "state": "above_horizon", "attributes": {} },
        ]);
        let extras = parse_extras(&states, &Registry::default(), &["climate"]);
        assert_eq!(extras.details.len(), 1);
        assert_eq!(extras.details[0].0, "climate.hall");
        assert_eq!(extras.hub.len(), 1);
        assert_eq!(script_ids(&json!([{ "entity_id": "script.a" }, { "entity_id": "light.b" }])), vec!["script.a".to_string()]);
    }

    #[test]
    fn entity_ids_are_checked_before_they_reach_a_path() {
        assert!(is_entity_id("camera.front_door"));
        assert!(is_entity_id("binary_sensor.motion_2"));
        for bad in ["camera", "camera.", ".x", "camera/../api", "Camera.Front", "camera.front door", "a.b.c"] {
            assert!(!is_entity_id(bad), "{bad}");
        }
    }

    #[test]
    fn timestamps_are_rewritten_to_the_mirrors_form() {
        assert_eq!(canonical_ts("2026-08-08T10:00:00.123456+00:00").as_deref(), Some("2026-08-08T10:00:00.123Z"));
        assert_eq!(canonical_ts("2026-08-08T12:00:00+02:00").as_deref(), Some("2026-08-08T10:00:00.000Z"));
        assert_eq!(canonical_ts("yesterday"), None);
    }

    #[test]
    fn hourly_statistics_land_in_local_hours_and_a_missing_hour_stays_missing() {
        let cph = FixedOffset::east_opt(3600).unwrap();
        // 06:00 and 07:00 UTC are 07:00 and 08:00 in a UTC+1 house.
        let rows = json!([
            { "start": 1_793_167_200_000_i64, "change": 0.4 },
            { "start": "2026-10-28T07:00:00+00:00", "change": 0.6 },
            { "start": 1_793_167_200_000_i64, "change": null },
        ]);
        let b = hour_buckets(&rows, &cph);
        assert_eq!(b.len(), 24);
        let at7 = DateTime::<Utc>::from_timestamp_millis(1_793_167_200_000).unwrap().with_timezone(&cph).format("%H").to_string().parse::<usize>().unwrap();
        assert_eq!(b[at7], Some(0.4));
        assert_eq!(b[8], Some(0.6));
        assert_eq!(b[3], None);
        assert_eq!(stat_change(&json!({ "change": 4.2 })), Some(4.2));
        assert_eq!(stat_change(&json!({ "change": null })), None);
    }
}
