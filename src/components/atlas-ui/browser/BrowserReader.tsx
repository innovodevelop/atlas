import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { EyeOff, FileX2, Globe, Unplug } from 'lucide-react';
import { Empty } from '@/components/atlas-ui/primitives';
import { useReducedMotion } from './useReducedMotion';
import type { BrowserPage, BrowserTab, FindMatch } from '@/lib/mocks/browser';

/**
 * The reading pane.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * Not a web view. Atlas has no browser engine, and the Tauri CSP
 * (`default-src 'self'`) would not let a remote page be framed here even if it
 * had one. This renders the *readable copy* of a page — the shape a reader-mode
 * extractor returns — and nothing on screen was fetched from anywhere.
 *
 * ── FIND ────────────────────────────────────────────────────────────────────
 *
 * Highlighting is driven by real matches computed in `findMatches()` against
 * these exact strings, so the count under the omnibox and the marks in the
 * prose can never disagree. The current match carries `data-br-current` and is
 * scrolled into view — instantly when the user has asked for reduced motion.
 *
 * ── THE FIGURE ──────────────────────────────────────────────────────────────
 *
 * A CSS gradient with a caption, exactly as the design draws it. Not a chart:
 * there is no series behind it, so it makes no claim about a shape. The caption
 * says what it would be.
 */

interface Props {
  tab: BrowserTab | null;
  /** Wider column, larger type. The design's reader toggle. */
  reader: boolean;
  isMock: boolean;
  /** The live find query, or '' when not finding. */
  query: string;
  /** Every match on this page, in reading order. */
  matches: FindMatch[];
  /** Index into `matches` of the one being stepped to. */
  cursor: number;
}

/**
 * Split one block of prose around every occurrence of the query.
 *
 * Offsets come from the same scan the omnibox counts with, not from a second
 * search here — one source of truth for "where the matches are".
 */
const highlight = (
  text: string,
  block: number,
  query: string,
  matches: FindMatch[],
  cursor: number,
): ReactNode => {
  if (!query) return text;
  const here = matches
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.block === block);
  if (here.length === 0) return text;

  const out: ReactNode[] = [];
  let at = 0;
  here.forEach(({ m, i }) => {
    if (m.offset > at) out.push(<Fragment key={`t${m.offset}`}>{text.slice(at, m.offset)}</Fragment>);
    const end = m.offset + query.length;
    out.push(
      <mark
        key={`m${m.offset}`}
        className={`br-mark ${i === cursor ? 'br-mark-on' : ''}`}
        data-br-current={i === cursor ? 'true' : undefined}
      >
        {text.slice(m.offset, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) out.push(<Fragment key="tail">{text.slice(at)}</Fragment>);
  return out;
};

/** Blocks in the same order `pageBlocks()` numbers them. Keep the two in step. */
const blockIndex = (page: BrowserPage) => {
  const before = page.paragraphs.length;
  return {
    headline: 0,
    standfirst: 1,
    paragraph: (i: number) => 2 + i,
    caption: 2 + before,
    after: (i: number) => 2 + before + (page.figure ? 1 : 0) + i,
  };
};

export const BrowserReader = ({ tab, reader, isMock, query, matches, cursor }: Props) => {
  const reduced = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Step to the current match. Runs on cursor and query changes only — the mark
  // itself is re-created on every keystroke, so the lookup has to be by
  // attribute rather than by a held ref.
  useEffect(() => {
    if (!query || matches.length === 0) return;
    const el = scrollRef.current?.querySelector('[data-br-current="true"]');
    el?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [cursor, query, matches.length, reduced]);

  if (!tab) {
    return (
      <div className="br-page-pane">
        <Empty
          size="section"
          icon={<Globe className="i20" />}
          title="Nothing open"
          body="No tab is selected. Pick one from the rail, or type an address below."
        />
      </div>
    );
  }

  const page = tab.page;

  if (!page) {
    // Reachable by clicking the Northshore tab: Atlas kept the address but has
    // no readable copy of the page behind it.
    return (
      <div className="br-page-pane">
        <Empty
          size="section"
          status="stale"
          icon={<FileX2 className="i20" />}
          title="No readable copy"
          body={`Atlas kept ${tab.host} but never read it. There is no text to show, and it will not invent one.`}
        />
      </div>
    );
  }

  const bi = blockIndex(page);

  return (
    <div className="br-page-pane" ref={scrollRef}>
      <article className={`br-article ${reader ? 'br-article-reader' : ''}`}>
        <p className="br-kicker">{page.kicker}</p>
        <h1 className="br-headline">
          {highlight(page.headline, bi.headline, query, matches, cursor)}
        </h1>
        <p className="br-standfirst">
          {highlight(page.standfirst, bi.standfirst, query, matches, cursor)}
        </p>

        <div className="br-byline">
          <span className="br-byline-av" aria-hidden>{page.author.initials}</span>
          <div className="br-byline-who">
            <p className="br-byline-name">{page.author.name}</p>
            <p className="br-byline-meta tnum">
              {page.published} · {page.readMinutes} min read
            </p>
          </div>
          {tab.trackersBlocked != null && tab.trackersBlocked > 0 && (
            <span className="br-byline-priv">
              <EyeOff className="i12" />
              <span className="tnum">{tab.trackersBlocked}</span> trackers blocked
            </span>
          )}
          {/* The stamp that stops this reading as a page Atlas actually loaded. */}
          {isMock && <span className="br-stamp br-article-stamp">Sample page</span>}
        </div>

        {page.paragraphs.map((text, i) => (
          <p key={`p${i}`} className="br-para">
            {highlight(text, bi.paragraph(i), query, matches, cursor)}
          </p>
        ))}

        {page.figure && (
          <figure className="br-figure">
            <div className={`br-figure-plate br-figure-${page.figure.tone}`} aria-hidden />
            <figcaption className="br-figure-cap">
              {highlight(page.figure.caption, bi.caption, query, matches, cursor)}
            </figcaption>
          </figure>
        )}

        {page.paragraphsAfter.map((text, i) => (
          <p key={`q${i}`} className="br-para">
            {highlight(text, bi.after(i), query, matches, cursor)}
          </p>
        ))}

        <p className="br-article-end">
          <Unplug className="i14" />
          End of the copy Atlas kept. There is no next page to load.
        </p>
      </article>
    </div>
  );
};
