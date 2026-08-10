// The Home Assistant adapter: REST for state and commands, WebSocket for the
// two things REST cannot do.
//
// WHY BOTH PROTOCOLS, since that looks like one too many
// Home Assistant's REST API has no area (room) endpoint at all — the area and
// entity registries live only behind the WebSocket API, and so does the event
// stream. So REST alone can tell you that `light.arc` is at 62% and can turn it
// down, but it cannot tell you the lamp is in the living room, and it cannot
// tell you when somebody else changes it. Both of those are on the page.
//
// The split is therefore: REST for the snapshot's values and for every outbound
// command (one bounded request each, through the shared timed agent in
// http.rs), WebSocket for the room map during a sync and for the live channel.
// A WebSocket failure degrades to "devices with no room" rather than to no
// sync — a house with unnamed rooms is still a true house.
//
// WHAT AN ADAPTER MAY NEVER DO, and this one does not: return a device it did
// not hear about, a value it did not receive, or a success for a call that did
// not answer. Every mapping below either produces a value from the payload or
// produces `None`, and `None` reaches the surface as "no reading yet".

use std::collections::HashMap;

use serde_json::{json, Value};

use super::{BridgeInfo, BridgeKind, BridgePull, DevicePull, HomeAdapter, HomeError, RoomPull, ScenePull};
use crate::home::ws::WsClient;

/// The HA entity domains Atlas renders. Anything else — `automation`, `script`,
/// `person`, `sun`, `zone`, `update`, `input_*` — is skipped rather than shown
/// as a nameless "sensor": those are Home Assistant's own machinery, and a
/// device list that contains them is a debugging view, not a house.
const RENDERED_DOMAINS: &[&str] = &[
    "light",
    "switch",
    "lock",
    "cover",
    "climate",
    "media_player",
    "fan",
    "vacuum",
    "camera",
    "sensor",
    "binary_sensor",
    "water_heater",
];

pub struct HomeAssistant {
    /// Origin only, no trailing slash: `http://homeassistant.local:8123`.
    base_url: String,
    /// The long-lived access token. Read from the Keychain on construction and
    /// never written anywhere else — not to the DB, not to a log line, not into
    /// an error message (see `http_err`).
    token: String,
}

impl HomeAssistant {
    pub fn new(base_url: &str, token: &str) -> HomeAssistant {
        HomeAssistant {
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }

    fn get(&self, path: &str) -> Result<Value, HomeError> {
        crate::http::agent()
            .get(&format!("{}{path}", self.base_url))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Content-Type", "application/json")
            .call()
            .map_err(http_err)?
            .into_json::<Value>()
            .map_err(|e| HomeError::Malformed(format!("the bridge sent something unreadable: {e}")))
    }

    fn post(&self, path: &str, body: Value) -> Result<Value, HomeError> {
        crate::http::agent()
            .post(&format!("{}{path}", self.base_url))
            .set("Authorization", &format!("Bearer {}", self.token))
            .send_json(body)
            .map_err(http_err)?
            .into_json::<Value>()
            // A service call answers with a (possibly empty) array of changed
            // states. An unreadable body after a 200 still means the call
            // happened, so this is not an error — but it is also not a result
            // we get to describe, so it comes back as null.
            .or(Ok(Value::Null))
    }

    /// Call one Home Assistant service on one entity.
    ///
    /// `data` must already name its `entity_id`. A service call with no target
    /// applies to EVERY entity in the domain — `light.turn_off` with an empty
    /// body switches off the whole house — so the caller not supplying one is a
    /// bug that must fail here rather than execute broadly.
    fn service(&self, domain: &str, service: &str, data: Value) -> Result<(), HomeError> {
        if data["entity_id"].as_str().map(str::is_empty) != Some(false) {
            return Err(HomeError::Refused(format!(
                "refusing to call {domain}.{service} with no entity: it would apply to every \
                 {domain} in the house"
            )));
        }
        self.post(&format!("/api/services/{domain}/{service}"), data)?;
        Ok(())
    }

    fn ws_url(&self) -> String {
        // http -> ws, https -> wss (which ws.rs refuses out loud rather than
        // downgrading; see the note there).
        let swapped = if let Some(rest) = self.base_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.base_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            format!("ws://{}", self.base_url)
        };
        format!("{swapped}/api/websocket")
    }

    /// Open the WebSocket and complete Home Assistant's auth handshake.
    ///
    /// The protocol: the server sends `auth_required`, we send `auth` with the
    /// token, and it answers `auth_ok` or `auth_invalid`. An `auth_invalid` is
    /// mapped to the same `Unauthorised` the REST side produces, so a bad token
    /// reads the same however it was discovered.
    fn ws_connect(&self) -> Result<WsClient, HomeError> {
        let mut ws = WsClient::connect(&self.ws_url()).map_err(ws_err)?;
        // The first message is `auth_required`. Read it so a peer that sends
        // something else fails here rather than later.
        let hello = ws.next_text().map_err(ws_err)?;
        let hello: Value = serde_json::from_str(&hello)
            .map_err(|_| HomeError::Malformed("the bridge's first message was not JSON".into()))?;
        if hello["type"] != json!("auth_required") {
            return Err(HomeError::Malformed(
                "the bridge did not open with auth_required, so it is not a Home Assistant \
                 WebSocket"
                    .into(),
            ));
        }
        ws.send_text(&json!({ "type": "auth", "access_token": self.token }).to_string())
            .map_err(ws_err)?;
        let reply = ws.next_text().map_err(ws_err)?;
        let reply: Value = serde_json::from_str(&reply)
            .map_err(|_| HomeError::Malformed("the bridge's auth reply was not JSON".into()))?;
        match reply["type"].as_str() {
            Some("auth_ok") => Ok(ws),
            Some("auth_invalid") => Err(HomeError::Unauthorised(
                "Home Assistant rejected the access token.".into(),
            )),
            _ => Err(HomeError::Malformed(
                "the bridge answered the auth message with something unexpected".into(),
            )),
        }
    }

