/* Atlas orb: one consistent, always-visible way to talk to Atlas on every screen.
   Self-mounting. Click or press ⌥Space to talk; Esc closes. Pages can drive it with
   window.AtlasOrb.set('thinking' | 'speaking' | 'listening' | 'idle' | …). */
(function () {
  if (window.AtlasOrb) return;
  const css = `
  .ao-btn{position:fixed;right:20px;bottom:10px;z-index:60;width:128px;height:128px;padding:0;border:none;border-radius:50%;background:transparent;cursor:pointer;transition:transform .35s cubic-bezier(.22,1,.36,1)}
  .ao-btn:hover{transform:scale(1.06)}
  .ao-btn canvas{position:absolute;inset:0;width:100%;height:100%;border-radius:50%;display:block;filter:drop-shadow(0 10px 14px rgba(30,30,36,.22)) drop-shadow(0 2px 4px rgba(30,30,36,.12))}
  .ao-tip{position:fixed;left:94px;bottom:56px;z-index:60;height:32px;padding:0 12px;display:flex;align-items:center;gap:8px;border-radius:9999px;background:#1e1e24;color:#f9f7f4;font:600 12.5px Geist,system-ui,sans-serif;white-space:nowrap;opacity:0;transform:translateX(6px);transition:opacity .25s,transform .25s;pointer-events:none}
  .ao-btn:hover + .ao-tip,.ao-tip.on{opacity:1;transform:none}
  .ao-tip kbd{height:20px;padding:0 6px;display:flex;align-items:center;border-radius:6px;background:rgba(249,247,244,.14);font:500 11px 'Geist Mono',monospace}
  .ao-dot{width:7px;height:7px;border-radius:50%;background:#8fa9ff}
  .ao-panel{position:fixed;left:20px;bottom:92px;z-index:61;width:min(360px,calc(100vw - 40px));padding:16px;border-radius:28px;background:#1e1e24;color:#f9f7f4;font-family:Geist,system-ui,sans-serif;box-shadow:0 40px 80px -30px rgba(0,0,0,.6);display:none;flex-direction:column;gap:12px;animation:ao-in .4s cubic-bezier(.22,1,.36,1) both}
  .ao-panel.on{display:flex}
  @keyframes ao-in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
  .ao-stage{position:relative;width:160px;height:160px;align-self:center}
  .ao-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  .ao-state{align-self:center;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:rgba(249,247,244,.78)}
  .ao-say{margin:0;font:500 17px/1.45 'Hanken Grotesk',Geist,sans-serif;letter-spacing:-.01em;text-wrap:pretty;min-height:24px}
  .ao-row{display:flex;gap:6px}
  .ao-in{flex:1;min-width:0;height:44px;padding:0 16px;border:none;outline:none;border-radius:9999px;background:#26262d;color:#f9f7f4;font:inherit;font-size:14px}
  .ao-in::placeholder{color:rgba(249,247,244,.5)}
  .ao-go{height:44px;width:44px;border:none;border-radius:50%;background:#f9f7f4;color:#1e1e24;font-size:16px;cursor:pointer}
  .ao-link{align-self:flex-start;height:36px;padding:0 14px;display:none;align-items:center;border-radius:9999px;background:#3461f2;color:#fff;font-size:13px;font-weight:600;text-decoration:none}
  .ao-link.on{display:flex}
  .ao-link:hover{background:#5b7cff;color:#fff}
  .ao-chips{display:flex;flex-wrap:wrap;gap:6px}
  .ao-chip{height:30px;padding:0 11px;white-space:nowrap;border:none;border-radius:9999px;background:#26262d;color:#f9f7f4;font:600 12px Geist,system-ui,sans-serif;cursor:pointer}
  .ao-chip:hover{background:#2e2e36}
  @media (prefers-reduced-motion: reduce){.ao-panel,.ao-btn,.ao-tip{animation:none;transition:none}}`;
  const STATE_COL = { idle: '#8fa9ff', listening: '#1696be', thinking: '#7854ff', speaking: '#3461f2', working: '#e07a1f', success: '#0fae76', alert: '#d0453a' };
  const STATE_TXT = { idle: 'Atlas is here', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Atlas', working: 'Working on it…', success: 'Done', alert: 'Needs you' };
  const ROUTES = [[/umbrella|rain|weather|cold|warm/i, 'rain', 'Yes, take an umbrella. Rain from 15:00, right when you walk to the studio.'], [/spend|spent|money|budget|cost/i, 'spend', 'You’ve spent €612 on food in October, €84 more than September.'], [/train|bus|metro|leave|commute/i, 'train', 'The next train to Lund is 14:42 from platform 2. The 14:22 is running late.'], [/compare|versus|flat|which/i, 'compare', 'The Nørrebro flat fits you better: shorter commute and the fourth room.'], [/who|priya|person|know about/i, 'person', 'Priya runs Raman Studio and is waiting on your offsite reply.']];
  function findHeader() { const cands = Array.from(document.querySelectorAll('header canvas, [style*="view-transition-name:hero"] canvas, [style*="view-transition-name: hero"] canvas')); for (const c of cands) { if (c.closest('.ao-panel,.ao-btn')) continue; const b = c.getBoundingClientRect(); if (b.width >= 40 && b.top < 360 && b.top > -40) return c; } return null; }
  let tries = 0;
  function boot() {
    if (document.querySelector('.ao-btn')) return;
    const hc = findHeader(); if (!hc && tries++ < 14) return setTimeout(boot, 150);
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const btn = document.createElement('button'); btn.className = 'ao-btn'; btn.setAttribute('aria-label', 'Talk to Atlas'); btn.innerHTML = '<canvas></canvas>';
    const tip = document.createElement('div'); tip.className = 'ao-tip'; tip.innerHTML = '<span class="ao-dot"></span><span class="ao-tip-t">Talk to Atlas</span><kbd>⌥ Space</kbd>';
    const panel = document.createElement('div'); panel.className = 'ao-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Talk to Atlas');
    panel.innerHTML = '<div class="ao-stage"><canvas></canvas></div><div class="ao-state"><span class="ao-dot"></span><span class="ao-state-t">Listening…</span></div><p class="ao-say"></p><a class="ao-link" href="Atlas Answer Views Beta.dc.html">Open the full answer →</a><div class="ao-chips"></div><div class="ao-row"><input class="ao-in" placeholder="Say it, or type to Atlas" aria-label="Message Atlas"><button class="ao-go" aria-label="Send">→</button></div>';
    document.body.append(btn, tip, panel);
    const place = () => { const S = 128, left = 16, bottom = 10; btn.style.left = left + 'px'; btn.style.right = 'auto'; btn.style.bottom = bottom + 'px'; tip.style.right = 'auto'; tip.style.left = (left + S + 6) + 'px'; tip.style.bottom = (bottom + S / 2 - 16) + 'px'; panel.style.right = 'auto'; panel.style.left = left + 'px'; panel.style.bottom = (bottom + S + 8) + 'px'; };
    const clearance = () => { const zone = 128 + 10 + 16, els = [document.scrollingElement].concat(Array.from(document.querySelectorAll('body *'))); els.forEach((el) => { if (!el || el.closest && el.closest('.ao-panel')) return; const cs = getComputedStyle(el), sc = el === document.scrollingElement || /auto|scroll/.test(cs.overflowY); if (!sc || el.clientHeight < 160) return; const rc = el === document.scrollingElement ? { left: 0, bottom: window.innerHeight } : el.getBoundingClientRect(); if (rc.left > 160 || rc.bottom < window.innerHeight - zone) return; const tgt = el === document.scrollingElement ? document.body : el; const cur = parseFloat(getComputedStyle(tgt).paddingBottom) || 0; if (!tgt.__aoPad && cur < zone) { tgt.__aoPad = 1; tgt.style.paddingBottom = zone + 'px'; } }); };
    place(); window.addEventListener('resize', place); setTimeout(clearance, 300); setTimeout(clearance, 1500); window.addEventListener('hashchange', () => setTimeout(clearance, 400)); const dk = document.querySelector('nav[data-dock="beta"]'); if (dk && window.ResizeObserver) new ResizeObserver(place).observe(dk); setTimeout(place, 400); setTimeout(place, 1500);
    const say = panel.querySelector('.ao-say'), link = panel.querySelector('.ao-link'), inp = panel.querySelector('.ao-in'), chips = panel.querySelector('.ao-chips');
    const lab = () => { const el = document.querySelector('[data-screen-label]'); return ((el && el.getAttribute('data-screen-label')) || document.title || 'this screen').replace(/^Atlas\s*[·—-]?\s*/, '').replace(/\s*[·—].*$/, '').replace(/ Beta$/, '') || 'this screen'; }; let screen = lab();
    let small = null, big = null, cur = 'idle', open = false, T = [];
    const ensure = (cb) => { if (window.QuickSphere) return cb(); if (!document.querySelector('script[src*="atlas-quickstart-sphere"]')) { const s = document.createElement('script'); s.src = 'atlas-quickstart-sphere.js'; document.head.appendChild(s); } const w = () => (window.QuickSphere ? cb() : setTimeout(w, 80)); w(); };
    const opts = (count) => ({ mode: 'veil', bg: '#1e1e24', dust: [92, 122, 248], strand: [176, 196, 255], blend: 'lighter', alpha: 0.55, seed: 11, count, scale: 0.42, state: cur });
    ensure(() => { small = window.QuickSphere.mount(btn.querySelector('canvas'), { mode: 'veil', bg: 'transparent', dust: [92, 122, 248], strand: [52, 97, 242], blend: 'source-over', alpha: 0.75, seed: 11, count: 5200, scale: 0.44, state: cur }); });
    function set(s) { cur = s; try { window.dispatchEvent(new CustomEvent('atlas-state', { detail: s })); } catch (e) {} if (small) small.set({ state: s }); if (big) big.set({ state: s }); if (window.__aoHeader && window.__aoHeader.__q) { try { window.__aoHeader.__q.set({ state: s }); } catch (e) {} } const c = STATE_COL[s] || '#8fa9ff'; panel.querySelector('.ao-dot').style.background = c; tip.querySelector('.ao-dot').style.background = c; panel.querySelector('.ao-state-t').textContent = STATE_TXT[s] || s; if (!open) { tip.querySelector('.ao-tip-t').textContent = s === 'idle' ? 'Talk to Atlas' : STATE_TXT[s]; tip.classList.toggle('on', s !== 'idle'); } }
    function clear() { T.forEach(clearTimeout); T = []; }
    function suggestions() { const ideas = ['What needs me today?', 'Do I need an umbrella?', 'Summarise ' + screen.toLowerCase()]; chips.innerHTML = ''; ideas.forEach((q) => { const b = document.createElement('button'); b.className = 'ao-chip'; b.textContent = q; b.onclick = () => ask(q); chips.appendChild(b); }); chips.style.display = 'flex'; }
    let show = function () { screen = lab(); open = true; panel.classList.add('on'); tip.classList.remove('on'); say.textContent = 'Go ahead, I’m listening.'; link.classList.remove('on'); suggestions(); set('listening'); if (!big && !window.__aoHeader) ensure(() => { big = window.QuickSphere.mount(panel.querySelector('.ao-stage canvas'), opts(9000)); big.set({ state: cur }); }); setTimeout(() => inp.focus(), 50); };
    function hide() { open = false; clear(); panel.classList.remove('on'); set('idle'); }
    function ask(q) { if (!q.trim()) return; clear(); chips.style.display = 'none'; inp.value = ''; say.textContent = '“' + q.trim() + '”'; link.classList.remove('on'); set('thinking');
      T.push(setTimeout(() => { const r = ROUTES.find(([re]) => re.test(q)); set('speaking'); say.textContent = r ? r[2] : /need|today/i.test(q) ? 'Two things need you before noon: Dana’s embargo and a held €62,000 payment.' : 'Here’s what I found on ' + screen + '. I’ve laid it out in full for you.'; link.href = 'Atlas Answer Views Beta.dc.html' + (r ? '#' + r[1] : ''); link.classList.add('on'); T.push(setTimeout(() => set('idle'), 3600)); }, 1300)); }
    if (hc) { btn.style.display = 'none'; tip.style.display = 'none'; const host = hc.closest('button') || hc.parentElement; host.style.cursor = 'pointer'; if (!host.title) host.title = 'Talk to Atlas · ⌥ Space'; panel.querySelector('.ao-stage').style.display = 'none'; window.__aoHeader = hc; const wrap = () => { const q = hc.__q; if (!q) return setTimeout(wrap, 200); if (q.__aoWrap) return; q.__aoWrap = 1; const o0 = q.set.bind(q); q.set = (nv) => { o0(nv); if (nv && nv.state) { try { window.dispatchEvent(new CustomEvent('atlas-state', { detail: nv.state })); } catch (e) {} } }; }; wrap(); if (!hc.closest('button')) host.addEventListener('click', (e) => { e.stopPropagation(); open ? hide() : show(); }); const anchor = () => { const b = hc.getBoundingClientRect(), w = Math.min(360, window.innerWidth - 40); panel.style.bottom = 'auto'; panel.style.right = 'auto'; const side = b.right + 12 + w <= window.innerWidth - 12; panel.style.left = (side ? b.right + 12 : Math.max(12, Math.min(b.left, window.innerWidth - w - 12))) + 'px'; panel.style.top = (side ? Math.max(8, b.top) : b.bottom + 8) + 'px'; panel.style.maxHeight = (window.innerHeight - (side ? Math.max(8, b.top) : b.bottom + 8) - 12) + 'px'; panel.style.overflowY = 'auto'; }; const show0 = show; show = function () { anchor(); show0(); }; window.addEventListener('resize', () => open && anchor()); }
    btn.addEventListener('click', () => (open ? hide() : show()));
    panel.querySelector('.ao-go').addEventListener('click', () => ask(inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(inp.value); else set(e.key.length === 1 ? 'listening' : cur); });
    window.addEventListener('keydown', (e) => { if (e.altKey && e.code === 'Space') { e.preventDefault(); open ? hide() : show(); } else if (e.key === 'Escape' && open) { e.stopImmediatePropagation(); e.preventDefault(); hide(); } }, true);
    window.AtlasOrb = { set: (s) => set(s), open: show, close: hide };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
