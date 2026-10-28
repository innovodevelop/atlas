/**
 * The Beta Browser's reading of the browser session — the pure half of
 * `src/pages/atlas/BetaBrowser.tsx` (`Atlas Browser Beta.dc.html`).
 *
 * The session itself is the one the Workshop page drives
 * (`useAtlasBrowserMock` in `src/lib/mocks/browser.ts`): a labelled sample,
 * because Atlas has no browser engine. Everything here is formatting and
 * small decisions over that session — the omnibox's three modes, the find
 * cursor, the highlight segments, the honest refusals — kept out of the page
 * so they can be tested without a DOM.
 */
import type { BrowserMode, FindMatch } from '@/lib/mocks/browser';

/* ── The omnibox's modes ──────────────────────────────────────────────────── */

/** The order the mode chip cycles through. The design's own order. */
export const MODE_ORDER: readonly BrowserMode[] = ['go', 'ask', 'find'];

export function nextMode(mode: BrowserMode): BrowserMode {
  return MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
}

/** The design's per-mode copy, in one place so the chip, input and button agree. */
export const MODE_COPY: Record<BrowserMode, { label: string; key: string; placeholder: string; submit: string }> = {
  go: { label: 'Go', key: '⌘L', placeholder: 'Type an address', submit: 'Open this address' },
  ask: { label: 'Ask', key: '⌘K', placeholder: 'Ask Atlas about this page', submit: 'Ask Atlas' },
  find: { label: 'Find', key: '⌘F', placeholder: 'Find on this page', submit: 'Next match' },
};

/** ⌘L / ⌘K / ⌘F → the mode they pick, or null for any other key. */
export function modeForShortcut(key: string): BrowserMode | null {
  const k = key.toLowerCase();
  return k === 'l' ? 'go' : k === 'k' ? 'ask' : k === 'f' ? 'find' : null;
}

/* ── Find on page ─────────────────────────────────────────────────────────── */

/** Steps the find cursor, wrapping both ways. Zero when there is nothing to step through. */
export function stepCursor(cursor: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  return (((cursor + dir) % total) + total) % total;
}

/** The count beside the input: "3 of 7", or the design's "No matches". */
export function findCountLabel(cursor: number, total: number): string {
  return total > 0 ? `${Math.min(cursor, total - 1) + 1} of ${total}` : 'No matches';
}

/** One run of a block's text, and which match it is (null for plain text). */
export interface Segment {
  text: string;
  hit: number | null;
}

/**
 * Splits one block of prose around its matches, for highlighting.
 *
 * The offsets come from the same `findMatches()` scan that counts them, so the
 * count beside the omnibox and the marks on the page cannot disagree. `hit` is
 * the match's index in the whole page, which is what the cursor points at.
 */
export function segmentsFor(text: string, block: number, matches: readonly FindMatch[], length: number): Segment[] {
  if (length <= 0) return [{ text, hit: null }];
  const out: Segment[] = [];
  let at = 0;
  matches.forEach((m, i) => {
    if (m.block !== block || m.offset < at) return;
    if (m.offset > at) out.push({ text: text.slice(at, m.offset), hit: null });
    out.push({ text: text.slice(m.offset, m.offset + length), hit: i });
    at = m.offset + length;
  });
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), hit: null });
  return out;
}

/* ── Addresses ────────────────────────────────────────────────────────────── */

/**
 * What the omnibox's Go mode can hand to the user's own browser, or null.
 *
 * Atlas cannot load a page, but the opener plugin can pass an address to the
 * OS. Only http(s) goes through — `javascript:`, `file:` and `mailto:` typed
 * into an address bar are not addresses Atlas should open on anyone's behalf —
 * and a bare word with no dot is a question, not a site.
 */
export function externalUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  let candidate: string;
  if (/^https?:\/\//i.test(raw)) candidate = raw;
  else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)) return null; // some other scheme
  else candidate = `${/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw) ? 'http' : 'https'}://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (host !== 'localhost' && !host.includes('.')) return null;
  if (host.startsWith('.') || host.endsWith('.')) return null;
  return url.href;
}

/** An address as the bar shows it: no scheme, no trailing slash. */
export function displayAddress(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/* ── Copy ─────────────────────────────────────────────────────────────────── */

export function tabCountLabel(n: number): string {
  return n === 1 ? 'open tab' : 'open tabs';
}

/** The hero's one line. Honest about the sample, and about day one. */
export function heroLine(tabs: number, isMock: boolean): string {
  if (tabs === 0) return 'Every tab is closed. This is the browser on day one: an omnibox, and nothing invented behind it.';
  if (!isMock) return `${tabs} ${tabs === 1 ? 'tab' : 'tabs'} open.`;
  return `${tabs} sample ${tabs === 1 ? 'tab' : 'tabs'} kept open. Nothing here was loaded: Atlas has no browser engine yet.`;
}

/** The sample strip's text, with and without tabs. */
export function noticeLine(tabs: number): string {
  return tabs
    ? 'Atlas has no browser engine: no web view and no fetch of remote pages. Every tab and article is a fixed sample so the shell can be reviewed. Find-on-page is real; an address can go to your own browser; everything else refuses honestly.'
    : 'This is what a real adapter returns before an engine reports in: no tabs, no shelves, no article.';
}

/* ── Refusals ─────────────────────────────────────────────────────────────── */

/** What the panel says after a submit Atlas could not honour. */
export type BrowserRefusal =
  | { kind: 'no-engine'; title: string; body: string; href: string | null; typed: string }
  | { kind: 'unanswerable'; title: string; body: string; question: string };

/**
 * Go: the address cannot be loaded here. When it is a real address the user
 * can still take it to their own browser; when it is not one, the refusal
 * says so and points at Ask.
 */
export function goRefusal(typed: string, shown: string): BrowserRefusal {
  const href = externalUrl(typed);
  if (!href) {
    return {
      kind: 'no-engine',
      title: `“${typed.trim()}” isn’t an address`,
      body: 'Go opens addresses, and this doesn’t look like one. Switch to Ask to put it to Atlas instead.',
      href: null,
      typed: typed.trim(),
    };
  }
  return {
    kind: 'no-engine',
    title: `Atlas can’t open “${shown || displayAddress(href)}”`,
    body: 'There’s no browser engine in Atlas yet: no web view and no fetch of remote pages. Nothing was loaded, and nothing is shown pretending it was. Your own browser can open it.',
    href,
    typed: typed.trim(),
  };
}

/** Ask: the sample has no written answer for this, and Atlas will not invent one. */
export function askRefusal(question: string, hasPage: boolean): BrowserRefusal {
  const q = question.trim();
  return {
    kind: 'unanswerable',
    title: hasPage ? 'Atlas can’t answer that from this page' : 'No page to answer from',
    body: hasPage
      ? `Answers here come only from the prompts written for this sample page, and “${q}” isn’t one of them. Ask Atlas in Talk for a general answer; it won’t see this page.`
      : 'Nothing is open, so there is nothing on a page to answer from. Ask Atlas in Talk for a general answer.',
    question: q,
  };
}
