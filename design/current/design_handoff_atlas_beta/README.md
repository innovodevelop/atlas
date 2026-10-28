# Atlas Beta: implementation handoff (app)

For **Claude Code**, working in the `helloatlas` repo (Tauri v2 + React/TS webview, Rust core, Bun sidecars). Read the repo's `CLAUDE.md` first: hard constraints (no `cargo update`, Bun only, no secrets) still apply.

Every `.dc.html` file in this folder opens directly in a browser and is the **source of truth for layout, copy, states and behaviour**. They are prototypes: rebuild them as React components in the repo; do not ship them as-is.

## The one rule that matters most

**Implement the features, not just the look.** Every control, state and flow you can see or click in these designs is in scope. Where the current app doesn't have the feature yet (for example spaced-repetition flashcards in School, the Agent View plan with approvals, the 3D device stage in Smart Home, the weather sky, the Mail "Atlas handled" lane with undo, held-payment approval in Money), **build the feature alongside the design**: data model, Rust/brain plumbing, persistence and tests. Where data is mocked in a design, wire it to the real source (DB, sidecar, connector). If a real source doesn't exist yet, add a typed adapter with a fixture so the UI is real and the source can be filled in later. Never leave a visible control that does nothing.

## Design rules (from `Atlas Beta Guidelines.dc.html` and project CLAUDE.md)

- **Flat, borderless.** Surfaces step page `#f9f7f4` → panel `#f1eeea` → card `#fffdfa`. Recessed areas go darker. Every `button`/`input`/`textarea` sets `border:none`.
- **Colour.** Atlas Blue `#3461f2`, ink `#1e1e24`, ink2 `#6d6a67`, neutral `#8b8681`, tertiary `#b6b1aa` (placeholders/timestamps only), green `#0fae76`/`#0a7a53`, red `#d0453a`/`#a3352c`. Emphasis fill `#eef2fe`. Hover shifts background (`#edebe7`, destructive `#f7e6e4`). On ink, small text never below `rgba(249,247,244,.62)`, body `.78`.
- **Type.** Hanken Grotesk for display and headings, Geist for UI and body, Geist Mono for numbers in tables and logs.
- **Icons.** Set 1a “Precision”, from `atlas-icon-data.js`.
- **Sphere.** Every screen shows the Atlas sphere, and it always reflects Atlas’s real state: idle, listening, thinking, speaking, working, success, alert, muted. Screens with a header sphere use it as the talk entry point. Others get the 128px bottom-left sphere. See `atlas-orb.js`.
- **Top bar** on every screen, `atlas-topbar.js`: wordmark → Home, Atlas state, current screen, devices / Bluetooth / Wi-Fi / battery → System Status.
- **Transitions.** Navigating feels like Home reshaping, not a page load: the tapped widget morphs into the destination hero (`view-transition-name: hero`), the Dock stays put, and the rest cross-fades with a slight scale. In the Tauri webview use same-document View Transitions with React Router.

## Reference files

- `atlas-quickstart-sphere.js`: the particle sphere. Port it to `src/components/atlas/`. It supports `bg:'transparent'`; keep large spheres on an opaque background that matches their panel, for performance.
- `atlas-orb.js`: the Talk to Atlas behaviour. Wire it to the voice gateway and brain.
- `atlas-topbar.js`: the status bar. Wire it to real device and battery data from Rust.
- `atlas-weather-sky.js`: the WebGL weather sky. Uniforms are cloud / rain / wind / sun / night / fog, eased between targets.
- `atlas-devices-3d.js`: three.js device models: lamp, bulb, speaker, thermostat, lock, camera, blinds.
- `Beta Redesign Plan.md`: the decision log.

## Implementation phases

Each phase ends with: typecheck clean, unit tests for new logic, Playwright smoke test per screen, a macOS build on the local CLI, and every visible control functional. Ship each phase behind the `beta_ui` flag, then flip the default in phase 8.

