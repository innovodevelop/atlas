# Claude Code prompt — Atlas suite audit + implementation

Written for a Claude Code session with the `helloatlas` repo open and the
`design_handoff_atlas_suite_v2` bundle available. Paste everything below the line.

---

**You have the repo and a design handoff. Before you change anything, run the app, audit it
in both directions, and write the audit down. Then implement in four tracks.**

The handoff is `design_handoff_atlas_suite_v2/` — start with its `README.md`. The
`.dc.html` files are design references: open them in a browser, read them for exact values,
do **not** port their structure. `atlas-sphere.js` and `atlas-cover.js` are real portable
code and should be lifted rather than rewritten.

## Phase 0 — Run it first

`bun install && bun dev`. Visit every route in `src/App.tsx`: `/`, `/home`, `/atlas-core`,
`/mail`, `/auth`, `/permissions`, `/atlas-sphere`, `/atlas-architecture`, `/atlas-teach`,
`/atlas-demo`, `/atlas-core-legacy`. Open the dashboard overlays (weather, calendar, tasks,
stocks, email, news, music) and Settings.

Report **what actually renders** — screenshots or a plain description per route, console
errors, anything dead or broken — before you read a single spec. If a route does not run,
say so and stop there rather than guessing.

## Phase 1 — Audit A: code against the last handoff

The previous bundle (`design_handoff_atlas_sphere_and_mail`, audited in
`docs/design-sync/2026-07-26-audit-sphere-mail-header.md` and `2026-07-27-mail-contract.md`)
specified the shared sphere renderer, the Sphere gallery, Mail, and the header-band change.

For each: **shipped / drifted / missing**, with file and line references. Where it drifted,
say whether the drift was deliberate (a product decision that should be written back into the
design) or accidental.

Pay particular attention to the three parallel sphere implementations —
`src/lib/atlasSphere.ts` + `AtlasSphereCanvas.tsx`, the three.js `AtlasSphere.tsx` behind
`AtlasSphereLazy`, and `src/components/atlas-ui/MusicSphere.tsx`. Establish which surfaces use
which, what each one implements that the others don't, and what it costs to converge on one.

## Phase 2 — Audit B: the new design against the code

README §1 lists what is new. For each item, name the files that must change, and flag
anything the app cannot support (missing data, no API, native constraint). README §2 is my
map of the repo — verify it; correct it where I'm wrong.

Deliver Phase 1 + 2 as one written report at `docs/design-sync/<date>-audit-atlas-suite-v2.md`
with a **prioritised gap list**, before any implementation. Flag anything ambiguous or
contradictory rather than picking for me — except where the handoff already states the rule.

## Phase 3 — Implement, in four tracks

Land each track as its own reviewable change. Don't start a track before its audit section
is written.

**T1 · Borderless pass.** README §1.1, on every shipped surface: dashboard, home, core,
mail, teach, architecture, settings, permissions, auth, sphere gallery. Fill and space only;
no 1px separators. Every `button`, `input`, `textarea` sets `border: none` explicitly.
Illustration strokes stay. Verify against the `.dc.html` references — several of them
changed layout when the borders came out, they aren't just border deletions.

**T2 · Sphere consolidation + music.** Converge on **one** renderer (my recommendation: the
canvas-2D shared one, upgraded to v3 per README §3 — the three.js copy and `MusicSphere.tsx`
retire). Port `atlas-cover.js`. Rebuild the music surface as Music Player v2 (README §5) on
the shared renderer, wired to the real player state in `useMusicPlayer`. Add the morph/field
controls to the Sphere gallery. Honour the perf contract in §3 — the quality/cache coupling
and the watchdog rules are load-bearing, both caused hard main-thread locks.

**T3 · The missing surfaces.** Smart Home, Health, Banking, Widget Catalog, Widget Sheet,
Browser, Model Lab, Answer Views, Onboarding. For each: route, dock entry (if it belongs
there), data source or an explicit mock boundary, populated **and** empty states. Several of
these imply backend that does not exist — say so in the audit and build against a clearly
marked mock rather than inventing an API.

**T4 · Admin redesign.** Settings (currently a dashboard overlay with no route), Permissions,
`/atlas-core-legacy` and the ~38 orphaned components under `src/components/atlas-health/`.
Decide per component: redesign into Core/Settings, or delete. Nothing stays reachable only by
typing a URL. Read `docs/ROADMAP.md` before deleting anything.

## Rules

- The accent is **Atlas Blue `#3461f2`**. Any orange in an older doc or in
  `Atlas Brand Guide.dc.html` is stale.
- The dock is mandatory on every full-page surface: icon-only at rest with `title` tooltips,
  only the current screen shows a label.
- **"Atlas Control" is out of scope** — a dock link in old prototypes, never designed, never built.
- `Atlas Permission Lab.dc.html` is an exploration canvas (options 1a–2k), not a spec. It
  needs a decision from me, not an implementation.
- Keep the app's own patterns: `workshop.css`, existing components, existing state
  management. Prototype helpers (`atlas-transition.js`, `atlas-models.js`, `atlas-devices.js`,
  `atlas-filings.js`, `image-slot.js`, `support.js`) are **not** for porting.
- Update `docs/design-sync/` and `design/.sync-manifest.json` as you go — that trail is how
  the next handoff gets audited.
