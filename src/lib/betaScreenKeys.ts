/**
 * Esc on the Core, Teach and Architecture screens.
 *
 * Each hero's back button says "Back · Esc", so Esc has to do what it says.
 * The rule every Beta screen follows: Esc inside a field only leaves the field
 * (blur), Esc with a modifier is someone else's shortcut, and the Talk panel
 * takes Esc first when it is open (it listens in the capture phase and stops
 * the event), so a screen never closes under it.
 */

/** True when the key went to something you type into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export type EscapeAction = 'ignore' | 'blur' | 'step';

interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  target: EventTarget | null;
}

/** What a screen should do with this keydown: nothing, leave the field, or step out. */
export function escapeAction(e: KeyLike): EscapeAction {
  if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return 'ignore';
  return isTypingTarget(e.target) ? 'blur' : 'step';
}
