import { describe, expect, test } from 'bun:test';
import {
  ARCH_TABS, ENGINE_STATES, LEARNING_STEPS, LOCAL_PARTS, REMOTE_SERVICES, RUNS_WHERE, SPHERE_STATES,
  TRIP, TRIP_ORDER, archTabFromHash, memoryCountLabel, sphereStateColor, topCategories,
} from './betaArchitecture';
import { ICON_PATHS } from '@/components/atlas/icons';

describe('How Atlas works', () => {
  test('a hash opens one of the five sections, and only those', () => {
    expect(ARCH_TABS.map((t) => t.key)).toEqual(['overview', 'providers', 'memory', 'learning', 'sphere']);
    expect(archTabFromHash('#memory')).toBe('memory');
    expect(archTabFromHash('#Sphere')).toBe('sphere');
    expect(archTabFromHash('#agent')).toBeNull();
    expect(archTabFromHash('')).toBeNull();
  });

  test('the sphere section explains every state the engine has, once each', () => {
    const listed = SPHERE_STATES.map((s) => s.state);
    expect([...listed].sort()).toEqual([...ENGINE_STATES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  test('state dots use the engine’s tints; resting has none', () => {
    expect(sphereStateColor('idle')).toBe('#c8c3bb');
    expect(sphereStateColor('alert')).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(sphereStateColor('listening')).not.toBe(sphereStateColor('thinking'));
  });

  test('the trip list walks every box of the diagram', () => {
    expect([...TRIP_ORDER].sort()).toEqual(Object.keys(TRIP).sort());
  });

  test('speech is not claimed as local, and every remote service says what it never sees', () => {
    // ElevenLabs does speech-to-text and the voice (services/voice-gateway).
    // The design put both on this Mac; this page must not.
    const speech = RUNS_WHERE.find((r) => /speech/i.test(r.what));
    expect(speech?.local).toBe(false);
    expect(REMOTE_SERVICES.some((s) => s.name === 'ElevenLabs')).toBe(true);
    for (const s of REMOTE_SERVICES) {
      expect(s.sees.length).toBeGreaterThan(0);
      expect(s.never.length).toBeGreaterThan(0);
    }
  });

  test('local parts draw real glyphs; learning steps have unique keys', () => {
    for (const p of LOCAL_PARTS) expect(ICON_PATHS[p.icon]).toBeTruthy();
    expect(new Set(LEARNING_STEPS.map((s) => s.key)).size).toBe(LEARNING_STEPS.length);
  });

  test('counts and categories come from what the brain returned', () => {
    expect(memoryCountLabel(412)).toBe('412');
    expect(memoryCountLabel(500)).toBe('500+');
    const cats = topCategories({ work: [1, 2, 3], life_events: [1], joys: [1, 2], a: [1], b: [1], c: [1], d: [1], e: [1] }, 3);
    expect(cats).toEqual({ shown: ['work', 'joys', 'a'], more: 5 });
    expect(topCategories({}).shown).toEqual([]);
  });
});