### Phase 1 · Foundation
- Design tokens (colours, surfaces, radii, type) as TS constants plus CSS variables. Remove borders app-wide.
- Port the sphere engine (with transparent support), the icon set, `TopBar`, `Dock` (current behaviour; final dock choice is pending, so build it swappable), `TalkToAtlas` (orb + panel, ⌥Space, Esc), and route transitions.
- A Sphere state bus: one source of truth for Atlas state (from brain/voice), consumed by every sphere and the top bar.
- Acceptance: an empty Beta shell routes between placeholder screens, with the dock, top bar and sphere reacting to real brain state.

### Phase 2 · Home and widgets
- `Atlas Dashboard Beta`: Stage, Grid and Centred layouts; the greeting band; status panels (Wi-Fi, Bluetooth, Devices, Battery); Edit Home (drag reorder, S/M/L, add/remove, capacity meter, Cancel restores). Persist per `Beta Persistence Spec.md`.
- Widgets: every type in `Atlas Widgets Beta` (Catalog, plus the loading / default / attention / empty / offline states). The Inbox and Watchlist side lists keep equal 12px insets. Now playing gets like, output switching, seek, previous/next, shuffle, repeat, volume, up next and live progress.
- Each widget opens its standalone screen, with the hero morph:
  - Weather, Calendar, Tasks, Briefing, Podcast and Focus go to `Atlas Widget Screens Beta`.
  - The other widgets go to their own app screens.
- Repo: `AtlasDashboard.tsx`, `AtlasHome.tsx`, `AtlasWidgetCatalog.tsx`, `AtlasWidgetSheet.tsx`, `src/components/atlas-ui/`.

### Phase 3 · Communication and knowledge
- **Mail** (`Atlas Mail Beta` → `AtlasMail.tsx`):
  - lanes: Needs you, Atlas handled, Inbox, Snoozed, Sent, Archive
  - per-account rules, and a per-message Atlas card with approve and undo
  - drafts with rewrite options, snooze (including “when X replies”)
  - compose with Atlas writing, a first-contact warning and send later
  - J/K/E/R/H/C shortcuts, and undo toasts
- **Answer Views** (`AtlasAnswerViews.tsx`): question → shape routing (weather, spending, departures, comparison, person, explainer). The sphere thinks in the centre, then moves to the corner. Use the brain’s structured output to choose the layout.
- **Core, Teach and Architecture:** the tailored heroes plus the existing bodies (`AtlasCoreScreen.tsx`, `AtlasTeach.tsx`, `AtlasArchitecture.tsx`).
- **Voice** (`Atlas Voice Beta`).

### Phase 4 · Life surfaces
- **Money** (`AtlasBanking.tsx`):
  - budget ring with category arcs and a pace tick; held-payment approval tied to limits
  - 30-day projected cash flow with event chips; category filter
  - subscription cancel and undo; savings goals
- **Health** (`AtlasHealth.tsx`):
  - readiness rings; live heart rate and ECG; sleep timeline with the Atlas fix
  - steps over 7 or 30 days; workouts; daily log (water, mood, meds); vitals trends
- **Smart Home** (`AtlasSmartHome.tsx`):
  - Home/Away/Night modes, scenes and rooms
  - an interactive three.js stage and 3D thumbnails, with per-type controls
  - energy, automations and Atlas tips; wire to Home Assistant
  - HomeKit Lab stays a separate dev tool (`AtlasHomeKitLab.tsx`)
- **Music:** the listening room: transport, waveform seek, ducking, Up next / Lyrics / Rooms, per-speaker volume and mood stations. Wire to Spotify and the speakers.
- **Clock:** giant time, a 24-hour day/night band with cities, and the existing timer, countdown, alarm and clocks.
- **Weather / Calendar / Tasks / Briefing / Podcast / Focus:** the screens in `Atlas Widget Screens Beta`:
  - Weather: the WebGL sky, which follows the hour and previews any hour you tap; the sun or moon at the top left; air quality.
  - Calendar: free-slot booking.
  - Tasks: delegate to Atlas.
  - Briefing: listen.
  - Podcast: chapters.
  - Focus: a timer that holds notifications.

