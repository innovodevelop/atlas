# Audit — Atlas Sphere, Mail, and the header change

Handoff: `Atlas premium polish (3).zip` → `design_handoff_atlas_sphere_and_mail`
(6 files, new bundle — sha256 differs from the July 22 `workshop_polish` sync).
Audited against `helloatlas@283b9a9`. **No implementation code written.**
The bundle is unpacked in the session scratchpad, not in `design/current/`, so
the diff baseline is untouched until you decide to sync it.

---

## Prioritised gap list

### P0 — decide before any code is written

| # | Gap | Why it blocks |
|---|---|---|
| 1 | **The handoff silently proposes replacing the WebGL sphere with a canvas-2D one.** The shipped sphere is `AtlasSphere.tsx` → `AtlasCore.tsx`, three.js + `@react-three/fiber` + postprocessing Bloom, with five particle systems. `atlas-sphere.js` is canvas 2D. The handoff never mentions the swap — it says "lift it directly". | This is an architecture decision, not a port. three.js is **1,008 kB** of the bundle (~275 kB gzipped). Dropping it is a big win; keeping both is the worst outcome. Nothing else in the handoff can be scoped until this is settled. |
| 2 | **Mail has no backend.** `localClient.ts:411-412` intercepts `mail-oauth-start`/`mail-sync`/`mail-disconnect` and returns `"Mail sync is temporarily unavailable — migrating to the new mail service"`. Table reads fall through to local SQLite and return empty forever, because nothing can populate them. | Building a three-pane autonomous mail client on a disabled backend produces a second prototype, not a product. The Phase-7 Cloudflare mail worker is the prerequisite. |
| 3 | **6 of the 10 sphere states have no trigger anywhere.** `working`, `success`, `alert`, `muted`, `waking`, `dissolving` return zero hits across `src/` — no type member, no config entry, no assignment. | 60 % of the specified contract is dead visuals on arrival. |
| 4 | **`atlas-sphere.js` watchdog can multiply the render loop and death-spiral.** See §3.2. | Fails worst on the slowest hardware — the opposite of the intent. |
| 5 | **Remount bug in `atlas-sphere.js`.** `frame()` prunes disconnected elements from `entries` but never clears `el.__atlasSphere`; `mount()` then sees it truthy and returns early **without re-adding to `entries`**. The canvas never paints again. | This is almost certainly the "host environment can leave a rAF loop dead after a remount" bug the watchdog was added to paper over. The watchdog cannot fix it — the entry is not in the array at all. |

### P1 — resolve during implementation

| # | Gap |
|---|---|
| 6 | Token collision: `--acc-text` is `#2a4fd0` in the codebase, `#2f4bbd` in the handoff. Same role, different hex. |
| 7 | The mail data model is **message-level, not thread-level**. `db_schema.sql:718` has `mail_messages` with no `thread_id`. Every view in the handoff is thread-oriented. |
| 8 | No token for `#fffdfa` (surface). It exists only as a hardcoded hex in the auth screen (`workshop.css:962,980,992,996`). `--wt` is `#ffffff` — a *different* value. |
| 9 | Status colours `#0fae76` / `#e07a1f` / `#d0453a` have no tokens. `--grn` `#2f7d4f` and `--red` `#c14a35` are same-role, different value. No amber token at all. |
| 10 | `prefers-reduced-motion` honoured nowhere, in the handoff or the codebase. |
| 11 | Canvas has no `aria-hidden`; it is decorative but announced. |

### P2 — cheap, do while nearby

| # | Gap |
|---|---|
| 12 | `#e8e4dd` / `#e6e2db` inset ring colours have no tokens. |
| 13 | Dock "Core" and "Control" both navigate to `/atlas-core` (`AtlasDashboard.tsx:163,166`) — one is a placeholder. |
| 14 | Dead dark-theme `body{}` rule at `workshop.css:20` (`hsl(240 28% 7%)` + Manrope) overridden by `:310`. Manrope/Sora aren't even loaded. Delete. |
| 15 | The `clouds` cache thrashes while dragging the particle slider (§3.6). |

---

## 1. Coverage audit

### 1.1 Sphere states — 4 of 10 reachable

