# ADR 014 — Capturing a sandbox window for the Lighthouse Test Lab

**Status:** accepted (spike findings) · **Date:** 2026-08-11 · **Verdict:** **GO, with one architecture correction**
**Gates:** stage L0 of `docs/audit/2026-08-11-test-lab-plan.md` — the Test Lab cannot exist without this.
**Method:** the lockfile discipline established in [ADR 010](010-objc2-wifi-bluetooth-resolution.md).

## Verdict

| Question | Answer |
|---|---|
| Do the capture crates resolve without moving the pinned graph? | **GO** — pure append |
| Does `objc2-screen-capture-kit` bind what a single-window capture needs? | **GO** — complete |
| Can "not granted" be detected without crashing or prompting? | **GO** — `CGPreflightScreenCaptureAccess` |
| Should live frames go over the Tauri event channel? | **NO — correct the plan.** Use a loopback HTTP stream. |

## Evidence

### 1. Lockfile — pure append, 784 → 792

Harness validated first: `cargo metadata` on an untouched copy left `Cargo.lock`
byte-identical (`md5 ccae0db4…` before and after), so any later delta is
attributable to the add and not to the tool.

Adding `objc2-screen-capture-kit` + `objc2-av-foundation` (both **0.3.2**,
matching every other `objc2-*` in the graph):

```
packages:          784 -> 792
names added:       8      names removed: 0
version-changed:   0      removed: 0
vergen:            9.0.6 -> 9.0.6        (pin intact)
vergen-gitcl:      1.0.5 -> 1.0.5        (pin intact)
objc2:             0.6.4 -> 0.6.4        (unchanged)
```

The 8 new packages: `objc2-screen-capture-kit`, `objc2-av-foundation`,
`objc2-avf-audio`, `objc2-core-media`, `objc2-core-video`, `objc2-image-io`,
`objc2-media-toolbox`, `objc2-uniform-type-identifiers`.

Note this is **8 new packages, not an edge on an existing one** — a larger
addition than ADR 010's Wi-Fi/Bluetooth crates. It is still safe by the rule
that matters (nothing existing moved), but it is not free, and AV Foundation is
only needed for the `.mp4` muxing in stage L8. **Add
`objc2-screen-capture-kit` alone for L1–L4** (4 of the 8 packages) and defer
`objc2-av-foundation` until muxing is actually built.

### 2. API reach — complete, no shim needed

Read from the crate source in the registry cache
(`objc2-screen-capture-kit-0.3.2/src/generated/`):

| Type | Present |
|---|---|
| `SCShareableContent` (enumerate windows) | 41 refs |
| `SCContentFilter` | 19 refs |
| `SCStream` | 63 refs |
| `SCStreamConfiguration` | 16 refs |
| `SCStreamOutput` / `SCStreamDelegate` | 11 / 5 refs |
| `SCWindow` | 25 refs |

The three things a per-window stream specifically needs all exist:

- **filter to ONE window** — `initWithDesktopIndependentWindow:`
  (`SCStream.rs:246`), which is exactly the sandbox-window case;
- **resolution + frame rate** — `setWidth` / `setHeight` (`SCStream.rs:391,401`)
  and `setMinimumFrameInterval(CMTime)` (`SCStream.rs:413`), so the ~10–15 fps
  live rate is a configuration value, not something we throttle by hand;
- **sample delivery** — `SCStreamOutputTypeScreen` hands back a `CMSampleBuffer`
  backed by an `IOSurface`, on a queue we provide.

No raw `extern "C"` and no Objective-C shim.

### 3. Permission — preflightable, and it does NOT crash

This was the trap in ADR 010: touching a Bluetooth framework without
`NSBluetoothAlwaysUsageDescription` **SIGABRTs**. Screen capture does not behave
that way.

```
CGPreflightScreenCaptureAccess = 1   (1 = granted, 0 = not granted)
windows=26  with-names=24
```

