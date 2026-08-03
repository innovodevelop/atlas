/**
 * Atlas Browser — the sample dataset.
 *
 * ── THE ONE THING TO KNOW ───────────────────────────────────────────────────
 *
 * ATLAS HAS NO BROWSER ENGINE, and this module does not pretend otherwise.
 * There is no embedded web view, no fetch of remote HTML, no reader-mode
 * extractor — and the Tauri CSP (`default-src 'self'`) means a remote page
 * cannot be framed inside the webview either. Every tab, every page and every
 * observation below is written copy from `Atlas Browser.dc.html`, reproduced so
 * the shell can be designed and reviewed against real-shaped content.
 *
 * The surface says so on screen, in three places you cannot miss: a strip under
 * the band, a `SAMPLE` stamp in the tab rail, and a stamp on the reading pane.
 * All three are gated on `isMock`, so a real adapter turns them off by
 * returning `false` — no edit to the page.
 *
 * This is the deliberate, labelled exception to the project rule "honest UI,
 * not fake data". It is honest *because* it is labelled. Remove the label and
 * it becomes exactly the thing the T4 pass spent a week deleting.
 *
 * ── WHAT IS NOT FAKED, EVEN HERE ────────────────────────────────────────────
 *
 * `engine.available` is `false` and everything that would need an engine
 * refuses out loud rather than running a fake spinner:
 *
 *   - `open()` NEVER returns success. Typing an address and pressing Go returns
 *     `{ ok: false, kind: 'no-engine' }`, and the surface renders that refusal
 *     as a designed state naming the address it could not open. A 1.2s
 *     "loading" shimmer that lands back on the same article — which is what
 *     the design prototype does — would be a lie the sample label does not
 *     cover.
 *   - `ask()` returns only answers that were WRITTEN INTO this file, keyed by
 *     suggestion. It cannot answer free text: `ask('anything else')` returns
 *     `{ ok: false, kind: 'unanswerable' }`. There is no model call here and no
 *     hook pretending to make one.
 *
 * `findMatches()` is genuinely real: it searches the actual paragraph strings
 * of the open page and returns real offsets. Find-on-page is the one thing this
 * surface does that a real adapter would not have to reimplement.
 *
 * ── HOW A REAL ADAPTER REPLACES THIS ────────────────────────────────────────
 *
 * `useAtlasBrowserMock()` returns `UseAtlasBrowser`, which is the shape a real
 * hook returns — nothing about it is mock-specific except that `isMock` is true
 * and `session` is preloaded. An adapter (say `src/hooks/useAtlasBrowserData.ts`,
 * driving a real engine through Tauri commands) implements the same interface
 * and the swap is ONE line in `AtlasBrowser.tsx`:
 *
 *     -import { useAtlasBrowserMock as useBrowser } from '@/lib/mocks/browser';
 *     +import { useAtlasBrowserData as useBrowser } from '@/hooks/useAtlasBrowserData';
 *
 * with `isMock: false` retiring every sample treatment on its own, and
 * `engine.available: true` retiring the refusal states.
 *
 * The real adapter returns `session: null` until an engine reports in, which is
 * why the page's first branch is a genuine empty state and not a spinner.
 *
 * ── PICTURES ────────────────────────────────────────────────────────────────
 *
 * There are none, by construction. `image-slot.js` is a prototype helper the
 * handoff explicitly excludes from porting, and the design's tab favicons are
 * `google.com/s2/favicons` URLs — remote images, which do not belong in a
 * local-first app that must render with the network off. Every tab therefore
 * carries a `preview` record of flat tokens (bar, wordmark, hero, ink) that
 * `BrowserThumb` draws in CSS, and a monogram tile instead of a favicon. That
 * IS the design's own placeholder treatment; it is simply the only one now.
 *
 * ── HOSTS ───────────────────────────────────────────────────────────────────
 *
 * The design seeds the rail with four real publications and attributes
 * behaviour to them ("Paywall bypassed via your account" under The Washington
 * Post). Invented claims about named real companies are a different kind of
 * fiction from invented copy, and the sample label does not cover it, so the
 * real brands are gone. `fieldnotes.press` is the design's own fictional
 * publication and is kept verbatim; the rest are fictional in the same key.
 */
