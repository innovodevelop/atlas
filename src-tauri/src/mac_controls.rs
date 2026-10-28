// Settings → This Mac: Wi-Fi, Bluetooth, the Mac's own details, battery
// health and history, whether the screen is locked (and a push when that
// changes), how long the Mac has been idle, and Restart Atlas.
//
// system_vitals.rs answers the top bar's three quick questions every thirty
// seconds. This module is what the Settings sections and the status panels
// ask when someone is looking at them, and the few switches they carry.
//
// THE SPLIT. The READ commands here run a fixed list of macOS tools and hand
// their text back unparsed; the parsing lives in src/lib/macProbes.ts, where
// it is unit-tested on real tool output with `bun test`. Three exceptions trim
// in Rust before anything crosses to the webview, because the raw output
// carries identifiers the screens never show: the hardware profile (serial
// number, hardware UUID) is cut down to the model's name, the Bluetooth
// profile (every AirPods' serial numbers and firmware) to each device's name,
// address, kind and battery, and the battery's ioreg dump (serial numbers,
// 16 KB of it) to the capacity numbers. The WRITE
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
// NO DISCONNECT. `networksetup` can join and forget but not leave a network.
// CoreWLAN's public `disassociate` does leave it, without an administrator —
// and macOS rejoins the same known network about a second later (seen on
// macOS 27.2: a new connection id and a fresh DHCP lease, same address). The
// Wi-Fi menu's own Disconnect holds because it also pauses auto-join, through
// private API. A Disconnect here would be a reconnect, so there is none; the
// lasting ways to leave a network, Forget and turning Wi-Fi off, are here.
// Per-network auto-join and "ask to join" have no tool either — CoreWLAN
// commits those only with an administrator's authorization — so they stay out.
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
//
// TIME LIMITS. Every tool runs against a deadline and is killed when it
// passes (`run_limited`). `system_profiler` is known to hang when a daemon
// behind it is wedged (bluetoothd, most often), and the screens ask again
// every few seconds; without a limit each ask would leave another stuck
// process behind for as long as the section stayed open.
use crate::db::DbState;
use rusqlite::params;
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// The interface macOS gives Wi-Fi on every Mac Atlas supports; used only when
/// `networksetup -listallhardwareports` does not name one.
const WIFI_FALLBACK_DEVICE: &str = "en0";

/// How often the battery history takes a sample.
const BATTERY_SAMPLE_SECS: u64 = 600;

/// The model's name never changes while Atlas runs, and `system_profiler`
/// takes a few hundred milliseconds, so it is read once an hour at most.
const HARDWARE_CACHE_SECS: u64 = 3600;

// --- Running tools ---------------------------------------------------------------

/// How long a quick read (sysctl, ipconfig, pmset, ioreg…) may take.
const READ_LIMIT: Duration = Duration::from_secs(5);
/// How long `system_profiler` may take: one to five seconds is normal.
const PROFILER_LIMIT: Duration = Duration::from_secs(15);
/// How long a switch may take: joining a network can take ten seconds or more.
const ACT_LIMIT: Duration = Duration::from_secs(30);

/// What a tool printed, and whether it exited successfully.
pub(crate) struct Ran {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// A pipe read to its end on a thread of its own, so a tool that fills one
/// pipe while nothing reads it cannot stall, and the caller can stop waiting.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    rx
}

/// Run a tool and kill it if it has not finished within `limit`. The error
/// names the tool, never its arguments (one of them can be a password).
pub(crate) fn run_limited(cmd: &str, args: &[&str], limit: Duration) -> Result<Ran, String> {
    let started = Instant::now();
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{cmd} could not run: {e}"))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    // Stdout closes when the tool exits, so this is the wait.
    let out = stdout.recv_timeout(limit).ok();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(5)),
            _ => break None,
        }
    };
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("{cmd} did not finish within {} seconds.", limit.as_secs()));
    };
    // A helper the tool started can hold its pipes open after it exits; what
    // the tool printed itself is in by now, so a moment is enough.
    let grace = Duration::from_millis(200);
    Ok(Ran {
        ok: status.success(),
        stdout: out.or_else(|| stdout.recv_timeout(grace).ok()).unwrap_or_default(),
        stderr: stderr.recv_timeout(grace).unwrap_or_default(),
    })
}

