# Atlas suite handoff v2 — the whole product surface

Supersedes `design_handoff_atlas_sphere_and_mail` (sphere · mail · header band) and the
`atlas-premium-workshop` bundle recorded in `design/.sync-manifest.json` (v4.4, 2026-07-22).
Everything in those two is still valid unless contradicted here.

## How to use this bundle

The `.dc.html` files are **design references** — markup with inline styles, behaviour in a
class below. Open them in a browser to see motion and interaction; read them for exact
values. **Do not port their structure.** Rebuild each surface in the app's own patterns
(React + `workshop.css` + the existing component vocabulary).

One exception, as before: **`atlas-sphere.js` and `atlas-cover.js` are real, portable,
framework-agnostic code.** Lift them; wrap them in components that own their canvas.

Fidelity is **high** — colours, type, spacing, radii, timings and copy are final.

---

## 1 · What changed since the last handoff

### 1.1 Flat and borderless (system-wide, affects every screen)

The suite no longer uses borders. Separation is **fill and space only**. This ran across
45 design views and is now the project's standing rule:

- Surfaces step through a paper scale: page `#f9f7f4` → panel `#f1eeea` → card `#fffdfa`.
  A card on a panel goes **lighter**; a recessed area (dropzone, textarea, nested row) goes
  **darker** (`#f9f7f4` inside `#f1eeea`).
- Emphasis that used to be a blue outline is now a blue-tinted **fill**: `#eef2fe`.
- Hover shifts **background** (`#edebe7`; destructive `#f7e6e4`), never a border colour.
- Divider rules are gone — rows get 15–20px vertical padding and rhythm carries the list.
- Every `button`, `input` and `textarea` must set `border: none` explicitly. Removing a
  border declaration lets the UA default outline back in.
- Illustration strokes (diagram arrows, progress rings, the "edge of your Mac" line) are
  drawings, not element borders — they stay.

Anything in an older handoff that specifies `1px solid …` for separation is superseded.
That includes the pane rings and row borders in the mail spec, and the "hairline borders"
line in `Atlas Brand Guide.dc.html`.

### 1.2 Atlas Sphere v3 — morph, field, artwork palette

`atlas-sphere.js` grew from a ten-state sphere into a **two-formation renderer**. Detail in
§3. Summary: the sphere can unroll into a full-bleed particle **field** and back, driven by
a single `morph` scalar; the field is an even hex lattice sized to the canvas aspect;
particles are round; the palette can be supplied per-frame (so artwork can drive it); and
the quality/DPR contract changed.

### 1.3 Artwork colour pipeline — `atlas-cover.js` (new file)

Extracts a three-tone palette (deep / mid / light) from any image, and generates procedural
sleeve art as a fallback. Everything in the music surface — wash, scrims, particles, vinyl —
is coloured from the record.

### 1.4 Atlas Music Player v2 (replaces `Atlas Music Player.dc.html`)

Full-screen player, a secondary sleeve player, and a compact widget, all on the shared
renderer. Playing = field, paused = sphere. Detail in §5.

### 1.5 Surfaces that have never existed in code

Smart Home, Health, Banking, Widget Catalog, Widget Sheet, Browser, Model Lab, Answer Views,
Onboarding. All are designed and included here.

---

## 2 · Reverse audit — what the repo already has

Read from the attached working copy. Verify each line before trusting it; this is a
starting map, not a source of truth.

