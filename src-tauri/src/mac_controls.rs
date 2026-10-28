// Settings → This Mac: Wi-Fi, Bluetooth, the Mac's own details, battery
// health and history, whether the screen is locked, and Restart Atlas.
//
// system_vitals.rs answers the top bar's three quick questions every thirty
// seconds. This module is what the Settings sections and the status panels
// ask when someone is looking at them, and the few switches they carry.
//
// THE SPLIT. The READ commands here run a fixed list of macOS tools and hand
// their text back unparsed; the parsing lives in src/lib/macProbes.ts, where
// it is unit-tested on real tool output with `bun test`. Two exceptions trim
// in Rust before anything crosses to the webview, because the raw output
// carries identifiers the screens never show: the hardware profile (serial
// number, hardware UUID) is cut down to the model's name, and the battery's
// ioreg dump (serial numbers, 16 KB of it) to the capacity lines. The WRITE
// commands take user input, so they validate it here, in Rust, before any
// tool sees it, and pass every value as its own argument — there is no shell
// anywhere in this file, and nothing a user types is ever interpreted by one.
//
// SECRETS. `wifi_join` takes the password the user typed and passes it to
// `networksetup` as one argument. It is never stored, never logged, never put
// in an error message (a tool's error text is scrubbed of it before it comes
// back), and it is dropped when the command returns. macOS keeps it in the
// Keychain itself when the join succeeds, which is how every other app joins.
//
// NETWORK NAMES. Since macOS 14.4, `ipconfig` and `system_profiler` print
// "<redacted>" for every network name unless the app asking has Location
// Services access, which Atlas does not request. The preferred-network list is
// not redacted, so known networks keep their names; the network in use and
// the ones in range usually do not. The screens say so rather than guess.
//
// BLUETOOTH. macOS has no command-line tool for Bluetooth power or
// connections. IOBluetooth bindings are not in Cargo.lock, so the switches use
// `blueutil` when the user has installed it (Homebrew's two prefixes are
// checked; it is never installed from here) and the section stays read-only,
// saying why, when it is absent.
//
// Every command is `#[tauri::command(async)]`: each one spawns a process, and
// `system_profiler` can take seconds, which on the main thread is a frozen
// window.
use crate::db::DbState;
use rusqlite::params;
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

/// The interface macOS gives Wi-Fi on every Mac Atlas supports; used only when
/// `networksetup -listallhardwareports` does not name one.
const WIFI_FALLBACK_DEVICE: &str = "en0";

/// How often the battery history takes a sample.
const BATTERY_SAMPLE_SECS: u64 = 600;

/// The model's name never changes while Atlas runs, and `system_profiler`
/// takes a few hundred milliseconds, so it is read once an hour at most.
const HARDWARE_CACHE_SECS: u64 = 3600;

// --- Running tools ---------------------------------------------------------------

/// Stdout of a tool, or "" when it is missing or fails. For reads, where an
/// empty answer is parsed as "unknown".
fn read(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// `text` with `secret` replaced, so a tool that echoes its arguments cannot
/// hand a password back to the webview.
fn scrub(text: &str, secret: Option<&str>) -> String {
    let t = text.trim().to_string();
    match secret {
        Some(p) if !p.is_empty() => t.replace(p, "•••"),
        _ => t,
    }
}

/// Run a tool that changes something. `networksetup` reports most failures on
/// stdout with exit status 0, so the text is checked as well as the status.
/// `secret` is removed from anything that comes back.
fn act(cmd: &str, args: &[&str], secret: Option<&str>) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("{cmd} could not run: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        let msg = if stderr.trim().is_empty() { stdout.as_str() } else { stderr.as_str() };
        let msg = scrub(msg, secret);
        return Err(if msg.is_empty() { format!("{cmd} failed") } else { msg });
    }
    if let Some(line) = tool_failure(&stdout).or_else(|| tool_failure(&stderr)) {
        return Err(scrub(&line, secret));
    }
    Ok(scrub(&stdout, secret))
}

/// The first line of a tool's output that reports a failure, if any.
/// `networksetup` prints "** Error: …", "Could not find network X." and
/// "Network X was not found in the preferred networks list" — the last two
/// with exit status 0.
pub fn tool_failure(out: &str) -> Option<String> {
    out.lines()
        .map(str::trim)
        .find(|l| {
            let low = l.trim_start_matches('*').trim_start().to_ascii_lowercase();
            low.starts_with("error")
                || low.starts_with("could not")
                || low.starts_with("failed")
                || low.starts_with("you cannot")
                || low.contains("was not found")
                || low.contains("is not a wi-fi interface")
                || low.contains("administrator")
                || low.contains("not authorized")
        })
        .map(|l| l.trim_start_matches('*').trim_start().to_string())
}

