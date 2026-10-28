import { describe, expect, test } from 'bun:test';
import { lineAt, lyricsView, parseLrc, plainLines } from './musicLyrics';

describe('parseLrc', () => {
  test('stamps of every precision, in time order', () => {
    const lines = parseLrc('[00:12.5] b\n[00:01.00] a\n[01:02.345] c\n[00:20] d\n[00:30:50] e');
    expect(lines).toEqual([
      { ms: 1000, text: 'a' },
      { ms: 12500, text: 'b' },
      { ms: 20000, text: 'd' },
      { ms: 30500, text: 'e' },
      { ms: 62345, text: 'c' },
    ]);
  });
  test('a line written once for several stamps (a chorus) becomes one line per stamp', () => {
    expect(parseLrc('[00:10.00][00:40.00] la la')).toEqual([{ ms: 10000, text: 'la la' }, { ms: 40000, text: 'la la' }]);
  });
  test('tags are dropped, the offset shifts every line sooner, empty stamped lines stay as breaks', () => {
    const lines = parseLrc('[ar:Someone]\n[ti:Song]\n[offset:+500]\n[00:10.00] one\n[00:15.00]\n\n[00:20.00] two\r\n');
    expect(lines).toEqual([{ ms: 9500, text: 'one' }, { ms: 14500, text: '' }, { ms: 19500, text: 'two' }]);
  });
  test('nothing in, nothing out', () => {
    expect(parseLrc(null)).toEqual([]);
    expect(parseLrc('just words')).toEqual([]);
  });
});

describe('lineAt', () => {
  const lines = parseLrc('[00:01.00] a\n[00:05.00] b\n[00:09.00] c');
  test('the last line that has started', () => {
    expect(lineAt(lines, 0)).toBe(-1);
    expect(lineAt(lines, 1000)).toBe(0);
    expect(lineAt(lines, 4999)).toBe(0);
    expect(lineAt(lines, 5000)).toBe(1);
    expect(lineAt(lines, 999999)).toBe(2);
    expect(lineAt([], 5000)).toBe(-1);
  });
});

describe('plainLines and lyricsView', () => {
  test('plain lyrics fold blank runs to one break and trim the ends', () => {
    expect(plainLines('\n a \n\n\n b \n\n')).toEqual(['a', '', 'b']);
    expect(plainLines(null)).toEqual([]);
  });
  test('timed lines first, then plain, then instrumental, then none', () => {
    const base = { found: true, instrumental: false, cached: false };
    expect(lyricsView({ ...base, synced: '[00:01.00] hi', plain: 'hi' }).kind).toBe('synced');
    // Timed lyrics with no words at all are not worth following.
    expect(lyricsView({ ...base, synced: '[00:01.00]', plain: 'hi' }).kind).toBe('plain');
    expect(lyricsView({ ...base, synced: null, plain: null, instrumental: true }).kind).toBe('instrumental');
    expect(lyricsView({ found: false, instrumental: false, synced: null, plain: null, cached: true }).kind).toBe('none');
    expect(lyricsView(null).kind).toBe('none');
  });
});