    /// One request/response round trip on an authenticated WebSocket.
    fn ws_call(&self, ws: &mut WsClient, id: u64, request: Value) -> Result<Value, HomeError> {
        ws.send_text(&request.to_string()).map_err(ws_err)?;
        // Events for other subscriptions can interleave with a result, so read
        // until the id matches rather than assuming the next frame is ours.
        for _ in 0..64 {
            let text = ws.next_text().map_err(ws_err)?;
            let msg: Value = serde_json::from_str(&text)
                .map_err(|_| HomeError::Malformed("the bridge sent a non-JSON message".into()))?;
            if msg["id"].as_u64() == Some(id) && msg["type"] == json!("result") {
                if msg["success"] == json!(false) {
                    return Err(HomeError::Malformed(format!(
                        "the bridge refused a registry request: {}",
                        msg["error"]["message"].as_str().unwrap_or("no reason given")
                    )));
                }
                return Ok(msg["result"].clone());
            }
        }
        Err(HomeError::Malformed(
            "the bridge never answered the registry request".into(),
        ))
    }

    /// Rooms, and which entity is in which — the half REST cannot serve.
    fn registry(&self) -> Result<(Vec<RoomPull>, HashMap<String, String>), HomeError> {
        let mut ws = self.ws_connect()?;
        let areas = self.ws_call(&mut ws, 1, json!({ "id": 1, "type": "config/area_registry/list" }))?;
        let entities =
            self.ws_call(&mut ws, 2, json!({ "id": 2, "type": "config/entity_registry/list" }))?;
        ws.close();
        Ok(parse_registry(&areas, &entities))
    }
}

/// Split the two registry payloads into rooms and an entity→area index.
pub fn parse_registry(areas: &Value, entities: &Value) -> (Vec<RoomPull>, HashMap<String, String>) {
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

    let index = entities
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    Some((
                        e["entity_id"].as_str()?.to_string(),
                        e["area_id"].as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();

    (rooms, index)
}

/// Never let a bridge's own body reach the user or the model.
///
/// A Home Assistant error body can contain entity names and, on some
/// integrations, credentials for downstream services. The status code is the
/// part that tells anybody what to do next.
fn http_err(e: ureq::Error) -> HomeError {
    match e {
        ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => HomeError::Unauthorised(
            "Home Assistant rejected the access token. Create a new long-lived token in your \
             Home Assistant profile and link the bridge again."
                .into(),
        ),
        ureq::Error::Status(404, _) => HomeError::Malformed(
            "that address answered, but not as a Home Assistant API.".into(),
        ),
        ureq::Error::Status(code, _) => {
            HomeError::Unreachable(format!("Home Assistant answered with an error ({code})."))
        }
        ureq::Error::Transport(_) => HomeError::Unreachable(
            "Atlas could not reach the bridge. Check that it is on and that the address is right."
                .into(),
        ),
    }
}

fn ws_err(e: super::ws::WsError) -> HomeError {
    use super::ws::WsError;
    match e {
        WsError::BadUrl(m) => HomeError::Malformed(m),
        WsError::Io(m) => HomeError::Unreachable(m),
        WsError::Handshake(m) | WsError::Protocol(m) => HomeError::Malformed(m),
        WsError::Closed => HomeError::Unreachable("the bridge closed the connection".into()),
        WsError::Idle => HomeError::Unreachable("the bridge went quiet".into()),
    }
}

// ---------------------------------------------------------------------------
// Entity mapping — pure, and therefore the part that is actually verified
// ---------------------------------------------------------------------------

pub fn domain_of(entity_id: &str) -> &str {
    entity_id.split_once('.').map(|(d, _)| d).unwrap_or("")
}

/// The `cover` half of `kind_of`, split out because `control_of` has to reach
/// the same verdict and two copies of this table would drift.
///
/// Home Assistant's `CoverDeviceClass` puts a garage door, a gate, a front door
/// and a bedroom blind in one domain. Three of those give access to the house;
/// the rest cover a window. Getting that wrong in either direction is a real
/// consequence, so this arm is exhaustive over the enum and **fails closed on a
/// class it does not recognise**: a member HA adds after this table was written
/// is far more likely to be a new kind of opening than a new kind of blind, and
/// guessing "blind" is how a door ends up on an Actuate-tier slider.
fn cover_kind(class: &str) -> &'static str {
    match class {
        // Access to the house. `door` was missing here and that was a hole: a
        // `cover` with device_class "door" took the `_` arm, came out a blind,
        // and `home_device_set` — which auto-runs at Tier::Actuate — would open
        // it with no approval card. All three leave that tier via LOCK_KINDS.
        "garage" | "gate" | "door" => "garage",
        "curtain" => "curtain",
        // The window-covering half of CoverDeviceClass, plus `damper` (HVAC).
        "blind" | "shade" | "shutter" | "awning" | "window" | "damper" => "blind",
        // No class at all is Home Assistant's own default for a plain cover,
        // and a plain cover is a blind. That is a fact about HA, not a guess.
        "" => "blind",
        // A class this table has never heard of. Not settable — see
        // `home::device_set_allowed`, which names the reason.
        _ => "cover",
    }
}

/// What kind of thing this entity is, in the surface's vocabulary.
///
/// The device_class attribute is consulted where it changes the answer — a
/// `cover` is a blind, a curtain or a garage door, and the last of those is in
/// the lock domain, which is a safety decision rather than an icon choice.
pub fn kind_of(entity_id: &str, attrs: &Value) -> &'static str {
    let class = attrs["device_class"].as_str().unwrap_or("");
    match domain_of(entity_id) {
        "light" => "bulb",
        "switch" => "plug",
        "lock" => "lock",
        "cover" => cover_kind(class),
        "climate" | "water_heater" => "thermostat",
        "media_player" => "speaker",
        "fan" => "purifier",
        "vacuum" => "vacuum",
        "camera" => "camera",
        "binary_sensor" => match class {
            "smoke" => "smoke",
            "door" | "garage_door" => "doorbell",
            _ => "sensor",
        },
        _ => "sensor",
    }
}

