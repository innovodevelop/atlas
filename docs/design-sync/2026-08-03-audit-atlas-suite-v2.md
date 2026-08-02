# Audit — `design_handoff_atlas_suite_v2` vs the Atlas app

**Date:** 2026-08-03
**Branch:** `atlas-redesign` (HEAD `ced022e`)
**Handoff:** `Atlas premium polish (5).zip` → `design_handoff_atlas_suite_v2/` (35 files, 22 `.dc.html`)
**Supersedes:** nothing. Complements `2026-07-26-audit-sphere-mail-header.md` and `2026-07-27-mail-contract.md`.

This is the audit gate for the four-track redesign. It contains no implementation.

## How this was produced, and what it can and cannot claim

- The app was run on the Vite dev server (`bun run dev`, port 8080) and every route was
  visited. Observations marked **[observed]** were seen at runtime. Observations marked
  **[code]** are read from source and were not exercised at runtime.
- **Layout defects are not claimed from screenshots.** The preview pane's capture pipeline
  desynced from the viewport repeatedly during this session (tiling the image, cropping to a
  quadrant). Two apparent layout bugs were disproved by measuring the DOM instead
  (`/atlas-core-legacy` appeared clipped; `scrollWidth === clientWidth === 1100`, no overflow).
  Every layout claim below is backed by a DOM measurement or by source, never by a screenshot.
- **The dashboard and Mail were not exercised at runtime.** Both redirect to `/auth` and
  auth was not attempted (see A.2). They are audited from source and are marked **[code]**.
- `.claude/launch.json` was created to run the dev server through the preview tooling. It is
  the only file changed by this audit besides this document.

---

# A · Phase 0 — what actually renders

## A.1 Route table

| Route | Renders? | Notes |
| --- | --- | --- |
| `/` | **Redirects → `/permissions`** | First-run `OnboardingGate` (`src/components/OnboardingGate.tsx:30`). After the onboarding record exists, redirects → `/auth`. |
| `/dashboard` | **Redirects → `/auth`** | Auth guard `src/pages/atlas/AtlasDashboard.tsx:108`. |
| `/home` | Yes | Greeting + composer + suggestion chips. |
| `/atlas-core` | Yes | 7 tabs, 4 stat tiles, 2 cards. **Serves fabricated data.** |
| `/mail` | **Redirects → `/auth`** | Auth guard `src/pages/atlas/AtlasMail.tsx:58`. |
| `/auth` | Yes | Split login, typewriter headline, two choice rows. |
| `/permissions` | Yes | 4 toggles + continue/not-now. |
| `/atlas-sphere` | Yes | Canvas vs WebGL comparison, 10 state chips, 4-control editor. |
| `/atlas-architecture` | Yes | Old orange design, Mermaid diagram, 5 tabs. |
| `/atlas-teach` | Yes | Voice-first surface, heavily orange, stuck on "Connecting…". |
| `/atlas-demo` | Yes | Dark sphere tuning lab, "Visual Controls", auto-save + import/export. |
| `/atlas-core-legacy` | Yes | 9 tabs incl. **Memory** and **Errors**. Honest empty states. |
| `*` (404) | Yes | Generic scaffold copy: "Oops! Page not found". |

**Console: no runtime errors on any route.** The only messages across the whole walk were
React Router v7 future-flag warnings, six framer-motion warnings
(`You're attempting to animate multiple children within AnimatePresence, but its mode is set
to "wait"` — from `src/components/atlas-health/AtlasCoreDashboard.tsx:314`,
`BrainActivityPanel.tsx:92`, `BrainSearchPanel.tsx:322`, `src/pages/AtlasTeach.tsx:620`), and
the app's own deliberate 404 log. Nothing threw.

## A.2 The auth wall

`/dashboard` and `/mail` are the only guarded routes. Auth was **not** attempted — no
credentials were entered anywhere. Consequently the dashboard overlays (weather, calendar,
tasks, stocks, email, news, music) and the Settings overlay **could not be opened at runtime**
and are audited from source only.

Two things worth recording about the gate itself:

1. **`VITE_PREVIEW_NOAUTH` no longer exists in code.** It survives only as a ship-flow check
   in `docs/RELEASE.md:123` and in `CLAUDE.md`. Grepping `src/` returns nothing. The
   documented pre-ship verification step therefore checks for a string that can never appear.
2. To reach `/dashboard` past the *onboarding* gate, the local record
   `atlas.onboarding.v1` was written directly to localStorage (all four choices recorded,
   `microphone`/`notifications` false). This triggers no OS permission prompt —
   `requestPermission()` (`src/lib/atlasPermissions.ts:104`) was never called. It only moved
   the gate; the *auth* wall behind it still held.

## A.3 Per-route observations

**`/auth`** [observed] — Flat `#3461f2` field, `atlas` wordmark top-left. Typewriter headline
"Hey — I'm Atlas. Have we met before?" over a ghost of the target word. Serif italic subline
"Tell me where to begin." Two choice rows: "Yes, we've met before" / "No, we're just meeting".
Footer "By continuing, you agree to our Terms & Privacy Policy." Two canvases render
(`.authbgcv`, `.authorbcv`), both at `2200×1440` for a `1100×720` box — **DPR 2, uncapped**.

**`/permissions`** [observed] — Same blue field and `AuthSphere`. Headline "Before we start",
serif subline *"Switch off anything you would rather I did not have. **You can change it
later.**"* Four toggles with honest blurbs; Microphone / Notifications / Live data on,
Proactive digest off — matching `defaultOn` in `src/lib/atlasPermissions.ts:32-68`.
Primary action "Continue with 3 selected →", secondary "NOT NOW" in letterspaced caps.

**`/home`** [observed] — Page `#f9f7f4`-ish with a large blurred **purple/lavender** wash (not
Atlas Blue). Header: black rounded-square mark + a very low-contrast `ATLAS` wordmark, a
"Listening" pill, two icon buttons, a `T` avatar. Headline "**Good morning, there**" — the
name is missing and falls through to "there". Subline "I'm Atlas, your **neural interface** —
ask me anything." Composer pill "Message Atlas…" with mic + blue send. Chips: Check emails ·
Search flights · Stock analysis · Create document · Atlas Core. **No dock.**

**`/atlas-core`** [observed] — Header "Atlas Core / INTELLIGENCE CENTER", "Back to Dashboard".
Four stat tiles: KNOWLEDGE `0`, RESEARCH `0`, ERROR RATE `0.0%`, HEALTH `100%`. Seven tabs:
Search · Overview · Live · Agent · Knowledge · Research · Learning. **No Memory tab.**

This route serves **fabricated data on live surfaces**:

- `src/pages/atlas/AtlasCoreScreen.tsx:46` — a hardcoded `+12% from last period` trend
  attached to a real value that is `0`. The screen reads "0, +12% from last period".
- `:72-74` — `1,204 docs/hr`, `18 pipelines`, `99.2% pass` with hardcoded bar widths
  `82% / 64% / 99%`, sitting directly above a real `Indexed — 0 total`.
- `:80-83` — four invented knowledge rows with invented provenance and relevance scores
  ("Transformer scaling laws — 2026 review · arXiv · indexed 4 min ago · 0.94 relevance").

The **legacy** screen it replaced is honest about the same emptiness — `/atlas-core-legacy`
renders "Waiting for data…", "No knowledge entries yet", "No errors to display". This is a
regression in data honesty, not merely unfinished wiring.

**`/atlas-sphere`** [observed] — "The sphere, every state." Canvas and WebGL mounted side by
side with the caption *"Both renderers on the same state. The canvas one implements all ten
natively; the WebGL one maps onto six, which is why `success` and `alert` look alike there."*
Ten state chips; `waking` and `dissolving` badged **CUT** with reasons rendered in the UI
("Cut: a 1.6s intro only delays first paint" / "Cut: a desktop app is quit, not logged out").
Editor: Particle amount `26.0k`, Particle density `0.70`, Particle size `×0.60`, Colour
softness `0/10`, Reset. **No morph, no field, no `amp`, no `pulse`, no `palette` control.**

