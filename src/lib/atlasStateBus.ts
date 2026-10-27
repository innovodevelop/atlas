/**
 * The Atlas state bus — one source of truth for what Atlas is doing.
 *
 * The Beta guidelines put a sphere on every screen and say it "always reflects
 * Atlas's real state". Before this, that state lived inside whichever page had
 * mounted the voice session (the dashboard's `useAtlasPresence` result), so a
 * sphere on /mail could only guess. Now anything that KNOWS the state publishes
 * it here, and every sphere, the top bar and the dock avatar read it.
 *
 * Publishers today:
 *   - the dashboard's presence (voice gateway + agent runs + mute), via
 *     `publishAtlasState(state, 'presence')`
 *   - the Talk to Atlas panel's own turn (listening → thinking → speaking → idle)
 *
 * Precedence is by recency, not rank: the publisher that spoke last wins. That
 * is deliberate — the presence hook already applies the rank rule (alert beats
 * voice beats success beats working beats muted) before it publishes, and the
 * Talk panel only publishes during a turn it is running.
 *
 * `requestVoice` is the one message that goes the other way: the Talk panel's
 * mic button asks whoever owns the microphone (the dashboard's voice session,
 * or the Voice screen) to start a turn. No owner mounted → nothing happens and
 * the panel says so.
 */
import { useSyncExternalStore } from 'react';

export const ATLAS_BUS_STATES = [
  'idle', 'listening', 'thinking', 'speaking', 'working',
  'success', 'alert', 'muted', 'waking', 'dissolving',
] as const;
export type AtlasBusState = (typeof ATLAS_BUS_STATES)[number];

export interface AtlasStateSnapshot {
  state: AtlasBusState;
  /** `Date.now()` when this state was published. */
  since: number;
  /** Who published it — for the status line and for debugging. */
  source: string;
}

let snapshot: AtlasStateSnapshot = { state: 'idle', since: 0, source: 'boot' };
const listeners = new Set<() => void>();
const voiceOwners = new Set<() => void>();

export function getAtlasState(): AtlasStateSnapshot {
  return snapshot;
}

export function publishAtlasState(state: AtlasBusState, source: string): void {
  if (snapshot.state === state && snapshot.source === source) return;
  snapshot = { state, since: Date.now(), source };
  listeners.forEach((l) => l());
}

export function subscribeAtlasState(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The current state; re-renders on every publish. */
export function useAtlasState(): AtlasBusState {
  return useSyncExternalStore(subscribeAtlasState, () => snapshot.state, () => snapshot.state);
}

export function useAtlasStateSnapshot(): AtlasStateSnapshot {
  return useSyncExternalStore(subscribeAtlasState, getAtlasState, getAtlasState);
}

/** Register as the thing that can open the microphone. Returns the unregister. */
export function onVoiceRequest(start: () => void): () => void {
  voiceOwners.add(start);
  return () => { voiceOwners.delete(start); };
}

/** Ask the microphone owner to start a turn. True if someone answered. */
export function requestVoice(): boolean {
  if (voiceOwners.size === 0) return false;
  voiceOwners.forEach((start) => start());
  return true;
}

export function hasVoiceOwner(): boolean {
  return voiceOwners.size > 0;
}

/** Test seam. */
export function _resetAtlasStateBus(): void {
  snapshot = { state: 'idle', since: 0, source: 'boot' };
  listeners.clear();
  voiceOwners.clear();
}

/** What the state pill says, per the top bar reference (`atlas-topbar.js`). */
export const STATE_LABEL: Record<AtlasBusState, string> = {
  idle: 'Listening',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  working: 'Working',
  success: 'Done',
  alert: 'Needs you',
  muted: 'Muted',
  waking: 'Waking',
  dissolving: 'Closing',
};

/** The dot colour beside the label — the sphere tint table on paper. */
export const STATE_COLOUR: Record<AtlasBusState, string> = {
  idle: '#0fae76',
  listening: '#1696be',
  thinking: '#7854ff',
  speaking: '#3461f2',
  working: '#e07a1f',
  success: '#0fae76',
  alert: '#d0453a',
  muted: '#b6b1aa',
  waking: '#d6963c',
  dissolving: '#966eb4',
};
