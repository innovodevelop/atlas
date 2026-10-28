/**
 * The Beta Browser's session and its reading — the pure half of
 * `src/pages/atlas/BetaBrowser.tsx` (`Atlas Browser Beta.dc.html`).
 *
 * Pages are real. Go hands an address to the brain (`/browser/fetch`), which
 * fetches it on this Mac behind a guard (public http/https only, a size cap, a
 * deadline, a redirect cap) and returns the page as reader blocks: text, never
 * HTML. The webview draws those blocks with its own markup, so no script on a
 * page runs and no remote image loads. See services/atlas-brain/src/
 * browserRoutes.ts and the pageGuard / pageFetch / pageReader modules beside it.
 *
 * The session — open tabs with the copy each one fetched, the history, and the
 * pages the user kept — lives on this Mac in localStorage (betaBrowserStore.ts).
 * Everything here is the data shape, the reducers over it, and the screen's
 * copy and small decisions, kept out of the page so they can be tested without
 * a DOM. (The Workshop page, `AtlasBrowser.tsx`, still draws the labelled
 * sample in `src/lib/mocks/browser.ts`; nothing here reads it.)
 */

/* ── The omnibox's modes ──────────────────────────────────────────────────── */

/** The omnibox's three jobs. Cycled by the mode chip, or ⌘L / ⌘K / ⌘F. */
export type BrowserMode = 'go' | 'ask' | 'find';

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

/* ── A page, as the brain reads it ────────────────────────────────────────── */

export type ReaderBlockKind = 'heading' | 'paragraph' | 'item' | 'quote' | 'caption' | 'code';

export interface ReaderBlock {
  kind: ReaderBlockKind;
  text: string;
  /** Headings only: 1–6. */
  level?: number;
}

export interface ReaderLink {
  text: string;
  href: string;
}

/** The readable copy of one fetched page — what `/browser/fetch` returns, as kept with a tab. */
export interface PageCopy {
  /** The address after redirects. */
  url: string;
  title: string;
  siteName: string | null;
  byline: string | null;
  lang: string | null;
  blocks: ReaderBlock[];
  links: ReaderLink[];
  words: number;
  /** The text went on past what Atlas kept (the reader's cap, or the store's). */
  clipped: boolean;
  /** The fetch stopped at its size cap. */
  truncated: boolean;
  /** ISO time the page was fetched. */
  fetchedAt: string;
}

export type NoticeKind = 'claim' | 'quote' | 'warn';

/** What Atlas noticed on a page, asked for on demand ("On this page"). */
export interface PageNotes {
  summary: string;
  points: Array<{ kind: NoticeKind; title: string; body: string }>;
  provider: string | null;
  /** Only the first part of a long page was sent. */
  partial: boolean;
  at: string;
}

export interface BrowserTab {
  id: string;
  /** The page's address after redirects. */
  url: string;
  title: string;
  host: string;
  /** Null when the copy was not kept (the store's space budget); the tab can load it again. */
  page: PageCopy | null;
  notes: PageNotes | null;
  viewedAt: string;
}

export interface HistoryEntry {
  url: string;
  title: string;
  at: string;
}

/** A page the user kept, with its copy so it reads without fetching again. */
export interface KeptPage {
  id: string;
  url: string;
  title: string;
  host: string;
  keptAt: string;
  page: PageCopy | null;
}

export interface BrowserState {
  tabs: BrowserTab[];
  selectedId: string | null;
  history: HistoryEntry[];
  kept: KeptPage[];
}

export const EMPTY_BROWSER: BrowserState = { tabs: [], selectedId: null, history: [], kept: [] };

/** More tabs than this and Go asks for one to be closed first. */
export const MAX_TABS = 30;
export const MAX_HISTORY = 200;
export const MAX_KEPT = 100;
/** Text kept per page copy, and links. A long article fits; a whole wiki does not. */
export const MAX_COPY_CHARS = 80_000;
export const MAX_COPY_LINKS = 150;
/**
 * Characters of page copy the store writes in total. localStorage holds about
 * five million per origin and other screens share it; past this budget the
 * copies of the least recently read tabs, then the oldest kept pages, are left
 * out of what is saved (the tab stays, and can load its page again).
 */
export const STORE_BUDGET = 1_200_000;

