# ADR 008 — HealthKit and HomeKit are a platform wall, not unwritten code

**Status:** accepted, superseded in part (2026-08-09) · **Date:** 2026-08-04

## Superseded in part — read this first

The HomeKit half of this ADR conflated two different things, and only one of
them is a wall.

- **The HomeKit FRAMEWORK is still unreachable, exactly as written below.**
  `HMHomeManager` is documented Mac Catalyst only; Atlas is AppKit + WKWebView;
  no entitlement changes that. Nothing in the tree references a HomeKit
  framework symbol, and `src-tauri/src/home/companion.rs`'s original stub row
  said so honestly.
- **Speaking the HomeKit Accessory Protocol ourselves is a different
  mechanism, and it is now built.** `src-tauri/src/home/hap/` is a HAP
  controller: Bonjour discovery, SRP-6a pair-setup, pair-verify, the encrypted
  session and the `/accessories` + `/characteristics` HTTP layer, all over the
  LAN. It is compiled ONLY into the Lighthouse build, behind the optional
  `homekit` cargo feature (`default = []`), so the consumer binary is
  unchanged.

The cost this ADR cited as the reason not to build it — an accessory holds one
pairing owner, so a physical accessory must be removed from Apple Home first —
is still true. It is now *surfaced* rather than used as a reason to stop:
`PairingStatus::PairedElsewhere` (`hap/discovery.rs`) reads `sf` bit 0 and
tells the user exactly that, and never offers a setup-code field for an
accessory it would only be refused by. Apple's HomeKit Accessory Simulator is
the development target precisely because it has no such cost — and it is **not
installed on this machine**, so nothing in the HAP module has ever exchanged a
byte with a real accessory.

The tripwire in `src-tauri/tests/platform_health_home_wall.rs` was rewritten in
the same change: it no longer greps `Cargo.toml` for the word "homekit" (which
could only be satisfied by never naming the protocol in the manifest built for
it) and instead asserts no HomeKit *framework* dependency exists and the HAP
crates stay optional and out of `default`.

The HealthKit half of this ADR is unchanged and unaffected.

## Context

The five health widgets (`steps`, `sleep`, `heart`) and five smart-home widgets
(`climate`, `energy`, `security`, `lights`, `groceries`) in
`src/components/atlas-ui/widgetCatalog/registry.ts` are mock-backed. Before
this ADR, the only record of *why* was a `needs:` string per widget — easy to
read past, and nothing stopped someone from filing "wire up HealthKit" as a
plain feature request.

## Finding

Verified by hand this session, by compiling and running native code — not by
CI, and not by this repo's test suite beyond the tripwire described below:

- **HealthKit:** a harness compiled against the macOS 26.5 SDK and run
  natively (unsigned, no HealthKit entitlement) on macOS 26.3 called
  `HKHealthStore.isHealthDataAvailable()` and got `false`.
  `isHealthDataAvailable()` is a *device capability* check, not a permission
  check — signing the app and adding the entitlement would not change the
  answer, because macOS has no HealthKit data store to serve from at all.
  Health data requires the iOS companion.
- **HomeKit:** HomeKit's public API is documented Mac Catalyst only. Atlas is
  a Tauri app — native AppKit + WKWebView, not a Catalyst target — so there is
  no HomeKit framework entry point to call, independent of entitlements. Home
  Assistant (local-first, no entitlement) is the near-term path instead of a
  direct HomeKit Accessory Protocol controller.

## Decision

Treat both as a platform wall until one of two things changes: an iOS
companion ships (HealthKit), or Atlas gains a Catalyst target (HomeKit).

*(Amended 2026-08-09.)* That still stands for the HomeKit **framework**. It
does not mean there is no home data source: the Home Assistant adapter ships,
and the HAP controller reaches HomeKit accessories directly in the Lighthouse
build. The health widgets have no data source and that half is unchanged.

## Where this is recorded

- `src-tauri/tests/platform_health_home_wall.rs` — a committed test. It does
  **not** re-run the HealthKit/HomeKit probe (this crate links neither
  framework and has no Objective-C/Swift bridge to do so); it asserts the
  structural facts that keep the finding true — build target is macOS, not
  Catalyst; `Cargo.toml` has grown no HealthKit/HomeKit **framework**
  dependency; and the HAP crates stay `optional` and out of `default` — so a
  change to any of them fails the test instead of silently going stale.
- `src/components/atlas-ui/widgetCatalog/registry.ts:415-467` — the original
  `needs:` strings per widget, restating this for anyone browsing the catalog.
- `docs/design-sync/2026-08-03-audit-atlas-suite-v2.md` — restates both walls
  in the design-audit table.