/// The affordance the surface draws. `status` is the honest one: a device that
/// reports and cannot be commanded.
pub fn control_of(entity_id: &str, attrs: &Value) -> &'static str {
    match domain_of(entity_id) {
        "light" => {
            let colour_capable = attrs["supported_color_modes"]
                .as_array()
                .map(|m| {
                    m.iter().any(|v| {
                        matches!(v.as_str(), Some("hs") | Some("rgb") | Some("rgbw") | Some("xy"))
                    })
                })
                .unwrap_or(false);
            if colour_capable {
                "colour"
            } else {
                "slider"
            }
        }
        "switch" | "lock" | "vacuum" => "toggle",
        // A cover whose class this build does not recognise reports and cannot
        // be commanded, so it draws the "No control · reports only" pill rather
        // than a slider that would refuse the moment it was moved.
        "cover" => match cover_kind(attrs["device_class"].as_str().unwrap_or("")) {
            "cover" => "status",
            _ => "slider",
        },
        "climate" | "water_heater" => "stepper",
        "media_player" => "slider",
        "fan" => "segmented",
        _ => "status",
    }
}

/// The number the surface shows, in the unit its `control` implies.
///
/// `None` where the bridge gave no number. That is the whole discipline of this
/// function: a light whose brightness attribute is absent is not a light at 0.
pub fn value_of(entity_id: &str, state: &str, attrs: &Value) -> Option<f64> {
    // FIRST, because every arm below reads `state` as an answer. Without this
    // an `unavailable` light took the `!on` branch and came back as `Some(0.0)`
    // — a lamp Atlas cannot reach, reported as a lamp that is switched off.
    // That is the one fabrication this whole module exists to avoid, and it is
    // also load-bearing for the mirror: `apply_pull` COALESCEs a `None` onto
    // the last known value, so a `Some(0.0)` here would overwrite the real
    // reading with a zero the bridge never sent.
    if !is_available(state) {
        return None;
    }
    let on = state == "on";
    match domain_of(entity_id) {
        "light" => {
            if !on {
                return Some(0.0);
            }
            attrs["brightness"]
                .as_f64()
                // Home Assistant reports 0-255; the surface's slider is 0-100.
                .map(|b| (b / 255.0 * 100.0).round())
        }
        "switch" => Some(if on { 1.0 } else { 0.0 }),
        "lock" => Some(if state == "locked" { 1.0 } else { 0.0 }),
        "cover" => attrs["current_position"].as_f64().or(match state {
            "open" => Some(100.0),
            "closed" => Some(0.0),
            _ => None,
        }),
        "climate" | "water_heater" => attrs["current_temperature"].as_f64(),
        "media_player" => attrs["volume_level"].as_f64().map(|v| (v * 100.0).round()),
        "fan" => attrs["percentage"].as_f64(),
        "vacuum" => Some(if state == "cleaning" { 1.0 } else { 0.0 }),
        "binary_sensor" => Some(if on { 1.0 } else { 0.0 }),
        // A numeric sensor reports its reading as the state string.
        "sensor" => state.parse::<f64>().ok(),
        _ => None,
    }
}

/// `#rrggbb` when the bridge reports one.
pub fn colour_of(attrs: &Value) -> Option<String> {
    let rgb = attrs["rgb_color"].as_array()?;
    if rgb.len() != 3 {
        return None;
    }
    let c: Vec<u8> = rgb
        .iter()
        .map(|v| v.as_u64().unwrap_or(0).min(255) as u8)
        .collect();
    Some(format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]))
}

/// `unavailable` and `unknown` are Home Assistant's two words for "I cannot
/// answer". Everything else is an answer, including "off".
pub fn is_available(state: &str) -> bool {
    !matches!(state, "unavailable" | "unknown" | "")
}

/// The device's own state word, capitalised. Not a sentence Atlas composed —
/// a unit is appended only when the bridge supplied one.
fn state_words(state: &str, attrs: &Value) -> String {
    if !is_available(state) {
        return "Not responding".to_string();
    }
    let unit = attrs["unit_of_measurement"].as_str().unwrap_or("");
    let mut words = state.replace('_', " ");
    if let Some(first) = words.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    if unit.is_empty() {
        words
    } else {
        format!("{words} {unit}")
    }
}

/// Turn one `/api/states` entry into a device, or `None` if it is not one.
pub fn device_from_state(entry: &Value, areas: &HashMap<String, String>) -> Option<DevicePull> {
    let entity_id = entry["entity_id"].as_str()?;
    if !RENDERED_DOMAINS.contains(&domain_of(entity_id)) {
        return None;
    }
    let state = entry["state"].as_str().unwrap_or("");
    let attrs = &entry["attributes"];
    Some(DevicePull {
        external_id: entity_id.to_string(),
        name: attrs["friendly_name"]
            .as_str()
            .unwrap_or(entity_id)
            .to_string(),
        kind: kind_of(entity_id, attrs).to_string(),
        control: control_of(entity_id, attrs).to_string(),
        room_external_id: areas.get(entity_id).cloned(),
        value: value_of(entity_id, state, attrs),
        state: Some(state_words(state, attrs)),
        colour: colour_of(attrs),
        available: is_available(state),
        last_changed: entry["last_changed"].as_str().map(str::to_string),
    })
}