let idSeq = 0;
function makeId(prefix: string): string {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** `www.example.com:8080` → `example.com:8080`; an unparseable address is shown as it is. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Cuts a copy to what one tab keeps. Returns the same object when it already fits. */
export function capCopy(copy: PageCopy, maxChars = MAX_COPY_CHARS, maxLinks = MAX_COPY_LINKS): PageCopy {
  let total = 0;
  let cut = -1;
  for (let i = 0; i < copy.blocks.length; i++) {
    total += copy.blocks[i].text.length;
    if (total > maxChars) { cut = i; break; }
  }
  if (cut === -1 && copy.links.length <= maxLinks) return copy;
  return {
    ...copy,
    blocks: cut === -1 ? copy.blocks : copy.blocks.slice(0, cut),
    links: copy.links.slice(0, maxLinks),
    clipped: copy.clipped || cut !== -1,
  };
}

/** Roughly the characters a copy takes in the store. */
export function copySize(copy: PageCopy | null): number {
  if (!copy) return 0;
  let n = copy.title.length + copy.url.length + 200;
  for (const b of copy.blocks) n += b.text.length + 24;
  for (const l of copy.links) n += l.text.length + l.href.length + 20;
  return n;
}

/* ── Reducers ─────────────────────────────────────────────────────────────── */

function recordVisit(history: HistoryEntry[], url: string, title: string, at: string): HistoryEntry[] {
  return [{ url, title, at }, ...history.filter((h) => h.url !== url)].slice(0, MAX_HISTORY);
}

/**
 * A page arrived: open it in a new tab, or in place of `replaceTabId` (the
 * address bar edited, or a tab loading its page again). Selects it and adds
 * it to the history.
 */
export function openPage(state: BrowserState, page: PageCopy, opts: { replaceTabId?: string | null; now: Date }): BrowserState {
  const at = opts.now.toISOString();
  const copy = capCopy(page);
  const replacing = opts.replaceTabId ? state.tabs.find((t) => t.id === opts.replaceTabId) : undefined;
  const tab: BrowserTab = {
    id: replacing?.id ?? makeId('t'),
    url: copy.url,
    title: copy.title,
    host: hostOf(copy.url),
    page: copy,
    notes: null,
    viewedAt: at,
  };
  const tabs = replacing ? state.tabs.map((t) => (t.id === replacing.id ? tab : t)) : [...state.tabs, tab];
  return { ...state, tabs, selectedId: tab.id, history: recordVisit(state.history, copy.url, copy.title, at) };
}

/** Opens a kept page from its copy: selects the tab already showing it, or opens one. Null when it has no copy to show. */
export function openKept(state: BrowserState, keptId: string, now: Date): BrowserState | null {
  const k = state.kept.find((x) => x.id === keptId);
  if (!k) return null;
  const open = state.tabs.find((t) => t.url === k.url);
  if (open) return selectTab(state, open.id, now);
  if (!k.page) return null;
  return openPage(state, k.page, { now });
}

export function selectTab(state: BrowserState, id: string, now: Date): BrowserState {
  if (!state.tabs.some((t) => t.id === id)) return state;
  return { ...state, selectedId: id, tabs: state.tabs.map((t) => (t.id === id ? { ...t, viewedAt: now.toISOString() } : t)) };
}

/** Closes a tab; the selection moves to its neighbour, as in any browser. */
export function closeTab(state: BrowserState, id: string): BrowserState {
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const selectedId = state.selectedId !== id ? state.selectedId : tabs[Math.min(at, tabs.length - 1)]?.id ?? null;
  return { ...state, tabs, selectedId };
}

export function isKept(state: BrowserState, url: string): boolean {
  return state.kept.some((k) => k.url === url);
}

/** Keeps the tab's page (with its copy), or lets it go when it is already kept. */
export function toggleKeep(state: BrowserState, tabId: string, now: Date): BrowserState {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return state;
  if (isKept(state, tab.url)) return { ...state, kept: state.kept.filter((k) => k.url !== tab.url) };
  const kept: KeptPage = { id: makeId('k'), url: tab.url, title: tab.title, host: tab.host, keptAt: now.toISOString(), page: tab.page };
  return { ...state, kept: [kept, ...state.kept].slice(0, MAX_KEPT) };
}

export function removeKept(state: BrowserState, keptId: string): BrowserState {
  return { ...state, kept: state.kept.filter((k) => k.id !== keptId) };
}

/**
 * Keeps "On this page" notes with their tab. `url` is the page they were read
 * from: notes that arrive after the tab has gone on to another page belong to
 * no page on screen, so they are dropped rather than pinned to the wrong one.
 */
export function setNotes(state: BrowserState, tabId: string, notes: PageNotes, url?: string): BrowserState {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || (url !== undefined && tab.url !== url)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, notes } : t)) };
}

