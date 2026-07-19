/**
 * Weather-atmosphere canvas renderer — direct port of the wx* suite from the
 * design handoff "Atlas Dashboard (Current).dc.html" (design/current/…).
 * Drives both the full-viewport dashboard atmosphere and the weather card's
 * masked background. Values match the design exactly; only the `this`-bound
 * class methods became pure functions and the RAF runner gained pause support
 * (window-inactive tabs must not burn CPU — Atlas perf convention).
 */

export type WxCondition = "sunny" | "partly" | "cloudy" | "rain";

interface WxPreset {
  b1: number[]; b2: number[];
  glows: number[][];
  sun: number[];
  veil: number; fall: number; specks: number; dark: number; en: number;
  sky: number; cloud: number;
}

export const wxPresets: Record<WxCondition, WxPreset> = {
  sunny:  { b1: [252, 248, 240], b2: [248, 236, 215], glows: [[255, 180, 94, .5], [255, 217, 160, .48], [255, 138, 60, .3], [174, 191, 255, .12]], sun: [255, 198, 124, .9],  veil: 0,   fall: 0, specks: .35, dark: 0, en: 1,   sky: .98, cloud: .26 },
  partly: { b1: [250, 246, 239], b2: [243, 235, 222], glows: [[255, 180, 94, .4], [255, 217, 160, .4], [255, 150, 80, .2], [174, 191, 255, .12]],  sun: [255, 198, 124, .6],  veil: .42, fall: 0, specks: .15, dark: 0, en: .85, sky: .62, cloud: .62 },
  cloudy: { b1: [241, 239, 235], b2: [229, 226, 221], glows: [[213, 207, 198, .5], [233, 227, 218, .5], [255, 196, 120, .1]],                      sun: [255, 214, 160, .16], veil: .78, fall: 0, specks: 0,   dark: 0, en: .55, sky: .2,  cloud: 1 },
  rain:   { b1: [233, 234, 238], b2: [217, 220, 228], glows: [[150, 162, 190, .42], [198, 205, 220, .45], [255, 180, 94, .07]],                    sun: [0, 0, 0, 0],         veil: .55, fall: 1, specks: 0,   dark: 0, en: .8,  sky: 0,   cloud: .55 },
};

const wxSunPos = [.74, .3];

const rgba = (c: number[], a: number) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

const mix = (a: number[], b: number[], t: number) =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Cheap 1-D value noise (hash-based, deterministic). */
const n1 = (x: number) => {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const h = (k: number) => { const s = Math.sin(k * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  return h(i) + (h(i + 1) - h(i)) * u;
};

type Ctx = CanvasRenderingContext2D;

function blob(x: Ctx, cx: number, cy: number, r: number, col: number[], a: number) {
  if (a <= 0.002 || r <= 0) return;
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, rgba(col, a)); g.addColorStop(.55, rgba(col, a * .45)); g.addColorStop(1, rgba(col, 0));
  x.fillStyle = g; x.fillRect(cx - r, cy - r, r * 2, r * 2);
}

function aurora(x: Ctx, w: number, h: number, t: number, P: WxPreset) {
  const R = Math.max(w, h);
  for (let L = 0; L < 2; L++) {
    const n = L ? 3 : 4;
    for (let i = 0; i < n; i++) {
      const j = i + L * 10;
      const gcol = P.glows[(i + L) % P.glows.length];
      const s1 = .35 + n1(j * 7.7) * .6, s2 = .35 + n1(j * 3.3) * .6;
      const spd = (L ? .095 : .05) * P.en;
      const cx = (.5 + .46 * Math.sin(t * spd * s1 + j * 2.1) + .06 * Math.sin(t * .31 * s2 + j)) * w;
      const cy = (.5 + .42 * Math.cos(t * spd * .8 * s2 + j * 1.3) + .05 * Math.cos(t * .27 * s1 + j * 2)) * h;
      const r = R * (L ? .24 : .45) * (1 + .12 * Math.sin(t * .18 * P.en + j));
      const a = gcol[3] * (L ? .55 : .8) * (.7 + .3 * Math.sin(t * .12 * P.en + j * 2.7));
      blob(x, cx, cy, r, gcol, a);
    }
  }
}

function sun(x: Ctx, w: number, h: number, t: number, P: WxPreset) {
  if (P.sun[3] <= 0.01) return;
  const sx = (wxSunPos[0] + Math.sin(t * .05) * .015) * w;
  const sy = (wxSunPos[1] + Math.cos(t * .04) * .015) * h;
  const R = Math.max(w, h), br = 1 + Math.sin(t * .5) * .04;
  blob(x, sx, sy, R * .62 * br, P.sun, P.sun[3] * .5);
  blob(x, sx, sy, R * .3 * br, mix(P.sun, [255, 246, 230], .55), P.sun[3] * .75);
  blob(x, sx, sy, R * .13 * br, [255, 250, 240], P.sun[3] * .8);
  const cr = Math.min(46, Math.max(15, Math.min(w, h) * .07)) * br;
  const dg = x.createRadialGradient(sx, sy, 0, sx, sy, cr);
  dg.addColorStop(0, rgba([255, 253, 246], P.sun[3]));
  dg.addColorStop(.68, rgba([255, 243, 218], P.sun[3] * .96));
  dg.addColorStop(.9, rgba([255, 226, 172], P.sun[3] * .5));
  dg.addColorStop(1, rgba([255, 218, 156], 0));
  x.fillStyle = dg; x.beginPath(); x.arc(sx, sy, cr, 0, 7); x.fill();
}

function rays(x: Ctx, w: number, h: number, t: number, P: WxPreset) {
  if (!P.sun || P.sun[3] <= 0.2) return;
  const sx = wxSunPos[0] * w, sy = wxSunPos[1] * h, R = Math.max(w, h) * 1.2;
  x.save(); x.globalCompositeOperation = "lighter";
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = t * .035 + i * (Math.PI * 2 / n);
    const wob = .05 + .035 * Math.sin(t * .5 + i * 1.3);
    const al = (.04 + .035 * Math.sin(t * .8 + i * 1.7)) * P.sun[3];
    if (al <= .002) continue;
    x.beginPath(); x.moveTo(sx, sy);
    x.lineTo(sx + Math.cos(a - wob) * R, sy + Math.sin(a - wob) * R);
    x.lineTo(sx + Math.cos(a + wob) * R, sy + Math.sin(a + wob) * R);
    x.closePath();
    const g = x.createRadialGradient(sx, sy, 0, sx, sy, R);
    g.addColorStop(0, rgba([255, 240, 206], al));
    g.addColorStop(.5, rgba([255, 236, 194], al * .4));
    g.addColorStop(1, rgba([255, 236, 194], 0));
    x.fillStyle = g; x.fill();
  }
  x.restore();
}

