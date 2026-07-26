/**
 * Presence precedence. The ordering IS the design here — an alert that routine
 * activity can mask is worse than no alert, and a "muted" badge outranking an
 * active turn would contradict itself on screen.
 *
 * Tests the pure resolver rather than the hook, so no renderer (and no extra
 * dependency) is needed for the logic that actually matters.
 */
import { describe, expect, test } from 'bun:test';
import { resolvePresence, ATLAS_STATES } from '@/hooks/useAtlasPresence';

const NOW = 1_000_000;
const past = NOW - 1;      // a window that has expired
const future = NOW + 1000; // a window still open
const idle = { voiceState: 'idle' as const };

describe('resolvePresence', () => {
  test('idle by default', () => {
    expect(resolvePresence(idle, NOW, past, past)).toBe('idle');
  });

  test('voice states pass through', () => {
    for (const s of ['listening', 'thinking', 'speaking'] as const) {
      expect(resolvePresence({ voiceState: s }, NOW, past, past)).toBe(s);
    }
  });

  test('muted shows only when nothing else is happening', () => {
    expect(resolvePresence({ ...idle, muted: true }, NOW, past, past)).toBe('muted');
    // A turn cannot occur while muted, but if the gateway ever reported one,
    // rendering "muted" over it would be a visible contradiction.
    expect(resolvePresence({ voiceState: 'speaking', muted: true }, NOW, past, past)).toBe('speaking');
  });

  test('an active run shows working, and voice outranks it', () => {
    expect(resolvePresence({ ...idle, runActive: true }, NOW, past, past)).toBe('working');
    expect(resolvePresence({ voiceState: 'listening', runActive: true }, NOW, past, past)).toBe('listening');
  });

  test('success is not starved by a follow-on run', () => {
    // A new run starting immediately must not hide that the last one succeeded.
    expect(resolvePresence({ ...idle, runActive: true }, NOW, future, past)).toBe('success');
  });

  test('success does not outrank an active turn', () => {
    expect(resolvePresence({ voiceState: 'thinking' }, NOW, future, past)).toBe('thinking');
  });

  test('alert outranks everything', () => {
    const busy = { voiceState: 'speaking' as const, muted: true, runActive: true };
    expect(resolvePresence(busy, NOW, future, future)).toBe('alert');
  });

  test('transient windows expire', () => {
    expect(resolvePresence(idle, NOW, past, past)).toBe('idle');
    expect(resolvePresence({ ...idle, muted: true }, NOW, past, past)).toBe('muted');
  });

  test('waking and dissolving are cut from the reachable contract', () => {
    expect((ATLAS_STATES as readonly string[]).includes('waking')).toBe(false);
    expect((ATLAS_STATES as readonly string[]).includes('dissolving')).toBe(false);
    expect(ATLAS_STATES.length).toBe(8);
  });

  test('every reachable state is producible by the resolver', () => {
    const produced = new Set<string>([
      resolvePresence(idle, NOW, past, past),
      resolvePresence({ voiceState: 'listening' }, NOW, past, past),
      resolvePresence({ voiceState: 'thinking' }, NOW, past, past),
      resolvePresence({ voiceState: 'speaking' }, NOW, past, past),
      resolvePresence({ ...idle, runActive: true }, NOW, past, past),
      resolvePresence(idle, NOW, future, past),
      resolvePresence(idle, NOW, past, future),
      resolvePresence({ ...idle, muted: true }, NOW, past, past),
    ]);
    // The point of the whole stage: no state in the contract is a dead visual.
    expect([...produced].sort()).toEqual([...ATLAS_STATES].sort());
  });
});
