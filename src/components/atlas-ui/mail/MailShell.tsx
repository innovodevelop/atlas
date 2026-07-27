import { useEffect, useState, type ReactNode } from 'react';

/**
 * The handoff assumes a fixed ≥1400px shell with no media queries, so the
 * responsive behaviour is ours (contract §6.5): below 1100px the sidebar
 * collapses to a top row of view pills, and below 820px the list and pane stack
 * into one full-width column with the selection deciding which is on screen.
 *
 * The breakpoints are evaluated here rather than in `mail.css` because the
 * stacked layout is a *behaviour* — which pane exists — not only a style, and
 * `hidden` keeps the off-screen pane out of the tab order and the a11y tree.
 */
const COLLAPSE_SIDEBAR = '(max-width: 1100px)';
const STACK_PANES = '(max-width: 820px)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Exposed so the page can tell the reading pane it needs a Back control. */
export const useMailStacked = () => useMediaQuery(STACK_PANES);

interface MailShellProps {
  sidebar: ReactNode;
  list: ReactNode;
  pane: ReactNode;
  /**
   * Route-level notices, above the three panes. They belong to the shell rather
   * than to a pane because a send refusal or a lost inbound message has to be
   * on screen in every pane state — and because the shell is sized to the
   * viewport, so whatever they occupy has to come out of the panes' height
   * instead of pushing the bottom of the reading pane off the fold.
   */
  notices?: ReactNode;
  /** In the stacked layout, true shows the reading pane instead of the list. */
  paneVisible: boolean;
}

export const MailShell = ({ sidebar, list, pane, notices, paneVisible }: MailShellProps) => {
  const collapsed = useMediaQuery(COLLAPSE_SIDEBAR);
  const stacked = useMediaQuery(STACK_PANES);

  return (
    <div className="mail-route">
      {notices}
      <div className={`mail-shell${collapsed ? ' mail-shell-collapsed' : ''}`}>
        <div className="mail-shell-sidebar">{sidebar}</div>
        <div className="mail-shell-list" hidden={stacked && paneVisible}>{list}</div>
        <div className="mail-shell-pane" hidden={stacked && !paneVisible}>{pane}</div>
      </div>
    </div>
  );
};
