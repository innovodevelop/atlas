/* atlas-transition.js — one continuous surface across every Atlas view.

   Navigating between Atlas pages should feel like the dashboard rearranging
   itself, not like leaving an app. Two halves:

   ENTER  the page lifts in from a slightly settled state (cream veil clears,
          content rises) the moment it is parseable — no white flash, because the
          veil is painted in the page's own background colour.
   EXIT   a same-origin Atlas link is intercepted, the current view settles back
          a touch and the veil returns, and only then does navigation happen.
          The two halves are mirror images, so the seam lands mid-veil.

   The sphere is deliberately exempt: it holds still through the change so it
   reads as the one persistent object across the whole product. */
(function () {
  if (window.AtlasTransition) return;

  var DUR = 320;                       /* one beat, matched both directions */
  var EASE = 'cubic-bezier(.32,.72,.24,1)';
  var PAPER = '#f9f7f4';
  var veil, holder, leaving = false;

  /* Cross-document view transitions: the browser holds the outgoing frame until the
     incoming one is ready, so there is NO blank beat, and any element carrying the
     same view-transition-name in both documents genuinely morphs between them.
     atlas-sphere.js assigns `atlas-orb` to exactly one mounted sphere per document,
     so every view that mounts a sphere morphs it with no per-view markup (and never
     duplicates the name, which would abort the transition). Where this is
     unsupported we fall back to the veil crossfade below. */
  var MORPH = typeof document.startViewTransition === 'function';

  if (MORPH) {
    var vt = document.createElement('style');
    vt.textContent =
      '@view-transition{navigation:auto}' +
      '::view-transition-group(atlas-orb){animation-duration:620ms;' +
        'animation-timing-function:' + EASE + '}' +
      '::view-transition-old(atlas-orb),::view-transition-new(atlas-orb){' +
        'animation:none;mix-blend-mode:normal;height:100%}' +
      '::view-transition-old(root){animation-duration:260ms;' +
        'animation-timing-function:' + EASE + '}' +
      '::view-transition-new(root){animation-duration:380ms;animation-delay:60ms;' +
        'animation-timing-function:' + EASE + '}';
    (document.head || document.documentElement).appendChild(vt);
  }

  function paper() {
    var b = getComputedStyle(document.body).backgroundColor;
    return (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') ? b : PAPER;
  }

  function makeVeil() {
    veil = document.createElement('div');
    veil.setAttribute('data-atlas-veil', '');
    veil.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;' +
      'background:' + paper() + ';opacity:1;transition:opacity ' + DUR + 'ms ' + EASE;
    (document.body || document.documentElement).appendChild(veil);
  }

  /* Everything except the sphere and the veil drifts; the orb stays put. */
  function stage() {
    if (holder) return holder;
    holder = document.createElement('style');
    holder.textContent =
      '@keyframes atlas-view-in{from{opacity:0;transform:translateY(10px) scale(.994)}' +
      'to{opacity:1;transform:none}}' +
      /* The DC runtime renders into #dc-root and never emits an <x-dc> element at
         runtime, so target its children; [data-atlas-view] stays supported for
         plain pages that opt in explicitly. */
      '#dc-root > *,[data-atlas-view]{animation:atlas-view-in ' + (DUR + 120) + 'ms ' + EASE + ' both}';
    document.head.appendChild(holder);
    return holder;
  }

  function enter() {
    if (MORPH) return;               /* the view transition IS the enter animation */
    stage();
    if (!veil) makeVeil();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        veil.style.opacity = '0';
        setTimeout(function () { if (veil) veil.style.display = 'none'; }, DUR + 40);
      });
    });
  }

  function go(href) {
    if (!href) return;
    if (MORPH) { window.location.href = href; return; }   /* instant; browser morphs */
    if (leaving) return;
    leaving = true;
    if (!veil) makeVeil();
    veil.style.display = 'block';
    veil.style.background = paper();
    /* settle the outgoing view back, the inverse of the enter lift */
    var root = document.querySelector('[data-atlas-view]') ||
      document.querySelector('#dc-root > *') || document.body;
    if (root && root.style) {
      root.style.transition = 'opacity ' + DUR + 'ms ' + EASE + ',transform ' + DUR + 'ms ' + EASE;
      root.style.transformOrigin = '50% 42%';
      root.style.opacity = '0';
      root.style.transform = 'translateY(-6px) scale(.996)';
    }
    requestAnimationFrame(function () { veil.style.opacity = '1'; });
    setTimeout(function () { window.location.href = href; }, DUR - 20);
  }

  /* Intercept Atlas-internal links; leave new-tab and external clicks alone. */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (a.target === '_blank' || /^(https?:|mailto:|#)/.test(href)) return;
    if (!/\.(dc\.html|html)$/i.test(href)) return;
    if (MORPH) return;               /* let the browser drive the cross-document morph */
    e.preventDefault();
    go(href);
  }, true);

  window.addEventListener('pageshow', function (e) {
    /* returning via back/forward: the veil must clear again */
    if (e.persisted) { leaving = false; if (veil) { veil.style.display = 'block'; enter(); } }
  });

  window.AtlasTransition = { go: go, enter: enter, DUR: DUR, EASE: EASE };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', enter);
  else enter();
})();
