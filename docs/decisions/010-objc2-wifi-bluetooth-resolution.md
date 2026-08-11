# ADR 010 — Wi-Fi and Bluetooth: what the objc2 crates can actually reach

**Status:** accepted (spike findings) · **Date:** 2026-08-11
**Depends on:** the lockfile discipline recorded at `src-tauri/Cargo.toml:85,108` (the
`vergen 9.0.6` / `vergen-gitcl 1.0.5` pin behind `librespot-core 0.8`).

## Verdict

Three separate questions, three different answers. Do not read one as the other.

| Question | Verdict |
| --- | --- |
| Can `objc2-core-wlan` + `objc2-core-bluetooth` be added without moving the lock? | **GO** — pure append, +5 packages, 0 removals, 0 version changes |
| Does `objc2-io-kit` expose the battery power-source APIs? | **GO** — fully bound, no `extern "C"` needed; verified by running it |
| Wi-Fi **state** (power/RSSI/rate/security)? | **GO** |
| Wi-Fi **SSID** (the network *name*)? | **GO WITH CAVEAT** — returns `nil` today; needs a Location Services grant Atlas has never asked for |
| Wi-Fi **switching** (`associateToNetwork`)? | **UNDETERMINED** — bound in the crate, deliberately not executed (see below) |
| Bluetooth **state** (on/off) via CoreBluetooth? | **GO WITH CAVEAT** — requires an Info.plist key Atlas does not have, and its absence is a **SIGABRT**, not a `nil` |
| Bluetooth **toggling** (turn the radio on/off)? | **NO-GO** — no public API exists, in any framework |
| Enumerating already-connected Bluetooth devices via CoreBluetooth? | **NO-GO** — the plan's claim is correct |
| `system_profiler SPBluetoothDataType -json` as the alternative? | **GO** — 60–110 ms, no TCC prompt, names devices usefully; one gap noted honestly below |

---

## 1. Lockfile resolution — GO

### Method

The question is *"does anything else move"*, not *"does it compile"*, so the test is a
lockfile diff, not a build. `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` were copied
into a scratch directory (no path deps, no parent workspace, so the copy resolves
identically). Baseline first — `cargo metadata --format-version 1 --offline` on the
untouched copy left `Cargo.lock` **byte-identical**, which is what makes the diffs below
mean something.

`cargo add --dry-run` names the versions:

```
      Adding objc2-core-wlan v0.3.2 to dependencies
      Adding objc2-core-bluetooth v0.3.2 to dependencies
      Adding objc2-pdf-kit v0.3.2 to dependencies
warning: aborting add due to dry run
```

### Result

Real add + resolve, then `diff Cargo.lock.orig Cargo.lock`:

```
package count: 784 -> 789
removed lines (<): 0    added lines (>): 64
```

**Zero removals. Zero version changes.** Every added line is either a new `[[package]]`
block or a new name inside an existing `dependencies = [...]` array. The five new packages:

| package | version | new transitive packages it drags in |
| --- | --- | --- |
| `objc2-core-wlan` | 0.3.2 | **`objc2-security` 0.3.2, `objc2-security-foundation` 0.3.2** |
| `objc2-core-bluetooth` | 0.3.2 | none — `dispatch2 0.3.1`, `bitflags 2.13.1`, `objc2-core-foundation 0.3.2`, `objc2-foundation 0.3.2` were all already locked |
| `objc2-pdf-kit` | 0.3.2 | none — `objc2-app-kit`, `objc2-core-graphics` already locked (see ADR 011) |

`objc2-core-wlan` is the only one that is not purely an edge. Two genuinely new packages,
both first-party `objc2` framework bindings at the same 0.3.2 as everything else in the
family. `objc2` itself stays **0.6.4** and nothing in the librespot/vergen subtree is
touched.

Excerpt of the real diff (the shape is representative of all 64 lines):

```diff
@@ -153,6 +153,9 @@
  "librespot-core",
  "librespot-playback",
  "log",
+ "objc2-core-bluetooth",
+ "objc2-core-wlan",
+ "objc2-pdf-kit",
   "rusqlite",
@@ -4001,6 +4017,20 @@
+[[package]]
+name = "objc2-core-wlan"
+version = "0.3.2"
+source = "registry+https://github.com/rust-lang/crates.io-index"
+checksum = "c71e34919aba0d701380d911702455038a8a3587467fe0141d6a71501e7ffe48"
+dependencies = [
+ "bitflags 2.13.1",
+ "objc2",
+ "objc2-core-foundation",
+ "objc2-foundation",
+ "objc2-security",
+ "objc2-security-foundation",
+]
```

They compile:

```
cargo check -p objc2-core-wlan -p objc2-core-bluetooth -p objc2-pdf-kit
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 9.12s
```

