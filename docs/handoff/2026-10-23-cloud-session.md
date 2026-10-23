# Handoff — cloud session "Atlas - Core Dashboard (fork)", 2026-10-23

Written by the cloud Claude Code session (session_01C78L3DYhTDHvi5adVUDTKh)
so a **local** session on the Mac can continue without its transcript. That
session could push to GitHub but never touched the Mac: nothing below has been
built, installed or run on macOS unless it says so.

Plan state still lives in `docs/VERSION-PLAN.md` (versions/status) and
`docs/ROADMAP.md` (decisions/risks) — this file only says what changed today,
what is unverified, and what to do next. Delete it once it's been acted on.

## 0. First thing to do on the Mac

```bash
cd <the atlas checkout>        # mdfind -name src-tauri finds it
git checkout atlas-redesign && git pull
bun install
bun run build
bun run tauri build --no-sign  # then install the .app to /Applications
```

Then work through **§3 Verify on the Mac**. Every feature merged today passed
CI (`cargo test` on macOS included) but none has run in the real app.

## 1. Merged into `atlas-redesign` today (ac65c96)

All seven branches were merged in one go; CI and the macOS Rust job are green
on the merge.

| Branch | What it does | Key files |
|---|---|---|
| `lens-admin-sync` | Lens v0.3.0 (feat-012/014/018): admin versions, design sync, agent view, changelog from `git log` | `services/atlas-brain/src/adminRoutes.ts`, `src/pages/atlas/AtlasVersions.tsx` |
| `ws-gmail-background-sync` | Gmail syncs every 15 min while Atlas runs (owner instance only); a revoked grant parks the mailbox as `error` with the reason shown in the UI | `src-tauri/src/gmail.rs` (`GmailAutoSync`), `lib.rs` |
| `ws-imap-connector` | Custom IMAP mailboxes: TLS only, `EXAMINE` (read-only), UID cursor, settings+password in Keychain `atlas-imap`; Settings has a connect form | `src-tauri/src/mail_imap.rs`, `AtlasSettings.tsx` |
| `ws-outlook-connector` | Outlook / Microsoft 365 over Graph: public-client PKCE on the loopback, `Mail.Read`, inbox delta query (first sync = last 14 days), rotated refresh tokens re-stored | `src-tauri/src/outlook.rs`, `secrets.rs`, `useMailIntelligence.ts` |
| `ws-roadmap-github-sync` | `/versions` syncs `docs/VERSION-PLAN.md` from GitHub every 5 min via the Mac's `gh` login, and shows a GitHub / Local checkout / Mac app strip plus "GitHub only" badges | `services/atlas-brain/src/planSync.ts`, `vite.config.ts` (`__ATLAS_BUILD_COMMIT__`) |
| `ws-voice-latency` | Each voice turn logs `[latency] speech-end → sttFinal … → firstAudio …`; STT tokens prefetched; final transcript awaited on its event | `services/voice-gateway/src/latency.ts`, `stt.ts`, `session.ts` |
| `ws-wakeword-backbone` | Wake-word backbone swapped to Google `speech_embedding` (Apache-2.0); openWakeWord's NC mel+embedding models deleted. Also fixed a framing bug (5 mel frames per 80 ms instead of 8) | `public/models/speech_embedding.onnx`, `src/lib/wakeWordFraming.ts`, `wakeWordRuntime.ts`, `scripts/wakeword-backbone/` |

Merge conflict resolved: Lens and roadmap-sync both rewrote `syncVersionPlan`.
It now pulls the plan from GitHub (planSync) **and** refreshes the changelog.

## 2. Not merged

- **`ws-e5-download`** (feat-045): the e5 embedding model (~280 MB) is no longer
  compiled into the brain; `services/atlas-brain/src/modelStore.ts` downloads it
  on first use into Application Support beside `atlas.db`, pinned to one
  Hugging Face revision and SHA-256-verified. Brain binary ~390 MB → ~108 MB.
  `.github/workflows/e5-model-pin.yml` ran the real first-launch path in CI:
  768 dims, Danish query 0.852 vs unrelated 0.700. **Status:** the regular CI's
  "Brain sidecar" test step failed once on the runner but all 247 brain tests
  pass locally on Bun 1.3.14 and 1.4.4; a re-run was triggered. Merge once CI
  is green. On the Mac, the first launch after this needs network for semantic
  recall (chat works meanwhile; keyword recall unaffected).
