# Handoff: Atlas Workshop — visual polish, full-screen widgets, music player

## Overview
This package captures a round of visual/interaction changes to the Atlas "Workshop" dashboard, its per-widget full-screen views, the Atlas Sphere music player, and the split login. Implement these in the real app at `src/` (React + Vite + Tauri).

## About the design files
The `.dc.html` files in this bundle are **design references** — HTML/canvas prototypes showing intended look and behavior. They are **not** production code to copy. Recreate the look and behavior in the existing React codebase using its established components, hooks, and styles (`src/components/atlas`, `src/styles/workshop.css`, the `useXxx` hooks). Do not introduce the prototype's `.dc.html` runtime.

## Fidelity
**High-fidelity.** Colors, typography, spacing, motion, and copy are final. Recreate pixel-accurately with the codebase's existing patterns.

## Design tokens (authoritative)
- **Accent (Atlas Orange):** `#ff6a00` — the ONLY accent. Backgrounds that used a gradient must now use this **flat** color (no `linear-gradient`).
- Ink `#1e1e24` · ink-2 `#6d6a67` · ink-3 `#b6b1aa`
- Surfaces: page `#f9f7f4` · raised `#f1eeea` · sunken `#edebe7` · border `#e2ded7`
- Positive `#2f7d4f` · Negative `#c14a35` · Signal blue `#3461f2`
- Focus-panel surface (subtle card): `rgba(255,253,250,.55–.62)`, border `rgba(226,222,215,.55)`, radius 18–20px, shadow `0 1px 2px rgba(30,30,36,.03)`
- Fonts: Hanken Grotesk (display, tracking −.03/−.04em), Geist (UI/body), Newsreader italic (rare accent)
- Easing: `cubic-bezier(.22,1,.36,1)` (spring), `cubic-bezier(.4,0,.2,1)` (standard); durations 300–550ms
- Full spec: `Atlas Design System.dc.html` in this bundle.

## Change 1 — Full-screen widget system (replaces the old card-expand/overlay)
**Concept:** opening a widget must feel like staying on the home dashboard — the top "atlas" header bar and the greeting band (with the Atlas Sphere) stay mounted; only the grid region swaps to the focused widget's content. No separate full-screen overlay that hides the header/sphere.

- Likely wiring: `useCardFocus` hook + the Workshop page. Keep header + band always rendered; conditionally render the grid OR the focused view below the band.
- **Disappear motion ("fold up into Atlas"):** on open, the dashboard grid cards animate out in a staggered cascade — translateY upward (toward the sphere) + scale down (~.86) + blur + fade; per-card `animation-delay` stagger (~0–180ms). On close they cascade back from below. Grid is hidden (`display:none`) once the focused view is shown; shown again on return.
  - Keyframes: `cardFoldIn` (from translateY(40px) scale(.92) blur(5px) → none), `cardFoldOut` (to translateY(-52px) scale(.86) blur(7px)).
- **Focused view entrance:** slide up + fade (`from translateY(30px) scale(.985)`), 0.5s spring; exit reverses (0.3s).
- **Transition timing:** open = 340ms out-phase then mount focused view; close = 300ms then unmount.
- **Persistent chrome:** the bottom navigation dock stays visible above the focused view; each focused view has a thin top bar containing only a return hint (see Change 3).
- Widgets: Weather, Calendar, Tasks, Watchlist (stocks), Inbox (email), Briefing (news), Music.

## Change 2 — Band narrates the focused widget (with directional swap)
When a widget is focused, the greeting band's three texts become widget-specific; on the dashboard they show the defaults.

| Widget | Title (accent word) | Subline | Meta big / small |
|---|---|---|---|
| home (default) | Good afternoon, **Marcus.** | Four meetings today. Paris in 6 days. Two messages that look important. | 68° / San Francisco — Partly cloudy |
| weather | Here's your **weather.** | Partly cloudy and mild — light rain arrives after 6 PM. | 68° / H 70° · L 58° |
| calendar | Here's your **day.** | Four events today — your 1:1 with Maya starts in 20 minutes. | 4 / events · 3h 15m booked |
| tasks | Let's clear your **tasks.** | One of five done, one due at 2 PM, nothing overdue. | 20% / 1 of 5 complete |
| stocks | Here's your **watchlist.** | Portfolio up 0.75% today, led by NVDA at +2.31%. | +0.75% / $248,910 · 6 live |
| email | Here's your **inbox.** | Two unread — Sarah's budget review needs a reply by Friday. | 2 / unread messages |
| news | Your morning **briefing.** | Five stories Atlas picked for you this morning. | 5 / top stories |
| music | Now **playing.** | Golden Hour — Vela Sunn · Ambient. | 3:34 / Golden Hour |

**Copy should be data-driven** in the real app (pull from `useWeather`, `useCalendarEvents`, `useTasks`, `useWatchlist`, `useMailIntelligence`, `useNews`, `useMusicPlayer`) — the strings above are the format/voice to match, not hardcodes.

**Swap animation:** implement as CSS transitions (opacity + transform), NOT keyed remounts. On open/close (`opening`/`closing` phase), add a `swapout` class: the title (top text) fades out moving **up** (`translateY(-18px)`), the subline (below it) fades out moving **down** (`translateY(16px)`); the meta moves up like the title. When the new text is in, transition back to rest. Duration ~340ms, spring easing.