| Surface | Repo | State |
| --- | --- | --- |
| Dashboard | `src/pages/atlas/AtlasDashboard.tsx` (route `/`, `/dashboard`) | Built. Band header landed. Needs the borderless pass + re-check against the current design. |
| Home | `src/pages/atlas/AtlasHome.tsx` (`/home`) | Built. Same. |
| Core | `src/pages/atlas/AtlasCoreScreen.tsx` (`/atlas-core`) | Built after the 2026-08-02 prompt. Re-audit against `Atlas Core.dc.html`, incl. the Memory tab. |
| Mail | `src/pages/atlas/AtlasMail.tsx` (`/mail`), `src/styles/mail.css` | Built. Audited in `docs/design-sync/2026-07-26` + `2026-07-27-mail-contract.md`. Needs the borderless pass — the spec it was built from used 1px pane rings and row borders. |
| Teach | `src/pages/AtlasTeach.tsx` (`/atlas-teach`) | Built. Re-audit. |
| Architecture | `src/pages/AtlasArchitecture.tsx` + `src/components/architecture/*` | Built after the 2026-08-02 prompt. Compare with `Atlas Architecture v2.dc.html`. |
| Sphere gallery | `src/pages/AtlasSphereGallery.tsx` (`/atlas-sphere`) | Built. Must gain the morph/field controls of v3. |
| Login / Auth | `src/pages/Auth.tsx`, `AuthSphere.tsx` | Built. Compare with `Atlas Login C1 - Split.dc.html`. |
| Permissions | `src/pages/AtlasPermissions.tsx` (`/permissions`) | Built. `Atlas Permission Lab.dc.html` is an **exploration canvas** (options 1a–2k), not a spec — a direction has to be picked. |
| Settings | `src/pages/atlas/AtlasSettings.tsx`, mounted as a dashboard overlay | Built, no route. Part of the admin redesign. |
| Music | `src/components/atlas-ui/MusicPlayerFull.tsx`, `MusicSphere.tsx`, `AtlasExtraCards.tsx` | Built against the **old** player, on a **forked** sphere (`MusicSphere.tsx`, five hand-ported "forms"). Replace with v2 on the shared renderer. |
| Onboarding | `src/components/OnboardingGate.tsx` + `/permissions` | Partial — gate only, no designed flow. |
| Smart Home · Health · Banking · Widget Catalog · Widget Sheet · Browser · Model Lab · Answer Views | — | **Not built.** No route, no page. |
| Legacy admin | `/atlas-core-legacy` → `src/pages/AtlasCore.tsx`, ~38 components under `src/components/atlas-health/` | Orphaned. Unlinked from the UI, reachable only by URL. Decide: redesign, fold into Core/Settings, or delete. |

**Three sphere implementations exist.** `src/lib/atlasSphere.ts` (canvas-2D port of the
shared renderer) with `AtlasSphereCanvas.tsx`; a three.js `AtlasSphere.tsx` behind
`AtlasSphereLazy`; and `MusicSphere.tsx`, a third hand-port for music. There is one design.
There should be one implementation.

---

## 3 · Atlas Sphere v3 — the contract

```js
AtlasSphere.mount(canvas, optsOrGetter, { adaptive, noName })
AtlasSphere.unmount(canvas)
AtlasSphere.PRESET   // {count, dens, size, soft}
AtlasSphere.STATES
```

Pass a **function** for live values — it is called once per frame per canvas.

```js
{
  state, dark, count, dens, size, soft, countScale,   // v2, unchanged
  morph,        // 1 = sphere, 0 = field, tween the scalar for the transition
  amp,          // 0–1 audio/energy envelope: wave height + alpha
  pulse,        // 0–1 per-beat impulse
  palette,      // [deep, mid, light] as [r,g,b] — overrides the state tint
  radius, cx, cy,      // fractions of min(W,H) / W / H
  fieldSpread,         // field width/height multiplier (1.06 default)
  sphereFrac,          // fraction of particles that survive into the sphere
  alphaGain, glow, spin,
  maxDpr        // per-canvas DPR cap (defaults 1.5)
}
```

**Ten states unchanged.** Motion is now **half the previous speed**, and idle slower still:
idle spin `0.0006` (was `0.0016`), listening `0.0013`, thinking `0.002`, speaking `0.0015`,
working `0.003`, muted `0.00025`. Breathing `sin(T*0.3)`, idle `sin(T*0.16)`.

**The field.** At `morph < 1` each particle travels from its sphere position to a home cell
on an even, **half-offset (hex-packed) lattice** whose column/row counts follow the canvas
aspect, so cells are square on screen. Cells are handed out in latitude→longitude order, so
the sphere visibly *unrolls* — neighbours on the shell stay neighbours on the plane. Transit
is staggered per particle (`STAG 0.62`) along a bowed path (`BOW 0.17`).

Motion in the field is carried by **alpha, not displacement**: travelling waves crest-weight
each particle's opacity (`fa = edge · (0.045 + 0.95·crest²) · (0.58 + 0.7·amp)`) while the
positional wave stays small (`H · (0.008 + 0.05·amp)`). Large displacement folds lattice rows
into moiré — this was tuned deliberately, don't raise it.

**Particles are round** — `arc()` above 0.95px, `rect()` below (identical at that size, much
cheaper). Radius is clamped `> 0.04` and `< 7`: `arc()` throws on a negative radius and one
throw kills the entire frame inside the renderer's `try/catch`.

