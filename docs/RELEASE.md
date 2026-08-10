# Atlas — Release Runbook

How to ship a new version of the Atlas macOS app, how the auto-updater feed
works, and how to recover when a bad build ships. Written for a solo founder:
every step is a concrete command.

**TL;DR:** bump the version → commit → push a `vX.Y.Z` tag → CI builds a
**draft** GitHub Release → you verify → you click **Publish** → the in-app
updater picks it up.

---

## 1. The two signing systems (don't confuse them)

Atlas releases involve **two completely independent** signing mechanisms:

| | What it protects | Key type | Status today |
|---|---|---|---|
| **Updater signing** | Every auto-update is verified before install (minisign signature checked against the public key baked into the app) | minisign keypair from `bunx tauri signer generate` | **Works today**, on the key rotated 2026-08-10 (`84E81AF87B3CA4D9`). No Apple account needed. This is what enforces "Atlas never installs an unverified update" — but read the endpoint warning below before trusting that sentence end to end. |
| **Apple code signing + notarization** | macOS Gatekeeper trust for *fresh installs* (no "unidentified developer" warning) | **Developer ID Application** certificate | **Not possible yet.** Requires the paid Apple Developer Program (~99 USD/yr), which is not purchased. The "Apple Development" certificate already on the Mac **cannot** be used — it is for local dev/device testing only and cannot notarize or distribute. |

The release workflow (`.github/workflows/release.yml`) treats Apple signing as
optional: with no Apple secrets it produces an **unsigned** build (current
state); the moment the Apple secrets exist, signing + notarization activate
automatically. Updater signing is **mandatory** — the workflow fails fast if
`TAURI_SIGNING_PRIVATE_KEY` is missing.

### What "unsigned" means for users, today

- Fresh installs: macOS Gatekeeper will block double-click launch. Users must
  right-click the app → **Open** → **Open** (once), or run
  `xattr -cr /Applications/Atlas.app`. Say this plainly on the download page.
- Auto-updates: unaffected. The updater downloads, minisign-verifies, and
  installs regardless of Apple signing. Update integrity is enforced either way.

---

## 2. Secrets — what must exist and where to get them

All secrets live in **GitHub → repo → Settings → Secrets and variables →
Actions**. None of them ever go in the repo.

### The updater keypair — where it actually is

**The keypair lives at `~/.tauri/atlas-updater.key`** (private, `chmod 600`) +
`~/.tauri/atlas-updater.key.pub`. Its public key ID is `84E81AF87B3CA4D9`, and
the `plugins.updater.pubkey` value committed in `src-tauri/tauri.conf.json` is
the public half of **this exact keypair** — verified by signing a file and
comparing the key ID embedded in the signature (bytes 2..10 of the decoded
signature, reversed) against the key ID in the committed public key.

#### Rotation log

| Date | Key ID | Why it changed |
|---|---|---|
| 2026-07-25 | `2DBFE39C42EDA4CE` | First keypair. **BURNED** — the private key appeared in a chat transcript. |
| 2026-08-10 | `84E81AF87B3CA4D9` | Rotation. In force. |

The burned pair was **not deleted**: it is archived as
`~/.tauri/BURNED-2026-08-10-atlas-updater.key{,.pub}` (`chmod 600`), renamed so
it cannot be picked up by the documented path or by habit. It is kept for one
reason only — it is the sole key that could sign a migration build for a copy of
Atlas installed *before* the rotation. **It must never sign a new release.**

Rotating was free this time and will not be next time: `gh release list` showed
**zero releases** on both remotes, so no installed copy had ever accepted an
update signed by the old key and there was nobody to migrate. Once a signed
release exists, a rotation costs every user a manual reinstall.

> **Invariant:** `plugins.updater.pubkey` must always be the public half of the
> key used by `TAURI_SIGNING_PRIVATE_KEY`. Running `tauri signer generate`
> again creates a *different* keypair — if you do that, you **must** also
> replace the pubkey in `tauri.conf.json`, and every already-installed copy of
> Atlas stops accepting updates forever.

