# Continue the Beta redesign in the cloud — 2026-10-28

The Mac session paused both Beta workflows at 12:15 CET because the 5-hour
usage limit stood above 91 % (it resets at 16:29 CET). Everything the agents
had written is on GitHub. This file is what a Claude Code cloud session reads
to pick up from there.

## Where things stand

- `ws-beta-redesign` (PR innovodevelop/atlas#6) holds phases 1–7, merged,
  gated and pushed. Tip: the commit that adds this file.
- `docs/design-sync/2026-10-28-left-out-features.md` lists the 97 left-out
  rows and which package builds each.
- `docs/handoff/2026-10-28-beta-packages.md` holds the exact brief each
  package's agent was given. Read the common brief and the package's own
  section before touching a package.

### The packages

Each started package is one branch, `beta-wip/<package>`, cut from
`ws-beta-redesign` at f65fc14, with ONE commit: the agent's unfinished work
as it stood when the workflow stopped. **None of it has been reviewed and
the gates have not run on it.** Expect half-written files.

| Package | Branch | Rust files | Brain files | State |
|---|---|---|---|---|
| F1 Money | `beta-wip/money` | 1 | 0 | WIP |
| F2 School | `beta-wip/school` | 2 | 0 | WIP |
| F3 Smart Home | `beta-wip/smarthome` | 8 | 0 | WIP |
| F4 Music and Podcast | `beta-wip/music` | 5 | 0 | WIP |
| F5 Clock | `beta-wip/clock` | 4 | 0 | WIP |
| F6 Home and widget screens | `beta-wip/home` | 5 | 0 | WIP |
| F7 Mail | `beta-wip/mail` | 7 | 0 | WIP |
| F8 Answer, Voice, Entry | `beta-wip/answer` | 2 | 5 | WIP |
| F9 Settings and status panels | — | — | — | not started |
| F10 System Status and Model Lab | — | — | — | not started |
| F11 Agent View | — | — | — | not started |
| F12 Browser | — | — | — | not started |
| F13 Dev tools | — | — | — | not started |
| P8a Core, Teach, Architecture bodies | `beta-wip/bodies` | 0 | 0 | WIP |
| P8b Shell accessibility, sphere performance | `beta-wip/shell` | 0 | 0 | WIP |
| P8c Dock styles | `beta-wip/dock` | 0 | 0 | WIP |
| P8d Cutover readiness | `beta-wip/cutover` | 0 | 0 | WIP |

### Update — cloud session, later on 2026-10-28

Steps 1 and 2 below are done.

- **Merged into `ws-beta-redesign`** (`--no-ff`, gates green on each merge):
  `bodies`, `shell`, `dock`, `cutover`. Two cross-package fixes landed with
  them: the dock's hub/capsule sphere now counts toward the shell's
  FRAME_BUDGET (DOCK_SPHERE 2500 → 1800), and `quickSphere.reducedMotion()`
  is exported again (shell dropped it; Architecture uses it).
- **Finished and pushed, NOT merged** — each needs `cargo check` on the Mac
  first; every commit body lists its unverified Rust files:

  | Branch | Tip | Rust / schema | User must provide |
  |---|---|---|---|
  | `beta-wip/money` | 10ed7c4 | bank.rs (new), lib.rs, db_schema.sql | GoCardless secret ID + key; check GoCardless accepts `atlas://bank/linked` (`LINK_REDIRECT`) |
  | `beta-wip/school` | e586fbc | school.rs (new), lib.rs | Lectio calendar link; LearnIT security key |
  | `beta-wip/smarthome` | 7368ff3 | home/{beta,extras,history}.rs (new), ha.rs, mod.rs, store.rs, lib.rs, db_schema.sql | — (existing HA link). Also fixes live HA updates never reaching the screen (bug already on this branch) |
  | `beta-wip/music` | 6716e1d | music.rs, music_engine.rs, control/ops_music.rs, lib.rs, db_schema.sql | Reconnect Spotify once for Like |
  | `beta-wip/clock` | 1d38d4c | clock.rs, control/ops_clock.rs, control/registry.rs, lib.rs | HA TTS engine for ringing on speakers |
  | `beta-wip/home` | 7eda6f5 | datafetch.rs, focus_mode.rs (new), control/ops_data.rs, lib.rs, db_schema.sql | — (existing OpenWeather/NewsAPI keys) |
  | `beta-wip/mail` | 8dbb7d0 | mail.rs, mail_flags.rs, mail_archive.rs (new), gmail.rs, outlook.rs, mail_imap.rs, lib.rs, db_schema.sql | `gmail.modify` scope on the Google consent screen, `Mail.ReadWrite` on the Microsoft app, then reconnect (see docs/mail-setup.md) |
  | `beta-wip/answer` | eda3779 | transit.rs, lib.rs | Rejseplanen access ID; confirm the API base and request link in transit.rs |

  The `mail_imap.rs` calls were checked against the real `imap` 2.4.1 source.
- **Not started:** F9–F13 (step 3).

## What the cloud can and cannot do

The cloud is Linux (see CLAUDE.md, "Environment split").

- **Can:** the React/TypeScript webview, the Bun brain and voice gateway,
  tests, typechecks, lint, reviews, and merging TypeScript-only branches.
- **Cannot:** compile or check the Rust core (it is macOS-only: objc, the
  Keychain, macOS tools), build the app, use the Keychain, or render in
  WKWebView. Rust written in the cloud stays unverified until the Mac runs
  `cargo check`. NEVER run `cargo update` anywhere.
- **Usage:** cloud sessions draw on the same plan limits as the Mac. They do
  not add capacity before the reset; they let the work go on without the Mac.

## The order to work in

1. **TypeScript-only packages first** — `bodies`, `shell`, `dock`, `cutover`.
   For each: check out the branch, finish it against its brief, run the gates
   that run on Linux, commit, push to the same branch, then merge it into
   `ws-beta-redesign` with `--no-ff` and push.
2. **The eight feature packages** — finish the TypeScript and brain parts,
   write the Rust parts the brief asks for, run the Linux gates, commit and
   push to the same `beta-wip/` branch. Do NOT merge these: their Rust must
   pass `cargo check` on the Mac first. List the unverified Rust files in the
   commit body.
3. **The five unstarted packages** — create `beta-wip/<package>` from
   `ws-beta-redesign` and build from the brief. Agent View, Dev tools and
   most of System Status are brain and TypeScript work and fit the cloud;
   the Browser can fetch pages in the brain (Bun) instead of Rust; Settings
   (Wi-Fi, Bluetooth, battery, Mac details) is macOS tooling and is best left
   for the Mac.
4. **Back on the Mac** — merge every remaining `beta-wip/` branch (expect
   additive conflicts in `src-tauri/src/lib.rs`, `src-tauri/src/db_schema.sql`,
   `src/lib/betaHome.ts`, `src/components/atlas/home/widgets.tsx`,
   `src/components/atlas/BetaShell.tsx`, `src/pages/atlas/BetaSettings.tsx`),
   wire any new routes in `src/App.tsx` (admin pages inside the
   `VITE_ATLAS_EDITION` ternary, never a static import), run every gate plus
   `cargo check`, check in the browser preview, do the phone-width pass, and
   build the Mac app for review. Rebuild the brain sidecar in that build
   (`bun run tauri build` runs `bun run build:brain`; anything that reuses
   `src-tauri/binaries/atlas-brain-*` must run it first): the Browser's page
   fetch lives in the brain, and a stale binary answers Go with a 404
   (“not found”).

## Gates that run in the cloud

```bash
bun install
bunx tsc -p tsconfig.app.json --noEmit
bun run typecheck:strict
bunx eslint <changed files>
bun test tests/ ./src ./scripts supabase/functions/_shared
bun test services/
```

`src/editionSplit.test.ts` runs two real Vite builds; it must pass before
any merge into `ws-beta-redesign`.

## Rules that still hold

- Bun only. Never `cargo update`. Never commit secrets: keys live in the
  macOS Keychain, so cloud code reads them through the existing secrets path
  and never hard-codes one.
- The handoff's rule: every visible control does something real, nothing is
  invented, and a feature that needs a key stays dormant and says so.
- Workflows can only run when the user's own message says "use a workflow".
- Commit attribution: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## A prompt to start the cloud session

> Read CLAUDE.md, docs/handoff/2026-10-28-beta-cloud.md and
> docs/handoff/2026-10-28-beta-packages.md. Continue the Beta redesign in the
> order the handoff gives: finish and merge the TypeScript-only packages
> (bodies, shell, dock, cutover) one at a time, then finish the feature
> packages on their beta-wip branches without merging them. Run the Linux
> gates before every commit and push after each package. Stop before
> anything that needs the Mac.