**`/atlas-architecture`** [observed] — The old design, unchanged. The active "Overview" tab
pill renders **orange**, as does the section icon — the clearest live proof of the
`--primary` problem (A.5). Tabs: Overview · AI Providers · Memory · Learning · Sphere.
The system diagram is **Mermaid**, which the handoff explicitly replaces with artwork.

**`/atlas-teach`** [observed] — The most orange surface in the app: orange mic button, orange
"Connecting…" pill, orange "Atlas" inline in the copy, warm orange background wash. Copy:
"Tap the microphone to enable voice, then say "Atlas" to start." / "Share your name,
interests, values, or anything you'd like me to remember." The "Connecting…" state never
resolves in the browser — the voice gateway sidecar is not running.

**`/atlas-demo`** [observed] — Dark surface, "Atlas Core Demo" in orange, an "Auto-saved"
amber pill, import/export buttons, a "Visual Controls" panel with Global Settings /
Visualization Mode / "Nebula Flow". A 1133-line particle tuning lab — the largest page in
the repo, and **absent from the handoff's repo map entirely** (see C.3).

**`/atlas-core-legacy`** [observed] — Nine tabs: Search · Overview · Live · Agent · Knowledge ·
Research · Learning · **Memory** · **Errors**, plus Settings and Refresh. Orange wordmark and
orange tab pill. Honest empty states throughout. One real content bug: the heading
**"Real-time Data Flow" renders twice** in succession (card title, then the empty-state title).

**404** [observed] — "404 / Oops! Page not found / Return to Home". Off-brand scaffold copy
inherited from the original Lovable template.

## A.4 The `AuthSphere` blank-canvas false alarm

Mid-walk both `/permissions` canvases sampled as fully transparent. This is **not** an app
bug: `document.visibilityState` was `hidden` because the preview pane backgrounds the tab
between calls, and both render loops correctly early-return on `document.hidden`
(`src/pages/AuthSphere.tsx:73`, `:114`). Particles render correctly whenever the pane is
foregrounded. Recorded here so it is not re-investigated.

One genuine latent issue in the same file, from source: **[code]** `AuthSphere.tsx:108`
computes the particle count **once** at effect setup from `el.clientWidth * el.clientHeight /
120`, and never recomputes. `fit()` is re-run on resize (`:147`) but `count` and `pts` are
not — so the orb keeps its first-paint density forever, and a mount at zero size yields a
permanently empty orb.

## A.5 Token reality, measured at runtime

Read from the live document on `/atlas-core`:

| Token | Runtime value | Means |
| --- | --- | --- |
| `--primary` | `25 100% 50%` | **`#ff6a00` — orange** |
| `--ring` | `25 100% 50%` | **`#ff6a00` — orange** |
| `--negative` | *(empty)* | **undefined** |

`src/index.css:21,41` declares both as orange with a `/* #3461f2 */` comment sitting beside
the wrong value. It feeds Tailwind `primary`, and `src/App.tsx:105` renders
`border-2 border-primary` — so the app's loading spinner is orange too.

**Fonts, measured by fallback-width comparison** (the reliable test; `document.fonts.check`
returns true for anything the fallback can render and must not be used):

| Family | Result |
| --- | --- |
| Geist | **available** |
| Hanken Grotesk | **available** |
| Sora | **missing — falls back** |
| Manrope | **missing — falls back** |
| Inter | **missing — falls back** |

`public/fonts/` contains only Geist, Hanken Grotesk and Newsreader. `'Sora'` appears **22×**
in `src/styles/workshop.css` and **2×** in `src/styles/mail.css` (24 total); `'Manrope'` 1×;
`'Inter'` 1×. Every one of them renders as system-ui today.

Other given findings confirmed by grep: `#eef2fe` — **0 occurrences**. `--negative` — **9
uses, 0 definitions**. `src/App.css` — **0 importers**.

## A.6 Music probe — does Spotify audio actually play?

**Honest answer: this cannot be confirmed from the dev server, and was not confirmed.**

`window.__TAURI_INTERNALS__` is **absent** [observed], so `isTauri`
(`src/hooks/useMusicPlayer.ts:10`) is false and every music command early-returns. No
`music_status` call is made, no listener fires, `levelRef` stays `{amp:0,bands:[0,0,0]}`.
**No playback was observed and none is claimed.**

What the code path requires, traced end to end **[code]**:

1. `music_status` (`src-tauri/src/music.rs:226-243`) reports three independent things:
   - `connected` ← `secrets::music_refresh_token().is_some()` (`:227`) — a Spotify refresh
     token in the Keychain, i.e. OAuth completed.
   - `premium` ← a **live** `/me` call asserting `product == "premium"` (`:228-233`). Not
     cached; a network failure reports `false`.
   - `audio_ready` ← `state.engine.lock().unwrap().is_some()` (`:234`) — **true only after
     the librespot engine has been spawned**, which `ensure_engine` (`:247`) does *lazily on
     first play*. So `audio_ready` is `false` on a cold launch even for a fully entitled
     Premium user; it is a "has played since launch" flag, not a capability flag.
2. `music:level` is emitted at `src-tauri/src/music_engine.rs:283`, inside the librespot audio
   sink's `write` path, throttled to 33 ms (~30 Hz), and **only** when the packet is a
   non-empty `AudioPacket::Samples`. It is a by-product of real PCM decode — it cannot fire
   without actual audio flowing.
3. `src/hooks/useMusicPlayer.ts:290` listens and writes `levelRef.current` without a
   re-render, for an animation loop to read.

So the chain is: Keychain refresh token → Premium → `ensure_engine` spawns librespot → PCM
decodes → `music:level` at 30 Hz. Every link is compiled in — `librespot-core 0.8` and
`librespot-playback 0.8` (rodio backend) are real dependencies at
`src-tauri/Cargo.toml:39-40`, and `CLIENT_ID` is hardcoded and public-safe at
`src-tauri/src/music.rs:31` (PKCE, no secret).

**What could only be confirmed in a packaged build:** whether OAuth has actually been
completed on this Mac, whether the account is Premium, whether `ensure_engine` succeeds, and
whether `music:level` ever fires. Ship a build, play a track, and watch for the event.

**Consequence for the redesign:** Music Player v2 (README §5) is specified to drive formation
(`playing → field`, `paused → sphere`), `amp`, `pulse` and every chrome colour from live
audio. Track 3 must therefore either (a) gate on a verified packaged build, or (b) build
against `levelRef` with a defined zero-signal fallback — a paused sphere at `amp = 0` — so the
surface is not dead when audio never arrives. This is a decision, not a detail (see E).

---

# B · Audit A — code vs the **previous** handoff

Against `2026-07-26-audit-sphere-mail-header.md` and `2026-07-27-mail-contract.md`.

## B.1 Shared sphere renderer

### Shipped

| Item | Evidence |
| --- | --- |
| P0-5 remount bug — registration moved to a `WeakMap` | `src/lib/atlasSphere.ts:280`, prune `:318-322`, `mount()` early-return `:377-378`; test `atlasSphere.test.ts:96-113` |
| P0-4 watchdog restarts rather than drives the loop, and bails while hidden | `atlasSphere.ts:350-363`; test `:115-130` |
| `raf` + `guard` cancelled at zero entries | `stop()` `:340-345`, called from `frame()` `:327` and `unmount()` `:395`; test `:132-143` |
| Empty `try/catch` replaced by logged-once `safePaint` | `:298-309`; test `:158-175` |
| DPR re-read per paint, with rationale | `:140`, `:144-145` |
| Off-screen check made horizontal too | `:293-294`; test `:184-191` |
| P2-15 cache thrash — single-entry eviction | `:84-87` |

### **`prefers-reduced-motion` is SHIPPED — the handoff's claim is false**

README §3 closes with *"Still open from the last handoff and **still not honoured**:
`prefers-reduced-motion`."* This is **incorrect**, and correcting it matters because the
handoff asks for a decision that has already been made and locked:

