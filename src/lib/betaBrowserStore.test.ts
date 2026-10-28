import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { openPage, type PageCopy } from './betaBrowser';

// The store under a stand-in window: what it writes, what it does when the
// browser refuses a write, and that it reads its own writing back.
const saved = new Map<string, string>();
let quota = Infinity;
const fakeWindow = {
  localStorage: {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > quota) throw new Error('QuotaExceededError');
      saved.set(k, v);
    },
  },
  addEventListener: () => {},
};
const g = globalThis as unknown as { window?: unknown };
const hadWindow = 'window' in g;
const before = g.window;
g.window = fakeWindow;
afterAll(() => { if (hadWindow) g.window = before; else delete g.window; });

const store = await import('./betaBrowserStore');

function copy(url: string, chars: number): PageCopy {
  return {
    url, title: url, siteName: null, byline: null, lang: null,
    blocks: [{ kind: 'paragraph', text: 'x'.repeat(chars) }],
    links: [], words: 1, clipped: false, truncated: false, fetchedAt: '2026-10-28T12:00:00.000Z',
  };
}

beforeEach(() => {
  saved.clear();
  quota = Infinity;
  store._resetBrowserStore();
});

describe('the browser store', () => {
  test('starts empty, and writes what it was given', () => {
    expect(store.getBrowser().tabs).toEqual([]);
    store.updateBrowser((s) => openPage(s, copy('https://a.example/', 10), { now: new Date() }));
    store.flushBrowser();
    const raw = saved.get(store.BROWSER_KEY);
    expect(raw).toBeDefined();
    store._resetBrowserStore();
    expect(store.getBrowser().tabs.map((t) => t.url)).toEqual(['https://a.example/']);
    expect(store.getBrowser().tabs[0].page?.blocks[0].text.length).toBe(10);
  });

  test('when the browser refuses the write, it saves the tabs without their copies', () => {
    store.updateBrowser((s) => openPage(s, copy('https://a.example/', 50_000), { now: new Date() }));
    quota = 5_000;
    store.flushBrowser();
    store._resetBrowserStore();
    const s = store.getBrowser();
    expect(s.tabs.map((t) => t.url)).toEqual(['https://a.example/']);
    expect(s.tabs[0].page).toBeNull();
  });

  test('when nothing can be written, it says so', () => {
    store.updateBrowser((s) => openPage(s, copy('https://a.example/', 10), { now: new Date() }));
    quota = 0;
    store.flushBrowser();
    expect(store.browserSaveFailed()).toBe(true);
    // The next write that lands clears it.
    quota = Infinity;
    store.updateBrowser((s) => openPage(s, copy('https://b.example/', 10), { now: new Date() }));
    store.flushBrowser();
    expect(store.browserSaveFailed()).toBe(false);
    store._resetBrowserStore();
    expect(store.getBrowser().tabs).toHaveLength(2);
  });

  test('a damaged entry opens as an empty browser', () => {
    saved.set(store.BROWSER_KEY, '{oops');
    expect(store.getBrowser().tabs).toEqual([]);
  });
});
