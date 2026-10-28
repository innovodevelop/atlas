import { describe, expect, test } from 'bun:test';
import {
  TEACH_CATEGORIES, canSendDraft, categoryLabel, teachCategoryOf, teachCountLabel, teachDateLabel,
  teachEyebrow, teachGapLine, teachGaps, teachMicLabel, teachPrompts, teachRows, teachTiles,
  teachValueText, teachVoiceChip, type TeachMemoryLike,
} from './betaTeach';

const mem = (id: string, category: string | null, created_at?: string, value: unknown = 'v'): TeachMemoryLike =>
  ({ id, key: `k-${id}`, value, category, created_at });

const NOW = new Date(2026, 9, 28, 15, 0, 0).getTime();
const day = (d: number, h = 10) => new Date(2026, 9, d, h, 0, 0).toISOString();

describe('categories', () => {
  test('stored categories fold onto the ones the teaching prompt names', () => {
    expect(teachCategoryOf('Relationship')).toBe('relationships');
    expect(teachCategoryOf('social')).toBe('relationships');
    expect(teachCategoryOf(' joy ')).toBe('joys');
    expect(teachCategoryOf('preferences')).toBe('preferences');
    expect(teachCategoryOf('')).toBe('general');
    expect(teachCategoryOf(null)).toBe('general');
    expect(categoryLabel('life_events')).toBe('Life events');
  });

  test('tiles: the eleven always, then every other category the brain used, most used first', () => {
    const tiles = teachTiles([mem('1', 'work'), mem('2', 'work'), mem('3', 'preferences'), mem('4', 'fact'), mem('5', 'fact'), mem('6', 'relationship')], 'work');
    expect(tiles.slice(0, 11).map((t) => t.key)).toEqual([...TEACH_CATEGORIES]);
    expect(tiles.slice(11).map((t) => t.key)).toEqual(['fact', 'preferences']);
    const work = tiles.find((t) => t.key === 'work');
    expect(work).toMatchObject({ count: 2, pips: 2, selected: true });
    expect(tiles.find((t) => t.key === 'relationships')?.count).toBe(1);
    // Nothing is lost: the tiles count every row.
    expect(tiles.reduce((n, t) => n + t.count, 0)).toBe(6);
  });

  test('pips cap at five', () => {
    const many = Array.from({ length: 9 }, (_, i) => mem(String(i), 'values'));
    expect(teachTiles(many, '').find((t) => t.key === 'values')?.pips).toBe(5);
  });
});

describe('gaps and prompts', () => {
  test('the gap line names up to three missing categories', () => {
    const gaps = teachGaps([mem('1', 'identity'), mem('2', 'personality')]);
    expect(gaps[0]).toBe('values');
    expect(teachGapLine(gaps)).toBe('Atlas hasn’t heard about your values, beliefs and feelings yet. The suggestions under the conversation start there.');
    expect(teachGapLine(['work'])).toContain('your work yet');
    expect(teachGapLine([])).toContain('every part of you');
  });

  test('prompts: the picked category first, then the gaps, never a repeat', () => {
    const memories = TEACH_CATEGORIES.filter((c) => c !== 'dreams' && c !== 'fears').map((c, i) => mem(String(i), c));
    expect(teachPrompts(memories, 'work').map((p) => p.category)).toEqual(['work', 'fears', 'dreams']);
    expect(teachPrompts(memories, '').map((p) => p.category)).toEqual(['fears', 'dreams', 'identity']);
    // A non-teaching tile (an extra category) has no question of its own.
    expect(teachPrompts(memories, 'fact').map((p) => p.category)).toEqual(['fears', 'dreams', 'identity']);
    for (const p of teachPrompts([], '')) expect(p.question.length).toBeGreaterThan(0);
  });
});

describe('the learned list', () => {
  test('newest first, filtered by tile, eight unfiltered', () => {
    const memories = Array.from({ length: 12 }, (_, i) => mem(String(i), i % 2 ? 'work' : 'joys', day(10 + i)));
    const rows = teachRows(memories, { selected: '', now: NOW });
    expect(rows).toHaveLength(8);
    expect(rows[0].id).toBe('11');
    const work = teachRows(memories, { selected: 'work', now: NOW });
    expect(work.every((r) => r.meta.startsWith('Work'))).toBe(true);
    expect(work).toHaveLength(6);
  });

  test('rows without a date sort last; fresh ids are marked', () => {
    const rows = teachRows([mem('a', 'work'), mem('b', 'work', day(27))], { selected: '', now: NOW, freshIds: new Set(['a']) });
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[1]).toMatchObject({ fresh: true, meta: 'Work' });
    expect(rows[0].meta).toBe('Work · Yesterday');
  });

  test('values print the way the Workshop printed them', () => {
    expect(teachValueText('plain')).toBe('plain');
    expect(teachValueText({ a: 1 })).toBe('{"a":1}');
    expect(teachValueText(null)).toBe('');
  });

  test('dates', () => {
    expect(teachDateLabel(day(28, 9), NOW)).toBe('Today');
    expect(teachDateLabel(day(27, 23), NOW)).toBe('Yesterday');
    expect(teachDateLabel(day(12), NOW)).toBe('12 Oct');
    expect(teachDateLabel(undefined, NOW)).toBe('');
  });
});

describe('labels', () => {
  test('the count admits the query limit', () => {
    expect(teachCountLabel(12)).toBe('12');
    expect(teachCountLabel(50)).toBe('50+');
    expect(teachEyebrow(1, false)).toBe('Teach · 1 thing kept');
    expect(teachEyebrow(50, true)).toBe('Teach · 50+ things kept · listening');
  });

  test('the microphone label follows connection, turn and listening mode', () => {
    expect(teachMicLabel({ isConnected: false, isProcessing: false, listeningMode: 'passive' })).toBe('Tap to talk');
    expect(teachMicLabel({ isConnected: true, isProcessing: true, listeningMode: 'active' })).toBe('Thinking…');
    expect(teachMicLabel({ isConnected: true, isProcessing: false, listeningMode: 'active' })).toBe('Listening · tap to stop');
    expect(teachMicLabel({ isConnected: true, isProcessing: false, listeningMode: 'passive' })).toBe('Say “Atlas” to start');
  });

  test('the voice chip keeps the Workshop pill’s four states and their controls', () => {
    const base = { listeningMode: 'passive' as const, retryCount: 0, maxRetries: 3 };
    expect(teachVoiceChip({ ...base, voiceStatus: 'disconnected' })).toEqual({ label: 'Voice off', tone: 'idle', action: 'connect' });
    expect(teachVoiceChip({ ...base, voiceStatus: 'error' }).action).toBe('retry');
    expect(teachVoiceChip({ ...base, voiceStatus: 'connecting', retryCount: 2 }).label).toBe('Retry 2/3…');
    expect(teachVoiceChip({ ...base, voiceStatus: 'connected', listeningMode: 'active' }).tone).toBe('live');
    expect(teachVoiceChip({ ...base, voiceStatus: 'connected' }).action).toBeNull();
  });

  test('send needs text and no turn in flight', () => {
    expect(canSendDraft('  ', false)).toBe(false);
    expect(canSendDraft('hi', true)).toBe(false);
    expect(canSendDraft('hi', false)).toBe(true);
  });
});
