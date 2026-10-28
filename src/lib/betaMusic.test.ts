import { describe, expect, test } from 'bun:test';
import type { Track } from '@/hooks/useMusicPlayer';
import {
  DEFAULT_PREFS, NO_SOURCE, afterEnd, neighbour, outputLine, parsePrefs, prevIntent, queueSummary, ratioAt, sameSource,
  sourceLabel, startOf, stationLine, volumeLabel,
} from './betaMusic';

const t = (id: string, durationMs = 200000): Track => ({ id, uri: `spotify:track:${id}`, title: id, artist: 'a', album: 'b', artUrl: null, durationMs });
const Q = [t('a'), t('b'), t('c'), t('d')];

describe('sources', () => {
  test('labels', () => {
    expect(sourceLabel(NO_SOURCE)).toBe('Up next');
    expect(sourceLabel({ kind: 'library' })).toBe('Liked songs');
    expect(sourceLabel({ kind: 'playlist', id: 'p1', name: 'Evening' })).toBe('Evening');
    expect(sourceLabel({ kind: 'search', query: 'arnalds' })).toBe('Search · arnalds');
  });
  test('sameness is by identity, not by label', () => {
    expect(sameSource({ kind: 'playlist', id: 'p1', name: 'A' }, { kind: 'playlist', id: 'p1', name: 'B' })).toBe(true);
    expect(sameSource({ kind: 'playlist', id: 'p1', name: 'A' }, { kind: 'playlist', id: 'p2', name: 'A' })).toBe(false);
    expect(sameSource({ kind: 'search', query: 'x' }, { kind: 'search', query: 'y' })).toBe(false);
    expect(sameSource({ kind: 'library' }, { kind: 'library' })).toBe(true);
    expect(sameSource({ kind: 'library' }, NO_SOURCE)).toBe(false);
  });
});

describe('prevIntent', () => {
  test('restarts after four seconds, steps back before', () => {
    expect(prevIntent(0)).toBe('previous');
    expect(prevIntent(4000)).toBe('previous');
    expect(prevIntent(4001)).toBe('restart');
  });
});

describe('neighbour', () => {
  test('steps and wraps both ways', () => {
    expect(neighbour(Q, 'a', 1)?.id).toBe('b');
    expect(neighbour(Q, 'd', 1)?.id).toBe('a');
    expect(neighbour(Q, 'a', -1)?.id).toBe('d');
    expect(neighbour(Q, 'c', -1)?.id).toBe('b');
  });
  test('a current track outside the queue steps to an end', () => {
    expect(neighbour(Q, 'zzz', 1)?.id).toBe('a');
    expect(neighbour(Q, null, 1)?.id).toBe('a');
    expect(neighbour(Q, null, -1)?.id).toBe('d');
  });
  test('nothing to step to', () => {
    expect(neighbour([], 'a', 1)).toBeNull();
    expect(neighbour([t('a')], 'a', 1)).toBeNull();
    expect(neighbour([t('a')], null, 1)?.id).toBe('a');
  });
  test('shuffle never picks the current track and reaches every other', () => {
    const seen = new Set<string>();
    for (let k = 0; k < 40; k++) {
      const pick = neighbour(Q, 'b', 1, true, () => k / 40);
      expect(pick).not.toBeNull();
      expect(pick!.id).not.toBe('b');
      seen.add(pick!.id);
    }
    expect([...seen].sort()).toEqual(['a', 'c', 'd']);
    // A generator that returns exactly 1 must still stay in range.
    expect(neighbour(Q, 'b', 1, true, () => 1)!.id).not.toBe('b');
  });
});

describe('startOf', () => {
  test('first track, or any track under shuffle', () => {
    expect(startOf([])).toBeNull();
    expect(startOf(Q)?.id).toBe('a');
    expect(startOf(Q, true, () => 0)?.id).toBe('a');
    expect(startOf(Q, true, () => 0.6)?.id).toBe('c');
    expect(startOf(Q, true, () => 1)?.id).toBe('d');
  });
});

describe('afterEnd', () => {
  test('repeat plays the same record again, queued or not', () => {
    expect(afterEnd(Q, Q[1], true)?.id).toBe('b');
    expect(afterEnd([], t('x'), true)?.id).toBe('x');
  });
  test('the queue moves on and wraps, as the design does', () => {
    expect(afterEnd(Q, Q[1], false)?.id).toBe('c');
    expect(afterEnd(Q, Q[3], false)?.id).toBe('a');
    expect(afterEnd(Q, Q[1], false, true, () => 0)?.id).not.toBe('b');
  });
  test('a record from outside the queue is left ended', () => {
    expect(afterEnd(Q, t('elsewhere'), false)).toBeNull();
    expect(afterEnd([t('a')], t('a'), false)).toBeNull();
  });
});

describe('outputLine', () => {
  test('this Mac unless another device holds the record', () => {
    expect(outputLine({ hasTrack: false, atlasOwnsAudio: false, deviceName: 'iPhone' })).toBe('This Mac');
    expect(outputLine({ hasTrack: true, atlasOwnsAudio: true, deviceName: null })).toBe('This Mac');
    expect(outputLine({ hasTrack: true, atlasOwnsAudio: false, deviceName: 'iPhone' })).toBe('iPhone');
    expect(outputLine({ hasTrack: true, atlasOwnsAudio: false, deviceName: null })).toBe('Spotify');
  });
});

describe('formats', () => {
  test('queue summary', () => {
    expect(queueSummary([])).toBe('');
    expect(queueSummary([t('a', 180000)])).toBe('1 track · 3 min');
    expect(queueSummary(Q)).toBe('4 tracks · 13 min');
  });
  test('station line and volume', () => {
    expect(stationLine({ trackCount: 1 })).toBe('1 track');
    expect(stationLine({ trackCount: 48 })).toBe('48 tracks');
    expect(volumeLabel(0.5)).toBe('50%');
    expect(volumeLabel(2)).toBe('100%');
    expect(volumeLabel(-1)).toBe('0%');
  });
  test('ratio of a click', () => {
    expect(ratioAt(150, 100, 100)).toBe(0.5);
    expect(ratioAt(50, 100, 100)).toBe(0);
    expect(ratioAt(500, 100, 100)).toBe(1);
    expect(ratioAt(10, 0, 0)).toBe(0);
  });
});

describe('prefs', () => {
  test('defaults for nothing, garbage and partial records', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('not json')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"shuffle":"yes","volume":"loud"}')).toEqual(DEFAULT_PREFS);
  });
  test('reads what was saved and clamps the volume', () => {
    expect(parsePrefs('{"shuffle":true,"repeat":true,"volume":0.3}')).toEqual({ shuffle: true, repeat: true, volume: 0.3 });
    expect(parsePrefs('{"volume":7}').volume).toBe(1);
  });
});