The shipped state pipeline is `useVoiceSession.ts` ← voice-gateway sidecar. The
server owns the transitions (`services/voice-gateway/src/session.ts`).

| State | Reachable? | Trigger today |
|---|---|---|
| `idle` | **yes** | init `useVoiceSession.ts:72`; WS close `:264`; server terminal transitions `session.ts:159,177,223,…` |
| `listening` | **yes** | wake word → `{type:"wake"}` `useVoiceSession.ts:314`; mic button → `handleManualActivate` `:343`; server `session.ts:152` |
| `thinking` | **yes** | end-of-speech, before the LLM call — `session.ts:188` |
| `speaking` | **yes** | first TTS chunk — `session.ts:315` |
| `working` | **no** | — |
| `success` | **no** | — |
| `alert` | **no** | — |
| `muted` | **no** | there is no mute control wired to the voice session at all |
| `waking` | **no** | — |
| `dissolving` | **no** | `turn_end` just stops playback (`useVoiceSession.ts:250`) and falls back to whatever the server sends |

Two further values (`dormant`, `activated`) exist in `WakeWordState`
(`src/types/index.ts:12`) with full visual configs in `stateConfigs.ts` and
`nebulaStateConfigs.ts`, but are assigned only in `/atlas-demo`, `/atlas-teach`,
a settings default and the legacy dashboard. **Configured but dead.**

**Recommendation per unreachable state** — four have a real trigger available
today, two should be cut:

| State | Verdict | Proposed trigger |
|---|---|---|
| `working` | **keep** | The proactive digest and the agent/run system already have a running concept — `runs`/`run_steps` tables and `useAgentRuns.ts`. Drive it from an active run. |
| `success` | **keep** | Fires on run completion and on "Approve & send" once Mail exists. Cheap, high delight. |
| `alert` | **keep** | The integrity gate already surfaces `integrity_error` and the app has error paths. Also the natural Mail escalation visual. |
| `muted` | **keep, but build the control first** | There is no mute today. Add mute to the voice session, then the state is honest. Shipping the visual without the control is backwards. |
| `waking` | **cut, or make it the splash** | "App open" is ~0.4 s in a desktop app that stays running; a 1.6 s fly-in delays first paint. Only worth it as a one-off launch animation, never on route change. |
| `dissolving` | **cut** | "Session end" has no meaning in a desktop app that is quit, not logged out. It would only ever be seen on sign-out — a rare, already-terminal moment. |

Also note `AtlasCoreScreen.tsx:43` hardcodes `state="thinking"` as decoration —
a fake state, never updated. That is a small existing lie worth fixing.

### 1.2 Mail status × view

The prototype fixture is **7 threads** (`Atlas Mail.dc.html:307-354`), ids `a`–`g`:

| Status | Count | Accounts |
|---|---|---|
| `approve` | 2 | press, partners |
| `drafting` | 1 | partners |
| `escalate` | 1 | hello |
| `snooze` | 1 | press |
| `handled` | 1 | hello |
| `handoff` | 1 | hello |

6 statuses × 8 views = 48 cells. Status→view is essentially 1:1
(`approve`→Needs approval, `drafting`→Atlas drafting, `escalate`→Escalations,
`snooze`→Scheduled, `handled`→Handled by Atlas, `handoff`→With humans), plus
Triage as a catch-all and Sent today driven by the `sentIds` override rather
than a status.

- **Structurally impossible: ~35 cells.** A `handled` thread cannot appear in
  Escalations. These need no design.
- **Reachable: ~13 cells**, and the fixture covers every one of the six
  dedicated views with at least one thread. Coverage of the *status* dimension
  is complete.
- **Never rendered: the account dimension.** 8 views × 4 account filters = 32
  combinations; 7 threads cannot populate them, so most are empty states. The
  eight empty-state variants are therefore well exercised — but "Needs approval
  filtered to `hello@`" is empty for a *data* reason, and the copy should not
  imply inbox-zero when it is really an empty filter. **That distinction is not
  in the handoff and is a genuine gap.**
- `Sent today` is only reachable after an in-session Approve & send. On a fresh
  load it is always empty — fine, but it means the view is untested against real
  data shapes.