**Quality.** `entry.q` thins the draw only — it must never reach the particle-cloud cache key.
The cloud is built once per `(count, dens, aspect)` and `q` draws a prefix of it; because
draw order is complete rows in bit-reversed sequence, any prefix is an evenly-spaced
sub-lattice rather than a clumpy random subset. (Keying the cache on `count·q` produced a
rebuild-per-frame feedback loop that hard-locked the main thread. Do not reintroduce it.)

**Watchdog.** The interval only re-queues a dead rAF pump (silent > 1400ms, page visible)
plus a `visibilitychange` listener. It must **never paint synchronously** from the timer —
that stacks a frame on top of a slow frame and saturates the thread.

**Budget.** 14 000 particles on a full-bleed field at `maxDpr 1.2` holds q=1 at ~5–8ms/frame.
Frames are capped at ~38fps (26ms). Off-screen canvases are skipped.

Still open from the last handoff and **still not honoured**: `prefers-reduced-motion`.
Decide there: static sphere, or morph disabled and spin at 0.

---

## 4 · `atlas-cover.js`

```js
AtlasCover.make(seed, tone)     // -> data URL, procedural sleeve (fallback art)
AtlasCover.read(img, fallback)  // -> {deep, mid, light} sampled from the image
AtlasCover.toward(a, b, t)      // colour lerp
AtlasCover.rgba(c, a) / .hex(c)
```

`read` needs a same-origin (or CORS-clean) image; it falls back to the supplied tone on a
tainted canvas. In the app, sample from the artwork the player already has — do not refetch.

---

## 5 · Atlas Music Player v2

Three presentations of one player, all on the shared renderer:

**Full player** (`100vh`, min 700px). Layers, back to front: the cover as a wash
(`blur(96px) saturate(1.75)` + a second `blur(130px)` layer), a palette-derived tint
gradient whose alpha follows the artwork's luminance (dark sleeves keep their light, bright
ones get held back), a vignette, an unfiltered radial "glow" whose **opacity** rides the beat,
then the particle canvas, then chrome.

> Both wash layers are **static** — no transform animation, no blend mode. Animating a
> transform on a 96px-blurred full-bleed image re-rasters the blur every frame and drops the
> page to ~15fps. The beat lives on the unfiltered gradient's opacity only.

- **Header:** source chip (Spotify · Premium), status line, formation label
  ("Field · in motion" / "Sphere · settled"), cover-card variant switch.
- **Cover card, top right** (96px at rest, expands on click to `min(312, sectionHeight − 96 − 316)`,
  floor 140px, recomputed on resize). Two variants to choose between: **Sleeve** (plain, radius
  22 → 30) and **Vinyl** (a disc tucked behind that slides out left and turns slowly, its
  label and body tinted from the artwork). Shadow is near-invisible: `0 16px 40px -32px rgba(0,0,0,.55)`.
  No metadata on the card.
- **Footer:** NOW PLAYING eyebrow, title (`clamp(30px, 3.6vw, 50px)`), `artist · release`,
  like + queue, waveform, transport.
- **Waveform:** 108 bars, `bw = w/108`, bar `0.6·bw` wide, fully rounded, height `v·h·0.86`,
  centred. Per-track deterministic silhouette. Played/unplayed is **one path filled twice**,
  the second pass clipped to the exact progress x — so the fill sweeps *through* the bar at
  the playhead instead of snapping bar to bar. No playhead dot. Hover shows a faint scrub column.
- **Formation:** playing → field, paused → sphere, tweened over `morphSeconds` (1.5s default).
- **Colour:** every chrome value is derived from the artwork palette each time it changes.

Sample records in the prototype: Gilli — *Tidligt Op* (2016), D1MA — *DRØM MIG VÆK* (2022),
D1MA — *NATTEN BLIVER MORGEN* (N1YA, 2025). Sleeves in `assets/covers/`. **Confirm the third
attribution before shipping it as sample data.**

---

## 6 · Per-surface briefs

Exact values live in each file. Purpose and the shape of the thing:

