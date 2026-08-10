// HomeKit — the adapter, and the two very different reasons it can be absent.
//
// WHAT CHANGED, AND WHAT DID NOT. This file used to be a stub that refused
// everything, on the grounds that HomeKit is unreachable from a Tauri app.
// HALF OF THAT IS STILL TRUE AND IS NOT NEGOTIABLE: Apple's HomeKit FRAMEWORK
// (HMHomeManager) is documented Mac Catalyst only, Atlas is AppKit + WKWebView,
// and so there is no framework entry point to call whatever the entitlements
// say. That is recorded in docs/decisions/008-healthkit-homekit-platform-wall.md
// and pinned by src-tauri/tests/platform_health_home_wall.rs, and nothing here
// touches it — no HomeKit framework symbol is referenced in this file or in
// `home/hap/`.
//
// What replaced the stub is a different mechanism with the same goal: Atlas
// speaks the HomeKit ACCESSORY PROTOCOL itself, over TCP on the LAN, the way an
// iPhone does. The accessory does not know or care that the controller is not
// an Apple device — it checks an Ed25519 signature, not a platform.
//
// SO THERE ARE NOW THREE STATES, AND THEY MUST NOT BE COLLAPSED:
//   no controller  Atlas.app is built without the `homekit` cargo feature, so
//                  the protocol code is not in the binary at all. `NO_CONTROLLER`
//                  says so and points at Home Assistant, which does work here.
//   not paired     The controller is compiled in and nothing has been paired.
//                  `NOT_PAIRED` says what to do about it.
//   paired         A real accessory, over a real verified session.
// The stub's original discipline is kept in all three: NONE of them returns
// `Ok(BridgePull::default())`. An empty house and an impossible call are
// different answers, and this file has never confused them.
//
// WHY THE FEATURE GATE IS HERE AND NOT IN THE FRONTEND. The control port
// (src/control) is a REGISTRY, not a webview: whatever is registered is
// reachable by the model in both editions, regardless of which React screens
// shipped. A frontend gate would leave a working HomeKit controller inside
// Atlas.app with an op the brain could call. A cargo feature makes the absence
// a build fact — `registry.rs` has the test that fails if a HAP op or command
// becomes reachable without it.

use serde_json::{json, Value};

use super::{BridgeInfo, BridgeKind, BridgePull, HomeAdapter, HomeError};

/// Shown when the HAP controller is not compiled into this bundle.
///
/// It keeps naming Home Assistant because that is the alternative that works
/// in the consumer build, and a bridge row that only says "no" is a dead end.
pub const NO_CONTROLLER: &str =
    "HomeKit accessories need the Lighthouse build of Atlas — Apple's HomeKit app and framework \
     are not available to a Mac app like this one, and Atlas' own HomeKit controller is not in \
     this build. Link Home Assistant instead.";

/// Shown when the controller IS present and nothing has been paired yet.
pub const NOT_PAIRED: &str =
    "Atlas has not paired with a HomeKit accessory yet. Search for one on the Setup screen and \
     enter the 8-digit setup code printed on it.";

/// The HomeKit adapter.
///
/// A two-state enum rather than an `Option` field so that the reason for an
/// absence travels WITH the absence: `Unavailable` carries the sentence the
/// bridge row, the error and the log line all show, and there is exactly one
/// place that decides which sentence it is (`for_bridge`).
pub enum Companion {
    /// Nothing to talk to, and the string says why.
    Unavailable(String),
    #[cfg(feature = "homekit")]
    Paired(lan::Paired),
}

impl Companion {
    /// Build the adapter for a stored `homekit_companion` bridge row.
    ///
    /// THE KEYCHAIN IS READ HERE AND NOWHERE ELSE ON THE COMMAND PATH — the
    /// same rule `home/mod.rs::adapter_for` follows for the Home Assistant
    /// token. The controller's long-term secret key goes into the adapter and
    /// is never returned, logged, or put in an error message.
    #[cfg(not(feature = "homekit"))]
    pub fn for_bridge(_bridge: &super::store::BridgeRow) -> Companion {
        Companion::Unavailable(NO_CONTROLLER.to_string())
    }

    #[cfg(feature = "homekit")]
    pub fn for_bridge(bridge: &super::store::BridgeRow) -> Companion {
        let Some(target) = bridge.base_url.as_deref().and_then(lan::Target::parse) else {
            return Companion::Unavailable(NOT_PAIRED.to_string());
        };
        let Some(record) = super::hap::keystore::pairing(&target.accessory_id) else {
            // The row exists and the Keychain item does not. That is the state
            // a half-finished unlink or a restored-from-backup machine leaves
            // behind, and it is NOT "not paired yet" — saying so would send the
            // user to type a setup code that the accessory will refuse, because
            // from its side the pairing is still live.
            return Companion::Unavailable(format!(
                "Atlas has a HomeKit bridge for {} but no key for it in the Keychain. Unlink it \
                 here and pair it again — the accessory still thinks it is paired, so you may \
                 also need to reset it.",
                target.accessory_id
            ));
        };
        let Some(ltsk) = super::hap::keystore::ltsk() else {
            return Companion::Unavailable(
                "Atlas' own HomeKit identity is missing from the Keychain, so it cannot prove who \
                 it is to an accessory. Unlink and pair again."
                    .into(),
            );
        };
        Companion::Paired(lan::Paired { target, record, ltsk })
    }

    fn refusal(&self) -> Option<HomeError> {
        match self {
            Companion::Unavailable(m) => Some(HomeError::Unavailable(m.clone())),
            #[cfg(feature = "homekit")]
            Companion::Paired(_) => None,
        }
    }
}

impl HomeAdapter for Companion {
    fn probe(&self) -> Result<BridgeInfo, HomeError> {
        if let Some(e) = self.refusal() {
            return Err(e);
        }
        #[cfg(feature = "homekit")]
        match self {
            Companion::Paired(p) => return p.probe(),
            Companion::Unavailable(_) => {}
        }
        unreachable!("refusal() covers every non-paired state")
    }

    /// NOT `Ok(BridgePull::default())` when there is nothing to talk to. An
    /// adapter that cannot be reached must not answer "your house is empty" —
    /// that is the fabrication the whole module is written to avoid, and this
    /// is the shape it would take here.
    fn pull(&self) -> Result<BridgePull, HomeError> {
        if let Some(e) = self.refusal() {
            return Err(e);
        }
        #[cfg(feature = "homekit")]
        match self {
            Companion::Paired(p) => return p.pull(),
            Companion::Unavailable(_) => {}
        }
        unreachable!("refusal() covers every non-paired state")
    }

    fn set_value(&self, external_id: &str, value: f64) -> Result<(), HomeError> {
        if let Some(e) = self.refusal() {
            return Err(e);
        }
        #[cfg(feature = "homekit")]
        match self {
            Companion::Paired(p) => return p.set_value(external_id, value),
            Companion::Unavailable(_) => {}
        }
        let _ = (external_id, value);
        unreachable!("refusal() covers every non-paired state")
    }

    fn set_colour(&self, external_id: &str, colour: &str) -> Result<(), HomeError> {
        if let Some(e) = self.refusal() {
            return Err(e);
        }
        #[cfg(feature = "homekit")]
        match self {
            Companion::Paired(p) => return p.set_colour(external_id, colour),
            Companion::Unavailable(_) => {}
        }
        let _ = (external_id, colour);
        unreachable!("refusal() covers every non-paired state")
    }

    fn set_lock(&self, external_id: &str, locked: bool) -> Result<(), HomeError> {
        if let Some(e) = self.refusal() {
            return Err(e);
        }
        #[cfg(feature = "homekit")]
        match self {
            Companion::Paired(p) => return p.set_lock(external_id, locked),
            Companion::Unavailable(_) => {}
        }
        let _ = (external_id, locked);
        unreachable!("refusal() covers every non-paired state")
    }

    /// HAP HAS NO SCENES. A scene in HomeKit is a controller-side concept —
    /// Apple Home stores it and writes the characteristics itself — so there is
    /// nothing on an accessory to run, and a paired Atlas has no scene list to
    /// offer either. `Refused` rather than `Unavailable`: the accessory is
    /// reachable and working, this is simply not a thing it has.
    fn run_scene(&self, _external_id: &str) -> Result<(), HomeError> {
        if let Some(e) = self.refusal() {
            return Err(e);
        }
        Err(HomeError::Refused(
            "HomeKit scenes live in the Home app on an Apple device, not on the accessory, so \
             Atlas cannot run one over the local protocol."
                .into(),
        ))
    }
}

/// The row the Setup screen shows for HomeKit.
///
/// Still synthetic when nothing is paired — there is no `home_bridges` row for
/// a bridge that was never linked, and storing one would be a record of a thing
/// that never happened. Once a pairing exists the real row is in the table and
/// `store::snapshot` renders it; this entry is only for the empty case, which
/// is why it takes no id.
pub fn bridge_entry() -> Value {
    json!({
        "id": "homekit-companion",
        "name": "HomeKit",
        "kind": BridgeKind::HomekitCompanion.as_str(),
        "detail": default_detail(),
        "state": "not-linked",
        "health": if cfg!(feature = "homekit") { "not-linked" } else { "unavailable" },
    })
}

/// Which of the two absences this build is in.
pub fn default_detail() -> &'static str {
    if cfg!(feature = "homekit") {
        NOT_PAIRED
    } else {
        NO_CONTROLLER
    }
}

// ===========================================================================
// The LAN controller. Everything below this line is compiled ONLY into the
// Lighthouse bundle.
// ===========================================================================

#[cfg(feature = "homekit")]
pub mod lan {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    use serde_json::{json, Value};

    use super::super::hap::http::{self, Accessory, CharId, CharWrite, Characteristic, Service};
    use super::super::hap::keystore::PairingRecord;
    use super::super::hap::session::HapSession;
    use super::super::hap::verify::PairVerify;
    use super::super::{BridgeInfo, BridgeKind, BridgePull, DevicePull, HomeError};

    /// How long to wait for the TCP handshake. An accessory that has gone off
    /// the network must not hold a command thread for a minute.
    pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
    /// Read/write timeout on an established connection. `HapSession::fill`
    /// turns a timeout into `Idle`, which the HTTP layer retries against its
    /// own bounded poll budget rather than waiting forever.
    pub const IO_TIMEOUT: Duration = Duration::from_secs(6);
    /// A plaintext pair-setup/pair-verify reply cannot be larger than this.
    /// Those bodies are TLV8 handshakes of a few hundred bytes; the ceiling
    /// exists because this read happens BEFORE any authentication, against a
    /// peer that has proved nothing.
    pub const MAX_PLAIN_REPLY: usize = 16 * 1024;

    const CONTENT_TYPE_TLV8: &str = "application/pairing+tlv8";

    // -------------------------------------------------------------------
    // Where the accessory lives
    // -------------------------------------------------------------------