export function clearHistory(state: BrowserState): BrowserState {
  return state.history.length ? { ...state, history: [] } : state;
}

export function selectedTab(state: BrowserState): BrowserTab | null {
  return state.tabs.find((t) => t.id === state.selectedId) ?? null;
}

/* ── The store's shape on disk ────────────────────────────────────────────── */

/**
 * What is written: the state with page copies left out past STORE_BUDGET.
 * Copies are kept in the order they matter — the open tab, the other tabs by
 * when they were last read, then kept pages, newest first.
 */
export function fitToBudget(state: BrowserState, budget = STORE_BUDGET): BrowserState {
  const order: PageCopy[] = [];
  const sel = selectedTab(state);
  if (sel?.page) order.push(sel.page);
  [...state.tabs]
    .filter((t) => t !== sel && t.page)
    .sort((a, b) => b.viewedAt.localeCompare(a.viewedAt))
    .forEach((t) => { if (t.page) order.push(t.page); });
  [...state.kept]
    .sort((a, b) => b.keptAt.localeCompare(a.keptAt))
    .forEach((k) => { if (k.page) order.push(k.page); });
  const keep = new Set<PageCopy>();
  let used = 0;
  for (const c of order) {
    const n = copySize(c);
    if (used + n > budget) continue;
    used += n;
    keep.add(c);
  }
  if (keep.size === order.length) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.page && !keep.has(t.page) ? { ...t, page: null } : t)),
    kept: state.kept.map((k) => (k.page && !keep.has(k.page) ? { ...k, page: null } : k)),
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const BLOCK_KINDS: readonly ReaderBlockKind[] = ['heading', 'paragraph', 'item', 'quote', 'caption', 'code'];
const NOTICE_KINDS: readonly NoticeKind[] = ['claim', 'quote', 'warn'];

/** A copy as the brain sent it or the store kept it; null when it is not one. */
export function parseCopy(v: unknown): PageCopy | null {
  if (!isObj(v)) return null;
  const url = str(v.url);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const blocks: ReaderBlock[] = [];
  if (Array.isArray(v.blocks)) {
    for (const b of v.blocks) {
      if (!isObj(b)) continue;
      const kind = BLOCK_KINDS.find((k) => k === b.kind);
      const text = str(b.text);
      if (!kind || !text) continue;
      const level = typeof b.level === 'number' && b.level >= 1 && b.level <= 6 ? Math.round(b.level) : undefined;
      blocks.push(level ? { kind, text, level } : { kind, text });
    }
  }
  const links: ReaderLink[] = [];
  if (Array.isArray(v.links)) {
    for (const l of v.links) {
      if (!isObj(l)) continue;
      const href = str(l.href);
      const text = str(l.text);
      if (href && text && /^https?:\/\//i.test(href)) links.push({ href, text });
    }
  }
  return {
    url,
    title: str(v.title) || hostOf(url),
    siteName: str(v.siteName),
    byline: str(v.byline),
    lang: str(v.lang),
    blocks,
    links,
    words: typeof v.words === 'number' && v.words >= 0 ? v.words : blocks.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0),
    clipped: v.clipped === true,
    truncated: v.truncated === true,
    fetchedAt: str(v.fetchedAt) ?? new Date(0).toISOString(),
  };
}

export function parseNotes(v: unknown): PageNotes | null {
  if (!isObj(v)) return null;
  const points: PageNotes['points'] = [];
  if (Array.isArray(v.points)) {
    for (const p of v.points) {
      if (!isObj(p)) continue;
      const kind = NOTICE_KINDS.find((k) => k === p.kind);
      const title = str(p.title);
      const body = str(p.body);
      if (kind && title && body) points.push({ kind, title, body });
    }
  }
  const summary = str(v.summary) ?? '';
  if (!summary && points.length === 0) return null;
  return { summary, points, provider: str(v.provider), partial: v.partial === true, at: str(v.at) ?? new Date(0).toISOString() };
}

/**
 * Reads the store. Defensive: a damaged entry opens as empty, and a damaged
 * tab or kept page is dropped rather than breaking the screen.
 */