| File | Surface | Notes |
| --- | --- | --- |
| `Atlas Dashboard (Current).dc.html` | Dashboard | The reference for band header, widget grid, dock. |
| `Atlas Home.dc.html` | Home | Narrative/landing surface. |
| `Atlas Core.dc.html` | Core | Eight tabs incl. Memory; populated + empty states. |
| `Atlas Mail.dc.html` | Mail | As the last handoff, now borderless. |
| `Atlas Teach.dc.html` | Teach | |
| `Atlas Architecture v2.dc.html` | Architecture | The diagram is artwork, not Mermaid. |
| `Atlas Smart Home.dc.html` | Smart home | Needs `atlas-models.js`. Rooms, devices, scenes. |
| `Atlas Health.dc.html` | Health | |
| `Atlas Banking.dc.html` | Banking | 12-col dense grid, 126px rows; money cards + a catalog section. |
| `Atlas Widget Catalog.dc.html` | Widget catalog | The widget system: sizes, spans, states. |
| `Atlas Widget Sheet.dc.html` | Widget sheet | Per-widget spec sheet. |
| `Atlas Browser.dc.html` | Browser | Horizontal-scroll shell; uses `image-slot.js`. |
| `Atlas Model Lab.dc.html` | Model lab | Model routing / comparison surface. |
| `Atlas Answer Views.dc.html` | Answer views | How Atlas renders an answer. |
| `Atlas Onboarding.dc.html` | Onboarding | Intro → permissions → welcome, spoken copy. |
| `Atlas Music Player v2.dc.html` | Music | §5. |
| `Atlas Sphere.dc.html` | Sphere gallery | State gallery + editor; must gain morph/field. |
| `Atlas Login C1 - Split.dc.html` | Login | |
| `Atlas Intro.dc.html` | Marketing intro | Scroll narrative; ported to atlas-site previously. |
| `Atlas Design System.dc.html` | Design system | Current tokens and components. |
| `Atlas Brand Guide.dc.html` | Brand guide | **Stale**: still says Signal Orange and hairline borders. Colour = Atlas Blue `#3461f2`; shape = borderless. Use for type/voice only. |
| `Atlas Permission Lab.dc.html` | Permissions exploration | Options 1a–2k. Needs a decision, not an implementation. |

---

## 7 · Tokens

**Colour** — page `#f9f7f4` · surface `#fffdfa` · panel `#f1eeea` · skin `#edebe7` ·
tinted emphasis `#eef2fe` · hover `#edebe7` / destructive hover `#f7e6e4` ·
ink `#1e1e24` · ink-2 `#6d6a67` · neutral `#8b8681` · tertiary `#b6b1aa` (placeholders and
timestamps only, never body prose) · accent `#3461f2` · accent-hover `#5b7cff` ·
accent-deep `#2f4bbd` · green `#0fae76` / `#0a7a53` · red `#d0453a` / `#a3352c` ·
amber `#e07a1f` / `#a2540c` · dark card `#1b1b21`.

On ink surfaces (`#1e1e24`), labels and captions under 18px never go below
`rgba(249,247,244,.62)`; body prose sits at `.78`.

**Type** — Hanken Grotesk 500/600/700 for display; Geist 400/500/600 for UI and body.
Tabular numerals wherever counts or times appear.

**Radius** — 9999px pills · 30px editor · 28px panes · 26px cards · 22px draft card ·
20px message/strip · 18px rules card · 16px rows · 12px rail items · 10px icon tiles.

**Motion** — one curve: `cubic-bezier(.22,1,.36,1)`. Page entry 0.7–0.8s; strips and toasts
0.3–0.5s with a 6px offset; shimmer 1.5s linear; status pulse 1.4–2s.

**Dock** — icon-only at rest with `title` tooltips; only the current screen shows a label.
Home · Core · Teach · Mail · Architecture · Voice · avatar.

---

## 8 · Files in this bundle

Design references: the 22 `.dc.html` files listed in §6.
Portable code: `atlas-sphere.js`, `atlas-cover.js`.
Prototype-only helpers (do **not** port; the app has its own equivalents):
`atlas-transition.js`, `atlas-models.js`, `atlas-devices.js`, `atlas-filings.js`,
`image-slot.js`, `support.js`.
Sample artwork: `assets/covers/*.jpg`.

## 9 · Open questions

1. Which of the three sphere implementations survives — and who owns the migration?
2. `prefers-reduced-motion`: static, slowed, or morph-disabled?
3. Do Smart Home / Health / Banking ship as real surfaces, or as widget-level features?
4. The legacy `atlas-health` component set: redesign, absorb, or delete?
5. Which Permission Lab direction is the one?
6. Music: does the app play the user's own Spotify audio in-app (per `docs/music-setup.md`),
   and does artwork reach the client at a resolution worth sampling?
7. Where do wordmark, global listening indicator and account menu live? (Still open from the
   last handoff.)
