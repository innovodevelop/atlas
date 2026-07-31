# Mail intelligence — one-time setup

Atlas scans your mailbox **read-only**, sorts everything inside Atlas (your
mailbox is never modified), and proactively alerts you — dashboard card,
macOS notification, and spoken — about bills, deadlines, and documents.
PDF/image attachments on bills/documents are parsed for amount, due date and
payee.

**Decision (Phase 7b):** consumer mail stays **local-only** — there is no cloud
mail-cron worker. OAuth, token storage, sync, and analysis all happen on-device
via the Tauri app (`mail_sync` Rust command); nothing mail-related touches
Cloudflare or any other cloud service. The tradeoff: Atlas only scans mail
while the Mac is on and the app has run recently — there's no 24/7-while-off
detection. That was a deliberate deprioritization, not an oversight (see
`docs/architecture-local-first-migration.md`, phase 7).

One-time step remains, yours (it involves credentials, so Claude doesn't
perform it):

## 1. Create the Google OAuth client (~5 minutes)

1. Go to https://console.cloud.google.com → create (or pick) a project, e.g. "Atlas".
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External → fill in app name
   "Atlas" + your email. Add yourself under **Test users** (that's enough for
   personal use — no verification needed).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   type **Desktop app**, name "Atlas Mail" (a desktop/native client, not "Web
   application" — the redirect is captured locally by the Tauri app, not by a
   server).
5. Copy the **Client ID** (and secret, if the console issues one for this
   client type) into the app's local secret store (macOS Keychain, service
   `atlas-core`) — never into a committed file.

`MAIL_TOKEN_KEY`-equivalent encryption of the refresh token, and the token
itself, live only in the local SQLite DB / Keychain — there is no server-side
secret to set.

## Then connect (in Atlas)

Open the **Mail** card → **Connect Gmail**. Your system browser opens Google's
consent page — since you're already signed in there, it's one "Allow" click,
no typing. The window says "Mailbox connected", the first scan starts
immediately, and the card fills in on its own. Syncs run locally on the
scheduler's cadence while the app is running (no cloud cron).

## What's stored where

- **Local only** (`atlas.db` on-device): message headers + snippet + AI
  extraction, and the encrypted refresh token. Nothing mail-related is sent to
  or stored in the cloud.
- Scope is `gmail.readonly` — Atlas cannot send, delete, label or modify mail.
- Disconnect any time from the Mail view — this revokes the Google grant and
  deletes all scanned data locally.

## Later phases

- **Outlook** (Microsoft Graph `Mail.Read`) — same local pipeline, needs an
  Azure app registration; ask Claude for "mail 4b" when wanted.
- **Custom IMAP** — syncs locally inside the Mac app; ask for "mail 4c".
