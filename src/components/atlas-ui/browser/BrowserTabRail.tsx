import { Bookmark, Clock, Plus, Sparkles, X, type LucideIcon } from 'lucide-react';
import { Button, Empty } from '@/components/atlas-ui/primitives';
import { BrowserThumb } from './BrowserThumb';
import type { BrowserTab, KeptShelf } from '@/lib/mocks/browser';

/**
 * The left rail: the tab stack, the shelves Atlas kept, and the privacy line.
 *
 * ── THE STACK ───────────────────────────────────────────────────────────────
 *
 * The design's signature move. Cards overlap and lean back by distance from
 * the open one: the open card is full height and full scale, its neighbours
 * pull up 6px at 0.965, everything further back pulls up 16px at 0.93 and
 * dims. Those are the design's own numbers, applied here as a CSS custom
 * property per card so the stylesheet owns the physics and this file only
 * decides how far back a card sits.
 *
 * The cards are real buttons in a `listbox`, so the stack is reachable by
 * keyboard even though it reads as a pile of paper.
 *
 * ── WHAT THE DESIGN HAS THAT THIS DOES NOT ──────────────────────────────────
 *
 * Three macOS traffic lights sit at the top of the design's rail. They are
 * drawn, not wired — and the app runs with `titleBarStyle: "Overlay"`, so the
 * real ones are already on screen a few pixels away. Two sets of window
 * controls, one of which does nothing, is worse than none.
 *
 * ── WHAT THIS HAS THAT THE DESIGN DOES NOT ──────────────────────────────────
 *
 * A close control per tab. The design offers a `+` and no `×`, which leaves the
 * surface with no way to reach its own empty state; you cannot review an empty
 * state you cannot get to. It appears on hover and on keyboard focus.
 */
const SHELF_ICONS: Record<string, LucideIcon> = {
  Bookmark, Clock, Sparkles,
};

interface Props {
  tabs: BrowserTab[];
  selectedTabId: string | null;
  kept: KeptShelf[];
  /** Trackers blocked on the open tab; `null` when blocking never ran there. */
  blocked: number | null;
  isMock: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Puts the omnibox in `go` mode — the design's `+` does exactly this. */
  onNewTab: () => void;
}

export const BrowserTabRail = ({
  tabs, selectedTabId, kept, blocked, isMock, onSelect, onClose, onNewTab,
}: Props) => {
  const activeIndex = tabs.findIndex((t) => t.id === selectedTabId);

  return (
    <aside className="br-rail" aria-label="Open tabs">
      <div className="br-rail-head">
        <p className="br-rail-brand">
          atlas <span className="br-rail-brand-2">browse</span>
        </p>
        {isMock && <span className="br-stamp">Sample</span>}
        <Button
          size="icon"
          variant="text"
          aria-label="New tab"
          title="New tab"
          className="br-rail-new"
          onClick={onNewTab}
        >
          <Plus className="i14" />
        </Button>
      </div>

      <div className="br-rail-stack" role="listbox" aria-label="Open tabs">
        <p className="br-rail-label">Open</p>

        {tabs.length === 0 ? (
          <Empty
            className="br-rail-empty"
            size="block"
            status="stale"
            title="No tabs"
            body="Nothing is open. Type an address below to start one."
          />
        ) : (
          tabs.map((tab, i) => {
            const on = tab.id === selectedTabId;
            // Distance from the open card is the only thing that decides how far
            // back a card leans. Clamped at 2 — the design flattens past that.
            const depth = activeIndex < 0 ? 2 : Math.min(2, Math.abs(i - activeIndex));
            return (
              <div
                key={tab.id}
                className={`br-tab ${on ? 'br-tab-on' : ''}`}
                data-depth={on ? 0 : depth}
                style={{ zIndex: on ? 30 : 20 - depth, ['--br-first' as string]: i === 0 ? '0px' : '' }}
              >
                <button
                  type="button"
                  className="br-tab-hit"
                  role="option"
                  aria-selected={on}
                  onClick={() => onSelect(tab.id)}
                  title={tab.url}
                >
                  <BrowserThumb preview={tab.preview} />
                  <span className="br-tab-veil" aria-hidden />

                  <span className="br-tab-chip">
                    <span className="br-tab-mono" style={{ background: tab.mark }} aria-hidden>
                      {tab.initial}
                    </span>
                    <span className="br-tab-names">
                      <span className="br-tab-title trunc">{tab.title}</span>
                      <span className="br-tab-host trunc">{tab.host}</span>
                    </span>
                    <span className="br-tab-idx tnum">{String(i + 1).padStart(2, '0')}</span>
                  </span>

                  {/* Only the open card narrates, and only when there is
                      something to narrate. A tab Atlas has not touched shows
                      nothing rather than "Open · nothing to report". */}
                  {on && tab.note && (
                    <span className="br-tab-note">
                      <span className="br-tab-note-dot" style={{ background: tab.mark }} aria-hidden />
                      <span className="trunc">{tab.note}</span>
                    </span>
                  )}

                  {/* A drawing, not a border: how far down the page you read. */}
                  {on && tab.readProgress != null && (
                    <span className="br-tab-read" aria-hidden>
                      <span
                        className="br-tab-read-fill"
                        style={{ width: `${Math.round(tab.readProgress * 100)}%`, background: tab.mark }}
                      />
                    </span>
                  )}
                </button>

                <Button
                  size="icon"
                  variant="text"
                  aria-label={`Close ${tab.title}`}
                  title="Close tab"
                  className="br-tab-close"
                  onClick={() => onClose(tab.id)}
                >
                  <X className="i12" />
                </Button>
              </div>
            );
          })
        )}
      </div>

      <div className="br-kept">
        <p className="br-rail-label">Atlas kept</p>
        {kept.length === 0 ? (
          <Empty body="Nothing kept yet. Saved pages and answers collect here." />
        ) : (
          kept.map((shelf) => {
            const Icon = SHELF_ICONS[shelf.icon] ?? Bookmark;
            return (
              <div key={shelf.id} className="br-kept-row">
                <Icon className="i14 br-kept-ico" />
                <span className="br-kept-label trunc">{shelf.label}</span>
                <span className="br-kept-count tnum">{shelf.count}</span>
              </div>
            );
          })
        )}
      </div>

      {/* The privacy line. Bound to the open tab, and honest about the third
          state: a tab where blocking never ran is not a tab with zero trackers. */}
      <div className="br-privacy">
        <span
          className={`br-privacy-dot ${blocked == null ? 'br-privacy-dot-off' : ''}`}
          aria-hidden
        />
        <span className="br-privacy-text">
          {blocked == null
            ? 'No blocking recorded here'
            : blocked === 0
              ? 'Nothing to block here'
              : `${blocked} tracker${blocked === 1 ? '' : 's'} blocked here`}
        </span>
      </div>
    </aside>
  );
};