// --- Validation --------------------------------------------------------------

/// A network name as 802.11 allows it: 1–32 bytes. Control characters are
/// refused (nothing legitimate has them, and they would mangle the tool's
/// output), and so is a leading '-', which `networksetup` would read as an
/// option rather than a name.
pub fn validate_ssid(ssid: &str) -> Result<(), String> {
    if ssid.is_empty() || ssid.len() > 32 {
        return Err("A network name is 1 to 32 bytes long.".into());
    }
    if ssid.chars().any(char::is_control) {
        return Err("That network name has characters a network name cannot have.".into());
    }
    if ssid.starts_with('-') {
        return Err("Atlas cannot join a network whose name starts with '-'. Join it from the macOS menu bar.".into());
    }
    Ok(())
}

/// A Wi-Fi password: empty for an open network (or a known one, whose password
/// macOS already holds), otherwise at most 64 characters (a WPA passphrase is
/// 8–63, a raw key 64 hex digits; older WEP keys are shorter, so there is no
/// lower bound here — the network refuses a wrong one). Control characters are
/// refused.
pub fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() > 64 {
        return Err("A Wi-Fi password is at most 64 characters.".into());
    }
    if password.chars().any(char::is_control) {
        return Err("That password has characters a Wi-Fi password cannot have.".into());
    }
    Ok(())
}

/// A Bluetooth address, `aa-bb-cc-dd-ee-ff` or `aa:bb:cc:dd:ee:ff`. Only an
/// address reaches blueutil — it also accepts names, which could collide.
pub fn validate_bt_address(addr: &str) -> Result<(), String> {
    let parts: Vec<&str> = addr.split(|c| c == '-' || c == ':').collect();
    let ok = addr.len() == 17
        && parts.len() == 6
        && parts.iter().all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit()));
    if ok {
        Ok(())
    } else {
        Err("That is not a Bluetooth device address.".into())
    }
}

// --- Wi-Fi -----------------------------------------------------------------------

/// `networksetup -listallhardwareports` prints blocks of
///   Hardware Port: Wi-Fi
///   Device: en0
/// (older systems say "AirPort"). The Wi-Fi block's device, if it looks like one.
pub fn parse_wifi_device(out: &str) -> Option<String> {
    let mut in_wifi = false;
    for line in out.lines().map(str::trim) {
        if let Some(port) = line.strip_prefix("Hardware Port:") {
            let p = port.trim();
            in_wifi = p == "Wi-Fi" || p == "AirPort";
        } else if in_wifi {
            if let Some(dev) = line.strip_prefix("Device:") {
                let dev = dev.trim();
                let valid = dev.len() > 2
                    && dev.starts_with("en")
                    && dev[2..].chars().all(|c| c.is_ascii_digit());
                return if valid { Some(dev.to_string()) } else { None };
            }
        }
    }
    None
}

fn wifi_device() -> String {
    parse_wifi_device(&read("networksetup", &["-listallhardwareports"]))
        .unwrap_or_else(|| WIFI_FALLBACK_DEVICE.to_string())
}

#[derive(Serialize, Debug, Default)]
pub struct WifiReadout {
    pub device: String,
    /// `networksetup -getairportpower`: "Wi-Fi Power (en0): On".
    pub power: String,
    /// `ipconfig getsummary <device>`: SSID (often redacted), security, link state.
    pub summary: String,
    /// `ipconfig getifaddr <device>`: the IPv4 address, or "".
    pub ip: String,
    /// `route -n get default`: the router as "gateway: …".
    pub route: String,
    /// `networksetup -listpreferredwirelessnetworks`: the known networks.
    pub preferred: String,
    /// `system_profiler SPAirPortDataType -json` — signal, rate, channel and
    /// the networks in range. Slow (one to five seconds), so only on request.
    pub profiler: Option<String>,
}