function clouds(x: Ctx, w: number, h: number, t: number, P: WxPreset) {
  const c = P.cloud || 0; if (c <= .01) return;
  const n = Math.round(3 + c * 4);
  const heavy = c > .8;
  for (let i = 0; i < n; i++) {
    const j = i * 1.7 + 1;
    const spd = 7 + n1(j) * 15;
    const cx = ((n1(j * 2.1) * (w + 460)) + t * spd) % (w + 460) - 230;
    const cy = h * (.1 + n1(j * 3.3) * (heavy ? .5 : .34));
    const rw = Math.max(w, h) * (.16 + n1(j * 4.4) * .15);
    const col = mix([255, 255, 255], P.b2, heavy ? .28 : .05);
    const a = (heavy ? .5 : .32) * c * (.7 + .3 * n1(j * 5.5));
    x.save(); x.translate(cx, cy); x.scale(2, 1);
    for (let k = 0; k < 4; k++) {
      const ox = (k - 1.5) * rw * .52, oy = Math.sin(k * 1.3 + j) * rw * .1;
      blob(x, ox, oy, rw * (.55 + n1(j + k * 2.2) * .34), col, a);
    }
    x.restore();
  }
}

function veil(x: Ctx, w: number, h: number, t: number, P: WxPreset) {
  if (P.veil <= 0.01) return;
  const shade = mix(P.b2, [104, 106, 112], .42);
  for (let L = 0; L < 2; L++) {
    for (let i = 0; i < 2; i++) {
      const j = i + L * 5;
      const spd = (L ? 22 : 11) * P.en * (0.6 + n1(j * 2.2));
      const cx = ((n1(j * 6.1) * (w + 500)) + t * spd) % (w + 500) - 250;
      const cy = h * (.18 + n1(j * 4.4) * .55) + Math.sin(t * .1 + j) * h * .03;
      const r = Math.max(w, h) * (L ? .32 : .5) * (1 + .12 * n1(j * 8.8));
      const a = P.veil * (L ? .24 : .34) * (.8 + .2 * Math.sin(t * .09 + j * 3));
      x.save(); x.translate(cx, cy); x.scale(1.6, .75);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, rgba(shade, a)); g.addColorStop(1, rgba(shade, 0));
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, r, 0, 7); x.fill(); x.restore();
    }
  }
}

function fall(x: Ctx, w: number, h: number, t: number, P: WxPreset) {
  if (P.fall <= 0.01) return;
  const col = [118, 130, 158];
  for (let L = 0; L < 2; L++) {
    const n = Math.floor((L ? 14 : 12) * P.fall);
    for (let i = 0; i < n; i++) {
      const j = i + L * 40;
      const rx = n1(j * 3.7) * w;
      const len = h * (L ? .16 : .09) * (1 + n1(j * 5.9) * .8);
      const spd = (h * (L ? .5 : .24) + h * .25 * n1(j * 8.3)) * (0.7 + .3 * n1(Math.floor(t * .4) + j));
      const ry = ((n1(j * 9.1) * (h + len)) + t * spd) % (h + len) - len;
      const a = (L ? .2 : .1) * (.6 + .4 * n1(j * 6.6));
      const g = x.createLinearGradient(rx, ry, rx, ry + len);
      g.addColorStop(0, rgba(col, 0)); g.addColorStop(.6, rgba(col, a)); g.addColorStop(1, rgba(col, 0));
      x.strokeStyle = g; x.lineWidth = L ? 1.5 : 1;
      x.beginPath(); x.moveTo(rx, ry); x.lineTo(rx, ry + len); x.stroke();
    }
  }
}

