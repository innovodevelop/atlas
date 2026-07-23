// Pure-particle sphere (no glow/halo). Fibonacci directions, orthographic
// projection, tilt. Depth (front..back) drives size, opacity AND colour
// (warm cream in front -> cool blue behind) so the ball reads deep and layered.
// All particles depth-sorted back-to-front so nearer ones overlap on top.
import { writeFileSync } from "node:fs";

const CX = 256, CY = 250, TILT = -0.32;
const FRONT = [255, 246, 236];   // #fff6ec
const BACK  = [176, 190, 232];   // #b0bee8

const hex = (t) => {
  const c = FRONT.map((f, i) => Math.round(f + (BACK[i] - f) * (1 - t)));
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
  const th = Math.PI * (3 - Math.sqrt(5)) * i + phase;
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
function emit(arr) {
  return arr
    .sort((a, b) => a.z - b.z) // back first, front last
    .map((p) => `      <circle cx="${p.sx.toFixed(1)}" cy="${p.sy.toFixed(1)}" r="${p.s.toFixed(1)}" fill="${hex(p.t)}" opacity="${p.o.toFixed(2)}"/>`)
    .join("\n");
}
function svg(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Atlas">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#3f67f6"/><stop offset="1" stop-color="#2543c4"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="114" fill="url(#bg)"/>
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
const blend = [];
shell(blend, 180, 150, 0.8, 2.2, 0.26, 0.70, 0.0);
shell(blend, 100, 106, 1.0, 2.7, 0.40, 0.84, 1.3);
volume(blend, 158, 96, 1.2, 3.4, 0.50, 1.0);

const dir = "/private/tmp/claude-501/-Users-magnuspilegaard-Desktop-Vibe-Coding-Projects/c08612ad-5882-446c-ad18-19c53cc82cc8/scratchpad";
const all = [
  ["layered", layered, "A · Layered"],
  ["volumetric", volumetric, "B · Volumetric"],
  ["blend", blend, "C · Blend"],
];
const items = all.map(([k, arr, title]) => {
  const inner = emit(arr);
  writeFileSync(`${dir}/favicon-${k}.svg`, svg(inner));
  return { k, inner, title: `${title} · ${arr.length}` };
});

// Emit a ready-to-render comparison widget (symbols defined once, reused).
const defs = `<linearGradient id="v5-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3f67f6"/><stop offset="1" stop-color="#2543c4"/></linearGradient>`;
const symbols = items.map((it) => `<symbol id="v5-${it.k}" viewBox="0 0 512 512"><rect width="512" height="512" rx="114" fill="url(#v5-bg)"/><g>\n${it.inner}\n</g></symbol>`).join("\n");
const cards = items.map((it) => `  <div style="display:flex;flex-direction:column;gap:10px;align-items:flex-start">
    <svg viewBox="0 0 512 512" width="152" height="152" style="border-radius:34px"><use href="#v5-${it.k}"/></svg>
    <div style="display:flex;gap:10px;align-items:flex-end">
      <svg viewBox="0 0 512 512" width="48" height="48" style="border-radius:11px"><use href="#v5-${it.k}"/></svg>
      <svg viewBox="0 0 512 512" width="32" height="32" style="border-radius:7px"><use href="#v5-${it.k}"/></svg>
      <svg viewBox="0 0 512 512" width="16" height="16" style="border-radius:4px"><use href="#v5-${it.k}"/></svg>
    </div>
    <div style="font:500 15px var(--font-sans);color:var(--text-primary)">${it.title}</div>
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
console.log(`wrote compare.html (${widget.length} bytes) + 3 svgs: ${items.map((i) => i.title).join(", ")}`);