- `reduceMotion()` — `src/lib/atlasSphere.ts:284-286`
- `start()` short-circuits to a single `paintOnce()` — `:348`
- `paintOnce()` — `:331-338`; `refresh()` re-paints on state change only — `:403-405`
- **Live** `matchMedia` `change` listener, so toggling the OS setting takes effect without a
  reload — `:368-373`
- Locked by tests — `src/lib/atlasSphere.test.ts:66`, `:145`
- Plus a global CSS kill-switch — `src/styles/workshop.css:1137-1143`

The shipped answer to the handoff's open question 2 is therefore **"static sphere, re-painted
only on state change"**. The question should be closed, not re-opened — unless the user
actively wants to revisit it now that a `morph` scalar exists (see E).

### Drifted

| Item | Verdict |
| --- | --- |
| Gallery editor presets in `localStorage`, not the app DB (audit §3.5 asked for SQLite) | **Deliberate.** `AtlasSphereGallery.tsx:42,44` carries the rationale: *"Developer tuning, not user data."* The audit's reasoning was about user data and the erase path; slider positions on an unlinked QA route are neither. |
| **P0-1 canvas vs WebGL — "keep both behind a flag"** | **Deliberate then drifting.** There is no flag; both are mounted only on `/atlas-sphere` (`AtlasSphereGallery.tsx:130,137-144`). The canvas renderer — the one that received every Stage-1 fix — **is used nowhere in the product.** The dashboard, `/atlas-core`, the expanded views and the drawer all still render WebGL (`AtlasDashboard.tsx:202`), and three.js is still fully bundled. The decision was left to the user and has not been taken; the cost is now visible as divergence (see the `aria-hidden` row below). |
| DPR caps diverge across four renderers | `atlasSphere.ts:140` caps at **1.5**; `sphereConfig.ts:35,68-70` at **2**; `MusicSphere.tsx:202` at **2**; `AuthSphere.tsx:62,101,103` at **2**. No shared constant, and no comment explains why 1.5 is the outlier. Neither doc specifies a cap, so this is an undocumented divergence rather than a doc drift. |

### Missing

| Item | Verdict |
| --- | --- |
| P1-11 `aria-hidden` on the sphere canvas | **Accidental.** Shipped on the canvas renderer (`atlasSphere.ts:381`) — but **not on the WebGL sphere, which is the one users actually see.** `src/components/atlas/AtlasSphere.tsx:110-122` is an unlabelled clickable `div` wrapping a `<Canvas>`; zero `aria-` attributes in the file. The audit's recommendation was renderer-agnostic. |
| §3.6 battery / low-power tier (`countScale: 0.5`, 50 ms frame cap) | **Accidental.** `countScale` exists as a knob (`:62`, `:135`) but nothing drives it; no `getBattery`/`lowPower` anywhere in `src/`. Frame cap is fixed at 26 ms (`:314`). No comment records a decision to skip it. |
| P2-14 dead dark `body{}` rule + Manrope/Sora declarations | **Accidental.** `src/styles/workshop.css:20` still sets `background:hsl(240 28% 7%)` and `font-family:'Manrope',…`, overridden by `:321`. `.wordB`'s Sora at `:24` also survives. Every *other* Stage-2 item landed, so this is a dropped sub-task. |
| `AtlasCoreScreen.tsx:43` still hardcodes `state="thinking"` | **Accidental.** The 2026-07-26 audit named this exactly — *"a fake state, never updated… a small existing lie worth fixing"* — and it is unchanged. |
| Hardcoded `#fffdfa` left in TSX | **Accidental.** All four gone from `workshop.css`, one survives at `src/pages/Auth.tsx:141`. A sweep that grepped the stylesheet only. |
| Dead `Entry.lastKey` field | `atlasSphere.ts:123,382` — written, never read. |

## B.2 Sphere gallery — `src/pages/AtlasSphereGallery.tsx`

**Shipped** against every 2026-07-26 ask: side-by-side canvas/WebGL hero (`:126-149`), all ten
states as chips with the two cut ones badged and dimmed (`:166-190`, `:62-63`, `:250`), the
editor with `count`/`dens`/`size`/`soft` (`:201-203`, `:221-232`), the card grid at
`countScale={0.3}` with the measured budget cited (`:237-239`, `:255`), and the dev-route
treatment matching `/atlas-architecture` (`src/App.tsx:154-159`).

**Missing for v3:** morph/field. No `morph`, `amp`, `pulse`, `palette`, `fieldSpread`,
`sphereFrac`, `alphaGain`, `glow`, `spin`, `maxDpr` or `radius/cx/cy` control exists. This is
new work, not drift.

## B.3 Mail — against `2026-07-27-mail-contract.md`

**The strongest-executed area in the repo.** All five §0 non-negotiables shipped, including
the ones easiest to fudge:

- Send path built end-to-end and refusing at the last hop with exactly
  `Sending requires the Workers Paid plan` — `src-tauri/src/mail.rs:1078-1108`; no UI copy
  anywhere claims mail can be sent (`MailDraftComposer.tsx:313` reads
  "Approve (sending is off)").
- No fabricated confidence. `matchedOn` is built from real rows only —
  `src/pages/atlas/AtlasMail.tsx:107-124`.
- Empty states distinguish inbox-zero from filter-empty — `MailEmptyState.tsx:30-56`.
- Autonomy default guarded in the **hook**, not just the UI — `useAtlasMail.ts:1147-1149`.
- Audit trail says **"Logged on this Mac"** — `MailAuditTrail.tsx:26`.

All six Rust commands ship with the specified names and signatures (`mail.rs:675`, `:818`,
`:1007`, `:1035`, `:1078`, `:1114`). Virtualisation, the keyboard map, responsive collapse and
the §6.3 props all ship verbatim. `mail.css` references tokens and contains **zero raw hex**.

### Drifted — deliberate

| Item | Detail |
| --- | --- |
| `r2_key` → **`blob_key`** | `src/types/mail.ts:92`, rationale `:82-84` (the store is S3; mirrors the worker column). Contract §8.1 says *"No existing response field may be renamed"* — so **the contract is now stale and should be amended**, not the code. |
| `MAIL_FNS` narrowed, not deleted | `src/integrations/local/localClient.ts:429` keeps `UNBUILT_MAIL_FNS` for two names that still have call sites; rationale `:423-428`. Better than the instruction; contract still reads "delete". |
| `mail-compose-blocked` composes around the verbatim reason | `MailDraftComposer.tsx:282-283` embeds the exact string inside a fuller sentence; rationale `:22-30`, `:274-278`. The bare verbatim render exists at route level (`MailNotices.tsx:60`). |
| `Enter` opens only when nothing is selected | `AtlasMail.tsx:158-162` — *"Selection **is** opening in the side-by-side layout."* |
| `filter_empty` null-mailbox fallback | `MailEmptyState.tsx:42`. Defensive, unspecified. |
| Composer uses `toISOString()`, `mailFormat` uses `isoWithOffset()` | `MailDraftComposer.tsx:46-51` vs `mailFormat.ts:36-53`. Both correct; **two files in one feature solve the same problem two ways.** Worth reconciling. |

### Missing

- **`mail-ingest-errors` / `mail-ingest-error`** — in the §6.4 class contract, **zero
  occurrences** in `mail.css` and in every component. `MailIngestErrors.tsx:76,89` reuses
  `mail-notice*` instead. Accidental: the in-code `CONTRACT-GAP` notes
  (`mail.css:267-270`, `MailNotices.tsx:18-21`) list only the four `mail-notice*` names and
  do not know the ingest pair exists.
- `mail.css:291,319` set `font-family:'Sora',ui-monospace,monospace` — **Sora is not loaded**
  (A.5). Harmless fallback, but a dead font reference in a new file.
- Stale rationale, not a drift: `mail.rs` explains the refusal as "Cloudflare Email Sending
  needs the Workers Paid plan", but per `docs/ROADMAP.md:157-187` an SESv2 path now exists and
  fails for a different reason. The refusal is still correct; the explanation is half the story.

