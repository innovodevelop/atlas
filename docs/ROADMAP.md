# Atlas — roadmap and open work

**This is the single source of truth for what is done and what is left.**
Updated 2026-08-02.

Before this file, planning state lived in five places that disagreed with each
other: the root `CLAUDE.md`, `docs/architecture-local-first-migration.md`, two
`docs/design-sync/` plans, and a session-local task list that was not in the
repo at all. Work was recorded as pending long after it shipped, and shipped
work was recorded nowhere. If you add a phase, a stage or a TODO, it goes here.

---

## Blocking commercial release

### 1. Wake-word model licensing — **hard blocker**

All three ONNX models in `public/models/` (`melspectrogram.onnx`,
`embedding_model.onnx`, `hey_jarvis_v0.1.onnx`) are openWakeWord **pre-trained
models**, licensed **CC BY-NC-SA 4.0** — NonCommercial *and* ShareAlike. Only
openWakeWord's *code* is Apache-2.0. Atlas cannot ship any of them.

Training a custom model with `scripts/train-wakeword/` as written does not
escape this: the negative feature set (`davidscripka/openwakeword_features`)
carries the same licence, and a custom phrase model still runs on top of the two
NC-SA backbone files.

**Resolution path (verified 2026-08-02):** Google's `speech_embedding` module on
Kaggle Models is **Apache 2.0** per its model card (`google/speech-embedding`,
TensorFlow1, v1). openWakeWord's backbone is a re-implementation of it, and the
Google module computes its own log-mel internally, so **one Apache-2.0 module
replaces both backbone files with no retraining**. Its published spec matches
`src/lib/wakeWord.ts` exactly (32 mel bins, 25 ms/10 ms STFT, first embedding at
12400 samples = 76 frames, then every 1280 samples = 8 frames, 96-dim output).
The phrase model is then trained on CC0 negatives (Mozilla Common Voice).

Full detail: `docs/decisions/002-wake-word-openwakeword.md` (licence correction
section) and `scripts/train-wakeword/README.md`.

### 2. The wake phrase is a lie in the UI

The app listens for **"Hey Jarvis"** (the only model that ships) while the UI and
the atlas-site privacy policy say **"Hey Atlas"**. Either train the model
(blocked on item 1) or correct the copy. Do not ship the mismatch.

### 3. Privacy-policy delta for Bedrock — now two deltas, one deploy

`atlas-site/public/privacy.html` has an uncommitted delta stating the digest
"now runs on AWS EU". Bedrock **is** live, so this is now overdue rather than
premature. It must deploy with the app build that has the Bedrock provider
active — and must be stashed around any unrelated atlas-site deploy.

**Stacked on top of it (2026-08-02): the EEA-confinement withdrawal — written, and
now DELIBERATELY HELD.** §2, §4.3, §4.7, §5, §6, §7 and §8 were rewritten to
remove the "background inference is processed inside the EEA, and is therefore
not a third-country transfer" claim, because non-EU inference profiles became
permitted in code.

**Do not deploy that part yet.** The justification evaporated the same day: this
AWS account cannot invoke the frontier tier on **any** profile, EU or global —
`AccessDeniedException … contact AWS Sales`, confirmed as the account admin in
the console, not just as `atlas-brain`. So the residency withdrawal currently
buys nothing, and weakening a published privacy commitment for a capability we
do not have is a bad trade. The sequencing rule still governs and now cuts the
other way: the text must be live *before* a non-EEA profile serves a real
request, and none can. Detail: `docs/aws-bedrock-non-eea-enablement.md` §2.

The code change stays — it is guarded, defaults to EU, and is the flip we would
need if access is ever granted.