### One subtlety worth knowing before you promote a *transitive* crate

`objc2-io-kit 0.3.2` is already locked — but only because `sysinfo 0.36.1` (via
`librespot-core 0.8`) asked for a narrow slice of it. Promoting it to a direct dependency
adds **no package**, but it is not a no-op on the lockfile either, because default features
turn on more of the crate than `sysinfo` needed:

```diff
# cargo add objc2-io-kit objc2-core-foundation
155a156,157
>  "objc2-core-foundation",
>  "objc2-io-kit",
3953a3956
>  "block2"
3954a3958
>  "libc"
4036a4041,4043
>  "bitflags 2.13.1",
>  "block2",
>  "dispatch2",
4037a4045
>  "objc2",
```

Eight added lines, all inside existing `dependencies` arrays. No new `[[package]]`, no
version change, nothing removed. So the `Cargo.toml:85` claim ("adds an edge, not a
package") holds literally — but expect the lock to *change*, and read the diff rather
than expecting it to be empty.

---

## 2. `objc2-io-kit` power sources — GO, no raw binding needed

All the APIs are present and re-exported at the crate root
(`src/generated/ps.rs`, behind the **default** `ps` feature):

| symbol | line | shape |
| --- | --- | --- |
| `IOPSCopyPowerSourcesInfo` | ps.rs:418 | safe fn → `Option<CFRetained<CFType>>` |
| `IOPSCopyPowerSourcesList` | ps.rs:444 | `unsafe fn(Option<&CFType>) -> Option<CFRetained<CFArray>>` |
| `IOPSGetPowerSourceDescription` | ps.rs:479 | `unsafe fn(Option<&CFType>, Option<&CFType>) -> Option<CFRetained<CFDictionary>>` |
| `IOPSGetProvidingPowerSourceType` | ps.rs:509 | `unsafe fn(Option<&CFType>) -> Option<CFRetained<CFString>>` |
| `IOPSGetTimeRemainingEstimate` | ps.rs:397 | safe fn → `CFTimeInterval` |

Retain/release is already modelled — `IOPSCopyPowerSourcesInfo` wraps with
`CFRetained::from_raw` (owned), `IOPSGetPowerSourceDescription` with `CFRetained::retain`
(borrowed, matching Apple's "caller should NOT release"). A hand-written `extern "C"`
block would have to get that right by hand; the crate already did.

Proven by running it, not by reading it — a standalone binary against
`objc2-io-kit =0.3.2` + `objc2-core-foundation =0.3.2`:

```
rows=1
Name=InternalBattery-0  Type=InternalBattery  Power Source State=Battery Power
Current Capacity=Some(77)  Max Capacity=Some(100)  Is Charging=false
Time to Empty=Some(81)  BatteryHealth=Check Battery
```

**Ergonomic trap to record now.** The `kIOPS*Key` constants in this crate are `&CStr`,
not `CFString`:

```rust
pub const kIOPSCurrentCapacityKey: &CStr =
    unsafe { CStr::from_bytes_with_nul_unchecked(b"Current Capacity\0") };
```

`CFDictionary` lookup wants a `CFString`, so the constants are decorative — the working
code builds `CFString::from_str("Current Capacity")` itself. They are still worth reading:
they are the authoritative spelling of each key, including the non-obvious ones
(`"DesignCapacity"` has no space; `"Current Capacity"` does).

---

## 3. Bluetooth — the plan's claim is right, and the situation is worse than it says

### CoreBluetooth cannot enumerate the system's connected devices — CONFIRMED

The only enumeration entry point on `CBCentralManager` is
`retrieveConnectedPeripheralsWithServices:` (`CBCentralManager.rs:264`), and it takes a
**required** `&NSArray<CBUUID>`. Apple's own doc comment, verbatim from the crate:

> Retrieves all peripherals that are connected to the system and implement any of the
> services listed in *serviceUUIDs*.

No service UUIDs, no results — there is no "give me everything" overload. AirPods, a Magic
Mouse or a Magic Keyboard expose no GATT service Atlas has any business guessing, and
classic-Bluetooth profiles (HFP/A2DP/AVRCP) are outside CoreBluetooth's model entirely.
The plan's claim stands.

### Bluetooth *toggling* is NO-GO in every public framework

`CBManager` has `state()` (`CBManager.rs:109`) and `authorization()` — both getters.
Grepping the whole `objc2-core-bluetooth 0.3.2` source for `setState` / `setPower` /
`powerOn` returns nothing that is a power control. `objc2-io-bluetooth 0.3.2` (the classic
framework, also on crates.io at 0.3.2) has `IOBluetoothHostController.powerState`
documented as *"This will be 1 for on, or 0 for off"* — and there is **no `setPowerState`
anywhere in that crate either**. Turning the radio on or off is not a public capability on
macOS. Anything that claims to do it is either `blueutil` (not installed here) or a private
`IOBluetoothPreferenceSetControllerPowerState` call, neither of which belongs in a signed,
notarized consumer build. **Ship read-only Bluetooth state, or deep-link the user to
System Settings.**

### The finding nobody was looking for: touching Bluetooth SIGABRTs today

A probe that called `IOBluetoothHostController::defaultController()` from a worker thread
died with **exit 134**, printing nothing. The crash report says exactly why:

```
"termination" : {"namespace":"TCC","details":[
  "This app has crashed because it attempted to access privacy-sensitive data without a
   usage description. The app's Info.plist must contain an NSBluetoothAlwaysUsageDescription
   key with a string value explaining to the user how the app uses this data."]}

faulting frames:
  __TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__
  +[IOBluetoothCoreBluetoothCoordinator sharedInstance]
  +[IOBluetoothHostController defaultController]
```

`IOBluetoothCoreBluetoothCoordinator` is shared machinery, so this is not an IOBluetooth
quirk — it is what any Bluetooth framework access does. `src-tauri/Info.plist` currently
contains **only** `NSMicrophoneUsageDescription`. So the first Bluetooth call in a shipped
build would not return `nil` or an error; it would **abort the whole app**. If Phase 2
links CoreBluetooth at all, adding `NSBluetoothAlwaysUsageDescription` to
`src-tauri/Info.plist` is not a polish item, it is the difference between a feature and a
crash-on-launch-path.

### The alternative: `system_profiler SPBluetoothDataType -json` — GO

Exit 0, **no TCC prompt, no crash**, and fast enough to poll on a human-visible cadence:

```
$ /usr/sbin/system_profiler SPBluetoothDataType -json
real 0.06 / 0.10 / 0.11   (three runs)
```

60–110 ms. That is fine for a widget refresh or an on-demand model call; it is still a
process spawn, so do not put it on a 1 Hz timer.

Shape (redacted; names abbreviated, addresses removed):

```json
{"SPBluetoothDataType": [{
  "controller_properties": {
    "controller_state": "attrib_on",
    "controller_chipset": "BCM_4388C2",
    "controller_discoverable": "attrib_off",
    "controller_transport": "PCIe",
    "controller_supportedServices": "0x392039 < HFP AVRCP A2DP HID Braille LEA AACP GATT SerialPort >",
    "controller_address": "<redacted>"
  },
  "device_not_connected": [
    { "D… – AirPods Pro - Find My": {
        "device_minorType": "Headphones", "device_vendorID": "0x004C",
        "device_productID": "0x200E", "device_firmwareVersion": "4E71",
        "device_address": "<redacted>", "device_serialNumber": "<redacted>" } },
    { "hygge mygge": {
        "device_minorType": "Speaker", "device_vendorID": "0x0057",
        "device_productID": "0x0024" } }
  ]
}]}
```

Two things this buys that CoreBluetooth cannot: **`controller_state`** gives radio on/off
with no entitlement, and every device carries a **human-readable name** plus a
`device_minorType` (`Headphones`, `Speaker`, …) good enough to render an icon.

Connected/not-connected is expressed as a **key name**, not a per-device field —
`device_connected` vs `device_not_connected` (the plain-text mode prints the same split as
`Connected:` / `Not Connected:` headers). So the distinction is structural and
unambiguous.

**Honest gap:** during this spike **nothing was connected** on this machine, so the output
contained only `device_not_connected` (12 entries) and I never observed a `device_connected`
array first-hand. The plain-text renderer's `Not Connected:` header and Apple's own
grouping make `device_connected` overwhelmingly likely to be the counterpart key, but the
parser must not *assume* it: read whichever of the two keys is present, treat a missing key
as an empty list, and verify the connected branch against a real connected device before
shipping. A parser that hard-requires `device_connected` will break on exactly the state
this machine was in.

---

## 4. Wi-Fi — state is free, the SSID is not

`objc2-core-wlan 0.3.2` binds everything Phase 2 asked for:

| capability | symbol |
| --- | --- |
| client / interface | `CWWiFiClient::sharedWiFiClient`, `.interface()`, `.interfaceNames()` |
| power state | `CWInterface::powerOn()` |
| power **set** | `CWInterface::setPower_error(bool)` |
| link quality | `.rssiValue()`, `.noiseMeasurement()`, `.transmitRate()`, `.security()` |
| identity | `.ssid()`, `.bssid()` |
| scan | `.scanForNetworksWithSSID_includeHidden_error(…)` |
| **switch** | `.associateToNetwork_password_error(…)` |

Runtime probe (unsigned CLI binary, `objc2-core-wlan =0.3.2`), while genuinely associated
to a network:

```
interfaceNames = Some(["en0"])
interfaceName  = Some("en0")
powerOn        = true
ssid           = None      <-- !!
bssid          = None      <-- !!
rssiValue      = -65
noise          = -95
txRate         = 260
security      = 4
activePHYMode  = 5
```

RSSI of −65 and a 260 Mbit rate prove the machine *is* associated. `ssid()` and `bssid()`
still come back `None`. Apple's own tool agrees and gives the same misleading answer:

```
$ /usr/sbin/networksetup -getairportnetwork en0
You are not associated with an AirPort network.
```

This is the macOS 14+ behaviour: the Wi-Fi network name is treated as location data and is
redacted from any process without a CoreLocation authorization.
`src-tauri/Info.plist` has no `NSLocationWhenInUseUsageDescription`, so Atlas cannot even
ask. **I did not prove the causal link by granting the authorization** — that needs a
signed bundle with the plist key, which this spike could not produce. What is proven is
that the SSID is withheld from an unentitled process while everything else is served.

There is a shell-out that is *not* redacted, and it is instant:

```
$ /usr/sbin/ipconfig getsummary en0 | grep -E '^ *S?SSID'
  BSSID : <value>
  SSID  : <value>
real 0.00
```

Same precedent as `src-tauri/src/health/zip.rs`: a first-party binary that already ships,
in place of a dependency and an entitlement negotiation.

**`associateToNetwork_password_error` was deliberately not executed.** Calling it means
dropping the user's live Wi-Fi association mid-session, and a failed re-associate leaves the
machine offline. So switching is **UNDETERMINED**: the binding exists and compiles, but
whether it succeeds from an unsigned/hardened-runtime/sandboxed Atlas — and whether it too
needs the location grant — is untested. Do not plan a "switch network" feature on the
assumption that it works.

---

## Decision

1. **Add `objc2-core-wlan` and `objc2-core-bluetooth` at `0.3.2`** when Phase 2 needs them.
   Resolution is proven clean. Follow the `Cargo.toml:85,108` convention: comment *why*,
   and note that `objc2-core-wlan` is the one that adds two real packages
   (`objc2-security`, `objc2-security-foundation`), not just edges.
2. **Battery: use `objc2-io-kit`'s `ps` module.** Promote it to a direct dependency; no raw
   `extern "C"` block. Build `CFString`s for the keys — the `kIOPS*Key` constants are
   `&CStr` and cannot be handed to `CFDictionary` directly.
3. **Bluetooth: read state from `system_profiler SPBluetoothDataType -json`**, not from
   CoreBluetooth. It is the only thing that both enumerates real devices with names and
   costs no entitlement. Parse whichever of `device_connected` / `device_not_connected` is
   present; never require both.
4. **If any CoreBluetooth/IOBluetooth symbol is ever linked and called, add
   `NSBluetoothAlwaysUsageDescription` to `src-tauri/Info.plist` in the same commit.**
   Missing it is a `SIGABRT`, not a degraded result.
5. **Ship Bluetooth as read-only.** There is no public toggle. Offer a deep link to
   System Settings instead of a switch that cannot work.
6. **Wi-Fi: ship state now, SSID behind a decision, switching not at all yet.**
   `powerOn`/RSSI/rate/security need nothing. The SSID needs either
   `ipconfig getsummary en0` (works today, zero cost) or a Location Services grant with a
   new Info.plist key and a user prompt — a product decision, not an implementation detail.
   Treat `associateToNetwork` as unproven until someone tests it on a machine whose Wi-Fi
   they are willing to drop.

## Where this is recorded

- `src-tauri/Cargo.toml:85,108` — the existing "adds an edge, not a package" convention
  these findings extend.
- `docs/decisions/011-document-text-extraction.md` — the `objc2-pdf-kit` half of the same
  lockfile experiment; the +5-package diff above includes it.
- `src-tauri/Info.plist` — the two keys named here (`NSBluetoothAlwaysUsageDescription`,
  `NSLocationWhenInUseUsageDescription`) are both absent as of this ADR.

## Not determined

Stated plainly so nobody reads confidence into silence:

- **`associateToNetwork_password_error` was never called.** Untested against sandbox,
  hardened runtime, or the location grant.
- **The SSID redaction was not proven to be CoreLocation.** Observed: the SSID is withheld
  from an unentitled process. Not observed: it appearing after a grant.
- **No `device_connected` array was ever seen**, because nothing was connected on this
  machine during the spike.
- **`setPower_error` (Wi-Fi radio off) was not called** — same reason as `associateToNetwork`.
- Everything here was measured on **macOS 26.3 (build 25D125), Apple silicon, cargo 1.93.1 /
  rustc 1.93.1**, from **unsigned CLI binaries**, not from a signed Atlas.app bundle.