**Two things you still owe (do them before the first `v*` tag):**

1. Copy the contents of `~/.tauri/atlas-updater.key` into the GitHub secret
   `TAURI_SIGNING_PRIVATE_KEY` on **the repo the updater endpoint actually
   points at** (see the warning below — that is currently unresolved), and set
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an **empty string**. Use
   `gh secret set TAURI_SIGNING_PRIVATE_KEY --repo <repo> < ~/.tauri/atlas-updater.key`
   rather than copy-paste: piping a file never puts the key on a screen, in a
   clipboard, or in a scrollback buffer, which is how the last one was lost.
2. Back the private key file up somewhere outside this Mac (password manager /
   encrypted backup). `~/.tauri/` is not backed up by anything. If the key is
   lost, existing installs can never accept another update — their baked-in
   public key won't match any new keypair — and every user must manually
   reinstall.

> ⚠️ **The updater endpoint points at a repo this machine cannot push to.**
> `plugins.updater.endpoints` is
> `https://github.com/HelloAtlasAI/helloatlas/releases/latest/download/latest.json`,
> and `gh api repos/HelloAtlasAI/helloatlas` reports `push: false, admin: false`
> for the signed-in account (`innovodevelop`) on a **public** repo. Whoever
> controls that repo controls what every installed Atlas is offered as an
> update; the signature check is the only thing standing behind it. Either
> obtain admin on it or repoint the endpoint at a repo we do control, and do it
> before the first release — not after. Tracked as the "release home repo"
> decision.

| Secret | What it is | Value |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | minisign private key **content** (the whole file, one base64 line) | `cat ~/.tauri/atlas-updater.key` → paste |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password chosen at generation | empty string |

The matching **public** key is the only piece that goes in the repo. Never
commit, print, echo, or paste the private key anywhere else — treat any key
that has appeared in a terminal transcript or chat log as burned, and rotate it
(regenerate + update `tauri.conf.json`) before shipping.

### Required later (Apple — after buying the Developer Program)

| Secret | What it is | How to get it |
|---|---|---|
| `APPLE_CERTIFICATE` | base64 of the **Developer ID Application** cert exported as `.p12` | Join the Apple Developer Program → Certificates → create *Developer ID Application* → download, import into Keychain Access, export as `.p12` with a password → `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password | You chose it during export |
| `APPLE_SIGNING_IDENTITY` | the identity string, e.g. `Developer ID Application: Magnus Pilegaard (TEAMID)` | `security find-identity -v -p codesigning` after importing the cert |
| `APPLE_ID` | Apple ID email for notarization | — |
| `APPLE_PASSWORD` | **app-specific password** (not the account password) | appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | 10-char team ID | developer.apple.com → Membership |

No workflow change is needed when these appear — the next tagged release is
signed and notarized automatically.

---

## 3. Version scheme

- **Semver** `MAJOR.MINOR.PATCH` (currently `0.x`: `MINOR` = features,
  `PATCH` = fixes).
- **Source of truth: `src-tauri/tauri.conf.json` → `"version"`.** That value is
  what the bundler stamps into the app and what `latest.json` advertises to the
  updater. (`src-tauri/Cargo.toml` and the root `package.json` versions are not
  used by the updater; keeping Cargo.toml in sync is nice-to-have, not
  required.)
- The git tag must be exactly `v<version>` (e.g. version `0.2.0` → tag
  `v0.2.0`). The workflow **fails the build if they don't match**, so you can't
  ship a mislabeled update feed.
- The updater only moves **forward**: an install at 0.2.0 ignores any feed
  advertising 0.2.0 or lower. This matters for rollback (§6).

---

## 4. Cutting a release

```bash
# 0. Be on a clean, pushed branch with CI green.