import { useCallback, useMemo, useState } from 'react';

/** The one flag the UI reads to decide whether to wear the sample treatment. */
export const IS_MOCK = true;

/* ── Vocabulary ───────────────────────────────────────────────────────────── */

/** The omnibox's three jobs. Cycled by the sphere, or ⌘L / ⌘K / ⌘F. */
export type BrowserMode = 'go' | 'ask' | 'find';

export const BROWSER_MODES: readonly BrowserMode[] = ['go', 'ask', 'find'] as const;

/** What an observation in the reading panel is. Drives its icon and tint. */
export type PointKind = 'claim' | 'link' | 'warn' | 'quote';

/**
 * A tab thumbnail, as flat tokens rather than an image.
 *
 * Drawn by `BrowserThumb` with backgrounds and radii only — no `<img>`, no
 * network, nothing the CSP has to allow. Values are the design's own
 * `pv*` fields.
 */
export interface TabPreview {
  /** Page fill behind everything. */
  bg: string;
  /** The site's masthead band. */
  bar: string;
  /** Masthead height, as a CSS length. */
  barHeight: string;
  /** Wordmark text in the masthead. Empty renders a bare band. */
  mark: string;
  markFg: string;
  /** `display` or `ui` — Hanken Grotesk or Geist. */
  markFont: 'display' | 'ui';
  markTracking: string;
  /** Top offset of the hero block, as a percentage of the card. */
  heroTop: string;
  /** The hero block's fill. A gradient, never a photo. */
  hero: string;
  /** Colour of the three text-line bars. */
  ink: string;
}

/** A paragraph-level figure. A CSS gradient with a caption — not an image. */
export interface PageFigure {
  caption: string;
  /** Which of the two gradients in `browser.css` to paint. */
  tone: 'paper' | 'slate';
}

/** The readable copy of a page, as an extractor would return it. */
export interface BrowserPage {
  kicker: string;
  headline: string;
  standfirst: string;
  author: { name: string; initials: string };
  published: string;
  readMinutes: number;
  /** Body before the figure. */
  paragraphs: string[];
  figure: PageFigure | null;
  /** Body after the figure. */
  paragraphsAfter: string[];
}

/** One observation Atlas made about the open page. */
export interface PagePoint {
  id: string;
  kind: PointKind;
  title: string;
  body: string;
}

/** What Atlas has to say about a page it has read. */
export interface PageAnalysis {
  summary: string;
  points: PagePoint[];
}

export interface BrowserTab {
  id: string;
  title: string;
  host: string;
  /** Full address as it would sit in the omnibox. */
  url: string;
  /** Monogram shown where a favicon would be. */
  initial: string;
  /** The site's mark colour. Tints the monogram and the read bar. */
  mark: string;
  /** What Atlas did here. `null` when it has nothing to report — not a filler string. */
  note: string | null;
  /** 0–1, or `null` when nothing has been read. */
  readProgress: number | null;
  /** `null` when blocking never ran on this tab. */
  trackersBlocked: number | null;
  preview: TabPreview;
  /** `null` when Atlas kept the address but no readable copy. */
  page: BrowserPage | null;
  /** `null` when Atlas has not read the page. Distinct from an empty analysis. */
  analysis: PageAnalysis | null;
}

/** A shelf in the rail's "Atlas kept" list. */
export interface KeptShelf {
  id: string;
  /** Exact lucide-react export name. */
  icon: string;
  label: string;
  count: number;
}

export interface BrowserSession {
  tabs: BrowserTab[];
  selectedTabId: string | null;
  kept: KeptShelf[];
}