### 1.3 The listed omissions — confirmed or flagged

| Omission | Verdict |
|---|---|
| Pagination / virtualisation | **Gap, P1.** A real mailbox is thousands of threads. The 392 px list renders every row. Needed before real data, not after. |
| Attachment UI | **Gap, P2.** `mail_messages.has_attachments` already exists in the schema (`db_schema.sql:718-734`) — the data model anticipates it, the design does not. At minimum show an indicator. |
| Multi-select / bulk actions | **Out of scope, agreed.** The product thesis is that Atlas handles the bulk; manual bulk actions contradict it. |
| Keyboard navigation | **Gap, P1.** A three-pane mail client without `j`/`k`, `⌘Enter` to send and `Esc` to close is not credible for the "power user supervising an agent" audience. The `⌘K` hint in the search field already promises a keyboard model. |
| Search results view | **Gap, P1.** The control bar ships a search field with a `⌘K` hint and no results surface. Either build it or remove the field. |
| Thread collapse for long threads | **Out of scope for v1.** Acceptable — the fixture threads are short. |
| Undo-send | **Gap, P0-adjacent.** This is an *autonomous agent* sending mail on your behalf. Undo-send is the safety net that makes autonomy tolerable. The toast already appears for 3.4 s — that is exactly the undo window. Strongly recommend building it with the send. |
| Contact / avatar images | **Out of scope, agreed.** Initials are specified and sufficient. |
| Timezone on "07:00 CET" | **Gap, P1.** Hardcoded CET in a product with a Paris-trip greeting. Schedule must resolve in the user's zone and display it. |

---

## 2. Data-model audit

### 2.1 What exists vs. what the UI implies

Existing (`src-tauri/src/db_schema.sql:702-756`): `mail_accounts`,
`mail_messages`, `mail_alerts`, `mail_oauth_states`. **Message-level, no
threads, no statuses, no rules, no audit.**

The UI implies:

```
Thread      id, account_id, subject, participants[], last_message_at,
            status ∈ {approve,drafting,escalate,snooze,handled,handoff},
            snippet, unread
Message     id, thread_id, from{name,address}, body, sent_at, is_atlas
Mailbox     address, autonomy_mode ∈ {approve_all, autonomous, conditional},
            condition (e.g. amount ceiling), colour
Rule        id, mailbox_id, predicate, action, label   ("press · publication date")
Draft       thread_id, body, state ∈ {proposed, scheduled, sent}, scheduled_for
AuditEvent  id, thread_id, ts, actor ∈ {atlas,user,rule}, action, detail,
            rule_id, model, prompt_version
```

The gap from `mail_messages` to this is **large** — thread grouping, a status
machine, rules and an audit log are all net-new tables.

### 2.2 Fields with no plausible backend source

| Displayed | Source? | Recommendation |
|---|---|---|
| `confidence 0.94` / `0.97` | **None.** No model returns a calibrated confidence, and an LLM's self-reported confidence is not one. | **Remove.** Displaying a fabricated precision number on an autonomy decision is the single most misleading element in the design. If you want a signal, show *what it matched on* — which is what the fact pills already do, honestly. |
| "matched 214 prior answers" | **None.** Would require a retrieval count over a corpus of prior replies that does not exist. | Buildable later against the memory/knowledge store, which already does hybrid recall. Until then, **remove** — or show the actual retrieved sources, which is truthful and more useful. |
| "Atlas answered 14 threads since 6am" | **Derivable** — `count(threads where status=handled and handled_at > today_06:00)`. | **Keep.** Cheap and real. |
| "€86k · over €50k ceiling" | **Partly.** The ceiling is a rule the user sets — real. The €86k must be **extracted from the message body by the model**, which is exactly the kind of extraction that is confidently wrong. | Keep the ceiling; render the amount as *model-extracted, click to see the sentence it came from*. Never as bare fact. `mail_messages.extracted` (JSON) already exists for this. |
| "3 mailboxes", per-view counts, unread counts | **Derivable.** | Keep. |
| "Held for approval · rule: press · publication date" | **Real if rules exist.** | Keep — needs the `Rule` table. |

### 2.3 The audit trail

