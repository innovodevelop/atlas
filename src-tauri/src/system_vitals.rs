// What the machine is doing, for the Beta top bar: battery, Wi-Fi, Bluetooth.
//
// The top bar reference (`atlas-topbar.js`) shows a device stack, a Bluetooth
// glyph, the Wi-Fi network name and the battery percentage, and links them to
// System Status. The app had none of this: the only battery in the Rust tree
// was a HomeKit service id. Everything here comes from macOS's own tools,
// which need no entitlement and no extra crate:
//
//   battery    `pmset -g batt`               ~5 ms
//   wi-fi      `ipconfig getsummary en0`     ~20 ms (macOS 14+ puts the SSID
//              here; `networksetup -getairportnetwork` is the fallback for
//              older systems)
//   bluetooth  `system_profiler SPBluetoothDataType -json`   300–1500 ms
//
// system_profiler is slow, so its answer is cached for CACHE_SECS and refreshed
// off the command's thread; the first call returns the quick fields at once and
// the Bluetooth half as `None` until the probe has run. Every field is an
// Option: "unknown" is an honest answer, a made-up 68% is not.
//
// The parsers take the tool's text so they can be tested on fixtures.
use serde::Serialize;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_SECS: u64 = 30;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
    /// Wall power, charging or not (a full battery on the charger).
    pub on_power: bool,
    /// "2:14 remaining" style text from pmset, when it gives one.
    pub remaining: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Wifi {
    pub ssid: Option<String>,
    pub connected: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct BtDevice {
    pub name: String,
    /// system_profiler's minor type: "Headphones", "Keyboard", "Mouse", "Trackpad", "Speaker"…
    pub kind: Option<String>,
    pub battery_percent: Option<u8>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Bluetooth {
    pub on: bool,
    pub connected: Vec<BtDevice>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SystemVitals {
    pub battery: Option<Battery>,
    pub wifi: Option<Wifi>,
    /// None until the first Bluetooth probe has finished.
    pub bluetooth: Option<Bluetooth>,
    /// Unix seconds of the Bluetooth probe this answer carries, if any.
    pub bluetooth_at: Option<u64>,
}

// --- Parsers ------------------------------------------------------------------

/// `pmset -g batt` on a MacBook:
///   Now drawing from 'Battery Power'
///    -InternalBattery-0 (id=…)	68%; discharging; 3:12 remaining present: true
/// A desktop prints only the first line, with no battery row: that is `None`.
pub fn parse_pmset(out: &str) -> Option<Battery> {
    let row = out.lines().find(|l| l.contains("InternalBattery"))?;
    let after_tab = row.split('\t').nth(1).unwrap_or(row);
    let mut parts = after_tab.split(';').map(str::trim);
    let percent: u8 = parts.next()?.trim_end_matches('%').parse().ok()?;
    let state = parts.next().unwrap_or("").to_ascii_lowercase();
    let rest = parts.next().unwrap_or("");
    let remaining = rest
        .split(" present")
        .next()
        .map(str::trim)
        .filter(|s| s.contains("remaining") || s.contains("until full"))
        .map(|s| s.to_string());
    let on_power = out.contains("'AC Power'") || state.contains("charging") && !state.contains("discharging") || state.contains("charged");
    Some(Battery {
        percent: percent.min(100),
        charging: state == "charging",
        on_power,
        remaining,
    })
}

/// `ipconfig getsummary en0` prints a dictionary; the line we want is
/// `  SSID : Fogware 5G`. Falls back to `networksetup -getairportnetwork en0`
/// output: `Current Wi-Fi Network: Fogware 5G` / `You are not associated…`.
pub fn parse_wifi(summary: &str, airport: &str) -> Wifi {
    if let Some(line) = summary.lines().find(|l| l.trim_start().starts_with("SSID :")) {
        let ssid = line.splitn(2, ':').nth(1).map(str::trim).filter(|s| !s.is_empty());
        if let Some(s) = ssid {
            return Wifi { ssid: Some(s.to_string()), connected: true };
        }
    }
    if let Some(rest) = airport.trim().strip_prefix("Current Wi-Fi Network:") {
        let s = rest.trim();
        if !s.is_empty() {
            return Wifi { ssid: Some(s.to_string()), connected: true };
        }
    }
    Wifi { ssid: None, connected: false }
}

/// `system_profiler SPBluetoothDataType -json`. The shape:
/// `{"SPBluetoothDataType":[{"controller_properties":{"controller_state":"attrib_on"},
///   "device_connected":[{"AirPods Pro":{"device_minorType":"Headphones","device_batteryLevelMain":"80%"}}]}]}`
pub fn parse_bluetooth(json: &str) -> Option<Bluetooth> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let entry = v.get("SPBluetoothDataType")?.as_array()?.first()?;
    let on = entry
        .get("controller_properties")
        .and_then(|c| c.get("controller_state"))
        .and_then(|s| s.as_str())
        .map(|s| s == "attrib_on" || s == "attrib_On")
        .unwrap_or(false);
    let mut connected = Vec::new();
    if let Some(list) = entry.get("device_connected").and_then(|d| d.as_array()) {
        for item in list {
            if let Some(obj) = item.as_object() {
                for (name, props) in obj {
                    let pct = ["device_batteryLevelMain", "device_batteryLevel", "device_batteryLevelLeft", "device_batteryLevelCase"]
                        .iter()
                        .find_map(|k| props.get(*k).and_then(|b| b.as_str()))
                        .and_then(|s| s.trim_end_matches('%').parse::<u8>().ok());
                    connected.push(BtDevice {
                        name: name.clone(),
                        kind: props.get("device_minorType").and_then(|k| k.as_str()).map(|s| s.to_string()),
                        battery_percent: pct,
                    });
                }
            }
        }
    }
    Some(Bluetooth { on, connected })
}

// --- Probes --------------------------------------------------------------------

fn run(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn probe_battery() -> Option<Battery> {
    parse_pmset(&run("pmset", &["-g", "batt"]))
}

fn probe_wifi() -> Wifi {
    let summary = run("ipconfig", &["getsummary", "en0"]);
    let airport = if summary.contains("SSID :") { String::new() } else { run("networksetup", &["-getairportnetwork", "en0"]) };
    parse_wifi(&summary, &airport)
}

struct BtCache {
    value: Option<Bluetooth>,
    at: Option<Instant>,
    at_unix: Option<u64>,
    refreshing: bool,
}

fn bt_cache() -> &'static Mutex<BtCache> {
    static CACHE: OnceLock<Mutex<BtCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BtCache { value: None, at: None, at_unix: None, refreshing: false }))
}