### Phase 5 · School, Browser, tools
- **School** (`Atlas School Beta` + `School Tools`):
  - the live module ribbon and the Lectio/LearnIT/itslearning connections
  - assignments with Atlas preparation, schedule, messages and materials
  - **new features:** Studieplan (auto-planned week + focus timer), Kort (spaced repetition: Igen/Svær/God/Let), Tutor (Socratic, three-step hints, never writes the answer), Karakterer (grades, absence, trends) and Eksamen (countdowns + revision readiness)
- **Browser** (`AtlasBrowser.tsx`): the address bar as the hero.
- **Model Lab** (`AtlasModelLab.tsx`), **Settings** (`AtlasSettings.tsx`, compact header, deep links from the status panels).

### Phase 6 · System and agent
- **Agent View** (`AtlasAgentView.tsx`):
  - run list; goal and limit; pause, and stop-and-undo
  - the plan, with inline approval steps
  - a live activity log streamed from the brain: read, think, tool, write and check events
- **System Status** (`AtlasSystemStatus.tsx`):
  - a health headline with the sphere; uptime, actions and model calls
  - device battery rings, services with latency, on-Mac storage and recent events
  - re-check runs the real probes
- **Dev tools** (`AtlasTests.tsx`, `AtlasVersions.tsx`, `AtlasDesignSync.tsx`): run tests, promote and roll back channels, a design ⇄ code screen table.

### Phase 7 · Entry and onboarding
- `Atlas Entry Beta` → `Auth.tsx`, `AtlasOnboarding.tsx`, `AtlasPermissions.tsx`: login, sign up, forgot password, and onboarding (intro → permissions → macOS asks → welcome).

### Phase 8 · Polish and cutover
- Accessibility pass (focus order, labels, reduced motion), performance pass (sphere particle budgets, pausing off-screen spheres), phone-width checks, the final dock once Marcus picks one from `Atlas Dock Explorations`, then remove `beta_ui` and the old screens.

## Screen map

| Design file | Repo target |
|---|---|
| Atlas Dashboard Beta | src/pages/atlas/AtlasDashboard.tsx, AtlasHome.tsx |
| Atlas Widgets Beta | AtlasWidgetCatalog.tsx, AtlasWidgetSheet.tsx |
| Atlas Widget Screens Beta | new: src/pages/atlas/widgets/* |
| Atlas Mail Beta | AtlasMail.tsx |
| Atlas Answer Views Beta | AtlasAnswerViews.tsx |
| Atlas Core / Teach / Architecture Beta | AtlasCoreScreen.tsx / AtlasTeach.tsx / AtlasArchitecture.tsx |
| Atlas Voice Beta | new: src/pages/atlas/AtlasVoice.tsx |
| Atlas Money Beta | AtlasBanking.tsx |
| Atlas Health Beta | AtlasHealth.tsx |
| Atlas Smart Home Beta | AtlasSmartHome.tsx |
| Atlas Music / Clock / School / School Tools Beta | new pages |
| Atlas Browser / Model Lab / Settings Beta | AtlasBrowser.tsx / AtlasModelLab.tsx / AtlasSettings.tsx |
| Atlas Agent View / System Status Beta | AtlasAgentView.tsx / AtlasSystemStatus.tsx |
| Atlas Dev Tools Beta | AtlasTests.tsx, AtlasVersions.tsx, AtlasDesignSync.tsx |
| Atlas Entry Beta | Auth.tsx, AtlasOnboarding.tsx, AtlasPermissions.tsx |

## Not in scope

The website and the Atlas Support system, which belongs to the website (see `design_handoff_atlas_site/`), and iOS (not designed yet).
