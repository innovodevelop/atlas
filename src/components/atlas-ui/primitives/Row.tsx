import type { HTMLAttributes, ReactNode } from 'react';

/**
 * A list row.
 *
 * Eight near-identical classes did this job — `.row0`/`.rowB`, `.flowrow`,
 * `.kbrow`, `.qrow`, `.errrow`, `.wclk`, `.srow`, `.mailrow` — each one
 * `display:flex; padding:Npx 0; border-bottom:1px solid var(--bd)` with a
 * `.last{border:none}` partner. README §1.1 collapses all of them: the divider
 * is gone and 18–20px of vertical padding carries the rhythm instead.
 *
 * THERE IS NO `last` PROP, on purpose. The last-row special case is exactly
 * what the borderless rule deletes; carrying it forward would re-encode the
 * divider in the type system. The eight `.last{border:none}` rules and the
 * fourteen `i === rows.length - 1 ? 'last' : ''` ternaries that fed them are
 * gone with it.
 *
 * NOT for `.mail-list-row`. That is a virtualiser row: its height is published
 * to CSS as `--mail-row-h` and the windowed slice is absolutely positioned
 * against the same number in JS. A row whose height follows its content — which
 * is what `density` does here — would misplace every row in a long mailbox.
 *
 * NOT for `.mail-side-item` either: that is navigation with `aria-current` that
 * reflows into horizontal pills below 1100px. It is a `<Button variant="ghost">`
 * inside a `<nav>`.
 */
// HTMLAttributes<HTMLElement>, not the div/button-specific props: a Row is
// whichever of the two `onSelect` makes it, and the shared set is what both
// branches can safely receive.
interface RowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Fixed left slot: a time, a ticker, a status dot, an avatar, a checkbox. */
  lead?: ReactNode;
  /** Width of the lead slot in px — 70 for event times, 64 for symbols. */
  leadWidth?: number;
  title: ReactNode;
  /** Second line under the title. */
  meta?: ReactNode;
  /** Right slot: a price, a change, a chip, a progress bar, a timestamp. */
  trail?: ReactNode;
  /** Renders the row as a `<button>` with hover fill and keyboard support. */
  onSelect?: () => void;
  selected?: boolean;
  density?: 'compact' | 'default';
  tone?: 'default' | 'muted';
}

export const Row = ({
  lead, leadWidth, title, meta, trail, onSelect, selected,
  density = 'default', tone = 'default', className, ...rest
}: RowProps) => {
  const cls = [
    'row0',
    density === 'compact' ? 'row0-compact' : '',
    tone === 'muted' ? 'row0-muted' : '',
    className,
  ].filter(Boolean).join(' ');

  const body = (
    <>
      {lead != null && (
        <span className="row0-lead" style={leadWidth ? { width: leadWidth } : undefined}>{lead}</span>
      )}
      <div className="row0-main">
        <p className="row0-title trunc">{title}</p>
        {meta != null && <p className="row0-meta trunc">{meta}</p>}
      </div>
      {trail != null && <span className="row0-trail">{trail}</span>}
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={cls}
        onClick={onSelect}
        aria-selected={selected}
        role="option"
        {...rest}
      >
        {body}
      </button>
    );
  }
  return <div className={cls} {...rest}>{body}</div>;
};