> **DECIDED 2026-07-26 — the trail is LOCAL.** It lives in `atlas.db` alongside
> the mail content it describes. Nothing about it is uploaded. The reasoning and
> the consequences are in §2.3.1 below; the rest of this section is the original
> analysis of what a *server-side* trail would have required, kept because it is
> the argument the decision was made against.

The prototype's trail is display-only, assembled client-side. For it to carry
the weight the design gives it ("Atlas keeps the record"), it must be:

- **Server-owned and append-only.** No update, no delete path — not even for the
  user. A trail the subject can edit is not a trail.
- **Per event:** monotonic id, `ts` (server clock, not client), `actor`
  (atlas | user | rule), `action`, human-readable `detail`, `thread_id`,
  `rule_id` that fired, `model` id and `prompt_version`.
- **Readable by:** the account owner only. It contains message content.
- **Retention:** stated in the privacy policy. This is new personal-data
  processing and §4/§6 of the published policy would need a row for it.

Flag: the current architecture is local-first with a Cloudflare auth plane. An
append-only server-side audit log is the first substantial *content* store on
the server side — that is a meaningful change to the privacy story, which
currently says "the only personal data we hold on our own servers is your
account email, a salted password hash, plan fields and timestamps". **Either
the trail stays local (and is not tamper-evident), or the privacy policy
changes.** That is a product decision, not an implementation detail.

### 2.3.1 The decision, and what it costs

**Local.** The trail is a table in `atlas.db`; no mail-derived content leaves the
machine.

Why: the trail's actual job is the owner reading their own history — *why did
Atlas send that, which rule fired, which model wrote it.* A local log serves
that completely. The thing a local log cannot do is prove to a **third party**
that the record was not edited, and Atlas has no third party: no shared
workspace, no compliance reviewer, no adversary the owner needs to convince. So
tamper-evidence buys nothing here, while server-side storage would cost the
privacy claim the whole product is sold on — helloatlas.dk states, verbatim,
that the only personal data on our servers is the account email, a salted
password hash, plan and subscription fields, timestamps and the waitlist /
login-throttle records, and that your content is "not uploaded to our servers,
and we cannot read them." Putting message-derived audit rows on the server would
make both sentences false. Bad trade.

Consequences to honour when Stage 6 is built:

1. **No privacy-policy change is needed.** §4/§6 stay as published. Confirm this
   again before shipping Mail — if any mail feature does start uploading
   content, the policy moves first, not after.
2. **Append-only is still worth enforcing, locally.** Insert-only table, no
   `UPDATE`/`DELETE` path in the app, monotonic id, `ts` from the local clock.
   Somebody with a SQLite client can rewrite it; that is fine and should not be
   hidden. It stops Atlas from quietly editing its own record, which is the
   failure mode that actually matters.
3. **Same per-event fields as specified above** — `actor`, `action`, `detail`,
   `thread_id`, `rule_id`, `model`, `prompt_version`. Nothing is dropped by
   going local.
4. **Retention is the user's**, since deletion is theirs: the trail is erased
   with the local data, and it must be covered by the existing local-erase path
   rather than surviving it.
5. **The copy has to change.** The handoff's *"Atlas keeps the record"* implies
   an authority that a local file does not have. Ship something true —
   *"Logged on this Mac"* — and let the honesty be the feature. Overclaiming
   here is worse than claiming less.

---

## 3. Code audit — `atlas-sphere.js`

### 3.1 Leaks and unmount paths

- `unmount()` splices `entries` and clears `el.__atlasSphere` — correct.
- `frame()` prunes disconnected elements (`:169`) but **does not clear
  `el.__atlasSphere`**. A detached-then-reattached canvas is now permanently
  broken: `mount()` (`:186`) sees the stale property, updates `opts`, returns —
  the entry is never re-added to `entries`. **P0-5.** React StrictMode's
  double-mount, and any route change that detaches the node, hits this.
  Fix: clear the property in the prune path, or key the entry off a WeakMap.
- `raf` and `guard` are **never cancelled**. Once started they run for the life
  of the page even with zero entries. In a Tauri app that never reloads, that is
  a permanent 120 ms interval plus a rAF chain. Fix: stop both when
  `entries.length === 0`.