## Change 3 — Focused views: editorial, not boxy
- The old heavy `.panel`/`.panel2` cards were softened: transparent-ish warm surface, hairline border, generous padding, whisper shadow (tokens above). Content must have a **subtle** background/shade so it doesn't fade into the page — but lighter than full cards.
- Section labels are **eyebrows**: 11px, weight 700, letter-spacing .15em, uppercase, ink-3.
- Dark "feature" blocks stay as anchors (weather glass hero, AAPL live quote).
- **No close button.** The per-view header shows only a return hint: "Tap the title or press Esc to return" with a `corner-up-left` icon. Return by (a) clicking the band title (clickable, cursor pointer, hover opacity .72) or (b) pressing **Esc**.
- The per-widget eyebrow/title/intro header block was **removed** from inside each view (the band now narrates it) — keep only the thin return-hint bar.
- Each focused view keeps its distinct content/layout (see prototype `Atlas Dashboard (Current).dc.html`, the `.exp` blocks per widget for exact rows, stats, and copy).

## Change 4 — Atlas Sphere music player
Prototype: `Atlas Music Player.dc.html` (standalone) and the dashboard music tile + expanded view.
- The disc/vinyl was replaced by the **Atlas Sphere**, rendered on canvas and reactive to the beat. Wire to `useSphereRenderer` + `useMusicPlayer` (playback state, track, progress); drive amplitude from real audio analysis (Web Audio `AnalyserNode`) rather than the prototype's synthetic beat.
- **Five sphere forms** (switchable): **Orb** (particle sphere), **Orbit** (gyroscopic rings), **Bloom** (liquid core + beat pulse rings), **Field** (sphere unrolled into a flat plane that ripples outward on the beat), **Burst** (radial rays). Bloom and Field are the "immersive" ones and should use the full canvas area.
- Reactivity must be **smooth and beat-locked**: frame-rate-independent amplitude smoothing + a beat envelope (`kick = exp(-timeSinceBeat*8)`), pulse value for on-beat swells. Motion settles to rest when paused; sphere spins while playing.
- **Compact tile** (dashboard): orange `#ff6a00` card, small sphere, live equalizer, animated progress, play/pause; whole tile opens the full-screen view; play button stops propagation.
- **Full-screen/expanded:** track title/artist top-center, large sphere filling the space, five-form switcher pills, clickable seek waveform + live time, transport controls (shuffle/prev/play/next/like). **Action buttons have NO shadow** (flat translucent).
- Music card background must be the flat accent `#ff6a00`.
- **Runtime caution:** use explicit controls, not a list rendered from objects carrying callbacks, if your equivalent has the same fragility; N.B. this was a prototype-runtime issue only — in React just map normally.

## Change 5 — Login flow (`Auth.tsx` / split login)
Prototype: `Atlas Login C1 - Split.dc.html`. Use this split layout as THE login flow.
- Left: conversational Atlas prompt that types in word-by-word ("Hey — I'm Atlas. Have we met before?" → name step → done). Right: choices / big-text name input / "Enter Atlas".
- **Background: flat accent `#ff6a00`** (was a 3-stop gradient — remove the gradient). Keep the low-alpha vignette/scrim overlays for split-panel depth only.
- **Atlas Sphere dot density increased** to ~6,400 points (prototype `N = 6400`); tune for the real renderer's perf budget.
- **Name-input text shadow fix:** the input's downward `text-shadow` was being clipped by the input box — add bottom padding / line-height so it isn't cut off.
- The dashboard "Sign in" entry points now route to this login screen.

## Interactions & behavior summary
- Open widget: grid fold-out (340ms) → focused view slide-in; band text directional swap; grid `display:none` while focused; dock stays.
- Close: Esc or click band title → focused view slide-out (300ms) → grid folds back in; band text swaps to home.
- Music: beat-reactive sphere; five forms; clickable waveform seek; tile→full-screen; flat action buttons.
- All hover states use existing patterns; transitions 300–550ms, spring/standard easing.

## State
- `focusedWidget: null | 'weather'|'calendar'|'tasks'|'stocks'|'email'|'news'|'music'` (drives grid hide + which focused view + band copy).
- Transition phase: `opening`/`closing` booleans (or a small state machine) to trigger the fold + band swap classes.
- Music: playing, current track, progress, selected sphere form, amplitude (from analyser).

## Files in this bundle
- `Atlas Dashboard (Current).dc.html` — dashboard, full-screen widget system, band narration, fold motion, per-widget focused content.
- `Atlas Music Player.dc.html` — standalone music player + five sphere forms (reference for the sphere math and layouts).
- `Atlas Login C1 - Split.dc.html` — split login.
- `Atlas Design System.dc.html` — full token/typography/component reference.

## Suggested target files in the repo
- Dashboard/full-screen + band: the Workshop page/components under `src/components/atlas`, `src/styles/workshop.css`, `useCardFocus`.
- Per-widget data: `useWeather`, `useCalendarEvents`, `useTasks`, `useWatchlist`, `useStocks`, `useMailIntelligence`, `useNews`.
- Music: `useMusicPlayer`, `useSphereRenderer` (+ Web Audio analyser).
- Login: `src/pages/Auth.tsx`.