## B.4 Header band

Landed entirely in `src/pages/atlas/AtlasDashboard.tsx` — the audit's "blast radius is one
file" held. **[code]**

**Shipped:** `hdrB` removed with the removal documented (`:194-198`); the greeting band
promoted to the top element (`:199-228`); the listening indicator relocated under the subline
rather than dropped, with the disclosure rationale named (`:211-222`); Home added to the dock
(`:236-241`); the Core/Control duplicate fixed (`:242-244`); a real account menu on the profile
chip with `aria-haspopup`/`aria-expanded`, deep-linking to Memory & Privacy (`:272-286`).

**Missing — the wordmark.** The audit called dropping it a *"Regression"*. Nothing on `/` or
`/dashboard` renders the Atlas wordmark; `.wordB` survives only on `/home`
(`src/pages/atlas/AtlasHome.tsx:55`). The audit offered two remedies — a dock Home item **or**
the sphere as home affordance — and the Home item shipped, which covers the *navigation* half.
The *branding* half ("The dock has no home affordance **and no branding**") is unaddressed, and
`AtlasDashboard.tsx:194-198` claims "What the bar carried moved rather than vanished", which
is true of the home action and the listening label but **not** of the wordmark. **Accidental.**

**Leftover:** dead `.hdrB` rules survive with no consumer at `workshop.css:23` and `:712`.

---

# C · Audit B — the new design vs the code

## C.1 README §1 — per item: what must change, and what the app cannot support

### §1.1 Flat and borderless (system-wide)

**Files that must change**

| File | Scope |
| --- | --- |
| `src/styles/workshop.css` | The live surface. ~74 border declarations in the light layer + ~55 in the dark base layer. Also carries the dead dark `body{}` block (B.1) that should die in the same pass. |
| `src/styles/mail.css` | 29 of 33 border declarations. |
| ~5 files with live inline `style={{ border… }}` | ~14 declarations. |
| `src/index.css` | Add `#eef2fe` as a token — it **does not exist in the codebase** (A.5). Define `--negative`, used 9× and never defined. |
| Every `button` / `input` / `textarea` rule | §1.1 requires `border: none` set **explicitly**; deleting a declaration lets the UA default back in. |

**Scope correction — the ~600 Tailwind border utilities are mostly not in scope.** They sit on
URL-only routes (`/atlas-architecture`, `/atlas-demo`, `/atlas-core-legacy`, `/atlas-teach`).
The live borderless pass is **~118 declarations across ~5 files**. Sizing this as a
700-declaration sweep would be wrong by a factor of six.

**Two things that must survive the pass — flagging, not deciding:**

1. **`mail.css:153,303,305`** — `border-left:3px solid var(--amber)` / `var(--red)` are
   **semantic status rails**, not separation. §1.1 exempts "illustration strokes… drawings,
   not element borders"; a status rail is arguably the same category, but the handoff does not
   name it. **If these are removed, mail loses its only non-colour status signal.**
2. **`mail.css:67,296`** — `.mail-thread-item` uses `border:1px solid transparent` as a
   **layout-stable hover placeholder**. It is invisible and separates nothing. Removing it
   causes a **2px jump on hover**. If it is removed for purity, the replacement must be an
   equivalent reserve (inset box-shadow, or padding math).

### §1.2 Atlas Sphere v3 — morph, field, artwork palette

**This is a merge, not a lift — and the case is much stronger than "one cache line".**
`atlas-sphere.js` regresses **five** separate fixes the app already made and paid for. Lifting
the file wholesale would undo a week of Stage-1 work:

| # | `atlas-sphere.js` | The app's shipped fix it would undo |
| --- | --- | --- |
| 1 | `:30` `if (clouds.size > 8) clouds.clear();` — flushes the **entire** cache | `atlasSphere.ts:84-87` single-entry eviction, with the rationale in place: *"…wiping every cached cloud made each step re-allocate 26 000 objects."* (**P2-15**) |
| 2 | `unmount()` (`:345-351`) **never cancels `raf` and never clears the 1200 ms `guard` interval** — both run forever once started, even at zero canvases | `atlasSphere.ts:340-345` `stop()`, called from `frame()` `:327` and `unmount()` `:395`; test `atlasSphere.test.ts:132-143` (**audit §3.1**) |
| 3 | The `visibilitychange` handler (`:318`) and the watchdog (`:312`) can **both** schedule a pump in the same window, permanently doubling the rAF callback count | `atlasSphere.ts:350-363` cancels first: `if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);` (**P0-4**) |
| 4 | Off-screen check is **vertical only** (`:287-288`) — a canvas scrolled off horizontally still paints | `atlasSphere.ts:293-294` adds `r.right < 0 \|\| r.left > window.innerWidth`; test `:184-191` (**audit §3.4**) |
| 5 | `try { paint(e, t); } catch (err) {}` (`:290`) — **silent**, every render error swallowed | `atlasSphere.ts:298-309` `safePaint`, logged once per canvas; test `:158-175` (**audit §3.5**) |

Plus `prefers-reduced-motion`, which the handoff does not implement at all (confirmed: zero
matches for `matchMedia|prefers|reduced` across all 353 lines) while the app has a tested
implementation (B.1).

**What genuinely must be adopted from the handoff:**

- The cache key gains an **aspect-ratio** component — `n|dens|ar` (`:27`), with `ar` clamped
  to `[0.5, 4]` and rounded to 2 dp. The field lattice is aspect-sized, so this is required.
  **The correct merge is: the handoff's key, the app's eviction.**
- The morph/field pipeline, the round-particle `arc()`/`rect()` split, the radius clamps, and
  the halved spin speeds.

**Correction — the README misstates its own alpha formula.** README §3 gives
`fa = edge · (0.045 + 0.95·crest²) · (0.58 + 0.7·amp)`. The code (`atlas-sphere.js:202-208`)
is:

```js
var crest = wv * 0.5 + 0.5;
var cr2 = crest * crest * (0.4 + 0.6 * crest);
var fa = edge * (0.045 + 0.95 * cr2) * (0.58 + amp * 0.7) * aSoft;
```

So the real term is **`crest² · (0.4 + 0.6·crest)`** — a cubic-weighted square that pushes
troughs darker — and it is additionally multiplied by **`aSoft = 1 - soft/10 * 0.42`**, which
the README omits entirely. Implementing from the README prose rather than the code yields a
visibly **flatter and brighter** field (up to 2.5× overstated alpha at low crest).
Likewise the positional wave `H · (0.008 + 0.05·amp)` is correct as written but is gated by
`edge` at the point of use (`:201`), so peak displacement at the field rim is ~0, not the
quoted value. **Port from the code, not from the README.**

**Other contract details worth knowing before the port** (all `atlas-sphere.js`):
`PRESET` and `STATES` are exported as **live references**, not frozen — a caller mutating
them mutates the renderer's defaults. `count: 0`, `dens: 0` and `maxDpr: 0` all silently
become their defaults because the defaulting uses `||` (`:89`, `:90`, `:94`). `maxDpr`
defaults to **1.5**. `q` correctly never reaches the cache key (`:88`, `:107`); the adaptive
controller (`:293-299`) degrades above 15 ms in −0.07 steps to a floor of 0.3 and recovers
below 9 ms in +0.015 steps — ~4.7× slower to recover than to degrade.

**Files that must change:** `src/lib/atlasSphere.ts` (the merge target),
`src/components/atlas/AtlasSphereCanvas.tsx` (pass the new opts through),
`src/pages/AtlasSphereGallery.tsx` (gain the morph/field controls).

**Do not port anything from `Atlas Sphere.dc.html`.** Beyond being a design reference, it
carries two traps: (a) every spin value in its state "recipe" strings is **exactly 2× the
shipped value** — the pre-v3 numbers the README says were halved, never updated
(idle `0.0016` vs `0.0006`, working `0.006` vs `0.003`, muted `0.0006` vs `0.00025`); and
(b) lines 175–303 are a **stale forked copy of the whole particle pipeline**, guarded behind
`if (this._alive || window.AtlasSphere) return;`, which draws every dot with `rect()` and no
radius clamp, has no morph/field, and runs a watchdog that **paints synchronously from a
timer** — precisely the pattern the README forbids.

