//! Records, as a committed test, the platform finding behind the five
//! `steps`/`sleep`/`heart`/`climate`/`energy`/`security`/`lights`/`groceries`
//! widgets in `src/components/atlas-ui/widgetCatalog/registry.ts` staying
//! mock-backed. Before this test existed the finding lived only in `needs:`
//! strings in that catalog and a design-audit doc, so it was one refactor away
//! from being re-litigated by someone who hadn't read either.
//!
//! THE FINDING (verified by hand, not by this test — see below for why):
//!
//! - HealthKit: a small Rust/Swift harness was compiled against the macOS 26.5
//!   SDK and run *natively* (unsigned, no HealthKit entitlement) on macOS
//!   26.3. `HKHealthStore.isHealthDataAvailable()` returned `false`.
//!   `isHealthDataAvailable()` is a *device capability* check, not a
//!   permission check — it answers "does this Mac have a Health data store to
//!   query at all", which it does not, entitlement or no entitlement. So the
//!   result is the platform answering, not the sandbox. Signing the app and
//!   adding the entitlement would not change it: macOS has no HealthKit data
//!   store to serve from. Health data requires the iOS companion.
//! - HomeKit: HomeKit's public API is documented as Mac Catalyst only. Atlas
//!   is a Tauri app — native AppKit + WKWebView, not a Catalyst target — so
//!   there is no HomeKit framework entry point to call from this process,
//!   independent of entitlements.
//!
//! WHAT CHANGED, AND WHAT DID NOT (2026-08-09). The HomeKit half of this
//! finding is about the FRAMEWORK, and it still holds exactly as written. What
//! this file's tripwire got wrong was equating "HomeKit" with "the HomeKit
//! framework": `src-tauri/src/home/hap/` now speaks the HomeKit ACCESSORY
//! PROTOCOL directly over the LAN — TCP, SRP, Ed25519, our own bytes — which
//! is a different mechanism and is not blocked by a Catalyst-only framework.
//! It references no HomeKit framework symbol, and it is compiled ONLY into the
//! Lighthouse build, behind the optional `homekit` cargo feature.
//!
//! So the second test below no longer greps `Cargo.toml` for the word
//! "homekit" — that assertion could only be satisfied by never writing the
//! phrase "HomeKit Accessory Protocol" in the manifest that exists for it,
//! which is obfuscation, not compliance. It now asserts the two things that
//! actually keep the wall standing: no HomeKit FRAMEWORK dependency, and the
//! HAP crates optional and absent from `default`, so the consumer binary still
//! contains no home bridge. That is a tighter tripwire than the substring
//! scan, and it fails loudly if anyone moves `homekit` into `default`.
//!
//! WHAT THIS TEST ACTUALLY VERIFIES, VERSUS WHAT WAS VERIFIED BY HAND:
//!
//! This crate links no HealthKit or HomeKit framework and has no
//! Objective-C/Swift bridge — there is nothing here that could call
//! `HKHealthStore` or a HomeKit API even if we wanted to reproduce the probe
//! in CI. Faking that call (e.g. hardcoding `is_health_data_available() ->
//! false` as a Rust fn) would assert our own fiction, not the platform. So
//! this test does NOT re-run the probe. It asserts the two structural facts
//! that make the finding still apply:
//!
//!   1. We are building for the platform the finding is about (macOS, not
//!      Mac Catalyst) — if this crate ever targets `mac-catalyst`, the
//!      HomeKit half of the finding no longer holds and this test should be
//!      revisited, not silently left green.
//!   2. `Cargo.toml` has not grown a HealthKit or HomeKit FRAMEWORK
//!      dependency (`objc2-health-kit`, `objc2-home-kit`, an `HMHomeManager`
//!      bridge) that would contradict "this crate has no bridge" out from
//!      under this comment — and that the HAP crates stay optional and out of
//!      `default`, so the consumer build is unchanged.
//!
//! If someone adds a real bridge later (most likely: a signed build with the
//! HealthKit entitlement re-probed, or an iOS companion shipping), this test
//! should be replaced with one that exercises that bridge — not patched to
//! keep passing.

