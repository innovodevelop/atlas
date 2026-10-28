/**
 * Which runs count as being worked. Home's sphere says "working" while
 * `activeRun` is set, and the runs are re-read every few seconds while any is
 * followed — so a run the user paused, possibly for days, must count as
 * neither, and a pending run nothing picked up must not be polled forever.
 */
import { describe, expect, test } from 'bun:test';
import { PENDING_FOLLOW_MS, followsRun, isWorkingRun } from '@/hooks/useAgentRuns';

const NOW = Date.parse('2026-10-28T09:10:00Z');
const run = (status: string, over: { paused_at?: string | null; created_at?: string } = {}) => ({
  status, created_at: over.created_at ?? '2026-10-28T09:09:00Z', paused_at: over.paused_at ?? null,
});

describe('a run being worked', () => {
  test('live and not paused', () => {
    for (const s of ['pending', 'planning', 'running', 'verifying']) expect(isWorkingRun(run(s))).toBe(true);
    for (const s of ['completed', 'failed', 'cancelled']) expect(isWorkingRun(run(s))).toBe(false);
  });
  test('a paused run is not working, and is not polled', () => {
    const paused = run('running', { paused_at: '2026-10-26T09:00:00Z' });
    expect(isWorkingRun(paused)).toBe(false);
    expect(followsRun(paused, NOW)).toBe(false);
    // A database older than the column has no paused_at at all.
    expect(isWorkingRun({ status: 'running', created_at: '2026-10-28T09:00:00Z' })).toBe(true);
  });
  test('a pending run is followed only while the brain could still pick it up', () => {
    expect(followsRun(run('pending'), NOW)).toBe(true);
    const old = new Date(NOW - PENDING_FOLLOW_MS - 1_000).toISOString();
    expect(followsRun(run('pending', { created_at: old }), NOW)).toBe(false);
    // A run that is working is followed however old it is.
    expect(followsRun(run('running', { created_at: old }), NOW)).toBe(true);
  });
});