/// Does this scene member reach a lock?
///
/// `attrs` is the member's OWN attributes, looked up from the same `/api/states`
/// payload the scene came from — and `None` means it was not in that payload.
/// Both of the ways this returns true are the fail-closed answer:
///
///   * a `cover` is a garage door or a blind depending on nothing but its own
///     `device_class`, so the entity id alone cannot decide it. It used to be
///     asked to: `kind_of(id, &Value::Null)` was passed a null attribute bag,
///     which can only ever come back "blind", so the garage half of this rule
///     was unreachable and `scene.leaving` containing `cover.garage_door` was
///     stored as lock-free and auto-runnable at Tier::Actuate.
///   * a member the bridge did not describe is a member Atlas cannot vouch for.
fn member_touches_lock(id: &str, attrs: Option<&Value>) -> bool {
    if domain_of(id) == "lock" {
        return true;
    }
    match attrs {
        Some(a) => super::is_lock_kind(kind_of(id, a)),
        None => true,
    }
}

/// Turn one `scene.*` state entry into a scene.
///
/// `member_attrs` answers "what are this entity's attributes", from the whole
/// states payload. `touches_locks` defaults to TRUE when the scene does not
/// publish its member list at all. That is the fail-closed half of the lock
/// rule: the control port may only auto-run a scene it can prove contains no
/// lock, and "the bridge did not say" is not proof.
pub fn scene_from_state(
    entry: &Value,
    member_attrs: &HashMap<&str, &Value>,
) -> Option<ScenePull> {
    let entity_id = entry["entity_id"].as_str()?;
    if domain_of(entity_id) != "scene" {
        return None;
    }
    let attrs = &entry["attributes"];
    let members = attrs["entity_id"].as_array();
    let touches_locks = match members {
        Some(list) => list.iter().any(|m| {
            let id = m.as_str().unwrap_or("");
            member_touches_lock(id, member_attrs.get(id).copied())
        }),
        None => true,
    };
    Some(ScenePull {
        external_id: entity_id.to_string(),
        label: attrs["friendly_name"]
            .as_str()
            .unwrap_or(entity_id)
            .to_string(),
        touches_locks,
    })
}

/// Split a whole `/api/states` payload into devices and scenes.
///
/// Scenes are parsed HERE rather than one entry at a time because a scene's
/// membership is a list of bare entity ids, and whether one of those is a lock
/// is a property of that member's own `device_class` — which only exists
/// elsewhere in this same payload.
pub fn parse_states(states: &Value, areas: &HashMap<String, String>) -> (Vec<DevicePull>, Vec<ScenePull>) {
    let list = states.as_array().cloned().unwrap_or_default();
    let member_attrs: HashMap<&str, &Value> = list
        .iter()
        .filter_map(|e| Some((e["entity_id"].as_str()?, &e["attributes"])))
        .collect();
    let devices = list.iter().filter_map(|e| device_from_state(e, areas)).collect();
    let scenes = list
        .iter()
        .filter_map(|e| scene_from_state(e, &member_attrs))
        .collect();
    (devices, scenes)
}

/// The service call that sets `entity_id` to `value`.
///
/// Returned as data rather than performed, so the mapping from "the user moved
/// a slider to 40" to "call light.turn_on with brightness_pct 40" is testable
/// without a hub. `None` means this device cannot be set at all — a sensor is
/// not a control, and pretending otherwise would report success for a call that
/// was never made.
pub fn set_value_call(entity_id: &str, value: f64) -> Option<(String, String, Value)> {
    let domain = domain_of(entity_id).to_string();
    let on = value > 0.0;
    let data = match domain.as_str() {
        "light" => {
            if on {
                json!({ "entity_id": entity_id, "brightness_pct": value.clamp(0.0, 100.0).round() })
            } else {
                json!({ "entity_id": entity_id })
            }
        }
        "switch" | "vacuum" => json!({ "entity_id": entity_id }),
        "cover" => json!({ "entity_id": entity_id, "position": value.clamp(0.0, 100.0).round() }),
        "climate" | "water_heater" => json!({ "entity_id": entity_id, "temperature": value }),
        "media_player" => {
            json!({ "entity_id": entity_id, "volume_level": (value / 100.0).clamp(0.0, 1.0) })
        }
        "fan" => json!({ "entity_id": entity_id, "percentage": value.clamp(0.0, 100.0).round() }),
        _ => return None,
    };
    let service = match domain.as_str() {
        "cover" => "set_cover_position".to_string(),
        "climate" | "water_heater" => "set_temperature".to_string(),
        "media_player" => "volume_set".to_string(),
        "fan" => "set_percentage".to_string(),
        "vacuum" => if on { "start" } else { "stop" }.to_string(),
        _ => if on { "turn_on" } else { "turn_off" }.to_string(),
    };
    Some((domain, service, data))
}

impl HomeAdapter for HomeAssistant {
    fn probe(&self) -> Result<BridgeInfo, HomeError> {
        // `/api/` is the cheapest authenticated endpoint HA has: it exists on
        // every version and returns a fixed message, so a 200 here means both
        // "reachable" and "this token works".
        let hello = self.get("/api/")?;
        if hello["message"].as_str().map(|m| m.contains("API running")) != Some(true) {
            return Err(HomeError::Malformed(
                "that address answered, but it is not a Home Assistant API.".into(),
            ));
        }
        // Config is nice-to-have: a bridge that authenticates but hides its
        // config is still linked, and Atlas names it generically rather than
        // failing the link over a label.
        let config = self.get("/api/config").unwrap_or(Value::Null);
        let name = config["location_name"]
            .as_str()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or("Home Assistant")
            .to_string();
        let version = config["version"].as_str().unwrap_or("");
        Ok(BridgeInfo {
            kind: BridgeKind::HomeAssistant,
            name,
            detail: if version.is_empty() {
                "Two-way · local network".to_string()
            } else {
                format!("Two-way · local network · {version}")
            },
            connected: true,
        })
    }