/**
 * Whether anything on this machine can actually load a page.
 *
 * A real adapter sets `available: true` once an engine reports in. Until then
 * the surface refuses in the open, and this string is the refusal.
 */
export interface BrowserEngine {
  available: boolean;
  reason: string;
}

/** The result of asking to open an address. A union so success is expressible. */
export type OpenResult =
  | { ok: true; tabId: string }
  | { ok: false; kind: 'no-engine'; url: string; reason: string }
  | { ok: false; kind: 'empty' };

/** The result of asking Atlas something. */
export type AskResult =
  | { ok: true; answer: BrowserAnswer }
  | { ok: false; kind: 'unanswerable'; question: string; reason: string }
  | { ok: false; kind: 'empty' };

/** An answer Atlas gave, as it appears in the reading panel. */
export interface BrowserAnswer {
  id: string;
  question: string;
  body: string;
  /** Where the answer came from, named. Sample answers say so. */
  basis: string;
}

/** A prompt offered under the omnibox in `ask` mode. */
export interface AskSuggestion {
  id: string;
  icon: string;
  label: string;
  meta: string;
  kind: PointKind;
  /** The written answer `ask()` returns for this prompt. */
  answer: string;
  basis: string;
}

/** A row offered under the omnibox in `go` mode. */
export interface GoSuggestion {
  id: string;
  icon: string;
  label: string;
  meta: string;
}

/* ── The pages ────────────────────────────────────────────────────────────── */

const QUIET_INTERFACE: BrowserPage = {
  kicker: 'Field Notes · Interfaces',
  headline: 'The quiet interface: what happens when software stops asking for attention',
  standfirst:
    'A decade of notifications taught us to interrupt. The next decade of assistants will be judged on how rarely they need to.',
  author: { name: 'Sonia Reyes', initials: 'SR' },
  published: '24 July 2026',
  readMinutes: 9,
  paragraphs: [
    'For twenty years the dominant metric of a consumer interface was engagement: minutes held, sessions started, notifications opened. The assistants arriving now are being measured against a stranger yardstick — how much of a person’s day they can quietly remove.',
    'The shift is not cosmetic. An assistant that acts on your behalf has to earn a different kind of trust than one that merely answers. It must show its work without demanding you read it, and it must know the precise moment to stop and ask.',
    'In interviews with fourteen teams building agentic software this spring, the same design problem surfaced repeatedly: the hardest state to design is not the answer. It is the pause.',
  ],
  figure: {
    caption: 'Figure 1 — Latency of assistive interfaces against perceived helpfulness, 2021–2026.',
    tone: 'paper',
  },
  paragraphsAfter: [
    'Where earlier products treated a hand-off to a human as a failure, the teams furthest along treat it as a feature with its own craft — a written brief, the sources consulted, and an explicit statement of what the system chose not to do.',
    'That restraint is expensive to build and almost invisible when it works. Which may be the point: the quiet interface is the one you stop noticing, right up until the moment it decides you should.',
  ],
};

const LEDGER_PIECE: BrowserPage = {
  kicker: 'The Ledger · Markets',
  headline: 'The quarter nobody hedged for',
  standfirst:
    'Three currencies moved together for the first time since 2019, and the desks that called it are not saying much.',
  author: { name: 'Aleks Buhl', initials: 'AB' },
  published: '31 July 2026',
  readMinutes: 6,
  paragraphs: [
    'Correlation is the cheapest thing to explain after the fact and the most expensive thing to be wrong about beforehand. The three-way move that closed the quarter was, by every desk’s own telling, unhedged.',
    'What makes it worth writing down is not the size of the move but its shape: it arrived slowly, over eleven sessions, in a market that has spent two years training itself to react to shocks rather than drifts.',
  ],
  figure: null,
  paragraphsAfter: [
    'The uncomfortable reading is that the models were fine and the risk limits were fine, and the thing that failed was the assumption that a slow move gives you time to think.',
  ],
};

