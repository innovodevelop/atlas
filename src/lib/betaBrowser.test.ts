import { describe, expect, test } from 'bun:test';
import {
  askRefusal, displayAddress, externalUrl, findCountLabel, goRefusal, heroLine,
  modeForShortcut, nextMode, noticeLine, segmentsFor, stepCursor, tabCountLabel,
} from './betaBrowser';
import { findMatches } from './mocks/browser';

describe('modes', () => {
  test('the chip cycles go → ask → find → go', () => {
    expect(nextMode('go')).toBe('ask');
    expect(nextMode('ask')).toBe('find');
    expect(nextMode('find')).toBe('go');
  });
  test('⌘L / ⌘K / ⌘F pick a mode, nothing else does', () => {
    expect(modeForShortcut('l')).toBe('go');
    expect(modeForShortcut('K')).toBe('ask');
    expect(modeForShortcut('f')).toBe('find');
    expect(modeForShortcut('j')).toBeNull();
  });
});

describe('find cursor', () => {
  test('wraps both ways', () => {
    expect(stepCursor(0, 3, 1)).toBe(1);
    expect(stepCursor(2, 3, 1)).toBe(0);
    expect(stepCursor(0, 3, -1)).toBe(2);
    expect(stepCursor(5, 0, 1)).toBe(0);
  });
  test('count label', () => {
    expect(findCountLabel(0, 7)).toBe('1 of 7');
    expect(findCountLabel(9, 3)).toBe('3 of 3');
    expect(findCountLabel(0, 0)).toBe('No matches');
  });
});

describe('segmentsFor', () => {
  const text = 'The pause, and the pause again.';
  const page = {
    kicker: '', headline: text, standfirst: 'pause', author: { name: '', initials: '' },
    published: '', readMinutes: 1, paragraphs: [], figure: null, paragraphsAfter: [],
  };
  test('splits around every match and numbers hits page-wide', () => {
    const matches = findMatches(page, 'Pause');
    expect(matches.length).toBe(3);
    const segs = segmentsFor(text, 0, matches, 5);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(segs.filter((s) => s.hit !== null).map((s) => s.hit)).toEqual([0, 1]);
    expect(segs[1]).toEqual({ text: 'pause', hit: 0 });
    // The standfirst's match is the page's third, whatever block it sits in.
    expect(segmentsFor('pause', 1, matches, 5)).toEqual([{ text: 'pause', hit: 2 }]);
  });
  test('plain text with no query or no match in the block', () => {
    expect(segmentsFor(text, 0, [], 0)).toEqual([{ text, hit: null }]);
    expect(segmentsFor('nothing here', 4, findMatches(page, 'pause'), 5)).toEqual([{ text: 'nothing here', hit: null }]);
  });
});

describe('externalUrl', () => {
  test('adds https to a bare host and keeps paths', () => {
    expect(externalUrl('example.com')).toBe('https://example.com/');
    expect(externalUrl(' fieldnotes.press/2026/the-quiet-interface ')).toBe('https://fieldnotes.press/2026/the-quiet-interface');
    expect(externalUrl('HTTP://Example.com/a?b=1')).toBe('http://example.com/a?b=1');
  });
  test('localhost goes over http', () => {
    expect(externalUrl('localhost:5173')).toBe('http://localhost:5173/');
  });
  test('refuses other schemes, words and sentences', () => {
    expect(externalUrl('javascript:alert(1)')).toBeNull();
    expect(externalUrl('file:///etc/passwd')).toBeNull();
    expect(externalUrl('mailto:a@b.co')).toBeNull();
    expect(externalUrl('ftp://files.example.com')).toBeNull();
    expect(externalUrl('notaurl')).toBeNull();
    expect(externalUrl('is it noisy')).toBeNull();
    expect(externalUrl('')).toBeNull();
    expect(externalUrl('https://')).toBeNull();
  });
  test('display strips the scheme and the trailing slash', () => {
    expect(displayAddress('https://example.com/')).toBe('example.com');
    expect(displayAddress('http://a.b/c')).toBe('a.b/c');
  });
});

describe('copy', () => {
  test('tab counts', () => {
    expect(tabCountLabel(1)).toBe('open tab');
    expect(tabCountLabel(0)).toBe('open tabs');
  });
  test('the hero line names the sample, and day one', () => {
    expect(heroLine(5, true)).toContain('5 sample tabs');
    expect(heroLine(1, true)).toContain('1 sample tab ');
    expect(heroLine(0, true)).toContain('day one');
    expect(heroLine(2, false)).toBe('2 tabs open.');
    expect(noticeLine(3)).toContain('no browser engine');
    expect(noticeLine(0)).toContain('no tabs');
  });
});

describe('refusals', () => {
  test('an address can go to the user’s own browser', () => {
    const r = goRefusal('meridianlabs.org/research', 'meridianlabs.org/research');
    expect(r.kind).toBe('no-engine');
    if (r.kind !== 'no-engine') throw new Error('kind');
    expect(r.href).toBe('https://meridianlabs.org/research');
    expect(r.title).toContain('meridianlabs.org/research');
  });
  test('a sentence typed into Go is not an address', () => {
    const r = goRefusal('heat pump prices', 'heat pump prices');
    if (r.kind !== 'no-engine') throw new Error('kind');
    expect(r.href).toBeNull();
    expect(r.title).toContain('isn’t an address');
  });
  test('ask refusals say where a general answer lives', () => {
    const on = askRefusal('  Is it noisy? ', true);
    if (on.kind !== 'unanswerable') throw new Error('kind');
    expect(on.question).toBe('Is it noisy?');
    expect(on.body).toContain('Talk');
    expect(askRefusal('x', false).title).toBe('No page to answer from');
  });
});