    fn pull(&self) -> Result<BridgePull, HomeError> {
        // Rooms first, and a failure here is survivable: `registry` needs the
        // WebSocket, and a hub behind a proxy that only forwards HTTP still has
        // devices worth showing. They land in "No room" and the sync succeeds.
        let (rooms, areas) = match self.registry() {
            Ok(pair) => pair,
            Err(e) => {
                log::warn!("[home] room registry unavailable, syncing without rooms: {e}");
                (Vec::new(), HashMap::new())
            }
        };
        let states = self.get("/api/states")?;
        if !states.is_array() {
            return Err(HomeError::Malformed(
                "the bridge's state list was not a list.".into(),
            ));
        }
        let (devices, scenes) = parse_states(&states, &areas);
        Ok(BridgePull { rooms, devices, scenes })
    }

    fn set_value(&self, external_id: &str, value: f64) -> Result<(), HomeError> {
        let (domain, service, data) = set_value_call(external_id, value).ok_or_else(|| {
            HomeError::Refused(format!(
                "{external_id} reports only — there is nothing on it to set."
            ))
        })?;
        self.service(&domain, &service, data)
    }

    fn set_colour(&self, external_id: &str, colour: &str) -> Result<(), HomeError> {
        let rgb = parse_hex(colour).ok_or_else(|| {
            HomeError::Refused("a colour must be #rrggbb, as the surface's swatches are.".into())
        })?;
        if domain_of(external_id) != "light" {
            return Err(HomeError::Refused(format!(
                "{external_id} is not a light, so it has no colour to set."
            )));
        }
        self.service(
            "light",
            "turn_on",
            json!({ "entity_id": external_id, "rgb_color": [rgb.0, rgb.1, rgb.2] }),
        )
    }

    fn set_lock(&self, external_id: &str, locked: bool) -> Result<(), HomeError> {
        match domain_of(external_id) {
            "lock" => self.service(
                "lock",
                if locked { "lock" } else { "unlock" },
                json!({ "entity_id": external_id }),
            ),
            // A garage door is in the lock domain for safety but is a `cover`
            // to Home Assistant, so it needs the cover services.
            "cover" => self.service(
                "cover",
                if locked { "close_cover" } else { "open_cover" },
                json!({ "entity_id": external_id }),
            ),
            _ => Err(HomeError::Refused(format!(
                "{external_id} is not a lock."
            ))),
        }
    }

    fn run_scene(&self, external_id: &str) -> Result<(), HomeError> {
        self.service("scene", "turn_on", json!({ "entity_id": external_id }))
    }
}

fn parse_hex(colour: &str) -> Option<(u8, u8, u8)> {
    let h = colour.strip_prefix('#')?;
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some((
        u8::from_str_radix(&h[0..2], 16).ok()?,
        u8::from_str_radix(&h[2..4], 16).ok()?,
        u8::from_str_radix(&h[4..6], 16).ok()?,
    ))
}

// ---------------------------------------------------------------------------
// The live channel
// ---------------------------------------------------------------------------

/// One pushed state change, already reduced to what the mirror stores.
#[derive(Debug)]
pub struct PushedState {
    pub external_id: String,
    pub value: Option<f64>,
    pub state: String,
    pub colour: Option<String>,
    pub available: bool,
    pub last_changed: Option<String>,
}

/// Reduce a `state_changed` event to a mirror update, or `None` when it is not
/// about a device the surface renders.
pub fn pushed_state(event: &Value) -> Option<PushedState> {
    let new_state = &event["event"]["data"]["new_state"];
    let entity_id = new_state["entity_id"].as_str()?;
    if !RENDERED_DOMAINS.contains(&domain_of(entity_id)) {
        return None;
    }
    let state = new_state["state"].as_str().unwrap_or("");
    let attrs = &new_state["attributes"];
    Some(PushedState {
        external_id: entity_id.to_string(),
        value: value_of(entity_id, state, attrs),
        state: state_words(state, attrs),
        colour: colour_of(attrs),
        available: is_available(state),
        last_changed: new_state["last_changed"].as_str().map(str::to_string),
    })
}