**The gallery's morph UI is not actually specified.** README §2 and §6 both require the
gallery to "gain the morph/field controls", but `Atlas Sphere.dc.html` contains no `morph`
slider, chip or prop anywhere — the requirement is stated and the control design left open.
The current editor wires only 6 of ~21 option keys (`state`, `dark`, `count`, `dens`, `size`,
`soft`, `countScale`); `morph`, `amp`, `pulse`, `palette`, `fieldSpread`, `sphereFrac`,
`alphaGain`, `glow`, `spin`, `radius`, `cx`, `cy`, `maxDpr` and `whiten` have no control.
Note also that a 400×400 fixed stage will **crop the field** — at `morph < 1` the formation is
full-bleed and aspect-sized.

**There are FOUR sphere implementations, not three.** The handoff's §2 note omits one:

| # | File | Tech | Serves |
| --- | --- | --- | --- |
| 1 | `src/lib/atlasSphere.ts` + `AtlasSphereCanvas.tsx` | canvas-2D | **the gallery only** |
| 2 | `src/components/atlas/AtlasSphere.tsx` (via `AtlasSphereLazy`) | three.js/WebGL | dashboard, core, drawer, expanded — **everything users see** |
| 3 | `src/components/atlas-ui/MusicSphere.tsx` (220 lines) | canvas-2D | music |
| 4 | **`src/pages/AuthSphere.tsx` (158 lines)** | canvas-2D | **`/auth` and `/permissions`** |

`AuthSphere` is the first sphere a new user ever sees. Any "one implementation" migration that
plans for three will strand it.

### §1.3 / §1.4 `atlas-cover.js` and Music Player v2

**Files that must change:** `src/components/atlas-ui/MusicPlayerFull.tsx` (135 lines),
`MusicSphere.tsx` (220 lines, to be deleted), `AtlasExtraCards.tsx` (181 lines), plus a new
`atlasCover.ts` port.

**Dead code to remove in the same pass:** `MusicSphere.tsx:12` declares five forms
(`'orb' | 'rings' | 'bloom' | 'field' | 'burst'`) with five draw functions (`:42`, `:67`,
`:89`, `:125`, `:153`), but `MusicPlayerFull.tsx:13` hardcodes `const FORM = 'field'` and
`AtlasExtraCards.tsx:87` passes `form="field"`. **`orb`, `rings`, `bloom` and `burst` are
unreachable** — written, styled, never rendered.

**What the app may not be able to support — flagging:**

- **Audio-reactive everything.** `amp` and `pulse` require `music:level`, which requires real
  librespot playback (A.6). Unverified.
- **Artwork palette extraction.** `AtlasCover.read()` downscales to 40×40 (**1600 pixels**),
  buckets them into a 512-entry histogram weighted by saturation and mid-luminance, and
  returns the darkest / 55th-percentile / lightest of the top 7 buckets. It needs a
  same-origin or CORS-clean image. Spotify artwork is served from `i.scdn.co`; whether it
  arrives CORS-clean **and at a resolution worth sampling** is unverified — the handoff's own
  open question 6, still open.
  **A sharp edge worth designing around:** `read()` wraps everything in one `try` and its
  `catch` cannot distinguish a **tainted canvas** from a **monochrome image** — both silently
  return the caller's `fallback` (or a built-in Atlas-blue triple `#18181E / #3461F2 /
  #CEDBFF`) with **no signal to the caller that the read failed**. There is no `crossOrigin`
  handling and no `img.complete` check. If sampling silently fails, the entire music surface
  renders in fallback blue and looks like a deliberate design, not a bug. The port should add
  a success flag.
- **`AtlasCover.make(seed, tone)` throws if `tone` is omitted** — it destructures
  `[deep, mid, light]` unguarded. It returns a 512×512 JPEG data URL.
- **Sample records.** The handoff says *"Confirm the third attribution before shipping it as
  sample data"* (D1MA — *NATTEN BLIVER MORGEN* / N1YA, 2025). Unconfirmed. Do not ship it as
  fact.

### §1.5 Nine surfaces that have never existed

Smart Home · Health · Banking · Widget Catalog · Widget Sheet · Browser · Model Lab ·
Answer Views · Onboarding. **Confirmed absent** — a case-insensitive grep across
`src/**/*.{ts,tsx}` for `smart ?home|banking|model ?lab|widget ?catalog|widget ?sheet|answer ?view`
returns **zero matches**. No page, no route, no component.

**Critical naming trap:** `src/components/atlas-health/` is **not** the Health surface. It is
the health dashboard for *Atlas itself* (agent runs, error rates, system nominal) and feeds
the "Health 100%" stat card at `AtlasCoreScreen.tsx:49`. Greps for `fitness|steps|heart
?rate|sleep|workout|hrv|calorie` hit only agent **run steps** and `max_steps: 20`. Anyone
implementing the Health surface must not fold into that directory.

**What the app cannot support today, by surface:**

| Surface | Blocker |
| --- | --- |
| **Health** | No biometric source at all. No HealthKit bridge, no Rust command, no schema. macOS HealthKit access is materially constrained — this is a native-capability question, not a UI one. |
| **Banking** | No bank/aggregator integration, no schema. "Read-only money" needs an Open Banking or Plaid-class provider, with the legal and entitlement surface that implies. |
| **Smart Home** | No HomeKit/Matter bridge. The handoff notes it "Needs `atlas-models.js`" — which §8 simultaneously lists as **prototype-only, do not port**. That is a direct contradiction in the handoff (see E). |
| **Browser** | Needs `image-slot.js`, also listed as prototype-only, do-not-port. A browser shell inside a Tauri webview is a substantial native question (WKWebView nesting, navigation control). |
| **Model Lab** | Partially supportable — model routing exists (`selectModel`, `ATLAS_AI_PROVIDER`), but there is no per-model comparison/telemetry store. |
| **Answer Views** | Supportable — this is a rendering concern over existing chat output. Lowest-risk of the nine. |
| **Widget Catalog / Sheet** | The dashboard grid is a **hardcoded list of 10 cards** at `AtlasDashboard.tsx:293-302`. A catalog implies a widget registry, per-widget size/span metadata and user arrangement — none of which exists. This is an architecture change, not a screen. |
| **Onboarding** | Gate only (`OnboardingGate.tsx`, 34 lines). The designed Intro → permissions → welcome flow does not exist. |

## C.1b The token set contradicts itself across the handoff — flagging, not deciding

`Atlas Design System.dc.html` is listed in §6 as "Current tokens and components", but it does
**not** agree with README §7. These must be reconciled before the borderless pass, because
§1.1 is defined in terms of these values.

**1. Orange is not simply stale.** The task framing (and README §6) treat orange as a Brand
Guide leftover. But the **Design System publishes it as a live token**:

| | Design System | README §7 |
| --- | --- | --- |
| `--accent` | `#3461F2` "Atlas Blue — the one voice" | accent `#3461f2` |
| **`--accent-2`** | **`#FF6A00` "Atlas Orange — secondary accent: warmth, highlights, energy"** | **not present** |

So `src/index.css:21,41` being `#ff6a00` may be the *right colour on the wrong token* rather
than simply wrong. **The fix is still to make `--primary`/`--ring` blue** (they feed Tailwind
`primary` and the loading spinner). But whether orange survives as a legitimate `--accent-2`
is a product decision the handoff answers two different ways.

**2. Blue text must not use `#3461F2`.** The Design System reserves `#3461F2` for fills and
icons and requires **`#2A4FD0` for blue text** (5.6:1). README §7 lists `accent-deep #2f4bbd`.
These are different values for the same role.

**3. `--negative` — the token the app uses 9× and never defines — has two candidate values.**
Design System: `#C14A35`. README §7: red `#d0453a` / `#a3352c`. Defining it requires a pick.