- `paths` retains up to 264 `Path2D` objects after the last paint — trivial,
  ignore.

### 3.2 The `setInterval` watchdog — the most serious defect

```js
if (!guard) guard = setInterval(function () {
  if (performance.now() - last > 260) frame(performance.now());
}, 120);
```

`frame()` unconditionally calls `requestAnimationFrame(frame)` on entry
(`:163`). The watchdog calls `frame()` directly. So:

1. **On a backgrounded window** rAF is throttled to ~0, `last` goes stale, and
   the watchdog becomes the render driver — painting 26 000 particles while
   nobody is looking. It burns CPU and battery precisely when it should idle.
2. **Loop multiplication.** If a rAF is merely *slow* rather than dead, the
   watchdog fires and queues a second chain. Each chain re-queues itself. The
   next watchdog tick can add a third. There is no guard against this because
   `raf` is overwritten without checking whether a callback is pending.
3. **Death spiral on slow hardware.** Frames slower than 260 ms trigger the
   watchdog → more concurrent loops → slower frames → more watchdog fires.
   Worst on the weakest device.

Fix: make the watchdog *restart* rather than *drive* — cancel the existing rAF
first, guard on `document.visibilityState !== 'hidden'`, and (better) fix the
remount bug in 3.1 so the watchdog is not needed at all.

### 3.3 The shared module-level `paths`

**Confirmed safe today.** `paint()` nulls all 264 slots (`:76`) and fully
consumes them (`:141-157`) with no `await` and no yield, and JS is
single-threaded. It is safe *by accident of being synchronous*. It needs the
comment the handoff asks for — or, better, hoist it into a closure per renderer
so a future `async` refactor cannot silently corrupt two canvases into each
other. Recommend the comment now, the refactor if the loop is ever touched.

### 3.4 `devicePixelRatio`, `display:none`, off-screen

- **DPR change is handled.** `dpr` is read every paint (`:46`) and the backing
  store is resized when it disagrees (`:49`). Moving to a different-density
  monitor recovers on the next frame.
- **`display:none` is handled**, but by luck rather than design: such an element
  has an all-zero `getBoundingClientRect`, so `!r.width` skips it at `:171`
  before `paint()` runs. Worth an explicit comment, since the `:47`
  `el.clientWidth || el.width` fallback *would* mis-size it if it ever got that
  far.
- **Off-screen is only vertical.** `:171` checks `bottom < 0` and
  `top > innerHeight` but never horizontal. A canvas scrolled off to the side
  keeps painting. Minor; add the two comparisons.
- `visibility:hidden` / `opacity:0` elements keep a rect and **do** paint.

### 3.5 `Path2D` and `localStorage`

- `new Path2D()` (`:125`) is unguarded, but the `try/catch` at `:172` is
  **empty** — so a missing `Path2D` produces a silently blank sphere with no
  console output, forever. Path2D is universally available in WKWebView on
  macOS 13+, so this is not a real risk here; the **empty catch is**, because it
  hides every other bug too. Log once, then suppress.
- `localStorage` is **not used by the renderer at all** — that is the editor page
  in the prototype. For the desktop app the editor's presets should go to the
  app's SQLite store, not `localStorage`, so they survive a webview data clear
  and are covered by the existing "delete all my data" path.

### 3.6 Is 26 000 affordable?

Measured on this machine (Apple silicon, JavaScriptCore — the same engine family
as WKWebView), replicating the per-particle hot loop; the renderer's own frame
budget is 26 ms (~38 fps):

| Particles | ms/frame | % of budget |
|---|---|---|
| 7 800 (a gallery card at 30 %) | 0.40 | 2 % |
| **26 000 (the shipped default)** | **0.84** | **3 %** |
| 36 000 (slider maximum) | 1.16 | 4 % |
| 104 000 (gallery page: header + 10 cards) | 3.38 | 13 % |

Rasterisation adds to this, but the bucketing means ~264 `fill()` calls, not
26 000 — that is cheap.

**Answer: yes, comfortably.** And the lowest-spec target is not in doubt: the
app is Apple-silicon only (`aarch64-apple-darwin` sidecars) with
`minimumSystemVersion: 13.0`, so the floor is an M1 MacBook Air. 26 000 costs
~3 % of the frame budget there.

