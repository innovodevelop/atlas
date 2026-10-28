import { describe, expect, test } from 'bun:test';
import {
  appendSection, noteSection, parseSections, placeNotes, removeHeading, renameHeading, replaceSectionText,
  sectionAt, sectionsForPrompt,
} from './betaSchoolSections';

const DOC = 'Intro line\n# Analysis\nFirst point.\nSecond point.\n## Conclusion\nDone.';

describe('headings split a document into sections', () => {
  test('the text before the first heading, then each heading and its text', () => {
    const s = parseSections(DOC);
    expect(s.map((x) => [x.heading, x.level, x.text])).toEqual([
      [null, 0, 'Intro line'],
      ['Analysis', 1, 'First point.\nSecond point.'],
      ['Conclusion', 2, 'Done.'],
    ]);
    expect(s.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  test('no headings is one untitled section; a document that opens with a heading has no untitled one', () => {
    expect(parseSections('Just text').map((x) => x.heading)).toEqual([null]);
    expect(parseSections('').map((x) => [x.heading, x.text])).toEqual([[null, '']]);
    expect(parseSections('# A\nx').map((x) => x.heading)).toEqual(['A']);
    expect(parseSections('#hashtag\n#  Spaced ').map((x) => x.heading)).toEqual([null, 'Spaced']);
  });

  test('editing a section changes only its text', () => {
    const s = parseSections(DOC);
    expect(replaceSectionText(DOC, s[1], 'Rewritten.')).toBe('Intro line\n# Analysis\nRewritten.\n## Conclusion\nDone.');
    expect(replaceSectionText(DOC, s[0], '')).toBe('\n# Analysis\nFirst point.\nSecond point.\n## Conclusion\nDone.');
    expect(replaceSectionText(DOC, s[2], 'Done again.')).toBe('Intro line\n# Analysis\nFirst point.\nSecond point.\n## Conclusion\nDone again.');
  });

  test('writing into an empty section keeps the next heading a heading', () => {
    const between = '# A\n# B';
    expect(replaceSectionText(between, parseSections(between)[0], 'x')).toBe('# A\nx\n# B');
    const blank = '# A\n\n# B';
    expect(replaceSectionText(blank, parseSections(blank)[0], 'x')).toBe('# A\nx\n# B');
    const last = '# A';
    expect(replaceSectionText(last, parseSections(last)[0], 'x')).toBe('# A\nx');
    expect(parseSections(replaceSectionText(between, parseSections(between)[0], 'x')).map((s) => s.text)).toEqual(['x', '']);
  });

  test('typing a heading into a section starts a new one', () => {
    const s = parseSections('# A\nold');
    const next = replaceSectionText('# A\nold', s[0], 'old\n# New\nmore');
    expect(parseSections(next).map((x) => [x.heading, x.text])).toEqual([['A', 'old'], ['New', 'more']]);
  });

  test('renaming, removing and adding headings', () => {
    const s = parseSections(DOC);
    expect(renameHeading(DOC, s[2], 'Ending\nnow')).toBe('Intro line\n# Analysis\nFirst point.\nSecond point.\n## Ending now\nDone.');
    expect(removeHeading(DOC, s[1])).toBe('Intro line\nFirst point.\nSecond point.\n## Conclusion\nDone.');
    expect(removeHeading('Intro\n# B', parseSections('Intro\n# B')[1])).toBe('Intro');
    expect(appendSection('Intro')).toBe('Intro\n# ');
    expect(appendSection('')).toBe('# ');
    expect(parseSections(appendSection('Intro')).map((x) => x.heading)).toEqual([null, '']);
  });

  test('an offset finds its section, in the heading or the text', () => {
    const s = parseSections(DOC);
    expect(sectionAt(s, 0)?.section.index).toBe(0);
    expect(sectionAt(s, DOC.indexOf('# Analysis') + 3)).toMatchObject({ inHeading: true, section: { heading: 'Analysis' } });
    expect(sectionAt(s, DOC.indexOf('Second'))).toMatchObject({ inHeading: false, section: { heading: 'Analysis' } });
  });
});

describe('notes anchored to sections', () => {
  const sections = parseSections(DOC);

  test('by heading, case and spaces aside; the untitled section is ""; a renamed heading lets go', () => {
    expect(noteSection({ anchor: ' analysis ' }, sections)?.index).toBe(1);
    expect(noteSection({ anchor: '' }, sections)?.index).toBe(0);
    expect(noteSection({ anchor: 'Gone' }, sections)).toBeNull();
    expect(noteSection({ anchor: null }, sections)).toBeNull();
  });

  test('numbered in reading order, unanchored last', () => {
    const placed = placeNotes([
      { id: 'a', text: 'about the end', anchor: 'Conclusion' },
      { id: 'b', text: 'loose', anchor: null },
      { id: 'c', text: 'about the start', anchor: '' },
      { id: 'd', text: 'about the analysis', anchor: 'Analysis' },
    ], sections);
    expect(placed.map((p) => [p.n, p.note.id, p.section?.index ?? null])).toEqual([[1, 'c', 0], [2, 'd', 1], [3, 'a', 2], [4, 'b', null]]);
  });

  test('what Atlas reads: sections numbered under their headings', () => {
    expect(sectionsForPrompt(parseSections('# A\n\n# B\nx'))).toBe('[1] A\n(empty)\n\n[2] B\nx');
  });
});
