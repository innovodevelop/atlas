import type { ReactNode } from 'react';
import { Button, type ButtonVariant } from './Button';

/**
 * An empty state.
 *
 * Lifted and generalised from the one-liner in `AtlasCoreTabs`
 * (`<p className="kbmeta">{label}</p>`, 12 call sites) and the five-reason mail
 * empty state. The design has three scales, so this has three:
 *
 *  - `inline`   a muted caption inside a panel — the old Core behaviour
 *  - `block`    an illustrated card: icon well, display title, capped body
 *  - `section`  the same, one step larger, on the recessed panel fill
 *
 * `MailEmptyState` keeps its own reason switch and maps onto this. The five
 * strings are owned by the mail contract §6.6 and the `filter_empty` vs
 * `view_empty` distinction is a deliberate honesty rule — folding that logic in
 * here would put it somewhere nobody looking at the contract would find it.
 *
 * CAVEAT worth knowing before you conclude a surface never empties: several
 * Atlas Core panels cannot reach an empty state at all because they are
 * hardcoded with fabricated rows (AtlasCoreScreen's data-flow, knowledge,
 * research and error panels). That is a data defect, not a missing empty state.
 */
export type EmptySize = 'inline' | 'block' | 'section';
export type EmptyStatus = 'resting' | 'stale' | 'error';

interface EmptyProps {
  size?: EmptySize;
  /** Required for `block` and `section`; `inline` renders `body` alone. */
  title?: ReactNode;
  body?: ReactNode;
  icon?: ReactNode;
  /** A pulsing dot: green when resting and healthy, neutral when stale, red on error. */
  status?: EmptyStatus;
  action?: { label: string; onClick: () => void; disabled?: boolean; variant?: ButtonVariant };
  className?: string;
}

const DOT: Record<EmptyStatus, string> = {
  resting: '', stale: 'aempty-dot-stale', error: 'aempty-dot-error',
};

export const Empty = ({
  size = 'inline', title, body, icon, status, action, className,
}: EmptyProps) => {
  const cls = ['aempty', `aempty-${size}`, className].filter(Boolean).join(' ');

  if (size === 'inline') {
    return (
      <p className={cls} role="status">
        {status && <span className={`aempty-dot ${DOT[status]}`} aria-hidden />}
        {title}{title && body ? ' ' : ''}{body}
      </p>
    );
  }

  return (
    <div className={cls} role="status">
      {icon && <div className="aempty-ico">{icon}</div>}
      {title != null && <p className="aempty-title">{title}</p>}
      {body != null && <p className="aempty-body">{body}</p>}
      {action && (
        <div className="aempty-actions">
          <Button
            variant={action.variant ?? 'primary'}
            size="sm"
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
};
