// Pure-particle sphere (no glow/halo). Fibonacci directions, orthographic
// projection, tilt. Depth (front..back) drives size, opacity AND colour
// (warm cream in front -> cool blue behind) so the ball reads deep and layered.
// All particles depth-sorted back-to-front so nearer ones overlap on top.
//
// TWO PRODUCTS, ONE SPHERE. Atlas (consumer) is the blue tile; Lighthouse (the
// developer build) is the same particle cloud inverted onto paper — off-white
// ground, ink particles. Same geometry, same tuning, different skin, so the two
// icons are unmistakably siblings sitting next to each other in the dock.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CX = 256, CY = 250, TILT = -0.32;

// How strongly the spiral arms read, in radians of detune from the golden angle.
//
// WHY IT IS A DETUNE AND NOT A ROTATION. The obvious way to "twist" a point
// cloud is to rotate it about the vertical axis by an angle proportional to
// height. On a sphere that does nothing you can see: such a rotation maps every
// latitude circle onto itself, so the silhouette is unchanged and only the
// azimuthal spacing moves. Worse, for a Fibonacci lattice `y` is linear in `i`,
// so `GOLDEN*i + TWIST*y` collapses exactly into `(GOLDEN - 2*TWIST/(N-1))*i`
// — verified numerically, the two are bit-identical. A "twist" implemented that
// way is therefore a detune wearing a disguise, and because the shells have
// different N (180/100/158) it detunes each by a different amount and pulls the
// layers out of register. That first attempt visibly clumped.
//
// So this does the real thing directly. At exactly the golden angle a
// phyllotactic lattice is maximally even and shows no spiral; detune it and
// parastichies — visible spiral arms — emerge, which is the same effect that
// makes the arms in a sunflower head countable. One value shared by every
// shell, so the layers stay registered.
//
// 0 reproduces the icon that shipped. Sweep it with ATLAS_SPIRAL and judge at
// 32px, not 512 — the arms are a character choice, and legibility in the dock
// is what the 2026-08-02 retune below was bought with.
//
// 0.022 chosen by sweeping 0 / 0.006 / 0.012 / 0.022 / 0.040 and comparing.
// Below ~0.012 the arms are too faint to be worth having; at 0.040 the cloud
// stops reading as a sphere and becomes a vortex with the outer shell
// separating into concentric rings. 0.022 shows clear arms with the spherical
// form intact.
const SPIRAL = Number(process.env.ATLAS_SPIRAL ?? 0.022);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const ANGLE = GOLDEN - SPIRAL;

const THEMES = {
  // Consumer Atlas: bright particles suspended in Atlas Blue.
  atlas: {
    front: [255, 246, 236],   // #fff6ec warm cream, nearest the viewer
    back:  [176, 190, 232],   // #b0bee8 cool blue, receding
    bg:    ["#3f67f6", "#2543c4"],
    label: "Atlas",
  },
  // Lighthouse: the same cloud on paper. Front particles are ink (--ink
  // #1e1e24); the far side fades toward the warm grey of the page rather than
  // going lighter-and-bluer, because on a light ground "receding" means losing
  // contrast against paper, not gaining brightness. Background is the app's own
  // surface/page pair (--surface #fffdfa -> --pg #f9f7f4) so the tile matches
  // the product it opens.
  lighthouse: {
    front: [30, 30, 36],      // #1e1e24 ink
    back:  [176, 171, 164],   // #b0aba4 warm grey, sinking into the page
    bg:    ["#fffdfa", "#f1eeea"],
    label: "Lighthouse",
    // The 0.48 opacity floor below was tuned against Atlas Blue. Ink on paper
    // is a weaker pairing at the same alpha — a 0.48 ink dot lands near #8f8d8a
    // on #fffdfa, which survives at 512px and washes out in the dock. Measured:
    // downsampled to 32px, Lighthouse read visibly fainter than Atlas. Lifting
    // the floor costs nothing at the bright end because the result is clamped,
    // so only the faint outer shell — the first thing to disappear when the
    // icon is downscaled — actually moves.
    opacityScale: 1.3,
  },
};

