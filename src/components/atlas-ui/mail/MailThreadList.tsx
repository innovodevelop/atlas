import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MailThread } from '@/types/mail';
import { MailThreadRow } from './MailThreadRow';

/**
 * Fixed row height, in px. The virtual window is computed from it, so `mail.css`
 * must not override the height of `.mail-list-row` — it is published to the
 * stylesheet as `--mail-row-h` on the viewport instead of being duplicated there.
 */
const ROW_H = 96;

/**
 * Below this a plain list is cheaper than the window arithmetic, and the DOM is
 * small enough that the browser's own scrolling is better than ours. Above it a
 * real mailbox (thousands of threads) would otherwise mount every row — the gap
 * the audit flagged as needed *before* real data, not after.
 */
const VIRTUALISE_ABOVE = 60;

/** Rows rendered beyond each edge, so a fast scroll never shows a blank band. */
const OVERSCAN = 6;

interface MailThreadListProps {
  threads: MailThread[];
  selectedThreadId: string | null;
  /** Thread id → preview text, for the threads whose messages are already local. */
  snippets: Record<string, string>;
  onSelect: (threadId: string) => void;
  /** Rendered in place of the rows when `threads` is empty. */
  empty: React.ReactNode;
}

export const MailThreadList = ({ threads, selectedThreadId, snippets, onSelect, empty }: MailThreadListProps) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);

  const virtual = threads.length > VIRTUALISE_ABOVE;

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  const window_ = useMemo(() => {
    if (!virtual) return { start: 0, end: threads.length };
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const end = Math.min(threads.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
    return { start, end };
  }, [virtual, scrollTop, viewportH, threads.length]);

  // Keyboard navigation moves the selection, not the scrollbar — so the list has
  // to follow it, and under virtualisation the selected row may not be mounted at
  // all, which rules out scrollIntoView.
  useEffect(() => {
    if (!selectedThreadId) return;
    const el = viewportRef.current;
    if (!el) return;
    const index = threads.findIndex((t) => t.id === selectedThreadId);
    if (index < 0) return;
    const top = index * ROW_H;
    const bottom = top + ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [selectedThreadId, threads]);

  const viewportStyle = { '--mail-row-h': `${ROW_H}px` } as CSSProperties;

  return (
    <div className="mail-list">
      <div
        className="mail-list-viewport"
        ref={viewportRef}
        onScroll={virtual ? onScroll : undefined}
        style={viewportStyle}
        role="listbox"
        aria-label="Threads"
        aria-activedescendant={selectedThreadId ? `mail-row-${selectedThreadId}` : undefined}
      >
        {threads.length === 0 ? (
          empty
        ) : (
          <div style={virtual ? { position: 'relative', height: threads.length * ROW_H } : undefined}>
            {threads.slice(window_.start, window_.end).map((thread, i) => {
              const index = window_.start + i;
              return (
                <MailThreadRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === selectedThreadId}
                  snippet={snippets[thread.id]}
                  style={
                    virtual
                      ? { position: 'absolute', top: index * ROW_H, left: 0, right: 0, height: ROW_H }
                      : { height: ROW_H }
                  }
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
