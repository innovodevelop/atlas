# Atlas brand icons — particle sphere

The Atlas mark is a **particle sphere** on Atlas Blue (`#3461f2`, tile gradient
`#3f67f6 → #2543c4`), echoing the dashboard's live particle sphere. Pure
particles, no glow: depth comes from front-to-back layering — nearer points are
larger, brighter and warm cream (`#fff6ec`); farther points are smaller, dimmer
and cool blue (`#b0bee8`), depth-sorted so nearer overlaps farther.

## Variants (all ~6× density, ~generated)

| File | Variant | Notes |
|------|---------|-------|
| `atlas-sphere-C-blend.svg` | **C · Blend** (shipping) | Layered shells for a defined edge + volumetric fill through the middle (~438 pts). |
| `atlas-sphere-A-layered.svg` | A · Layered | Three nested shells, cleanest edge (~328 pts). |
| `atlas-sphere-B-volumetric.svg` | B · Volumetric | One deep cloud, soft rim (~314 pts). |
| `atlas-appicon-C-blend-padded.svg` | C, padded 1024 | macOS app-icon layout: rounded tile inset with transparent margin. Source for `tauri icon`. |

**In use:** C ships as the web favicon (`public/favicon.svg` here + in
`atlas-site`) and the macOS/iOS/Android app icon set (`src-tauri/icons/`,
regenerated from the padded PNG via `tauri icon`). A and B are kept for other
graphic uses.

## Regenerating

`gen-particles.mjs` (Bun) generates the full-bleed 512 favicons for A/B/C
(Fibonacci-sphere directions, orthographic projection, depth-graded size/opacity/
colour). Tune counts/sizes at the bottom of the file.

```bash
bun design/brand-icons/gen-particles.mjs   # writes favicon-{layered,volumetric,blend}.svg
```

To rebuild the macOS icon from variant C:

```bash
# 1. make the padded 1024 PNG (needs @resvg/resvg-js) from the padded SVG
# 2. bun run tauri icon <path-to-1024.png>   # regenerates src-tauri/icons/*
```

Never hand-edit `src-tauri/icons/*` — regenerate from the SVG so every size stays
in sync.
