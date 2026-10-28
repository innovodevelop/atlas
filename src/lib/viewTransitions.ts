/**
 * Route transitions for the Beta shell — the app version of the handoff's
 * `atlas-transition.js`.
 *
 * Navigating should feel like Home reshaping, not a page load: the tapped
 * card morphs into the destination's hero (`view-transition-name: hero`), the
 * dock and the top bar stay put, and the rest cross-fades with a slight scale.
 * In a single-document app that is a same-document View Transition, which
 * React Router 6.30 starts for us when `navigate(to, { viewTransition: true })`
 * is used. The CSS for the groups is in src/styles/beta.css.
 *
 * `prefers-reduced-motion` turns it off: the navigation still happens, it just
 * swaps.
 */
import { useCallback } from 'react';
import { useNavigate, type NavigateOptions, type To } from 'react-router-dom';

export function viewTransitionsSupported(): boolean {
  return typeof document !== 'undefined' && typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === 'function';
}

export function motionAllowed(): boolean {
  return typeof window === 'undefined' || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function shouldTransition(): boolean {
  return viewTransitionsSupported() && motionAllowed();
}

/**
 * `navigate` with the Beta transition. Pass the element that was tapped as
 * `hero` and it carries the `hero` view-transition-name for the duration, so
 * it morphs into whatever the destination names `hero`.
 */
export function useBetaNavigate() {
  const navigate = useNavigate();
  return useCallback(
    (to: To, opts: NavigateOptions & { hero?: HTMLElement | null } = {}) => {
      const { hero, ...rest } = opts;
      const on = shouldTransition();
      if (on && hero) {
        hero.style.viewTransitionName = 'hero';
        // The browser snapshots before the navigation commits; clear the name
        // afterwards so two cards never carry it at once (a duplicate aborts
        // the transition).
        window.setTimeout(() => { hero.style.viewTransitionName = ''; }, 700);
      }
      navigate(to, { ...rest, viewTransition: on });
    },
    [navigate],
  );
}