- **`wakeword-backbone-output`**: output branch written by the wake-word CI job
  (ONNX + report). Not source; never merge it.

## 3. Verify on the Mac (nothing here has been run on macOS)

1. **Roadmap sync** — needs `gh auth status` OK on the Mac. Open `/versions`:
   the strip should say GitHub ✓, Local checkout ✓ (it looks in `~/atlas`,
   `~/Developer/atlas`, `~/Projects/atlas`, … — else set `ATLAS_REPO_DIR`),
   Mac app ✓ (only for builds made after today; older builds didn't stamp a
   commit).
2. **Wake word** — say "Hey Jarvis" (still the only phrase model). Detection
   should work, likely better than before because of the framing fix. Watch
   for false triggers; per-model threshold is in `src/lib/wakeWord.ts`.
3. **Voice latency** — launch Atlas from Terminal and read the `[latency]`
   lines from a few voice turns; the largest `(+N ms)` stage is the next thing
   to cut (feat-025).
4. **Gmail** — connect + Scan now; leave Atlas open 15+ min and confirm new mail
   arrives without pressing Scan.
5. **IMAP** — Settings → Mail → Connect another mailbox (IMAP), e.g. iCloud
   with an app-specific password from appleid.apple.com.
6. **Outlook** — needs a Microsoft app registration first (user step, steps in
   `docs/mail-setup.md` → "Outlook and Microsoft 365"): public client,
   redirect `http://127.0.0.1`, delegated `Mail.Read` + `User.Read` +
   `offline_access`, then put `microsoft_oauth_client_id` in the `atlas-core`
   Keychain blob via `secrets-import`.

## 4. Decisions waiting on Magnus

- **Hey Atlas training data (feat-024):** Mozilla Common Voice (CC0, cleanest,
  needs a Hugging Face account that accepted the dataset terms + a token in CI)
  vs LibriSpeech (CC BY 4.0, attribution, no account). The training job would
  run in GitHub Actions on embeddings from `speech_embedding.onnx`;
  `scripts/train-wakeword/` still points at openWakeWord's NC negative features
  and must be changed either way.
- **Mail sending (feat-021):** blocked on Cloudflare Workers Paid / SES.
- **Old branches:** the merged `ws-*` branches and `lens-admin-sync` can be
  deleted on GitHub once the Mac build is verified.

## 5. Roadmap after this

v0.4.0 Waypoint: feat-020 connectors all built (each needs its first real
sign-in), feat-022 mail runtime verification (Mac), feat-023 backbone done /
phrase model pending (= feat-024), feat-025 latency instrumented (needs Mac
numbers). v0.6.0 Drydock: feat-045 on `ws-e5-download`; feat-040/041 release
pipeline (`docs/RELEASE.md`; no release has ever been cut), feat-042 privacy
policy deploy, feat-043 Atlas Teach redesign, feat-044 home memory cards.

## 6. Things learned the hard way

- The cloud sandbox can't reach Hugging Face, TF Hub, Kaggle or GitHub's
  log/artifact blob storage. Workarounds used: run the step in GitHub Actions,
  surface results as **job annotations** (readable via `gh api`) or push them
  to an output branch. The Mac has none of these limits.
- `gh` launched from a Finder-started app gets launchd's PATH; `planSync.ts`
  looks in `/opt/homebrew/bin` and `/usr/local/bin` for that reason.
- `tensorflow-hub` must stay at 0.15.0 for the backbone conversion (`hub.Module`
  was removed in 0.16).
- Merge order for the mail branches was Gmail → IMAP → Outlook (each was
  stacked on the previous); all are in `atlas-redesign` now.
