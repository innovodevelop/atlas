# Atlas Beta — redesign plan

Goal: every Atlas screen redesigned to the Beta language, packaged as a handoff the codebase can diff against suite v2.

## Phase 0 — Lock the Beta guidelines (first)
Pull the rules out of `Atlas Dashboard Beta.dc.html` into one reference page, `Atlas Beta Guidelines.dc.html`, so every later screen is built from the same source.
- Stage band anatomy: sphere size, greeting type, band height and how the band collapses on narrow widths
- Widget grid: columns, gaps, the expanded-widget patterns (chart, stats, side list)
- Full view template: band header + content grid + side rail
- Status-bar panels: panel shell, switch, device row, empty state, footer link
- Veil sphere states and colours, plus when each motion plays
- Icon style: **1a Precision** (decided)
- Paper scale, CLAUDE.md flat/borderless rules, type, Dock behaviour

## Phase 1 — Close the open Beta gaps
1. **Settings** in Beta: the code already has `AtlasSettings.tsx`, so redesign it and point the Wi-Fi, Bluetooth, Devices and Battery links at its sections
2. Persistence: what the dashboard remembers across sessions (layout, widget order, mail folder, sphere state)
3. Grid and Centred layouts redesigned in Beta (decided: they get redesigned now and will be retired later, so keep the effort light)

## Phase 2 — Core workspace screens (Dock order)
Each one gets the Stage band and a full-view body. Build them in Dock order:
1. **Home**, merged into or distinct from the Beta dashboard (**decision needed**)
2. **Core**
3. **Teach**
4. **Mail**: the standalone page becomes the Beta email client, wired to the existing accounts/sync code
5. **Architecture**
6. **Voice**, the sphere-led conversation surface

## Phase 3 — Life surfaces
**Banking/Money, Health, Smart Home** (+ HomeKit Lab), Music Player, Answer Views. Each one reuses the full-view template and widget patterns, so it should be quick.

## Phase 4 — System and entry
**Entry flow (priority):** Login, Sign up, Onboarding (permissions included), Intro.
**School** (from the 11 August brief), Clock, Status Bar, Test Lab.
Then: Model Lab, Widget Catalog, Widget Sheet, plus the Status Bar, Clock, School and Test Lab briefs that haven't been built yet.

These are in the code but have never had a design. They get Beta designs here:
- **Agent View** (`AtlasAgentView.tsx`)
- **System Status** (`AtlasSystemStatus.tsx`), which pairs with the Devices and Battery panels
- **HomeKit Lab** (`AtlasHomeKitLab.tsx`), folded into Smart Home or kept as a dev tool (**decision needed**)
- **Tests, Versions, Design Sync**: internal tools. A light Beta pass only, using the full-view template

## Phase 5 — Mobile
iOS versions of the dashboard, Mail and Voice in the Beta style.

## Phase 6 — Handoff
`design_handoff_atlas_beta/` in the same structure as suite v2: one DC per screen, a README with the guidelines summary, a screen map against `src/pages`, and changes listed against v2.

## How each screen is done
1. Read the suite v2 version and the matching `src/pages` file so features stay in parity
2. Rebuild it in Beta in its own file, `Atlas <Screen> Beta.dc.html`
3. Check it against the guidelines page and CLAUDE.md
4. You review it, and it's marked ready in this file