const HALCYON_PIECE: BrowserPage = {
  kicker: 'Halcyon Instruments · Documentation',
  headline: 'Calibrating the field probe',
  standfirst: 'Bench procedure for the HX-4 series, revision 11.',
  author: { name: 'Halcyon Instruments', initials: 'HI' },
  published: '2 August 2026',
  readMinutes: 4,
  paragraphs: [
    'Allow the probe to reach ambient temperature before the first reading. A probe brought in from a cold vehicle will read approximately four percent low for the first eleven minutes, and the drift is not linear.',
    'Zero against the supplied reference block, never against air. Air zeroing is the single most common cause of the fault code the support desk sees most often.',
  ],
  figure: {
    caption: 'Figure 2 — Warm-up drift, HX-4 against reference, first twenty minutes.',
    tone: 'slate',
  },
  paragraphsAfter: [
    'Record the calibration constant in the log sheet at the back of this document. The instrument stores it, but the instrument is not the record.',
  ],
};

const MERIDIAN_PIECE: BrowserPage = {
  kicker: 'Meridian Labs · Research',
  headline: 'Small models, long horizons',
  standfirst:
    'What a year of running the same evaluation every Monday morning actually told us.',
  author: { name: 'Priya Raman', initials: 'PR' },
  published: '19 July 2026',
  readMinutes: 12,
  paragraphs: [
    'A benchmark run once is a measurement. A benchmark run fifty-two times is a time series, and the two answer different questions. We had been asking the first one for years.',
    'The headline result is dull and, we think, important: on the tasks we care about, week-to-week variance in our own harness was larger than the gap we had been reporting between two model generations.',
  ],
  figure: null,
  paragraphsAfter: [
    'We are publishing the harness, the weekly logs and the two runs we threw away, along with the reason we threw them away. The last of those is the part we would have wanted from someone else.',
  ],
};

/* ── The tabs ─────────────────────────────────────────────────────────────── */