const hexFor = (theme) => (t) => {
  const { front, back } = theme;
  const c = front.map((f, i) => Math.round(f + (back[i] - f) * (1 - t)));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
};
const project = (x, y, z) => {
  const y2 = y * Math.cos(TILT) - z * Math.sin(TILT);
  const z2 = y * Math.sin(TILT) + z * Math.cos(TILT);
  return { sx: CX + x, sy: CY - y2, z: z2 };
};
const fibDir = (i, N, phase = 0) => {
  const y = 1 - (i / (N - 1)) * 2;
  const rad = Math.sqrt(Math.max(0, 1 - y * y));
  const th = ANGLE * i + phase;
  return { x: Math.cos(th) * rad, y, z: Math.sin(th) * rad };
};
const frac = (n) => n - Math.floor(n);

// push particles for one spherical shell of radius R
function shell(arr, N, R, minS, maxS, minO, maxO, phase = 0) {
  for (let i = 0; i < N; i++) {
    const d = fibDir(i, N, phase);
    const p = project(d.x * R, d.y * R, d.z * R);
    const t = (p.z / R + 1) / 2; // 0 back .. 1 front
    arr.push({ ...p, t, s: minS + (maxS - minS) * t, o: minO + (maxO - minO) * t });
  }
}
// push particles filling the sphere volume (jittered radius per point)
function volume(arr, N, R, minS, maxS, minO, maxO) {
  for (let i = 0; i < N; i++) {
    const d = fibDir(i, N, 0.7);
    const rr = R * (0.26 + 0.74 * frac(i * 0.61803398875)); // radius spread across volume
    const p = project(d.x * rr, d.y * rr, d.z * rr);
    const t = (p.z / R + 1) / 2;
    arr.push({ ...p, t, s: minS + (maxS - minS) * t, o: minO + (maxO - minO) * t });
  }
}
function emit(arr, theme) {
  const hex = hexFor(theme);
  const k = theme.opacityScale ?? 1;
  return arr
    .sort((a, b) => a.z - b.z) // back first, front last
    .map((p) => `      <circle cx="${p.sx.toFixed(1)}" cy="${p.sy.toFixed(1)}" r="${p.s.toFixed(1)}" fill="${hex(p.t)}" opacity="${Math.min(1, p.o * k).toFixed(2)}"/>`)
    .join("\n");
}
function svg(inner, theme, id = "bg") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="${theme.label}">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${theme.bg[0]}"/><stop offset="1" stop-color="${theme.bg[1]}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="114" fill="url(#${id})"/>
  <g>
${inner}
  </g>
</svg>
`;
}

// ~6x density to replicate the dashboard's dense point cloud. Finer points at
// high count so it reads as fine shimmer rather than blobs.

// A — layered: nested shells (outer defines the sphere, inner add depth)
const layered = [];
shell(layered, 182, 150, 0.8, 2.4, 0.28, 0.74, 0.0);
shell(layered, 100, 104, 1.0, 2.9, 0.42, 0.88, 1.3);
shell(layered, 46, 56, 1.3, 3.4, 0.60, 1.0, 2.6);

// B — volumetric: one deep cloud filling the sphere
const volumetric = [];
volume(volumetric, 314, 152, 0.8, 3.0, 0.28, 1.0);

// C — blend: layered shells for the edge + volumetric fill through the middle
//
// RETUNED 2026-08-02 for small sizes. The first version was built by eye at
// 512px and disappeared in the dock: the sphere covered only 59% of the tile,
// its bright core just 29%, and the largest particle was r=3.3 in a 512 space —
// which at a 48px dock icon renders around a third of a pixel. Atlas showed up
// as an almost-empty blue square.
//
// So: radius ×1.26 (sphere now ~74% of the tile), particle size ×1.9, and an
// opacity floor of 0.48 because the faint outer shell is the first thing to
// vanish when the icon is downscaled. Compared against the shipped version at
// 128/64/48/32/16px before choosing; a more aggressive tuning (×2.2, 80%) read
// better at 16px but clumped into a mass at 128px and lost the fine shimmer.
const blend = [];
shell(blend, 180, 189, 1.5, 4.2, 0.48, 0.70, 0.0);
shell(blend, 100, 134, 1.9, 5.1, 0.48, 0.84, 1.3);
volume(blend, 158, 121, 2.3, 6.5, 0.50, 1.0);

// Write next to this script. (This used to point at a scratch directory from a
// long-dead session, so "regenerating" silently wrote nothing anyone would find
// and the committed SVGs had to be hand-patched.)
// fileURLToPath, not URL.pathname — the repo lives under a path with a space
// ("Vibe Coding Projects"), which pathname hands back percent-encoded.
const dir = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");
const all = [
  ["layered", layered, "A · Layered", "atlas-sphere-A-layered.svg"],
  ["volumetric", volumetric, "B · Volumetric", "atlas-sphere-B-volumetric.svg"],
  ["blend", blend, "C · Blend", "atlas-sphere-C-blend.svg"],
];
const items = all.map(([k, arr, title, filename]) => {
  const inner = emit(arr, THEMES.atlas);
  writeFileSync(`${dir}/${filename}`, svg(inner, THEMES.atlas));
  return { k, arr, inner, title: `${title} · ${arr.length}` };
});

// Variant C also ships as the macOS app icon: the same 512 tile inset inside a
// 1024 canvas with a transparent margin, which is the layout `tauri icon`
// expects. Emitted here so the whole icon set is one command away and no one
// has to reproduce the padding maths by hand.
//
// Emitted once per product. Lighthouse re-colours the SAME particle array
// rather than regenerating it, so the two tiles are geometrically identical —
// if they ever drift apart it will be because someone changed the geometry, not
// because the two code paths diverged.
const APP_PAD = 96;                                   // transparent margin
const APP_SCALE = (1024 - APP_PAD * 2) / 512;         // 1.625
const blendArr = items.find((i) => i.k === "blend").arr;

function appIcon(theme, filename) {
  const inner = emit(blendArr, theme);
  writeFileSync(`${dir}/${filename}`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="${theme.label}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${theme.bg[0]}"/><stop offset="1" stop-color="${theme.bg[1]}"/>
    </linearGradient>
  </defs>
  <g transform="translate(${APP_PAD},${APP_PAD}) scale(${APP_SCALE})">
    <rect x="0" y="0" width="512" height="512" rx="114" fill="url(#bg)"/>
    <g>
${inner}
    </g>
  </g>
</svg>
`);
  return filename;
}