`CGPreflightScreenCaptureAccess` answers **without prompting and without
crashing**, and `CGRequestScreenCaptureAccess` triggers the system prompt
deliberately. So the design brief's "not granted" state is a first-class,
queryable state rather than something inferred from a failure.

Two caveats, stated because both are easy to get wrong:

- **The `1` above is the terminal's grant, inherited by a child process.** It
  says the API works; it says nothing about what a shipped `Atlas.app` will see.
  A fresh bundle starts at 0.
- **SCK uses no Info.plist key** (`rg -i usagedescription` over the crate: no
  hits). Screen Recording is TCC-only and the user grants it in System Settings
  → Privacy & Security → Screen Recording, then **must relaunch the app**. That
  relaunch is part of the flow and has to be designed, not discovered.

### 4. The live path — the plan's Tauri-event approach is wrong

Measured on a real 3600×2338 screen capture, re-encoded at the sizes the Lab
would actually use:

| Frame | Bytes | At 12 fps |
|---|---|---|
| 2560px JPEG q50 | 304 KB | **3.4 MB/s** |
| 2560px JPEG q75 | 475 KB | **5.4 MB/s** |
| 2560px JPEG q90 | 588 KB | **6.7 MB/s** |
| 1280px JPEG q75 | 164 KB | **1.8 MB/s** |

The Test Lab plan proposed pushing these over the Tauri event channel. **Don't.**
Tauri events serialise payloads through the IPC bridge as JSON-ish messages;
base64 inflates every frame by ~33% (2560/q75 → ~630 KB per event), and at
12 fps that is ~7 MB/s of string marshalling on the main thread — the same
thread whose blocking already has its own incident on record
(`src-tauri/src/http.rs`). With four sandboxes running, ~27 MB/s.

**Serve frames from Rust over loopback HTTP instead** and let the webview use
an `<img>`/`ImageBitmap` pipeline: bytes stay binary, decoding happens off the
main thread, and the browser's own connection handling gives back-pressure for
free. The `tiny_http` dependency and its hardened 4-rung auth ladder already
exist in `src-tauri/src/control/` and are the obvious model — the same
constant-time bearer compare, `Host` check and identical-403 discipline.

Recommended split, from the numbers above: **live preview at 1280px q75
(1.8 MB/s)** — comfortably smooth, and the design brief already commits to the
live view being lower quality than the recording — with the **saved recording
at full 2560px**, written to disk by Rust and never streamed.

### 5. Fallback, if SCK ever becomes unavailable

`CGWindowListCreateImage` polling works on every macOS version and needs the
same TCC grant, at the cost of a synchronous per-frame capture and no
`minimumFrameInterval` (we would pace it ourselves). It is strictly worse and
not needed today — recorded only so the fallback question is answered.

## Recommendation

1. Take the **GO**. Add `objc2-screen-capture-kit` only, for L1–L4.
2. **Correct the Test Lab plan**: live frames go over a loopback HTTP endpoint
   modelled on the control port's auth ladder, not the Tauri event channel.
3. Live 1280px q75; recording 2560px. State both numbers in the UI so nobody
   mistakes the preview for the artefact.
4. Preflight with `CGPreflightScreenCaptureAccess` on Lab open; request
   explicitly; design for the mandatory relaunch after granting.
5. Defer `objc2-av-foundation` to L8 (mp4 muxing).

## What I could NOT determine

- **Whether a shipped, signed `Atlas.app` gets the grant cleanly.** Everything
  above ran unsigned from a terminal that already holds the permission. The
  first-run experience in a real bundle — including whether Tauri's helper
  processes complicate the TCC identity — is untested.
- **Real achieved frame rate.** No stream was opened; `minimumFrameInterval` was
  read from the API, not exercised. The 12 fps figures are budget arithmetic
  over measured frame sizes, not observed throughput.
- **Behaviour when the captured window is occluded or off-screen.** SCK is
  documented to keep delivering frames for a covered window, but that was not
  tested, and the Lab's sandbox windows may well sit behind Lighthouse.
- **Cost of the IOSurface→JPEG encode step** in Rust, which is on the hot path
  and is not free.