/// Everything the Wi-Fi section shows. `scan` adds the slow profiler read.
#[tauri::command(async)]
pub fn wifi_read(scan: Option<bool>) -> Result<WifiReadout, String> {
    let device = wifi_device();
    let dev = device.as_str();
    Ok(WifiReadout {
        power: read("networksetup", &["-getairportpower", dev]),
        summary: read("ipconfig", &["getsummary", dev]),
        ip: read("ipconfig", &["getifaddr", dev]),
        route: read("route", &["-n", "get", "default"]),
        preferred: read("networksetup", &["-listpreferredwirelessnetworks", dev]),
        profiler: if scan.unwrap_or(false) {
            Some(read("system_profiler", &["SPAirPortDataType", "-json"]))
        } else {
            None
        },
        device,
    })
}

#[tauri::command(async)]
pub fn wifi_set_power(on: bool) -> Result<(), String> {
    let device = wifi_device();
    act("networksetup", &["-setairportpower", &device, if on { "on" } else { "off" }], None).map(|_| ())
}

/// Join a network. The password goes straight to `networksetup` as its own
/// argument and nowhere else — see the header. Without one, macOS uses the
/// password it already holds for a known network.
#[tauri::command(async)]
pub fn wifi_join(ssid: String, password: Option<String>) -> Result<(), String> {
    validate_ssid(&ssid)?;
    let password = password.unwrap_or_default();
    validate_password(&password)?;
    let device = wifi_device();
    let result = if password.is_empty() {
        act("networksetup", &["-setairportnetwork", &device, &ssid], None)
    } else {
        act("networksetup", &["-setairportnetwork", &device, &ssid, &password], Some(&password))
    };
    result.map(|_| ())
}

/// Remove a network from the preferred list, so this Mac stops joining it.
#[tauri::command(async)]
pub fn wifi_forget(ssid: String) -> Result<(), String> {
    validate_ssid(&ssid)?;
    let device = wifi_device();
    act("networksetup", &["-removepreferredwirelessnetwork", &device, &ssid], None).map(|_| ())
}

// --- Bluetooth -------------------------------------------------------------------

/// Where Homebrew puts blueutil (Apple silicon, then Intel). A GUI app's PATH
/// holds neither, so the two prefixes are checked directly.
const BLUEUTIL_PATHS: [&str; 2] = ["/opt/homebrew/bin/blueutil", "/usr/local/bin/blueutil"];

fn blueutil() -> Option<&'static str> {
    BLUEUTIL_PATHS.iter().copied().find(|p| Path::new(p).is_file())
}

#[derive(Serialize, Debug, Default)]
pub struct BluetoothReadout {
    /// The blueutil binary in use, or None when it is not installed.
    pub blueutil: Option<String>,
    /// `system_profiler SPBluetoothDataType -json`: power, connected and
    /// paired-but-not-connected devices, with addresses.
    pub profiler: String,
    /// `blueutil --power`: "1" or "0".
    pub power: Option<String>,
}

/// The Bluetooth section's read. `devices: false` skips the slow device list
/// (300–1500 ms), for the status panel, which only needs the switch and has
/// the device list from `system_vitals` already.
#[tauri::command(async)]
pub fn bluetooth_read(devices: Option<bool>) -> Result<BluetoothReadout, String> {
    let tool = blueutil();
    Ok(BluetoothReadout {
        blueutil: tool.map(str::to_string),
        profiler: if devices.unwrap_or(true) {
            read("system_profiler", &["SPBluetoothDataType", "-json"])
        } else {
            String::new()
        },
        power: tool.map(|t| read(t, &["--power"])),
    })
}

fn require_blueutil() -> Result<&'static str, String> {
    blueutil().ok_or_else(|| {
        "Switching Bluetooth from Atlas needs the blueutil tool, which is not installed on this Mac.".to_string()
    })
}

#[tauri::command(async)]
pub fn bluetooth_set_power(on: bool) -> Result<(), String> {
    let tool = require_blueutil()?;
    act(tool, &["--power", if on { "1" } else { "0" }], None).map(|_| ())
}

/// Connect or disconnect a paired device, by address.
#[tauri::command(async)]
pub fn bluetooth_device(address: String, connect: bool) -> Result<(), String> {
    validate_bt_address(&address)?;
    let tool = require_blueutil()?;
    let flag = if connect { "--connect" } else { "--disconnect" };
    act(tool, &[flag, &address], None).map(|_| ())
}

// --- This Mac ---------------------------------------------------------------------