const appIcons = [
  appIcon(THEMES.atlas, "atlas-appicon-C-blend-padded.svg"),
  appIcon(THEMES.lighthouse, "lighthouse-appicon-C-blend-padded.svg"),
];

// Emit a ready-to-render comparison widget (symbols defined once, reused).
// Both products at every size that matters, because the twist and the ink
// inversion have to be judged at 32px and 16px, not at 152.
const themeEntries = [["atlas", THEMES.atlas], ["lighthouse", THEMES.lighthouse]];
const defs = themeEntries.map(([k, t]) =>
  `<linearGradient id="v6-bg-${k}" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${t.bg[0]}"/><stop offset="1" stop-color="${t.bg[1]}"/></linearGradient>`).join("\n");
const cells = [];
for (const [tk, theme] of themeEntries) {
  for (const it of items) {
    cells.push({ id: `v6-${tk}-${it.k}`, tk, theme, title: `${theme.label} · ${it.title}`, inner: emit(it.arr, theme) });
  }
}
const symbols = cells.map((c) => `<symbol id="${c.id}" viewBox="0 0 512 512"><rect width="512" height="512" rx="114" fill="url(#v6-bg-${c.tk})"/><g>\n${c.inner}\n</g></symbol>`).join("\n");
const cards = cells.map((c) => `  <div style="display:flex;flex-direction:column;gap:10px;align-items:flex-start">
    <svg viewBox="0 0 512 512" width="152" height="152" style="border-radius:34px"><use href="#${c.id}"/></svg>
    <div style="display:flex;gap:10px;align-items:flex-end">
      <svg viewBox="0 0 512 512" width="48" height="48" style="border-radius:11px"><use href="#${c.id}"/></svg>
      <svg viewBox="0 0 512 512" width="32" height="32" style="border-radius:7px"><use href="#${c.id}"/></svg>
      <svg viewBox="0 0 512 512" width="16" height="16" style="border-radius:4px"><use href="#${c.id}"/></svg>
    </div>
    <div style="font:500 15px var(--font-sans);color:var(--text-primary)">${c.title}</div>
  </div>`).join("\n");
const widget = `<div style="padding:1rem 0;display:flex;flex-direction:column;gap:20px">
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${defs}</defs>
${symbols}
</svg>
<div style="display:flex;gap:26px;flex-wrap:wrap">
${cards}
</div>
</div>`;
writeFileSync(`${dir}/compare.html`, widget);
console.log(`spiral=${SPIRAL} · wrote compare.html (${widget.length} bytes), 3 svgs, ${appIcons.length} app icons: ${appIcons.join(", ")}`);