    /// The accessory a bridge row points at.
    ///
    /// STORED IN `home_bridges.base_url`, as `hap://<id>@<host>:<port>`. That
    /// column is a nullable TEXT with no CHECK on its contents, and the
    /// alternative — a new column, or a new `kind` value — needs a schema
    /// change to `db_schema.sql`, whose `home_bridges.kind` CHECK constraint
    /// admits exactly `home_assistant` and `homekit_companion`. Reusing the
    /// existing kind and encoding the locator in the URL keeps this change
    /// inside the files it belongs to. (The column comment in db_schema.sql
    /// still says "NULL for the companion bridge"; that is now stale, and
    /// correcting it belongs to whoever owns that file.)
    ///
    /// THE `accessory_id` IS THE IDENTITY. Host and port come from DHCP and
    /// change; the Keychain pairing is keyed on the id and nothing else.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Target {
        pub accessory_id: String,
        pub host: String,
        pub port: u16,
    }

    impl Target {
        pub fn locator(&self) -> String {
            format!("hap://{}@{}:{}", self.accessory_id, self.host, self.port)
        }

        /// `None` for anything that is not one of ours — including a plain
        /// `http://…` Home Assistant URL, which is what a mis-typed bridge kind
        /// would put here.
        pub fn parse(s: &str) -> Option<Target> {
            let rest = s.trim().strip_prefix("hap://")?;
            let (id, hostport) = rest.rsplit_once('@')?;
            let (host, port) = hostport.rsplit_once(':')?;
            let port: u16 = port.parse().ok()?;
            if id.is_empty() || host.is_empty() || port == 0 {
                return None;
            }
            Some(Target {
                accessory_id: id.to_string(),
                host: host.to_string(),
                port,
            })
        }

        /// What goes in the HTTP `Host:` header and into the connect. Kept
        /// together so the two can never disagree.
        pub fn authority(&self) -> String {
            format!("{}:{}", self.host, self.port)
        }
    }

    // -------------------------------------------------------------------
    // Apple-defined UUIDs
    // -------------------------------------------------------------------

    /// The suffix every Apple-defined HAP type shares.
    ///
    /// Derived, not guessed: `HAPUUIDIsAppleDefined` compares bytes[0..12]
    /// against `{0x91,0x52,0x76,0xBB,0x26,0x00,0x00,0x80,0x00,0x10,0x00,0x00}`
    /// (HAPUUID.c:25), and `HAPUUIDGetDescription`'s long form prints
    /// bytes[15]…bytes[0] in the usual 8-4-4-4-12 grouping (HAPUUID.c:87-104).
    /// Those two together give exactly this tail.
    pub const APPLE_UUID_SUFFIX: &str = "-0000-1000-8000-0026BB765291";

    /// Reduce a `/accessories` `type` string to the Apple-defined short value,
    /// or `None` when it is a vendor type.
    ///
    /// BOTH FORMS ARE ACCEPTED ON PURPOSE. Apple's own accessory-side code
    /// emits the SHORT form — `HAPUUIDGetDescription` prints `"%X%02X%02X%02X"`
    /// with no leading zero on the top byte, so `0x43` becomes `"43"` and
    /// `0x110` becomes `"110"` (HAPUUID.c:70-84). Other stacks (and Apple's own
    /// HomeKit Accessory Simulator, going by every published capture) emit the
    /// full 128-bit form. A controller that understood only one of them would
    /// classify half the accessories on the market as "unknown".
    ///
    /// Case-insensitive because a UUID is hex, and hex is.
    pub fn apple_type(t: &str) -> Option<u32> {
        let t = t.trim();
        // NON-ASCII IS REJECTED BEFORE ANYTHING SLICES. `t.len()` is a BYTE
        // count, and this string comes straight off the accessory's
        // /accessories JSON (http.rs takes `type` verbatim, as it must —
        // vendor UUIDs are opaque). "AAAAAAA\u{e9}0000-1000-8000-0026BB765291"
        // is 36 BYTES with a char boundary inside byte 8, so `split_at(8)`
        // panicked on it. A hex UUID is ASCII by construction, so this costs
        // nothing real and keeps the module's rule that no data path panics.
        if !t.is_ascii() {
            return None;
        }
        let core = if t.len() == 36 {
            let (head, tail) = t.split_at(8);
            if !tail.eq_ignore_ascii_case(APPLE_UUID_SUFFIX) {
                return None;
            }
            head
        } else if (1..=8).contains(&t.len()) {
            t
        } else {
            return None;
        };
        if !core.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        u32::from_str_radix(core, 16).ok()
    }

    // Service types — HAPServiceTypes.c, one `HAPUUIDCreateAppleDefined` line
    // each. Only the ones this module has an opinion about are named.
    //
    // VERIFIED AGAINST APPLE'S SOURCE on 2026-08-09, not recalled. Fetched from
    // https://raw.githubusercontent.com/apple/HomeKitADK/master/HAP/HAPServiceTypes.c
    // and .../HAPCharacteristicTypes.c, which define these as
    // `HAPUUIDCreateAppleDefined(0xNN)`. Sixteen values were checked one by one
    // and all sixteen matched what is written below, including every value that
    // decides whether something is a lock:
    //     LockMechanism 0x45 · LockManagement 0x44 · GarageDoorOpener 0x41
    //     Door 0x81 · Window 0x8B · WindowCovering 0x8C · SecuritySystem 0x7E
    //     Lightbulb 0x43 · Switch 0x49 · Outlet 0x47
    //     LockCurrentState 0x1D · LockTargetState 0x1E
    //     CurrentDoorState 0x0E · TargetDoorState 0x32 · On 0x25 · Brightness 0x08
    //
    // WHY THAT MATTERS RATHER THAN BEING TRIVIA: a wrong service number here
    // does not fail loudly. It silently files a lock as some other kind of
    // device, and a device that is not a lock does not get `Tier::Approval` —
    // so Atlas would unlock a door without ever raising a card. The numbers
    // below were originally transcribed without a primary source (the HAP spec
    // PDF needs an Apple ID), which is why this note exists: the next person to
    // add a constant should fetch the same two files rather than trust memory,
    // and `the_lock_bearing_services_are_exactly_the_reviewed_set` below is the
    // guard that makes an unreviewed addition fail.
    const SVC_ACCESSORY_INFORMATION: u32 = 0x3E;
    const SVC_GARAGE_DOOR_OPENER: u32 = 0x41;
    const SVC_LIGHTBULB: u32 = 0x43;
    const SVC_LOCK_MANAGEMENT: u32 = 0x44;
    const SVC_LOCK_MECHANISM: u32 = 0x45;
    const SVC_OUTLET: u32 = 0x47;
    const SVC_SWITCH: u32 = 0x49;
    const SVC_THERMOSTAT: u32 = 0x4A;
    const SVC_PAIRING: u32 = 0x55;
    const SVC_SECURITY_SYSTEM: u32 = 0x7E;
    const SVC_CARBON_MONOXIDE_SENSOR: u32 = 0x7F;
    const SVC_CONTACT_SENSOR: u32 = 0x80;
    const SVC_DOOR: u32 = 0x81;
    const SVC_HUMIDITY_SENSOR: u32 = 0x82;
    const SVC_LEAK_SENSOR: u32 = 0x83;
    const SVC_LIGHT_SENSOR: u32 = 0x84;
    const SVC_MOTION_SENSOR: u32 = 0x85;
    const SVC_OCCUPANCY_SENSOR: u32 = 0x86;
    const SVC_SMOKE_SENSOR: u32 = 0x87;
    const SVC_STATELESS_SWITCH: u32 = 0x89;
    const SVC_TEMPERATURE_SENSOR: u32 = 0x8A;
    const SVC_WINDOW: u32 = 0x8B;
    const SVC_WINDOW_COVERING: u32 = 0x8C;
    const SVC_AIR_QUALITY_SENSOR: u32 = 0x8D;
    const SVC_BATTERY: u32 = 0x96;
    const SVC_CARBON_DIOXIDE_SENSOR: u32 = 0x97;
    const SVC_PROTOCOL_INFORMATION: u32 = 0xA2;
    const SVC_FAN_V2: u32 = 0xB7;
    const SVC_SLAT: u32 = 0xB9;
    const SVC_FILTER_MAINTENANCE: u32 = 0xBA;
    const SVC_AIR_PURIFIER: u32 = 0xBB;
    const SVC_HEATER_COOLER: u32 = 0xBC;
    const SVC_HUMIDIFIER_DEHUMIDIFIER: u32 = 0xBD;
    const SVC_SERVICE_LABEL: u32 = 0xCC;
    const SVC_IRRIGATION_SYSTEM: u32 = 0xCF;
    const SVC_VALVE: u32 = 0xD0;
    const SVC_FAUCET: u32 = 0xD7;
    const SVC_CAMERA_RTP: u32 = 0x110;
    const SVC_MICROPHONE: u32 = 0x112;
    const SVC_SPEAKER: u32 = 0x113;

    // Characteristic types — HAPCharacteristicTypes.c.
    const CHR_BRIGHTNESS: u32 = 0x08;
    const CHR_CURRENT_DOOR_STATE: u32 = 0x0E;
    const CHR_CURRENT_RELATIVE_HUMIDITY: u32 = 0x10;
    const CHR_CURRENT_TEMPERATURE: u32 = 0x11;
    const CHR_HUE: u32 = 0x13;
    const CHR_LOCK_CURRENT_STATE: u32 = 0x1D;
    const CHR_LOCK_TARGET_STATE: u32 = 0x1E;
    const CHR_MOTION_DETECTED: u32 = 0x22;
    const CHR_NAME: u32 = 0x23;
    const CHR_ON: u32 = 0x25;
    const CHR_ROTATION_SPEED: u32 = 0x29;
    const CHR_SATURATION: u32 = 0x2F;
    const CHR_TARGET_DOOR_STATE: u32 = 0x32;
    const CHR_TARGET_TEMPERATURE: u32 = 0x35;
    const CHR_CARBON_MONOXIDE_DETECTED: u32 = 0x69;
    const CHR_CONTACT_SENSOR_STATE: u32 = 0x6A;
    const CHR_CURRENT_AMBIENT_LIGHT_LEVEL: u32 = 0x6B;
    const CHR_CURRENT_POSITION: u32 = 0x6D;
    const CHR_LEAK_DETECTED: u32 = 0x70;
    const CHR_OCCUPANCY_DETECTED: u32 = 0x71;
    const CHR_SMOKE_DETECTED: u32 = 0x76;
    const CHR_TARGET_POSITION: u32 = 0x7C;
    const CHR_CARBON_DIOXIDE_DETECTED: u32 = 0x92;
    const CHR_AIR_QUALITY: u32 = 0x95;
    const CHR_ACTIVE: u32 = 0xB0;
    const CHR_VOLUME: u32 = 0x119;

    // Enumerated values, from HAPCharacteristicTypes.h. Written as constants
    // because "1 means locked" is exactly the kind of fact that gets inverted
    // in a rewrite.
    /// `kHAPCharacteristicValue_LockCurrentState_Secured = 1` (:395).
    const LOCK_SECURED: u64 = 1;
    /// `kHAPCharacteristicValue_LockTargetState_{Unsecured=0, Secured=1}` (:425-428).
    const LOCK_TARGET_SECURED: u64 = 1;
    const LOCK_TARGET_UNSECURED: u64 = 0;
    /// `kHAPCharacteristicValue_CurrentDoorState_Closed = 1` (:127).
    const DOOR_CLOSED: u64 = 1;
    /// `kHAPCharacteristicValue_TargetDoorState_{Open=0, Closed=1}` (:680-683).
    const DOOR_TARGET_CLOSED: u64 = 1;
    const DOOR_TARGET_OPEN: u64 = 0;

    // -------------------------------------------------------------------
    // Classification — the part with a physical consequence
    // -------------------------------------------------------------------

    /// What Atlas will do with a service.
    ///
    /// A ROLE, NOT A LABEL. `kind` and `control` are what the surface draws;
    /// this is what decides which characteristic gets read and which gets
    /// written, so it has to be one decision rather than three that could
    /// disagree. `ha.rs::cover_kind` is the model: one function reaches the
    /// verdict and everything else asks it.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Role {
        /// On, plus optional Brightness / Hue / Saturation.
        Light,
        /// On, and nothing else.
        Switch,
        /// LockMechanism: LockCurrentState / LockTargetState.
        Lock,
        /// GarageDoorOpener: CurrentDoorState / TargetDoorState.
        GarageDoor,
        /// A motorised Door: CurrentPosition / TargetPosition, and in the LOCK
        /// domain because it is a way into the house.
        PositionedDoor,
        WindowCovering,
        Thermostat,
        Fan,
        Speaker,
        /// A device that reports and cannot be commanded. Carries the `kind`
        /// the surface should draw so the fail-closed arm is still specific.
        ReportsOnly(&'static str),
    }

    impl Role {
        /// `SmartDevice.kind` in `src/lib/mocks/smartHome.ts`. `lock` and
        /// `garage` are the two the control port treats as the lock domain
        /// (`home::LOCK_KINDS`), so this function is where a HAP service enters
        /// or leaves Approval-tier territory.
        pub fn kind(self) -> &'static str {
            match self {
                Role::Light => "bulb",
                Role::Switch => "plug",
                Role::Lock => "lock",
                // BOTH of these are `garage`, which is a LOCK_KIND. A garage
                // door and a motorised front door are both ways into the house,
                // and `home::device_set_allowed` refuses every lock kind on the
                // Actuate tier — so classifying them here is what routes them
                // to the approval card instead of to a slider.
                Role::GarageDoor | Role::PositionedDoor => "garage",
                Role::WindowCovering => "blind",
                Role::Thermostat => "thermostat",
                Role::Fan => "purifier",
                Role::Speaker => "speaker",
                Role::ReportsOnly(kind) => kind,
            }
        }
    }

    fn characteristic(svc: &Service, want: u32) -> Option<&Characteristic> {
        svc.characteristics.iter().find(|c| apple_type(&c.type_uuid) == Some(want))
    }

    /// The iid of a characteristic this controller may WRITE.
    ///
    /// `"pw"` is the paired-write permission, serialised at
    /// adk_HAPIPAccessory.c:1023. A characteristic without it is read-only, and
    /// writing to it earns a per-characteristic error inside a 207 rather than
    /// a clean refusal — so the check happens here, before anything is sent.
    fn writable(svc: &Service, want: u32) -> Option<u64> {
        let c = characteristic(svc, want)?;
        c.perms.iter().any(|p| p == "pw").then_some(c.iid)
    }

    fn readable_value(svc: &Service, want: u32) -> Option<&Value> {
        characteristic(svc, want)?.value.as_ref()
    }

    /// Decide what a service is.
    ///
    /// `None` means "not a device at all" — the infrastructure services every
    /// accessory carries. Everything else gets a role, and AN UNRECOGNISED
    /// SERVICE TYPE FAILS CLOSED TO `ReportsOnly`, never to a slider. That is
    /// the same rule as `ha.rs::cover_kind`'s `_ => "cover"` arm and for the
    /// same reason: a type this table has never seen is more likely to be a new
    /// kind of opening than a new kind of lamp, and "probably harmless" is not
    /// a safe default for something that might be a door.
    pub fn classify(service_type: &str) -> Option<Role> {
        let Some(t) = apple_type(service_type) else {
            // A vendor service. Visible, so the user can see Atlas found
            // something, and not settable, because nothing here knows what
            // writing to it would do.
            return Some(Role::ReportsOnly("sensor"));
        };
        Some(match t {
            // Not devices. Every accessory has AccessoryInformation and
            // Pairing; these are metadata, and a row for each would bury the
            // lamp in a list of things nobody can act on.
            SVC_ACCESSORY_INFORMATION
            | SVC_PROTOCOL_INFORMATION
            | SVC_PAIRING
            | SVC_SERVICE_LABEL
            | SVC_BATTERY
            | SVC_FILTER_MAINTENANCE
            | SVC_SLAT
            | SVC_LOCK_MANAGEMENT
            | SVC_CAMERA_RTP
            | SVC_MICROPHONE => return None,

            SVC_LIGHTBULB => Role::Light,
            SVC_OUTLET | SVC_SWITCH => Role::Switch,
            SVC_LOCK_MECHANISM => Role::Lock,
            SVC_GARAGE_DOOR_OPENER => Role::GarageDoor,
            SVC_DOOR => Role::PositionedDoor,
            SVC_WINDOW_COVERING => Role::WindowCovering,
            SVC_THERMOSTAT => Role::Thermostat,
            SVC_FAN_V2 | SVC_AIR_PURIFIER => Role::Fan,
            SVC_SPEAKER => Role::Speaker,

            // A HAP `Window` is a motorised WINDOW, not a window covering —
            // it opens a hole in the building envelope. `ha.rs` files Home
            // Assistant's `window` cover class under "blind", which is right
            // for HA (its CoverDeviceClass.WINDOW is a covering) and wrong
            // here. Reports only, deliberately: Atlas will not open a window
            // on an Actuate-tier op that runs without asking anybody.
            SVC_WINDOW => Role::ReportsOnly("cover"),

            // Arming and disarming a house alarm is a decision of the same
            // weight as a lock, and the lock path writes LockTargetState,
            // which a SecuritySystem does not have. Read-only until somebody
            // designs the approval for it properly.
            SVC_SECURITY_SYSTEM => Role::ReportsOnly("sensor"),
            // Water. Same reasoning: a valve left open is a flood, and there
            // is no approval tier designed for it.
            SVC_VALVE | SVC_IRRIGATION_SYSTEM | SVC_FAUCET => Role::ReportsOnly("sensor"),
            // Multi-mode climate. The target is a mode plus a threshold pair,
            // which does not fit the surface's single `value`, so reporting is
            // the honest half.
            SVC_HEATER_COOLER | SVC_HUMIDIFIER_DEHUMIDIFIER => Role::ReportsOnly("thermostat"),

            SVC_SMOKE_SENSOR => Role::ReportsOnly("smoke"),
            SVC_CONTACT_SENSOR => Role::ReportsOnly("doorbell"),
            SVC_TEMPERATURE_SENSOR
            | SVC_HUMIDITY_SENSOR
            | SVC_LIGHT_SENSOR
            | SVC_MOTION_SENSOR
            | SVC_OCCUPANCY_SENSOR
            | SVC_LEAK_SENSOR
            | SVC_AIR_QUALITY_SENSOR
            | SVC_CARBON_DIOXIDE_SENSOR
            | SVC_CARBON_MONOXIDE_SENSOR
            | SVC_STATELESS_SWITCH => Role::ReportsOnly("sensor"),

            // An Apple-defined type this table has never seen. Same fail-closed
            // arm as a vendor type.
            _ => Role::ReportsOnly("sensor"),
        })
    }

    /// The affordance the surface draws, given what the service can actually
    /// take. `status` is the honest one: reports, cannot be commanded.
    ///
    /// EVERY ARM CHECKS `writable`, not merely "the characteristic exists". A
    /// read-only Brightness is a real thing (a lamp that reports its level and
    /// is switched elsewhere), and drawing a slider on it produces a control
    /// that silently does nothing.
    pub fn control_of(role: Role, svc: &Service) -> &'static str {
        match role {
            Role::Light => {
                if writable(svc, CHR_HUE).is_some() && writable(svc, CHR_SATURATION).is_some() {
                    "colour"
                } else if writable(svc, CHR_BRIGHTNESS).is_some() {
                    "slider"
                } else if writable(svc, CHR_ON).is_some() {
                    "toggle"
                } else {
                    "status"
                }
            }
            Role::Switch => {
                if writable(svc, CHR_ON).is_some() {
                    "toggle"
                } else {
                    "status"
                }
            }
            Role::Lock => {
                if writable(svc, CHR_LOCK_TARGET_STATE).is_some() {
                    "toggle"
                } else {
                    "status"
                }
            }
            Role::GarageDoor => {
                if writable(svc, CHR_TARGET_DOOR_STATE).is_some() {
                    "toggle"
                } else {
                    "status"
                }
            }
            Role::PositionedDoor => {
                if writable(svc, CHR_TARGET_POSITION).is_some() {
                    "toggle"
                } else {
                    "status"
                }
            }
            Role::WindowCovering => {
                if writable(svc, CHR_TARGET_POSITION).is_some() {
                    "slider"
                } else {
                    "status"
                }
            }
            Role::Thermostat => {
                if writable(svc, CHR_TARGET_TEMPERATURE).is_some() {
                    "stepper"
                } else {
                    "status"
                }
            }
            Role::Fan => {
                if writable(svc, CHR_ROTATION_SPEED).is_some() {
                    "slider"
                } else if writable(svc, CHR_ACTIVE).is_some() || writable(svc, CHR_ON).is_some() {
                    "toggle"
                } else {
                    "status"
                }
            }
            Role::Speaker => {
                if writable(svc, CHR_VOLUME).is_some() {
                    "slider"
                } else {
                    "status"
                }
            }
            Role::ReportsOnly(_) => "status",
        }
    }

    fn as_f64(v: Option<&Value>) -> Option<f64> {
        v?.as_f64()
    }

    fn as_u64(v: Option<&Value>) -> Option<u64> {
        // HAP's uint8 characteristics arrive as JSON numbers; a bool would be
        // a `bool` and is handled separately, never coerced to 1.
        v?.as_u64()
    }

    fn as_bool(v: Option<&Value>) -> Option<bool> {
        v?.as_bool()
    }

    /// The number the surface shows, in the unit its `control` implies.
    ///
    /// `None` where the accessory gave no reading. That is the discipline
    /// `ha.rs::value_of` states and it matters twice as much here: the mirror's
    /// `apply_pull` COALESCEs a `None` onto the last known value, so a
    /// `Some(0.0)` invented for a missing characteristic would overwrite a real
    /// reading with a zero nobody sent.
    pub fn value_of(role: Role, svc: &Service) -> Option<f64> {
        match role {
            Role::Light => {
                let on = as_bool(readable_value(svc, CHR_ON))?;
                if !on {
                    return Some(0.0);
                }
                // A lamp that is on and reports no brightness is a lamp that is
                // simply on. 100 is the reading, not a guess about a dimmer it
                // does not have.
                Some(as_f64(readable_value(svc, CHR_BRIGHTNESS)).unwrap_or(100.0))
            }
            Role::Switch => as_bool(readable_value(svc, CHR_ON)).map(|on| if on { 1.0 } else { 0.0 }),
            Role::Lock => as_u64(readable_value(svc, CHR_LOCK_CURRENT_STATE))
                .map(|s| if s == LOCK_SECURED { 1.0 } else { 0.0 }),
            Role::GarageDoor => as_u64(readable_value(svc, CHR_CURRENT_DOOR_STATE))
                .map(|s| if s == DOOR_CLOSED { 1.0 } else { 0.0 }),
            // A POSITIONED DOOR IS A `garage` KIND WITH A `toggle` CONTROL, so
            // its value must speak the toggle convention, not the percentage
            // one. The surface reads `value > 0` as "secured" and prints
            // "Closed"/"Open" from it (deviceGlyph.tsx), so handing it a raw
            // 0-100 position inverted the card exactly: a closed door (0)
            // rendered "Open" and a fully open door (100) rendered "Closed" —
            // in the lock domain, above a `state` line that correctly said
            // "0 % open". Anything above 0 is ajar, and ajar is open; the
            // threshold is deliberately not a tolerance. The percentage is not
            // lost — `state_of` still reports it, in words.
            Role::PositionedDoor => as_f64(readable_value(svc, CHR_CURRENT_POSITION))
                .map(|p| if p <= 0.0 { 1.0 } else { 0.0 }),
            Role::WindowCovering => as_f64(readable_value(svc, CHR_CURRENT_POSITION)),
            Role::Thermostat => as_f64(readable_value(svc, CHR_CURRENT_TEMPERATURE)),
            Role::Fan => {
                let active = as_u64(readable_value(svc, CHR_ACTIVE))
                    .map(|a| a != 0)
                    .or_else(|| as_bool(readable_value(svc, CHR_ON)))?;
                if !active {
                    return Some(0.0);
                }
                Some(as_f64(readable_value(svc, CHR_ROTATION_SPEED)).unwrap_or(100.0))
            }
            Role::Speaker => as_f64(readable_value(svc, CHR_VOLUME)),
            Role::ReportsOnly(_) => sensor_reading(svc).map(|(v, _)| v),
        }
    }

    /// A reports-only service's reading and its unit, when the service carries
    /// one of the sensor characteristics this module knows by number.
    ///
    /// The list is short and every entry is a confirmed constant. A service
    /// whose reading is not here shows no number at all, which is the honest
    /// answer — inventing one from "the first numeric characteristic" would
    /// happily report a firmware revision as a temperature.
    fn sensor_reading(svc: &Service) -> Option<(f64, &'static str)> {
        const NUMERIC: &[(u32, &str)] = &[
            (CHR_CURRENT_TEMPERATURE, "°C"),
            (CHR_CURRENT_RELATIVE_HUMIDITY, "%"),
            (CHR_CURRENT_AMBIENT_LIGHT_LEVEL, "lux"),
            (CHR_AIR_QUALITY, ""),
        ];
        for (t, unit) in NUMERIC {
            if let Some(v) = as_f64(readable_value(svc, *t)) {
                return Some((v, unit));
            }
        }
        const FLAGS: &[u32] = &[
            CHR_MOTION_DETECTED,
            CHR_CONTACT_SENSOR_STATE,
            CHR_LEAK_DETECTED,
            CHR_OCCUPANCY_DETECTED,
            CHR_SMOKE_DETECTED,
            CHR_CARBON_MONOXIDE_DETECTED,
            CHR_CARBON_DIOXIDE_DETECTED,
        ];
        for t in FLAGS {
            // `continue`, NOT `?`. An early return here would abandon the whole
            // search the moment the FIRST name in the list was absent, so a
            // leak sensor would report nothing because it has no
            // MotionDetected — which is exactly what it should not have.
            let Some(raw) = readable_value(svc, *t) else { continue };
            if let Some(b) = raw.as_bool() {
                return Some((if b { 1.0 } else { 0.0 }, ""));
            }
            if let Some(n) = raw.as_u64() {
                return Some((if n != 0 { 1.0 } else { 0.0 }, ""));
            }
        }
        None
    }

    /// The device's own state, in words. Never a sentence Atlas composed about
    /// something it did not read.
    pub fn state_words(role: Role, svc: &Service) -> Option<String> {
        match role {
            Role::Light | Role::Switch => {
                as_bool(readable_value(svc, CHR_ON)).map(|on| if on { "On" } else { "Off" }.into())
            }
            Role::Lock => as_u64(readable_value(svc, CHR_LOCK_CURRENT_STATE)).map(|s| {
                // The four values of LockCurrentState, HAPCharacteristicTypes.h
                // :392-401. "Jammed" is the one that matters: a lock that did
                // not move must not read as either locked or unlocked.
                match s {
                    0 => "Unlocked",
                    1 => "Locked",
                    2 => "Jammed",
                    _ => "Unknown",
                }
                .to_string()
            }),
            Role::GarageDoor => as_u64(readable_value(svc, CHR_CURRENT_DOOR_STATE)).map(|s| {
                match s {
                    0 => "Open",
                    1 => "Closed",
                    2 => "Opening",
                    3 => "Closing",
                    4 => "Stopped",
                    _ => "Unknown",
                }
                .to_string()
            }),
            Role::PositionedDoor | Role::WindowCovering => {
                as_f64(readable_value(svc, CHR_CURRENT_POSITION))
                    .map(|p| format!("{} % open", p.round()))
            }
            Role::Thermostat => {
                as_f64(readable_value(svc, CHR_CURRENT_TEMPERATURE)).map(|t| format!("{t} °C"))
            }
            Role::Fan => as_u64(readable_value(svc, CHR_ACTIVE))
                .map(|a| a != 0)
                .or_else(|| as_bool(readable_value(svc, CHR_ON)))
                .map(|on| if on { "On" } else { "Off" }.into()),
            Role::Speaker => as_f64(readable_value(svc, CHR_VOLUME)).map(|v| format!("{v} %")),
            Role::ReportsOnly(_) => sensor_reading(svc).map(|(v, unit)| {
                if unit.is_empty() {
                    format!("{v}")
                } else {
                    format!("{v} {unit}")
                }
            }),
        }
    }

    // -------------------------------------------------------------------
    // Colour
    // -------------------------------------------------------------------

    /// HAP Hue (0-360 degrees) and Saturation (0-100 %) as the `#rrggbb` the
    /// surface's swatch draws.
    ///
    /// VALUE IS FIXED AT FULL, deliberately. HAP keeps brightness in its own
    /// characteristic, and folding it into the swatch would paint a dimmed lamp
    /// black — the swatch answers "what colour is it", and the slider already
    /// answers "how bright".
    pub fn hs_to_hex(hue: f64, saturation: f64) -> String {
        let h = hue.rem_euclid(360.0);
        let s = (saturation / 100.0).clamp(0.0, 1.0);
        let c = s;
        let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
        let (r, g, b) = match (h / 60.0) as u32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = 1.0 - c;
        let to8 = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
        format!("#{:02x}{:02x}{:02x}", to8(r), to8(g), to8(b))
    }

    /// `#rrggbb` back to HAP's hue and saturation.
    ///
    /// THE VALUE COMPONENT IS DISCARDED, and that is the point. The user picked
    /// a colour, not a brightness; writing V into Brightness would dim a lamp
    /// because somebody chose a darker shade of blue.
    pub fn hex_to_hs(hex: &str) -> Option<(f64, f64)> {
        let h = hex.trim().strip_prefix('#')?;
        if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(|v| v as f64 / 255.0);
        let (r, g, b) = (byte(0)?, byte(2)?, byte(4)?);
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let d = max - min;
        let hue = if d == 0.0 {
            0.0
        } else if max == r {
            60.0 * (((g - b) / d) % 6.0)
        } else if max == g {
            60.0 * ((b - r) / d + 2.0)
        } else {
            60.0 * ((r - g) / d + 4.0)
        };
        let sat = if max == 0.0 { 0.0 } else { d / max * 100.0 };
        Some(((hue.rem_euclid(360.0) * 10.0).round() / 10.0, (sat * 10.0).round() / 10.0))
    }

    pub fn colour_of(svc: &Service) -> Option<String> {
        let hue = as_f64(readable_value(svc, CHR_HUE))?;
        let sat = as_f64(readable_value(svc, CHR_SATURATION))?;
        Some(hs_to_hex(hue, sat))
    }

    // -------------------------------------------------------------------
    // Addressing
    // -------------------------------------------------------------------

    /// `home_devices.external_id` for a HAP service: `<aid>.<service iid>`.
    ///
    /// The SERVICE iid, not a characteristic's. Which characteristic a command
    /// writes depends on the role and on what the accessory says it accepts,
    /// and both are re-read at write time — see `Paired::write_to`.
    pub fn external_id(aid: u64, service_iid: u64) -> String {
        format!("{aid}.{service_iid}")
    }

    pub fn parse_external_id(s: &str) -> Option<(u64, u64)> {
        let (a, i) = s.split_once('.')?;
        Some((a.parse().ok()?, i.parse().ok()?))
    }

    /// The label a person recognises.
    ///
    /// The service's own Name characteristic first — that is what the user
    /// typed into the accessory's app — then the accessory's name from
    /// AccessoryInformation, then the role. Never blank, and never an iid.
    pub fn device_name(svc: &Service, accessory_name: Option<&str>, role: Role) -> String {
        if let Some(n) = readable_value(svc, CHR_NAME).and_then(|v| v.as_str()) {
            let n = n.trim();
            if !n.is_empty() {
                return n.to_string();
            }
        }
        match accessory_name.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => n.to_string(),
            None => role.kind().to_string(),
        }
    }

    /// The accessory's own name, from its AccessoryInformation service.
    pub fn accessory_name(acc: &Accessory) -> Option<String> {
        for svc in &acc.services {
            if apple_type(&svc.type_uuid) != Some(SVC_ACCESSORY_INFORMATION) {
                continue;
            }
            if let Some(n) = readable_value(svc, CHR_NAME).and_then(|v| v.as_str()) {
                let n = n.trim();
                if !n.is_empty() {
                    return Some(n.to_string());
                }
            }
        }
        None
    }

    /// Turn a parsed `/accessories` payload into the mirror's devices.
    ///
    /// PURE, and therefore the part that is actually verified. Everything below
    /// it needs a socket.
    pub fn devices_from(accessories: &[Accessory]) -> Vec<DevicePull> {
        let mut out = Vec::new();
        for acc in accessories {
            let name = accessory_name(acc);
            for svc in &acc.services {
                let Some(role) = classify(&svc.type_uuid) else { continue };
                out.push(DevicePull {
                    external_id: external_id(acc.aid, svc.iid),
                    name: device_name(svc, name.as_deref(), role),
                    kind: role.kind().to_string(),
                    control: control_of(role, svc).to_string(),
                    // HAP HAS NO ROOMS. Room assignment lives in the
                    // controller — Apple Home stores it — so an accessory
                    // paired directly with Atlas genuinely belongs to no room,
                    // and inventing one would be a label nobody chose.
                    room_external_id: None,
                    value: value_of(role, svc),
                    state: state_words(role, svc),
                    colour: colour_of(svc),
                    // If `/accessories` came back at all, everything in it
                    // answered: HAP has no per-characteristic reachability
                    // flag. A whole accessory that is off the network fails
                    // the pull, which `sync_bridge` records on the bridge row.
                    available: true,
                    // HAP publishes no change timestamp.
                    last_changed: None,
                });
            }
        }
        out
    }

    // -------------------------------------------------------------------
    // Writes
    // -------------------------------------------------------------------

    fn refuse(what: &str) -> HomeError {
        HomeError::Refused(what.to_string())
    }

    /// The characteristic writes that set a device's primary value.
    ///
    /// REFUSES EVERY LOCK KIND. `home::device_set_allowed` already refuses them
    /// before the adapter is reached, and this is the second half of the same
    /// rule written where the protocol is: if that guard were ever bypassed,
    /// this returns `Refused` rather than composing a door-opening write.
    pub fn writes_for_value(role: Role, svc: &Service, aid: u64, v: f64) -> Result<Vec<CharWrite>, HomeError> {
        if !v.is_finite() {
            return Err(refuse("a device value must be a real number"));
        }
        let id = |iid: u64| CharId::new(aid, iid);
        let pct = v.clamp(0.0, 100.0).round();
        match role {
            Role::Lock | Role::GarageDoor | Role::PositionedDoor => Err(refuse(
                "this is a lock or a door — it is never set this way. Use home_lock_set, which \
                 asks you first.",
            )),
            Role::ReportsOnly(_) => {
                Err(refuse("this accessory service reports only — there is nothing on it to set."))
            }
            Role::Light => {
                let on_iid = writable(svc, CHR_ON)
                    .ok_or_else(|| refuse("this light will not accept an on/off command"))?;
                let mut writes = vec![CharWrite { id: id(on_iid), value: json!(pct > 0.0) }];
                // On FIRST: a brightness written while the lamp is off is
                // accepted and invisible on most accessories, and the ADK
                // applies a PUT's elements in order.
                if pct > 0.0 {
                    if let Some(b) = writable(svc, CHR_BRIGHTNESS) {
                        writes.push(CharWrite { id: id(b), value: json!(pct as i64) });
                    }
                }
                Ok(writes)
            }
            Role::Switch => {
                let on_iid = writable(svc, CHR_ON)
                    .ok_or_else(|| refuse("this switch will not accept an on/off command"))?;
                Ok(vec![CharWrite { id: id(on_iid), value: json!(pct > 0.0) }])
            }
            Role::WindowCovering => {
                let iid = writable(svc, CHR_TARGET_POSITION)
                    .ok_or_else(|| refuse("this blind will not accept a position"))?;
                Ok(vec![CharWrite { id: id(iid), value: json!(pct as i64) }])
            }
            Role::Thermostat => {
                let iid = writable(svc, CHR_TARGET_TEMPERATURE)
                    .ok_or_else(|| refuse("this thermostat will not accept a target temperature"))?;
                // NOT clamped to 0-100: this one is degrees Celsius, not a
                // percentage, and clamping it would silently turn 21 °C into
                // something else in a Fahrenheit-thinking user's hands. The
                // accessory publishes its own min/max and rejects the rest.
                Ok(vec![CharWrite { id: id(iid), value: json!(v) }])
            }
            Role::Fan => {
                let mut writes = Vec::new();
                if let Some(a) = writable(svc, CHR_ACTIVE) {
                    writes.push(CharWrite { id: id(a), value: json!(if pct > 0.0 { 1 } else { 0 }) });
                } else if let Some(o) = writable(svc, CHR_ON) {
                    writes.push(CharWrite { id: id(o), value: json!(pct > 0.0) });
                }
                if pct > 0.0 {
                    if let Some(s) = writable(svc, CHR_ROTATION_SPEED) {
                        writes.push(CharWrite { id: id(s), value: json!(pct) });
                    }
                }
                if writes.is_empty() {
                    return Err(refuse("this fan will not accept a speed or an on/off command"));
                }
                Ok(writes)
            }
            Role::Speaker => {
                let iid = writable(svc, CHR_VOLUME)
                    .ok_or_else(|| refuse("this speaker will not accept a volume"))?;
                Ok(vec![CharWrite { id: id(iid), value: json!(pct as i64) }])
            }
        }
    }

    /// The writes that lock or unlock. THE ONLY PATH TO A DOOR, and it is
    /// reached only from `home_lock_set`, which is `Tier::Approval` at the
    /// control port on both profiles.
    pub fn writes_for_lock(role: Role, svc: &Service, aid: u64, locked: bool) -> Result<Vec<CharWrite>, HomeError> {
        let id = |iid: u64| CharId::new(aid, iid);
        match role {
            Role::Lock => {
                let iid = writable(svc, CHR_LOCK_TARGET_STATE)
                    .ok_or_else(|| refuse("this lock will not accept a target state"))?;
                let want = if locked { LOCK_TARGET_SECURED } else { LOCK_TARGET_UNSECURED };
                Ok(vec![CharWrite { id: id(iid), value: json!(want) }])
            }
            Role::GarageDoor => {
                let iid = writable(svc, CHR_TARGET_DOOR_STATE)
                    .ok_or_else(|| refuse("this door will not accept a target state"))?;
                // Closed IS locked for a door that has no bolt. The mapping is
                // written out rather than computed so that inverting it needs
                // an edit somebody has to justify.
                let want = if locked { DOOR_TARGET_CLOSED } else { DOOR_TARGET_OPEN };
                Ok(vec![CharWrite { id: id(iid), value: json!(want) }])
            }
            Role::PositionedDoor => {
                let iid = writable(svc, CHR_TARGET_POSITION)
                    .ok_or_else(|| refuse("this door will not accept a position"))?;
                Ok(vec![CharWrite { id: id(iid), value: json!(if locked { 0 } else { 100 }) }])
            }
            _ => Err(refuse("that accessory is not a lock or a door")),
        }
    }

    pub fn writes_for_colour(svc: &Service, aid: u64, colour: &str) -> Result<Vec<CharWrite>, HomeError> {
        let (hue, sat) = hex_to_hs(colour)
            .ok_or_else(|| refuse("a colour must look like #rrggbb"))?;
        let (h_iid, s_iid) = match (writable(svc, CHR_HUE), writable(svc, CHR_SATURATION)) {
            (Some(h), Some(s)) => (h, s),
            // Both or neither. A hue written without a saturation moves a lamp
            // to a colour the user did not pick.
            _ => return Err(refuse("this light does not take a colour")),
        };
        Ok(vec![
            CharWrite { id: CharId::new(aid, h_iid), value: json!(hue) },
            CharWrite { id: CharId::new(aid, s_iid), value: json!(sat) },
        ])
    }

    // -------------------------------------------------------------------
    // The connection
    // -------------------------------------------------------------------

    /// A plaintext HTTP request, for the two endpoints that MUST NOT be sent
    /// inside a session.
    ///
    /// "Rejected POST /pair-setup: Only non-secure access is supported"
    /// (adk_HAPIPAccessoryServer.c:2611, and :2625 for /pair-verify) — the
    /// accessory refuses these on an encrypted connection, which is the whole
    /// reason this exists next to `http.rs`'s session-framed builders.
    fn tlv_post(path: &str, host: &str, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(160 + body.len());
        out.extend_from_slice(b"POST ");
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(b" HTTP/1.1\r\nHost: ");
        out.extend_from_slice(host.as_bytes());
        out.extend_from_slice(b"\r\nContent-Type: ");
        out.extend_from_slice(CONTENT_TYPE_TLV8.as_bytes());
        out.extend_from_slice(b"\r\nContent-Length: ");
        out.extend_from_slice(body.len().to_string().as_bytes());
        out.extend_from_slice(b"\r\n\r\n");
        out.extend_from_slice(body);
        out
    }

    /// The same host check `http.rs` applies to a session request, applied to
    /// the plaintext ones too. A Bonjour instance name reaches this header.
    fn check_host(host: &str) -> Result<(), HomeError> {
        if host.is_empty()
            || host.len() > 255
            || host.bytes().any(|b| !(0x21..=0x7E).contains(&b))
        {
            return Err(refuse("that accessory address cannot go in an HTTP header"));
        }
        Ok(())
    }

    /// Send one plaintext request and read one response.
    ///
    /// BOUNDED BEFORE AUTHENTICATION. This runs against a peer that has proved
    /// nothing at all, so the read stops at `MAX_PLAIN_REPLY` whatever the
    /// headers claim — `http::parse_message` already refuses an over-long
    /// Content-Length, and this is the second ceiling for a peer that simply
    /// never stops sending.
    fn plain_exchange(stream: &mut TcpStream, request: &[u8]) -> Result<http::Message, HomeError> {
        stream.write_all(request).map_err(|e| HomeError::Unreachable(e.to_string()))?;
        let mut buf: Vec<u8> = Vec::with_capacity(1024);
        let mut chunk = [0u8; 2048];
        loop {
            if let Some((msg, _used)) = http::parse_message(&buf)? {
                return Ok(msg);
            }
            if buf.len() >= MAX_PLAIN_REPLY {
                return Err(HomeError::Malformed(
                    "the accessory's pairing reply was larger than Atlas will read".into(),
                ));
            }
            match stream.read(&mut chunk) {
                Ok(0) => {
                    return Err(HomeError::Unreachable(
                        "the accessory closed the connection during pairing".into(),
                    ))
                }
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(e) => return Err(HomeError::Unreachable(e.to_string())),
            }
        }
    }

    fn tlv_body(msg: &http::Message) -> Result<&[u8], HomeError> {
        if msg.status != 200 {
            return Err(HomeError::Unreachable(format!(
                "the accessory answered {} during pairing",
                msg.status
            )));
        }
        Ok(&msg.body)
    }

    fn connect(target: &Target) -> Result<TcpStream, HomeError> {
        check_host(&target.host)?;
        let addrs = target
            .authority()
            .to_socket_addrs()
            .map_err(|e| {
                HomeError::Unreachable(format!(
                    "Atlas could not find {} on the network: {e}",
                    target.host
                ))
            })?
            .collect::<Vec<_>>();
        let mut last: Option<std::io::Error> = None;
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
                Ok(s) => {
                    s.set_read_timeout(Some(IO_TIMEOUT)).ok();
                    s.set_write_timeout(Some(IO_TIMEOUT)).ok();
                    // Nagle off: every HAP exchange is one small framed
                    // message and a 40 ms coalescing delay on each is the
                    // difference between a responsive light and a laggy one.
                    s.set_nodelay(true).ok();
                    return Ok(s);
                }
                Err(e) => last = Some(e),
            }
        }
        Err(HomeError::Unreachable(match last {
            Some(e) => format!("Atlas could not reach the accessory at {}: {e}", target.authority()),
            None => format!("{} resolved to no address at all", target.host),
        }))
    }

    /// A verified session with one accessory.
    ///
    /// SHORT-LIVED ON PURPOSE. It is opened per operation and dropped at the
    /// end of it. A held-open session would need a supervisor thread, a
    /// reconnect policy and a place to put the event stream — all of which
    /// `ha.rs`/`ws.rs` have and none of which exist for HAP yet. Pair-verify
    /// is two round trips and some Curve25519, which is cheap enough that
    /// paying it per command is the right trade until events land.
    struct Link {
        stream: TcpStream,
        session: HapSession,
        host: String,
    }

    impl Link {
        fn open(target: &Target, record: &PairingRecord, ltsk: &[u8; 32]) -> Result<Link, HomeError> {
            let mut stream = connect(target)?;
            let mut verify = PairVerify::new(record, ltsk)?;
            let m1 = verify.start()?;
            let m2 = plain_exchange(&mut stream, &tlv_post("/pair-verify", &target.authority(), &m1))?;
            let m3 = verify.handle_m2(tlv_body(&m2)?)?;
            let m4 = plain_exchange(&mut stream, &tlv_post("/pair-verify", &target.authority(), &m3))?;
            let keys = verify.handle_m4(tlv_body(&m4)?)?;
            Ok(Link { stream, session: HapSession::new(keys), host: target.authority() })
        }

        fn accessories(&mut self) -> Result<Vec<Accessory>, HomeError> {
            let request = http::get_accessories(&self.host)?;
            // Events arriving mid-exchange are collected rather than dropped;
            // nothing consumes them yet (there is no push channel for HAP), and
            // discarding them here is what keeps the framing in step.
            let mut events = Vec::new();
            let reply = http::exchange(&mut self.session, &mut self.stream, &request, &mut events)?;
            Ok(http::parse_accessories(&reply)?)
        }

        fn put(&mut self, writes: &[CharWrite]) -> Result<(), HomeError> {
            let request = http::put_characteristics(&self.host, writes)?;
            let mut events = Vec::new();
            let reply = http::exchange(&mut self.session, &mut self.stream, &request, &mut events)?;
            let outcome = http::parse_write_outcome(&reply)?;
            // A 207 carries a status for EVERY element, including the ones that
            // worked. Reporting success because the HTTP status was 2xx is the
            // failure this check exists to prevent — the user would be told the
            // door had locked.
            if let Some(bad) = outcome.iter().find(|r| !r.ok()) {
                return Err(HomeError::Unreachable(format!(
                    "the accessory refused the change to {} (status {})",
                    bad.id,
                    bad.status.unwrap_or_default()
                )));
            }
            Ok(())
        }
    }

    /// Run pair-setup against an accessory and return what survives it.
    ///
    /// THE SETUP CODE IS AN ARGUMENT AND IS NEVER STORED. It is the user's
    /// one-time proof of physical possession — it goes into the SRP exchange
    /// and out of scope. What is kept afterwards is the accessory's long-term
    /// PUBLIC key and our own pairing id, which is what `PairingRecord` holds.
    ///
    /// NOT REACHABLE FROM THE CONTROL PORT, on purpose and for the same reason
    /// `home.link` is not: a tool that can pair a controller to an accessory is
    /// a tool that can be talked into pairing with something the user did not
    /// choose, and it needs a credential the user reads off a physical label
    /// while standing in front of the thing.
    pub fn pair(target: &Target, setup_code: &str) -> Result<PairingRecord, HomeError> {
        use super::super::hap::pairing::{load_or_create_identity, PairSetup};

        // Minted on first use and shared by every accessory — that is what an
        // `iOSDevicePairingID` means. Loaded before the socket so a Keychain
        // refusal does not leave a half-open connection behind.
        let (controller_id, ltsk) = load_or_create_identity().map_err(HomeError::Refused)?;
        // The code is validated here, before any traffic: a malformed code is a
        // typo and must be refused without side effects of any kind.
        let mut setup = PairSetup::new(setup_code, &controller_id, &ltsk)?;

        let mut stream = connect(target)?;
        let host = target.authority();
        let m1 = setup.start()?;
        let m2 = plain_exchange(&mut stream, &tlv_post("/pair-setup", &host, &m1))?;
        let m3 = setup.handle_m2(tlv_body(&m2)?)?;
        let m4 = plain_exchange(&mut stream, &tlv_post("/pair-setup", &host, &m3))?;
        let m5 = setup.handle_m4(tlv_body(&m4)?)?;
        let m6 = plain_exchange(&mut stream, &tlv_post("/pair-setup", &host, &m5))?;
        Ok(setup.handle_m6(tlv_body(&m6)?)?)
    }

    /// A HomeKit accessory Atlas is paired with.
    pub struct Paired {
        pub target: Target,
        pub record: PairingRecord,
        /// The controller's long-term secret. Read once in `for_bridge` and
        /// never returned, logged or serialised.
        pub ltsk: [u8; 32],
    }

    /// The long-term signing key does not outlive the adapter that borrowed it.
    /// This is the one copy that lives as long as a sync does, so it is the one
    /// most worth wiping.
    impl Drop for Paired {
        fn drop(&mut self) {
            super::super::hap::wipe(&mut self.ltsk);
        }
    }

    impl Paired {
        fn link(&self) -> Result<Link, HomeError> {
            Link::open(&self.target, &self.record, &self.ltsk)
        }

        pub fn probe(&self) -> Result<BridgeInfo, HomeError> {
            let accessories = self.link()?.accessories()?;
            let name = accessories
                .first()
                .and_then(accessory_name)
                .unwrap_or_else(|| self.target.accessory_id.clone());
            let devices = devices_from(&accessories).len();
            Ok(BridgeInfo {
                kind: BridgeKind::HomekitCompanion,
                name,
                // "devices", not "accessories": `devices_from` emits one row
                // per SERVICE that `classify` recognises, across every
                // accessory behind this pairing. One lamp publishing a
                // Lightbulb and a Switch is two devices and one accessory, and
                // calling that "2 accessories" is simply wrong.
                detail: format!(
                    "Paired over the local network · {devices} device{} at {}",
                    if devices == 1 { "" } else { "s" },
                    self.target.host
                ),
                // Only ever true because a verified session answered.
                connected: true,
            })
        }

        pub fn pull(&self) -> Result<BridgePull, HomeError> {
            let accessories = self.link()?.accessories()?;
            Ok(BridgePull {
                // HAP has neither rooms nor scenes at the accessory. Empty
                // because they do not exist here, which is a different
                // statement from the whole pull being empty.
                rooms: Vec::new(),
                devices: devices_from(&accessories),
                scenes: Vec::new(),
            })
        }

        /// Resolve an external id against a FRESH `/accessories`, then write.
        ///
        /// THE ATTRIBUTE DATABASE IS RE-READ ON EVERY WRITE, and that is a
        /// deliberate cost. Instance ids are only stable while the accessory's
        /// configuration number `c#` is unchanged; Atlas does not watch `c#`
        /// (it would need the discovery layer running continuously), so a
        /// cached iid could address a different characteristic after a firmware
        /// update. On a lock, that is not a bug worth risking to save a round
        /// trip.
        fn write_to(
            &self,
            external_id: &str,
            build: impl FnOnce(Role, &Service, u64) -> Result<Vec<CharWrite>, HomeError>,
        ) -> Result<(), HomeError> {
            let (aid, siid) = parse_external_id(external_id).ok_or_else(|| {
                refuse("that device id is not one this accessory published")
            })?;
            let mut link = self.link()?;
            let accessories = link.accessories()?;
            let svc = accessories
                .iter()
                .find(|a| a.aid == aid)
                .and_then(|a| a.services.iter().find(|s| s.iid == siid))
                .ok_or_else(|| {
                    HomeError::Unreachable(
                        "the accessory no longer publishes that service — sync the bridge again"
                            .into(),
                    )
                })?;
            let role = classify(&svc.type_uuid).ok_or_else(|| {
                refuse("that part of the accessory is not something Atlas can command")
            })?;
            let writes = build(role, svc, aid)?;
            link.put(&writes)
        }

        pub fn set_value(&self, external_id: &str, value: f64) -> Result<(), HomeError> {
            self.write_to(external_id, |role, svc, aid| writes_for_value(role, svc, aid, value))
        }

        pub fn set_colour(&self, external_id: &str, colour: &str) -> Result<(), HomeError> {
            let colour = colour.to_string();
            self.write_to(external_id, move |_role, svc, aid| {
                writes_for_colour(svc, aid, &colour)
            })
        }

        pub fn set_lock(&self, external_id: &str, locked: bool) -> Result<(), HomeError> {
            self.write_to(external_id, |role, svc, aid| writes_for_lock(role, svc, aid, locked))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Exactly three HAP services are ways into the house — no more, no
        /// fewer, and by number rather than by name.
        ///
        /// WHY A SWEEP AND NOT THREE ASSERTIONS. Asserting
        /// `SVC_LOCK_MECHANISM == 0x45` in the file that defines
        /// `SVC_LOCK_MECHANISM` restates a literal and proves nothing — the
        /// weakness a reviewer already flagged elsewhere in this module. This
        /// walks the whole Apple-defined service-type space instead and asks
        /// the only question that matters: which NUMBERS end up in the lock
        /// domain? A wrong constant, a new service classified as a door, or a
        /// lock silently demoted to a switch all change that set.
        ///
        /// `lock` and `garage` are `home::LOCK_KINDS`, which
        /// `device_set_allowed` refuses on the Actuate tier — so this set is
        /// precisely the boundary between "raises an approval card" and "Atlas
        /// opens it without asking". The three values were verified against
        /// Apple's HAPServiceTypes.c on 2026-08-09 (see the note above the
        /// constants).
        #[test]
        fn the_lock_bearing_services_are_exactly_the_reviewed_set() {
            // LockMechanism, GarageDoorOpener, Door.
            const REVIEWED: &[u32] = &[0x41, 0x45, 0x81];

            let mut found: Vec<u32> = Vec::new();
            // 0x200 is past every service type this module names (the highest
            // is Speaker, 0x113), so the sweep covers the whole space rather
            // than the values we happened to think of.
            for t in 0x00u32..=0x200 {
                let Some(role) = classify(&format!("{t:X}")) else {
                    continue;
                };
                if matches!(role.kind(), "lock" | "garage") {
                    found.push(t);
                }
            }

            assert_eq!(
                found, REVIEWED,
                "the set of HAP services that reach the lock domain changed. \
                 Every number here bypasses or gains an approval card, so this \
                 is a security review, not a test update: confirm the value \
                 against apple/HomeKitADK HAPServiceTypes.c before touching it."
            );
        }

        /// A copy-paste in the constant block would silently alias two services.
        #[test]
        fn no_two_service_constants_share_a_number() {
            // Reads the source rather than the constants: a duplicated VALUE is
            // invisible to code that only ever names one of the two.
            let src = include_str!("companion.rs");
            let mut seen: Vec<(String, String)> = Vec::new();
            for line in src.lines() {
                let line = line.trim();
                let Some(rest) = line.strip_prefix("const SVC_") else {
                    continue;
                };
                let Some((name, value)) = rest.split_once(": u32 = ") else {
                    continue;
                };
                let value = value.trim_end_matches(';').trim().to_ascii_uppercase();
                if let Some((other, _)) = seen.iter().find(|(_, v)| *v == value) {
                    panic!("SVC_{name} and SVC_{other} are both {value}");
                }
                seen.push((name.to_string(), value));
            }
            assert!(seen.len() > 30, "the constant scan found almost nothing — it broke");
        }

        fn chr(t: &str, iid: u64, perms: &[&str], value: Option<Value>) -> Characteristic {
            Characteristic {
                iid,
                type_uuid: t.to_string(),
                format: None,
                perms: perms.iter().map(|p| p.to_string()).collect(),
                value,
            }
        }

        fn svc(t: &str, iid: u64, chars: Vec<Characteristic>) -> Service {
            Service { iid, type_uuid: t.to_string(), characteristics: chars }
        }

        // -- UUID normalisation -------------------------------------------

        /// Both wire forms mean the same type, and a vendor UUID means neither.
        ///
        /// The short form is what Apple's own accessory code emits
        /// (HAPUUID.c:70-84, `"%X%02X%02X%02X"` — note the unpadded top byte,
        /// which is why "43" and not "0043"). The long form is what most other
        /// stacks emit. A controller that read only one of them would call half
        /// the accessories on the market "unknown" and, per `classify`'s
        /// fail-closed arm, render every one of them as a dead sensor row.
        #[test]
        fn an_apple_type_is_recognised_in_both_the_forms_accessories_send() {
            assert_eq!(apple_type("43"), Some(0x43));
            assert_eq!(apple_type("00000043-0000-1000-8000-0026BB765291"), Some(0x43));
            assert_eq!(apple_type("00000043-0000-1000-8000-0026bb765291"), Some(0x43));
            // The three-byte form. `HAPUUIDGetDescription` prints 0x110 as
            // "110", not "0110".
            assert_eq!(apple_type("110"), Some(0x110));
            assert_eq!(apple_type("8"), Some(0x8));
            assert_eq!(apple_type("00000110-0000-1000-8000-0026BB765291"), Some(0x110));

            // A vendor type is not Apple-defined, whatever it looks like.
            assert_eq!(apple_type("E863F007-079E-48FF-8F27-9C2605A29F52"), None);
            // …and neither is a 36-character string with the wrong tail.
            assert_eq!(apple_type("00000043-0000-1000-8000-0026BB765292"), None);
            // A UUID IS ASCII AND THE ACCESSORY IS NOT OBLIGED TO SEND ONE.
            // `t.len()` counts BYTES, so "AAAAAAA\u{e9}0000-…" is 36 bytes with
            // a char boundary inside byte 8 — `split_at(8)` panicked on it, on
            // a value taken verbatim off the accessory's /accessories JSON
            // (http.rs must take vendor UUIDs verbatim; it cannot know their
            // shape). The multi-byte character is placed at exactly the split
            // point on purpose; move it and the case stops testing anything.
            assert_eq!(apple_type("AAAAAAA\u{e9}0000-1000-8000-0026BB765291"), None);
            assert_eq!(apple_type("00000043-0000-1000-8000-0026BB76529\u{e9}"), None);
            assert_eq!(apple_type("4\u{e9}"), None);

            for junk in ["", "  ", "xyz", "43-", "0000004300001000800000026BB765291"] {
                assert_eq!(apple_type(junk), None, "{junk:?}");
            }
        }

        // -- classification: the safety half ------------------------------

        /// THE FAIL-CLOSED RULE, in the two directions that matter.
        ///
        /// A service type this build has never seen — a vendor UUID, or an
        /// Apple type added after this table was written — must come out as
        /// something with NO control, not as a slider. `ha.rs::cover_kind`'s
        /// `_ => "cover"` arm exists for the same reason and the same failure:
        /// an unrecognised opening rendered as a blind is a door on an
        /// Actuate-tier slider that auto-runs without asking anybody.
        #[test]
        fn an_unrecognised_service_type_gets_no_control_rather_than_a_slider() {
            for unknown in [
                // A vendor service (Elgato's, in the wild).
                "E863F007-079E-48FF-8F27-9C2605A29F52",
                // An Apple-defined type this table does not list.
                "F0",
                "000000F0-0000-1000-8000-0026BB765291",
                // Nonsense.
                "not-a-uuid-at-all",
            ] {
                // Given every writable characteristic in the book, so the only
                // thing that can produce "status" is the classification.
                let s = svc(
                    unknown,
                    9,
                    vec![
                        chr("25", 10, &["pr", "pw"], Some(json!(true))),
                        chr("8", 11, &["pr", "pw"], Some(json!(80))),
                        chr("7C", 12, &["pr", "pw"], Some(json!(50))),
                        chr("1E", 13, &["pr", "pw"], Some(json!(0))),
                    ],
                );
                let role = classify(unknown).expect("still a row the user can see");
                assert_eq!(control_of(role, &s), "status", "{unknown} became settable");
                assert!(
                    !crate::home::is_lock_kind(role.kind()),
                    "{unknown} must not claim to be a lock either"
                );
                // And the write paths refuse it outright, so the guard does not
                // rest on `control` alone.
                assert!(writes_for_value(role, &s, 1, 50.0).is_err());
                assert!(writes_for_lock(role, &s, 1, true).is_err());
            }
        }

        /// The two service types that put a device in the LOCK domain, and the
        /// one that must not be there.
        ///
        /// `home::LOCK_KINDS` is `["lock", "garage"]`, and membership is what
        /// routes a device to `home_lock_set` (Tier::Approval, never auto-runs)
        /// instead of `home_device_set` (Tier::Actuate, runs unattended on the
        /// interactive profile). Getting this wrong in the permissive direction
        /// is an Atlas that opens a front door on its own initiative.
        #[test]
        fn the_lock_domain_holds_exactly_the_services_that_open_a_house() {
            for (service, target, kind) in
                [("45", "1E", "lock"), ("41", "32", "garage"), ("81", "7C", "garage")]
            {
                let s = svc(service, 1, vec![chr(target, 2, &["pr", "pw"], Some(json!(1)))]);
                let role = classify(service).expect("a device, not infrastructure");
                assert_eq!(role.kind(), kind, "service {service}");
                assert!(crate::home::is_lock_kind(role.kind()), "service {service}");
                // A lock draws a toggle, never a slider — the surface must not
                // offer "half unlocked".
                assert_eq!(control_of(role, &s), "toggle", "service {service}");
            }
            // A window covering is a blind and must NOT be a lock, or every
            // curtain in the house needs an approval click.
            let blind = svc("8C", 1, vec![chr("7C", 2, &["pr", "pw"], Some(json!(40)))]);
            let role = classify("8C").unwrap();
            assert_eq!(role.kind(), "blind");
            assert_eq!(control_of(role, &blind), "slider");
            assert!(!crate::home::is_lock_kind(role.kind()));
        }

        /// A motorised WINDOW is not a window covering. HAP's `Window` service
        /// opens a hole in the wall; `WindowCovering` moves a blind across one.
        /// Only the second is safe on a tier that runs unattended.
        #[test]
        fn a_motorised_window_is_not_treated_as_a_blind() {
            let window = svc("8B", 1, vec![chr("7C", 2, &["pr", "pw"], Some(json!(0)))]);
            let role = classify("8B").unwrap();
            assert_eq!(control_of(role, &window), "status");
            assert!(writes_for_value(role, &window, 1, 100.0).is_err());
        }

        /// Every Actuate-tier write path refuses a lock, in case the guard in
        /// `home::device_set_allowed` is ever bypassed. Two independent halves
        /// of one rule.
        #[test]
        fn the_value_path_refuses_every_lock_kind_at_the_protocol_layer() {
            for (t, target) in [("45", "1E"), ("41", "32"), ("81", "7C")] {
                let s = svc(t, 1, vec![chr(target, 2, &["pr", "pw"], Some(json!(0)))]);
                let role = classify(t).unwrap();
                let err = writes_for_value(role, &s, 1, 100.0)
                    .expect_err("a lock must never be settable through the value path");
                assert!(err.to_string().contains("home_lock_set"), "{err}");
            }
        }

        /// A characteristic without `pw` is read-only. Drawing a slider on it
        /// gives the user a control that silently does nothing, and sending it
        /// a write earns a per-element error inside a 207 instead of a refusal
        /// anybody can read.
        #[test]
        fn a_read_only_characteristic_never_becomes_a_control() {
            let dim_but_readonly = svc(
                "43",
                1,
                vec![
                    chr("25", 2, &["pr"], Some(json!(true))),
                    chr("8", 3, &["pr"], Some(json!(60))),
                ],
            );
            let role = classify("43").unwrap();
            assert_eq!(control_of(role, &dim_but_readonly), "status");
            assert!(writes_for_value(role, &dim_but_readonly, 1, 50.0).is_err());

            // And a lock whose target state is read-only cannot be locked.
            let watched_lock = svc("45", 1, vec![chr("1D", 2, &["pr"], Some(json!(1)))]);
            let role = classify("45").unwrap();
            assert_eq!(control_of(role, &watched_lock), "status");
            assert!(writes_for_lock(role, &watched_lock, 1, true).is_err());
        }

        // -- values --------------------------------------------------------

        /// The enum values, in the direction HAPCharacteristicTypes.h defines
        /// them. Inverted, Atlas reports every locked door as open.
        #[test]
        fn lock_and_door_states_are_read_in_the_direction_the_header_defines() {
            let lock = |v: u64| svc("45", 1, vec![chr("1D", 2, &["pr"], Some(json!(v)))]);
            let role = Role::Lock;
            assert_eq!(value_of(role, &lock(1)), Some(1.0)); // Secured
            assert_eq!(value_of(role, &lock(0)), Some(0.0)); // Unsecured
            assert_eq!(state_words(role, &lock(1)).as_deref(), Some("Locked"));
            assert_eq!(state_words(role, &lock(0)).as_deref(), Some("Unlocked"));
            // A jammed lock is neither, and must say so rather than pick one.
            assert_eq!(state_words(role, &lock(2)).as_deref(), Some("Jammed"));
            assert_eq!(value_of(role, &lock(2)), Some(0.0));
            assert_eq!(state_words(role, &lock(3)).as_deref(), Some("Unknown"));

            let door = |v: u64| svc("41", 1, vec![chr("E", 2, &["pr"], Some(json!(v)))]);
            let role = Role::GarageDoor;
            assert_eq!(value_of(role, &door(1)), Some(1.0)); // Closed
            assert_eq!(value_of(role, &door(0)), Some(0.0)); // Open
            assert_eq!(state_words(role, &door(0)).as_deref(), Some("Open"));
            assert_eq!(state_words(role, &door(2)).as_deref(), Some("Opening"));
            assert_eq!(state_words(role, &door(4)).as_deref(), Some("Stopped"));
        }

        /// A POSITIONED DOOR IS A `garage` KIND WITH A `toggle` CONTROL, so
        /// its value must speak the toggle convention, not the percentage one.
        ///
        /// This is the assertion that bites: while `value_of` returned the raw
        /// 0-100 CurrentPosition, the card read exactly backwards. The surface
        /// computes `deviceOn = value > 0` and, for a `garage` toggle, prints
        /// `on ? 'Closed' : 'Open'` (deviceGlyph.tsx) — so a CLOSED door
        /// (position 0) rendered "Open" and a fully OPEN door (100) rendered
        /// "Closed", in the lock domain, directly above a `state` line that
        /// correctly said "0 % open". `GarageDoor` is asserted alongside it
        /// because the whole point is that the two agree.
        #[test]
        fn a_positioned_door_speaks_the_same_closed_is_one_convention_as_a_garage_door() {
            let door = |pos: u64| svc("81", 1, vec![chr("6D", 2, &["pr"], Some(json!(pos)))]);
            let role = classify("81").expect("Door is a service this table knows");
            assert_eq!(role, Role::PositionedDoor);
            assert_eq!(role.kind(), "garage");
            assert!(crate::home::is_lock_kind(role.kind()));

            assert_eq!(value_of(role, &door(0)), Some(1.0), "closed must read as secured");
            assert_eq!(value_of(role, &door(100)), Some(0.0), "wide open must read as not secured");
            // Ajar is open. Not a tolerance — a door off its latch is not shut.
            assert_eq!(value_of(role, &door(1)), Some(0.0));

            // The percentage is not lost, it just is not the toggle's value.
            assert_eq!(state_words(role, &door(0)).as_deref(), Some("0 % open"));

            // Same convention as the garage door it shares a `kind` with.
            let garage = svc("41", 1, vec![chr("E", 2, &["pr"], Some(json!(1u64)))]);
            assert_eq!(value_of(Role::GarageDoor, &garage), value_of(role, &door(0)));
        }

        /// A missing reading is `None`, never zero. `store::apply_pull`
        /// COALESCEs `None` onto the last known value, so a fabricated 0 would
        /// overwrite a real reading with a number the accessory never sent.
        #[test]
        fn a_characteristic_with_no_value_reads_as_no_reading() {
            let no_value = svc("43", 1, vec![chr("25", 2, &["pr", "pw"], None)]);
            assert_eq!(value_of(Role::Light, &no_value), None);
            assert_eq!(state_words(Role::Light, &no_value), None);
            let empty = svc("45", 1, vec![]);
            assert_eq!(value_of(Role::Lock, &empty), None);
            // A lamp that is on and has no dimmer reads as 100, which is the
            // truth about a lamp with no dimmer — not a guess.
            let plain_on = svc("43", 1, vec![chr("25", 2, &["pr", "pw"], Some(json!(true)))]);
            assert_eq!(value_of(Role::Light, &plain_on), Some(100.0));
            let plain_off = svc("43", 1, vec![chr("25", 2, &["pr", "pw"], Some(json!(false)))]);
            assert_eq!(value_of(Role::Light, &plain_off), Some(0.0));
        }

        /// A reports-only service shows a reading only when the module knows
        /// the characteristic by number. Reading "the first numeric one" would
        /// report a firmware revision as a temperature.
        #[test]
        fn a_sensor_reports_only_a_characteristic_this_module_can_name() {
            let temp = svc("8A", 1, vec![chr("11", 2, &["pr"], Some(json!(21.5)))]);
            let role = classify("8A").unwrap();
            assert_eq!(value_of(role, &temp), Some(21.5));
            assert_eq!(state_words(role, &temp).as_deref(), Some("21.5 °C"));

            let mystery = svc("8A", 1, vec![chr("52", 2, &["pr"], Some(json!(1.2)))]);
            assert_eq!(value_of(role, &mystery), None);
            assert_eq!(state_words(role, &mystery), None);

            let leak = svc("83", 1, vec![chr("70", 2, &["pr"], Some(json!(1)))]);
            let role = classify("83").unwrap();
            assert_eq!(value_of(role, &leak), Some(1.0));
            assert_eq!(control_of(role, &leak), "status");
        }

        // -- colour --------------------------------------------------------

        /// Hue/saturation round-trip through the swatch, and — the part that
        /// matters — the VALUE component never leaks into the write. A user
        /// picking a darker blue must not dim the lamp.
        #[test]
        fn colour_round_trips_and_never_carries_a_brightness_with_it() {
            for (h, s, hex) in [
                (0.0, 100.0, "#ff0000"),
                (120.0, 100.0, "#00ff00"),
                (240.0, 100.0, "#0000ff"),
                (0.0, 0.0, "#ffffff"),
                (60.0, 50.0, "#ffff80"),
            ] {
                assert_eq!(hs_to_hex(h, s), hex, "hs_to_hex({h},{s})");
                let (h2, s2) = hex_to_hs(hex).expect(hex);
                assert!((h2 - h).abs() < 1.0 || s == 0.0, "hue {h2} != {h} for {hex}");
                assert!((s2 - s).abs() < 1.0, "sat {s2} != {s} for {hex}");
            }
            // A dark blue and a bright blue are the same HUE and SATURATION.
            // If value leaked into the write these two would differ.
            assert_eq!(hex_to_hs("#000080"), hex_to_hs("#0000ff"));

            let light = svc(
                "43",
                1,
                vec![
                    chr("25", 2, &["pr", "pw"], Some(json!(true))),
                    chr("13", 3, &["pr", "pw"], Some(json!(0.0))),
                    chr("2F", 4, &["pr", "pw"], Some(json!(0.0))),
                ],
            );
            assert_eq!(control_of(classify("43").unwrap(), &light), "colour");
            let writes = writes_for_colour(&light, 1, "#0000ff").unwrap();
            assert_eq!(writes.len(), 2, "hue and saturation, both or neither");
            assert_eq!(writes[0].id, CharId::new(1, 3));
            assert_eq!(writes[0].value, json!(240.0));
            assert_eq!(writes[1].value, json!(100.0));

            for bad in ["", "#fff", "blue", "#gggggg", "#00000"] {
                assert!(writes_for_colour(&light, 1, bad).is_err(), "{bad:?}");
            }
        }

        /// Hue without saturation is refused. Writing one of the pair moves the
        /// lamp to a colour the user did not choose.
        #[test]
        fn a_light_with_only_half_a_colour_pair_takes_no_colour() {
            let half = svc(
                "43",
                1,
                vec![
                    chr("25", 2, &["pr", "pw"], Some(json!(true))),
                    chr("13", 3, &["pr", "pw"], Some(json!(0.0))),
                ],
            );
            assert!(writes_for_colour(&half, 1, "#0000ff").is_err());
            assert_eq!(control_of(classify("43").unwrap(), &half), "toggle");
        }

        // -- writes --------------------------------------------------------

        /// A dimmable lamp: On first, then Brightness. Written in that order
        /// because a brightness applied while the lamp is off is accepted and
        /// invisible, and the ADK applies a PUT's elements in order.
        #[test]
        fn setting_a_light_sends_on_before_brightness_and_nothing_when_off() {
            let light = svc(
                "43",
                1,
                vec![
                    chr("25", 2, &["pr", "pw"], Some(json!(false))),
                    chr("8", 3, &["pr", "pw"], Some(json!(0))),
                ],
            );
            let role = classify("43").unwrap();
            assert_eq!(control_of(role, &light), "slider");

            let on = writes_for_value(role, &light, 7, 40.0).unwrap();
            assert_eq!(on.len(), 2);
            assert_eq!(on[0], CharWrite { id: CharId::new(7, 2), value: json!(true) });
            assert_eq!(on[1], CharWrite { id: CharId::new(7, 3), value: json!(40) });

            // Zero is off, and must NOT also write brightness 0 — a lamp
            // switched off at brightness 0 comes back on at nothing.
            let off = writes_for_value(role, &light, 7, 0.0).unwrap();
            assert_eq!(off, vec![CharWrite { id: CharId::new(7, 2), value: json!(false) }]);
        }

        /// The lock write, in both directions, for all three door shapes.
        #[test]
        fn locking_writes_the_target_the_header_defines_for_each_shape() {
            let lock = svc("45", 1, vec![chr("1E", 5, &["pr", "pw"], Some(json!(0)))]);
            let role = classify("45").unwrap();
            assert_eq!(
                writes_for_lock(role, &lock, 2, true).unwrap(),
                vec![CharWrite { id: CharId::new(2, 5), value: json!(1) }]
            );
            assert_eq!(
                writes_for_lock(role, &lock, 2, false).unwrap()[0].value,
                json!(0)
            );

            let garage = svc("41", 1, vec![chr("32", 6, &["pr", "pw"], Some(json!(1)))]);
            let role = classify("41").unwrap();
            // Closed is locked. TargetDoorState: Open = 0, Closed = 1.
            assert_eq!(writes_for_lock(role, &garage, 3, true).unwrap()[0].value, json!(1));
            assert_eq!(writes_for_lock(role, &garage, 3, false).unwrap()[0].value, json!(0));

            let door = svc("81", 1, vec![chr("7C", 7, &["pr", "pw"], Some(json!(100)))]);
            let role = classify("81").unwrap();
            // A positioned door has no bolt: shut is locked.
            assert_eq!(writes_for_lock(role, &door, 4, true).unwrap()[0].value, json!(0));
            assert_eq!(writes_for_lock(role, &door, 4, false).unwrap()[0].value, json!(100));
        }

        /// A thermostat's value is degrees, not a percentage, so it must not be
        /// clamped to 0-100 the way a slider is.
        #[test]
        fn a_thermostat_target_is_not_clamped_into_a_percentage() {
            let t = svc(
                "4A",
                1,
                vec![
                    chr("11", 2, &["pr"], Some(json!(19.5))),
                    chr("35", 3, &["pr", "pw"], Some(json!(21.0))),
                ],
            );
            let role = classify("4A").unwrap();
            assert_eq!(control_of(role, &t), "stepper");
            assert_eq!(value_of(role, &t), Some(19.5));
            assert_eq!(writes_for_value(role, &t, 1, 21.5).unwrap()[0].value, json!(21.5));
            // Below zero is a real target in a cold country and must survive.
            assert_eq!(writes_for_value(role, &t, 1, -5.0).unwrap()[0].value, json!(-5.0));
            // …but a non-number is not.
            assert!(writes_for_value(role, &t, 1, f64::NAN).is_err());
            assert!(writes_for_value(role, &t, 1, f64::INFINITY).is_err());
        }

        // -- the whole projection -------------------------------------------

        /// Infrastructure services are not devices. Every accessory carries
        /// AccessoryInformation and Pairing; a row for each would bury the lamp
        /// in a list of things nobody can act on.
        #[test]
        fn the_services_every_accessory_carries_are_not_rendered_as_devices() {
            let acc = Accessory {
                aid: 1,
                services: vec![
                    svc(
                        "3E",
                        1,
                        vec![chr("23", 2, &["pr"], Some(json!("Hall Lamp")))],
                    ),
                    svc("A2", 10, vec![]),
                    svc("55", 20, vec![]),
                    svc("96", 30, vec![]),
                    svc(
                        "43",
                        40,
                        vec![chr("25", 41, &["pr", "pw"], Some(json!(true)))],
                    ),
                ],
            };
            let devices = devices_from(&[acc]);
            assert_eq!(devices.len(), 1, "{devices:#?}");
            assert_eq!(devices[0].kind, "bulb");
            // The accessory's own name is used when the service has none.
            assert_eq!(devices[0].name, "Hall Lamp");
            assert_eq!(devices[0].external_id, "1.40");
            assert_eq!(parse_external_id("1.40"), Some((1, 40)));
            // HAP has no rooms and no change timestamp; both are absent rather
            // than invented.
            assert!(devices[0].room_external_id.is_none());
            assert!(devices[0].last_changed.is_none());
        }

        /// A service's own Name wins over the accessory's — a two-outlet plug
        /// names each socket, and showing both as "Power Strip" makes the pair
        /// impossible to tell apart on an approvals card.
        #[test]
        fn each_service_keeps_its_own_name_when_it_has_one() {
            let acc = Accessory {
                aid: 2,
                services: vec![
                    svc("3E", 1, vec![chr("23", 2, &["pr"], Some(json!("Power Strip")))]),
                    svc(
                        "47",
                        10,
                        vec![
                            chr("23", 11, &["pr"], Some(json!("Desk"))),
                            chr("25", 12, &["pr", "pw"], Some(json!(true))),
                        ],
                    ),
                    svc(
                        "47",
                        20,
                        vec![
                            chr("23", 21, &["pr"], Some(json!("Lamp"))),
                            chr("25", 22, &["pr", "pw"], Some(json!(false))),
                        ],
                    ),
                ],
            };
            let devices = devices_from(&[acc]);
            let names: Vec<&str> = devices.iter().map(|d| d.name.as_str()).collect();
            assert_eq!(names, vec!["Desk", "Lamp"]);
            assert_eq!(devices[0].external_id, "2.10");
            assert_eq!(devices[1].external_id, "2.20");
            assert_eq!(devices[0].value, Some(1.0));
            assert_eq!(devices[1].value, Some(0.0));
        }

        // -- the locator ---------------------------------------------------

        #[test]
        fn a_target_round_trips_through_the_bridge_row_it_is_stored_in() {
            let t = Target {
                accessory_id: "AA:BB:CC:DD:EE:FF".into(),
                host: "lock-1.local".into(),
                port: 51826,
            };
            assert_eq!(t.locator(), "hap://AA:BB:CC:DD:EE:FF@lock-1.local:51826");
            assert_eq!(Target::parse(&t.locator()), Some(t.clone()));
            assert_eq!(t.authority(), "lock-1.local:51826");

            // A Home Assistant URL in this column is not a HomeKit target, and
            // must not be parsed into one.
            assert_eq!(Target::parse("http://homeassistant.local:8123"), None);
            for junk in ["", "hap://", "hap://id@host", "hap://@h:1", "hap://id@:1", "hap://id@h:0"]
            {
                assert_eq!(Target::parse(junk), None, "{junk:?}");
            }
        }

        /// The `Host:` header is composed from a name that arrived over
        /// unauthenticated multicast, so a control character in it would be a
        /// header-injection primitive. Refused rather than sanitised.
        #[test]
        fn an_accessory_host_with_header_characters_is_refused() {
            for bad in ["", "a\r\nX: y", "has space", "a\u{0}b", &"x".repeat(256)] {
                assert!(check_host(bad).is_err(), "{bad:?}");
            }
            assert!(check_host("lock-1.local:51826").is_ok());
            assert!(check_host("192.168.1.9").is_ok());
        }

        /// The pairing endpoints must be plaintext HTTP with the TLV8 content
        /// type — "Only non-secure access is supported"
        /// (adk_HAPIPAccessoryServer.c:2611/:2625).
        #[test]
        fn the_pairing_request_is_the_plaintext_post_the_accessory_accepts() {
            let r = tlv_post("/pair-verify", "lock-1.local:51826", &[1, 2, 3]);
            let text = String::from_utf8_lossy(&r);
            assert!(text.starts_with("POST /pair-verify HTTP/1.1\r\n"), "{text}");
            assert!(text.contains("Host: lock-1.local:51826\r\n"), "{text}");
            assert!(text.contains("Content-Type: application/pairing+tlv8\r\n"), "{text}");
            assert!(text.contains("Content-Length: 3\r\n"), "{text}");
            assert_eq!(&r[r.len() - 3..], &[1, 2, 3]);
            // And it parses as a message with the body intact, which is the
            // property the accessory's own parser needs.
            assert!(text.contains("\r\n\r\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The adapter must FAIL, in every direction, whenever there is nothing
    /// paired — and say the same thing each time. A stub that quietly returned
    /// success on any of these would make Atlas report that it had locked a
    /// door it never touched.
    #[test]
    fn an_unpaired_adapter_refuses_everything_and_none_of_it_pretends_to_work() {
        let c = Companion::Unavailable("nothing here".into());
        let errors: Vec<HomeError> = vec![
            c.probe().expect_err("probe must refuse"),
            c.pull().expect_err("pull must refuse — an empty house is not the answer"),
            c.set_value("1.2", 1.0).unwrap_err(),
            c.set_colour("1.2", "#ffffff").unwrap_err(),
            c.set_lock("1.2", true).unwrap_err(),
            c.run_scene("x").unwrap_err(),
        ];
        for e in &errors {
            assert!(matches!(e, HomeError::Unavailable(_)), "{e}");
            assert_eq!(e.to_string(), "nothing here");
        }
    }

    /// The two absences are different problems with different fixes, and the
    /// row has to say which one this build is in. Collapsing them would tell a
    /// Lighthouse user to go and install Lighthouse.
    #[test]
    fn the_two_absences_are_told_apart_and_both_name_a_next_step() {
        assert_ne!(NO_CONTROLLER, NOT_PAIRED);
        // The consumer build's sentence names the alternative that works here.
        assert!(NO_CONTROLLER.contains("Home Assistant"), "{NO_CONTROLLER}");
        assert!(NO_CONTROLLER.contains("Lighthouse"), "{NO_CONTROLLER}");
        // The Lighthouse build's names the action.
        assert!(NOT_PAIRED.contains("setup code"), "{NOT_PAIRED}");

        let expected = if cfg!(feature = "homekit") { NOT_PAIRED } else { NO_CONTROLLER };
        assert_eq!(default_detail(), expected);
    }

    /// The Setup row must explain itself rather than looking linkable in a
    /// build that cannot link it.
    #[test]
    fn the_bridge_row_says_which_of_the_two_absences_this_build_is_in() {
        let row = bridge_entry();
        assert_eq!(row["state"], json!("not-linked"));
        assert_eq!(row["kind"], json!("homekit_companion"));
        let detail = row["detail"].as_str().unwrap();
        assert_eq!(detail, default_detail());
        if cfg!(feature = "homekit") {
            // Present but unpaired: a Link button here would work.
            assert_eq!(row["health"], json!("not-linked"));
        } else {
            assert_eq!(row["health"], json!("unavailable"));
        }
    }

    /// HAP has no scenes on the accessory at all, and the refusal says so
    /// rather than reporting an empty scene list the user could not act on.
    #[test]
    fn a_scene_is_refused_with_the_reason_that_hap_has_none() {
        // Only reachable in a build with the controller; without it the
        // unavailable sentence comes first, which is also correct.
        let c = Companion::Unavailable(NO_CONTROLLER.into());
        assert!(matches!(c.run_scene("x"), Err(HomeError::Unavailable(_))));
    }
}