#[derive(Serialize, Debug, Default)]
pub struct MacReadout {
    /// `sysctl -n machdep.cpu.brand_string`: "Apple M3 Max".
    pub cpu_brand: String,
    /// `sysctl -n hw.memsize`: bytes.
    pub memsize: String,
    /// `sysctl -n hw.logicalcpu`.
    pub logical_cpus: String,
    /// `sysctl -n hw.model`: "Mac15,9".
    pub hw_model: String,
    /// `sysctl -n kern.boottime`: "{ sec = 1761600000, usec = 0 } …".
    pub boottime: String,
    /// `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical.
    pub pressure: String,
    /// `sw_vers -productVersion`.
    pub os_version: String,
    /// The model's marketing name ("MacBook Pro"), from the cached hardware
    /// profile; "" when it could not be read.
    pub machine_name: String,
    /// `vm_stat`.
    pub vm_stat: String,
    /// `df -k /System/Volumes/Data` (the user's data volume on APFS).
    pub df: String,
    /// `ps -A -o pid=,ppid=,%cpu=,rss=,comm=`.
    pub ps: String,
    /// This process, so the webview can tell Atlas's own share of the processor.
    pub self_pid: u32,
}

/// `system_profiler SPHardwareDataType -json` → `machine_name`. The profile
/// also carries the serial number and hardware UUID, so only the name leaves.
pub fn parse_machine_name(json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| {
            v.get("SPHardwareDataType")?
                .as_array()?
                .first()?
                .get("machine_name")?
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn machine_name() -> String {
    static CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((at, name)) = guard.as_ref() {
            if at.elapsed() < Duration::from_secs(HARDWARE_CACHE_SECS) && !name.is_empty() {
                return name.clone();
            }
        }
    }
    let name = parse_machine_name(&read("system_profiler", &["SPHardwareDataType", "-json"]));
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), name.clone()));
    }
    name
}

fn ps_table() -> String {
    read("ps", &["-A", "-o", "pid=,ppid=,%cpu=,rss=,comm="])
}

#[tauri::command(async)]
pub fn mac_read() -> Result<MacReadout, String> {
    let df = {
        let data = read("df", &["-k", "/System/Volumes/Data"]);
        if data.trim().is_empty() { read("df", &["-k", "/"]) } else { data }
    };
    Ok(MacReadout {
        cpu_brand: read("sysctl", &["-n", "machdep.cpu.brand_string"]),
        memsize: read("sysctl", &["-n", "hw.memsize"]),
        logical_cpus: read("sysctl", &["-n", "hw.logicalcpu"]),
        hw_model: read("sysctl", &["-n", "hw.model"]),
        boottime: read("sysctl", &["-n", "kern.boottime"]),
        pressure: read("sysctl", &["-n", "kern.memorystatus_vm_pressure_level"]),
        os_version: read("sw_vers", &["-productVersion"]),
        machine_name: machine_name(),
        vm_stat: read("vm_stat", &[]),
        df,
        ps: ps_table(),
        self_pid: std::process::id(),
    })
}

// --- Battery ---------------------------------------------------------------------

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct BatterySample {
    /// ISO-8601 UTC.
    pub at: String,
    pub percent: i64,
    pub charging: bool,
    pub on_power: bool,
}

#[derive(Serialize, Debug, Default)]
pub struct BatteryReadout {
    /// The capacity lines of `ioreg -r -c AppleSmartBattery`: cycle count,
    /// design and maximum capacity. "" on a Mac without a battery.
    pub ioreg: String,
    /// `sppower_battery_health_info` from `system_profiler SPPowerDataType
    /// -json` as JSON text: the condition and maximum capacity macOS reports.
    pub health: String,
    /// `pmset -g`: the live settings, including `lowpowermode`.
    pub pmset: String,
    /// `ps -A -o pid=,ppid=,%cpu=,rss=,comm=`, for what is using the processor.
    pub ps: String,
    pub self_pid: u32,
    /// The last 24 hours of samples, oldest first.
    pub history: Vec<BatterySample>,
}

/// The keys the battery health card reads. ioreg prints them at the top level
/// ("CycleCount" = 164) and, on recent macOS, inside the "BatteryData"
/// dictionary ("DesignCapacity"=6249), so a line is kept when it names one.
const BATTERY_KEYS: [&str; 6] = [
    "\"CycleCount\"",
    "\"DesignCapacity\"",
    "\"AppleRawMaxCapacity\"",
    "\"NominalChargeCapacity\"",
    "\"MaxCapacity\"",
    "\"DesignCycleCount9C\"",
];