**4. The radius scales are incompatible.**

| Design System | README §7 |
| --- | --- |
| `9px` control · `12px` icon · `18px` card · `9999px` pill | `9999` pill · `30` editor · `28` panes · `26` cards · `22` draft · `20` message · `18` rules · `16` rows · `12` rail · `10` icon tiles |

A card is `18px` in one file and `26px` in the other. This is not a rounding difference.

**5. The Design System contradicts itself internally** — all three look like fallout from the
orange→blue accent swap:
- The Atlas Blue swatch caption reads `Hover #FF773C` — that is the **orange** hover
  (`--acc2h`); the blue hover in its own stylesheet is `#5B7CFF`.
- `.chip.acc` is `background:rgba(255,106,0,.1); color:var(--acc)` — an **orange fill with
  blue text**.
- The focus ring `.btnf` is `0 0 0 3px rgba(255,106,0,.28)` — **still orange** — while
  `.inp:focus` correctly uses `rgba(52,97,242,.18)`.

**Good news on type:** the Design System's families are Hanken Grotesk (display), Geist (UI),
Newsreader (editorial italic) and a system mono stack. **All are already bundled** in
`public/fonts/`. The spec is fully satisfiable today — Sora, Manrope and Inter are pure legacy
cruft in the app and can simply be deleted rather than sourced (A.5).

**Confirmed token name for §1.1's emphasis fill:** `--wash: #EEF2FE`.

**Also confirmed:** the Design System requires honouring `prefers-reduced-motion` ("freeze
drift, breathe and stream; keep instant state"). The app already does; only the handoff's
portable `atlas-sphere.js` does not.

## C.2 Verifying README §2 — the handoff's own repo map

The handoff says of §2: *"Verify each line before trusting it; this is a starting map, not a
source of truth."* It was verified line by line. **Corrections:**

| # | Claim | Correction |
| --- | --- | --- |
| 1 | Core "Built after the 2026-08-02 prompt… incl. the Memory tab" | **Wrong twice.** `AtlasCoreScreen.tsx:11-19` defines seven tabs — Search, Overview, Live, Agent, Knowledge, Research, Learning. **There is no Memory tab**, and no `memory` case in `AtlasCoreTabs.tsx:194-201`. Memory lives only in *Settings* (`AtlasSettings.tsx:31`). And it was built **before**: last touched `3e54e86` (2026-07-23). |
| 2 | Architecture "Built after the 2026-08-02 prompt" | **Wrong.** Last touched `dc19cfe` (2026-02-05). Commit `3a0745d` (2026-08-02) added **only two docs** — the prompt is a *request for a redesign*, not a shipped implementation. Both rows should read "built **before** the prompt; the prompt targets them for redesign." Also, the row **omits the route**: `/atlas-architecture`, `src/App.tsx:162`. |
| 3 | Legacy admin "~38 components" | **39 files** in `src/components/atlas-health/`. The map inherited the error from the code comment at `src/App.tsx:142`. |
| 4 | Legacy admin "Orphaned" | **Not fully.** `src/pages/AtlasCore.tsx` is unreferenced except by its route (`App.tsx:29,149`), but **5 of the 39 components are live-imported by the shipping Settings overlay** — `AtlasSettings.tsx:3-7` pulls `VoiceSettingsPanel`, `BudgetSettingsPanel`, `MemoryPrivacyPanel`, `PersonalityPanel`, `SoftwareUpdatePanel`. Accurate statement: **34 of 39 orphaned, 5 load-bearing.** Deleting the directory wholesale would break Settings. |
| 5 | Music "Built against the **old** player" | **Wrong.** `MusicPlayerFull.tsx:4` imports the **current** local-first `useMusicPlayer`. The *sphere* is forked (true) and four of its five forms are dead (C.1), but the player wiring is current. |
| 6 | Sphere: "Three sphere implementations exist" | **Four.** `AuthSphere.tsx` omitted — see C.1. |
| 7 | `prefers-reduced-motion` "still not honoured" (§3) | **False.** Shipped and tested — see B.1. |
| 8 | Settings "mounted as a dashboard overlay" | Correct, and there are **two** entry points, not one: a direct dock button (`AtlasDashboard.tsx:265`) **and** dock avatar → `AccountMenu` → Settings (`:273-285`, `AccountMenu.tsx:58`, deep-link `:64`). Rendered `:330-335`, Esc-dismissed `:135`. Tabs: voice, mail, portfolio, music, budget, personality, memory, updates (`AtlasSettings.tsx:22-33`). |
| 9 | **Row missing entirely** | **`src/pages/AtlasDemo.tsx` — 1133 lines, route `/atlas-demo` (`App.tsx:179`)** — the **largest page in the repo**. A particle-sphere tuning lab with per-state config, three performance presets, and preset save/export/import. Unlinked and URL-only, but unlike the legacy route it is flagged as such nowhere. |
| 10 | "Orphaned… reachable only by URL" applied to the legacy route alone | **Six routes have no in-app entry point:** `/home`, `/atlas-teach`, `/atlas-architecture`, `/atlas-sphere`, `/atlas-demo`, `/atlas-core-legacy`. An exhaustive scan of every `navigate('/…')` / `to="/…"` / `href="/…"` yields only `/` (8), `/atlas-core` (6), `/dashboard` (2), `/auth` (2), `/permissions` (1), `/mail` (1). |
| 11 | — | **`/permissions` is reached only programmatically** (`OnboardingGate.tsx:30`, `Auth.tsx:73`), never from a visible control. This makes `App.tsx:135`'s comment *"Reachable again from Settings so choices are revisitable"* **false**, and therefore makes the user-facing promise at `AtlasPermissions.tsx` — *"You can change it later"* — **a false statement in shipping UI**. No Settings tab links to it. |

**Verified as claimed:** Dashboard (routes `/` + `/dashboard`, band header landed), Home,
Mail (+ `mail.css`, 13 components under `atlas-ui/mail/`), Teach, Sphere gallery, Login/Auth
(`AuthSphere` also reused by `AtlasPermissions.tsx:4,104`), Permissions (statically imported,
deliberately — `App.tsx:25-27`), Onboarding (gate only), and all nine unbuilt surfaces.

## C.3 Corrected repo map

| Surface | Repo | Route | Lines | State |
| --- | --- | --- | --- | --- |
| Dashboard | `src/pages/atlas/AtlasDashboard.tsx` | `/`, `/dashboard` | 340 | Built. Band landed. Needs borderless pass. Wordmark regression open. |
| Home | `src/pages/atlas/AtlasHome.tsx` | `/home` | 94 | Built. **No in-app link.** |
| Core | `src/pages/atlas/AtlasCoreScreen.tsx` | `/atlas-core` | 146 | Built **2026-07-23**. **7 tabs, no Memory.** **Serves fabricated data.** |
| Mail | `src/pages/atlas/AtlasMail.tsx` + `src/styles/mail.css` | `/mail` | 308 | Built, contract-clean. Needs borderless pass with two exemptions. |
| Teach | `src/pages/AtlasTeach.tsx` | `/atlas-teach` | 858 | Built. **No in-app link.** Heavily orange. |
| Architecture | `src/pages/AtlasArchitecture.tsx` + `src/components/architecture/*` (1454) | `/atlas-architecture` | 124 | Built **2026-02-05**. Old design. Mermaid, not artwork. **No in-app link.** |
| Sphere gallery | `src/pages/AtlasSphereGallery.tsx` | `/atlas-sphere` | 271 | Built. Must gain morph/field. **No in-app link.** |
| **Sphere tuning lab** | **`src/pages/AtlasDemo.tsx`** | **`/atlas-demo`** | **1133** | **Missing from the handoff map.** **No in-app link.** |
| Login / Auth | `src/pages/Auth.tsx`, `src/pages/AuthSphere.tsx` | `/auth` | 243 / 158 | Built. `AuthSphere` = 4th sphere impl. |
| Permissions | `src/pages/AtlasPermissions.tsx` | `/permissions` | 187 | Built. **Unreachable after first run.** |
| Settings | `src/pages/atlas/AtlasSettings.tsx` | — (overlay) | 311 | Built. **Two** entry points. 8 tabs. |
| Music | `MusicPlayerFull.tsx` / `MusicSphere.tsx` / `AtlasExtraCards.tsx` | — (overlay) | 135 / 220 / 181 | Current player, forked sphere, **4 of 5 forms dead**. |
| Onboarding | `src/components/OnboardingGate.tsx` | — | 34 | Gate only. |
| Smart Home · Health · Banking · Widget Catalog · Widget Sheet · Browser · Model Lab · Answer Views | — | — | — | **Not built.** Blockers per C.1. |
| Legacy admin | `src/pages/AtlasCore.tsx` + `src/components/atlas-health/` (**39**) | `/atlas-core-legacy` | 96 | **34 of 39 orphaned, 5 load-bearing in Settings.** |

## C.4 `Atlas Permission Lab.dc.html` — the options, for the user to pick

**Presented for a decision. This audit does not choose.**

The canvas has two families. Note the document order **inverts** the numbering — family 2
appears first.

- **Family 1 — "Permission Lab":** *"Three experimental grant experiences."*
- **Family 2 — "Grounded set":** *"Six calmer takes — familiar controls with Atlas manners."*
  (It actually contains **eleven**, 2a–2k; 2g–2k were spliced in later and the subtitle was
  never updated.)

**True of all 14 options** — these collapse several likely decision criteria:

- All are **one screen with every permission visible**. There is no wizard, no
  one-per-card flow, no paging anywhere in the file.
- The permission set is **six, not the app's four**: Voice (wake word only), Mail (triage and
  drafting), Smart home (lights, locks, climate), Health (trends on-device), Banking
  (read-only money), Location (presence and scenes). **Three of these six have no data source
  in the app** (C.1).
