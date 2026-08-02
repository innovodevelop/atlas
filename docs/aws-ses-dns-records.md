# SES DNS records for helloatlas.dk — the last manual step

**Status 2026-08-02: these three records are the ONLY thing blocking Atlas Mail
from sending.** Everything else is done (see the checklist at the bottom).

## ⚠️ Why this cannot wait, and cannot be half-done

`helloatlas.dk` publishes **`DMARC p=reject; sp=reject`** with no `pct=`. That is
the strictest possible policy, applied to 100% of mail.

Right now SPF authorises **only Cloudflare** (`v=spf1
include:_spf.mx.cloudflare.net ~all`) and the only DKIM key is Cloudflare's
`cf2024-1`. So a message sent through SES today has **no aligned DKIM and no SPF
cover** — receivers will **reject it outright**, not file it as spam. The failure
is silent from our side: SES reports a successful send, and the mail simply never
arrives.

**Add these before the first send.** DKIM alignment alone satisfies DMARC, so
these three records are sufficient — a custom MAIL-FROM is optional (see below).

## The three records

Cloudflare dashboard → **helloatlas.dk** → **DNS** → **Add record**, three times:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `tfmfzzhjet7dkfwlh2dm35wvluxgkr3t._domainkey` | `tfmfzzhjet7dkfwlh2dm35wvluxgkr3t.dkim.amazonses.com` | DNS only |
| CNAME | `gqiaxrd4l5ngyxb47ygxmzfazyjoo7pk._domainkey` | `gqiaxrd4l5ngyxb47ygxmzfazyjoo7pk.dkim.amazonses.com` | DNS only |
| CNAME | `djs7vmgdp5ply6xz2znhkdnu2zbrkk3h._domainkey` | `djs7vmgdp5ply6xz2znhkdnu2zbrkk3h.dkim.amazonses.com` | DNS only |

Enter the **Name** exactly as shown — Cloudflare appends `.helloatlas.dk`
itself. Leave the proxy **grey / DNS only**; Cloudflare will not proxy an
underscore name anyway, but set it deliberately rather than by accident.

These tokens are public DNS data, not secrets. They were issued by
`CreateEmailIdentity` on 2026-08-02 and are stable unless the identity is
deleted and recreated.

TTLs on this zone are 300s and there is no DNSSEC, so propagation is ~5 minutes
and the change is cheap to reverse.

## Verifying

SES polls DNS itself; verification usually completes within 15 minutes:

```
aws sesv2 get-email-identity --email-identity helloatlas.dk --region eu-central-1 \
  --query '{Verified:VerifiedForSendingStatus,Dkim:DkimAttributes.Status}'
```

`{"Verified": true, "Dkim": "SUCCESS"}` means sending is safe. **Do not send
before that.**

## Optional: custom MAIL-FROM (better deliverability, not required)

Without it, the envelope sender is `amazonses.com`, so SPF authenticates but does
not *align* with helloatlas.dk. DMARC passes on DKIM alone, so this is a
refinement rather than a requirement. If you want it later, it needs two more
records (`bounce.helloatlas.dk` MX → `feedback-smtp.eu-central-1.amazonses.com`
priority 10, and an SPF TXT on that subdomain) plus
`PutEmailIdentityMailFromAttributes`.

---

## What is already done (2026-08-02)

| Step | State |
|---|---|
| IAM policy `atlas-mail-ses-s3` on `atlas-brain` | ✅ applied by the account owner |
| SES domain identity `helloatlas.dk` | ✅ created, eu-central-1 |
| DKIM tokens issued | ✅ the three above |
| SES production-access request | ✅ filed, **Status: PENDING** (~24h) |
| Worker secret `AWS_ACCESS_KEY_ID` | ✅ set (key `AKIAVVOEAEIQVCKJKGPO`) |
| Worker secret `AWS_SECRET_ACCESS_KEY` | ✅ set — value never displayed |
| `blob_key` migration + worker deploy | ✅ done earlier today |
| **DKIM CNAMEs in DNS** | ❌ **the remaining blocker — above** |

The worker key is a **second, independent** access key on `atlas-brain`
(`AKIAVVOEAEIQVCKJKGPO`, created 2026-08-02). The Mac's Bedrock key
(`AKIAVVOEAEIQTB2TFX64`) is untouched, so revoking one does not disturb the
other:

```
aws iam delete-access-key --user-name atlas-brain --access-key-id AKIAVVOEAEIQVCKJKGPO
```

## Sandbox

The account is **still in the SES sandbox** (200 msg/day, sending enabled). In
sandbox, SES will only deliver to **verified** recipients — so even after DKIM
goes green, a test send to an arbitrary address fails until either production
access is granted or that recipient is verified:

```
aws sesv2 create-email-identity --email-identity you@example.com --region eu-central-1
```
(then click the link AWS emails to that address)
