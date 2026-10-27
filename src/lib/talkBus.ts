/**
 * The talk bus — how a screen reaches the Talk to Atlas panel.
 *
 * Two messages, both one way:
 *   - `openTalk(question?)`: open the panel, and ask `question` if given. The
 *     band's suggested asks and the focus card's "Join" use this.
 *   - `setTalkAnchor(el)`: a screen with a header sphere registers it as the
 *     talk entry point (handoff `atlas-orb.js`: "uses the page's header sphere
 *     when there is one"). The orb hides and the panel anchors beside it; the
 *     screen unregisters on unmount and the orb comes back.
 */
import { useSyncExternalStore } from 'react';

type Listener = () => void;
let anchor: HTMLElement | null = null;
let pending: { question?: string; at: number } | null = null;
const listeners = new Set<Listener>();

function emit() { listeners.forEach((l) => l()); }

export function setTalkAnchor(el: HTMLElement | null): void {
  if (anchor === el) return;
  anchor = el;
  emit();
}

export function getTalkAnchor(): HTMLElement | null {
  return anchor;
}

export function openTalk(question?: string): void {
  pending = { question, at: Date.now() };
  emit();
}

/** The panel takes the request so a re-render does not repeat it. */
export function takeTalkRequest(): { question?: string } | null {
  const p = pending;
  pending = null;
  return p;
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useTalkAnchor(): HTMLElement | null {
  return useSyncExternalStore(subscribe, getTalkAnchor, getTalkAnchor);
}

/** A changing number the panel subscribes to; it reads the request with `takeTalkRequest`. */
export function useTalkRequestTick(): number {
  return useSyncExternalStore(subscribe, () => pending?.at ?? 0, () => 0);
}

export function _resetTalkBus(): void {
  anchor = null;
  pending = null;
  listeners.clear();
}