- **No option models the OS prompt.** Immediate-vs-deferred is simply not addressed here — per
  the handoff that lives in `Atlas Onboarding.dc.html`.
- **No option is skippable** — no Skip/Continue/Not now. These are settings-style panels, not
  a gated first-run flow. The app's current screen *is* a gated flow with "Not now".
- **Only 2e shows any consequence of declining.**
- Only **1b** and **2c** are three-state; the other twelve are binary.

### Family 1 — experimental

| Option | Title | What it is |
| --- | --- | --- |
| **1a** | Orbit intake | Six pills orbit the live Atlas sphere; granting animates a pill inward to a 98px ring, revoking outward to 160px (0.7s). Binary. **The only option with a live sphere dependency.** |
| **1b** | Scope dial | Per-row three-stop slider; **tapping cycles** 0→1→2→0. Per-permission vocabularies (Mail: Off/Headers/Full text; Location: Off/Coarse/Precise). Caveat: returning to Off from the middle requires two taps through "Always on". |
| **1c** | Constellation | Dark card; granting grows an amber thread from a core dot to a star. Binary. **Carries the most per-item explanatory copy** of family 1. Node coordinates hardcoded for exactly six items. |

### Family 2 — grounded

| Option | Title | What it is |
| --- | --- | --- |
| **2a** | Quiet switches | Classic 44×26 pill toggle per row. Most conventional, most immediately legible. |
| **2b** | Checklist | Whole row is the target; 24px circular checkbox. Larger hit target than 2a. |
| **2c** | Three stops | Segmented control per row — **direct selection** rather than 1b's cycling, all states visible as labels, at the cost of a busier row. |
| **2d** | Tap tiles | Two-column grid; status dot + name + uppercase state tag ("GRANTED"/"OFF") + caption. **1.5px amber ring** when granted. The base pattern for 2g–2k. |
| **2g** | Tap tiles, filled | 2d **with the rings removed** — solid ink fill when granted, faint wash when off. Explicitly the borderless correction of 2d. |
| **2h** | Tap tiles, inverted | 2g on a dark ink card; granted tiles fill **amber** `#e8862e`. Highest contrast. |
| **2i** | Tap tiles, inverted blue | 2h with **blue** `#2a4fd0`. *"Reads as system rather than alert."* |
| **2j** | Filled tiles, amber on light | 2h's treatment on the cream card. Carries the file's only accessibility note: **ink on amber = 6.2:1; cream on amber only 2.6:1** — so amber forces dark text. |
| **2k** | Filled tiles, blue on light | 2j in blue. *"Quieter than amber, and it never reads as a warning."* |
| **2e** | Profiles | **Three radio postures, not per-permission**: Minimal (1 of 6) / Recommended (4 of 6, the default) / Everything (6 of 6), with a live summary sentence. Fastest path; the **only** option with consequence-of-declining copy. Caveat: *"Adjust later, per permission"* implies a second surface this canvas does not design — it needs one of 2a–2k behind it. |
| **2f** | Chip cloud | Wrapping pill chips, tap to grant. Most compact, **least explanatory** — purpose captions dropped entirely. Quirk: a granted chip appends the *middle* scope word ("Mail · headers") although the control is binary and no scope can be set. |

**The file states no recommendation.** The only hard constraint is the 6.2:1 / 2.6:1 contrast
note above 2j.

**Three things about this canvas conflict with the rest of the handoff — flagged, not resolved:**

1. **Amber `#e8862e` is the Lab's primary accent throughout** (1a, 1b, 1c, 2d, 2g, 2h, 2j),
   while `PROMPT.md` and README §6 both state the accent is Atlas Blue `#3461f2` and that any
   orange is stale. **2h/2i and 2j/2k exist precisely to put amber and blue to a vote the
   handoff says is already settled.**
2. **None of the Lab's hexes are project tokens.** It uses `#e8862e` and `#2a4fd0`; README §7
   specifies amber `#e07a1f`/`#a2540c` and accent `#3461f2`/`#2f4bbd`. Whichever wins needs
   reconciling — **and the 6.2:1 measurement re-taken**, since it was computed for `#e8862e`.
3. **Only 2g, 2h, 2i, 2j, 2k are borderless-compliant as drawn.** 2a explicitly sells
   "hairlines"; 2b, 2d, 2e and 2f use rings. The others are pickable but need a borderless
   re-draw first.

---

# D · Prioritised gap list

Ordered by user-visible harm, then by cost of leaving it.

### P0 — dishonest or broken in shipping UI

1. **`/atlas-core` serves fabricated data.** `AtlasCoreScreen.tsx:46,72-74,80-83` — a `+12%`
   trend on a zero, "1,204 docs/hr" beside a real "0 total", and four invented knowledge rows
   with invented relevance scores. The legacy screen it replaced was honest. **Fix before any
   redesign work touches this screen**, or the redesign ships the lie in nicer type.
2. **`--primary` / `--ring` are orange.** `src/index.css:21,41` — `#ff6a00` with a
   `/* #3461f2 */` comment beside the wrong value. Visible right now on `/atlas-architecture`,
   `/atlas-teach`, `/atlas-core-legacy` and the app's own loading spinner
   (`App.tsx:105`). One-line fix; unblocks every track. **Note:** this is *not* the same as
   "delete all orange" — the Design System still publishes `--accent-2 #FF6A00` as a live
   secondary token (C.1b). Making `--primary` blue is unambiguous; retiring orange entirely
   is a separate decision.
