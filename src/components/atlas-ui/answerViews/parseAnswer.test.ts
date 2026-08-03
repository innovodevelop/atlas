/**
 * Parser tests for the answer view.
 *
 * The parser is the whole honesty contract of the surface: every card on screen
 * is a block it emitted, so a block it invents is a value the app fabricated.
 * These lock the two directions that matter — structure the model really writes
 * is recognised, and structure it did not write is NOT inferred.
 */
import { describe, expect, test } from 'bun:test';
import { ANSWER_SPECIMENS } from '@/lib/mocks/answerViews';
import { answerSubline, parseAnswer, parseBlocks, planCards, splitHeadline } from './parseAnswer';

describe('parseBlocks', () => {
  test('paragraphs are joined across soft wraps and split on blank lines', () => {
    const blocks = parseBlocks('one line\nstill one\n\nsecond para');
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'one line still one' },
      { kind: 'paragraph', text: 'second para' },
    ]);
  });

  test('a fenced block keeps its language, its newlines and its markdown', () => {
    const blocks = parseBlocks('before\n\n```ts\nconst a = 1;\n// **not bold**\n```\n\nafter');
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', code: 'const a = 1;\n// **not bold**' });
    expect(blocks[2].kind).toBe('paragraph');
  });

  test('a bullet list of bold label/value lines becomes pairs', () => {
    const blocks = parseBlocks('- **Routing**: explicit asks only\n- **Fallback**: none');
    expect(blocks[0]).toEqual({
      kind: 'pairs',
      items: [
        { label: 'Routing', value: 'explicit asks only' },
        { label: 'Fallback', value: 'none' },
      ],
    });
  });

  test('prose bullets with a colon inside a sentence stay a list', () => {
    const blocks = parseBlocks(
      '- The point here is simple: an assistant that guesses about money is worse than one that says nothing at all\n' +
      '- And the second one runs long as well, so neither of these is a label',
    );
    expect(blocks[0].kind).toBe('bullets');
  });

  test('a single label/value bullet is not promoted to a pair table', () => {
    // One row is not a table; promoting it would put emphasis the model never wrote.
    expect(parseBlocks('- **Only**: one')[0].kind).toBe('bullets');
  });

  test('pipes without a separator row are not a table', () => {
    expect(parseBlocks('a | b | c')[0].kind).toBe('paragraph');
  });

  test('a pipe table parses head and rows', () => {
    const blocks = parseBlocks('| Tier | Share |\n| --- | --- |\n| Chat | 91% |\n| Research | 9% |');
    expect(blocks[0]).toEqual({
      kind: 'table',
      head: ['Tier', 'Share'],
      rows: [['Chat', '91%'], ['Research', '9%']],
    });
  });

  test('ordered and unordered lists do not merge into each other', () => {
    const blocks = parseBlocks('1. first\n2. second\n\n- loose\n- ends');
    expect(blocks[0]).toMatchObject({ kind: 'bullets', ordered: true });
    expect(blocks[1]).toMatchObject({ kind: 'bullets', ordered: false });
  });
});

describe('splitHeadline', () => {
  test('cuts at the last dash so the tail can take the accent colour', () => {
    expect(splitHeadline('Ready — except your packing.')).toEqual({
      lead: 'Ready — ', accent: 'except your packing.',
    });
  });

  test('falls back to a plain headline rather than inventing a flourish', () => {
    expect(splitHeadline('The house is fine.')).toEqual({ lead: 'The house is fine.', accent: '' });
  });
});

describe('sources', () => {
  test('the citations event and links in the prose are kept apart', () => {
    const parsed = parseAnswer('See [the page](https://example.org/a) for the text.', [
      { url: 'https://fieldnotes.press/x', domain: 'fieldnotes.press' },
    ]);
    expect(parsed.sources.map((s) => s.via)).toEqual(['citation', 'inline']);
    expect(parsed.sources[1].domain).toBe('example.org');
  });

  test('one url cited twice is one source', () => {
    const parsed = parseAnswer('https://example.org/a and again https://example.org/a', [
      { url: 'https://example.org/a' },
    ]);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0].via).toBe('citation');
  });

  test('an answer with no links has no sources — none are inferred', () => {
    expect(parseAnswer('Nothing to cite here.').sources).toHaveLength(0);
  });
});

describe('specimens', () => {
  test('every specimen parses to the shape it claims', () => {
    for (const s of ANSWER_SPECIMENS) {
      const parsed = parseAnswer(s.markdown, s.citations);
      if (s.id === 'empty') {
        expect(parsed.blocks).toHaveLength(0);
        expect(parsed.headline).toBeNull();
        continue;
      }
      expect(parsed.blocks.length).toBeGreaterThan(0);
      expect(parsed.headline).not.toBeNull();
      expect(planCards(parsed.blocks)).toHaveLength(parsed.blocks.length);
    }
  });

  test('the search specimen surfaces its inline link, the citations one its event', () => {
    const search = ANSWER_SPECIMENS.find((s) => s.id === 'search')!;
    const cited = ANSWER_SPECIMENS.find((s) => s.id === 'citations')!;
    expect(parseAnswer(search.markdown, search.citations).sources.every((s) => s.via === 'inline')).toBe(true);
    expect(parseAnswer(cited.markdown, cited.citations).sources.every((s) => s.via === 'citation')).toBe(true);
  });

  test('the subline never repeats the headline sentence', () => {
    const s = ANSWER_SPECIMENS.find((x) => x.id === 'prose')!;
    const parsed = parseAnswer(s.markdown, s.citations);
    expect(answerSubline(parsed.blocks).startsWith(parsed.headline!.lead)).toBe(false);
  });
});

describe('planCards', () => {
  test('the lead paragraph is full width and code and tables take the row', () => {
    const cards = planCards(parseBlocks('Lead sentence here.\n\n```\nx\n```'));
    expect(cards[0].cols).toBe(12);
    expect(cards[1]).toMatchObject({ cols: 12, rows: 2 });
  });
});