**A device tier is therefore not needed for capability — but is still worth
having for battery**, which the benchmark does not measure. Recommend a single
tier driven by two real signals rather than a device probe:

- `prefers-reduced-motion: reduce` → static, single frame (see 3.7)
- on battery / low-power mode → `countScale: 0.5` and a 50 ms frame cap

### 3.7 Accessibility

- **`prefers-reduced-motion` is honoured nowhere** — not in the handoff, not in
  `workshop.css`. Recommendation: **render one frame and stop.** Not a slower
  spin — vestibular triggers come from continuous motion, and a slowly rotating
  26 000-particle sphere is still continuous motion. A static sphere keeps the
  entire visual identity at zero motion cost. Re-render only on state change.
  Implement inside the renderer via `matchMedia`, with a live `change` listener
  so it responds without a reload.
- The canvas needs `aria-hidden="true"`. It is decorative; the state it conveys
  is already announced in text ("Listening for…"). Without it, screen readers
  announce an unlabelled canvas on every view.

---

## 4. Design-system audit

The codebase's real token set is one `:root` block: `workshop.css:309`. The
Tailwind config maps `--border`, `--dashboard-*`, `--orb-*` etc., **none of
which are defined in `workshop.css`** — a parallel, largely dead shadcn system.
Target the Workshop tokens, not the Tailwind ones.

| Handoff | Codebase | Verdict |
|---|---|---|
| `#f9f7f4` page | `--pg` | **exact** |
| `#f1eeea` rise | `--rz` | **exact** |
| `#edebe7` skin | `--sk` | **exact** |
| `#1e1e24` ink | `--ink` | **exact** |
| `#6d6a67` / `#b6b1aa` | `--ink2` / `--ink3` | **exact** |
| `#e2ded7` border | `--bd` | **exact** |
| `#3461f2` accent | `--acc` | **exact** |
| `#5b7cff` hover | `--acch` | **exact** |
| `#2f4bbd` accent-deep | `--acc-text` = `#2a4fd0` | **COLLISION** |
| `#fffdfa` surface | none (`--wt` is `#ffffff`) | **gap** |
| `#e8e4dd` / `#e6e2db` | none | **gap** |
| `#0fae76` emerald | `--grn` = `#2f7d4f` | **collision (role)** |
| `#d0453a` danger | `--red` = `#c14a35` | **collision (role)** |
| `#e07a1f` amber | none | **gap** |
| `#8b8681`, `#6d8bff`, `#33312f`, `#1b1b21` | none | **gap** |

**Recommendation:** adopt the handoff values as the source of truth and *update*
`--acc-text`, `--grn`, `--red` rather than introducing parallel names — the
handoff is the newer design decision and duplicate near-identical greens would
be worse than a one-line change. Add `--surface: #fffdfa`, `--bd-soft`,
`--amber`, `--neutral`, `--handoff`, `--body` as new tokens. Then replace the
four hardcoded `#fffdfa` occurrences in the auth screen with the new token.

**Already correct, no work needed:** the app is **already the warm light theme**
(`workshop.css:310`, `background: var(--pg)`), and **Hanken Grotesk + Geist are
already self-hosted and live** (`public/fonts/fonts.css`, loaded via
`index.html:12`). The handoff's typography needs no pipeline work at all.

**Pattern violations to adapt rather than copy:** the prototypes inline every
hex; the codebase uses `var(--token)` throughout. Port to tokens. The prototype
uses `localStorage`; use the app's store. The prototype's `.dc.html` structure
should not be ported — only values.

---

## 5. Header-change impact

**The blast radius is one file.** `hdrB` and `HeaderWave` appear only in
`src/pages/atlas/AtlasDashboard.tsx:128-140` (+ `workshop.css:23,701`). Only
`/` and `/dashboard` render it. Every other route has its own unrelated header:
`/home` `.homehead`, `/atlas-core` `.corehead`, `/atlas-core-legacy`, `/atlas-demo`,
`/atlas-architecture`. `/auth` and `*` have none.