3. **"You can change it later" is false.** `/permissions` is unreachable after first run
   (C.2 #11); `App.tsx:135`'s comment asserts otherwise. Either route to it from Settings or
   change the copy — but not both ways at once.

### P1 — blocks or misdirects the redesign tracks

4. **The sphere merge is not a lift — `atlas-sphere.js` regresses FIVE shipped fixes.**
   Cache flush (P2-15), no teardown of `raf`/`guard` on unmount (§3.1), double-pump on
   visibility change (P0-4), vertical-only off-screen check (§3.4), and a silent `try/catch`
   (§3.5) — full table in C.1 §1.2. Plus no `prefers-reduced-motion`. **Take the handoff's
   aspect-ratio cache key and morph pipeline; keep the app's eviction, teardown, pump
   guarding, off-screen test, `safePaint` and reduced-motion.**
5. **Port the sphere field from the code, not the README.** The README's alpha formula
   omits the cubic crest weighting and the `aSoft` term; implementing it as written produces
   a measurably flatter, brighter field (C.1 §1.2).
6. **Reconcile the token set before the borderless pass** (C.1b). `Atlas Design System.dc.html`
   and README §7 disagree on the radius scale (18px vs 26px cards), on `--negative`
   (`#C14A35` vs `#d0453a`), and on whether orange exists at all (`--accent-2 #FF6A00` vs
   absent). §1.1 is defined in terms of these values, so the pass cannot start on a
   contradiction.
7. **Four sphere implementations, not three.** `AuthSphere.tsx` is omitted from the handoff
   and serves the first screen a new user sees. Any consolidation plan must include it.
8. **Decide canvas vs WebGL (P0-1, a week open).** The canvas renderer got every Stage-1 fix
   and is used **nowhere in the product**; WebGL serves every real surface and never got
   `aria-hidden` (`AtlasSphere.tsx:110-122`). three.js is still fully bundled. The divergence
   is now producing real defects.
9. **Missing tokens block §1.1.** `#eef2fe` (the Design System's `--wash`) does not exist in
   the codebase; `--negative` is used 9× and never defined.
10. **Fonts: Sora / Manrope / Inter are referenced 24× and none are bundled** (A.5). Cheap
    win — the Design System's actual families (Hanken Grotesk, Geist, Newsreader) are all
    already bundled, so these are pure cruft and can be deleted, not sourced.

### P2 — correctness and hygiene, cheap

11. **`aria-hidden` missing on the WebGL sphere** — the one users actually see.
12. **Dead dark `body{}` + Manrope rule** (`workshop.css:20`) — a dropped P2-14 sub-task.
13. **`AtlasCoreScreen.tsx:43` hardcodes `state="thinking"`** — named in the last audit,
    unfixed.
14. **`mail-ingest-errors` / `mail-ingest-error`** in the mail contract, absent from code.
15. **`MusicSphere` forms `orb`/`rings`/`bloom`/`burst` are unreachable dead code.**
16. **`src/App.css` imported nowhere**; dead `.hdrB` rules at `workshop.css:23,712`;
    dead `Entry.lastKey` at `atlasSphere.ts:123,382`.
17. **Duplicated "Real-time Data Flow" heading** on `/atlas-core-legacy`.
18. **404 copy is Lovable scaffold** — "Oops! Page not found".
19. **`AuthSphere.tsx:108` never recomputes particle count on resize.**
20. **`VITE_PREVIEW_NOAUTH` ship-check is dead** — `docs/RELEASE.md:123` and `CLAUDE.md`
    check for a string with no code path.
21. **Mail contract §8.1 is stale** — it forbids the `blob_key` rename that shipped
    deliberately. Amend the contract.
22. **Six routes have no in-app entry point** (C.2 #10). Decide which are dev-only (and label
    them) and which are missing navigation.
23. **`Atlas Sphere.dc.html`'s state recipe strings are 2× stale** (C.1 §1.2) — if any copy is
    lifted from that file into the gallery, the numbers will be wrong.

---

# E · Ambiguities and contradictions — for the user, not decided here

1. **Permission Lab direction.** 14 options (C.4). No recommendation exists in the file.
   Choosing also implicitly decides amber-vs-blue, which the handoff elsewhere says is settled.
2. **Amber vs Atlas Blue in the Permission Lab.** The Lab's accent is amber `#e8862e`
   throughout and offers amber/blue forks as a vote; `PROMPT.md` and README §6 say blue is the
   accent and orange is stale. **Direct contradiction inside one zip.**
2b. **And the Design System publishes `--accent-2 #FF6A00` "Atlas Orange" as a live
   secondary token** (C.1b), which README §7 omits entirely. So "orange is stale" is asserted
   in two files and contradicted in two others. **Does orange survive as a secondary accent,
   or not at all?** Everything downstream — the borderless pass, the Permission Lab pick, and
   whether `/atlas-teach` gets recoloured or restyled — depends on this one answer.
2c. **Radius scale.** Design System says cards are `18px`; README §7 says `26px`. Two
   incompatible scales for the same components (C.1b).
2d. **`--negative`.** `#C14A35` (Design System) or `#d0453a` (README §7)? The app uses the
   token 9× and defines it nowhere, so this must be picked before anything renders.
2e. **Blue text colour.** The Design System reserves `#3461F2` for fills/icons and requires
   `#2A4FD0` for text at 5.6:1; README §7 offers `accent-deep #2f4bbd`. Different values,
   same role.
3. **The Lab's six permissions vs the app's four.** The Lab adds Smart home, Health, Banking
   and Location. Three have no data source (C.1). Does the permission screen ask for
   capabilities that do not exist yet?
4. **`prefers-reduced-motion` is already answered** (static sphere, tested). The handoff asks
   again as if open. Confirm the shipped answer stands, and decide what `morph` does under it
   — freeze at `morph=1`, or allow the tween.
5. **Ten states vs eight.** README §3 says "Ten states unchanged"; the app deliberately cut
   `waking` and `dissolving`, with the reasoning rendered in the gallery UI. Does v3 revive
   them, or does the cut stand and the handoff get corrected?
6. **Status rails in the borderless pass.** `mail.css:153,303,305` — semantic, not separation.
   Exempt or convert? And `.mail-thread-item`'s transparent placeholder (`:67,296`) needs an
   explicit replacement to avoid a 2px hover jump.
7. **`atlas-models.js` and `image-slot.js` are contradictory.** §6 says Smart Home "needs
   `atlas-models.js`" and Browser "uses `image-slot.js`"; §8 lists both as prototype-only,
   **do not port**. Both cannot be true.
8. **Music, and whether audio is real** (A.6). Not verifiable outside a packaged build. Does
   track 3 gate on a verified build, or build to a defined zero-signal fallback?
9. **Artwork palette sampling.** Whether Spotify artwork reaches the client CORS-clean and at
   a useful resolution is unverified — the handoff's own open question 6. If it fails, every
   chrome colour in the full player falls back and the design changes materially.
10. **Third sample record attribution** (D1MA — *NATTEN BLIVER MORGEN* / N1YA, 2025) is
    explicitly unconfirmed by the handoff. Do not ship as fact.
11. **Nine new surfaces: real screens or widget-level features?** (handoff open question 3).
    Health, Banking and Smart Home each need a native integration that does not exist. Widget
    Catalog/Sheet needs a widget registry — the grid is 10 hardcoded cards today.
12. **The legacy `atlas-health` set** (open question 4). **34 of 39 orphaned, 5 load-bearing
    in Settings** — deleting the directory breaks Settings. Redesign, absorb, or extract the 5?
13. **Wordmark, global listening indicator, account menu placement** — still open from the last
    handoff (open question 7). The listening indicator and account menu shipped; **the wordmark
    is still absent from the dashboard** and the code comment claims otherwise.
14. **Dock composition.** README §7 specifies Home · Core · Teach · Mail · Architecture · Voice ·
    avatar. Teach and Architecture currently have **no in-app entry point at all** — adding them
    to the dock is a product decision, not a style fix.
15. **`/home` vs `/dashboard`.** Two landing surfaces exist; `/home` is unreachable in-app and
    still says "your neural interface". Which is the real one?
16. **The gallery's morph control is unspecified.** README requires the gallery to "gain the
    morph/field controls", but `Atlas Sphere.dc.html` contains no morph UI at all (C.1 §1.2).
    Track work needs either a design or licence to invent one.
17. **`atlas-cover.js` cannot report failure.** Tainted canvas and monochrome artwork are
    indistinguishable and both silently return the fallback palette (C.1 §1.3). Should the
    port add a success flag and a visible degraded state, or is silent fallback acceptable?
