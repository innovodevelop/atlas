/* Atlas device geometry — one renderer shared by the app and the model lab. */
(function () {
  var BBOX = {};
  function measure(model, v, dark) {
    var key = model;
    if (BBOX[key]) return BBOX[key];
    var PROBE = 420, s0 = 90;
    var cv = document.createElement('canvas'); cv.width = PROBE; cv.height = PROBE;
    var c2 = cv.getContext('2d');
    paint(c2, PROBE, PROBE, s0, PROBE/2, PROBE/2, { model: model, value: v, dark: dark, t: 0, silhouette: true });
    var d = c2.getImageData(0, 0, PROBE, PROBE).data;
    var minX = PROBE, maxX = -1, minY = PROBE, maxY = -1;
    for (var y = 0; y < PROBE; y++) {
      for (var x = 0; x < PROBE; x++) {
        if (d[(y*PROBE + x)*4 + 3] > 14) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
    }
    if (maxX < 0) { BBOX[key] = { w: 2, h: 2, cx: 0, cy: 0 }; return BBOX[key]; }
    BBOX[key] = { w: (maxX - minX + 1)/s0, h: (maxY - minY + 1)/s0, cx: ((minX + maxX)/2 - PROBE/2)/s0, cy: ((minY + maxY)/2 - PROBE/2)/s0 };
    return BBOX[key];
  }
  function hexRGB(h) { if (typeof h !== 'string') return [200,200,200]; if (h.indexOf('rgb') === 0) { var mm = h.match(/[\d.]+/g) || []; return [+mm[0]||0, +mm[1]||0, +mm[2]||0]; } var q = h.replace('#',''); var r = parseInt(q.slice(0,2),16), g = parseInt(q.slice(2,4),16), b = parseInt(q.slice(4,6),16); return [isNaN(r)?200:r, isNaN(g)?200:g, isNaN(b)?200:b]; }
  function texturePass(ctx, W, H, opts) {
    var tex = opts.tex || 'matte', dark = !!opts.dark;
    var q = opts.q || {};
    var amt = (q.detail == null ? 58 : q.detail)/100;
    var grain = (q.grain == null ? 38 : q.grain)/100;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    if (tex === 'brushed' || tex === 'alu') {
      var lines = Math.round(60 + amt*260);
      for (var i = 0; i < lines; i++) {
        var y = (i/lines)*H, n = Math.abs(Math.sin(i*12.9898)*43758.5453 % 1);
        ctx.strokeStyle = 'rgba(' + (n > 0.5 ? '255,255,255,' : '0,0,0,') + (0.02 + n*0.06*(0.4 + amt)).toFixed(3) + ')';
        ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y + (n - 0.5)*2); ctx.stroke();
      }
    } else if (tex === 'fabric') {
      var step = Math.max(2, Math.round(9 - amt*5));
      for (var y2 = 0; y2 < H; y2 += step) for (var x2 = 0; x2 < W; x2 += step) {
        var v2 = (Math.sin(x2*0.7) * Math.cos(y2*0.7) + 1)/2;
        ctx.fillStyle = 'rgba(' + (v2 > 0.5 ? '255,255,255,' : '0,0,0,') + (0.05 + v2*0.09).toFixed(3) + ')';
        ctx.fillRect(x2, y2, step - 1, step - 1);
      }
    } else if (tex === 'glass') {
      var gg = ctx.createLinearGradient(0, 0, W, H);
      gg.addColorStop(0, 'rgba(255,255,255,.22)'); gg.addColorStop(0.42, 'rgba(255,255,255,0)');
      gg.addColorStop(0.62, 'rgba(255,255,255,.12)'); gg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gg; ctx.fillRect(0, 0, W, H);
    } else {
      var dots = Math.round(900 + amt*4200);
      for (var i2 = 0; i2 < dots; i2++) {
        var rx = Math.abs(Math.sin(i2*91.7)*43758.5453 % 1)*W, ry = Math.abs(Math.cos(i2*53.3)*43758.5453 % 1)*H;
        var nn = Math.abs(Math.sin(i2*7.13)*43758.5453 % 1);
        ctx.fillStyle = (nn > 0.5 ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + (0.03 + nn*0.07*grain).toFixed(3) + ')';
        ctx.fillRect(rx, ry, 1.2, 1.2);
      }
    }
    if (dark) { ctx.fillStyle = 'rgba(0,0,0,.06)'; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
  }
  function draw(ctx, W, H, opts) {
    opts = opts || {};
    ctx.clearRect(0, 0, W, H);
    var bb = measure(opts.model, opts.value, !!opts.dark);
    var s = Math.min((W*0.88)/bb.w, (H*0.88)/bb.h)*(opts.scale || 1);
    var ox = W/2 - bb.cx*s, oy = H/2 - bb.cy*s;
    paint(ctx, W, H, s, ox, oy, opts);
    texturePass(ctx, W, H, opts);
  }
  function paint(ctx, W, H, s, ox, oy, opts) {
    opts = opts || {};
    var dark = !!opts.dark, model = opts.model, v = opts.value, t = opts.t || 0;
    var sil = !!opts.silhouette;
    const on = v > 0 && !sil;
    const T = t*0.001;
    const P = (x, y, z) => [ox + (x - z)*0.87*s, oy + (x + z)*0.48*s - y*s];
    const lvl0 = 0;
    const SURF = dark
      ? { top:'#5c5a66', l:'#3c3a45', r:'#2b2a33', metal:'#6d6b78', dark:'#232228', glass:'#3a3944', line:'rgba(247,245,242,.14)' }
      : { top:'#fbfaf8', l:'#e6e2db', r:'#d2cdc4', metal:'#c9c4bb', dark:'#37353c', glass:'#e9e6e0', line:'rgba(30,30,36,.1)' };
    const shade = (hex, f2) => { const q = hex.replace('#',''); const c = [parseInt(q.slice(0,2),16), parseInt(q.slice(2,4),16), parseInt(q.slice(4,6),16)].map(v => Math.max(0, Math.min(255, Math.round(f2 > 1 ? v + (255 - v)*(f2 - 1) : v*f2)))); return 'rgb(' + c.join(',') + ')'; };
    const facePaint = (pts, fill, lit) => {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      pts.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
      if (fill.charAt(0) !== '#') return fill;
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      var spread2 = 0.06 + (1 - qn('rough', 42))*0.3 + qn('metal', 18)*0.34;
      g.addColorStop(0, shade(fill, 1 + spread2*(lit ? 1.1 : 0.7)));
      g.addColorStop(0.55, fill);
      g.addColorStop(1, shade(fill, 1 - spread2*(lit ? 0.5 : 0.9)));
      return g;
    };
    const poly = (pts, fill, lit) => {
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
      ctx.fillStyle = facePaint(pts, fill, lit); ctx.fill();
      ctx.strokeStyle = dark ? 'rgba(0,0,0,.28)' : 'rgba(30,30,36,.07)'; ctx.lineWidth = Math.max(0.6, s*0.008); ctx.stroke();
    };
    const box = (x, y, z, w, h, dp, cTop, cL, cR) => {
      const a = P(x, y + h, z), b = P(x + w, y + h, z), c = P(x + w, y + h, z + dp), e = P(x, y + h, z + dp);
      const a2 = P(x, y, z), b2 = P(x + w, y, z), c2 = P(x + w, y, z + dp);
      poly([a, b, c, e], cTop || SURF.top, true);
      poly([b, c, c2, b2], cR || SURF.r);
      poly([a, b, b2, a2], cL || SURF.l);
      const bw = Math.max(0.8, s*0.016);
      ctx.strokeStyle = 'rgba(255,255,255,' + ((dark ? 0.18 : 0.5)*(0.2 + qn('bevel', 34)*2.2)).toFixed(3) + ')'; ctx.lineWidth = bw*(0.4 + qn('bevel', 34)*1.6);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(30,30,36,' + (dark ? 0.4 : 0.13) + ')'; ctx.lineWidth = bw*0.8;
      ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(b2[0], b2[1]); ctx.moveTo(c[0], c[1]); ctx.lineTo(c2[0], c2[1]); ctx.stroke();
      const seams = Math.max(1, Math.round(qn('seams', 40)*18));
      ctx.strokeStyle = 'rgba(30,30,36,' + (dark ? 0.22 : 0.055) + ')'; ctx.lineWidth = 0.7;
      for (let i = 1; i < seams; i++) {
        const yy = y + h*i/seams, l0 = P(x, yy, z), l1 = P(x + w, yy, z), l2 = P(x + w, yy, z + dp);
        ctx.beginPath(); ctx.moveTo(l0[0], l0[1]); ctx.lineTo(l1[0], l1[1]); ctx.lineTo(l2[0], l2[1]); ctx.stroke();
      }
      const gA = ctx.createLinearGradient(a[0], a[1], b2[0], b2[1]);
      gA.addColorStop(0, 'rgba(255,255,255,' + (dark ? 0.06 : 0.16) + ')'); gA.addColorStop(1, 'rgba(0,0,0,' + (dark ? 0.22 : 0.07) + ')');
      ctx.fillStyle = gA; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(a2[0], a2[1]); ctx.closePath(); ctx.fill();
    };
    const cyl = (x, y, z, r, h, cTop, cBody) => {
      const c0 = P(x, y, z), c1 = P(x, y + h, z), rx = r*0.87*s, ry = r*0.48*s;
      const bodyCol = cBody || SURF.l;
      let bg = bodyCol;
      if (bodyCol.charAt(0) === '#') {
        bg = ctx.createLinearGradient(c0[0] - rx, 0, c0[0] + rx, 0);
        bg.addColorStop(0, shade(bodyCol, 0.78));
        bg.addColorStop(0.28, shade(bodyCol, 1.08));
        bg.addColorStop(0.62, bodyCol);
        bg.addColorStop(1, shade(bodyCol, 0.72));
      }
      var N = Math.max(5, Math.round(5 + (opts.q && opts.q.polys != null ? opts.q.polys : 62)/100*43));
      var baseRGB = hexRGB(bodyCol);
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.moveTo(c0[0] - rx, c0[1]); ctx.lineTo(c1[0] - rx, c1[1]);
      ctx.ellipse(c1[0], c1[1], rx, ry, 0, Math.PI, 0, true); ctx.lineTo(c0[0] + rx, c0[1]);
      ctx.ellipse(c0[0], c0[1], rx, ry, 0, 0, Math.PI, false); ctx.closePath(); ctx.fill();
      for (var fi = 0; fi < N; fi++) {
        var aa = Math.PI + fi/N*Math.PI, ab = Math.PI + (fi + 1)/N*Math.PI;
        var xA = c0[0] + Math.cos(aa)*rx, xB = c0[0] + Math.cos(ab)*rx;
        var yA = c0[1] + Math.sin(aa)*ry, yB = c0[1] + Math.sin(ab)*ry;
        var nrm = Math.cos((aa + ab)/2);
        var f2 = 0.6 + Math.max(0, nrm)*0.62 + Math.max(0, -nrm)*0.05;
        ctx.fillStyle = 'rgb(' + Math.min(255, baseRGB[0]*f2 | 0) + ',' + Math.min(255, baseRGB[1]*f2 | 0) + ',' + Math.min(255, baseRGB[2]*f2 | 0) + ')';
        var dyTop = c0[1] - c1[1];
        ctx.beginPath(); ctx.moveTo(xA, yA);
        ctx.ellipse(c0[0], c0[1], rx, ry, 0, aa, ab, false);
        ctx.lineTo(xB, yB - dyTop);
        ctx.ellipse(c1[0], c1[1], rx, ry, 0, ab, aa, true);
        ctx.closePath(); ctx.fill();
        if (N < 22) { ctx.strokeStyle = 'rgba(30,30,36,.16)'; ctx.lineWidth = 0.8; ctx.stroke(); }
      }
      const topCol = cTop || SURF.top;
      let tg = topCol;
      if (topCol.charAt(0) === '#') {
        tg = ctx.createRadialGradient(c1[0] - rx*0.35, c1[1] - ry*0.4, 0, c1[0], c1[1], rx*1.2);
        tg.addColorStop(0, shade(topCol, 1.12));
        tg.addColorStop(1, shade(topCol, 0.9));
      }
      ctx.fillStyle = tg;
      ctx.beginPath();
      for (var ci = 0; ci <= N*2; ci++) { var ca = ci/(N*2)*6.2832, px2 = c1[0] + Math.cos(ca)*rx, py2 = c1[1] + Math.sin(ca)*ry; ci ? ctx.lineTo(px2, py2) : ctx.moveTo(px2, py2); }
      ctx.closePath(); ctx.fill();
      if (N < 22) { ctx.strokeStyle = 'rgba(30,30,36,.2)'; ctx.lineWidth = 0.8; ctx.stroke(); }
      ctx.strokeStyle = dark ? 'rgba(0,0,0,.3)' : 'rgba(30,30,36,.08)'; ctx.lineWidth = Math.max(0.6, s*0.008); ctx.stroke();
      const facets = Math.max(8, Math.round(10 + qn('polys', 62)*90));
      for (let i = 0; i < facets; i++) {
        const a0 = Math.PI + i/facets*Math.PI, a1 = Math.PI + (i + 1)/facets*Math.PI;
        const nx = Math.cos((a0 + a1)/2), lit = Math.max(0, 0.3 + nx*0.8);
        const x0 = c0[0] + Math.cos(a0)*rx, x1 = c0[0] + Math.cos(a1)*rx;
        ctx.fillStyle = 'rgba(255,255,255,' + (lit*lit*0.06).toFixed(3) + ')';
        ctx.fillRect(Math.min(x0, x1) - 0.3, c1[1], Math.abs(x1 - x0) + 0.8, c0[1] - c1[1]);
      }
      ctx.strokeStyle = 'rgba(30,30,36,' + (dark ? 0.16 : 0.045) + ')'; ctx.lineWidth = 0.7;
      const cRings = Math.max(2, Math.round(qn('seams', 40)*40));
      for (let i = 1; i < cRings; i++) { const yy = c1[1] + (c0[1] - c1[1])*i/cRings; ctx.beginPath(); ctx.ellipse(c0[0], yy, rx, ry, 0, 0.14, Math.PI - 0.14); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(255,255,255,' + (dark ? 0.18 : 0.42) + ')'; ctx.lineWidth = Math.max(1, s*0.014);
      ctx.beginPath(); ctx.moveTo(c0[0] - rx*0.62, c0[1] - ry*0.2); ctx.lineTo(c1[0] - rx*0.62, c1[1] + ry*0.2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,' + (dark ? 0.1 : 0.22) + ')'; ctx.lineWidth = Math.max(0.8, s*0.007);
      ctx.beginPath(); ctx.moveTo(c0[0] + rx*0.72, c0[1] - ry*0.25); ctx.lineTo(c1[0] + rx*0.72, c1[1] + ry*0.25); ctx.stroke();
    };
    const dome = (x, y, z, r, col, flip) => {
      const c = P(x, y, z), rx = r*0.87*s, ry = r*0.62*s;
      const g = ctx.createRadialGradient(c[0] - rx*0.35, c[1] - ry*0.4, 0, c[0], c[1], rx*1.3);
      g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
      ctx.fillStyle = g; ctx.beginPath();
      ctx.ellipse(c[0], c[1], rx, ry, 0, flip ? 0 : Math.PI, flip ? Math.PI : 0); ctx.closePath(); ctx.fill();
    };
    const glow = (x, y, z, r, col, a) => {
      if (sil || a <= 0.01) return;
      const c = P(x, y, z), g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r*s);
      g.addColorStop(0, 'rgba(' + col + ',' + a + ')'); g.addColorStop(1, 'rgba(' + col + ',0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c[0], c[1], r*s, 0, 6.2832); ctx.fill();
    };
    const shadow = (x, z, r) => { const c = P(x, 0, z); const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], r*s); g.addColorStop(0, dark ? 'rgba(0,0,0,.5)' : 'rgba(120,112,100,.22)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(c[0], c[1], r*s, r*s*0.4, 0, 0, 6.2832); ctx.fill(); };
    var Q = opts.q || {};
    var qn = function (k, dflt) { return (Q[k] == null ? dflt : Q[k])/100; };
    if (opts.base && !dark) { SURF.top = shade(opts.base, 1.06); SURF.l = shade(opts.base, 0.93); SURF.r = shade(opts.base, 0.8); SURF.metal = shade(opts.base, 0.86); SURF.glass = shade(opts.base, 0.97); }
    if (opts.base && dark) { SURF.top = shade(opts.base, 0.48); SURF.l = shade(opts.base, 0.36); SURF.r = shade(opts.base, 0.28); SURF.metal = shade(opts.base, 0.52); }
    const lvl = Math.max(0, Math.min(1, (typeof v === 'number' ? v : 0)/100));
    const warm = '255,214,140';
    if (model === 'pendant') {
      ctx.strokeStyle = SURF.metal; ctx.lineWidth = Math.max(1, s*0.02);
      const a = P(0, 1.5, 0), b = P(0, 0.78, 0); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      glow(0, 0.5, 0, 1.1, warm, lvl*0.5);
      dome(0, 0.78, 0, 0.46, [SURF.top, SURF.r], false);
      dome(0, 0.5, 0, 0.3, ['rgba(255,236,190,' + (0.35 + lvl*0.65) + ')', 'rgba(255,206,120,' + (0.2 + lvl*0.5) + ')'], true);
    } else if (model === 'floorlamp') {
      cyl(0, 0, 0, 0.34, 0.06, SURF.metal, SURF.metal);
      ctx.strokeStyle = SURF.metal; ctx.lineWidth = Math.max(1.5, s*0.035);
      const a = P(0, 0.06, 0), b = P(0, 1.0, 0), c = P(0.55, 1.28, 0);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(b[0], b[1] - s*0.25, c[0], c[1]); ctx.stroke();
      glow(0.55, 1.0, 0, 1.0, warm, lvl*0.5);
      dome(0.55, 1.2, 0, 0.34, [SURF.top, SURF.r], false);
      dome(0.55, 1.02, 0, 0.24, ['rgba(255,238,196,' + (0.3 + lvl*0.7) + ')', 'rgba(255,208,124,' + (0.2 + lvl*0.5) + ')'], true);
    } else if (model === 'bulb') {
      glow(0, 0.62, 0, 1.1, warm, lvl*0.55);
      cyl(0, 0, 0, 0.16, 0.28, SURF.metal, SURF.metal);
      const c = P(0, 0.62, 0), r = 0.4*0.87*s;
      const g = ctx.createRadialGradient(c[0] - r*0.3, c[1] - r*0.3, 0, c[0], c[1], r*1.2);
      g.addColorStop(0, 'rgba(255,247,220,' + (0.5 + lvl*0.5) + ')'); g.addColorStop(1, lvl > 0.05 ? 'rgba(255,206,120,.85)' : SURF.glass);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, 6.2832); ctx.fill();
    } else if (model === 'strip') {
      const col = opts.col || '#ffb765';
      glow(0, 0.3, 0, 0.62, '255,180,90', lvl*0.55);
      box(-1.05, 0.24, -0.1, 2.1, 0.1, 0.2, SURF.top, SURF.l, SURF.r);
      const a = P(-1.05, 0.24, 0.1), b = P(1.05, 0.24, 0.1);
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, s*0.07); ctx.globalAlpha = 0.35 + lvl*0.65;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (model === 'speaker') {
      if (on) {
        const gr0 = P(0.34, 0.5, 0.34);
        ctx.save();
        for (let i = 0; i < 4; i++) {
          const ph = (T*0.55 + i*0.25) % 1;
          const rr = s*(0.3 + ph*0.85), a = (1 - ph)*(1 - ph)*0.55*(0.4 + lvl*0.6);
          ctx.strokeStyle = 'rgba(52,97,242,' + a.toFixed(3) + ')';
          ctx.lineWidth = Math.max(1, s*0.024*(1 - ph*0.5));
          ctx.beginPath(); ctx.arc(gr0[0], gr0[1], rr, 0, 6.2832); ctx.stroke();
        }
        ctx.restore();
      }
      cyl(0, 0, 0, 0.5, 0.95, SURF.top, SURF.l);
      const c = P(0.34, 0.5, 0.34);
      ctx.save();
      ctx.fillStyle = dark ? 'rgba(247,245,242,.1)' : 'rgba(30,30,36,.1)';
      ctx.beginPath(); ctx.ellipse(c[0], c[1], s*0.3, s*0.3, 0, 0, 6.2832); ctx.fill();
      ctx.clip();
      ctx.fillStyle = dark ? 'rgba(247,245,242,.16)' : 'rgba(30,30,36,.14)';
      const per = Math.max(3, Math.round(s*0.028));
      for (let gy = -Math.round(s*0.3); gy < s*0.3; gy += per) {
        for (let gx = -Math.round(s*0.3); gx < s*0.3; gx += per) {
          const off = (Math.round(gy/per) % 2) ? per/2 : 0;
          if (gx*gx + gy*gy > s*0.3*s*0.3) continue;
          ctx.beginPath(); ctx.arc(c[0] + gx + off, c[1] + gy, Math.max(0.5, per*0.22), 0, 6.2832); ctx.fill();
        }
      }
      ctx.restore();
      if (on) {
        const cone = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], s*0.34);
        cone.addColorStop(0, 'rgba(52,97,242,' + (0.14 + lvl*0.18).toFixed(3) + ')'); cone.addColorStop(1, 'rgba(52,97,242,0)');
        ctx.fillStyle = cone; ctx.beginPath(); ctx.arc(c[0], c[1], s*0.3, 0, 6.2832); ctx.fill();
      }
    } else if (model === 'tv') {
      box(-0.18, 0, -0.05, 0.36, 0.12, 0.3, SURF.metal, SURF.metal, SURF.dark);
      const a = P(-1.15, 0.12, 0), b = P(1.15, 0.12, 0), c = P(1.15, 1.4, 0), e = P(-1.15, 1.4, 0);
      poly([a, b, c, e], SURF.dark);
      const ins = 0.05;
      poly([P(-1.15 + ins, 0.12 + ins, -0.01), P(1.15 - ins, 0.12 + ins, -0.01), P(1.15 - ins, 1.4 - ins, -0.01), P(-1.15 + ins, 1.4 - ins, -0.01)], on ? 'rgba(120,160,255,.75)' : (dark ? '#191921' : '#26252c'));
    } else if (model === 'thermostat' || model === 'valve') {
      const r = model === 'valve' ? 0.34 : 0.52;
      cyl(0, 0, 0, r, model === 'valve' ? 0.5 : 0.3, SURF.top, SURF.l);
      const c = P(0, model === 'valve' ? 0.5 : 0.3, 0), rr = r*0.87*s*0.72;
      ctx.fillStyle = dark ? '#26252d' : '#f4f1ec'; ctx.beginPath(); ctx.ellipse(c[0], c[1], rr, rr*0.55, 0, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = '#c2661a'; ctx.lineWidth = Math.max(2, s*0.06); ctx.lineCap = 'round';
      const ang = -2.4 + (Math.max(0, Math.min(1, ((typeof v === 'number' ? v : 20) - 12)/16)))*4.8;
      ctx.beginPath(); ctx.ellipse(c[0], c[1], rr*0.78, rr*0.44, 0, -2.4, ang); ctx.stroke();
    } else if (model === 'purifier') {
      cyl(0, 0, 0, 0.46, 1.1, SURF.top, SURF.l);
      const c = P(0, 1.1, 0);
      ctx.strokeStyle = on ? '#3461f2' : SURF.line; ctx.lineWidth = Math.max(1, s*0.03);
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.ellipse(c[0], c[1], s*0.1 + i*s*0.1, s*0.055 + i*s*0.055, 0, 0, 6.2832); ctx.stroke(); }
    } else if (model === 'camera') {
      box(-0.3, 0, -0.2, 0.6, 0.16, 0.4, SURF.top, SURF.l, SURF.r);
      cyl(0, 0.16, 0, 0.34, 0.5, SURF.top, SURF.l);
      const c = P(0.28, 0.42, 0); ctx.fillStyle = SURF.dark; ctx.beginPath(); ctx.ellipse(c[0], c[1], s*0.16, s*0.16, 0, 0, 6.2832); ctx.fill();
      if (on) { ctx.fillStyle = '#d0453a'; ctx.beginPath(); ctx.arc(c[0] + s*0.2, c[1] - s*0.18, s*0.045, 0, 6.2832); ctx.fill(); }
    } else if (model === 'doorbell') {
      box(-0.22, 0, -0.12, 0.44, 0.9, 0.24, SURF.top, SURF.l, SURF.r);
      const c = P(0, 0.6, 0.12); ctx.fillStyle = SURF.dark; ctx.beginPath(); ctx.arc(c[0], c[1], s*0.11, 0, 6.2832); ctx.fill();
      const b = P(0, 0.24, 0.12); ctx.fillStyle = on ? '#3461f2' : SURF.metal; ctx.beginPath(); ctx.arc(b[0], b[1], s*0.09, 0, 6.2832); ctx.fill();
    } else if (model === 'lock') {
      box(-0.34, 0, -0.16, 0.68, 1.0, 0.32, SURF.top, SURF.l, SURF.r);
      const c = P(0, 0.56, 0.16), rr = s*0.2;
      ctx.strokeStyle = on ? '#0fae76' : '#c2661a'; ctx.lineWidth = Math.max(2, s*0.07);
      ctx.beginPath(); ctx.arc(c[0], c[1] - rr*0.2, rr, Math.PI, on ? 0 : -0.4); ctx.stroke();
      ctx.fillStyle = SURF.metal; ctx.fillRect(c[0] - rr*0.9, c[1], rr*1.8, rr*1.1);
    } else if (model === 'garage') {
      const open = !on;
      box(-1.0, 0, -0.1, 2.0, 1.3, 0.2, SURF.metal, SURF.l, SURF.r);
      const h = open ? 0.3 : 1.15;
      poly([P(-0.85, 0.05, 0.11), P(0.85, 0.05, 0.11), P(0.85, h, 0.11), P(-0.85, h, 0.11)], dark ? '#2c2b33' : '#ece8e1');
      ctx.strokeStyle = SURF.line; ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) { const y = 0.05 + (h - 0.05)*i/4; const a = P(-0.85, y, 0.11), b = P(0.85, y, 0.11); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    } else if (model === 'blind' || model === 'curtain') {
      box(-1.0, 1.35, -0.06, 2.0, 0.12, 0.12, SURF.metal, SURF.metal, SURF.dark);
      const drop = 1.28*(1 - lvl);
      if (model === 'blind') {
        for (let i = 0; i < 9; i++) { const y = 1.35 - (i + 1)*(drop/9); if (y < 0.07) break; poly([P(-0.95, y, 0), P(0.95, y, 0), P(0.95, y - drop/11, 0), P(-0.95, y - drop/11, 0)], i % 2 ? SURF.l : SURF.top); }
      } else {
        [-1, 1].forEach(sd => { const w = 0.42 + 0.5*(1 - lvl); poly([P(sd*0.95, 1.35, 0), P(sd*(0.95 - w), 1.35, 0), P(sd*(0.95 - w), 1.35 - 1.28, 0), P(sd*0.95, 1.35 - 1.28, 0)], sd < 0 ? SURF.top : SURF.l); });
      }
    } else if (model === 'vacuum') {
      cyl(0, 0, 0, 0.62, 0.22, SURF.top, SURF.l);
      const c = P(0, 0.22, 0);
      ctx.fillStyle = SURF.dark; ctx.beginPath(); ctx.ellipse(c[0] - s*0.22, c[1] - s*0.04, s*0.1, s*0.06, 0, 0, 6.2832); ctx.fill();
      if (on) { ctx.strokeStyle = 'rgba(52,97,242,.55)'; ctx.lineWidth = Math.max(1, s*0.03); const a = (T*2) % 6.2832; ctx.beginPath(); ctx.ellipse(c[0], c[1], s*0.44, s*0.24, 0, a, a + 2.2); ctx.stroke(); }
    } else if (model === 'washer' || model === 'fridge' || model === 'heater') {
      const hh = model === 'fridge' ? 1.5 : 1.15;
      box(-0.62, 0, -0.36, 1.24, hh, 0.72, SURF.top, SURF.l, SURF.r);
      if (model === 'washer') {
        const c = P(0, hh*0.52, 0.36); ctx.fillStyle = SURF.metal; ctx.beginPath(); ctx.ellipse(c[0], c[1], s*0.26, s*0.26, 0, 0, 6.2832); ctx.fill();
        ctx.fillStyle = on ? 'rgba(52,97,242,.35)' : SURF.glass; ctx.beginPath(); ctx.ellipse(c[0], c[1], s*0.19, s*0.19, 0, 0, 6.2832); ctx.fill();
      } else if (model === 'fridge') {
        const a = P(-0.62, hh*0.62, 0.36), b = P(0.62, hh*0.62, 0.36);
        ctx.strokeStyle = SURF.line; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        const h1 = P(0.42, hh*0.5, 0.36), h2 = P(0.42, hh*0.78, 0.36);
        ctx.strokeStyle = SURF.metal; ctx.lineWidth = Math.max(2, s*0.05);
        ctx.beginPath(); ctx.moveTo(h1[0], h1[1]); ctx.lineTo(h1[0], h1[1] - s*0.3); ctx.moveTo(h2[0], h2[1]); ctx.lineTo(h2[0], h2[1] - s*0.3); ctx.stroke();
      } else {
        const c = P(0, hh*0.62, 0.36); ctx.fillStyle = on ? 'rgba(194,102,26,.5)' : SURF.glass; ctx.beginPath(); ctx.ellipse(c[0], c[1], s*0.16, s*0.16, 0, 0, 6.2832); ctx.fill();
      }
    } else if (model === 'plug' || model === 'kettle' || model === 'router' || model === 'sensor' || model === 'smoke' || model === 'ev' || model === 'solar' || model === 'sprinkler') {
      if (model === 'kettle') {
        cyl(0, 0, 0, 0.4, 0.16, SURF.metal, SURF.metal);
        cyl(0, 0.16, 0, 0.44, 0.8, SURF.top, SURF.l);
        ctx.strokeStyle = SURF.dark; ctx.lineWidth = Math.max(2, s*0.05);
        const h1 = P(0.44, 0.4, 0), h2 = P(0.78, 0.72, 0), h3 = P(0.44, 0.92, 0);
        ctx.beginPath(); ctx.moveTo(h1[0], h1[1]); ctx.quadraticCurveTo(h2[0], h2[1], h3[0], h3[1]); ctx.stroke();
        if (on) glow(0, 0.6, 0, 0.9, '255,150,80', 0.35);
      } else if (model === 'router') {
        box(-0.6, 0, -0.34, 1.2, 0.2, 0.68, SURF.top, SURF.l, SURF.r);
        [-0.4, 0.4].forEach(x => { const a = P(x, 0.2, -0.2), b = P(x + 0.1, 1.0, -0.2); ctx.strokeStyle = SURF.dark; ctx.lineWidth = Math.max(2, s*0.05); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); });
        const c = P(-0.4, 0.2, 0.34); ctx.fillStyle = '#0fae76'; ctx.beginPath(); ctx.arc(c[0], c[1] - s*0.06, s*0.04, 0, 6.2832); ctx.fill();
      } else if (model === 'ev') {
        box(-0.34, 0, -0.18, 0.68, 1.3, 0.36, SURF.top, SURF.l, SURF.r);
        const c = P(0, 0.86, 0.18); ctx.fillStyle = dark ? '#23222a' : '#2f2e35'; ctx.beginPath(); ctx.roundRect(c[0] - s*0.2, c[1] - s*0.22, s*0.4, s*0.34, s*0.06); ctx.fill();
        ctx.fillStyle = '#0fae76'; ctx.beginPath(); ctx.roundRect(c[0] - s*0.16, c[1] + s*0.14 - s*0.06, s*0.32*lvl, s*0.05, s*0.02); ctx.fill();
        ctx.strokeStyle = SURF.dark; ctx.lineWidth = Math.max(2, s*0.05);
        const p1 = P(0.34, 0.5, 0.18), p2 = P(0.9, 0.1, 0.18);
        ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.quadraticCurveTo(p1[0] + s*0.4, p1[1] + s*0.3, p2[0], p2[1]); ctx.stroke();
      } else if (model === 'solar') {
        poly([P(-1.0, 0.3, -0.5), P(1.0, 0.3, -0.5), P(0.8, 0.62, 0.5), P(-1.2, 0.62, 0.5)], on ? (dark ? '#2c3d63' : '#3f5a8f') : SURF.l);
        ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) { const a = P(-1.0 + i*0.5, 0.3, -0.5), b = P(-1.2 + i*0.5, 0.62, 0.5); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
        cyl(0, 0, 0, 0.12, 0.3, SURF.metal, SURF.metal);
      } else if (model === 'sprinkler') {
        cyl(0, 0, 0, 0.3, 0.16, SURF.top, SURF.l);
        cyl(0, 0.16, 0, 0.1, 0.5, SURF.metal, SURF.metal);
        if (on) { ctx.strokeStyle = 'rgba(90,150,240,.6)'; ctx.lineWidth = Math.max(1, s*0.025); for (let i = 0; i < 5; i++) { const a = P(0, 0.66, 0), ang = -0.9 - i*0.28; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(a[0] + Math.cos(ang)*s*0.5, a[1] + Math.sin(ang)*s*0.5, a[0] + Math.cos(ang)*s*0.95, a[1] + s*0.2); ctx.stroke(); } }
      } else if (model === 'smoke') {
        cyl(0, 0.9, 0, 0.5, 0.16, SURF.top, SURF.l);
        const c = P(0, 0.9, 0); ctx.fillStyle = on ? '#0fae76' : '#c2483d'; ctx.beginPath(); ctx.arc(c[0], c[1] + s*0.06, s*0.045, 0, 6.2832); ctx.fill();
      } else if (model === 'sensor') {
        cyl(0, 0, 0, 0.34, 0.34, SURF.top, SURF.l);
        const c = P(0, 0.34, 0); ctx.fillStyle = on ? '#0fae76' : SURF.metal; ctx.beginPath(); ctx.ellipse(c[0], c[1], s*0.08, s*0.05, 0, 0, 6.2832); ctx.fill();
      } else {
        box(-0.3, 0, -0.18, 0.6, 0.66, 0.36, SURF.top, SURF.l, SURF.r);
        const c = P(0, 0.34, 0.18); ctx.fillStyle = SURF.dark; ctx.beginPath(); ctx.arc(c[0] - s*0.08, c[1], s*0.035, 0, 6.2832); ctx.arc(c[0] + s*0.08, c[1], s*0.035, 0, 6.2832); ctx.fill();
        const lamp = P(0, 0.58, 0.18); ctx.fillStyle = on ? '#0fae76' : SURF.metal; ctx.beginPath(); ctx.arc(lamp[0], lamp[1], s*0.04, 0, 6.2832); ctx.fill();
      }
    } else {
      box(-0.42, 0, -0.26, 0.84, 0.9, 0.52, SURF.top, SURF.l, SURF.r);
      const c = P(0, 0.62, 0.26); ctx.fillStyle = SURF.dark; ctx.beginPath(); ctx.arc(c[0], c[1], s*0.06, 0, 6.2832); ctx.fill();
    }

  }
  window.AtlasModels = { draw: draw };
})();