const TABS: BrowserTab[] = [
  {
    id: 't1',
    title: 'The quiet interface',
    host: 'fieldnotes.press',
    url: 'fieldnotes.press/2026/the-quiet-interface',
    initial: 'F',
    mark: '#c2551e',
    note: 'Summarised · 3 claims checked',
    readProgress: 0.62,
    trackersBlocked: 14,
    preview: {
      bg: '#fffdfa', bar: '#1e1e24', barHeight: '17%', mark: 'FIELD NOTES', markFg: '#f7f5f2',
      markFont: 'ui', markTracking: '.16em', heroTop: '26%',
      hero: 'linear-gradient(150deg,#efe9df,#dfd8cc 60%,#cfd6dd)', ink: '#2c2a28',
    },
    page: QUIET_INTERFACE,
    analysis: {
      summary:
        'The piece argues agentic assistants should be judged on restraint rather than engagement, and that the hardest design problem is the pause before acting — not the answer itself. Based on interviews with fourteen teams.',
      points: [
        {
          id: 'p1', kind: 'quote', title: 'The claim',
          body: 'Engagement metrics are the wrong yardstick for software that acts on your behalf.',
        },
        {
          id: 'p2', kind: 'link', title: 'Related to your work',
          body: 'Overlaps with the escalation rules you set on your mail account three weeks ago.',
        },
        {
          id: 'p3', kind: 'warn', title: 'Unsourced',
          body: 'The “fourteen teams” figure has no methodology note. Treat it as anecdotal.',
        },
      ],
    },
  },
  {
    id: 't2',
    title: 'The quarter nobody hedged for',
    host: 'ledger.press',
    url: 'ledger.press/markets/the-quarter-nobody-hedged-for',
    initial: 'L',
    mark: '#8b6f3f',
    note: 'Two figures cross-checked',
    readProgress: 0.24,
    trackersBlocked: 6,
    preview: {
      bg: '#fffdfa', bar: '#f1eeea', barHeight: '19%', mark: 'THE LEDGER', markFg: '#1e1e24',
      markFont: 'display', markTracking: '.08em', heroTop: '28%',
      hero: 'linear-gradient(140deg,#c9d3dd,#9fb0c0)', ink: '#141414',
    },
    page: LEDGER_PIECE,
    analysis: {
      summary:
        'A slow three-way currency move closed the quarter unhedged across several desks. The argument is about shape, not size: the market is trained on shocks and this was a drift.',
      points: [
        {
          id: 'p1', kind: 'claim', title: 'The claim',
          body: 'Risk limits held; the failed assumption was that a slow move leaves time to think.',
        },
        {
          id: 'p2', kind: 'warn', title: 'No desk named',
          body: 'Every attribution here is anonymous. Nothing in the piece can be checked against a named source.',
        },
      ],
    },
  },
  {
    id: 't3',
    title: 'Calibrating the field probe',
    host: 'halcyon.tools',
    url: 'halcyon.tools/docs/hx-4/calibration',
    initial: 'H',
    mark: '#2f7d5e',
    note: null,
    readProgress: 0.46,
    trackersBlocked: 0,
    preview: {
      bg: '#f7f5f2', bar: '#2f7d5e', barHeight: '15%', mark: 'HALCYON', markFg: '#fffdfa',
      markFont: 'ui', markTracking: '.2em', heroTop: '24%',
      hero: 'linear-gradient(160deg,#2b2b2f,#4a4a52 55%,#1d1d1f)', ink: '#1d1d1f',
    },
    page: HALCYON_PIECE,
    // Deliberately unread: this is what reaches the panel's "not read yet" state.
    analysis: null,
  },
  {
    id: 't4',
    title: 'Northshore Review',
    host: 'northshore.review',
    url: 'northshore.review',
    initial: 'N',
    mark: '#5b3ce0',
    note: 'Address kept — nothing read',
    readProgress: null,
    trackersBlocked: 9,
    preview: {
      bg: '#fffdfa', bar: '#fffdfa', barHeight: '20%', mark: 'Northshore Review', markFg: '#1e1e24',
      markFont: 'display', markTracking: '0', heroTop: '30%',
      hero: 'linear-gradient(140deg,#d8d4cd,#b9b3a9)', ink: '#1e1e24',
    },
    // Deliberately empty: this is what reaches the reader's "no readable copy" state.
    page: null,
    analysis: null,
  },
  {
    id: 't5',
    title: 'Small models, long horizons',
    host: 'meridianlabs.org',
    url: 'meridianlabs.org/research/small-models-long-horizons',
    initial: 'M',
    mark: '#2f4bbd',
    note: '2 papers saved to Reading',
    readProgress: 0.8,
    trackersBlocked: 2,
    preview: {
      bg: '#f0eee6', bar: '#f0eee6', barHeight: '18%', mark: 'MERIDIAN', markFg: '#141413',
      markFont: 'display', markTracking: '.02em', heroTop: '27%',
      hero: 'linear-gradient(150deg,#8ea3d8,#e2dccf 70%)', ink: '#141413',
    },
    page: MERIDIAN_PIECE,
    analysis: {
      summary:
        'A year of running one evaluation weekly produced a dull, useful result: harness variance exceeded the generation-to-generation gap the lab had been reporting.',
      points: [
        {
          id: 'p1', kind: 'claim', title: 'The claim',
          body: 'Week-to-week variance in their own harness was larger than the model-generation gap.',
        },
        {
          id: 'p2', kind: 'quote', title: 'Published with it',
          body: 'The harness, the weekly logs, and the two discarded runs with the reason for discarding them.',
        },
      ],
    },
  },
];

const KEPT: KeptShelf[] = [
  { id: 'k1', icon: 'Bookmark', label: 'Reading · Interfaces', count: 6 },
  { id: 'k2', icon: 'Clock', label: 'Yesterday', count: 23 },
  { id: 'k3', icon: 'Sparkles', label: 'Answers Atlas saved', count: 11 },
];