export function parseBrowser(raw: string | null): BrowserState {
  if (!raw) return EMPTY_BROWSER;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return EMPTY_BROWSER; }
  if (!isObj(v)) return EMPTY_BROWSER;
  const tabs: BrowserTab[] = [];
  if (Array.isArray(v.tabs)) {
    for (const t of v.tabs) {
      if (!isObj(t)) continue;
      const id = str(t.id);
      const url = str(t.url);
      if (!id || !url || !/^https?:\/\//i.test(url) || tabs.some((x) => x.id === id)) continue;
      tabs.push({
        id, url,
        title: str(t.title) || hostOf(url),
        host: hostOf(url),
        page: parseCopy(t.page),
        notes: parseNotes(t.notes),
        viewedAt: str(t.viewedAt) ?? new Date(0).toISOString(),
      });
    }
  }
  const history: HistoryEntry[] = [];
  if (Array.isArray(v.history)) {
    for (const h of v.history) {
      if (!isObj(h)) continue;
      const url = str(h.url);
      if (!url || !/^https?:\/\//i.test(url)) continue;
      history.push({ url, title: str(h.title) || hostOf(url), at: str(h.at) ?? new Date(0).toISOString() });
    }
  }
  const kept: KeptPage[] = [];
  if (Array.isArray(v.kept)) {
    for (const k of v.kept) {
      if (!isObj(k)) continue;
      const id = str(k.id);
      const url = str(k.url);
      if (!id || !url || !/^https?:\/\//i.test(url)) continue;
      kept.push({ id, url, title: str(k.title) || hostOf(url), host: hostOf(url), keptAt: str(k.keptAt) ?? new Date(0).toISOString(), page: parseCopy(k.page) });
    }
  }
  const selected = str(v.selectedId);
  return {
    tabs: tabs.slice(0, MAX_TABS),
    selectedId: tabs.some((t) => t.id === selected) ? selected : tabs[0]?.id ?? null,
    history: history.slice(0, MAX_HISTORY),
    kept: kept.slice(0, MAX_KEPT),
  };
}

/* ── Go suggestions ───────────────────────────────────────────────────────── */

export interface GoRow {
  id: string;
  url: string;
  label: string;
  meta: string;
  /** Where the row comes from: a tab is selected, a kept page opens from its copy, history fetches again. */
  source: 'tab' | 'kept' | 'history';
  ref: string;
}

/** "visited 5 min ago", "visited yesterday", "visited 12 Oct". */
export function visitedLabel(at: string, now: Date): string {
  const t = new Date(at);
  const mins = Math.round((now.getTime() - t.getTime()) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return 'visited just now';
  if (mins < 60) return `visited ${mins} min ago`;
  if (mins < 24 * 60 && t.getDate() === now.getDate()) return `visited ${Math.round(mins / 60)} h ago`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (t.toDateString() === yesterday.toDateString()) return 'visited yesterday';
  return `visited ${dayLabel(t)}`;
}

/** "22 Oct", the design's date for a kept page. */
export function dayLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Addresses for Go: open tabs, kept pages, then history — each address once,
 * filtered by what is typed (in the address or the title).
 */
export function goSuggestions(state: BrowserState, typed: string, now: Date, limit = 6): GoRow[] {
  const q = typed.trim().toLowerCase();
  const seen = new Set<string>();
  const out: GoRow[] = [];
  const add = (row: GoRow, title: string) => {
    if (out.length >= limit || seen.has(row.url)) return;
    if (q && !row.url.toLowerCase().includes(q) && !title.toLowerCase().includes(q)) return;
    seen.add(row.url);
    out.push(row);
  };
  for (const t of state.tabs) add({ id: `tab:${t.id}`, url: t.url, label: displayAddress(t.url), meta: 'in a tab', source: 'tab', ref: t.id }, t.title);
  for (const k of state.kept) add({ id: `kept:${k.id}`, url: k.url, label: displayAddress(k.url), meta: 'kept', source: 'kept', ref: k.id }, k.title);
  for (const h of state.history) add({ id: `hist:${h.url}`, url: h.url, label: displayAddress(h.url), meta: visitedLabel(h.at, now), source: 'history', ref: h.url }, h.title);
  return out;
}

/** Prompts offered under Ask. Questions any page can answer or decline; never page-specific copy. */
export const ASK_PROMPTS: ReadonlyArray<{ id: string; label: string; meta: string }> = [
  { id: 'summary', label: 'Summarise the key points', meta: 'Summary' },
  { id: 'evidence', label: 'What does this page claim, and on what evidence?', meta: 'Claims' },
  { id: 'caveats', label: 'What should I be careful about here?', meta: 'Caveats' },
];

/* ── Find on page ─────────────────────────────────────────────────────────── */

export interface FindMatch {
  /** Index into `pageTexts()`: 0 is the title, then each block in reading order. */
  block: number;
  /** Character offset of the match inside that block. */
  offset: number;
  /** The matched text plus a little either side. */
  context: string;
}

/** Every searchable string on a page, in reading order — the title first. */
export function pageTexts(copy: PageCopy | null): string[] {
  return copy ? [copy.title, ...copy.blocks.map((b) => b.text)] : [];
}

/**
 * Real search over the text on screen. Case-insensitive, every occurrence, in
 * reading order — no cap, because a count the user can trust is the point.
 */
export function findMatches(texts: readonly string[], query: string): FindMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const out: FindMatch[] = [];
  texts.forEach((text, block) => {
    const hay = text.toLowerCase();
    for (let from = 0; ;) {
      const at = hay.indexOf(q, from);
      if (at === -1) break;
      out.push({ block, offset: at, context: text.slice(Math.max(0, at - 28), Math.min(text.length, at + q.length + 34)).trim() });
      from = at + q.length;
    }
  });
  return out;
}

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

/** A run of the page as the reader draws it: one block, or consecutive list items as one list. */
export type BlockGroup =
  | { type: 'block'; block: ReaderBlock; n: number }
  | { type: 'list'; items: Array<{ block: ReaderBlock; n: number }> };

/**
 * Groups consecutive items into lists. `n` is each block's number in
 * `pageTexts()` (the title is 0), so find's marks land on the right block.
 */
export function groupBlocks(blocks: readonly ReaderBlock[]): BlockGroup[] {
  const out: BlockGroup[] = [];
  blocks.forEach((block, i) => {
    const n = i + 1;
    const last = out[out.length - 1];
    if (block.kind === 'item' && last?.type === 'list') last.items.push({ block, n });
    else if (block.kind === 'item') out.push({ type: 'list', items: [{ block, n }] });
    else out.push({ type: 'block', block, n });
  });
  return out;
}

/* ── Addresses ────────────────────────────────────────────────────────────── */

/**
 * What the omnibox's Go mode treats as an address, as a full URL, or null.
 *
 * Only http(s) — `javascript:`, `file:` and `mailto:` typed into an address
 * bar are not addresses Atlas should open on anyone's behalf — and a bare word
 * with no dot is a question, not a site. The brain's guard decides what it
 * will actually fetch (no local or private addresses); this only decides what
 * is worth sending, and what "Open in your browser" may hand to the OS.
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
  if (host !== 'localhost' && !host.includes('.') && !host.includes(':')) return null;
  if (host.startsWith('.') || host.endsWith('.')) return null;
  return url.href;
}

/** An address as the bar shows it: no scheme, no trailing slash. */
export function displayAddress(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** The monogram tile's colour: one of the design's site marks, the same for a host every time. */
const MARKS = ['#0a7a53', '#8a3b3b', '#2748bd', '#9a5a00', '#3461f2', '#6d6a67'];
export function markFor(host: string): string {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
  return MARKS[h % MARKS.length];
}

/** The monogram itself: the host's first letter or digit. */
export function initialFor(host: string): string {
  return (/[\p{L}\p{N}]/u.exec(host)?.[0] ?? '?').toUpperCase();
}

/* ── Copy ─────────────────────────────────────────────────────────────────── */

export function tabCountLabel(n: number): string {
  return n === 1 ? 'open tab' : 'open tabs';
}

/** The hero's one line. */
export function heroLine(tabs: number): string {
  if (tabs === 0) return 'Every tab is closed. Type an address and Atlas fetches the page on this Mac, as text.';
  return `${tabs} ${tabs === 1 ? 'tab' : 'tabs'} open, each fetched on this Mac and read as text.`;
}

/** The strip under the hero: what happens on this Mac, and what leaves it. */
export const NOTICE_LINE =
  'Pages are fetched by this Mac and shown as text: no scripts run and no images load. Ask and “On this page” send the page’s text to your AI provider; nothing is saved to memory.';

/** "Heatwise · Sonia Reyes · 9 min read". */
export function bylineFor(copy: PageCopy): string {
  const minutes = Math.max(1, Math.round(copy.words / 230));
  return [copy.siteName || hostOf(copy.url), copy.byline, `${minutes} min read`].filter(Boolean).join(' · ');
}

/** "14:05" today, "22 Oct, 14:05" before. */
export function fetchedLabel(at: string, now: Date): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'earlier';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${dayLabel(d)}, ${time}`;
}

/** The end of a page: where the copy came from, and whether it is all of it. */
export function endLine(copy: PageCopy, now: Date): string {
  const when = `End of the copy this Mac fetched at ${fetchedLabel(copy.fetchedAt, now)}.`;
  if (copy.truncated) return `${when} The page was larger than Atlas reads (2 MB), so it stops here.`;
  if (copy.clipped) return `${when} The page goes on; Atlas kept the first part of it.`;
  return when;
}

/** The provider's name, for saying where page text went. */
export function providerName(provider: string | null): string {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'bedrock') return 'Amazon Bedrock';
  return 'your AI provider';
}

/** Under an answer: what it rests on, where the text went, what was not kept. */
export function answerBasis(provider: string | null, partial: boolean): string {
  const part = partial ? 'the first part of this page’s text (it is long)' : 'this page’s text';
  return `Answered from ${part} only, by ${providerName(provider)}. Nothing was saved to memory.`;
}

/** Under "On this page": the same account, for notes Atlas was asked to make. */
export function notesBasis(provider: string | null, partial: boolean): string {
  const part = partial ? 'the first part of this page’s text (it is long)' : 'this page’s text';
  return `Read from ${part} only, by ${providerName(provider)}, when you asked. Nothing was saved to memory.`;
}

/* ── Refusals ─────────────────────────────────────────────────────────────── */

/** What the panel says after a submit Atlas could not honour. */
export type BrowserRefusal =
  /** Go got something that is not an address: put it to Ask instead. */
  | { kind: 'not-address'; title: string; body: string; typed: string }
  /** Go could not open a page; the user's own browser may (`href`). */
  | { kind: 'not-opened'; title: string; body: string; href: string | null }
  /** Ask or "On this page" got no answer; Talk can take a general question (`question`). */
  | { kind: 'no-answer'; title: string; body: string; question: string | null };

export function notAnAddress(typed: string): BrowserRefusal {
  const t = typed.trim();
  return {
    kind: 'not-address',
    title: `“${t}” isn’t an address`,
    body: 'Go opens addresses, and this doesn’t look like one. Switch to Ask to put it to Atlas instead.',
    typed: t,
  };
}

/** The brain refused or failed to fetch; its sentence is the body. */
export function notOpened(href: string, message: string, reason: string | null): BrowserRefusal {
  // A private or local address is one the user's own browser may reach, and
  // that is their call; anything Atlas would not even parse is not handed on.
  return {
    kind: 'not-opened',
    title: `Atlas couldn’t open “${displayAddress(href)}”`,
    body: message,
    href: reason === 'scheme' || reason === 'bad-address' ? null : href,
  };
}

/** No brain to fetch through: outside the desktop app, or Atlas is not running. */
export function noBrain(href: string | null, why: string): BrowserRefusal {
  return { kind: 'not-opened', title: 'Atlas can’t fetch pages here', body: why, href };
}

export function tooManyTabs(): BrowserRefusal {
  return {
    kind: 'not-opened',
    title: `${MAX_TABS} tabs are open`,
    body: 'Close one to open another. Atlas keeps every open tab’s copy on this Mac, and that space is finite.',
    href: null,
  };
}

/** Ask with no page to answer from. */
export function askWithoutPage(question: string, hasTab: boolean): BrowserRefusal {
  const q = question.trim();
  return {
    kind: 'no-answer',
    title: 'No page to answer from',
    body: hasTab
      ? 'This tab’s copy wasn’t kept, so there is no text to ask about. Load the page again, then ask. For a general answer, ask Atlas in Talk; it won’t see this page.'
      : 'Nothing is open, so there is nothing on a page to answer from. Ask Atlas in Talk for a general answer.',
    question: q || null,
  };
}

/** The brain answered with an error; its sentence is the body. */
export function askFailed(question: string | null, message: string): BrowserRefusal {
  return { kind: 'no-answer', title: question ? 'No answer from this page' : 'Atlas couldn’t read this page', body: message, question };
}