**And the bottom dock already exists** (`AtlasDashboard.tsx:161-179`) with Core,
Control, Voice, Settings, New chat and a Profile avatar. So this is a
consolidation inside one file, not a new navigation paradigm.

What the top bar carried, and where it goes:

| Carried | Today | After removal |
|---|---|---|
| Wordmark "atlas" (`:132`), click → `/` | header | **Regression.** The dock has no home affordance and no branding. Recommend the sphere itself becomes the home affordance (it is already clickable to open the drawer — needs a second gesture or a dock "Home" item). |
| `HeaderWave` audio-reactive visualiser (`:130`) | header | Superseded by the band sphere — it conveys the same state. **No regression.** |
| Listening state label (`:137`, `atlasStateLabel`) | header | **Regression — and it matters.** This is the only text that tells the user the wake phrase and whether Atlas is listening. It must land somewhere: recommend under the greeting subline, or as a persistent dock chip. Do not drop it; it is also the honest disclosure of an active microphone. |
| Manual activate (click the visualiser, `:134`) | header | Dock already has a Voice button (`:169`). **Covered.** |
| Avatar / account menu | **never existed in the header** | No regression. But note there is *no account menu anywhere in the app* — the Profile chip navigates to `/atlas-core`. Sign-out, plan and the new account-deletion flow have no home. **Pre-existing gap the handoff does not solve.** |

**Verdict: the dock covers navigation, but not branding, not the listening
indicator, and not account access.** Two of those three are real regressions.

---

## 6. The seven open questions

**1. Where do the wordmark, listening indicator and account menu live now?**
Wordmark → the dock needs a Home item, or the sphere becomes the home affordance
(it is already interactive). Listening indicator → under the greeting subline;
it is a microphone disclosure and must stay visible. Account menu → does not
exist today and should be built as a real menu on the Profile chip (sign-out,
plan, delete account), because account deletion is now a published promise.

**2. Which sphere states can the product reach?**
Four: `idle`, `listening`, `thinking`, `speaking`. See §1.1 for the six others
and the recommendation to build triggers for `working`/`success`/`alert`, build
the control first for `muted`, and cut `waking`/`dissolving`.

**3. Which Mail confidence/statistics fields have a real source?**
"14 threads since 6am", the counts and the mailbox count are derivable. The
`€86k` amount is model-extracted and must be presented as such. `confidence
0.94` and "matched 214 prior answers" have **no source — remove them**.

**4. Is 26 000 affordable, and what is the fallback tier?**
Yes: 0.84 ms/frame, 3 % of the 26 ms budget, and the lowest-spec target is an M1
Air (Apple-silicon-only build). No capability tier needed. Add a
`prefers-reduced-motion` static mode and an optional battery-saver
`countScale: 0.5`.

**5. How is `prefers-reduced-motion` honoured?**
**Static sphere** — render one frame, re-render on state change only. Not a
slower spin; continuous motion is the trigger regardless of speed.

**6. Is the audit trail append-only and server-owned?**
**Append-only yes, server-owned no — ANSWERED 2026-07-26: local.** Server storage
would put message-derived content on our servers for the first time and falsify
the published privacy policy; the trail's real reader is the account owner, who
does not need to be convinced by tamper-evidence. It lives in `atlas.db`,
insert-only, with the full event schema, and the design copy drops from "Atlas
keeps the record" to "Logged on this Mac". See §2.3.1.

**7. What are the real autonomy rules?**
None exist; the prototype hardcodes them. They must become user-editable data
(`Rule` table, per-mailbox). The three shown are a reasonable *default set* to
ship, but "fully autonomous on `hello@`" should not be a default anyone gets
without opting in — an agent that sends mail unsupervised is the highest-risk
behaviour in the product.

---

## 7. Proposed implementation plan

Sequenced so each stage is independently shippable and the risky decisions come
first. **Nothing starts until the P0 decisions are made.**

**Stage 0 — decisions (you).** (a) Canvas sphere replaces WebGL, or not?
(b) Audit trail local or server? (c) Mail before or after the Phase-7 mail
worker? (d) Accept the three token value changes?

