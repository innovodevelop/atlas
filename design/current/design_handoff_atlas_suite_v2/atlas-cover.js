/* Atlas cover art — the bridge between a song and the Sphere.

   make(seed, tone)  → 512² abstract sleeve as a data URL. Stands in until real
                       Spotify / Apple artwork is dropped on a slot.
   read(imgOrCanvas) → { deep, mid, light } RGB triples sampled from the pixels,
                       so ANY artwork (generated or dropped) drives the palette.
   Everything downstream — background wash, particles, scrims, controls — reads
   from that trio, so the player is coloured by the song, never hardcoded. */
(function () {
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lum(c) { return (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255; }
  function toward(c, t, k) { return [c[0] + (t[0] - c[0]) * k, c[1] + (t[1] - c[1]) * k, c[2] + (t[2] - c[2]) * k]; }
  function hex(c) { return '#' + [0, 1, 2].map(function (i) { var v = clamp(Math.round(c[i]), 0, 255).toString(16); return v.length < 2 ? '0' + v : v; }).join(''); }
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }

  function rnd(seed) { var s = seed * 9301 + 49297; return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

  function make(seed, tone) {
    var N = 512, c = document.createElement('canvas'); c.width = c.height = N;
    var x = c.getContext('2d'), R = rnd(seed || 1);
    var deep = tone[0], mid = tone[1], light = tone[2];
    x.fillStyle = hex(deep); x.fillRect(0, 0, N, N);
    /* soft colour masses — blurred so the sleeve reads as light, not shapes */
    try { x.filter = 'blur(46px)'; } catch (e) {}
    var blobs = [
      [0.26, 0.22, 0.56, mid, 1], [0.76, 0.34, 0.5, light, 0.9],
      [0.5, 0.84, 0.62, mid, 0.8], [0.14, 0.7, 0.4, light, 0.55],
      [0.86, 0.86, 0.36, deep, 0.85]
    ];
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i], bx = (b[0] + (R() - 0.5) * 0.16) * N, by = (b[1] + (R() - 0.5) * 0.16) * N, br = b[2] * N * (0.8 + R() * 0.4);
      var g = x.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, rgba(b[3], b[4])); g.addColorStop(1, rgba(b[3], 0));
      x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, 6.2832); x.fill();
    }
    /* one hard-edged mark keeps it from reading as a pure gradient */
    x.filter = 'blur(2px)';
    var mx = (0.34 + R() * 0.3) * N, my = (0.3 + R() * 0.34) * N, mr = (0.2 + R() * 0.1) * N;
    var mg = x.createLinearGradient(mx - mr, my - mr, mx + mr, my + mr);
    mg.addColorStop(0, rgba(toward(light, [255, 255, 255], 0.5), 0.5));
    mg.addColorStop(1, rgba(light, 0.04));
    x.fillStyle = mg; x.beginPath(); x.arc(mx, my, mr, 0, 6.2832); x.fill();
    x.filter = 'none';
    /* sweep + grain */
    var sw = x.createLinearGradient(0, N, N, 0);
    sw.addColorStop(0, rgba(deep, 0.38)); sw.addColorStop(0.55, rgba(deep, 0)); sw.addColorStop(1, rgba(light, 0.16));
    x.fillStyle = sw; x.fillRect(0, 0, N, N);
    var im = x.getImageData(0, 0, N, N), d = im.data;
    for (var p = 0; p < d.length; p += 4) {
      var n = (R() - 0.5) * 15;
      d[p] = clamp(d[p] + n, 0, 255); d[p + 1] = clamp(d[p + 1] + n, 0, 255); d[p + 2] = clamp(d[p + 2] + n, 0, 255);
    }
    x.putImageData(im, 0, 0);
    return c.toDataURL('image/jpeg', 0.9);
  }

  function read(src, fallback) {
    try {
      var N = 40, c = document.createElement('canvas'); c.width = c.height = N;
      var x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(src, 0, 0, N, N);
      var d = x.getImageData(0, 0, N, N).data, box = {};
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2];
        var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        var sat = mx ? (mx - mn) / mx : 0, L = lum([r, g, b]);
        var wgt = 0.3 + sat * 1.7 + (L > 0.12 && L < 0.94 ? 0.45 : 0);
        var k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
        var e = box[k] || (box[k] = [0, 0, 0, 0]);
        e[0] += r * wgt; e[1] += g * wgt; e[2] += b * wgt; e[3] += wgt;
      }
      var list = [];
      for (var k2 in box) { var v = box[k2]; if (v[3] > 1.2) list.push([v[0] / v[3], v[1] / v[3], v[2] / v[3], v[3]]); }
      if (list.length < 2) throw 0;
      list.sort(function (a, b2) { return b2[3] - a[3]; });
      var top = list.slice(0, 7).sort(function (a, b2) { return lum(a) - lum(b2); });
      var deep = top[0].slice(0, 3), light = top[top.length - 1].slice(0, 3);
      var mid = top[Math.max(0, Math.min(top.length - 1, Math.round((top.length - 1) * 0.55)))].slice(0, 3);
      /* guarantee the three tones separate, whatever the artwork */
      if (lum(deep) > 0.2) deep = toward(deep, [10, 9, 14], (lum(deep) - 0.16) / Math.max(0.2, lum(deep)));
      if (lum(light) < 0.74) light = toward(light, [255, 252, 246], (0.78 - lum(light)) / 0.78);
      if (lum(mid) < 0.3) mid = toward(mid, light, 0.4); else if (lum(mid) > 0.66) mid = toward(mid, deep, 0.32);
      return { deep: deep, mid: mid, light: light };
    } catch (e) {
      return fallback || { deep: [24, 24, 30], mid: [52, 97, 242], light: [206, 219, 255] };
    }
  }

  window.AtlasCover = { make: make, read: read, hex: hex, lum: lum, toward: toward, rgba: rgba };
})();
