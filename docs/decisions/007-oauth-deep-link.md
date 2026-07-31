# 007 — Native OAuth via deep link (not loopback), branded universal link staged

**Status:** accepted · **Date:** 2026-07-21
**Context:** the music player (Spotify/librespot, see [006](006-music-librespot.md))
is the first Atlas feature to run OAuth from the *desktop app itself* rather than
server-side. This records how that redirect works and why.

## Decision

Atlas desktop OAuth uses **Authorization Code + PKCE** (RFC 8252, "OAuth 2.0 for
Native Apps") and captures the redirect through an **OS deep link**, not a
loopback HTTP server and not a server round-trip.

The redirect target is a single seam, `oauth::REDIRECT_URI`:

- **Now:** the custom scheme **`atlas://oauth/callback`**. Works on any build —
  signed or not, dev or prod — with zero extra infrastructure.
- **Later (pre-staged):** the branded universal link
  **`https://atlas.innovo-studio.com/oauth/callback`**. Activating it is a
  one-line change (`REDIRECT_URI` → `REDIRECT_URI_UNIVERSAL`) plus the hosting +
  entitlement steps below. **The flow does not change** — PKCE, deep-link
  capture, and the Rust-side token exchange are identical.

## Why not the alternatives

- **Loopback (`http://127.0.0.1:<port>`)** — the RFC-endorsed *default* for native
  apps and what librespot-oauth ships with. Perfectly valid, but it shows a bare
  IP in the consent redirect and needs a free local port. We prefer a deep link
  for the branded end state, and do our own PKCE so the redirect isn't tied to
  librespot's loopback helper.
- **Branded domain as a *server* redirect (like Gmail)** — was correct for the
  mail flow when it ran as a *confidential* client in Supabase functions;
  mail OAuth has since moved to a local desktop-client flow (Phase 7b: no
  cloud piece, see `docs/mail-setup.md`), so this alternative no longer
  applies to either flow. Still wrong for Spotify regardless: a desktop app is
  a *public* client (no secret in a shipped binary), and the code must reach
  the *app instance*, not a server. Routing through the domain would force a
  fragile relay back down to the right desktop process.

## Why custom scheme first, universal link later

Universal links only work on a **code-signed + notarized** app that ships an
`associated-domains` entitlement — macOS silently ignores them otherwise. Atlas
currently has **no Apple Developer Team ID** (`tauri.conf.json` sets no
`signingIdentity`). So the universal link cannot function yet; the custom scheme
can, today. Custom schemes are theoretically hijackable by another app
registering the same scheme, but PKCE makes a stolen code unusable without the
verifier (which never leaves this process), so the residual risk is low for an
internal 5–10-person tool.

## Activating the universal link (when a Team ID exists)

1. Enroll in the Apple Developer Program; set `signingIdentity` + notarization in
   the build (and the `com.apple.developer.associated-domains` entitlement:
   `applinks:atlas.innovo-studio.com`).
2. Host the Apple App Site Association at
   `https://atlas.innovo-studio.com/.well-known/apple-app-site-association`
   (served as `application/json`, no extension). A ready template lives at
   `atlas-site/public/.well-known/apple-app-site-association.template.json` —
   fill in `TEAMID` and deploy.
3. Flip `oauth::REDIRECT_URI` to `REDIRECT_URI_UNIVERSAL`, and update the
   registered redirect URI in the provider console (Spotify / Google) to match.

## Implementation

- `src-tauri/src/oauth.rs` — PKCE (`generate_pkce`, S256 pinned to the RFC 7636
  test vector), `parse_callback` (accepts both redirect forms, ignores unrelated
  deep links), the `OauthCallback` payload. Provider-neutral.
- `src-tauri/src/lib.rs` — registers `tauri-plugin-deep-link`, and in `setup`
  parses each opened URL and re-emits it as the `oauth-callback` Tauri event.
  The **authorization code stays in Rust**; the token exchange (per provider)
  runs there too, so no secret or code ever enters the webview.
- `src-tauri/tauri.conf.json` — `plugins.deep-link.desktop.schemes: ["atlas"]`
  (generates the macOS `CFBundleURLTypes`). `capabilities/default.json` grants
  `deep-link:default`.
- `src/lib/deepLinkOauth.ts` — thin webview seam (`onOauthCallback`,
  `waitForOauthCallback`) so a connect button can await the round trip.

## Consequences

- The music player OAuth flow is fixed now and will not be re-architected when we
  brand it — only the redirect string moves.
- Spotify Developer app must register `atlas://oauth/callback` as a redirect URI
  (in addition to any future universal link).
- Deep links on macOS rely on the app being the registered scheme handler; the
  first-launch (cold-start) URL is delivered after `setup` wires the handler.

## Amendment — 2026-07-25: branded host moves to `helloatlas.dk`

The decision above stands unchanged; only the **branded host** does. Atlas moved
from `atlas.innovo-studio.com` to the purpose-bought **`helloatlas.dk`**, whose
**apex is canonical** (`www.helloatlas.dk` redirects to it; the apex must serve
directly because it also hosts the desktop app's auth API, and a 301 on
`POST /api/auth/login` does not reliably survive a cross-origin hop).

What changed:

- `oauth::REDIRECT_URI_UNIVERSAL` is now
  **`https://helloatlas.dk/oauth/callback`** — this is the URL we *generate*, so
  it is the one to register in provider consoles from here on.
- `parse_callback` *accepts* **both** hosts (`oauth::UNIVERSAL_HOSTS`). The old
  host is still an active custom domain on the same Pages project and is still
  compiled into every already-installed build, so rejecting it would drop an
  in-flight callback for those users. Acceptance lists keep the old host;
  generation uses the new one.
- The AASA hosting step (§"Activating the universal link", step 2) now means
  `https://helloatlas.dk/.well-known/apple-app-site-association`, and the
  `associated-domains` entitlement becomes `applinks:helloatlas.dk`. Serving the
  file from the old host as well costs nothing and keeps older signed builds
  working, should any exist by then.
- Same for the CSP `connect-src` in `tauri.conf.json`: `helloatlas.dk` added,
  `atlas.innovo-studio.com` kept.

Custom-scheme `atlas://oauth/callback` is untouched and remains the redirect in
use today, so nothing about the shipping flow changes with this amendment.