use std::fs;
use std::path::Path;

#[test]
fn builds_for_macos_not_mac_catalyst() {
    // The HomeKit half of the finding is Catalyst-specific: HomeKit's public
    // API is documented Catalyst-only, and this crate is a plain macOS
    // (AppKit/WKWebView) target, not Catalyst, so it has no HomeKit entry
    // point regardless of entitlements. If that ever changes, this assert
    // fails and forces the finding to be re-examined instead of quietly going
    // stale.
    assert_eq!(
        std::env::consts::OS,
        "macos",
        "this test documents a macOS-specific platform finding (HealthKit \
         isHealthDataAvailable()==false, HomeKit is Catalyst-only); it does \
         not apply to other OS targets and should not be run under one"
    );
}

fn manifest_text() -> String {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    fs::read_to_string(&manifest)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", manifest.display()))
}

/// Lines outside comments. The manifest documents the platform wall at length,
/// so a text scan that counts `#` comments finds every word it is looking for
/// and proves nothing.
fn manifest_code() -> String {
    manifest_text()
        .lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase()
}

#[test]
fn no_healthkit_or_homekit_framework_dependency_has_been_added() {
    // A FRAMEWORK dependency is what would contradict this file. Nothing here
    // can call `HKHealthStore` or `HMHomeManager` — there is no
    // Objective-C/Swift bridge — and one appearing is the event this tripwire
    // is for. The HAP controller in src/home/hap/ is NOT one of these: it
    // speaks the accessory protocol over TCP and references no framework
    // symbol. See this file's module doc.
    let code = manifest_code();
    for needle in ["healthkit", "health-kit", "home-kit", "homekit-sys", "hmhomemanager"] {
        assert!(
            !code.contains(needle),
            "Cargo.toml now depends on `{needle}` — that is a HealthKit/HomeKit \
             FRAMEWORK bridge, which is the thing this file says cannot exist \
             on macOS. Re-verify the finding (see this file's module doc and \
             docs/decisions/008-healthkit-homekit-platform-wall.md) before \
             wiring the widgets to real data, and update both places."
        );
    }
}

/// The HAP controller must stay out of the consumer binary. This is the
/// assertion that replaced the old bare `homekit` substring scan, and it is
/// strictly stronger: the scan only knew whether a word appeared, while this
/// knows whether the code SHIPS.
#[test]
fn the_hap_controller_stays_optional_and_out_of_the_default_build() {
    let text = manifest_text();

    // `default = [...]` must not name the feature. Moving it there is the one
    // edit that would put a HomeKit bridge into Atlas.app, and it is a
    // one-word edit, which is exactly why it needs a test.
    let default_line = text
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("default"))
        .unwrap_or_else(|| panic!("Cargo.toml has no `default = [...]` feature line"));
    assert!(
        !default_line.contains("homekit"),
        "`{default_line}` puts the HAP controller in the DEFAULT build — it \
         would then compile into Atlas.app, where the control-port registry \
         makes it reachable by the model whatever the frontend shipped. It is \
         a Lighthouse-only capability; see src/home/hap/mod.rs."
    );

    // …and every crate the feature pulls in must be `optional`, or the crates
    // are linked regardless of whether the feature is on.
    //
    // HONEST LIMIT, checked by hand: while the feature list says
    // `dep:ed25519-dalek`, cargo refuses to parse the manifest at all if the
    // dependency is not optional, so THAT mutation never reaches this test —
    // cargo's check is the stronger one and this is a restatement of it. What
    // this assertion still catches is the edit cargo permits: dropping the
    // `dep:` entry AND the `optional` in one go, which silently links all
    // three crates into Atlas.app.
    let code = manifest_code();
    for dep in ["ed25519-dalek", "x25519-dalek", "chacha20poly1305"] {
        let line = code
            .lines()
            .find(|l| l.trim_start().starts_with(dep))
            .unwrap_or_else(|| panic!("Cargo.toml no longer declares `{dep}`"));
        assert!(
            line.contains("optional = true"),
            "`{dep}` is no longer optional, so it links into the consumer \
             build: {line}"
        );
    }
}
