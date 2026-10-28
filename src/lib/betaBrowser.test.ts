import { describe, expect, test } from 'bun:test';
import {
  EMPTY_BROWSER, MAX_HISTORY, answerBasis, askFailed, askWithoutPage, bylineFor, capCopy, clearHistory, closeTab,
  copySize, displayAddress, endLine, externalUrl, findCountLabel, findMatches, fitToBudget, goSuggestions, groupBlocks,
  heroLine, hostOf, initialFor, isKept, markFor, modeForShortcut, nextMode, notAnAddress, notOpened, notesBasis,
  openKept, openPage, pageTexts, parseBrowser, parseCopy, parseNotes, providerName, removeKept, segmentsFor, selectTab,
  selectedTab, setNotes, stepCursor, tabCountLabel, toggleKeep, tooManyTabs, visitedLabel,
  type BrowserState, type PageCopy,
} from './betaBrowser';

const NOW = new Date('2026-10-28T14:00:00Z');

function copy(url: string, extra: Partial<PageCopy> = {}): PageCopy {
  return {
    url,
    title: `Title of ${hostOf(url)}`,
    siteName: null,
    byline: null,
    lang: 'en',
    blocks: [
      { kind: 'paragraph', text: 'The pause, and the pause again.' },
      { kind: 'item', text: 'one' },
      { kind: 'item', text: 'two' },
      { kind: 'heading', text: 'Noise', level: 2 },
      { kind: 'quote', text: 'pause' },
    ],
    links: [{ text: 'Next', href: 'https://b.example/next' }],
    words: 460,
    clipped: false,
    truncated: false,
    fetchedAt: NOW.toISOString(),
    ...extra,
  };
}

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

describe('find', () => {
  const page = copy('https://a.example/');
  const texts = pageTexts(page);

  test('searches the title and every block, case-insensitively, in reading order', () => {
    expect(texts[0]).toBe('Title of a.example');
    const m = findMatches(texts, 'PAUSE');
    expect(m.map((x) => [x.block, x.offset])).toEqual([[1, 4], [1, 19], [5, 0]]);
    expect(findMatches(texts, '   ')).toEqual([]);
    expect(findMatches(pageTexts(null), 'x')).toEqual([]);
  });

  test('segments split around every match and number hits page-wide', () => {
    const text = texts[1];
    const matches = findMatches(texts, 'pause');
    const segs = segmentsFor(text, 1, matches, 5);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(segs.filter((s) => s.hit !== null).map((s) => s.hit)).toEqual([0, 1]);
    expect(segmentsFor('pause', 5, matches, 5)).toEqual([{ text: 'pause', hit: 2 }]);
    expect(segmentsFor(text, 1, [], 0)).toEqual([{ text, hit: null }]);
  });

  test('cursor wraps both ways; count label', () => {
    expect(stepCursor(2, 3, 1)).toBe(0);
    expect(stepCursor(0, 3, -1)).toBe(2);
    expect(stepCursor(5, 0, 1)).toBe(0);
    expect(findCountLabel(0, 7)).toBe('1 of 7');
    expect(findCountLabel(9, 3)).toBe('3 of 3');
    expect(findCountLabel(0, 0)).toBe('No matches');
  });

  test('groupBlocks gathers consecutive items, numbered as find numbers them', () => {
    const g = groupBlocks(page.blocks);
    expect(g.map((x) => x.type)).toEqual(['block', 'list', 'block', 'block']);
    const list = g[1];
    if (list.type !== 'list') throw new Error('list');
    expect(list.items.map((i) => i.n)).toEqual([2, 3]);
    const quote = g[3];
    if (quote.type !== 'block') throw new Error('block');
    expect(quote.n).toBe(5);
  });
});

