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

### 3. Privacy-policy delta for Bedrock

`atlas-site/public/privacy.html` has an uncommitted delta stating the digest
"now runs on AWS EU". Bedrock **is** live, so this is now overdue rather than
premature. It must deploy with the app build that has the Bedrock provider
active — and must be stashed around any unrelated atlas-site deploy.

### 4. Rotate the Mastercard webhook secret

Exposed in a transcript. Still valid. Security item, user-only.

---

## Open product work

| Item | State | Notes |
|---|---|---|
| **three.js vs canvas sphere** | Decision not taken | Both renderers still ship (~1 MB of three.js). The single largest un-taken decision. `docs/design-sync/2026-07-26-audit-sphere-mail-header.md` P0-1 |
| **Mail Stage 6e** — Gmail/Outlook/IMAP connectors | Not started | The last mail stage. `src/integrations/local/localClient.ts:424` stub is correct until then |
| **Mail 6b–6d runtime verification** | Built, never run | No `mail_*` Tauri command has executed once |
| **Mail sending** | Blocked | Needs Workers Paid; forwarding destination unverified |
| **Atlas Core: Memory tab** | Specified, never built | Plan called for 8 tabs; `AtlasCoreScreen.tsx` has 7 |
| **Atlas Core: fabricated data** | Violates own rule | `AtlasCoreScreen.tsx:88-107` hardcodes results, queue and error log; the Agent tab badge is a static `3`. The design plan's rule is "honest UI, not fake data" |
| **Atlas Teach** | Orphaned | `src/pages/AtlasTeach.tsx` (858 lines) is routed at `/atlas-teach` but linked from nowhere, and is pure Tailwind — it does not match the design system |
| **No manual "add a memory"** | Gap | The *only* way a memory is created is the model choosing to call `memory_store`. There is also no correction/feedback mechanism |
| **Portfolio hero** | Blocked | No holdings data source until Mastercard Open Finance lands |
| **Home floating memory cards** | Not built | Low priority |

## Open release/infra work

- Decide the release-home repo and align the updater endpoint
- Back up the updater private key; set CI signing secrets
- Shrink the download (e5 model out of the sidecar binary)
- Request Bedrock access for Opus 5 / Sonnet 5 / Opus 4.8 (a form, not IAM)
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
