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

## Sizing — read before retuning

The mark is **built for the dock, not for the design canvas.** The first
version was tuned by eye at 512px and effectively vanished at icon sizes: the
sphere covered 59% of the tile, its bright core only 29%, and the largest
particle was `r=3.3` in a 512 space — about **a third of a pixel** once scaled
to a 48px dock icon. Atlas showed up as a nearly empty blue square.

Current tuning: sphere **~73% of the tile**, particles `r=1.5..6.3`, opacity
floor `0.48` (the faint outer shell is the first thing to disappear when
downscaled).

If you retune, **compare at 128 / 64 / 48 / 32 / 16px before committing.** There
is a real trade-off: pushing further (sphere 80%, particles ×2.2) reads better
at 16px but clumps into a mass at 128px and loses the fine shimmer.

## Regenerating

`gen-particles.mjs` (Bun) generates all four SVGs — the three full-bleed 512
variants under their committed filenames, plus the padded 1024 app-icon layout
for variant C. Fibonacci-sphere directions, orthographic projection,
depth-graded size/opacity/colour. Tune counts/sizes/radii near the bottom.

```bash
bun design/brand-icons/gen-particles.mjs
bun run tauri icon design/brand-icons/atlas-appicon-C-blend-padded.svg
cp design/brand-icons/atlas-sphere-C-blend.svg public/favicon.svg
cp design/brand-icons/atlas-sphere-C-blend.svg ../atlas-site/public/favicon.svg
```

`tauri icon` takes the **SVG directly** — no rasteriser needed, despite what an
earlier version of this file said about `@resvg/resvg-js`.

Never hand-edit `src-tauri/icons/*` — regenerate so every size stays in sync.