describe('addresses', () => {
  test('adds https to a bare host and keeps paths', () => {
    expect(externalUrl('example.com')).toBe('https://example.com/');
    expect(externalUrl(' fieldnotes.press/2026/the-quiet-interface ')).toBe('https://fieldnotes.press/2026/the-quiet-interface');
    expect(externalUrl('HTTP://Example.com/a?b=1')).toBe('http://example.com/a?b=1');
    expect(externalUrl('localhost:5173')).toBe('http://localhost:5173/');
  });
  test('refuses other schemes, words and sentences', () => {
    for (const s of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.co', 'ftp://files.example.com', 'notaurl', 'is it noisy', '', 'https://']) {
      expect([s, externalUrl(s)]).toEqual([s, null]);
    }
  });
  test('display, host, monogram and mark', () => {
    expect(displayAddress('https://example.com/')).toBe('example.com');
    expect(displayAddress('http://a.b/c')).toBe('a.b/c');
    expect(hostOf('https://www.example.com:8080/x')).toBe('example.com:8080');
    expect(hostOf('not a url')).toBe('not a url');
    expect(initialFor('dr.dk')).toBe('D');
    expect(markFor('dr.dk')).toBe(markFor('dr.dk'));
    expect(markFor('dr.dk')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('the session', () => {
  test('openPage opens a tab, selects it and records the visit', () => {
    const s = openPage(EMPTY_BROWSER, copy('https://a.example/x'), { now: NOW });
    expect(s.tabs).toHaveLength(1);
    expect(s.selectedId).toBe(s.tabs[0].id);
    expect(s.tabs[0]).toMatchObject({ url: 'https://a.example/x', host: 'a.example', title: 'Title of a.example', notes: null });
    expect(s.history).toEqual([{ url: 'https://a.example/x', title: 'Title of a.example', at: NOW.toISOString() }]);
  });

  test('openPage into a tab replaces it in place; a revisit moves to the top of the history', () => {
    let s = openPage(EMPTY_BROWSER, copy('https://a.example/'), { now: NOW });
    s = openPage(s, copy('https://b.example/'), { now: NOW });
    const first = s.tabs[0].id;
    s = openPage(s, copy('https://a.example/'), { replaceTabId: s.tabs[1].id, now: NOW });
    expect(s.tabs.map((t) => t.url)).toEqual(['https://a.example/', 'https://a.example/']);
    expect(s.tabs[0].id).toBe(first);
    expect(s.history.map((h) => h.url)).toEqual(['https://a.example/', 'https://b.example/']);
  });

  test('history is capped', () => {
    let s: BrowserState = EMPTY_BROWSER;
    for (let i = 0; i < MAX_HISTORY + 5; i++) s = openPage({ ...s, tabs: [] }, copy(`https://a.example/${i}`), { now: NOW });
    expect(s.history).toHaveLength(MAX_HISTORY);
    expect(clearHistory(s).history).toEqual([]);
    expect(clearHistory(EMPTY_BROWSER)).toBe(EMPTY_BROWSER);
  });

  test('closing the open tab selects its neighbour', () => {
    let s = EMPTY_BROWSER;
    for (const h of ['a', 'b', 'c']) s = openPage(s, copy(`https://${h}.example/`), { now: NOW });
    const [a, b, c] = s.tabs.map((t) => t.id);
    s = selectTab(s, b, NOW);
    s = closeTab(s, b);
    expect(s.selectedId).toBe(c);
    s = closeTab(s, c);
    expect(s.selectedId).toBe(a);
    s = closeTab(s, a);
    expect(s.selectedId).toBeNull();
    expect(closeTab(s, 'nope')).toBe(s);
  });

  test('keep and let go; a kept page opens from its copy without a fetch', () => {
    let s = openPage(EMPTY_BROWSER, copy('https://a.example/'), { now: NOW });
    const tabId = s.tabs[0].id;
    s = toggleKeep(s, tabId, NOW);
    expect(isKept(s, 'https://a.example/')).toBe(true);
    const keptId = s.kept[0].id;
    expect(s.kept[0].page?.blocks.length).toBe(5);
    // Already open: selects that tab rather than opening a second.
    const again = openKept(s, keptId, NOW);
    expect(again?.tabs).toHaveLength(1);
    // Closed: opens a new tab from the kept copy.
    s = closeTab(s, tabId);
    const reopened = openKept(s, keptId, NOW);
    expect(reopened?.tabs).toHaveLength(1);
    expect(reopened?.tabs[0].page?.url).toBe('https://a.example/');
    // No copy kept: the caller has to fetch.
    expect(openKept({ ...s, kept: [{ ...s.kept[0], page: null }] }, keptId, NOW)).toBeNull();
    // Let go.
    expect(removeKept(s, keptId).kept).toEqual([]);
    const t2 = openPage(s, copy('https://a.example/'), { now: NOW });
    expect(isKept(toggleKeep(t2, t2.tabs[0].id, NOW), 'https://a.example/')).toBe(false);
  });

  test('notes are kept with their tab', () => {
    const s = openPage(EMPTY_BROWSER, copy('https://a.example/'), { now: NOW });
    const notes = { summary: 'S', points: [], provider: 'anthropic', partial: false, at: NOW.toISOString() };
    expect(selectedTab(setNotes(s, s.tabs[0].id, notes))?.notes).toEqual(notes);
  });
});

describe('storage', () => {
  test('capCopy cuts long pages and says so', () => {
    const long = copy('https://a.example/', { blocks: Array.from({ length: 10 }, () => ({ kind: 'paragraph' as const, text: 'x'.repeat(100) })) });
    const cut = capCopy(long, 450);
    expect(cut.blocks).toHaveLength(4);
    expect(cut.clipped).toBe(true);
    const fits = copy('https://a.example/');
    expect(capCopy(fits)).toBe(fits);
  });

  test('fitToBudget keeps the open tab’s copy first, then the most recently read', () => {
    let s = EMPTY_BROWSER;
    for (const h of ['a', 'b', 'c']) s = openPage(s, copy(`https://${h}.example/`), { now: NOW });
    const [a, b] = s.tabs.map((t) => t.id);
    s = selectTab(s, b, new Date(NOW.getTime() + 1000));
    s = selectTab(s, a, new Date(NOW.getTime() + 2000));
    const one = copySize(s.tabs[0].page);
    const fit = fitToBudget(s, one * 2 + 10);
    expect(fit.tabs.map((t) => t.page !== null)).toEqual([true, true, false]);
    expect(fitToBudget(s, one * 10)).toBe(s);
    expect(fitToBudget(s, 0).tabs.every((t) => t.page === null)).toBe(true);
  });

  test('round-trips through JSON', () => {
    let s = openPage(EMPTY_BROWSER, copy('https://a.example/'), { now: NOW });
    s = toggleKeep(s, s.tabs[0].id, NOW);
    expect(parseBrowser(JSON.stringify(s))).toEqual(s);
  });

  test('a damaged store opens empty, and damaged entries are dropped', () => {
    expect(parseBrowser(null)).toEqual(EMPTY_BROWSER);
    expect(parseBrowser('{not json')).toEqual(EMPTY_BROWSER);
    expect(parseBrowser('[1,2]')).toEqual(EMPTY_BROWSER);
    const s = parseBrowser(JSON.stringify({
      tabs: [
        { id: 't1', url: 'javascript:alert(1)' },
        { id: 't2', url: 'https://ok.example/', page: { url: 'https://ok.example/', blocks: [{ kind: 'script', text: 'x' }, { kind: 'paragraph', text: 'fine' }], links: [{ href: 'file:///x', text: 'f' }] } },
        'junk',
      ],
      selectedId: 'gone',
      history: [{ url: 'https://ok.example/' }, { url: 'ftp://x' }],
      kept: [{ id: 'k', url: 'https://ok.example/', page: 'nope' }],
    }));
    expect(s.tabs.map((t) => t.id)).toEqual(['t2']);
    expect(s.selectedId).toBe('t2');
    expect(s.tabs[0].page?.blocks).toEqual([{ kind: 'paragraph', text: 'fine' }]);
    expect(s.tabs[0].page?.links).toEqual([]);
    expect(s.history).toHaveLength(1);
    expect(s.kept[0].page).toBeNull();
  });

  test('parseCopy and parseNotes refuse what is not one', () => {
    expect(parseCopy({ url: 'file:///x', blocks: [] })).toBeNull();
    expect(parseCopy(null)).toBeNull();
    expect(parseNotes({ summary: '', points: [{ kind: 'link', title: 'x', body: 'y' }] })).toBeNull();
    expect(parseNotes({ summary: 'S', points: [{ kind: 'warn', title: 'T', body: 'B' }], provider: 'bedrock', partial: true, at: 'x' }))
      .toEqual({ summary: 'S', points: [{ kind: 'warn', title: 'T', body: 'B' }], provider: 'bedrock', partial: true, at: 'x' });
  });
});

describe('go suggestions', () => {
  test('tabs, then kept, then history — each address once, filtered by address or title', () => {
    let s = openPage(EMPTY_BROWSER, copy('https://a.example/'), { now: NOW });
    s = toggleKeep(s, s.tabs[0].id, NOW);
    s = openPage(s, copy('https://b.example/'), { now: NOW });
    s = closeTab(s, s.tabs[1].id);
    s = { ...s, kept: [...s.kept, { id: 'k2', url: 'https://c.example/', title: 'Heat pumps', host: 'c.example', keptAt: NOW.toISOString(), page: null }] };
    const rows = goSuggestions(s, '', NOW);
    expect(rows.map((r) => [r.label, r.source])).toEqual([['a.example', 'tab'], ['c.example', 'kept'], ['b.example', 'history']]);
    expect(goSuggestions(s, 'heat', NOW).map((r) => r.url)).toEqual(['https://c.example/']);
    expect(goSuggestions(s, 'zzz', NOW)).toEqual([]);
  });

  test('visited labels', () => {
    // Local times: "today" and "yesterday" are the user's own calendar days.
    const now = new Date(2026, 9, 28, 14, 0);
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    expect(visitedLabel(ago(10_000), now)).toBe('visited just now');
    expect(visitedLabel(ago(5 * 60_000), now)).toBe('visited 5 min ago');
    expect(visitedLabel(ago(2 * 3600_000), now)).toBe('visited 2 h ago');
    expect(visitedLabel(ago(26 * 3600_000), now)).toBe('visited yesterday');
    expect(visitedLabel(new Date(2026, 9, 12, 10, 0).toISOString(), now)).toBe('visited 12 Oct');
  });
});

describe('copy', () => {
  test('tab counts and the hero line', () => {
    expect(tabCountLabel(1)).toBe('open tab');
    expect(tabCountLabel(0)).toBe('open tabs');
    expect(heroLine(0)).toContain('Every tab is closed');
    expect(heroLine(1)).toBe('1 tab open, each fetched on this Mac and read as text.');
    expect(heroLine(3)).toContain('3 tabs open');
  });
  test('byline and end line say where the copy came from', () => {
    const p = copy('https://www.heatwise.example/g', { siteName: 'Heatwise', byline: 'Sonia Reyes' });
    expect(bylineFor(p)).toBe('Heatwise · Sonia Reyes · 2 min read');
    expect(bylineFor(copy('https://a.example/', { words: 10 }))).toBe('a.example · 1 min read');
    expect(endLine(p, NOW)).toMatch(/^End of the copy this Mac fetched at \d\d:\d\d\.$/);
    expect(endLine({ ...p, truncated: true }, NOW)).toContain('2 MB');
    expect(endLine({ ...p, clipped: true }, NOW)).toContain('first part');
  });
  test('answers and notes say what was sent where, and that memory was not touched', () => {
    expect(providerName('anthropic')).toBe('Anthropic');
    expect(providerName('bedrock')).toBe('Amazon Bedrock');
    expect(providerName(null)).toBe('your AI provider');
    expect(answerBasis('anthropic', false)).toBe('Answered from this page’s text only, by Anthropic. Nothing was saved to memory.');
    expect(answerBasis(null, true)).toContain('first part');
    expect(notesBasis('bedrock', false)).toContain('when you asked');
  });
});

describe('refusals', () => {
  test('a sentence typed into Go is not an address', () => {
    const r = notAnAddress('  heat pump prices ');
    expect(r).toMatchObject({ kind: 'not-address', typed: 'heat pump prices' });
    expect(r.title).toContain('isn’t an address');
  });
  test('a page Atlas would not fetch can still go to the user’s browser, unless it is no address at all', () => {
    const priv = notOpened('http://192.168.1.1/', '192.168.1.1 is a private address.', 'private');
    expect(priv).toMatchObject({ kind: 'not-opened', href: 'http://192.168.1.1/', body: '192.168.1.1 is a private address.' });
    expect(priv.title).toContain('192.168.1.1');
    expect(notOpened('https://a.example/', 'x', 'scheme')).toMatchObject({ href: null });
    expect(tooManyTabs()).toMatchObject({ kind: 'not-opened', href: null });
  });
  test('ask refusals say where a general answer lives', () => {
    const none = askWithoutPage('  Is it noisy? ', false);
    expect(none).toMatchObject({ kind: 'no-answer', question: 'Is it noisy?', title: 'No page to answer from' });
    expect(none.body).toContain('Talk');
    expect(askWithoutPage('q', true).body).toContain('Load the page again');
    expect(askFailed(null, 'The AI provider didn’t answer.')).toMatchObject({ title: 'Atlas couldn’t read this page', question: null });
  });
});
