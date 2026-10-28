/* Atlas top bar: the dashboard's status bar on every screen. Self-mounting.
   Left: wordmark (→ Home), Atlas state, current screen. Right: devices, Bluetooth, Wi-Fi, battery (→ System Status). */
(function () {
  if (window.__atlasTopbar) return; window.__atlasTopbar = 1;
  const H = 64;
  const P = { head: 'M3 14v-2a9 9 0 0 1 18 0v2M21 15a2 2 0 0 1-2 2h-1v-5h3zM3 15a2 2 0 0 0 2 2h1v-5H3z', tab: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM10 18h4', phone: 'M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5zM11 18.5h2', watch: 'M9 6.5h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9.5 6.5 10 3h4l.5 3.5M9.5 17.5 10 21h4l.5-3.5', bt: 'M7 7l10 10-5 4V3l5 4L7 17', wifi: 'M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01' };
  const svg = (d, s, c) => '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="' + (c || 'currentColor') + '" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"></path></svg>';
  const STATE = { idle: ['Listening', '#0fae76'], listening: ['Listening', '#1696be'], thinking: ['Thinking', '#7854ff'], speaking: ['Speaking', '#3461f2'], working: ['Working', '#e07a1f'], success: ['Done', '#0fae76'], alert: ['Needs you', '#d0453a'], muted: ['Muted', '#b6b1aa'] };
  function lum(rgb) { const m = (rgb || '').match(/\d+(\.\d+)?/g); if (!m || (m[3] !== undefined && +m[3] === 0)) return null; return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255; }
  function boot() {
    const root = document.querySelector('[data-screen-label]'); if (!root) return setTimeout(boot, 120);
    if (document.querySelector('.atb')) return;
    let dark = false, n = root; while (n && n !== document.documentElement) { const L = lum(getComputedStyle(n).backgroundColor); if (L != null) { dark = L < 0.4; break; } n = n.parentElement; }
    const ink = dark ? '#f9f7f4' : '#1e1e24', sub = dark ? 'rgba(249,247,244,.78)' : '#6d6a67', pill = dark ? 'rgba(249,247,244,.08)' : '#f1eeea', card = dark ? 'rgba(249,247,244,.08)' : '#fffdfa', avBg = dark ? '#f9f7f4' : '#1e1e24', avFg = dark ? '#1e1e24' : '#f9f7f4';
    const label = (root.getAttribute('data-screen-label') || document.title || '').replace(/^Atlas\s*[·—-]?\s*/, '').replace(/\s*[·—].*$/, '').replace(/ Beta$/, '') || 'Atlas';
    const st = document.createElement('style');
    st.textContent = `.atb{position:fixed;left:0;right:0;top:0;z-index:55;height:${H}px;display:flex;align-items:center;gap:10px;padding:0 20px 0 28px;font-family:Geist,system-ui,sans-serif;color:${ink};pointer-events:none}
.atb>*{pointer-events:auto}.atb a{text-decoration:none;color:inherit}
.atb-w{font-family:'Hanken Grotesk',Geist,sans-serif;font-size:24px;font-weight:600;letter-spacing:-.05em;margin-right:14px}
.atb-p{height:40px;padding:0 16px;display:flex;align-items:center;gap:9px;border-radius:9999px;background:${pill};font-size:14px;font-weight:500;color:${sub};white-space:nowrap}
.atb-p i{width:8px;height:8px;border-radius:50%;transition:background .3s}
.atb-s{height:40px;padding:0 16px;display:flex;align-items:center;border-radius:9999px;background:${avBg};color:${avFg};font-size:14px;font-weight:600;white-space:nowrap}
.atb-r{margin-left:auto;height:52px;padding:0 18px 0 6px;display:flex;align-items:center;gap:22px;border-radius:9999px;background:${card};box-shadow:${dark ? 'none' : '0 10px 28px -22px rgba(30,30,36,.35)'};font-size:14px;font-weight:500;color:${ink}}
.atb-r:hover{background:${dark ? 'rgba(249,247,244,.12)' : '#fdfbf7'}}
.atb-av{display:flex}.atb-av span{width:34px;height:34px;margin-right:-8px;border-radius:50%;background:${avBg};color:${avFg};display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px ${dark ? '#1e1e24' : '#fffdfa'}}
.atb-av span:last-child{background:${pill};color:${sub}}
.atb-i{display:flex;align-items:center;gap:8px}
.atb-bat{width:24px;height:12px;border-radius:4px;box-shadow:inset 0 0 0 1.5px ${sub};position:relative;padding:2px}.atb-bat::after{content:"";position:absolute;right:-3px;top:4px;width:2px;height:4px;border-radius:1px;background:${sub}}.atb-bat b{display:block;height:100%;width:68%;border-radius:2px;background:${ink}}
@media (max-width:900px){.atb-net,.atb-s{display:none}}@media (max-width:640px){.atb-r .atb-av{display:none}}`;
    document.head.appendChild(st);
    const bar = document.createElement('div'); bar.className = 'atb'; bar.setAttribute('role', 'banner');
    bar.innerHTML = '<a class="atb-w" href="Atlas Dashboard Beta.dc.html" title="Home">atlas</a><span class="atb-p" title="What Atlas is doing"><i style="background:#0fae76"></i><span class="atb-pt">Listening</span></span><span class="atb-s" title="You are here">' + label + '</span>' +
      '<a class="atb-r" href="Atlas System Status Beta.dc.html" title="Devices, network and battery"><span class="atb-av"><span>' + svg(P.head, 16) + '</span><span>' + svg(P.tab, 16) + '</span><span>' + svg(P.phone, 16) + '</span><span>' + svg(P.watch, 16) + '</span></span><span class="atb-i" style="margin-left:6px">' + svg(P.bt, 18, '#3461f2') + '</span><span class="atb-i atb-net">' + svg(P.wifi, 18) + 'Fogware 5G</span><span class="atb-i"><span class="atb-bat"><b></b></span>68%</span></a>';
    document.body.appendChild(bar);
    const fit = () => { const cs = getComputedStyle(root); if (root.__atbFit) return; root.__atbFit = 1; const full = Math.abs(root.getBoundingClientRect().height - window.innerHeight) < 4 || /100vh/.test(root.getAttribute('style') || ''); root.style.marginTop = H + 'px'; if (full) root.style.height = 'calc(100vh - ' + H + 'px)'; else root.style.minHeight = 'calc(100vh - ' + H + 'px)'; if (cs.position === 'absolute' || cs.position === 'fixed') root.style.top = H + 'px'; };
    fit();
    const setState = (s) => { const v = STATE[s] || STATE.idle; bar.querySelector('.atb-pt').textContent = v[0]; bar.querySelector('.atb-p i').style.background = v[1]; };
    window.addEventListener('atlas-state', (e) => setState(e.detail));
    window.AtlasTopbar = { setState, setScreen: (t) => { bar.querySelector('.atb-s').textContent = t; } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
