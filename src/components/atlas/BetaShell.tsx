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
 */
import { Suspense, lazy, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { TopBar } from './TopBar';
import { BetaDock } from './BetaDock';
import { TalkToAtlas } from './TalkToAtlas';

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

export function BetaShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  useEffect(() => {
    document.documentElement.dataset.ui = 'beta';
    return () => { delete document.documentElement.dataset.ui; delete document.documentElement.dataset.betaTone; };
  }, []);

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
      <TopBar />
      <div className="beta-page">{children}</div>
      <BetaDock />
      <TalkToAtlas />
      <Suspense fallback={null}><ClockRinging /></Suspense>
    </>
  );
}
