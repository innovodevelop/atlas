/* Atlas particle sphere — single shared renderer for every Atlas view.
   Baseline = saved editor preset "Atlas v2.0". Mount a canvas, pass a state
   (or a getter for live params) and the sphere looks identical everywhere.

   v3 adds a second FORMATION to the same particle set — the field — plus the
   morph that carries every particle precisely between the two:

     morph = 1  → Atlas Sphere   (default; byte-identical to v2 for all callers)
     morph = 0  → Particle Field (the sphere unrolled to a plane of travelling waves)
     0 < m < 1  → in transit, per-particle staggered, on a bowed arc

   Every particle owns BOTH homes, so nothing is created or destroyed on a state
   change: the cloud simply re-forms. Shading, dot-size and depth banding are the
   one shared pipeline, so a field dot and a sphere dot are the same dot. */
(function () {
  var PRESET = { count: 26000, dens: 0.70, size: 0.60, soft: 0 };

  var STATES = ['idle', 'listening', 'thinking', 'speaking', 'working', 'success', 'alert', 'muted', 'waking', 'dissolving'];

  var TINT = {
    thinking: [109, 75, 255], speaking: [22, 168, 122], working: [224, 122, 31],
    success: [30, 176, 128], alert: [208, 69, 58]
  };

  var clouds = new Map();
  function cloud(n, dens, ar) {
    var key = n + '|' + dens.toFixed(2) + '|' + ar.toFixed(2);
    var hit = clouds.get(key);
    if (hit) return hit;
    if (clouds.size > 8) clouds.clear();
    var P = [];
    for (var i = 0; i < n; i++) {
      var th = Math.random() * 6.2832, ph = Math.acos(2 * Math.random() - 1), r = Math.pow(Math.random(), dens);
      var x = r * Math.sin(ph) * Math.cos(th), y = r * Math.sin(ph) * Math.sin(th), z = r * Math.cos(ph);
      var lon = (Math.atan2(z, x) + Math.PI) / 6.2832;
      var sy = r > 1e-4 ? y / r : 0;
      if (sy > 1) sy = 1; else if (sy < -1) sy = -1;
      P.push({
        x: x, y: y, z: z, r: r, rn: Math.random(),
        ox: (Math.random() - 0.5) * 4.2, oy: (Math.random() - 0.5) * 4.2, oz: (Math.random() - 0.5) * 4.2,
        lon: lon, lat: (sy < 0 ? -1 : 1) * Math.pow(Math.abs(sy), 0.62),
        par: Math.random() < 0.5 ? -1 : 1
      });
    }
    /* Field home = an even, half-offset (hex-packed) lattice sized to the canvas
       aspect, so cells are square on screen and the plane reads clean rather than
       clumped. Cells are handed out in latitude→longitude order, so the sphere
       still UNROLLS into the field: neighbours on the shell stay neighbours here. */
    var cols = Math.max(2, Math.round(Math.sqrt(n * ar)));
    var rows = Math.max(2, Math.ceil(n / cols));
    var rb = 1; while ((1 << rb) < rows) rb++;
    var rev = function (x) { var r = 0; for (var b = 0; b < rb; b++) { r = (r << 1) | (x & 1); x >>= 1; } return r; };
    var order = P.slice().sort(function (a, b) { return a.lat - b.lat; });
    for (var row = 0; row < rows; row++) {
      var slice = order.slice(row * cols, (row + 1) * cols);
      if (!slice.length) break;
      slice.sort(function (a, b) { return a.lon - b.lon; });
      var off = (row & 1) ? 0.5 : 0;
      for (var c = 0; c < slice.length; c++) {
        var q = slice[c];
        q.rk = rev(row);                                   /* bit-reversed row rank */
        q.u = (c + 0.5 + off) / cols;
        q.vy = ((row + 0.5) / rows) * 2 - 1;
        q.jx = (Math.random() - 0.5) * (1.6 / cols);      /* ±8% of a cell */
        q.jy = (Math.random() - 0.5) * (0.32 / rows);
        var ex = (q.u * 2 - 1) + q.jx, ey = (q.vy + q.jy) * 1.05;
        q.fr = Math.min(1, Math.sqrt(ex * ex + ey * ey) / 1.3);
      }
    }
    /* Draw order = complete rows in bit-reversed sequence, so ANY prefix of the
       array is a set of evenly-spaced whole rows — adaptive thinning stays an
       aligned sub-lattice instead of collapsing into Poisson clumps. */
    P.sort(function (a, b) { return (a.rk - b.rk) || (a.u - b.u); });
    clouds.set(key, P);
    return P;
  }

  var NB = 8, NA = 11, NS = 3;
  var paths = [];
  var STAG = 0.62;              /* how much of the morph is spent staggering  */
  var BOW = 0.17;               /* arc height as a fraction of travel length  */

  function paint(entry, t) {
    var el = entry.el, ctx = entry.ctx;
    var o = typeof entry.opts === 'function' ? (entry.opts() || {}) : entry.opts;
    var st = o.state || el.getAttribute('data-state') || 'idle';
    var dark = !!o.dark;
    var q = entry.q == null ? 1 : entry.q;
    var count = Math.max(400, Math.round((o.count || PRESET.count) * (o.countScale == null ? 1 : o.countScale)));
    var dens = o.dens || PRESET.dens;
    var dotSize = o.size == null ? PRESET.size : o.size;
    var sof = Math.max(0, Math.min(1, (o.soft == null ? PRESET.soft : o.soft) / 10));

    var dpr = Math.min(o.maxDpr || 1.5, window.devicePixelRatio || 1);
    var cw = el.clientWidth || el.width, ch = el.clientHeight || el.height;
    if (!cw || !ch) return;
    if (el.width !== Math.round(cw * dpr) || el.height !== Math.round(ch * dpr)) { el.width = Math.round(cw * dpr); el.height = Math.round(ch * dpr); }

    var W = el.width, H = el.height, S = W < H ? W : H;
    var cx = W * (o.cx == null ? 0.5 : o.cx), cy = H * (o.cy == null ? 0.5 : o.cy);
    var R = S * (o.radius == null ? 0.44 : o.radius);

    var pts = cloud(count, dens, Math.max(0.5, Math.min(4, W / H))), T = t * 0.001;
    /* quality thins the draw, it does not rebuild the cloud — particles sit in
       creation order while lattice cells were assigned by latitude, so any prefix
       is an evenly-scattered subset of the plane */
    var lim = q >= 1 ? pts.length : Math.max(400, Math.min(pts.length, Math.round(pts.length * q)));
    ctx.clearRect(0, 0, W, H);

    /* ---- formation state ------------------------------------------------ */
    var morph = o.morph == null ? 1 : (o.morph < 0 ? 0 : (o.morph > 1 ? 1 : o.morph));
    var mixed = morph < 0.999;
    var amp = o.amp == null ? 0.3 : o.amp, pulse = o.pulse || 0;
    var aGain = o.alphaGain == null ? 1 : o.alphaGain;
    var whiten = o.whiten || 0;
    var pal = (o.palette && o.palette.length >= 3) ? o.palette : null;
    var fw = W * 0.5 * (o.fieldSpread == null ? 1.06 : o.fieldSpread);
    var fh = H * 0.5 * (o.fieldSpread == null ? 1.06 : o.fieldSpread);
    var fAmp = H * (0.008 + amp * 0.05);
    var sphereFrac = o.sphereFrac == null ? 1 : o.sphereFrac;  /* extras dissolve on the way in */
    var settle = mixed ? 1 + Math.sin((1 - morph) * 9.4) * 0.022 * morph * (1 - morph) * 4 : 1;

    var spin = 0.0006, sat = 1, jx = 0, radial = 0.82;
    if (st === 'listening') spin = 0.0013;
    else if (st === 'thinking') spin = 0.002;
    else if (st === 'speaking') spin = 0.0015;
    else if (st === 'working') spin = 0.003;
    else if (st === 'muted') { spin = 0.00025; radial = 0.68; sat = 0; }
    else if (st === 'alert') jx = Math.sin(T * 15) * Math.max(0, Math.sin(T * 2.6)) * 1.6 * dpr;
    if (o.spin != null) spin = o.spin;

    var tint = TINT[st] || null;
    var rot = t * spin, ca = Math.cos(rot), sa = Math.sin(rot);
    var breathe = 1 + Math.sin(T * (st === 'idle' ? 0.16 : 0.3)) * 0.03;
    var wake = st === 'waking' ? Math.min(1, ((T * 0.55) % 1.9) / 1.3) : 1;
    var diss = st === 'dissolving' ? ((T * 0.6) % 1.9) / 1.9 : 0;

    var gAlpha = o.glow == null ? (dark ? 0.15 : 0.07) : o.glow;
    if (gAlpha > 0) {
      var gR = R * 1.25 * (mixed ? 0.35 + 0.65 * morph : 1);
      var glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, gR);
      var gc = pal ? pal[2] : (tint || [52, 97, 242]);
      glow.addColorStop(0, 'rgba(' + (gc[0] | 0) + ',' + (gc[1] | 0) + ',' + (gc[2] | 0) + ',' + (gAlpha * (0.45 + morph * 0.55)).toFixed(3) + ')');
      glow.addColorStop(1, 'rgba(' + (gc[0] | 0) + ',' + (gc[1] | 0) + ',' + (gc[2] | 0) + ',0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, gR, 0, 6.2832); ctx.fill();
    }

    var szSoft = 1 + sof * 0.75, aSoft = 1 - sof * 0.42;
    for (var i = 0; i < NB * NS * NA; i++) paths[i] = null;

    for (var pi = 0; pi < lim; pi++) {
      var p = pts[pi];
      var x = p.x, y = p.y, z = p.z, aMul = 1, szMul = 1, dscale = 1;
      var wob = (1 + Math.sin(T * 0.5 + p.rn * 8) * 0.06) * breathe;
      x *= wob; y *= wob; z *= wob;

      if (st === 'listening') {
        var d0 = Math.sqrt(x * x + y * y + z * z) || 1e-4, w = Math.sin(d0 * 8 - T * 4) * 0.09, k1 = 1 + w;
        x *= k1; y *= k1; z *= k1; aMul = 1.18 + w * 2;
      } else if (st === 'thinking') {
        var sh = y * 0.9 + Math.sin(T * 1.3) * 0.2, cs = Math.cos(sh), ss = Math.sin(sh), nx2 = x * cs - z * ss;
        z = x * ss + z * cs; x = nx2;
      } else if (st === 'speaking') {
        var band = Math.floor((y + 1) * 4), amp2 = 0.22 * Math.abs(Math.sin(T * 6 + band * 1.3)) * (1 - Math.abs(y) * 0.4), k2 = 1 + amp2;
        x *= k2; z *= k2; aMul = 0.9 + amp2 * 2.2;
      } else if (st === 'working') {
        var mix = 0.72, rr = Math.sqrt(x * x + z * z) || 1e-4, tr = 0.78 + (rr - 0.78) * 0.28;
        x = x + ((x / rr) * tr - x) * mix; z = z + ((z / rr) * tr - z) * mix; y *= 1 - mix * 0.72;
      } else if (st === 'alert') {
        var pulse2 = 1 + 0.1 * Math.max(0, Math.sin(T * 5.2)) * Math.max(0, Math.sin(T * 2.6));
        x *= pulse2; y *= pulse2; z *= pulse2;
      } else if (st === 'success') {
        if (p.rn > 0.52) {
          var q1 = ((T * 0.62 + p.rn * 1.85) % 1), e1 = 1 - (1 - q1) * (1 - q1), k3 = 1 + e1 * 1.05;
          x *= k3; y *= k3; z *= k3; dscale = k3;
          aMul = (1 - q1) * (1 - q1) * 1.6; szMul = 1 - 0.4 * e1;
        } else { var k4 = 0.94 + 0.06 * Math.sin(T * 3.1); x *= k4; y *= k4; z *= k4; }
      } else if (st === 'waking') {
        var q2 = Math.min(1, Math.max(0, (wake - p.rn * 0.5) / 0.5)), e2 = q2 * q2 * (3 - 2 * q2);
        x = p.ox + (x - p.ox) * e2; y = p.oy + (y - p.oy) * e2; z = p.oz + (z - p.oz) * e2;
        aMul = e2 * e2; szMul = 0.5 + 0.5 * e2;
      } else if (st === 'dissolving') {
        var q3 = Math.min(1, Math.max(0, (diss - p.rn * 0.35) / 0.65)), e3 = q3 * q3, k5 = 1 + e3 * 0.9;
        x *= k5; y *= k5; z *= k5; aMul = (1 - e3) * (1 - e3);
      }

      var X = x * ca + z * sa, Z = -x * sa + z * ca;
      var depth = (Z + 1) / 2, dd = Math.sqrt(X * X + y * y + Z * Z) / dscale;
      var a = Math.max(0, 1 - Math.max(0, (dd - 0.42) / 0.5)) * (0.4 + depth * 0.6) * aMul * aSoft;
      var kR = R * (radial / 0.82) * settle;
      var px = cx + X * kR + jx, py = cy + y * kR;

      if (mixed) {
        /* --- field home + travelling waves ------------------------------- */
        var lin = Math.sin(p.u * 12.566 - T * 1.5 + p.vy * 2.3) * 0.78 + Math.sin(p.u * 5.4 + T * 0.58 - p.vy * 1.1) * 0.34;
        var rad0 = Math.sin(p.fr * 5.1 - T * 2.3);
        var wv = (lin + (0.22 + 0.5 * pulse) * rad0) / (1.06 + 0.5 * pulse);
        var edge = 1 - p.fr * p.fr * p.fr;
        if (edge < 0) edge = 0;
        var fx = cx + ((p.u * 2 - 1) + p.jx) * fw;
        var fy = cy + (p.vy + p.jy) * fh + wv * fAmp * edge;
        var crest = wv * 0.5 + 0.5;
        var cr2 = crest * crest * (0.4 + 0.6 * crest);
        var fDepth = 0.14 + 0.7 * crest + p.r * 0.14;
        if (fDepth > 1) fDepth = 1;
        /* crest-weighted alpha: troughs fall to nothing so the waves read as
           bands of light travelling through the plane, not as flat noise. */
        var fa = edge * (0.045 + 0.95 * cr2) * (0.58 + amp * 0.7) * aSoft;

        /* --- per-particle staggered, bowed transit ----------------------- */
        var wgt = p.fr * 0.55 + p.rn * 0.45;
        var e = (morph * (1 + STAG) - wgt * STAG) / 1;
        if (e < 0) e = 0; else if (e > 1) e = 1;
        e = e * e * (3 - 2 * e);
        var dx = px - fx, dy = py - fy, L = Math.sqrt(dx * dx + dy * dy) || 1;
        var arc = Math.sin(Math.PI * e) * L * BOW * p.par;
        px = fx + dx * e - (dy / L) * arc;
        py = fy + dy * e + (dx / L) * arc;
        depth = fDepth + (depth - fDepth) * e;
        a = fa + (a - fa) * e;
        szMul *= 1 + Math.sin(Math.PI * e) * 0.3;
        if (sphereFrac < 1 && p.rn > sphereFrac) aMul = 1 - e, a *= aMul;
      }

      a *= aGain;
      if (dark) a *= 1.25;
      if (a <= 0.014) continue;
      if (a > 1) a = 1;

      var db = depth < 0 ? 0 : (depth > 0.999 ? NB - 1 : (depth * NB) | 0);
      var ab = (a * NA) | 0; if (ab >= NA) ab = NA - 1;
      var sb = p.rn < 0.34 ? 0 : (p.rn < 0.72 ? 1 : 2);
      var key = (db * NS + sb) * NA + ab;
      var pt = paths[key] || (paths[key] = new Path2D());
      var sz = (0.6 + p.rn * 1.05) * (0.5 + depth * 0.7) * (S / 360) * szMul * dotSize * szSoft;
      /* arc() throws on a negative or NaN radius, and one throw kills the whole frame */
      if (!(sz > 0.04)) continue;
      if (sz > 7) sz = 7;
      /* round dots; sub-pixel specks stay square (visually identical, much cheaper) */
      if (sz < 0.95) { pt.rect(px - sz, py - sz, sz * 2, sz * 2); }
      else { pt.moveTo(px + sz, py); pt.arc(px, py, sz, 0, 6.2831853); }
    }

    var bs = tint || [52, 97, 242];
    var sp = 1 - sof * 0.92;
    var paper = dark ? [58, 60, 74] : [249, 247, 244];
    function lift(c, ix, f) { var v = c + (paper[ix] - c) * sof * 0.62 * f; return v < 0 ? 0 : (v > 255 ? 255 : v); }
    var SH = pal ? [
      [lift(pal[0][0], 0, 0.8), lift(pal[0][1], 1, 0.8), lift(pal[0][2], 2, 0.8)],
      [lift(pal[1][0], 0, 1), lift(pal[1][1], 1, 1), lift(pal[1][2], 2, 1)],
      [lift(pal[2][0], 0, 1.15), lift(pal[2][1], 1, 1.15), lift(pal[2][2], 2, 1.15)]
    ] : [
      [lift(bs[0] * (1 - 0.48 * sp), 0, 0.8), lift(bs[1] * (1 - 0.5 * sp), 1, 0.8), lift(bs[2] * (1 - 0.38 * sp), 2, 0.8)],
      [lift(bs[0], 0, 1), lift(bs[1], 1, 1), lift(bs[2], 2, 1)],
      [lift(bs[0] + (255 - bs[0]) * 0.46 * sp, 0, 1.15), lift(bs[1] + (255 - bs[1]) * 0.42 * sp, 1, 1.15), lift(bs[2] + (255 - bs[2]) * 0.3 * sp, 2, 1.15)]
    ];
    if (whiten) for (var wi = 0; wi < 3; wi++) for (var wj = 0; wj < 3; wj++) SH[wi][wj] += (255 - SH[wi][wj]) * whiten;

    for (var dbi = 0; dbi < NB; dbi++) {
      var dpth = (dbi + 0.5) / NB, f2 = 0.46 + dpth * 0.72;
      for (var sbi = 0; sbi < NS; sbi++) {
        var s3 = SH[sbi];
        var cr = s3[0] * f2, cg = s3[1] * f2, cb = s3[2] * f2;
        if (cr > 255) cr = 255; if (cg > 255) cg = 255; if (cb > 255) cb = 255;
        if (!sat) { var l = cr * 0.3 + cg * 0.5 + cb * 0.2; cr = cg = cb = l; }
        if (dark) { cr = Math.min(255, cr + 62); cg = Math.min(255, cg + 54); cb = Math.min(255, cb + 36); }
        var head = 'rgba(' + (cr | 0) + ',' + (cg | 0) + ',' + (cb | 0) + ',';
        for (var abi = 0; abi < NA; abi++) {
          var pth = paths[(dbi * NS + sbi) * NA + abi];
          if (!pth) continue;
          ctx.fillStyle = head + ((abi + 0.6) / NA).toFixed(3) + ')';
          ctx.fill(pth);
        }
      }
    }
  }

  var entries = [], raf = 0, prev = 0, last = 0, guard = 0, named = null;

  function frame(t) {
    last = performance.now();
    if (t - prev < 26) return;
    prev = t;
    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      if (!e.el.isConnected) { entries.splice(i, 1); continue; }
      var r = e.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight || !r.width) continue;
      var t0 = performance.now();
      try { paint(e, t); } catch (err) {}
      /* Adaptive quality: heavy canvases (full-viewport fields) trade count for
         frame time, so a slow machine degrades density instead of smoothness. */
      if (e.adaptive) {
        var ms = performance.now() - t0;
        e.ema = e.ema == null ? ms : e.ema + (ms - e.ema) * 0.12;
        if (e.q == null) e.q = 1;
        if (e.ema > 15 && e.q > 0.3) e.q = Math.max(0.3, e.q - 0.07);
        else if (e.ema < 9 && e.q < 1) e.q = Math.min(1, e.q + 0.015);
      }
    }
  }

  function pump(t) { raf = requestAnimationFrame(pump); frame(t); }

  function start() {
    if (!raf) raf = requestAnimationFrame(pump);
    /* Revive a genuinely dead pump (tab was hidden, or a mount happened while
       hidden). It NEVER paints from the timer: painting here would stack a
       synchronous frame on top of a slow rAF frame and saturate the main thread. */
    if (!guard) guard = setInterval(function () {
      if (performance.now() - last > 1400 && document.visibilityState !== 'hidden') {
        raf = requestAnimationFrame(pump);
      }
    }, 1200);
    if (!start._vis) {
      start._vis = 1;
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'hidden') raf = requestAnimationFrame(pump);
      });
    }
  }

  window.AtlasSphere = {
    PRESET: PRESET,
    STATES: STATES,
    mount: function (el, opts, cfg) {
      if (!el) return;
      if (el.__atlasSphere) { el.__atlasSphere.opts = opts || {}; return el.__atlasSphere; }
      var entry = { el: el, ctx: el.getContext('2d'), opts: opts || {}, adaptive: !!(cfg && cfg.adaptive), q: 1 };
      el.__atlasSphere = entry;
      entries.push(entry);
      /* Name exactly ONE sphere per document `atlas-orb`, so cross-document view
         transitions morph it between views. A duplicate name aborts the whole
         transition (spec), so this is claimed by the first mount and only handed
         on if that canvas leaves the DOM — which also means every view that mounts
         a sphere gets the morph for free, with no per-view markup. */
      if (!(cfg && cfg.noName) && (!named || !document.contains(named))) {
        if (named) named.style.viewTransitionName = '';
        named = el;
        el.style.viewTransitionName = 'atlas-orb';
      }
      start();
      return entry;
    },
    unmount: function (el) {
      if (!el || !el.__atlasSphere) return;
      if (named === el) { el.style.viewTransitionName = ''; named = null; }
      var i = entries.indexOf(el.__atlasSphere);
      if (i >= 0) entries.splice(i, 1);
      el.__atlasSphere = null;
    }
  };
})();
