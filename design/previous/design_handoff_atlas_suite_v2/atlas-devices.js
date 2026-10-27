/**
 * Atlas photoreal device library — geometry + procedurally synthesised PBR maps
 * for the self-contained WebGL renderer in atlas-pbr.js.
 *
 * Every map is generated in-browser from a height field: Sobel-converted to a
 * tangent-space normal map, with roughness derived from the same field.
 * Nothing is loaded from disk or network.
 */

import { lathe, disc, tube, torus, sphere, roundedBox, shearTop, hexRGB } from './atlas-pbr.js';

/* ---------- async chunked texture synthesis ---------- */

const _cache = new Map();
const _mc = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const _pending = [];
if (_mc) _mc.port1.onmessage = () => { const r = _pending.shift(); if (r) r(); };
const tick = () => _mc
  ? new Promise(r => { _pending.push(r); _mc.port2.postMessage(0); })
  : new Promise(r => setTimeout(r, 0));

async function memo(key, make) {
  if (!_cache.has(key)) _cache.set(key, await make());
  return _cache.get(key);
}
function memoSync(key, make) {
  if (!_cache.has(key)) _cache.set(key, make());
  return _cache.get(key);
}
export function clearTextureCache() { _cache.clear(); }

function cvs(size) { const c = document.createElement('canvas'); c.width = c.height = size; return c; }

