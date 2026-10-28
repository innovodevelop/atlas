import { describe, expect, test } from 'bun:test';
import type { Device, Track } from './musicSpotify';
import {
  DEFAULT_PREFS, DUCK_DROP, MOODS, NO_SOURCE, RESUME_TAIL_MS, THIS_MAC, WIND_MAX_STEPS, WIND_STEP, afterEnd, albumLine,
  effectiveVolume, episodeLeft, handoffUris, moodOf, neighbour, nextLine, outputLine, parsePrefs, parseStationPicks,
  prevIntent, queueSummary, ratioAt, resumeFrom, roomIcon, roomMove, roomsFrom, sameSource, shouldDuck, sourceLabel,
  startOf, stationLine, stationPrompt, volumeLabel,
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
    expect(parsePrefs('{"shuffle":true,"repeat":true,"volume":0.3}')).toEqual({ shuffle: true, repeat: true, volume: 0.3, duck: true });
    expect(parsePrefs('{"duck":false}').duck).toBe(false);
    expect(parsePrefs('{"duck":"no"}').duck).toBe(true);
    expect(parsePrefs('{"volume":7}').volume).toBe(1);
  });
});

describe('sources, the moods', () => {
  test('a mood station is labelled and compared by its mood', () => {
    expect(sourceLabel({ kind: 'mood', mood: 'wind' })).toBe('Wind down · picked by Atlas');
    expect(sameSource({ kind: 'mood', mood: 'run' }, { kind: 'mood', mood: 'run' })).toBe(true);
    expect(sameSource({ kind: 'mood', mood: 'run' }, { kind: 'mood', mood: 'cook' })).toBe(false);
  });
});

describe('afterEnd with an announced Up next', () => {
  test('plays what it said was next when that is still queued', () => {
    expect(afterEnd(Q, Q[0], false, true, () => 0, Q[2])?.id).toBe('c');
    // Not queued any more, or the record itself: fall back to the neighbour.
    expect(afterEnd(Q, Q[0], false, false, Math.random, t('gone'))?.id).toBe('b');
    expect(afterEnd(Q, Q[0], false, false, Math.random, Q[0])?.id).toBe('b');
    // Repeat still wins.
    expect(afterEnd(Q, Q[0], true, false, Math.random, Q[2])?.id).toBe('a');
  });
});

describe('the record lines', () => {
  test('album with the year, or Single', () => {
    expect(albumLine({ album: 'Low Sun', year: '2026' })).toBe('Low Sun · 2026');
    expect(albumLine({ album: 'Low Sun', year: null })).toBe('Low Sun');
    expect(albumLine({ album: '', year: '1999' })).toBe('Single · 1999');
    expect(albumLine({ album: '' })).toBe('Single');
  });
  test('Up next line', () => {
    expect(nextLine(null)).toBe('');
    expect(nextLine({ title: 'Golden Hour', artist: 'Vela Sunn' })).toBe('Golden Hour · Vela Sunn');
    expect(nextLine({ title: 'Golden Hour', artist: '' })).toBe('Golden Hour');
  });
});

describe('ducking and Wind down', () => {
  test('ducks while Atlas wakes, listens, thinks or speaks, and only when switched on', () => {
    for (const st of ['waking', 'listening', 'thinking', 'speaking'] as const) expect(shouldDuck(st, true)).toBe(true);
    expect(shouldDuck('speaking', false)).toBe(false);
    expect(shouldDuck('idle', true)).toBe(false);
  });
  test('the duck lowers the slider by a fixed amount, never below zero', () => {
    expect(effectiveVolume(1, false)).toBe(1);
    expect(effectiveVolume(1, true)).toBe(1 - DUCK_DROP);
    expect(effectiveVolume(0.2, true)).toBe(0);
    expect(effectiveVolume(2, false)).toBe(1);
  });
  test('Wind down steps softer, and stops after its last step', () => {
    expect(effectiveVolume(1, false, 2)).toBe(1 - 2 * WIND_STEP);
    expect(effectiveVolume(1, false, 99)).toBe(Math.round((1 - WIND_MAX_STEPS * WIND_STEP) * 1000) / 1000);
    expect(effectiveVolume(1, true, 1)).toBe(Math.round((1 - WIND_STEP - DUCK_DROP) * 1000) / 1000);
  });
});

describe('mood stations', () => {
  test('the four stations, and Focus for an unknown key', () => {
    expect(MOODS.map((m) => m.key)).toEqual(['focus', 'wind', 'cook', 'run']);
    expect(moodOf('cook').title).toBe('Cooking');
  });
  test('the prompt carries titles and artists only, numbered', () => {
    const pool = [
      { title: 'Xtal', artist: 'Aphex Twin', id: 'SECRETID', album: 'SAW', uri: 'spotify:track:SECRETID' },
      { title: 'Two\nLines', artist: 'Some  One' },
    ];
    const text = stationPrompt(moodOf('wind'), pool, 10);
    expect(text).toContain('1. Xtal — Aphex Twin');
    expect(text).toContain('2. Two Lines — Some One');
    expect(text).toContain('liveliest to the softest');
    expect(text).toContain('up to 10');
    expect(text).not.toContain('SECRETID');
    expect(text).not.toContain('SAW');
  });
  test('picks are read from the longest run of numbers, deduplicated and in range', () => {
    expect(parseStationPicks('Here are 25 picks: 3, 1, 3, 99, 2', 10)).toEqual([2, 0, 1]);
    expect(parseStationPicks('4\n2\n7', 10)).toEqual([3, 1, 6]);
    expect(parseStationPicks('5', 10)).toEqual([4]);
    expect(parseStationPicks('no idea', 10)).toEqual([]);
    expect(parseStationPicks('1, 2, 3, 4', 10, 2)).toEqual([0, 1]);
  });
});

