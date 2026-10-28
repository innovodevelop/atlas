/**
 * The Beta shell's layers — the Talk panel and the status panels — and the two
 * keys they share.
 *
 *   - Esc closes the topmost layer and nothing else: not the layer under it,
 *     not the page's own sheet under both. Pages listen for Esc on `window` in
 *     the bubble phase; this listens in the capture phase and stops the event,
 *     so a page never also acts on an Esc a layer used.
 *   - Tab stays inside the topmost layer while it is open, and wraps at its
 *     ends. Only the keyboard is held: a click elsewhere is not fought, but the
 *     next Tab brings focus back into the layer, so a keyboard user can never
 *     end up behind it.
 *
 * Opening and closing (moving focus in, giving it back to the trigger) is the
 * hook's job: src/hooks/useShellLayer.ts. The stack maths, the Tab rule and the
 * focus-return rule are pure and tested.
 *
 * Focus goes back to the trigger only for a keyboard (or assistive technology)
 * user, who would otherwise be dropped at the top of the document. A pointer
 * user has no use for it, and in WebKit a scripted focus after a click can
 * paint the keyboard ring the guidelines keep off pointer users. The input
 * modality is tracked from real key and pointer presses; a screen reader's
 * own navigation sends neither, so the starting value is the keyboard.
 */

/** `id` on top, wherever it was before (re-opening a layer raises it). */
export function raise(stack: readonly string[], id: string): string[] {
  return [...stack.filter((x) => x !== id), id];
}

export function drop(stack: readonly string[], id: string): string[] {
  return stack.filter((x) => x !== id);
}

/**
 * Where Tab should land among a layer's `count` focusable elements, given the
 * index of the focused one (-1 when focus is outside the layer). `null` means
 * leave it to the browser: the move stays inside the layer anyway.
 */
export function trapTab(current: number, count: number, back: boolean): number | null {
  if (count <= 0) return null;
  if (current < 0) return back ? count - 1 : 0;
  if (back && current === 0) return count - 1;
  if (!back && current === count - 1) return 0;
  return null;
}

export type InputModality = 'keyboard' | 'pointer';

/**
 * Give focus back to the trigger when a layer closes? Only when focus went
 * down with the layer (it was inside, or fell to <body> when the layer's
 * nodes went away) and the user is on the keyboard. A click elsewhere that
 * closed the layer keeps focus where the click put it.
 */
export function shouldReturnFocus(lost: boolean, modality: InputModality): boolean {
  return lost && modality === 'keyboard';
}

// ---- Input modality (DOM) ----------------------------------------------------

let modality: InputModality = 'keyboard';
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);
function onAnyKey(e: KeyboardEvent) { if (!MODIFIERS.has(e.key)) modality = 'keyboard'; }
function onPointer(e: PointerEvent) { if (e.isTrusted) modality = 'pointer'; }

/** Start tracking the last input modality (the Beta shell does, once). Returns the stop. */
export function trackInputModality(): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('keydown', onAnyKey, { capture: true, passive: true });
  window.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
  return () => {
    window.removeEventListener('keydown', onAnyKey, { capture: true });
    window.removeEventListener('pointerdown', onPointer, { capture: true });
  };
}

export function inputModality(): InputModality {
  return modality;
}

// ---- The live stack (DOM) ----------------------------------------------------

export interface ShellLayer {
  id: string;
  /** The layer's root, for the Tab trap. */
  root: () => HTMLElement | null;
  onEscape: () => void;
}

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', '[contenteditable=""]',
  '[contenteditable="true"]', '[tabindex]',
].join(', ');

/** The elements Tab visits inside `root`, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length > 0,
  );
}

const byId = new Map<string, ShellLayer>();
let stack: string[] = [];

function onKey(e: KeyboardEvent) {
  const top = byId.get(stack[stack.length - 1]);
  if (!top || e.defaultPrevented) return;
  if (e.key === 'Escape') {
    if (e.isComposing) return; // Esc cancels the IME first
    e.preventDefault();
    e.stopImmediatePropagation();
    top.onEscape();
    return;
  }
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const root = top.root();
  if (!root) return;
  const items = focusables(root);
  const active = document.activeElement;
  const next = trapTab(items.findIndex((el) => el === active), items.length, e.shiftKey);
  if (items.length === 0) {
    // Nothing to land on: keep focus on the layer itself.
    e.preventDefault();
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    root.focus({ preventScroll: true });
    return;
  }
  if (next === null) return;
  e.preventDefault();
  items[next].focus({ preventScroll: true });
}

/** Put a layer on top. Returns its removal. */
export function openLayer(layer: ShellLayer): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!stack.length) window.addEventListener('keydown', onKey, true);
  byId.set(layer.id, layer);
  stack = raise(stack, layer.id);
  return () => {
    // Only this registration: a layer re-opened under the same id since then
    // has its own removal.
    if (byId.get(layer.id) !== layer) return;
    byId.delete(layer.id);
    stack = drop(stack, layer.id);
    if (!stack.length) window.removeEventListener('keydown', onKey, true);
  };
}

/** The id of the layer Esc would close, or null. */
export function topLayer(): string | null {
  return stack[stack.length - 1] ?? null;
}