async function heightField(size, fn) {
  const c = cvs(size), ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size), d = img.data;
  const band = Math.max(64, size >> 3);
  for (let y0 = 0; y0 < size; y0 += band) {
    const y1 = Math.min(size, y0 + band);
    for (let y = y0; y < y1; y++) {
      const vy = y / size, row = y * size;
      for (let x = 0; x < size; x++) {
        let v = fn(x / size, vy);
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        const i = (row + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v * 255; d[i + 3] = 255;
      }
    }
    if (y1 < size) await tick();
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function toNormal(src, strength) {
  const s = src.width;
  const sc = src.getContext('2d').getImageData(0, 0, s, s).data;
  const h = new Float32Array(s * s);
  for (let i = 0, p = 0; i < h.length; i++, p += 4) h[i] = sc[p] / 255;
  const out = cvs(s), octx = out.getContext('2d');
  const img = octx.createImageData(s, s), d = img.data;
  const band = Math.max(64, s >> 3);
  for (let y0 = 0; y0 < s; y0 += band) {
    const y1 = Math.min(s, y0 + band);
    for (let y = y0; y < y1; y++) {
      const ym = ((y - 1 + s) % s) * s, yp = ((y + 1) % s) * s, yc = y * s;
      for (let x = 0; x < s; x++) {
        const xm = (x - 1 + s) % s, xp = (x + 1) % s;
        const dx = (h[ym+xm] + 2*h[yc+xm] + h[yp+xm] - h[ym+xp] - 2*h[yc+xp] - h[yp+xp]) * strength;
        const dy = (h[ym+xm] + 2*h[ym+x] + h[ym+xp] - h[yp+xm] - 2*h[yp+x] - h[yp+xp]) * strength;
        const len = Math.sqrt(dx*dx + dy*dy + 1);
        const i = (yc + x) * 4;
        d[i] = (dx/len*0.5 + 0.5) * 255;
        d[i+1] = (dy/len*0.5 + 0.5) * 255;
        d[i+2] = (1/len*0.5 + 0.5) * 255;
        d[i+3] = 255;
      }
    }
    if (y1 < s) await tick();
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function roughFrom(src, lo, hi) {
  const s = src.width;
  const sc = src.getContext('2d').getImageData(0, 0, s, s).data;
  const out = cvs(s), octx = out.getContext('2d');
  const img = octx.createImageData(s, s);
  for (let i = 0; i < sc.length; i += 4) {
    const v = (lo + (1 - sc[i] / 255) * (hi - lo)) * 255;
    img.data[i] = img.data[i+1] = img.data[i+2] = v;
    img.data[i+3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* value noise */
function hash(x, y) { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf*xf*(3-2*xf), v = yf*yf*(3-2*yf);
  return (hash(xi,yi)*(1-u) + hash(xi+1,yi)*u)*(1-v) + (hash(xi,yi+1)*(1-u) + hash(xi+1,yi+1)*u)*v;
}
function fbm(x, y, oct) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < (oct || 4); i++) { s += vnoise(x*f, y*f)*a; f *= 2; a *= 0.5; }
  return s;
}

/* --- height fields --- */
const weaveH = (size, threads) => heightField(size, (u, v) => {
  const cell = 1 / threads;
  const cx = Math.floor(u / cell), cy = Math.floor(v / cell);
  const fu = (u % cell) / cell, fv = (v % cell) / cell;
  const t = ((cx + cy) & 1) === 0 ? fu : fv;
  let h = 0.18 + Math.sin(Math.PI * t) * 0.72;
  h += (fbm(u * threads * 5, v * threads * 5, 3) - 0.5) * 0.3;
  h -= Math.max(0, 1 - Math.hypot(fu - 0.5, fv - 0.5) * 3.4) * 0.07;
  return h;
});

const latticeH = (size, period) => heightField(size, (u, v) => {
  const a = (u + v) * period, b = (u - v) * period;
  const fa = Math.abs((a - Math.floor(a)) - 0.5) * 2;
  const fb = Math.abs((b - Math.floor(b)) - 0.5) * 2;
  const edge = Math.max(fa, fb);
  let h = edge * edge * edge;
  h -= Math.max(0, 1 - Math.hypot(1 - fa, 1 - fb) * 1.5) * 0.6;
  h = 0.26 + h * 0.7;
  h += (fbm(u * period * 9, v * period * 9, 3) - 0.5) * 0.22;
  return h;
});

const grainH = (size) => heightField(size, (u, v) => 0.5 + (fbm(u * 260, v * 260, 4) - 0.5) * 0.7);
const brushedH = (size) => heightField(size, (u, v) => 0.5 + (fbm(u * 3, v * 620, 3) - 0.5) * 0.9);

/* ---------- materials ---------- */

async function fabric(color, res, threads, repeat, bump) {
  const k = 'weave' + res + '_' + threads;
  const h = await memo(k, () => weaveH(res, threads));
  return {
    color: hexRGB(color), roughness: 1, metalness: 0, sheen: 0.5,
    normalMap: await memo(k + '_n', () => toNormal(h, bump || 3.4)),
    roughnessMap: memoSync(k + '_r', () => roughFrom(h, 0.72, 1)),
    // weave cavities self-shadow — without this cloth renders flat and pale
    aoMap: h, aoStrength: 0.9,
    normalScale: 1.15, repeat: repeat || [1, 1]
  };
}

async function lattice(color, res, period, repeat) {
  const k = 'lat' + res + '_' + period;
  const h = await memo(k, () => latticeH(res, period));
  return {
    color: hexRGB(color), roughness: 1, metalness: 0, sheen: 0.22,
    normalMap: await memo(k + '_n', () => toNormal(h, 5.2)),
    roughnessMap: memoSync(k + '_r', () => roughFrom(h, 0.52, 0.98)),
    aoMap: h, aoStrength: 0.92, normalScale: 1.9, repeat: repeat || [1, 1]
  };
}

async function plastic(color, roughness, res, o) {
  const opt = o || {};
  const h = await memo('grain' + res, () => grainH(res));
  return {
    color: hexRGB(color), roughness, metalness: 0,
    clearcoat: opt.clearcoat == null ? 0.4 : opt.clearcoat,
    clearcoatRoughness: opt.clearcoatRoughness == null ? 0.28 : opt.clearcoatRoughness,
    normalMap: await memo('grain' + res + '_n', () => toNormal(h, 0.5)),
    normalScale: 0.3, repeat: [3, 3]
  };
}

async function metal(color, roughness, res) {
  const h = await memo('brushed' + res, () => brushedH(res));
  return {
    color: hexRGB(color), roughness, metalness: 0.9,
    normalMap: await memo('brushed' + res + '_n', () => toNormal(h, 1.1)),
    normalScale: 0.45, repeat: [2, 2]
  };
}

const emissive = (color, glow, on) => ({
  color: hexRGB(color), roughness: 0.35, metalness: 0,
  emissive: hexRGB(glow), emissiveIntensity: on ? 2.6 : 0.16
});

/* ---------- painted display maps ---------- */

function siriMap(res) {
  return memoSync('siri' + res, () => {
    const c = cvs(res), ctx = c.getContext('2d');
    ctx.fillStyle = '#0a0a10'; ctx.fillRect(0, 0, res, res);
    const blob = (x, y, r, col) => {
      const g = ctx.createRadialGradient(x*res, y*res, 0, x*res, y*res, r*res);
      g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x*res, y*res, r*res, 0, 6.2832); ctx.fill();
    };
    blob(0.5, 0.5, 0.54, '#1b90c4');
    blob(0.24, 0.4, 0.34, '#e5289f');
    blob(0.79, 0.6, 0.34, '#10b89c');
    blob(0.5, 0.5, 0.22, '#ffffff');
    blob(0.52, 0.47, 0.1, '#ffffff');
    ctx.strokeStyle = 'rgba(16,16,22,.5)'; ctx.lineWidth = res*0.013; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(res*0.19, res*0.3); ctx.lineTo(res*0.3, res*0.3); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(res*0.7, res*0.65); ctx.lineTo(res*0.8, res*0.75);
    ctx.moveTo(res*0.8, res*0.65); ctx.lineTo(res*0.7, res*0.75); ctx.stroke();
    return c;
  });
}

function echoTopMap(res) {
  return memoSync('echotop' + res, () => {
    const c = cvs(res), ctx = c.getContext('2d');
    ctx.fillStyle = '#232429'; ctx.fillRect(0, 0, res, res);
    const R = res * 0.5;
    const btn = (ang, glyph) => {
      const x = R + Math.cos(ang)*R*0.46, y = R + Math.sin(ang)*R*0.46, r = res*0.085;
      ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = res*0.006;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke();
      ctx.save(); ctx.translate(x, y);
      ctx.strokeStyle = 'rgba(255,255,255,.62)'; ctx.lineWidth = res*0.0075; ctx.lineCap = 'round';
      if (glyph === 'x') { ctx.beginPath(); ctx.moveTo(-r*.3,-r*.3); ctx.lineTo(r*.3,r*.3); ctx.moveTo(r*.3,-r*.3); ctx.lineTo(-r*.3,r*.3); ctx.stroke(); }
      else if (glyph === 'dot') { ctx.fillStyle = 'rgba(255,255,255,.62)'; ctx.beginPath(); ctx.arc(0,0,r*.16,0,6.2832); ctx.fill(); }
      else if (glyph === 'minus') { ctx.beginPath(); ctx.moveTo(0,-r*.34); ctx.lineTo(0,r*.34); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(0,0,r*.32,0,6.2832); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-r*.44,0); ctx.lineTo(r*.44,0); ctx.stroke(); }
      ctx.restore();
    };
    btn(Math.PI*1.25, 'mic'); btn(Math.PI*1.75, 'x');
    btn(Math.PI*0.75, 'minus'); btn(Math.PI*0.25, 'dot');
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    for (let i = 0; i < 4; i++) {
      const a = Math.PI*(0.5 + i*0.5) + 0.4;
      ctx.beginPath(); ctx.arc(R + Math.cos(a)*R*0.74, R + Math.sin(a)*R*0.74, res*0.008, 0, 6.2832); ctx.fill();
    }
    return c;
  });
}

function hueLabelMap(res) {
  return memoSync('huelabel' + res, () => {
    const src = cvs(res), sx = src.getContext('2d');
    sx.fillStyle = '#f8f7f5'; sx.fillRect(0, 0, res, res);
    for (let i = 0; i < 3; i++) {
      sx.save();
      sx.translate(res * (0.1667 + i * 0.3333), res * 0.46);
      sx.textAlign = 'center';
      sx.fillStyle = '#a8601c';
      sx.font = '700 ' + Math.round(res*0.042) + 'px Geist, system-ui, sans-serif';
      sx.fillText('PHILIPS', 0, -res*0.03);
      sx.font = '400 ' + Math.round(res*0.085) + 'px Geist, system-ui, sans-serif';
      sx.fillText('hue', 0, res*0.05);
      sx.fillStyle = '#9b958f';
      sx.font = '400 ' + Math.round(res*0.028) + 'px Geist, system-ui, sans-serif';
      sx.fillText('white and color', 0, res*0.098);
      sx.restore();
    }
    /* The lathe's UV runs opposite on both axes for an outward-facing wall,
       so the artwork is baked rotated 180° to read upright on the housing. */
    const c = cvs(res), ctx = c.getContext('2d');
    ctx.translate(res, res); ctx.scale(-1, -1);
    ctx.drawImage(src, 0, 0);
    return c;
  });
}

/* ---------- device builders ---------- */

const B = {};

/* Apple HomePod mini — Ø97.9 × 84.3 mm, lattice-wrapped sphere. */
B.homepod = async (o) => {
  const R = 0.0489, H = 0.0843, res = o.res, parts = [];
  const prof = [[0, 0.0006], [0.0248, 0.0006]];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, a = -Math.PI*0.44 + t*(Math.PI*0.44 + Math.PI*0.352);
    prof.push([Math.cos(a) * R, H/2 + Math.sin(a) * (H/2)]);
  }
  const topR = prof[prof.length - 1][0];
  const dishY = prof[prof.length - 1][1] + 0.0012;
  prof.push([topR * 0.985, dishY - 0.0002], [topR * 0.955, dishY]);
  parts.push({ name: 'mesh_shell', geo: lathe(prof, 200, [7, 4]), mat: await lattice(0x232326, res, 44, [6, 3.4]) });

  const dishR = topR * 0.955;
  parts.push({ name: 'siri_display', geo: disc(dishR, 96, dishY), mat: {
    decal: true,
    color: [1,1,1], roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06,
    map: siriMap(Math.min(1024, res)),
    emissive: [1,1,1], emissiveIntensity: o.on ? 1.45 : 0.05,
    emissiveMap: siriMap(Math.min(1024, res))
  }});
  parts.push({ name: 'dish_rim', geo: torus(dishR, 0.0011, 96, 16), mat: await plastic(0x1c1c1f, 0.38, 512),
    offset: [0, dishY, 0] });
  parts.push({ name: 'base_pad', geo: disc(0.0262, 64, 0.0005, true), mat: await plastic(0x2a2a2d, 0.92, 512, { clearcoat: 0 }) });
  return parts;
};

/* Amazon Echo Dot 3 — Ø99 × 43 mm, fabric barrel, light ring, dark cap. */
B.echodot = async (o) => {
  const R = 0.0495, H = 0.043, res = o.res, parts = [];
  const SEAM0 = 0.0318, SEAM1 = 0.0352;   // the light ring owns this band

  /* Fabric barrel: bottom fillet, then a straight wall that stops at the
     widest point. It must not curve inward before the seam, or it swallows
     the ring. */
  const body = [[0, 0.0004], [R - 0.007, 0.0004]];
  for (let i = 1; i <= 14; i++) {
    const t = i / 14;
    body.push([R - 0.007 + 0.007 * Math.sin(t * Math.PI / 2), 0.0004 + 0.0072 * (1 - Math.cos(t * Math.PI / 2))]);
  }
  body.push([R, SEAM0]);
  parts.push({ name: 'fabric_body', geo: lathe(body, 180, [8, 1.4]),
    mat: await fabric(0x2c2d31, res, 80, [7, 1], 3.8) });

  /* Translucent light band at full body diameter — the silhouette at the seam. */
  parts.push({ name: 'light_ring', geo: tube(R, SEAM1 - SEAM0, SEAM0, 180),
    mat: emissive(0x0b2340, 0x3aa6ff, o.on) });

  /* Dark cap doming in from the seam to the flat control face. */
  const FACE_R = 0.0375, FACE_Y = H;
  const cap = [[R, SEAM1]];
  for (let i = 1; i <= 20; i++) {
    const t = i / 20;
    cap.push([R - (R - FACE_R) * Math.sin(t * Math.PI / 2), SEAM1 + (FACE_Y - SEAM1) * (1 - Math.cos(t * Math.PI / 2))]);
  }
  cap.push([0, FACE_Y]);
  parts.push({ name: 'top_bezel', geo: lathe(cap, 180, [4, 1]),
    mat: await plastic(0x282930, 0.5, 512, { clearcoat: 0.55, clearcoatRoughness: 0.3 }) });
  parts.push({ name: 'control_face', geo: disc(FACE_R, 96, FACE_Y), mat: {
    decal: true, color: [1, 1, 1], roughness: 0.46, metalness: 0, clearcoat: 0.65, clearcoatRoughness: 0.36,
    map: echoTopMap(Math.min(1024, res))
  }});
  return parts;
};

/* Philips Hue A19 — frosted diffuser, white body, nickel E26. */
B.huebulb = async (o) => {
  const res = o.res, parts = [];
  /* A19 dome: springs from the housing lip at its exact radius, bulges a hair,
     then rounds over. a0 < 0 puts the widest point just above the seam. */
  const NECK_R = 0.0310, NECK_Y = 0.0700, TOP_Y = 0.1100, A0 = -0.12;
  const RM = NECK_R / Math.pow(Math.cos(A0), 0.62);
  const glass = [];
  for (let i = 0; i <= 56; i++) {
    const a = A0 + (i/56) * (Math.PI/2 - A0);
    glass.push([RM * Math.pow(Math.max(0, Math.cos(a)), 0.62),
      NECK_Y + (TOP_Y - NECK_Y) * (Math.sin(a) - Math.sin(A0)) / (1 - Math.sin(A0))]);
  }
  glass.push([0, TOP_Y]);
  const tint = o.tint == null ? 0xff5fa8 : o.tint;
  parts.push({ name: 'diffuser', geo: lathe(glass, 128, [1,1]), mat: {
    color: hexRGB(o.on ? tint : 0xf3f1ef), roughness: 0.36, metalness: 0,
    transmission: 0.5, clearcoat: 1, clearcoatRoughness: 0.12,
    emissive: hexRGB(tint), emissiveIntensity: o.on ? 0.85 : 0
  }});
  parts.push({ name: 'housing', geo: lathe(
    [[0.0169, 0.0226], [0.0205, 0.0330], [0.0258, 0.0470], [0.0296, 0.0600], [0.0310, 0.0700]], 128, [3, 1]),
    mat: { color: [1,1,1], roughness: 0.42, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.28,
      map: hueLabelMap(Math.min(1024, res)), repeat: [1, 1] } });

  const screw = [[0.0088, 0], [0.0134, 0.0026], [0.0166, 0.0072]];
  for (let i = 0; i <= 26; i++) { const t = i/26; screw.push([0.0169 + Math.sin(t*Math.PI*9)*0.0012, 0.0072 + t*0.0154]); }
  parts.push({ name: 'e26_base', geo: lathe(screw, 128, [3,1]), mat: await metal(0xd6d7d9, 0.26, 512) });
  parts.push({ name: 'contact_tip', geo: sphere(0.0086, 40, 20, Math.PI*0.5, Math.PI*0.5),
    mat: await plastic(0x1b1b1d, 0.48, 512), offset: [0, 0.0024, 0] });
  return parts;
};

/* Philips Hue Bridge — 88 × 88 × 26 mm gloss slab. */
B.huebridge = async (o) => {
  const W = 0.088, H = 0.026, res = o.res, parts = [];
  parts.push({ name: 'bridge_shell', geo: roundedBox(W, W, H, 0.017, 0.005, 12),
    mat: await plastic(0xf7f7f8, 0.26, res, { clearcoat: 0.9, clearcoatRoughness: 0.16 }) });
  parts.push({ name: 'button_well', geo: disc(0.0186, 96, H),
    mat: Object.assign(await plastic(0xe8e9eb, 0.4, 512, { clearcoat: 0.45 }), { decal: true }) });
  parts.push({ name: 'button_halo', geo: torus(0.0178, 0.0011, 96, 14),
    mat: emissive(0x08283c, 0x3ad0ff, o.on), offset: [0, H, 0] });
  const btn = [[0, H + 0.0034], [0.0138, H + 0.0034]];
  for (let i = 1; i <= 6; i++) { const t = i/6; btn.push([0.0138 + 0.0026*Math.sin(t*Math.PI/2), H + 0.0034 - 0.0038*(1 - Math.cos(t*Math.PI/2))]); }
  parts.push({ name: 'link_button', geo: lathe(btn, 96, [1,1]),
    mat: await plastic(0xfcfcfd, 0.22, 512, { clearcoat: 0.95, clearcoatRoughness: 0.12 }) });
  const led = Object.assign(emissive(0x08283c, 0x3ad0ff, o.on), { decal: true });
  [-0.019, 0, 0.019].forEach((x, i) => parts.push({
    name: 'led_' + i, geo: disc(0.0017, 20, 0), mat: led, offset: [x, H, -0.031] }));
  const dark = await plastic(0x17181a, 0.55, 512, { clearcoat: 0 });
  parts.push({ name: 'lan_port', geo: roundedBox(0.0152, 0.0062, 0.0128, 0.0008, 0.0004, 3), mat: dark,
    offset: [0.013, 0.003, W/2 - 0.0032] });
  parts.push({ name: 'lan_pins', geo: roundedBox(0.0106, 0.0012, 0.0016, 0.0003, 0.0002, 2),
    mat: await metal(0xd9b74c, 0.3, 512), offset: [0.013, 0.0128, W/2 - 0.0006] });
  parts.push({ name: 'dc_jack', geo: lathe([[0, 0], [0.0038, 0], [0.0038, 0.006], [0.0016, 0.006], [0.0016, 0.001]], 40, [1,1]),
    mat: dark, offset: [-0.019, 0.0092, W/2 - 0.0062] });
  return parts;
};

/* Google Home — Ø96 × 142 mm, sheared aluminium shell over a woven base. */
B.googlehome = async (o) => {
  const res = o.res, H = 0.1424, parts = [];
  const base = [[0, 0.0006], [0.0374, 0.0006]];
  for (let i = 1; i <= 30; i++) { const t = i/30; base.push([0.0374 + Math.sin(t*Math.PI*0.60)*0.0111, 0.0006 + t*0.0552]); }
  parts.push({ name: 'fabric_base', geo: lathe(base, 180, [9, 1.4]), mat: await fabric(0xc4c4c2, res, 96, [8, 1], 3) });

  const top = [[0.0479, 0.0552], [0.0479, 0.058]];
  for (let i = 1; i <= 34; i++) { const t = i/34; top.push([0.0479 - Math.pow(t, 1.9)*0.0126, 0.058 + t*(H - 0.058)]); }
  top.push([0, H - 0.0006]);
  const shell = shearTop(lathe(top, 180, [5, 2]), 0.058, H, 0.62);
  parts.push({ name: 'alu_shell', geo: shell, mat: Object.assign(await metal(0xf4f4f6, 0.42, 512), { metalness: 0.22, clearcoat: 0.18, clearcoatRoughness: 0.4 }) });
  parts.push({ name: 'mute_ring', geo: torus(0.0068, 0.0007, 64, 12),
    mat: Object.assign(await plastic(0xcacbcd, 0.48, 512, { clearcoat: 0.25 }), { decal: true }), offset: [-0.0272, 0.1166, 0.0294] });
  parts.push({ name: 'status_led', geo: disc(0.0012, 20, 0),
    mat: Object.assign(emissive(0x08283c, 0x4aa8ff, o.on), { decal: true }),
    offset: [-0.0188, 0.083, 0.0442] });
  return parts;
};

/* Thermostat — steel bezel, glass face. */
B.thermostat = async (o) => {
  const parts = [];
  parts.push({ name: 'bezel', geo: lathe(
    [[0, 0], [0.038, 0], [0.0414, 0.0042], [0.0414, 0.0208], [0.0388, 0.0244], [0.0336, 0.0254]], 160, [4,1]),
    mat: await metal(0xd8d9db, 0.24, 512) });
  parts.push({ name: 'display', geo: disc(0.0336, 96, 0.0254), mat: {
    decal: true, color: hexRGB(0x0e0e12), roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03,
    emissive: hexRGB(0xc2661a), emissiveIntensity: o.on ? 0.4 : 0.05 } });
  return parts;
};

/* Smart plug — soft-touch ABS block. */
B.plug = async (o) => {
  const parts = [];
  parts.push({ name: 'plug_shell', geo: roundedBox(0.052, 0.038, 0.062, 0.015, 0.005, 10),
    mat: await plastic(0xf5f5f6, 0.32, o.res, { clearcoat: 0.75 }) });
  parts.push({ name: 'power_button', geo: lathe([[0, 0.0022], [0.0056, 0.0022], [0.0058, 0]], 48, [1,1]),
    mat: await plastic(0xeaeaeb, 0.4, 512), offset: [0, 0.046, 0.019] });
  parts.push({ name: 'status_led', geo: disc(0.0017, 20, 0),
    mat: Object.assign(emissive(0x05301f, 0x27d891, o.on), { decal: true }),
    offset: [0, 0.03, 0.019] });
  return parts;
};

export const DEVICES = [
  { id: 'homepod',    label: 'HomePod mini',       note: 'Diamond lattice · Siri display' },
  { id: 'echodot',    label: 'Echo Dot (3rd gen)', note: 'Woven fabric · light ring' },
  { id: 'huebulb',    label: 'Hue White & Color',  note: 'Frosted transmission · E26' },
  { id: 'huebridge',  label: 'Hue Bridge',         note: 'Gloss ABS · LAN + LEDs' },
  { id: 'googlehome', label: 'Google Home',        note: 'Brushed alu · sheared shell' },
  { id: 'thermostat', label: 'Thermostat',         note: 'Steel bezel · glass face' },
  { id: 'plug',       label: 'Smart plug',         note: 'Soft-touch ABS' }
];


/* ---------- parametric generation from filed dimensions ----------
   Archetype + real dimensions -> a true-scale solid. Dimension-driven, not
   image-driven: this produces a correct BLANK to calibrate against, and the
   patent elevations still have to be traced to refine the profile. */
const MM = 0.001;

function genProfile(a, D, H, g) {
  const R = D / 2, p = [];
  if (a === 'sphere-truncated') {
    const ft = g.flatTop ?? 0.34, fb = g.flatBottom ?? 0.30;
    const y0 = H * 0.02, cy = H / 2;
    p.push([R * fb, 0]);
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, ang = -Math.PI * 0.5 + t * Math.PI;
      const rr = R * Math.cos(ang * 0.86), yy = cy + Math.sin(ang) * (H / 2 - y0);
      if (yy >= 0 && rr >= 0) p.push([Math.max(rr, R * 0.02), yy]);
    }
    p.push([R * ft, H]);
  } else if (a === 'puck-domed' || a === 'puck-flat') {
    const f = (a === 'puck-flat' ? 0.06 : (g.fillet ?? 0.2)) * H;
    const seam = (g.seam ?? 0.82) * H;
    p.push([0, 0], [R - f, 0]);
    for (let i = 1; i <= 12; i++) { const t = i / 12;
      p.push([R - f + f * Math.sin(t * Math.PI / 2), f * (1 - Math.cos(t * Math.PI / 2))]); }
    p.push([R, seam]);
    for (let i = 1; i <= 14; i++) { const t = i / 14;
      p.push([R - R * 0.26 * Math.sin(t * Math.PI / 2), seam + (H - seam) * (1 - Math.cos(t * Math.PI / 2))]); }
    p.push([0, H]);
  } else if (a === 'cylinder-domed' || a === 'cylinder-sheared') {
    const crown = (g.crown ?? 0.18) * H;
    p.push([0, 0], [R * 0.94, 0], [R, H * 0.05], [R, H - crown]);
    for (let i = 1; i <= 16; i++) { const t = i / 16;
      p.push([R * Math.cos(t * Math.PI / 2 * 0.98), H - crown + crown * Math.sin(t * Math.PI / 2)]); }
    p.push([0, H]);
  } else if (a === 'bulb-a19') {
    const neck = H * 0.30;
    for (let i = 0; i <= 44; i++) { const t = i / 44;
      p.push([R * Math.pow(Math.sin(t * Math.PI * 0.93 + 0.22), 0.6), neck + t * (H - neck)]); }
    p.push([0, H]);
  } else if (a === 'strip-flex') {
    /* low domed extrusion: flat PCB base, diffuser crown */
    const r = R;
    p.push([0, 0], [r * 0.96, 0], [r, H * 0.22]);
    for (let i = 1; i <= 14; i++) { const t = i / 14;
      p.push([r * Math.cos(t * Math.PI / 2 * 0.96), H * 0.22 + (H - H * 0.22) * Math.sin(t * Math.PI / 2)]); }
    p.push([0, H]);
  } else { /* slab-rounded, display-on-base fall back to a rounded column */
    const r = Math.min(R, H / 2) * (g.radius ?? 0.3);
    p.push([0, 0], [R - r, 0]);
    for (let i = 1; i <= 10; i++) { const t = i / 10;
      p.push([R - r + r * Math.sin(t * Math.PI / 2), r * (1 - Math.cos(t * Math.PI / 2))]); }
    p.push([R, H - r]);
    for (let i = 1; i <= 10; i++) { const t = i / 10;
      p.push([R - r + r * Math.cos(t * Math.PI / 2), H - r + r * Math.sin(t * Math.PI / 2)]); }
    p.push([0, H]);
  }
  return p.filter((v, i, arr) => i === 0 || v[0] !== arr[i-1][0] || v[1] !== arr[i-1][1]);
}

async function genMaterial(kind, res, on) {
  if (kind === 'fabric')   return await fabric(0x54565e, res, 72, [7, 1], 3.4);
  if (kind === 'metal')    return await metal(0xbfc1c4, 0.3, res);
  if (kind === 'mirror')   return await metal(0xe6e7e9, 0.12, res);
  if (kind === 'gloss')    return await plastic(0xf2f0ed, 0.16, res, { clearcoat: 1, clearcoatRoughness: 0.06 });
  if (kind === 'diffuser') return { color: [0.96,0.95,0.94], roughness: 0.36, metalness: 0,
    transmission: 0.5, clearcoat: 1, clearcoatRoughness: 0.12,
    emissive: [1,0.62,0.78], emissiveIntensity: on ? 0.8 : 0 };
  return await plastic(0xd8d5d0, 0.42, res, { clearcoat: 0.5, clearcoatRoughness: 0.3 });
}

/* radius of a lathe profile at height y, linearly interpolated between samples */
function radiusAt(profile, y) {
  let best = 0;
  for (let i = 1; i < profile.length; i++) {
    const [r0, y0] = profile[i - 1], [r1, y1] = profile[i];
    if (y >= Math.min(y0, y1) && y <= Math.max(y0, y1)) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      best = Math.max(best, r0 + (r1 - r0) * t);
    }
  }
  return best;
}