const dev = (id: string, o: Partial<Device> = {}): Device => ({
  id, name: id, type: 'Speaker', active: false, restricted: false, volume: 40, supportsVolume: true, ...o,
});

describe('rooms', () => {
  test('device types map to the icon set', () => {
    expect(roomIcon('Computer')).toBe('mac');
    expect(roomIcon('Smartphone')).toBe('iphone');
    expect(roomIcon('TV')).toBe('display');
    expect(roomIcon('Speaker')).toBe('speaker');
    expect(roomIcon('CastAudio')).toBe('speaker');
  });
  test('this Mac first and active when Atlas plays, or when nothing does', () => {
    const r = roomsFrom([dev('kitchen', { active: true })], { atlasOwnsAudio: true, isPlaying: true, macVolume: 0.5 });
    expect(r.map((x) => x.id)).toEqual([THIS_MAC, 'kitchen']);
    expect(r[0].active).toBe(true);
    expect(r[0].volume).toBe(50);
    expect(r[0].detail).toContain('playing');
    expect(r[1].active).toBe(false);
    const idle = roomsFrom([dev('kitchen')], { atlasOwnsAudio: false, isPlaying: false, macVolume: 1 });
    expect(idle[0].active).toBe(true);
  });
  test('a Connect device is the room when Spotify says so and Atlas is not playing', () => {
    const r = roomsFrom([dev('kitchen', { active: true }), dev('tv', { restricted: true, supportsVolume: false, volume: null })], { atlasOwnsAudio: false, isPlaying: false, macVolume: 1 });
    expect(r[0].active).toBe(false);
    expect(r[1].active).toBe(true);
    expect(r[1].detail).toContain('paused');
    expect(r[2].volume).toBeNull();
    expect(r[2].detail).toContain('no remote control');
  });
  test('what a choice of room does', () => {
    const base = { hasTrack: true, atlasOwnsAudio: true, activeDeviceId: null };
    expect(roomMove(THIS_MAC, base).kind).toBe('stay');
    expect(roomMove('kitchen', base)).toEqual({ kind: 'mac-to-device', to: 'kitchen' });
    expect(roomMove('kitchen', { ...base, atlasOwnsAudio: false, activeDeviceId: 'phone' })).toEqual({ kind: 'device-to-device', to: 'kitchen' });
    expect(roomMove(THIS_MAC, { ...base, atlasOwnsAudio: false, activeDeviceId: 'phone' })).toEqual({ kind: 'to-mac', from: 'phone' });
    expect(roomMove('phone', { ...base, atlasOwnsAudio: false, activeDeviceId: 'phone' }).kind).toBe('stay');
    expect(roomMove('kitchen', { ...base, hasTrack: false }).kind).toBe('blocked');
    expect(roomMove('tv', { ...base, targetRestricted: true }).kind).toBe('blocked');
  });
  test('a speaker is handed the record and the rest of Up next; an episode goes alone', () => {
    expect(handoffUris(Q, Q[1])).toEqual(['spotify:track:b', 'spotify:track:c', 'spotify:track:d']);
    expect(handoffUris(Q, Q[1], 2)).toEqual(['spotify:track:b', 'spotify:track:c']);
    expect(handoffUris(Q, t('x'))).toEqual(['spotify:track:x']);
    const ep: Track = { ...t('e'), uri: 'spotify:episode:e', kind: 'episode' };
    expect(handoffUris([...Q, ep], ep)).toEqual(['spotify:episode:e']);
    expect(handoffUris([Q[0], ep, Q[1]], Q[0])).toEqual(['spotify:track:a', 'spotify:track:b']);
  });
});

describe('podcast resume', () => {
  const dur = 60 * 60000;
  test('Atlas\'s own place wins over Spotify\'s', () => {
    expect(resumeFrom({ local: { positionMs: 120000 }, spotify: { positionMs: 900000, fullyPlayed: false }, durationMs: dur })).toBe(120000);
    expect(resumeFrom({ local: null, spotify: { positionMs: 900000, fullyPlayed: false }, durationMs: dur })).toBe(900000);
  });
  test('played, barely started and nearly finished start from the top', () => {
    expect(resumeFrom({ local: null, spotify: { positionMs: 900000, fullyPlayed: true }, durationMs: dur })).toBe(0);
    expect(resumeFrom({ local: { positionMs: 3000 }, spotify: null, durationMs: dur })).toBe(0);
    expect(resumeFrom({ local: { positionMs: dur - RESUME_TAIL_MS + 1 }, spotify: null, durationMs: dur })).toBe(0);
    expect(resumeFrom({ local: null, spotify: null, durationMs: dur })).toBe(0);
  });
  test('the row line', () => {
    expect(episodeLeft(dur, 0)).toBe('60 min');
    expect(episodeLeft(dur, 28 * 60000)).toBe('32 min left');
    expect(episodeLeft(dur, dur)).toBe('Played');
    expect(episodeLeft(dur, dur - 1000)).toBe('Played');
  });
});