const SESSION: BrowserSession = {
  tabs: TABS,
  selectedTabId: 't1',
  kept: KEPT,
};

/**
 * No engine, and the reason a user can act on.
 *
 * Exported so the page can render it verbatim rather than paraphrasing it in
 * three different states.
 */
export const ENGINE: BrowserEngine = {
  available: false,
  reason:
    'Atlas has no browser engine yet. Nothing on this screen was loaded from the network, and typing an address will not open one.',
};

/* ── Prompts ──────────────────────────────────────────────────────────────── */

/**
 * The `ask` prompts, each with the answer `ask()` gives for it.
 *
 * Written answers, not generated ones. A prompt with no answer written here is
 * unanswerable and says so — which is what free text hits.
 */
const ASK_SUGGESTIONS: Record<string, AskSuggestion[]> = {
  t1: [
    {
      id: 'a1', icon: 'List', label: 'Summarise this in three lines', meta: 'on this page',
      kind: 'claim',
      answer:
        'Engagement is the wrong yardstick for software that acts for you. The hardest state to design is the pause before acting, not the answer. Fourteen teams were interviewed, with no methodology note attached to the figure.',
      basis: 'Written into the sample set — the summary above, split three ways.',
    },
    {
      id: 'a2', icon: 'Scale', label: 'What would the strongest counter-argument be?',
      meta: 'reasons over sources', kind: 'link',
      answer:
        'That restraint is unfalsifiable as a product metric: an assistant that does nothing scores perfectly. The piece never proposes a way to tell deliberate restraint from an assistant that simply failed to act.',
      basis: 'Written into the sample set. Atlas did not reason about this page.',
    },
    {
      id: 'a3', icon: 'Quote', label: 'Who is quoted, and what do they actually claim?',
      meta: 'nobody, on this page', kind: 'warn',
      answer:
        'Nobody is quoted. The piece refers to interviews with fourteen unnamed teams and carries no direct quotation, which is worth knowing before citing it.',
      basis: 'Checkable against the paragraphs on screen — there are no quotation marks in them.',
    },
  ],
  t2: [
    {
      id: 'a4', icon: 'List', label: 'Summarise this in three lines', meta: 'on this page',
      kind: 'claim',
      answer:
        'Three currencies moved together for the first time since 2019. The move was slow — eleven sessions — in a market trained on shocks. Limits and models held; the assumption that a drift leaves time to think did not.',
      basis: 'Written into the sample set — the summary above, split three ways.',
    },
    {
      id: 'a5', icon: 'Scale', label: 'What would the strongest counter-argument be?',
      meta: 'reasons over sources', kind: 'link',
      answer:
        'That a correlation observed once is not a regime. With no named desk and no position data, the piece cannot distinguish a structural change from eleven sessions of noise.',
      basis: 'Written into the sample set. Atlas did not reason about this page.',
    },
  ],
  t5: [
    {
      id: 'a6', icon: 'List', label: 'Summarise this in three lines', meta: 'on this page',
      kind: 'claim',
      answer:
        'One evaluation, run every Monday for a year, becomes a time series rather than a measurement. Harness variance week to week exceeded the reported gap between model generations. The harness, the logs and the discarded runs are all published.',
      basis: 'Written into the sample set — the summary above, split three ways.',
    },
    {
      id: 'a7', icon: 'Quote', label: 'What did they throw away, and why?',
      meta: '2 discarded runs', kind: 'quote',
      answer:
        'Two runs, discarded with the reason published alongside them. The piece frames that disclosure as the part they would most have wanted from another lab.',
      basis: 'Checkable against the closing paragraph on screen.',
    },
  ],
};