# 1. Preflight locally (macOS):
bun run build
(cd services/atlas-brain && bunx tsc --noEmit && bun test)
(cd services/voice-gateway && bunx tsc --noEmit)
(cd src-tauri && cargo check && cargo test)   # cargo test covers integrity.rs's tamper/refusal gate
# Also confirm no VITE_PREVIEW_NOAUTH leaked into dist/ (per CLAUDE.md ship flow).

# 2. Bump the version in src-tauri/tauri.conf.json ("version": "0.2.0"),
#    commit it:
git add src-tauri/tauri.conf.json
git commit -m "release: v0.2.0"
git push

# 3. Tag and push the tag — this triggers the release workflow:
git tag v0.2.0
git push origin v0.2.0
```

Then:

4. Watch **Actions → Release** on GitHub (~15–25 min: frontend + two Bun
   sidecar compiles + full Rust build).
5. The workflow creates a **draft** release named `Atlas 0.2.0` with these
   assets: `Atlas_0.2.0_aarch64.dmg` (human download), `Atlas.app.tar.gz` +
   `Atlas.app.tar.gz.sig` (updater payload + minisign signature), and
   `latest.json` (the update feed manifest). After the build, CI recompresses
   the `.dmg` as ULMO (LZMA, ~25-30 MB smaller) via `scripts/compress-dmg.sh`
   and replaces the draft asset under the same name; the updater payload
   (`.app.tar.gz` + `.sig`) is never rewritten — minisign signed those exact
   bytes.
6. **Verify before publishing** (the draft is your safety gate):
   - Download the `.dmg`, install, launch (right-click → Open while unsigned),
     smoke-test chat + voice.
   - Open `latest.json` and check the `version` field and that the download URL
     points at this release.
7. Click **Publish release**. This is the moment the update goes live: the feed
   URL `.../releases/latest/download/latest.json` now resolves to this release,
   and running installs pick it up on their next update check, verify the
   `.sig`, and install.

A `workflow_dispatch` run of the same workflow does a **dry-run build** (no
release created; bundle attached as a workflow artifact) — useful for testing
the pipeline without burning a version number.

---

## 5. How the updater feed works

> **⚠ Unresolved: which repo is the release home?** The endpoint below names
> `HelloAtlasAI/helloatlas`, but the working branch is pushed to the fork
> `innovodevelop/helloatlas-1`, and the authenticated account has **no push
> access** to `HelloAtlasAI/helloatlas`. A tag pushed to the fork publishes the
> release *on the fork*, while shipped apps would poll `HelloAtlasAI` — a feed
> that 404s forever. Pick one before the first `v*` tag:
>
> - **Release from the fork** → change `plugins.updater.endpoints[0]` in
>   `src-tauri/tauri.conf.json` to
>   `https://github.com/innovodevelop/helloatlas-1/releases/latest/download/latest.json`.
> - **Release from `HelloAtlasAI/helloatlas`** → get push access to that repo
>   and push tags there; the endpoint is already correct.
>
> The `Verify updater endpoint points at this repo` step in `release.yml` fails
> the build if these disagree, so this cannot ship wrong silently — but it also
> means a tag pushed to the fork fails until one of the two is done.

- The app's updater config (in `src-tauri/tauri.conf.json`, `plugins.updater`)
  points at the static URL
  `https://github.com/HelloAtlasAI/helloatlas/releases/latest/download/latest.json`.
  GitHub redirects that to the **latest published, non-prerelease, non-draft**
  release — which is why "publish the draft" is the go-live switch and drafts
  are invisible to users.
- `latest.json` contains the new version, release notes, the download URL of
  `Atlas.app.tar.gz`, and its minisign **signature**.
- The app compares versions, downloads the archive, **verifies the signature
  against the public key compiled into the binary**, and only then installs and
  relaunches. A tampered or unsigned archive is rejected — this is the invariant
  "Atlas never modifies its running binary; updates arrive through a separate,
  dumb, verifying updater".

---

## 6. Rollback to N-1

Two separate problems — do both when a bad build ships:

