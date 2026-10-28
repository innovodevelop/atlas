/**
 * Two hooks the School views share.
 *
 * `useNow` is the screen's clock: it ticks only while something on screen
 * moves (the hero clock, a running session, the focus timer) and only while
 * the window is active, so a School screen left open overnight is not a
 * timer firing every second into a hidden webview. The focus timer keeps an
 * end time rather than counting ticks, so it is right again the moment the
 * window comes back.
 *
 * `useAsk` runs one question to the brain (`askAtlas`), streamed, abortable:
 * a new question or leaving the view aborts the one in flight, and the sphere
 * follows along through the state bus — thinking while it waits, a short
 * success or alert after.
 *
 * Two asks can run at once (Writing has a rewrite and margin notes), so the
 * sphere's state is counted, not toggled: it stays thinking until the last
 * School ask settles. And the screen only ever puts back a state it set
 * itself — when the bus has moved on to another publisher (a voice turn, an
 * agent run), finishing or leaving School must not reset it to idle.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { askAtlas } from '@/lib/askAtlas';
import { getAtlasState, publishAtlasState } from '@/lib/atlasStateBus';
import { useWindowActivity } from '@/hooks/useWindowActivity';

export function useNow(intervalMs: number, enabled = true): number {
  const active = useWindowActivity();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled || !active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs, enabled, active]);
  return now;
}

/** The page's toast: a line of text, with Undo when `undo` is given. */
export type SchoolToast = (text: string, undo?: () => void) => void;

const SOURCE = 'school';
const SETTLE_MS = 1800;

/** School asks in flight across every view; the sphere thinks while any is. */
let inFlight = 0;
let settleTimer: number | null = null;

function clearSettle(): void {
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  settleTimer = null;
}

/** Puts the sphere back to idle, but only if School is still the one driving it. */
function releaseBus(): void {
  if (getAtlasState().source === SOURCE) publishAtlasState('idle', SOURCE);
}

function beginAsk(): void {
  inFlight += 1;
  clearSettle();
  publishAtlasState('thinking', SOURCE);
}

/** One ask ended: the last one out shows how it went, briefly, then rests. */
function endAsk(outcome: 'success' | 'alert' | 'cancelled'): void {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight > 0) return;
  if (outcome === 'cancelled') { releaseBus(); return; }
  if (getAtlasState().source !== SOURCE) return;
  publishAtlasState(outcome, SOURCE);
  clearSettle();
  settleTimer = window.setTimeout(() => { settleTimer = null; releaseBus(); }, SETTLE_MS);
}

export interface Ask {
  /** Resolves with the whole answer, or null when it failed or was cancelled. */
  ask: (prompt: string, onText?: (text: string) => void) => Promise<string | null>;
  cancel: () => void;
  busy: boolean;
  error: string | null;
  clearError: () => void;
}

export function useAsk(): Ask {
  const ctrl = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leaving the view aborts the ask in flight; its own `finally` settles the bus.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ctrl.current?.abort(); };
  }, []);

  const ask = useCallback(async (prompt: string, onText?: (text: string) => void) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(null);
    beginAsk();
    let outcome: 'success' | 'alert' | 'cancelled' = 'cancelled';
    try {
      const result = await askAtlas(prompt, { screen: 'School', signal: c.signal, onText });
      if (c.signal.aborted) return null;
      if (!result.text.trim()) throw new Error('Atlas sent an empty reply.');
      outcome = 'success';
      return result.text;
    } catch (e) {
      if (c.signal.aborted) return null;
      outcome = 'alert';
      if (mounted.current) setError(e instanceof Error ? e.message : 'Atlas did not answer.');
      return null;
    } finally {
      endAsk(outcome);
      if (ctrl.current === c) {
        ctrl.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    setBusy(false);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { ask, cancel, busy, error, clearError };
}