/** The `go` rows. History and pins — addresses, not results. */
const GO_SUGGESTIONS: GoSuggestion[] = [
  { id: 'g1', icon: 'Clock', label: 'fieldnotes.press/2026/the-quiet-interface', meta: 'in a tab' },
  { id: 'g2', icon: 'Star', label: 'meridianlabs.org/research', meta: 'pinned' },
  { id: 'g3', icon: 'Clock', label: 'halcyon.tools/docs/hx-4', meta: 'in a tab' },
];

/** Prompts for the open tab. Empty when nothing has been written for it. */
export const askSuggestionsFor = (tab: BrowserTab | null): AskSuggestion[] =>
  (tab && ASK_SUGGESTIONS[tab.id]) || [];

/** History rows, filtered by whatever is typed. Real filtering over a fixed list. */
export const goSuggestionsFor = (query: string): GoSuggestion[] => {
  const q = query.trim().toLowerCase();
  if (!q) return GO_SUGGESTIONS;
  return GO_SUGGESTIONS.filter((s) => s.label.toLowerCase().includes(q));
};

/* ── Find on page — the one genuinely computed thing here ─────────────────── */

export interface FindMatch {
  /** Index into the page's full paragraph list, figure caption included. */
  block: number;
  /** Character offset of the match inside that block. */
  offset: number;
  /** The matched text plus a little either side, for the result row. */
  context: string;
}

/** Every block of prose on a page, in reading order. */
export const pageBlocks = (page: BrowserPage): string[] => [
  page.headline,
  page.standfirst,
  ...page.paragraphs,
  ...(page.figure ? [page.figure.caption] : []),
  ...page.paragraphsAfter,
];

/**
 * Real search over the real text on screen. Case-insensitive, every occurrence,
 * in reading order — no cap, because a count the user can trust is the point.
 */
export const findMatches = (page: BrowserPage | null, query: string): FindMatch[] => {
  const q = query.trim().toLowerCase();
  if (!page || q.length === 0) return [];
  const out: FindMatch[] = [];
  pageBlocks(page).forEach((text, block) => {
    const hay = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(q, from);
      if (at === -1) break;
      out.push({
        block,
        offset: at,
        context: text.slice(Math.max(0, at - 28), Math.min(text.length, at + q.length + 34)).trim(),
      });
      from = at + q.length;
    }
  });
  return out;
};

/* ── The hook a real adapter has to match ─────────────────────────────────── */

export interface UseAtlasBrowser {
  /** `null` is the day-one state of any real adapter: no engine has reported in. */
  session: BrowserSession | null;
  loading: boolean;
  error: string | null;
  /** Drives every sample-data treatment on screen. A real adapter sets it false. */
  isMock: boolean;
  /** Whether anything can actually be loaded. False here, and said out loud. */
  engine: BrowserEngine;
  /** Answers Atlas has given this session, newest first. Empty on arrival. */
  answers: BrowserAnswer[];
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  /** Closes every tab — the route to the surface's own empty state. */
  closeAll: () => void;
  /** Puts the sample session back after `closeAll`. A real adapter would not have it. */
  restoreSample: () => void;
  /** Never succeeds while `engine.available` is false. */
  open: (input: string) => OpenResult;
  /** Answers only what is written in this file; refuses everything else by name. */
  ask: (question: string, suggestionId?: string) => AskResult;
  dismissAnswer: (id: string) => void;
  /** Part of the contract a real adapter owes. The mock cannot refresh anything. */
  refresh: () => Promise<void>;
}

/**
 * Sample-backed implementation.
 *
 * It does not pretend to fetch: `loading` is false on the first render, there
 * is no timer, and no promise resolves late. The behaviour that IS real — tab
 * selection and closing, mode state, find-on-page, answer history — is real
 * because it operates on data already in memory.
 */