/* Highest point of the profile, and its radius there — where a top-face decal sits. */
function crown(profile) {
  let y = -Infinity, r = 0;
  for (const [pr, py] of profile) if (py > y) { y = py; r = pr; }
  return { y, r: Math.max(r, radiusAt(profile, y - 1e-6)) };
}

export async function generateFromFiling(spec, opts) {
  const o = Object.assign({ res: 2048, on: true }, opts || {});
  const d = spec.dims || {};
  const D = (d.d || d.w || 80) * MM;
  const H = (d.h || 80) * MM;
  const g = spec.gen || {};
  const a = spec.archetype || 'puck-domed';
  const parts = [];

  const profile = genProfile(a, D, H, g);
  const top = crown(profile);
  if (a === 'strip-flex') {
    /* cross-section is depth x height; sweep it along the run length */
    const L = (d.w || 300) * MM, T = (d.d || 14) * MM, Ht = (d.h || 4) * MM;
    parts.push({ name: 'strip_diffuser', geo: roundedBox(L, T, Ht, Math.min(T, Ht) * 0.35),
      mat: { color: [0.95, 0.94, 0.93], roughness: 0.34, metalness: 0,
        emissive: [1, 0.68, 0.42], emissiveIntensity: o.on ? 1.1 : 0 } });
    return { id: 'generated:' + (spec.name || 'device'), parts, generated: true, spec };
  }
  parts.push({ name: 'generated_body', geo: lathe(profile, 256, [4, 1]),
    mat: await genMaterial(g.material, o.res, o.on) });

  if (a === 'bulb-a19') {
    const base = radiusAt(profile, H * 0.30) || D * 0.27;
    const screw = [[base * 0.52, 0], [base * 0.78, H*0.02], [base * 0.96, H*0.05]];
    for (let i = 0; i <= 24; i++) { const t = i/24;
      screw.push([base + Math.sin(t*Math.PI*9)*base*0.07, H*0.05 + t*H*0.24]); }
    parts.push({ name: 'cap', geo: lathe(screw, 96, [3,1]), mat: await metal(0xd6d7d9, 0.26, o.res) });
  }
  if (g.accent === 'ring') {
    /* sit the ring ON the silhouette at its own height, not on the body's max radius */
    const y = H * ((g.seam ?? 0.82) - 0.04);
    const r = radiusAt(profile, y + H * 0.025) || D / 2;
    parts.push({ name: 'light_ring', geo: tube(r * 1.002, H * 0.05, y, 176),
      mat: emissive(0x0b2340, 0x3aa6ff, o.on) });
  }
  if (g.accent === 'display') {
    /* flush with the crown, inset so it never overhangs the edge it sits in */
    parts.push({ name: 'display', geo: disc(top.r * 0.9, 88, top.y + H * 0.0004),
      mat: emissive(0x14161c, 0x6f8dff, o.on) });
  }
  if (g.accent === 'emissive' && a !== 'bulb-a19') {
    parts.push({ name: 'lens', geo: disc(top.r * 0.82, 72, top.y + H * 0.0004),
      mat: emissive(0x1a1a1c, 0xffb46e, o.on) });
  }
  return { id: 'generated:' + (spec.name || 'device'), parts, generated: true, spec };
}

export async function buildDevice(id, opts) {
  const o = Object.assign({ res: 1024, on: true }, opts || {});
  const parts = await (B[id] || B.homepod)(o);
  return { id, parts };
}