If it is deployed later: withdrawing a published residency guarantee is a
**material change** under §12 ("Material changes will be communicated in the app
or by email"). Deploying the page is not sufficient on its own; the notice is
owed to anyone already running Atlas.

**Riding along with this deploy:** `atlas-site/public/favicon.svg` is also
modified and uncommitted (the 2026-08-02 icon retune — the mark was illegible at
favicon size for the same reason it was illegible in the dock). Deliberately
held back rather than committed on its own, because any atlas-site deploy risks
shipping the privacy delta early. Commit and deploy both together.

Two uncommitted files in a repo nobody is watching is a fragile way to hold a
release gate. If this drags, stash them with a named stash instead.

### 4. Rotate the Mastercard webhook secret

Exposed in a transcript. Still valid. Security item, user-only.

---

## Open product work

| Item | State | Notes |
|---|---|---|
| ~~**three.js vs canvas sphere**~~ | **RESOLVED** (suite v2, `aaced86`) | Canvas won. All four renderers collapsed onto `src/lib/atlasSphere.ts`; `three`, `@types/three` and the three `@react-three/*` packages are out of `package.json`, and `MusicSphere.tsx` — the last fork — went in `33ca831` |
| **Mail Stage 6e** — Gmail/Outlook/IMAP connectors | Not started | The last mail stage. `src/integrations/local/localClient.ts:424` stub is correct until then |
| **Mail 6b–6d runtime verification** | Built, never run — **now buildable** | No `mail_*` Tauri command has executed once. A packaged 0.2.0 with the suite-v2 UI is installed at `/Applications/Atlas.app` (2026-08-04), so this is finally testable; it has not been tested |
| **Mail sending** | Blocked | Needs Workers Paid; forwarding destination unverified |
| ~~**Atlas Core: Memory tab**~~ | **DONE** (`28abe9f`) | 8th tab, on `useAtlasMemory` lifted out of the legacy tree. Read-only by design — the destructive controls stay in Settings |
| ~~**Atlas Core: fabricated data**~~ | **DONE** (`28abe9f`) | All four invented panels replaced with real hooks + `<Empty>`; the static `badge: 3` and the two fake trends are gone. The throughput panel now shows the one real figure and says plainly that ingestion rate, pipeline count and validation pass rate are not measured |
| **Atlas Teach** | Half-fixed | No longer orphaned — `AccountMenu.tsx:81` links it (suite v2 T4). Still 858 lines of pure Tailwind that does not match the design system |
| **No manual "add a memory"** | Gap | The *only* way a memory is created is the model choosing to call `memory_store`. There is also no correction/feedback mechanism |
| **Portfolio hero** | Blocked | No holdings data source until Mastercard Open Finance lands |
| **Home floating memory cards** | Not built | Low priority |

## Open release/infra work

- Decide the release-home repo and align the updater endpoint
- Back up the updater private key; set CI signing secrets
- Shrink the download (e5 model out of the sidecar binary)
- Enable Fable 5 / Opus 5 / Sonnet 5 / Opus 4.8 on Bedrock. **IAM is done** (v4,
  applied and functionally verified 2026-08-02). What remains is entitlement, and
  **there is no longer an access-request form** — the Bedrock "Model access" page
  has been retired. Enablement now happens by opening the model in the console
  playground and invoking it once as an admin, completing the Anthropic use-case
  form if prompted. The playground page wedges browser automation, so this step
  is manual. Full detail: `docs/aws-bedrock-non-eea-enablement.md`
- Fold `atlas-snaptrade` Keychain items into a consolidated blob
- Mastercard Open Finance integration build

---

## Done — do not re-plan these

Local-first migration is **complete**: SQLite core with sqlite-vec + FTS5 recall,
the Bun brain sidecar as sole orchestrator, Cloudflare D1 auth, data-fetch in
Rust, ElevenLabs via the voice gateway, local scheduler. Supabase is gone from
every runtime path.

Also landed: Bedrock live end-to-end; prompt caching actually working (stable/
volatile system split); CI green with local parity; atlas-site deployed with
Terms/Privacy and account deletion; helloatlas.dk on Cloudflare; the Workshop
reskin including the canvas sphere port and top-bar removal; signing + updater
substrate; the first-run permissions screen.

**Inert but still present:** `@supabase/supabase-js`, the `supabase` CLI,
`postgres` deps, `tests/auth.spec.ts` and `supabase/migrations/` remain in the
tree. They are not on any runtime path — cosmetic cleanup only. Note that
`supabase/functions/_shared/` is a **misleading directory name**: it holds the
runtime-neutral shared orchestrator the brain imports, and has no Supabase
dependency. Do not "clean it up".

---

## The 2026-07-30 workflow plan — what actually landed

That plan ran Stage 0, then four parallel workflows, then W-SHIP. It was never
finished, and the earlier claim in this file that "all four Stage-1 workflows
landed" was wrong. Verified against the tree on 2026-08-02:

| | State | Evidence |
|---|---|---|
| **Stage 0** — prompt caching | ✅ done | `b6e1741` stable/volatile system split + `system[0]` breakpoint |
| **W-SUPA** — finish Supabase removal | ✅ done | `6208892` (34 edge fns, client alias, 3 shim bugs) + `6b16d45` (last 3 npm deps) |
| **W-AUTH** — audit + harden auth | ✅ mostly | login/signup wrap D1 access; `auth_attempts` pruning exists in `login.ts` |
| **W-CI** — permanent CI fix | ✅ done | `bun run ci` → `scripts/ci/run.sh`, `scripts/hooks/pre-push`. **Its tail sat uncommitted for days** — the `RUN_LIVE_AUTH_TESTS` gating only landed in `41fcc35` |
| **W-AWS** — complete the AWS migration | 🟡 **mostly built, not deployed** | See the correction below — an earlier version of this row said "no SES send path anywhere", which was wrong: it searched only this repo, and the work lives in the sibling `atlas-mail` repo |
| **W-SHIP** (Stage 2) — build + runtime verify | ❌ **not done** | Atlas Mail 6b–6d still never runtime-executed; the privacy delta is still undeployed, which was W-SHIP's final step |

### W-AWS in detail (corrected 2026-08-02)

Most of it **is built** — in `atlas-mail`, a sibling repo, which is why a
helloatlas-only grep concluded it did not exist. Atlas spans four repos; audit
all of them or say which one you audited.

| Piece | State |
|---|---|
| SESv2 outbound sending | ✅ built — `atlas-mail/src/ses.ts`, vendored SigV4, `SES_REGION=eu-central-1`, sandbox behaviour handled (`c9bef50`) |
| S3 blob helper | ✅ built — `atlas-mail/src/s3.ts` (`s3PutObject` / `s3GetObject`) (`9b4530f`) |
| `r2_key` → `blob_key` | ✅ **shipped 2026-08-02** — migration applied to remote D1, worker deployed (version `8790b280`), `/health` 200 |
| Bedrock live through our own signer | ✅ **verified 2026-08-02** — HTTP 200, `[bedrockAdapter] eu.anthropic.claude-sonnet-4-6`, real completion returned |
| Updater release home (S3/CloudFront) | ❌ still GitHub releases — needs a decision, not code |
| SES production access | ⛔ user gate — ~24h AWS request; sandbox only until then |

**Done 2026-08-02.** Migration applied to remote D1, then worker deployed
(`8790b280`, `/health` 200). The migration also created `mail_send_errors`,
which was missing remotely — so until now every SES send failure was being
swallowed by the `catch` in `store.ts` and recorded nowhere.

### ⛔ Sending is deployed but cannot authenticate

`wrangler secret list` on atlas-mail returns **only `AUTH_JWT_SECRET`**. The
SES path needs `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as worker
secrets, and they were never set. The route fails closed with
`500 "Sending is not configured (missing AWS credentials)"` (`index.ts:245`) —
correct behaviour, but it means outbound mail has never been able to work,
independently of the Workers Paid question.

**This needs a decision, not just a command.** The obvious move is to copy the
AWS key pair the app already uses for Bedrock out of the Keychain and into
Cloudflare. Do not do that without thinking: those credentials can invoke
Bedrock, and putting them in a Worker widens their blast radius from "this Mac"
to "anything that can read this Worker's environment".

The right shape is a **separate IAM user scoped to `ses:SendEmail` on the
verified identity only** — then a leak costs email sending, not model inference.
That IAM user does not exist yet.

### W-SHIP in detail

Bedrock is now verified live (above), which was its first checkpoint. What
remains is Atlas Mail 6b–6d runtime verification — still true that no `mail_*`
Tauri command has ever executed — and the privacy-policy deploy.

Worth noting *why* this went unnoticed: W-CI's work was complete on disk but
uncommitted, so the tree looked further along than git did. Uncommitted work is
invisible to every audit — this file included.

## Superseded documents

These are kept only for history. Do not act on them:

- `docs/WORKFLOW-RESUME.md` — **deleted 2026-08-02.** Described as outstanding
  the work that `6208892` (Supabase removal + 3 shim bug fixes) and `b6e1741`
  (prompt caching) completed.
- `docs/atlas-audit-2026-07-24.{md,json}` — a point-in-time audit, superseded
- `docs/ATLAS-SPHERE.md`, `CONVERSION.md` — predate the Workshop reskin and the
  local-first migration
- `docs/design-sync/*` — historical design plans; still useful for the *reasoning*
  behind a screen, not for what is outstanding

`docs/decisions/` is missing 001, 003, 004 and 005 — the numbering has gaps and
those ADRs were never written.
