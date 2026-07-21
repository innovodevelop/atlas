# 006 — In-app Spotify audio via librespot

**Status:** accepted · **Date:** 2026-07-21
**Related:** [007-oauth-deep-link.md](007-oauth-deep-link.md), `docs/music-setup.md`

## Context

The music player must play **full tracks** (not 30s previews) inside the Atlas
Tauri app and react a visualizer to the real audio. Two web-native options were
ruled out:

- **Spotify Web Playback SDK** needs Widevine/EME — broken in Tauri's macOS
  WKWebView ([tauri#7400](https://github.com/tauri-apps/tauri/issues/7400), open
  since 2023).
- **Apple MusicKit JS** needs FairPlay — same WKWebView limitation.
- Spotify also **removed `preview_url`** for new apps (Nov 2024).

So DRM catalog audio cannot decode in the webview. The user chose **true in-app
audio via a native sidecar, Spotify first**.

## Decision

Embed **librespot 0.8** (open-source Spotify Connect playback client, Rust) in
`src-tauri`. It authenticates a **Premium** account, decodes full Ogg audio to
CoreAudio locally, and a custom sink taps the PCM for the Sphere. The Spotify
**Web API** (over `ureq`) provides browse/search/library/state; librespot
provides the audio. See `music.rs` (commands + Web API) and `music_engine.rs`
(the librespot Player on its own tokio thread).

We drive the librespot `Player` **directly** (load/play/pause/seek) rather than
via Spotify Connect/Spirc — lower latency, no round trip to control our own
device. A small local queue backs next/prev.

## Caveats (surfaced in code + setup)

- **Unofficial client.** librespot is reverse-engineered; streaming through it is
  outside Spotify's Developer ToS. Acceptable for the internal 5–10-person team;
  keep the Spotify app in **Development Mode**, never request a public quota
  extension. Revisit official MusicKit/SDK before any public release.
- **Premium required.** Free accounts can browse (Web API) but librespot only
  streams full audio for Premium.
- **macOS-only** audio. The browser preview degrades to `available:false`.
- **Access-token lifetime.** librespot connects with the access token from our
  own PKCE flow (`Credentials::with_access_token`, `SessionConfig.client_id` set
  to our app's Client ID). Tokens expire ~1h; long-session reconnect is a
  follow-up. **Live login+play with a real Premium account is the acceptance
  test** and confirms the AP accepts a third-party-client token.

## Build pin (critical)

librespot-core 0.8's build script breaks with vergen ≥ 9.1. The committed
`Cargo.lock` pins **`vergen = 9.0.6`** and **`vergen-gitcl = 1.0.5`**:

```
cargo update -p vergen --precise 9.0.6
cargo update -p vergen-gitcl --precise 1.0.5
```

Without this, `cargo build` fails with an E0277 vergen-lib trait mismatch.
`librespot-playback` is taken with `default-features = false, features =
["rodio-backend"]` (rodio → CoreAudio).

## Provider abstraction

Commands are `music_*` (not `spotify_*`) and `music_status` returns `provider`.
Apple Music becomes a second engine behind the same commands (native MusicKit +
Apple Developer membership) in a later phase, with no UI rework.
