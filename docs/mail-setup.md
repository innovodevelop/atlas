# Gmail — one-time setup

Atlas reads your Gmail inbox **read-only** (scope `gmail.readonly`: it cannot
send, delete, label or modify mail) and keeps what it reads on this Mac.

**Decision (Phase 7b):** consumer mail stays **local-only**. OAuth, token
storage and sync all happen on-device in the Tauri app (`src-tauri/src/gmail.rs`,
the `gmail_*` commands); nothing mail-related touches Cloudflare or any other
cloud service. The tradeoff: Atlas only syncs while the app is running — there
is no 24/7 detection while the Mac is off. That was a deliberate
deprioritization, not an oversight (see
`docs/architecture-local-first-migration.md`, phase 7).

(The admin mailbox in the Atlas Mail suite is a different path: the atlas-mail
Cloudflare worker plus `mail.rs`. Nothing below applies to it.)

## 1. Create the Google OAuth client (~5 minutes, yours)

This involves credentials, so Claude doesn't perform it.

1. Go to https://console.cloud.google.com → create (or pick) a project, e.g. "Atlas".
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External → app name "Atlas" +
   your email. Add every Google account you'll connect under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   type **Desktop app**, name "Atlas Mail". It must be *Desktop app*: Atlas
   signs in with a loopback redirect (`http://127.0.0.1:<random port>`), which
   is what that client type accepts. You don't enter any redirect URI.
5. Copy the **Client ID** and the **Client secret**. Google documents a
   Desktop-app secret as not confidential (it ships inside installed apps),
   but its token endpoint still requires it — so it goes in the Keychain with
   the ID, never in a committed file.

## 2. Put the client into Atlas's Keychain item

Both values live in the `atlas-core` Keychain blob as
`google_oauth_client_id` and `google_oauth_client_secret`. The promptless way
in is the `secrets-import` staging item, which Atlas absorbs into the blob on
its next launch (see `load_or_migrate` in `src-tauri/src/secrets.rs`):

```bash
security add-generic-password -U -s atlas-core -a secrets-import -T /Applications/Atlas.app/Contents/MacOS/app -w '{"google_oauth_client_id":"PASTE_ID","google_oauth_client_secret":"PASTE_SECRET"}'
```

Then quit Atlas fully (⌘Q) and reopen it. Until both values are there,
**Connect Gmail** says so instead of opening the browser. Note that a key
already in the blob wins over an imported one, so this sets the client once;
replacing it later means removing the old value from the blob first.

## 3. Connect (in Atlas)

**Settings → Mail → Connect Gmail** (or **Connect Gmail** in the expanded Mail
view). Your browser opens Google's consent page; after **Allow**, Google
redirects to Atlas's local listener, Atlas exchanges the code itself, and the
tab shows whether the mailbox connected. Back in Atlas, use **Scan now** to sync.

- A sign-in waits 10 minutes, then gives up. **Cancel** abandons it at once,
  so a Google tab finished afterwards connects nothing (the tab says so).
- Closing the Mail view or Settings doesn't stop a sign-in: finish the Google
  tab and the mailbox appears next time you open it.
- Clicking Connect again starts another sign-in alongside the first; either
  tab works. (At most four can be in flight; a fifth retires the oldest.)

## What sync does today

- Inbox only, message metadata only: sender, subject, date, snippet,
  Message-ID. No bodies, no attachments.
- First scan: the newest 50 inbox messages. Later scans: everything added to
  the inbox since the last one, via Gmail's history API. Older mail is not
  backfilled.
- Automatic: every 15 minutes while Atlas is open (the first scan about 90
  seconds after launch), plus **Scan now** at any time. A mailbox far behind
  catches up in up to five back-to-back scans per round. Nothing syncs while
  Atlas is closed.
- When a scan fails, the mailbox says why in Settings → Mail. A dropped
  connection or a Google outage is retried on the next round and the mailbox
  stays active. A revoked or expired grant, a missing token or a missing OAuth
  client marks it **error** and stops background scans for it: reconnect it,
  or fix the client and press **Scan now**, and it resumes.
- Not built yet: categorising mail, bill/deadline/document alerts, attachment
  parsing, threads.

## What's stored where

- **Keychain** (service `atlas-gmail`, one item per connected mailbox): the
  Google refresh token. The client ID and secret sit in `atlas-core`.
- **`atlas.db`** on this Mac: the account row and the message metadata above.
  Nothing mail-related is sent to or stored in the cloud.
- **Disconnect** (Settings → Mail) deletes the mailbox and everything scanned
  from it locally, and revokes the Google grant — unless another Atlas user on
  this Mac has the same Gmail address connected, since Google keeps one grant
  per app and account and revoking it would cut them off too.

## Limits worth knowing

- While the consent screen is in **Testing**, Google expires refresh tokens
  after 7 days, so a mailbox needs reconnecting weekly. Publishing the app
  removes that, but `gmail.readonly` is a *restricted* scope: production use
  by people outside your test users needs Google's verification and a
  security assessment.
- Gmail sign-in has not yet been run end to end against a real Google
  account; the first real connect is the verification step.

## Custom IMAP mailboxes

Settings → Mail → **Connect another mailbox (IMAP)** connects any mailbox
that speaks IMAP (iCloud, Fastmail, Yahoo, a hosting provider's server).

- **Server settings:** the email address, the IMAP server and port (993),
  an optional username (defaults to the address) and the password. Most
  providers with two-factor sign-in need an **app-specific password**:
  iCloud (appleid.apple.com), Yahoo and Fastmail all issue them.
- **TLS only.** Atlas connects with implicit TLS and refuses STARTTLS and
  plaintext, so the password never crosses the network unencrypted.
- **Read-only.** The inbox is opened with `EXAMINE`, so the server cannot
  even mark a message as read, and only the envelope (sender, subject, date,
  Message-ID) is fetched.
- **Where it lives:** server settings and password are one Keychain item
  per mailbox (service `atlas-imap`); messages are in `atlas.db`.
- **Sync:** Atlas logs in once before saving anything, scans straight away,
  then joins Gmail's 15-minute background sync. A first scan takes the
  newest 50 messages and doesn't backfill. A rejected password or a TLS
  certificate that doesn't verify marks the mailbox **error** until you
  reconnect it; a network failure is retried on the next round.
- **Disconnect** deletes the mailbox, its scanned mail and the Keychain item.
  There is no grant to revoke; change the password at your provider if you
  want to cut access off there too.
- **Not yet:** run against a real server (the first connect on the Mac is
  the verification step).

## Later phases

- **Outlook** (Microsoft Graph `Mail.Read`) — same local pipeline, needs an
  Azure app registration. Outlook.com mailboxes no longer accept IMAP
  password logins, so the IMAP connector doesn't cover them.
