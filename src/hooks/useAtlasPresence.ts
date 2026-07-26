/**
 * Atlas presence — composes the sphere's state from the signals the app really
 * has, so the ten-state contract stops being mostly dead visuals.
 *
 * Before this, four states were reachable (idle / listening / thinking /
 * speaking, all from the voice gateway) and six were specified but never
 * assigned anywhere. See docs/design-sync/2026-07-26-audit-sphere-mail-header.md
 * §1.1. This hook wires four of the six to signals that already exist, and the
 * audit's recommendation to cut the other two is honoured in ATLAS_STATES below.
 *
 * Renderer-agnostic on purpose: both the WebGL sphere and the new canvas one
 * take a state string, so the trigger logic lives here rather than in either.
 */
import { useEffect, useRef, useState } from 'react';
import type { AIState } from '@/types';
import type { SphereState } from '@/lib/atlasSphere';

/**
 * The states Atlas can actually reach. `waking` and `dissolving` are
 * deliberately absent: "app open" is ~0.4 s in a desktop app that stays
 * running, so a 1.6 s fly-in only delays first paint, and "session end" has no
 * meaning in an app that is quit rather than logged out. The renderer still
 * implements both — they are one line away if a launch splash ever wants them.
 */
export const ATLAS_STATES = [
  'idle', 'listening', 'thinking', 'speaking', 'working', 'success', 'alert', 'muted',
] as const;

export type AtlasPresenceState = (typeof ATLAS_STATES)[number];

/** How long `success` and `alert` hold before falling back. */
const SUCCESS_MS = 2600;
const ALERT_MS = 4200;

export interface PresenceInput {
  /** Voice-gateway state — the base layer. */
  voiceState: AIState;
  /** Microphone gated off. */
  muted?: boolean;
  /** An agent run is executing (status running/pending). */
  runActive?: boolean;
  /** Monotonic marker that a run just finished successfully. */
  runCompletedAt?: number | null;
  /** Monotonic marker that something failed and the user should see it. */
  faultAt?: number | null;
}

/**
 * The precedence rule, as a pure function so it can be tested without a
 * renderer. Highest first:
 *
 *   alert     an error the user needs to notice, and it is transient — it must
 *             outrank everything or routine activity can mask it
 *   voice     listening/thinking/speaking are direct responses to the user and
 *             beat background work; they cannot occur while muted anyway
 *   success   transient, so a follow-on run does not starve it
 *   working   background task
 *   muted     nothing is happening AND the mic is off — the honest resting
 *             state, below voice so it can never contradict an active turn
 *   idle      default
 */
export function resolvePresence(
  input: PresenceInput,
  now: number,
  successUntil: number,
  alertUntil: number,
): AtlasPresenceState {
  const { voiceState, muted = false, runActive = false } = input;
  if (now < alertUntil) return 'alert';
  if (voiceState === 'listening' || voiceState === 'thinking' || voiceState === 'speaking') {
    return voiceState;
  }
  if (now < successUntil) return 'success';
  if (runActive) return 'working';
  if (muted) return 'muted';
  return 'idle';
}

export function useAtlasPresence(input: PresenceInput): AtlasPresenceState {
  const { voiceState, muted = false, runActive = false, runCompletedAt = null, faultAt = null } = input;

  const [, force] = useState(0);
  const successUntil = useRef(0);
  const alertUntil = useRef(0);
  const seenCompleted = useRef<number | null>(null);
  const seenFault = useRef<number | null>(null);

  // Start a transient window when a new marker arrives, and schedule the single
  // re-render that ends it — no interval, so an idle app stays idle.
  useEffect(() => {
    if (runCompletedAt && runCompletedAt !== seenCompleted.current) {
      seenCompleted.current = runCompletedAt;
      successUntil.current = Date.now() + SUCCESS_MS;
      const id = window.setTimeout(() => force((n) => n + 1), SUCCESS_MS);
      return () => window.clearTimeout(id);
    }
  }, [runCompletedAt]);

  useEffect(() => {
    if (faultAt && faultAt !== seenFault.current) {
      seenFault.current = faultAt;
      alertUntil.current = Date.now() + ALERT_MS;
      const id = window.setTimeout(() => force((n) => n + 1), ALERT_MS);
      return () => window.clearTimeout(id);
    }
  }, [faultAt]);

  return resolvePresence(
    { voiceState, muted, runActive },
    Date.now(),
    successUntil.current,
    alertUntil.current,
  );
}

/** Narrow to the renderer's wider union without a cast at every call site. */
export function toSphereState(s: AtlasPresenceState): SphereState {
  return s;
}
