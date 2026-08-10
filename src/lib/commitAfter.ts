/**
 * Run `commit` after `ms` — but never later than the user's next sign of life.
 *
 * A plain setTimeout is not safe for anything that gates interaction. WKWebView
 * throttles timers hard when the window is not key, so a transition that
 * disables pointer events "for 340ms" can stay disabled indefinitely if the
 * user switches away and back. That is exactly how the dashboard ended up
 * scrollable but completely unclickable.
 *
 * So we race the timer against the first pointer/key/focus/visibility event
 * that arrives once the duration has actually elapsed (wall-clock, not timer
 * ticks). Whichever fires first commits, once.
 *
 * Lived in AtlasDashboard.tsx unexported until the Clock surface needed the same
 * guarantee. Nothing about it is dashboard-specific: any timeout that disables
 * or hides something the user can interact with wants this instead of
 * setTimeout.
 */
export function commitAfter(ms: number, commit: () => void): void {
  const start = Date.now();
  const WAKE = ['pointerdown', 'keydown', 'focus', 'visibilitychange'] as const;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    WAKE.forEach((e) => window.removeEventListener(e, onWake, true));
    commit();
  };
  // Only rescue AFTER the animation would have finished, so an early click
  // during the transition does not cut the motion short.
  const onWake = () => { if (Date.now() - start >= ms) finish(); };

  const timer = window.setTimeout(finish, ms);
  WAKE.forEach((e) => window.addEventListener(e, onWake, true));
}