impl HomeAssistant {
    /// Subscribe to `state_changed` and hand each one to `on_state` until
    /// `keep_going` says stop or the socket fails.
    ///
    /// Blocking, and meant to own a thread of its own. It never retries: the
    /// supervisor in mod.rs owns the backoff, because a reconnect policy that
    /// lives inside the read loop cannot be told to stop.
    pub fn subscribe(
        &self,
        keep_going: &dyn Fn() -> bool,
        on_state: &mut dyn FnMut(PushedState),
    ) -> Result<(), HomeError> {
        let mut ws = self.ws_connect()?;
        ws.send_text(
            &json!({ "id": 1, "type": "subscribe_events", "event_type": "state_changed" })
                .to_string(),
        )
        .map_err(ws_err)?;

        while keep_going() {
            match ws.next_text() {
                Ok(text) => {
                    let msg: Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        // One unreadable frame is not a reason to drop a
                        // working subscription; a broken socket is, and that
                        // arrives as an Err below.
                        Err(_) => continue,
                    };
                    if msg["type"] != json!("event") {
                        continue;
                    }
                    if let Some(update) = pushed_state(&msg) {
                        on_state(update);
                    }
                }
                // The read timeout is how this loop gets to re-check the stop
                // flag on an idle socket. It is not a failure.
                Err(super::ws::WsError::Idle) => continue,
                Err(e) => {
                    ws.close();
                    return Err(ws_err(e));
                }
            }
        }
        ws.close();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A stub Home Assistant, on a kernel-chosen port.
    ///
    /// The model for this is services/atlas-brain/src/control.test.ts: it
    /// REIMPLEMENTS the peer's contract — including what the peer refuses —
    /// rather than mocking our own client. That is what makes a green test
    /// evidence about the wire and not about the mock.
    struct StubHa {
        port: u16,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl StubHa {
        /// `routes` maps a path to (status, body). A path that is not in the
        /// map gets a 404, exactly as Home Assistant would.
        ///
        /// SERVES UNTIL DROPPED rather than for a fixed number of requests, and
        /// that is not tidiness. `pull()` opens a WebSocket before it fetches
        /// `/api/states`, so a counted stub silently ran out of accepts and the
        /// state fetch came back as a TRANSPORT error — which made
        /// "the bridge sent garbage" and "the bridge is switched off" the same
        /// test result, i.e. the two failures these tests exist to tell apart.
        fn start(routes: Vec<(&'static str, u16, &'static str)>) -> StubHa {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
            let port = listener.local_addr().unwrap().port();
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let thread_stop = stop.clone();
            let handle = std::thread::spawn(move || {
                loop {
                    let Ok((mut sock, _)) = listener.accept() else { return };
                    if thread_stop.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    let mut buf = [0u8; 4096];
                    let n = sock.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = head
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    // The real API answers 401 to a request with no bearer
                    // token, so the stub does too — otherwise a client that
                    // forgot the header would pass this test.
                    let (status, body) = if !head.contains("Authorization: Bearer ") {
                        (401u16, "{\"message\":\"Unauthorized\"}")
                    } else {
                        routes
                            .iter()
                            .find(|(p, _, _)| *p == path)
                            .map(|(_, s, b)| (*s, *b))
                            .unwrap_or((404, "{\"message\":\"Not found\"}"))
                    };
                    let response = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(response.as_bytes());
                }
            });
            StubHa { port, stop, handle: Some(handle) }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
    }

    impl Drop for StubHa {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            // `accept()` is blocking, so the flag alone would never be read.
            // One throwaway connection wakes it; the thread then sees the flag
            // and returns instead of serving.
            let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    #[test]
    fn a_good_token_probes_and_names_the_house() {
        let stub = StubHa::start(
            vec![
                ("/api/", 200, "{\"message\":\"API running.\"}"),
                ("/api/config", 200, "{\"location_name\":\"Sorø\",\"version\":\"2026.7.1\"}"),
            ],
        );
        let ha = HomeAssistant::new(&stub.url(), "good-token");
        let info = ha.probe().expect("a reachable, authorised bridge");
        assert_eq!(info.name, "Sorø");
        assert!(info.detail.contains("2026.7.1"));
        assert!(info.connected);
    }

    #[test]
    fn a_rejected_token_is_reported_as_an_auth_problem_not_a_network_one() {
        let stub = StubHa::start(vec![("/api/", 401, "{\"message\":\"Unauthorized\"}")]);
        let ha = HomeAssistant::new(&stub.url(), "stale-token");
        let err = ha.probe().expect_err("401 must not look like success");
        assert!(matches!(err, HomeError::Unauthorised(_)), "{err}");
        // The fix has to be actionable, and the token must not be echoed.
        let msg = err.to_string();
        assert!(msg.contains("token"), "{msg}");
        assert!(!msg.contains("stale-token"), "an error must never echo the token");
    }

    #[test]
    fn an_unreachable_bridge_is_an_error_and_never_an_empty_house() {
        // Bind, learn the port, then drop the listener: nothing is listening,
        // which is what a hub that is switched off looks like.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let ha = HomeAssistant::new(&format!("http://127.0.0.1:{port}"), "t");
        let err = ha.probe().expect_err("an unreachable bridge is not a house with no devices");
        assert!(matches!(err, HomeError::Unreachable(_)), "{err}");
    }

    #[test]
    fn something_that_is_not_home_assistant_is_refused_even_with_a_200() {
        let stub = StubHa::start(vec![("/api/", 200, "{\"hello\":\"i am a router\"}")]);
        let ha = HomeAssistant::new(&stub.url(), "t");
        let err = ha.probe().expect_err("a 200 from the wrong server is not a link");
        assert!(matches!(err, HomeError::Malformed(_)), "{err}");
    }

    #[test]
    fn a_malformed_body_is_refused_rather_than_read_as_an_empty_house() {
        let stub = StubHa::start(
            vec![
                ("/api/", 200, "{\"message\":\"API running.\"}"),
                ("/api/config", 200, "{}"),
                ("/api/states", 200, "not json at all"),
            ],
        );
        let ha = HomeAssistant::new(&stub.url(), "t");
        assert!(ha.probe().is_ok());
        let err = ha.pull().expect_err("unreadable JSON is not zero devices");
        assert!(matches!(err, HomeError::Malformed(_)), "{err}");
    }

    #[test]
    fn a_state_list_that_is_not_a_list_is_refused() {
        let stub = StubHa::start(
            vec![("/api/states", 200, "{\"error\":\"nope\"}")],
        );
        let ha = HomeAssistant::new(&stub.url(), "t");
        let err = ha.pull().expect_err("an object is not a state list");
        assert!(matches!(err, HomeError::Malformed(_)), "{err}");
    }

    // --- the pure mapping ---------------------------------------------------

    fn state(entity: &str, state: &str, attrs: Value) -> Value {
        json!({ "entity_id": entity, "state": state, "attributes": attrs,
                "last_changed": "2026-08-08T10:00:00.000000+00:00" })
    }

    #[test]
    fn a_light_maps_brightness_to_the_sliders_scale() {
        let e = state("light.arc", "on", json!({ "friendly_name": "Arc", "brightness": 255 }));
        let d = device_from_state(&e, &HashMap::new()).unwrap();
        assert_eq!(d.value, Some(100.0));
        assert_eq!(d.control, "slider");
        assert_eq!(d.name, "Arc");
        assert!(d.available);

        let half = state("light.arc", "on", json!({ "brightness": 128 }));
        assert_eq!(device_from_state(&half, &HashMap::new()).unwrap().value, Some(50.0));
    }

    /// The one mapping that must not guess. A light that is on but reports no
    /// brightness is not a light at 0 and not a light at 100.
    #[test]
    fn a_missing_reading_stays_missing() {
        let e = state("light.arc", "on", json!({}));
        assert_eq!(device_from_state(&e, &HashMap::new()).unwrap().value, None);

        let sensor = state("sensor.humidity", "not-a-number", json!({}));
        assert_eq!(device_from_state(&sensor, &HashMap::new()).unwrap().value, None);
    }

    #[test]
    fn an_unavailable_entity_is_marked_and_not_silently_zeroed() {
        let e = state("light.arc", "unavailable", json!({ "friendly_name": "Arc" }));
        let d = device_from_state(&e, &HashMap::new()).unwrap();
        assert!(!d.available);
        assert_eq!(d.value, None);
        assert_eq!(d.state.as_deref(), Some("Not responding"));
    }

    #[test]
    fn a_colour_light_gets_the_colour_affordance_and_a_hex_swatch() {
        let e = state(
            "light.strip",
            "on",
            json!({ "supported_color_modes": ["hs"], "rgb_color": [255, 170, 0], "brightness": 255 }),
        );
        let d = device_from_state(&e, &HashMap::new()).unwrap();
        assert_eq!(d.control, "colour");
        assert_eq!(d.colour.as_deref(), Some("#ffaa00"));
    }

    #[test]
    fn a_garage_cover_is_in_the_lock_domain_and_a_blind_is_not() {
        let garage = state("cover.garage", "closed", json!({ "device_class": "garage" }));
        assert_eq!(device_from_state(&garage, &HashMap::new()).unwrap().kind, "garage");
        // No device_class is Home Assistant's own default for a plain cover.
        let blind = state("cover.blinds", "open", json!({ "current_position": 55 }));
        let d = device_from_state(&blind, &HashMap::new()).unwrap();
        assert_eq!(d.kind, "blind");
        assert_eq!(d.value, Some(55.0));
    }

    /// Home Assistant's `CoverDeviceClass` has a `door` member, for a door or a
    /// gate that gives access to an area. It used to fall through to "blind",
    /// which put a front door on the Actuate tier: `home_device_set` accepted
    /// it and issued `cover.set_cover_position position=100` with no approval
    /// card. Every class that opens the house has to reach the lock kinds.
    #[test]
    fn every_cover_that_opens_the_house_leaves_the_actuate_tier() {
        for class in ["garage", "gate", "door"] {
            let e = state("cover.front", "closed", json!({ "device_class": class }));
            let d = device_from_state(&e, &HashMap::new()).unwrap();
            assert_eq!(d.kind, "garage", "device_class '{class}' must be a lock kind");
            assert!(super::super::is_lock_kind(&d.kind), "'{class}' must be in LOCK_KINDS");
            assert!(
                super::super::device_set_allowed(&d.kind, &d.control, "Front").is_err(),
                "the Actuate path must refuse a '{class}' cover"
            );
        }
    }

    /// The other direction: window coverings stay settable, so failing closed
    /// on doors did not quietly make every blind inert.
    #[test]
    fn window_coverings_stay_settable() {
        for class in ["blind", "shade", "shutter", "awning", "window", "curtain"] {
            let e = state("cover.win", "open", json!({ "device_class": class }));
            let d = device_from_state(&e, &HashMap::new()).unwrap();
            assert!(!super::super::is_lock_kind(&d.kind), "'{class}' is not a lock");
            assert_eq!(d.control, "slider", "'{class}' must keep its slider");
            assert!(super::super::device_set_allowed(&d.kind, &d.control, "Blind").is_ok());
        }
    }

    /// A device_class this table has never seen is far more likely to be a new
    /// kind of opening than a new kind of blind, so it is refused rather than
    /// guessed at — and it is refused as a cover, not as a broken sensor.
    #[test]
    fn an_unrecognised_cover_class_fails_closed_rather_than_becoming_a_blind() {
        let e = state("cover.mystery", "closed", json!({ "device_class": "portcullis" }));
        let d = device_from_state(&e, &HashMap::new()).unwrap();
        assert_eq!(d.kind, "cover");
        assert_eq!(d.control, "status");
        let err = super::super::device_set_allowed(&d.kind, &d.control, "Mystery").unwrap_err();
        assert!(err.contains("cannot identify"), "the refusal must say why: {err}");
    }

    #[test]
    fn home_assistants_own_machinery_is_not_a_device() {
        for entity in [
            "automation.morning",
            "script.bedtime",
            "person.magnus",
            "sun.sun",
            "zone.home",
            "update.core",
            "input_boolean.guest",
        ] {
            assert!(
                device_from_state(&state(entity, "on", json!({})), &HashMap::new()).is_none(),
                "{entity} must not appear as a device"
            );
        }
    }

    /// Scene membership is decided from the whole states payload, so these go
    /// through `parse_states` rather than calling `scene_from_state` directly.
    fn scenes_of(entries: Vec<Value>) -> Vec<ScenePull> {
        parse_states(&Value::Array(entries), &HashMap::new()).1
    }

    #[test]
    fn a_scene_with_a_lock_is_flagged_and_an_unknown_membership_fails_closed() {
        let with_lock = scenes_of(vec![
            state("lock.front_door", "locked", json!({})),
            state("light.arc", "on", json!({})),
            state(
                "scene.away",
                "unknown",
                json!({ "friendly_name": "Away", "entity_id": ["light.arc", "lock.front_door"] }),
            ),
        ]);
        assert!(with_lock[0].touches_locks);

        let lights_only = scenes_of(vec![
            state("light.arc", "on", json!({})),
            state(
                "scene.evening",
                "unknown",
                json!({ "friendly_name": "Evening", "entity_id": ["light.arc"] }),
            ),
        ]);
        assert!(!lights_only[0].touches_locks);

        // No membership published: Atlas cannot prove there is no lock in it.
        let opaque = scenes_of(vec![state(
            "scene.mystery",
            "unknown",
            json!({ "friendly_name": "Mystery" }),
        )]);
        assert!(opaque[0].touches_locks, "an unknown membership must fail closed");
    }

    /// The one this rule was written for, and the one it did not catch. A
    /// garage door is a `cover`, so nothing about `cover.garage_door` says
    /// "lock" except that member's own `device_class` — which lives on its own
    /// states entry, not on the scene. `scene_from_state` used to consult a
    /// null attribute bag, which can only come back "blind", so this scene was
    /// stored lock-free and `home.scene_run` (Tier::Actuate) would auto-run it.
    #[test]
    fn a_scene_containing_a_garage_door_is_flagged_from_that_members_device_class() {
        let scenes = scenes_of(vec![
            state("cover.garage_door", "closed", json!({ "device_class": "garage" })),
            state("light.arc", "on", json!({})),
            state(
                "scene.leaving",
                "unknown",
                json!({
                    "friendly_name": "Leaving",
                    "entity_id": ["light.arc", "cover.garage_door"],
                }),
            ),
        ]);
        assert!(
            scenes[0].touches_locks,
            "a scene that opens the garage is not an Actuate-tier scene"
        );
        assert!(super::super::scene_run_allowed(scenes[0].touches_locks, "Leaving").is_err());

        // And the same scene with a real blind in it stays runnable, so the
        // rule discriminates rather than flagging every cover.
        let blinds = scenes_of(vec![
            state("cover.blinds", "open", json!({ "device_class": "blind" })),
            state(
                "scene.evening",
                "unknown",
                json!({ "friendly_name": "Evening", "entity_id": ["cover.blinds"] }),
            ),
        ]);
        assert!(!blinds[0].touches_locks);
    }

    /// A member the bridge listed but never described. Atlas cannot say what it
    /// is, and "cannot say" has to fail the same way "it is a lock" does.
    #[test]
    fn a_scene_member_missing_from_the_payload_fails_closed() {
        let scenes = scenes_of(vec![state(
            "scene.away",
            "unknown",
            json!({ "friendly_name": "Away", "entity_id": ["cover.somewhere_else"] }),
        )]);
        assert!(scenes[0].touches_locks);
    }

    #[test]
    fn the_registry_maps_entities_into_rooms() {
        let areas = json!([{ "area_id": "living", "name": "Living room" }]);
        let entities = json!([
            { "entity_id": "light.arc", "area_id": "living" },
            { "entity_id": "light.loose", "area_id": Value::Null },
        ]);
        let (rooms, index) = parse_registry(&areas, &entities);
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0].name, "Living room");
        assert_eq!(index.get("light.arc").map(String::as_str), Some("living"));
        assert!(!index.contains_key("light.loose"));

        let d = device_from_state(&state("light.arc", "on", json!({})), &index).unwrap();
        assert_eq!(d.room_external_id.as_deref(), Some("living"));
    }

