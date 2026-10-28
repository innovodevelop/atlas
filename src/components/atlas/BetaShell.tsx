/**
 * The Beta shell — what every route renders inside while `beta_ui` is on.
 *
 * Top bar above, the page in the middle, the dock and the Talk to Atlas orb
 * floating over it. Marks `<html data-ui="beta">` so src/styles/beta.css can
 * restyle the Workshop pages underneath (borders off, page paper, the page's
 * own dock hidden) without touching them when the flag is off.
 *
 * Tone: the top bar is drawn in ink on paper and in paper on ink. Like the
 * handoff's `atlas-topbar.js`, the shell measures the page's background after
 * each route change (walking up from the page root until something opaque)
 * and sets `data-beta-tone`. A page can also declare it with
 * `data-beta-tone="ink"` on its root and skip the measurement.
 *
 * Accessibility (phase 8): the focus order is the DOM order — a skip link,
 * the top bar, the page, the dock, then the orb. Since the dock and the bar
 * stay put while the page changes, nothing else tells a screen reader that a
 * route changed, so a polite status line says the new screen's name. Focus
 * rings, reduced motion and the hidden-text helper are in
 * src/styles/beta/shell-a11y.css. The shell also tracks whether the user is
 * on the keyboard (src/lib/shellLayers.ts), which decides whether a closing
 * panel hands focus back.
 *
 * Performance (phase 8): every Beta sphere sleeps while the window is hidden,
 * unfocused or idle. The window's activity is a React hook, so the shell reads
 * it once and hands it to the sphere engine for all of them.
 */
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { TopBar, screenLabel } from './TopBar';
import { BetaDock } from './BetaDock';
import { TalkToAtlas } from './TalkToAtlas';
import { useWindowActivity } from '@/hooks/useWindowActivity';
import { setSpheresWindowActive } from '@/lib/quickSphere';
import { trackInputModality } from '@/lib/shellLayers';
import '@/styles/beta/shell-a11y.css';

// The Clock's ringing alarm, on every screen: an alarm set on /clock rings
// wherever the user is, and mounting this also starts the clock store for the
// run. Lazy, so the shell's own chunk does not grow by the clock's.
const ClockRinging = lazy(() => import('./clock/ClockRinging'));

/** Relative luminance of a CSS colour string, or null when transparent/unparseable. */
export function luminance(color: string): number | null {
  const m = color.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return null;
  if (m[3] !== undefined && Number(m[3]) === 0) return null;
  return (0.299 * Number(m[0]) + 0.587 * Number(m[1]) + 0.114 * Number(m[2])) / 255;
}

export function measureTone(root: Element | null): 'paper' | 'ink' {
  for (let n = root; n && n !== document.documentElement; n = n.parentElement) {
    const declared = (n as HTMLElement).dataset?.betaTone;
    if (declared === 'ink' || declared === 'paper') return declared;
    const l = luminance(getComputedStyle(n).backgroundColor);
    if (l != null) return l < 0.4 ? 'ink' : 'paper';
  }
  return 'paper';
}

const MAIN_ID = 'beta-main';

/** What the status line says after a route change. */
export function routeAnnouncement(pathname: string): string {
  return `${screenLabel(pathname)} screen`;
}

/**
 * Skip link target: the page wrapper takes focus for the jump and gives up its
 * tabindex on the way out, so a click on the page never lands focus on it.
 */
function skipToPage(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  const main = document.getElementById(MAIN_ID);
  if (!main) return;
  main.setAttribute('tabindex', '-1');
  main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
  main.focus();
}

export function BetaShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const active = useWindowActivity();

  useEffect(() => {
    document.documentElement.dataset.ui = 'beta';
    return () => { delete document.documentElement.dataset.ui; delete document.documentElement.dataset.betaTone; };
  }, []);

  useEffect(() => trackInputModality(), []);

  useEffect(() => { setSpheresWindowActive(active); }, [active]);
  // Leaving the shell (the flag turned off) must not leave the engine asleep.
  useEffect(() => () => setSpheresWindowActive(true), []);

  // The new screen's name, for screen readers. Not on the first render: the
  // window's title and the page itself are what a fresh start reads.
  const [announce, setAnnounce] = useState('');
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) { firstRoute.current = false; return; }
    setAnnounce(routeAnnouncement(pathname));
  }, [pathname]);

  // After the route's first paint (and again once its lazy chunk has
  // rendered), read the page's background and pick the bar's tone.
  useLayoutEffect(() => {
    const apply = () => {
      const page = document.querySelector('.beta-page');
      const root = page?.firstElementChild ?? page;
      document.documentElement.dataset.betaTone = measureTone(root);
    };
    apply();
    const t1 = window.setTimeout(apply, 120);
    const t2 = window.setTimeout(apply, 600);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [pathname]);

  return (
    <>
      <a className="b-skip" href={`#${MAIN_ID}`} onClick={skipToPage}>Skip to content</a>
      <p className="b-sr-only" role="status" aria-atomic="true">{announce}</p>
      <TopBar />
      <div className="beta-page" id={MAIN_ID}>{children}</div>
      <BetaDock />
      <TalkToAtlas />
      <Suspense fallback={null}><ClockRinging /></Suspense>
    </>
  );
}