function specks(x: Ctx, w: number, h: number, t: number, P: WxPreset) {
  if (P.specks <= 0.01) return;
  const n = Math.floor(22 * P.specks);
  const col = [255, 190, 110];
  for (let i = 0; i < n; i++) {
    const pr = n1(i * 4.9);
    const rx = (n1(i * 5.1) * w + Math.sin(t * (.2 + pr * .25) + i) * (10 + pr * 16));
    const ry = ((n1(i * 7.9) * (h + 40)) - t * (3 + 11 * pr)) % (h + 40); const ryy = ry < 0 ? ry + h + 40 : ry;
    const a = (.08 + .18 * Math.abs(Math.sin(t * (0.6 + n1(i * 4.4)) + i * 2))) * P.specks * (.5 + pr * .7);
    blob(x, rx, ryy - 20, 5 + pr * 7, col, a * .5);
    x.fillStyle = rgba(col, a);
    x.beginPath(); x.arc(rx, ryy - 20, .8 + pr * 1.3, 0, 7); x.fill();
  }
}

/** One full atmosphere frame (design wxAtmo, verbatim values). */
export function renderAtmo(x: Ctx, w: number, h: number, t: number, P: WxPreset) {
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, rgba(P.b1, 1)); g.addColorStop(1, rgba(P.b2, 1));
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const s = P.sky || 0;
  if (s > .01) {
    const sg = x.createLinearGradient(0, 0, 0, h);
    sg.addColorStop(0, rgba([66, 122, 224], .66 * s));
    sg.addColorStop(.28, rgba([104, 156, 232], .44 * s));
    sg.addColorStop(.58, rgba([158, 192, 238], .18 * s));
    sg.addColorStop(1, rgba([214, 226, 246], 0));
    x.fillStyle = sg; x.fillRect(0, 0, w, h);
    blob(x, w * (1 - wxSunPos[0]), h * .04, Math.max(w, h) * .62, [78, 134, 228], .34 * s);
    blob(x, wxSunPos[0] * w, wxSunPos[1] * h, Math.max(w, h) * .5, [255, 240, 205], .1 * s);
  }
  aurora(x, w, h, t, P);
  sun(x, w, h, t, P);
  rays(x, w, h, t, P);
  clouds(x, w, h, t, P);
  veil(x, w, h, t, P);
  fall(x, w, h, t, P);
  specks(x, w, h, t, P);
  const vg = x.createRadialGradient(w * .5, h * .45, Math.min(w, h) * .42, w * .5, h * .5, Math.max(w, h) * .78);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, rgba(mix(P.b2, [10, 10, 16], .5), .12));
  x.fillStyle = vg; x.fillRect(0, 0, w, h);
}

export function presetFor(condition: string | undefined): WxPreset {
  const key = (condition ?? "").toLowerCase();
  if (key.includes("rain") || key.includes("drizzle") || key.includes("thunder")) return wxPresets.rain;
  if (key.includes("cloud") && !key.includes("part")) return wxPresets.cloudy;
  if (key.includes("clear") || key.includes("sun")) return wxPresets.sunny;
  return wxPresets.partly;
}

export interface WxRunnerHandle {
  stop: () => void;
}

/**
 * RAF runner (design wxCanvas) with pause support. `getPreset` is sampled
 * every frame so condition changes take effect live; `isPaused` gates
 * rendering without tearing down (window-blur convention).
 */
export function startWxCanvas(
  el: HTMLCanvasElement,
  getPreset: () => WxPreset,
  isPaused?: () => boolean,
): WxRunnerHandle {
  const x = el.getContext("2d");
  let running = true;
  if (!x) return { stop: () => { running = false; } };

  const tick = (ts: number) => {
    if (!running || !el.isConnected) return;
    if (isPaused?.()) { requestAnimationFrame(tick); return; }
    const d = Math.min(2, window.devicePixelRatio || 1);
    const cw = el.clientWidth, ch = el.clientHeight;
    if (cw && ch) {
      if (el.width !== cw * d || el.height !== ch * d) { el.width = cw * d; el.height = ch * d; }
      x.setTransform(d, 0, 0, d, 0, 0);
      renderAtmo(x, cw, ch, ts / 1000, getPreset());
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { stop: () => { running = false; } };
}
