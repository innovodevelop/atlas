# Music setup — Spotify (librespot)

Atlas plays the signed-in user's own **Spotify Premium** audio in-app via
librespot, browses/searches their library via the Spotify Web API, and drives a
Sphere visualizer from the real audio. This is the one-time setup. See
`docs/decisions/006-music-librespot.md` (why librespot) and `007-oauth-deep-link.md`
(why the deep-link redirect).

## 1. Create the Spotify app (~5 min)

At <https://developer.spotify.com/dashboard> → **Create app**:

| Field | Value |
|---|---|
| App name | `Atlas Desktop (Innovo Studio)` (must not contain "Spotify") |
| Description | Private macOS assistant that plays the user's own Spotify Premium audio in-app. |
| Redirect URI | `atlas://oauth/callback` → **Add** |
| APIs used | **Web API** only (leave Web Playback SDK / Android / iOS / Ads unchecked) |

The **Client ID** is public-safe and hardcoded in `src-tauri/src/music.rs`
(`CLIENT_ID`). The **Client Secret is not used** — Atlas is a PKCE public client.
Never commit the secret.

## 2. Allow-list the test account

New apps run in **Development Mode**: only explicitly-added users can log in. In
the app → **User Management**, add the **name + email of the Premium account**.
Skipping this makes login fail with "user not registered".

Keep the app in Development Mode — do **not** request a public Quota Extension.
librespot is an unofficial client (fine for an internal team, outside Spotify's
ToS for public distribution; see ADR 006).

## 3. Scopes (requested at login — no dashboard toggle)

```
streaming
user-read-playback-state user-modify-playback-state user-read-currently-playing
user-library-read playlist-read-private playlist-read-collaborative
user-read-email user-read-private
```

`streaming` + playback require **Premium**; free accounts can browse but not play.

## 4. How the flow works (no secret leaves the app)

1. `music_connect` builds a PKCE consent URL and opens it in the system browser.
2. Spotify redirects to `atlas://oauth/callback` → the OS hands it to Atlas.
3. Rust (`music::complete_oauth`) validates CSRF state, exchanges the code, and
   stores only the **refresh token** in the macOS Keychain (`atlas-music`).
4. On first playback, the librespot engine connects with a fresh access token
   and decodes audio to CoreAudio; `music:level` events drive the Sphere.

## If the dashboard rejects `atlas://oauth/callback`

Spotify tightened redirect rules in 2025. If the custom scheme is refused, use
`http://127.0.0.1:5657/login` instead and tell the developer — loopback capture
is a small addition to the same deep-link flow (see ADR 007), not a rewrite.

## Verifying signups / playback locally

Connect from Settings → Music, approve in the browser with the Premium account,
then play a track — audio should come from Atlas and the Sphere should react.