    #[test]
    fn setting_a_value_picks_the_service_home_assistant_actually_has() {
        let (domain, service, data) = set_value_call("light.arc", 40.0).unwrap();
        assert_eq!((domain.as_str(), service.as_str()), ("light", "turn_on"));
        assert_eq!(data["brightness_pct"], json!(40.0));

        // Zero is off, not "on at 0%".
        let (_, service, _) = set_value_call("light.arc", 0.0).unwrap();
        assert_eq!(service, "turn_off");

        let (domain, service, data) = set_value_call("cover.blinds", 55.0).unwrap();
        assert_eq!((domain.as_str(), service.as_str()), ("cover", "set_cover_position"));
        assert_eq!(data["position"], json!(55.0));

        let (_, service, data) = set_value_call("media_player.sonos", 28.0).unwrap();
        assert_eq!(service, "volume_set");
        assert_eq!(data["volume_level"], json!(0.28));

        // A sensor has nothing to set, and that is a refusal rather than a
        // silent no-op reported as success.
        assert!(set_value_call("sensor.humidity", 1.0).is_none());
        assert!(set_value_call("binary_sensor.leak", 1.0).is_none());
    }

    /// A model that reads "50%" and sends 5000 must not put the room at
    /// whatever the hub does with an out-of-range number.
    #[test]
    fn an_out_of_range_value_is_clamped_to_the_units_the_service_declares() {
        let (_, _, data) = set_value_call("light.arc", 5000.0).unwrap();
        assert_eq!(data["brightness_pct"], json!(100.0));
        let (_, _, data) = set_value_call("media_player.sonos", 900.0).unwrap();
        assert_eq!(data["volume_level"], json!(1.0));
    }