export const useAtlasBrowserMock = (): UseAtlasBrowser => {
  const [tabs, setTabs] = useState<BrowserTab[]>(SESSION.tabs);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(SESSION.selectedTabId);
  const [answers, setAnswers] = useState<BrowserAnswer[]>([]);

  const selectTab = useCallback((id: string) => setSelectedTabId(id), []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setSelectedTabId((cur) => {
        if (cur !== id) return next.length ? cur : null;
        const at = prev.findIndex((t) => t.id === id);
        return next[Math.min(at, next.length - 1)]?.id ?? null;
      });
      return next;
    });
  }, []);

  const closeAll = useCallback(() => {
    setTabs([]);
    setSelectedTabId(null);
    setAnswers([]);
  }, []);

  const restoreSample = useCallback(() => {
    setTabs(SESSION.tabs);
    setSelectedTabId(SESSION.selectedTabId);
    setAnswers([]);
  }, []);

  /**
   * The refusal. No engine means no navigation, and the honest response is to
   * name the address and say why — not to spin for 1.2s and land on the page
   * that was already open.
   */
  const open = useCallback((input: string): OpenResult => {
    const url = input.trim().replace(/^https?:\/\//, '');
    if (!url) return { ok: false, kind: 'empty' };
    return { ok: false, kind: 'no-engine', url, reason: ENGINE.reason };
  }, []);

  const ask = useCallback((question: string, suggestionId?: string): AskResult => {
    const text = question.trim();
    if (!text && !suggestionId) return { ok: false, kind: 'empty' };

    const pool = Object.values(ASK_SUGGESTIONS).flat();
    const hit = suggestionId
      ? pool.find((s) => s.id === suggestionId)
      : pool.find((s) => s.label.toLowerCase() === text.toLowerCase());

    if (!hit) {
      return {
        ok: false,
        kind: 'unanswerable',
        question: text,
        reason:
          'This surface has no model behind it. Only the written prompts below can be answered — anything else would be invented.',
      };
    }

    const answer: BrowserAnswer = {
      id: `${hit.id}-${answers.length}`,
      question: hit.label,
      body: hit.answer,
      basis: hit.basis,
    };
    setAnswers((prev) => [answer, ...prev]);
    return { ok: true, answer };
  }, [answers.length]);

  const dismissAnswer = useCallback((id: string) => {
    setAnswers((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const refresh = useCallback(async () => {}, []);

  const session = useMemo<BrowserSession | null>(
    () => ({ tabs, selectedTabId, kept: tabs.length ? KEPT : [] }),
    [tabs, selectedTabId],
  );

  return {
    session,
    loading: false,
    error: null,
    isMock: IS_MOCK,
    engine: ENGINE,
    answers,
    selectTab,
    closeTab,
    closeAll,
    restoreSample,
    open,
    ask,
    dismissAnswer,
    refresh,
  };
};

/* ── Derivations shared by the page and its components ────────────────────── */

/** The open tab, or null. */
export const openTab = (session: BrowserSession | null): BrowserTab | null => {
  if (!session || !session.selectedTabId) return null;
  return session.tabs.find((t) => t.id === session.selectedTabId) ?? null;
};

/** Trackers blocked on the open tab, or null when blocking never ran there. */
export const blockedOn = (tab: BrowserTab | null): number | null =>
  tab && tab.trackersBlocked != null ? tab.trackersBlocked : null;

/** Per-mode omnibox copy. One place, so the button, placeholder and hint agree. */
export const MODE_COPY: Record<BrowserMode, {
  label: string; icon: string; placeholder: string; shortcut: string;
  submit: string; submitTitle: string;
}> = {
  go: {
    label: 'Go', icon: 'Compass', placeholder: 'Type a site, or paste a link',
    shortcut: '⌘L', submit: 'Open', submitTitle: 'Open this address',
  },
  ask: {
    label: 'Ask Atlas', icon: 'Sparkles', placeholder: 'Ask anything about this page',
    shortcut: '⌘K', submit: 'Ask', submitTitle: 'Ask Atlas about this page',
  },
  find: {
    label: 'Find', icon: 'Search', placeholder: 'Find on page',
    shortcut: '⌘F', submit: 'Next', submitTitle: 'Next match',
  },
};