> Status 2026-07-26: **(b) decided — local** (§2.3.1). **(d) decided — accepted**,
> shipped in Stage 2. **(a) is now a look-at-it call** on `/atlas-sphere`, with
> the evidence in the addendum; both renderers are still mounted, nothing
> deleted. **(c) open**, and effectively answered by Phase 7's schedule.

**Stage 1 — sphere renderer (1–2 days).** Port `atlas-sphere.js` into
`src/lib/atlasSphere.ts` with the five fixes: remount bug, watchdog rewrite,
loop teardown at zero entries, `prefers-reduced-motion` static mode,
`aria-hidden`. Wrap in `<AtlasSphereCanvas>` owning the canvas. Keep the WebGL
sphere mounted in parallel behind a flag so they can be compared on the same
screen before anything is deleted.

**Stage 2 — tokens (half a day).** Update `--acc-text`, `--grn`, `--red`; add
`--surface`, `--bd-soft`, `--amber`, `--neutral`, `--handoff`, `--body`. Replace
the four hardcoded `#fffdfa`. Delete the dead dark `body{}` rule and the
Manrope/Sora declarations.

**Stage 3 — header + dock (1 day).** Remove `hdrB` from `AtlasDashboard`,
promote the greeting band, relocate the listening indicator, add Home to the
dock, fix Core/Control both pointing at `/atlas-core`, and build the real
account menu on the Profile chip.

**Stage 4 — sphere state triggers (1–2 days).** Wire `working`, `success`,
`alert` to existing signals (runs, run completion, integrity/error paths). Add a
mute control, then `muted`. Cut `waking`/`dissolving` from the contract.

**Stage 5 — Atlas Sphere gallery page (1 day).** Only worth building as an
internal QA route; it is a design tool, not a user feature. Behind the same
dev-route treatment as `/atlas-architecture`.

**Stage 6 — Mail (blocked, then 1–2 weeks).** Requires the Phase-7 mail worker
and the thread/rule/audit schema; Stage-0(b) is settled (local trail, §2.3.1),
so the audit table is a plain `atlas.db` migration alongside the rest of the mail
schema rather than a new server surface. Build the data layer
and the three-pane shell before any of the delight (drafting shimmer, ambient
strip). Ship with undo-send, keyboard nav, virtualisation and timezone-correct
scheduling — those are not polish, they are what makes an autonomous mail agent
safe to use.

---

## Addendum — 2026-07-26, after implementing stages 1–5

**§P0-1 (canvas vs WebGL) now has evidence rather than argument.** /atlas-sphere
mounts both renderers on the same state. Two things came out of it:

1. The WebGL sphere appeared blank there, which I first reported as a possible
   shipped bug. **That was wrong.** `AtlasCore` pauses rendering when the window
   is unfocused (`useWindowActivity`, a deliberate power win) and used
   `frameloop='never'`, which refuses even the first draw — so a sphere mounted
   in an unfocused window never drew once and stayed an empty box. Fixed to
   `'demand'`: it now paints on mount. The diagnosis that settled it was
   `CURRENT_PROGRAM === null` on a live GL context with a correct viewport — not
   one draw call had ever been issued.
2. **The comparison favours the canvas renderer, visibly.** On `alert` the
   canvas sphere turns red; the WebGL one stays pale, because its palette has no
   red *and*, while unfocused, it cannot animate a state transition at all
   (state is expressed through `useFrame` over time, not static props). The
   canvas renderer also costs 0.84 ms/frame against three.js's ~1 MB of bundle.

Recommendation: **adopt the canvas renderer and drop three.js**, once you have
looked at both on `/atlas-sphere` yourself. Nothing has been deleted — both are
still mounted.

Stages 2, 3, 4 and 5 are implemented and pushed.

**§2.3 (audit trail) is decided: local.** Recorded in §2.3.1 with the reasoning
and the five consequences for Stage 6 — including the copy change from "Atlas
keeps the record" to "Logged on this Mac", which is the one place the handoff
now overstates what the product does.

Stage 6 (Mail) therefore has **one** remaining blocker: the Phase-7 Cloudflare
mail worker. Nothing about Mail should be started before it exists — the backend
is stubbed out in `localClient.ts:411-412` and table reads return empty forever.