### A. Stop the spread (users still on N-1)

Un-publish the bad release so the feed points back at N-1:

```bash
# fastest: flip the bad release back to draft
gh release edit v0.2.0 --draft
# (or mark it a prerelease: gh release edit v0.2.0 --prerelease)
```

`releases/latest` immediately resolves to the previous published release, so
nobody else receives the bad update. Do this **first** — it takes seconds.

### B. Rescue users who already updated (on N)

The updater **never downgrades** (it only installs versions greater than the
running one), so you cannot "re-point" them at N-1. Ship the old code under a
**new, higher** version:

```bash
# branch from the last good tag
git checkout -b hotfix/rollback-0.2.1 v0.1.0        # v0.1.0 = last good
# bump version in src-tauri/tauri.conf.json to 0.2.1, commit
git commit -am "release: v0.2.1 (rollback of v0.2.0)"
git push -u origin hotfix/rollback-0.2.1
git tag v0.2.1 && git push origin v0.2.1
```

Verify the draft, publish, and everyone — including users stuck on the bad
0.2.0 — updates forward onto the good code.

### Bad-build incident checklist

1. `gh release edit vBAD --draft` (stops new installs/updates — seconds).
2. Decide: is a real fix quick, or roll back? When in doubt, roll back (§6B) —
   a fix can follow at its own pace.
3. Cut the rollback/hotfix version, verify the draft **thoroughly** this time,
   publish.
4. If the bad build corrupted local state (SQLite in
   `~/Library/Application Support/`), the new release must handle/migrate that
   state — a rollback alone won't repair user data. Test with a copy of an
   affected profile before publishing.
5. Post-mortem: add whatever check would have caught it to the local preflight
   (§4 step 1) or CI.

---

## 7. Honest limitations, today

- **No notarization / no Apple signing** until the Developer Program is
  purchased and a *Developer ID Application* cert exists. Fresh installs need
  right-click → Open. There is no workaround worth doing (ad-hoc signing does
  not help Gatekeeper for downloaded apps).
- **No Intel (x86_64) builds.** The pipeline builds Apple silicon only —
  matching the `aarch64-apple-darwin` sidecar binaries. Universal builds would
  require compiling both sidecars per-arch first; out of scope for now.
- **First release bootstrap:** until the first `v*` tag is pushed *and*
  `TAURI_SIGNING_PRIVATE_KEY` is set in GitHub secrets, no release exists and
  the feed URL 404s. The app's updater treats that as "no update available" —
  harmless.
- **Losing the updater private key is unrecoverable** for existing installs
  (see §2). Back it up now, outside the repo.
- **A plain local `bun run tauri build` now fails at the bundling step** with
  *"A public key has been found, but no private key"*. That is by design:
  `createUpdaterArtifacts: true` + a configured `pubkey` make minisign signing
  mandatory, and the key is not an env var by default. For a local install
  (not a release), skip signing:

  ```bash
  bun run tauri build --no-sign
  ```

  To shrink the resulting `.dmg` the same way CI does (ULMO recompression,
  ~25-30 MB smaller — human download only, never the updater archive):

  ```bash
  bash scripts/compress-dmg.sh src-tauri/target/release/bundle/dmg/*.dmg
  ```

  To produce a *real*, updatable bundle locally, export the key first:

  ```bash
  export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/atlas-updater.key)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  bun run tauri build
  ```

  Releases come from CI, which does exactly this from the GitHub secrets. The
  failure surfaces ~15 minutes into the build, after the Rust compile — hence
  this note.
- **The webview holds the `updater:default` capability**, so any JS running in
  it can call `downloadAndInstall()` without the button in
  `SoftwareUpdatePanel`. The blast radius is bounded — the artifact must still
  pass minisign verification, so at worst a *genuinely signed newer release*
  gets installed without a click — but "install only on explicit user action"
  is currently a convention in `useAppUpdater.ts`, not an enforced permission.
