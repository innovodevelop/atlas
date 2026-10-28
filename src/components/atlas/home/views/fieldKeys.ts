import type { KeyboardEvent } from 'react';

/**
 * Esc inside a field leaves the field, not the screen: blur it and stop the
 * key before it reaches BetaHome's window listener, which closes the view.
 * (TasksView keeps its own copy from before this file existed.)
 */
export function escapeBlurs(e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>): void {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  e.currentTarget.blur();
}