    #[test]
    fn a_pushed_event_reduces_to_a_mirror_update() {
        let event = json!({
            "type": "event",
            "event": { "data": { "new_state": {
                "entity_id": "light.arc", "state": "on",
                "attributes": { "brightness": 51 },
                "last_changed": "2026-08-08T11:00:00.000000+00:00"
            }}}
        });
        let p = pushed_state(&event).unwrap();
        assert_eq!(p.external_id, "light.arc");
        assert_eq!(p.value, Some(20.0));
        assert!(p.available);

        // An event about HA's own machinery is not a device update.
        let noise = json!({
            "type": "event",
            "event": { "data": { "new_state": { "entity_id": "automation.x", "state": "on" }}}
        });
        assert!(pushed_state(&noise).is_none());
    }

    #[test]
    fn the_websocket_url_is_derived_from_the_bridge_origin() {
        assert_eq!(
            HomeAssistant::new("http://hub.local:8123/", "t").ws_url(),
            "ws://hub.local:8123/api/websocket"
        );
        assert_eq!(
            HomeAssistant::new("https://hub.example:8123", "t").ws_url(),
            "wss://hub.example:8123/api/websocket"
        );
    }

    #[test]
    fn a_colour_must_be_a_swatch_and_not_arbitrary_text() {
        assert_eq!(parse_hex("#ffaa00"), Some((255, 170, 0)));
        for bad in ["ffaa00", "#fff", "#gggggg", "", "#ffaa0"] {
            assert!(parse_hex(bad).is_none(), "'{bad}' must not parse");
        }
    }
}