fn refresh_bluetooth_in_background() {
    {
        let mut c = bt_cache().lock().unwrap();
        let fresh = c.at.map(|t| t.elapsed() < Duration::from_secs(CACHE_SECS)).unwrap_or(false);
        if fresh || c.refreshing {
            return;
        }
        c.refreshing = true;
    }
    std::thread::spawn(|| {
        let parsed = parse_bluetooth(&run("system_profiler", &["SPBluetoothDataType", "-json"]));
        let mut c = bt_cache().lock().unwrap();
        c.value = parsed;
        c.at = Some(Instant::now());
        c.at_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs());
        c.refreshing = false;
    });
}

/// The top bar's data. Quick fields now; Bluetooth from the cache, refreshed
/// in the background when older than CACHE_SECS.
#[tauri::command]
pub fn system_vitals() -> SystemVitals {
    refresh_bluetooth_in_background();
    let (bluetooth, bluetooth_at) = {
        let c = bt_cache().lock().unwrap();
        (c.value.clone(), c.at_unix)
    };
    SystemVitals {
        battery: probe_battery(),
        wifi: Some(probe_wifi()),
        bluetooth,
        bluetooth_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pmset_on_battery() {
        let out = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=12345)\t68%; discharging; 3:12 remaining present: true\n";
        let b = parse_pmset(out).unwrap();
        assert_eq!(b, Battery { percent: 68, charging: false, on_power: false, remaining: Some("3:12 remaining".into()) });
    }

    #[test]
    fn pmset_charging_and_charged() {
        let charging = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t54%; charging; 1:02 remaining present: true\n";
        let b = parse_pmset(charging).unwrap();
        assert!(b.charging && b.on_power);
        assert_eq!(b.percent, 54);
        let full = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
        let b = parse_pmset(full).unwrap();
        assert!(!b.charging && b.on_power);
        // "0:00 remaining" is not information; pmset also prints "(no estimate)".
        let none = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t91%; charging; (no estimate) present: true\n";
        assert_eq!(parse_pmset(none).unwrap().remaining, None);
    }

    #[test]
    fn pmset_desktop_has_no_battery() {
        assert_eq!(parse_pmset("Now drawing from 'AC Power'\n"), None);
    }

    #[test]
    fn wifi_from_summary_then_airport_then_nothing() {
        let summary = "<dictionary> {\n  InterfaceType : WiFi\n  SSID : Fogware 5G\n  Security : WPA3\n}\n";
        assert_eq!(parse_wifi(summary, ""), Wifi { ssid: Some("Fogware 5G".into()), connected: true });
        assert_eq!(parse_wifi("", "Current Wi-Fi Network: Home\n"), Wifi { ssid: Some("Home".into()), connected: true });
        assert_eq!(parse_wifi("", "You are not associated with an AirPort network.\n"), Wifi { ssid: None, connected: false });
    }

    #[test]
    fn bluetooth_devices_and_power() {
        let json = r#"{"SPBluetoothDataType":[{"controller_properties":{"controller_state":"attrib_on"},
          "device_connected":[{"AirPods Pro":{"device_minorType":"Headphones","device_batteryLevelLeft":"80%","device_batteryLevelCase":"40%"}},
                              {"Magic Trackpad":{"device_minorType":"Trackpad","device_batteryLevelMain":"62%"}}]}]}"#;
        let b = parse_bluetooth(json).unwrap();
        assert!(b.on);
        assert_eq!(b.connected.len(), 2);
        assert_eq!(b.connected[0].name, "AirPods Pro");
        assert_eq!(b.connected[0].battery_percent, Some(80));
        assert_eq!(b.connected[1].kind.as_deref(), Some("Trackpad"));
        let off = r#"{"SPBluetoothDataType":[{"controller_properties":{"controller_state":"attrib_off"}}]}"#;
        let b = parse_bluetooth(off).unwrap();
        assert!(!b.on && b.connected.is_empty());
        assert!(parse_bluetooth("not json").is_none());
    }
}
