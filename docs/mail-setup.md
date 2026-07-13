# Mail intelligence — one-time setup

Atlas scans your mailbox **read-only**, sorts everything inside Atlas (your
mailbox is never modified), and proactively alerts you — dashboard card,
macOS notification, and spoken — about bills, deadlines, and documents.
PDF/image attachments on bills/documents are parsed for amount, due date and
payee.

Everything is already deployed. Two one-time steps remain, both yours (they
involve credentials, so Claude doesn't perform them):

## 1. Create the Google OAuth client (~5 minutes)

1. Go to https://console.cloud.google.com → create (or pick) a project, e.g. "Atlas".
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → External → fill in app name
   "Atlas" + your email. Add yourself under **Test users** (that's enough for
   personal use — no verification needed).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   type **Web application**, name "Atlas Mail".
   - Authorized redirect URI (exactly):
     `https://gdhdqetwlinlpimpxokp.supabase.co/functions/v1/mail-oauth-callback`
5. Copy the **Client ID** and **Client secret**.

## 2. Set the three secrets

From `helloatlas/`, run (fill in your two values; the third generates itself):

```bash
bunx supabase secrets set \
  GOOGLE_OAUTH_CLIENT_ID="<your client id>" \
  GOOGLE_OAUTH_CLIENT_SECRET="<your client secret>" \
  MAIL_TOKEN_KEY="$(openssl rand -base64 32)" \
  --project-ref gdhdqetwlinlpimpxokp
```

`MAIL_TOKEN_KEY` encrypts refresh tokens at rest (AES-GCM). If you ever
rotate it, existing accounts must be reconnected.

## Then connect (in Atlas)

Open the **Mail** card → **Connect Gmail**. Your system browser opens Google's
consent page — since you're already signed in there, it's one "Allow" click,
no typing. The window says "Mailbox connected", the first scan starts
immediately, and the card fills in on its own. Syncs run automatically every
15 minutes after that.

## What's stored where

- Supabase (your own project): message **headers + snippet + AI extraction
  only** — never full bodies; refresh token encrypted with `MAIL_TOKEN_KEY`.
- Scope is `gmail.readonly` — Atlas cannot send, delete, label or modify mail.
- Disconnect any time from the Mail view — this revokes the Google grant and
  deletes all scanned data (cascade).

## Later phases

- **Outlook** (Microsoft Graph `Mail.Read`) — same pipeline, needs an Azure
  app registration; ask Claude for "mail 4b" when wanted.
- **Custom IMAP** — will sync locally inside the Mac app (Deno edge IMAP is
  unreliable); ask for "mail 4c".