/// The lines of the ioreg dump that carry a capacity key — and nothing else,
/// so no serial number crosses to the webview.
pub fn battery_capacity_lines(ioreg: &str) -> String {
    ioreg
        .lines()
        .filter(|l| !l.contains("Serial") && BATTERY_KEYS.iter().any(|k| l.contains(k)))
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
}

/// `system_profiler SPPowerDataType -json` → the battery's health object as
/// JSON text, or "" when there is none (a desktop Mac).
pub fn battery_health_json(json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| {
            v.get("SPPowerDataType")?
                .as_array()?
                .iter()
                .find_map(|entry| entry.get("sppower_battery_health_info").cloned())
        })
        .map(|h| h.to_string())
        .unwrap_or_default()
}

#[tauri::command(async)]
pub fn battery_read(state: State<'_, DbState>) -> Result<BatteryReadout, String> {
    let history = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT recorded_at, percent, charging, on_power FROM battery_history \
                 WHERE recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') \
                 ORDER BY recorded_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(BatterySample {
                    at: r.get(0)?,
                    percent: r.get(1)?,
                    charging: r.get::<_, i64>(2)? != 0,
                    on_power: r.get::<_, i64>(3)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect::<Vec<_>>()
    };
    Ok(BatteryReadout {
        ioreg: battery_capacity_lines(&read("ioreg", &["-r", "-c", "AppleSmartBattery"])),
        health: battery_health_json(&read("system_profiler", &["SPPowerDataType", "-json"])),
        pmset: read("pmset", &["-g"]),
        ps: ps_table(),
        self_pid: std::process::id(),
        history,
    })
}

/// One battery sample into `battery_history`, and anything older than two
/// days out of it — the screen draws 24 hours, so the table stays at about
/// three hundred rows. A Mac without a battery records nothing.
fn record_battery_sample(app: &AppHandle) {
    let Some(b) = crate::system_vitals::parse_pmset(&read("pmset", &["-g", "batt"])) else {
        return;
    };
    let Some(db) = app.try_state::<DbState>() else {
        return;
    };
    let Ok(conn) = db.conn.lock() else {
        return;
    };
    if let Err(e) = conn.execute(
        "INSERT INTO battery_history (recorded_at, percent, charging, on_power) \
         VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?1, ?2, ?3)",
        params![b.percent as i64, b.charging as i64, b.on_power as i64],
    ) {
        log::warn!("[battery] sample not recorded: {e}");
        return;
    }
    let _ = conn.execute(
        "DELETE FROM battery_history WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')",
        [],
    );
}

/// Samples the battery every ten minutes for as long as the app runs. Called
/// once, by the instance that owns the shared database's background work, so
/// two open apps do not record every sample twice.
pub fn start_battery_recorder(app: AppHandle) {
    std::thread::spawn(move || loop {
        record_battery_sample(&app);
        std::thread::sleep(Duration::from_secs(BATTERY_SAMPLE_SECS));
    });
}

// --- Screen lock -------------------------------------------------------------------

/// `ioreg -n Root -d1` lists the console sessions; the one on screen carries
/// `"CGSSessionScreenIsLocked"=Yes` while the screen is locked, and no such key
/// otherwise.
pub fn parse_screen_locked(ioreg: &str) -> bool {
    ioreg.contains("\"CGSSessionScreenIsLocked\"=Yes")
}

/// Whether the screen is locked right now. Read by the voice session's "mute
/// when the Mac is locked". The ioreg dump is ~100 KB, so only the answer
/// crosses to the webview.
#[tauri::command(async)]
pub fn screen_locked() -> Result<bool, String> {
    Ok(parse_screen_locked(&read("ioreg", &["-n", "Root", "-d1"])))
}

// --- Restart Atlas -----------------------------------------------------------------

