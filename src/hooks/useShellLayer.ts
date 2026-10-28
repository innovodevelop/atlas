/**
 * A shell layer while `open`: on the layer stack (Esc closes the topmost only,
 * Tab stays inside — src/lib/shellLayers.ts), focus moved in when it opens and
 * handed back to its trigger when it closes.
 *
 * Handing focus back follows `shouldReturnFocus`: only when focus went down
 * with the layer, and only for a keyboard user. A click on the page that
 * closed the layer keeps focus where the click put it.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { focusables, inputModality, openLayer, shouldReturnFocus } from '@/lib/shellLayers';

export interface ShellLayerOptions {
  id: string;
  /** The layer's root element. */
  ref: RefObject<HTMLElement | null>;
  /** Esc on the topmost layer. */
  onClose: () => void;
  /**
   * Where focus goes on open; default the first focusable, else the root. A
   * non-focusable target (a dialog's own element) gets tabindex="-1", which
   * the Beta focus ring leaves alone.
   */
  initialFocus?: () => HTMLElement | null;
  /**
   * Where focus goes back to on close. Gets the element that had focus when
   * the layer opened (null if that was <body>, which is what a mouse click on
   * a button leaves in WebKit); default that element.
   */
  returnFocus?: (opener: HTMLElement | null) => HTMLElement | null;
}

function focusedElement(): HTMLElement | null {
  const a = typeof document === 'undefined' ? null : document.activeElement;
  return a instanceof HTMLElement && a !== document.body ? a : null;
}

function focusInto(el: HTMLElement): void {
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

export function useShellLayer(open: boolean, opts: ShellLayerOptions): void {
  // The latest callbacks, without re-running the open/close effect for them.
  const latest = useRef(opts);
  useLayoutEffect(() => { latest.current = opts; });

  useLayoutEffect(() => {
    if (!open) return;
    const opener = focusedElement();
    const root = latest.current.ref.current;
    const remove = openLayer({
      id: latest.current.id,
      root: () => latest.current.ref.current,
      onEscape: () => latest.current.onClose(),
    });
    if (root && !root.contains(document.activeElement)) {
      const first = latest.current.initialFocus?.() ?? focusables(root)[0] ?? root;
      focusInto(first);
    }
    return () => {
      remove();
      const now = document.activeElement;
      const lost = !now || now === document.body || (root?.contains(now) ?? false);
      if (!shouldReturnFocus(lost, inputModality())) return;
      const back = latest.current.returnFocus ? latest.current.returnFocus(opener) : opener;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    // Opens and closes with `open`; the id and callbacks are read through `latest`.
  }, [open]);
}