/// Stdout of a tool, or "" when it is missing, fails or runs out of time. For
/// reads, where an empty answer is parsed as "unknown". system_vitals.rs
/// reads through this too.
pub(crate) fn read(cmd: &str, args: &[&str]) -> String {
    let limit = if cmd == "system_profiler" { PROFILER_LIMIT } else { READ_LIMIT };
    match run_limited(cmd, args, limit) {
        Ok(ran) if ran.ok => ran.stdout,
        Ok(_) => String::new(),
        Err(e) => {
            log::warn!("[mac] {e}");
            String::new()
        }
    }
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
    let Ran { ok, stdout, stderr } = run_limited(cmd, args, ACT_LIMIT)?;
    if !ok {
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
/// macOS can be set to want an administrator for this ("Require
/// administrator authorization" in Wi-Fi's advanced settings), in which case
/// the tool's own refusal comes back with where to do it instead.
#[tauri::command(async)]
pub fn wifi_forget(ssid: String) -> Result<(), String> {
    validate_ssid(&ssid)?;
    let device = wifi_device();
    act("networksetup", &["-removepreferredwirelessnetwork", &device, &ssid], None)
        .map(|_| ())
        .map_err(|e| format!("{e} System Settings → Wi-Fi can forget it with an administrator's password."))
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
    /// `system_profiler SPBluetoothDataType -json`, trimmed by
    /// `bluetooth_trim`: power, connected and paired-but-not-connected
    /// devices, with addresses.
    pub profiler: String,
    /// `blueutil --power`: "1" or "0".
    pub power: Option<String>,
}

/// The device fields the Bluetooth section draws. Everything else the profile
/// prints — serial numbers of each AirPod and its case, firmware, vendor and
/// product ids — stays in Rust.
const BT_DEVICE_KEYS: [&str; 7] = [
    "device_address",
    "device_minorType",
    "device_batteryLevelMain",
    "device_batteryLevel",
    "device_batteryLevelLeft",
    "device_batteryLevelRight",
    "device_batteryLevelCase",
];

/// `system_profiler SPBluetoothDataType -json`, cut down to the controller's
/// state and, per device, the BT_DEVICE_KEYS — in the same shape, so the
/// webview's parser reads it as it would the whole profile. "" when the
/// profile could not be read.
pub fn bluetooth_trim(json: &str) -> String {
    use serde_json::{json, Map, Value};
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return String::new();
    };
    let Some(entry) = v.get("SPBluetoothDataType").and_then(Value::as_array).and_then(|a| a.first()) else {
        return String::new();
    };
    let mut out = Map::new();
    if let Some(state) = entry.get("controller_properties").and_then(|c| c.get("controller_state")) {
        out.insert("controller_properties".into(), json!({ "controller_state": state }));
    }
    for list in ["device_connected", "device_not_connected"] {
        let Some(items) = entry.get(list).and_then(Value::as_array) else {
            continue;
        };
        let trimmed: Vec<Value> = items
            .iter()
            .filter_map(Value::as_object)
            .map(|devices| {
                let mut named = Map::new();
                for (name, props) in devices {
                    let kept: Map<String, Value> = BT_DEVICE_KEYS
                        .iter()
                        .filter_map(|k| props.get(*k).map(|val| ((*k).to_string(), val.clone())))
                        .collect();
                    named.insert(name.clone(), Value::Object(kept));
                }
                Value::Object(named)
            })
            .collect();
        out.insert(list.into(), Value::Array(trimmed));
    }
    json!({ "SPBluetoothDataType": [Value::Object(out)] }).to_string()
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
            bluetooth_trim(&read("system_profiler", &["SPBluetoothDataType", "-json"]))
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

/// After a switch, the top bar's Bluetooth answer (cached thirty seconds in
/// system_vitals.rs) is stale; dropping it makes the next poll read again.
#[tauri::command(async)]
pub fn bluetooth_set_power(on: bool) -> Result<(), String> {
    let tool = require_blueutil()?;
    act(tool, &["--power", if on { "1" } else { "0" }], None)?;
    crate::system_vitals::forget_bluetooth();
    Ok(())
}

/// Connect or disconnect a paired device, by address.
#[tauri::command(async)]
pub fn bluetooth_device(address: String, connect: bool) -> Result<(), String> {
    validate_bt_address(&address)?;
    let tool = require_blueutil()?;
    let flag = if connect { "--connect" } else { "--disconnect" };
    act(tool, &[flag, &address], None)?;
    crate::system_vitals::forget_bluetooth();
    Ok(())
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

/// The numbers the battery health card reads. ioreg prints them at the top
/// level ("CycleCount" = 164) and, on recent macOS, inside the one-line
/// "BatteryData" dictionary ("DesignCapacity"=6249), which also holds other
/// identifiers — so the numbers are picked out, never whole lines.
const BATTERY_KEYS: [&str; 6] = [
    "CycleCount",
    "DesignCapacity",
    "AppleRawMaxCapacity",
    "NominalChargeCapacity",
    "MaxCapacity",
    "DesignCycleCount9C",
];

/// One `"Key" = N` line per capacity number the dump has (the first of each),
/// and nothing else, so no serial number crosses to the webview. The quotes
/// keep `"MaxCapacity"` from matching inside `"AppleRawMaxCapacity"`.
pub fn battery_capacity_lines(ioreg: &str) -> String {
    BATTERY_KEYS
        .iter()
        .filter_map(|key| {
            let quoted = format!("\"{key}\"");
            ioreg.match_indices(quoted.as_str()).find_map(|(at, _)| {
                let rest = ioreg[at + quoted.len()..].trim_start().strip_prefix('=')?.trim_start();
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                (!digits.is_empty()).then(|| format!("\"{key}\" = {digits}"))
            })
        })
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

// --- Idle time -----------------------------------------------------------------------

/// `ioreg -c IOHIDSystem` prints `"HIDIdleTime" = <nanoseconds>`: the time
/// since the last keyboard, mouse or trackpad input to this Mac, in any app.
/// Whole seconds, or None when the line is missing.
pub fn parse_hid_idle_secs(ioreg: &str) -> Option<u64> {
    const KEY: &str = "\"HIDIdleTime\"";
    let at = ioreg.find(KEY)?;
    let rest = ioreg[at + KEY.len()..].trim_start().strip_prefix('=')?.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<u64>().ok().map(|ns| ns / 1_000_000_000)
}

/// How long nobody has touched this Mac — in any app, not only Atlas. The
/// overnight update asks before it installs and restarts
/// (src/hooks/useAppUpdater.ts). None when it cannot be read, which never
/// counts as idle there. `-k` keeps the dump to the one property (~4 KB).
#[tauri::command(async)]
pub fn system_idle_secs() -> Option<u64> {
    parse_hid_idle_secs(&read("ioreg", &["-c", "IOHIDSystem", "-r", "-d", "1", "-k", "HIDIdleTime"]))
}

// --- Screen lock -------------------------------------------------------------------

/// Sent to every window with `true` the moment the screen locks and `false`
/// the moment it unlocks. The voice session's "Mute when the Mac is locked"
/// gates the microphone on it (src/hooks/useVoiceSession.ts).
pub const SCREEN_LOCK_EVENT: &str = "mac:screen-lock";

/// The lock state as last seen, so an event goes out only on a change.
static SCREEN_LOCKED: AtomicBool = AtomicBool::new(false);
/// The notifications are observed, so SCREEN_LOCKED is current.
static LOCK_OBSERVED: AtomicBool = AtomicBool::new(false);
/// Where the event goes; set once, by `start_lock_watcher`.
static LOCK_APP: OnceLock<AppHandle> = OnceLock::new();

// Only the macOS notification callbacks call this.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn set_screen_locked(locked: bool) {
    if SCREEN_LOCKED.swap(locked, Ordering::SeqCst) == locked {
        return;
    }
    if let Some(app) = LOCK_APP.get() {
        let _ = app.emit(SCREEN_LOCK_EVENT, locked);
    }
}

/// `ioreg -n Root -d1` lists the console sessions; the one on screen carries
/// `"CGSSessionScreenIsLocked"=Yes` while the screen is locked, and no such key
/// otherwise.
pub fn parse_screen_locked(ioreg: &str) -> bool {
    ioreg.contains("\"CGSSessionScreenIsLocked\"=Yes")
}

/// Whether the screen is locked right now: the window server's session
/// dictionary (a call, not a process), or the same key in ioreg's dump of the
/// console sessions when there is no dictionary to ask.
fn read_screen_locked() -> bool {
    #[cfg(target_os = "macos")]
    if let Some(locked) = lock_watch::session_locked() {
        return locked;
    }
    parse_screen_locked(&read("ioreg", &["-n", "Root", "-d1"]))
}

/// Start pushing SCREEN_LOCK_EVENT. Called once, in setup, in every instance:
/// each app's own windows run a voice session.
pub fn start_lock_watcher(app: AppHandle) {
    if LOCK_APP.set(app).is_err() {
        return;
    }
    SCREEN_LOCKED.store(read_screen_locked(), Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    LOCK_OBSERVED.store(lock_watch::observe(), Ordering::SeqCst);
}

/// Whether the screen is locked right now. The voice session asks once when it
/// sets up the gate, for the state before the first SCREEN_LOCK_EVENT; only
/// the answer crosses to the webview. While the notifications are observed
/// this is the state they keep, so it can never disagree with an event that
/// has gone out; a fresh read otherwise.
#[tauri::command(async)]
pub fn screen_locked() -> Result<bool, String> {
    if LOCK_OBSERVED.load(Ordering::SeqCst) {
        return Ok(SCREEN_LOCKED.load(Ordering::SeqCst));
    }
    Ok(read_screen_locked())
}

/// macOS's own lock and unlock notifications, observed through CoreFoundation's
/// C API: no Objective-C, no new crate. loginwindow posts
/// `com.apple.screenIsLocked` and `com.apple.screenIsUnlocked` on the
/// distributed notification center; CoreFoundation delivers them on the main
/// thread's run loop — which Tauri's event loop runs — whichever thread
/// registered (checked on this Mac with a test notification). Delivery is
/// immediate on purpose: AppKit holds distributed notifications back from an
/// app that is not frontmost, and a screen locks exactly when Atlas is not.
#[cfg(target_os = "macos")]
mod lock_watch {
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr::null;

    type CFStringRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type Callback = extern "C" fn(*mut c_void, *const c_void, CFStringRef, *const c_void, CFDictionaryRef);

    /// kCFStringEncodingUTF8.
    const UTF8: u32 = 0x0800_0100;
    /// CFNotificationSuspensionBehaviorDeliverImmediately.
    const DELIVER_IMMEDIATELY: isize = 4;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFNotificationCenterGetDistributedCenter() -> *mut c_void;
        fn CFNotificationCenterAddObserver(
            center: *mut c_void,
            observer: *const c_void,
            callback: Callback,
            name: CFStringRef,
            object: *const c_void,
            suspension: isize,
        );
        fn CFStringCreateWithCString(alloc: *const c_void, s: *const c_char, encoding: u32) -> CFStringRef;
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
        fn CFGetTypeID(value: *const c_void) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(value: *const c_void) -> u8;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    }

    /// Identifies this module's registrations to the center; never dereferenced.
    static OBSERVER: u8 = 0;

    fn cf_string(s: &CStr) -> CFStringRef {
        // SAFETY: `s` is a valid NUL-terminated string; a null result is checked by every caller.
        unsafe { CFStringCreateWithCString(null(), s.as_ptr(), UTF8) }
    }

    extern "C" fn on_locked(_: *mut c_void, _: *const c_void, _: CFStringRef, _: *const c_void, _: CFDictionaryRef) {
        super::set_screen_locked(true);
    }

    extern "C" fn on_unlocked(_: *mut c_void, _: *const c_void, _: CFStringRef, _: *const c_void, _: CFDictionaryRef) {
        super::set_screen_locked(false);
    }

    /// Start observing both notifications. False when they could not be
    /// registered, and the lock is then read each time it is asked for.
    pub fn observe() -> bool {
        // SAFETY: plain CoreFoundation calls with valid arguments. The names
        // are kept for the life of the process, as the observations are.
        unsafe {
            let center = CFNotificationCenterGetDistributedCenter();
            if center.is_null() {
                log::warn!("[mac] no distributed notification center: the lock is read only when asked");
                return false;
            }
            let observer = &OBSERVER as *const u8 as *const c_void;
            let names = [
                (cf_string(c"com.apple.screenIsLocked"), on_locked as Callback),
                (cf_string(c"com.apple.screenIsUnlocked"), on_unlocked as Callback),
            ];
            if names.iter().any(|(name, _)| name.is_null()) {
                return false;
            }
            for (name, callback) in names {
                CFNotificationCenterAddObserver(center, observer, callback, name, null(), DELIVER_IMMEDIATELY);
            }
            true
        }
    }

    /// `CGSSessionScreenIsLocked` in the session dictionary: present (and true)
    /// while the screen is locked, absent otherwise. None outside a login
    /// session, where there is no dictionary.
    pub fn session_locked() -> Option<bool> {
        // SAFETY: the dictionary and key are checked for null, the value is
        // only read as a boolean once its type says it is one, and both
        // created objects are released exactly once.
        unsafe {
            let dict = CGSessionCopyCurrentDictionary();
            if dict.is_null() {
                return None;
            }
            let key = cf_string(c"CGSSessionScreenIsLocked");
            let value = if key.is_null() { null() } else { CFDictionaryGetValue(dict, key) };
            let locked = !value.is_null() && (CFGetTypeID(value) != CFBooleanGetTypeID() || CFBooleanGetValue(value) != 0);
            if !key.is_null() {
                CFRelease(key);
            }
            CFRelease(dict);
            Some(locked)
        }
    }
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
        assert!(kept.contains("\"DesignCapacity\" = 6249"));
        assert!(kept.contains("\"AppleRawMaxCapacity\" = 5926"));
        assert!(kept.contains("\"MaxCapacity\" = 100"));
        assert!(!kept.contains("Serial") && !kept.contains("ExternalConnected") && !kept.contains("ABC"));
        // A serial inside BatteryData no longer costs the line its numbers.
        let nested = "  |   \"BatteryData\" = {\"Serial\"=\"F5D1\",\"DesignCapacity\"=4382}\n";
        assert_eq!(battery_capacity_lines(nested), "\"DesignCapacity\" = 4382");
        let power = r#"{"SPPowerDataType":[{"_name":"spbattery_information","sppower_battery_health_info":{"sppower_battery_cycle_count":164,"sppower_battery_health":"Good","sppower_battery_health_maximum_capacity":"100 %"}},{"_name":"sppower_information"}]}"#;
        let health = battery_health_json(power);
        assert!(health.contains("\"sppower_battery_health\":\"Good\""));
        assert_eq!(battery_health_json(r#"{"SPPowerDataType":[{"_name":"sppower_information"}]}"#), "");
    }

    #[test]
    fn bluetooth_profile_keeps_only_what_the_screen_draws() {
        let json = r#"{"SPBluetoothDataType":[{"controller_properties":{"controller_state":"attrib_on","controller_address":"AA:BB:CC:00:11:22"},
            "device_connected":[{"Magic Trackpad":{"device_address":"F0:B3:EC:01:02:03","device_minorType":"Trackpad","device_batteryLevelMain":"64%","device_serialNumber":"XYZ"}}],
            "device_not_connected":[{"AirPods Pro":{"device_address":"A4:83:E7:12:34:56","device_minorType":"Headphones","device_serialNumberLeft":"H6PF","device_firmwareVersion":"4E71"}}]}]}"#;
        let trimmed = bluetooth_trim(json);
        assert!(trimmed.contains("\"controller_state\":\"attrib_on\""));
        assert!(trimmed.contains("\"device_batteryLevelMain\":\"64%\""));
        assert!(trimmed.contains("\"A4:83:E7:12:34:56\"") && trimmed.contains("\"Headphones\""));
        assert!(!trimmed.contains("serial") && !trimmed.contains("XYZ") && !trimmed.contains("4E71"));
        assert!(!trimmed.contains("controller_address"));
        assert_eq!(bluetooth_trim(""), "");
    }

    #[test]
    fn tools_run_against_a_deadline() {
        let ran = run_limited("sh", &["-c", "echo out; echo err >&2; exit 3"], Duration::from_secs(5)).unwrap();
        assert!(!ran.ok);
        assert_eq!(ran.stdout.trim(), "out");
        assert_eq!(ran.stderr.trim(), "err");
        assert_eq!(read("echo", &["hello"]).trim(), "hello");
        // A tool that hangs is killed at the limit rather than waited on.
        let started = Instant::now();
        let hung = run_limited("sleep", &["30"], Duration::from_millis(300));
        assert!(hung.is_err_and(|e| e.starts_with("sleep did not finish")));
        assert!(started.elapsed() < Duration::from_secs(3));
        // The error names the tool, never its arguments.
        assert!(run_limited("no-such-tool-here", &["hunter22"], READ_LIMIT).is_err_and(|e| !e.contains("hunter22")));
    }

    #[test]
    fn idle_time_from_hid_system() {
        let ioreg = "+-o IOHIDSystem  <class IOHIDSystem>\n    {\n      \"HIDIdleTime\" = 42808797208\n    }\n";
        assert_eq!(parse_hid_idle_secs(ioreg), Some(42));
        assert_eq!(parse_hid_idle_secs("\"HIDIdleTime\" = 999999999"), Some(0));
        assert_eq!(parse_hid_idle_secs(""), None);
        assert_eq!(parse_hid_idle_secs("\"HIDIdleTime\" = <>"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn session_lock_read() {
        // Tests run at an unlocked screen, or outside a login session.
        assert_ne!(lock_watch::session_locked(), Some(true));
    }

    #[test]
    fn screen_lock_from_console_users() {
        assert!(parse_screen_locked("\"IOConsoleUsers\" = ({\"kCGSSessionOnConsoleKey\"=Yes,\"CGSSessionScreenIsLocked\"=Yes})"));
        assert!(!parse_screen_locked("\"IOConsoleUsers\" = ({\"kCGSSessionOnConsoleKey\"=Yes})"));
    }
}