## Status
- [x] Dashboard Beta, Veil sphere, email client, status panels, icon set
- [x] Phase 0 guidelines: `Atlas Beta Guidelines.dc.html` · icons 1a
- [x] Dashboard editor redesigned in Beta (Edit Home: live reorder by drag, sizes, add/remove, capacity meter, layout switch, Cancel restores)
- [x] Phase 1: Settings (`Atlas Settings Beta.dc.html`), persistence (`Beta Persistence Spec.md`), Grid + Centred given a light Beta pass
- [~] Phase 2: Core ✓ (`Atlas Core Beta.dc.html`), Teach ✓ (`Atlas Teach Beta.dc.html`), Mail ✓ standalone `Atlas Mail Beta.dc.html` (Needs you / Atlas handled / Inbox / Snoozed / Sent / Archive, accounts with their rules, Atlas card per message with approve/undo, drafts with rewrites, snooze, compose with Atlas writing + first-contact warning + send later, keyboard J/K/E/R/H/C, undo toasts); the dashboard’s inbox full view stays as the quick version, Architecture ✓ (`Atlas Architecture Beta.dc.html`), Voice ✓ (`Atlas Voice Beta.dc.html`). Dock added to every Beta page
- [~] Phase 3: Money ✓ (`Atlas Money Beta.dc.html`), Health ✓ (`Atlas Health Beta.dc.html`), Smart Home ✓ (`Atlas Smart Home Beta.dc.html`), Music ✓ (`Atlas Music Beta.dc.html`), Browser ✓ (`Atlas Browser Beta.dc.html`); Answer Views ✓ (`Atlas Answer Views Beta.dc.html`)
- [~] Phase 4: Login + Sign up + Forgot + Onboarding (intro → permissions → macOS asks → welcome) ✓ in `Atlas Entry Beta.dc.html`; School ✓ (`Atlas School Beta.dc.html` + `Atlas School Tools Beta.dc.html` for Spreadsheet and Writing), Clock ✓ (`Atlas Clock Beta.dc.html`), Model Lab ✓ (`Atlas Model Lab Beta.dc.html`), Widget Catalog + Widget Sheet ✓ merged into `Atlas Widgets Beta.dc.html` (Catalog tab: every widget × S/M/L × paper/ink × data/empty; States tab: loading/default/attention/empty/offline for the six core widgets; the Sheet's "proposed widgets" dropped since they now live in the catalog); Agent View ✓, System Status ✓, Dev tools ✓ (see Phase 4 completions)
- [ ] Phase 5 (iOS: Home, Mail, Voice)
- [ ] Phase 6 (handoff package)
- [ ] Dock choice (deferred)

## Shared runtime
- `atlas-topbar.js`: dashboard status bar on every screen (wordmark, Atlas state, current screen, devices/BT/Wi-Fi/battery → System Status)
- `atlas-orb.js`: Talk to Atlas. Uses the page’s header sphere when there is one (drives its state and the top bar), otherwise a 128px sphere bottom-left; adds bottom clearance to scroll areas
- Page transitions: cross-document View Transitions when Atlas runs top-level; a JS fade/scale when embedded
- `atlas-quickstart-sphere.js` supports `bg: 'transparent'` (used for small spheres; large ones keep an opaque bg matching their panel for performance)

## Tailored screens (no generic Stage band)
Each of these now has its own layout built around its job. Previous versions kept as `… Beta v1.dc.html`.
- **Music**: ink listening room: spinning record + cover, giant title, waveform scrubber, big transport, ducking switch, Up next / Lyrics / Rooms (per-speaker volume), mood stations
- **Smart Home**: home readout + Home/Away/Night, scenes, rooms rail, interactive three.js device stage (`atlas-devices-3d.js`: lamp, bulb, speaker, thermostat, lock, camera, blinds, rendered with PBR + soft shadows), 3D-rendered device tiles, per-type controls, energy, automations
- **Health**: readiness rings hero, live heart + ECG, full-width sleep hypnogram with Atlas fix, steps 7/30 days, workouts, daily log (water, mood, meds), vitals with trends
- **Clock**: giant live time hero on ink with a 24-hour day/night band and city markers; tabs and tools unchanged
- **Money**: ink hero with the sphere inside a budget ring (categories as arcs, pace tick), held-payment approval, 30-day projected cash flow with clickable bills/salary, transactions by category, subscriptions with Atlas cancel, savings goals
- **Answer Views**: full screen and shaped by the question. The sphere thinks large in the centre, then moves to the corner and speaks the one-line answer while the view assembles: weather (rain timeline vs your calendar), spending (big number + weeks + merchants), departures board, side-by-side comparison with Atlas’s pick, person card with memories, plain-language explainer with key dates. Free text is routed to the closest shape
- **Sphere on every screen**: Music (header, speaks while playing), Health (inside the readiness rings), Smart Home (beside the home temperature, reacts to mode and scenes), Money (inside the budget ring)
- **School**: ink “school day” hero with live module ribbon, next-due card and quick stats; new tabs Studieplan (auto-planned week + focus timer), Kort (spaced-repetition flashcards), Tutor (Socratic, hints in three steps, never writes the answer), Karakterer (grades, absence, trends), Eksamen (countdowns + revision readiness)

## Widget screens and fluid navigation
- `Atlas Widget Screens Beta.dc.html` #weather (incl. air quality; sphere rides the sun arc) · #calendar (day timeline; sphere on the now line; Atlas finds free time) · #tasks (sphere in the progress ring; Atlas takes tasks) · #briefing (editorial; sphere is the Listen button) · #podcast (chapters; sphere is the play button) · #focus (sphere inside the timer ring)
- Every widget on Home now opens a standalone screen: the rest map to Mail, Money, Clock, Music, Health and Smart Home
- Cross-document view transitions on every Beta page: the tapped widget morphs into the destination hero, the Dock stays put, everything else cross-fades with a slight scale. Switching views inside a page uses the same transition

## Phase 4 completions
- **Agent View** `Atlas Agent View Beta.dc.html`: runs list, sphere hero with goal/limit/pause/stop-and-undo, plan steps with inline approval, live activity log (read/think/tool/write/check)
- **System Status** `Atlas System Status Beta.dc.html`: health headline with sphere (alert→success on re-check), uptime/actions/model calls/battery, device battery rings, services with latency sparklines, on-Mac storage, recent events
- **Dev tools** `Atlas Dev Tools Beta.dc.html` #tests #versions #sync (light pass)
- **HomeKit Lab** stays a separate developer tool (decided)
- **Tailored heroes** replaced the generic band on Core (ink orbit lab), Teach (the sphere is the mic), Architecture (isometric layer stack with the sphere on top), Settings (compact utility header), Browser (the hero is the address bar), Model Lab (ink lab bench with crosshair specimen)
- Dock choice deferred by Marcus

## Dock explorations
`Atlas Dock Explorations.dc.html`: 3a Lens · 3b Sphere hub · 3c Breadcrumb rail · 3d Capsule (⌘J) · 3e Colour lane · 3f Status dock. **Decision needed** before rolling one out to every Beta page.

## Website (helloatlas.com)
Separate from the app, built from the same Beta tokens. Every page shares one header: wordmark pill on the left; Sign in · Request access · **Menu ⌘K** on the right, which opens a full-screen ink index (Esc closes).

1. [x] **Home**: `Atlas Site Beta.dc.html`. Hero = 2a Eclipse (ink panel, sphere rising over the fold, state chips) + 2d ⌘K menu. Previous hero kept in `Atlas Site Beta v1.dc.html`; explorations in `Atlas Site Hero Explorations.dc.html`
2. [x] **Features + Pricing**: `Atlas Site Features Beta.dc.html` (Home, Mail, Voice, Limits, Audit trail, Memory, Connections; Pricing at #pricing with monthly/yearly + FAQ)
3. [x] **About**: `Atlas Site About Beta.dc.html` (story, principles, timeline, team, #careers, #press)
4. [x] **Support**: `Atlas Site Support Beta.dc.html` (#help, #article, #ask, #status, #changelog, #contact)
5. [x] **Account**: `Atlas Site Account Beta.dc.html`
   - Signed out: Sign in (passkey or email) → 6-digit code, Create account (strength meter, terms), Forgot password
   - Signed in (sign in, use "Preview the signed-in account", open any #section link, or the `signedIn` tweak): Overview (#download), Profile, Sign-in & security (2FA, passkeys, recovery codes, sessions), Macs, Plan & billing (change plan, card, details, invoices, cancel), Household (seats, invite), Connections (revoke), Email, Privacy & data (sync, export, delete with confirmation)
6. [x] Help centre articles: `Atlas Site Article Beta.dc.html#<slug>` (13 articles, 2–3 per category, category nav, on-this-page, feedback, previous/next). Support, console and widget link into it
7. [x] New pages: `Atlas Site Trust Beta.dc.html` (promises, what stays/leaves with a sync toggle, practices, subprocessors, disclosure), `Atlas Site Download Beta.dc.html` (download, install steps, requirements, other platforms), `Atlas Site Legal Beta.dc.html` (#terms #privacy #cookies with cookie choices), `Atlas Site Careers Beta.dc.html#<role>` (posting, hiring steps, apply). Press kit stays in About #press
8. [x] Site → app: Download step 3 and Account Overview “Open Atlas” go to `Atlas Entry Beta.dc.html`; request-access confirmation offers the download. Shared footer now has Product / Company / Support / Legal
9. [~] Mobile: header collapses to wordmark + Menu under 640px on every page; full phone-width pass on each page still to do
10. [ ] Replace placeholder content (team, prices, company details, integrations) and add real imagery
11. [ ] Add the site to the Phase 6 handoff as its own section with a page list

## Atlas Support (live chat platform)
Atlas answers first, hands over to a person when it isn’t confident or a guardrail applies, and briefs that person so the customer never repeats themselves.
1. [x] **Console** `Atlas Support Console.dc.html`: #live (queue lanes Need you / Atlas / Mine / Resolved sorted by Atlas priority, conversation with take over / hand back, Atlas drafts with rewrites, internal notes, Atlas summary + sentiment + suggested actions, customer panel with account controls) and #overview (real-time wall, surge alert, live floor, hourly chart, people on shift)
2. [x] **Admin** `Atlas Support Admin.dc.html`: #insights, #atlas (autonomy mode, confidence threshold simulator, per-topic modes, guardrails, voice, sandbox test), #customers (search, account controls, timeline), #team (roles, skills, permissions matrix, invite), #routing (queues, SLAs, escalation, hours), #audit, #settings (widget, tools, data and keys)
3. [x] **Widget** `Atlas Support Widget.dc.html`: sphere launcher, proactive nudge, Atlas-first answers with citations, in-chat charges + refund action, handover card with briefing and honest wait, person joined, rating; voice and attach; scenes + “Play the full story”
4. [ ] Mobile widget (full-screen sheet), agent mobile app, email channel view, macros library, knowledge editor