/// Settings → Software Update's "Restart Atlas", and any other screen that
/// needs a fresh start (a provider switch). Other packages invoke it by name.
///
/// `request_restart`, not `restart`: `AppHandle::restart` called on the main
/// thread skips `RunEvent::Exit`, and that event is where lib.rs stops the
/// brain and the voice gateway and gives up the sidecar claim. Skipping it
/// would leave both sidecars running beside the relaunched app's new pair.
#[tauri::command(async)]
pub fn app_restart(app: AppHandle) {
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wifi_device_from_hardware_ports() {
        let out = "\nHardware Port: Ethernet\nDevice: en1\nEthernet Address: aa\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: bb\n";
        assert_eq!(parse_wifi_device(out).as_deref(), Some("en0"));
        assert_eq!(parse_wifi_device("Hardware Port: AirPort\nDevice: en2\n").as_deref(), Some("en2"));
        assert_eq!(parse_wifi_device("Hardware Port: Wi-Fi\nDevice: ; rm\n"), None);
        assert_eq!(parse_wifi_device("Hardware Port: Thunderbolt\nDevice: bridge0\n"), None);
    }

    #[test]
    fn ssid_and_password_rules() {
        assert!(validate_ssid("Fogware 5G").is_ok());
        assert!(validate_ssid("Café Ritual").is_ok());
        assert!(validate_ssid("").is_err());
        assert!(validate_ssid(&"x".repeat(33)).is_err());
        assert!(validate_ssid("bad\nname").is_err());
        assert!(validate_ssid("-setairportpower").is_err());
        assert!(validate_password("").is_ok());
        assert!(validate_password("correct horse battery").is_ok());
        assert!(validate_password(&"a".repeat(65)).is_err());
        assert!(validate_password("tab\there").is_err());
    }

    #[test]
    fn bluetooth_addresses() {
        assert!(validate_bt_address("a4-83-e7-12-34-56").is_ok());
        assert!(validate_bt_address("A4:83:E7:12:34:56").is_ok());
        assert!(validate_bt_address("AirPods Pro").is_err());
        assert!(validate_bt_address("a4-83-e7-12-34").is_err());
        assert!(validate_bt_address("--power 0 a4-8").is_err());
    }

    #[test]
    fn tool_failures_are_found_in_stdout() {
        assert_eq!(
            tool_failure("Failed to join network Home.\nError: -3900  The operation couldn’t be completed.\n").as_deref(),
            Some("Failed to join network Home.")
        );
        assert!(tool_failure("Could not find network Nowhere.\n").is_some());
        assert_eq!(
            tool_failure("Network Nowhere was not found in the preferred networks list\n").as_deref(),
            Some("Network Nowhere was not found in the preferred networks list")
        );
        assert_eq!(tool_failure("** Error: The parameters were not valid.\n").as_deref(), Some("Error: The parameters were not valid."));
        assert!(tool_failure("").is_none());
        assert!(tool_failure("Wi-Fi Power (en0): On\n").is_none());
    }

    #[test]
    fn secrets_are_scrubbed() {
        assert_eq!(scrub(" wrong key hunter22 \n", Some("hunter22")), "wrong key •••");
        assert_eq!(scrub("no secret here", Some("")), "no secret here");
        assert_eq!(scrub("left alone", None), "left alone");
    }

    #[test]
    fn machine_name_only() {
        let json = r#"{"SPHardwareDataType":[{"machine_name":"MacBook Pro","serial_number":"XXXX","chip_type":"Apple M5"}]}"#;
        assert_eq!(parse_machine_name(json), "MacBook Pro");
        assert_eq!(parse_machine_name("not json"), "");
    }

    #[test]
    fn battery_lines_and_health() {
        let ioreg = "  |   \"ExternalConnected\" = Yes\n  |   \"MaxCapacity\" = 100\n  |   \"CycleCount\" = 164\n  |   \"Serial\" = \"ABC\"\n  |   \"BatteryData\" = {\"AppleRawMaxCapacity\"=5926,\"DesignCapacity\"=6249}\n";
        let kept = battery_capacity_lines(ioreg);
        assert!(kept.contains("\"CycleCount\" = 164"));
        assert!(kept.contains("\"DesignCapacity\"=6249"));
        assert!(!kept.contains("Serial") && !kept.contains("ExternalConnected"));
        let power = r#"{"SPPowerDataType":[{"_name":"spbattery_information","sppower_battery_health_info":{"sppower_battery_cycle_count":164,"sppower_battery_health":"Good","sppower_battery_health_maximum_capacity":"100 %"}},{"_name":"sppower_information"}]}"#;
        let health = battery_health_json(power);
        assert!(health.contains("\"sppower_battery_health\":\"Good\""));
        assert_eq!(battery_health_json(r#"{"SPPowerDataType":[{"_name":"sppower_information"}]}"#), "");
    }

    #[test]
    fn screen_lock_from_console_users() {
        assert!(parse_screen_locked("\"IOConsoleUsers\" = ({\"kCGSSessionOnConsoleKey\"=Yes,\"CGSSessionScreenIsLocked\"=Yes})"));
        assert!(!parse_screen_locked("\"IOConsoleUsers\" = ({\"kCGSSessionOnConsoleKey\"=Yes})"));
    }
}
