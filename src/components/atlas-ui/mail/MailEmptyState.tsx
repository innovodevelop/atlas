import type { MailEmptyReason, MailView } from '@/types/mail';
import { VIEW_LABELS } from './mailFormat';

interface MailEmptyStateProps {
  reason: MailEmptyReason;
  view: MailView;
  mailbox: string | null;
  query: string;
  syncing: boolean;
  onSync: () => void;
  onClearFilter: () => void;
  onClearQuery: () => void;
}

/**
 * The empty state is where a mail agent is most tempted to lie. "Needs approval,
 * filtered to hello@" being empty is a data reason — the threads exist, they are
 * behind the filter — so it never gets inbox-zero copy. Strings are verbatim from
 * the contract (§6.6); do not reword them without changing the contract first.
 */
export const MailEmptyState = ({
  reason, view, mailbox, query, syncing, onSync, onClearFilter, onClearQuery,
}: MailEmptyStateProps) => {
  const label = VIEW_LABELS[view];

  let title: string;
  let body: string;
  let action: { label: string; run: () => void } | null = null;

  switch (reason) {
    case 'not_synced_yet':
      title = 'Not synced yet';
      body = 'Sync to load contact@helloatlas.dk.';
      action = { label: syncing ? 'Syncing…' : 'Sync now', run: onSync };
      break;
    case 'no_threads_at_all':
      title = 'No mail stored';
      body = 'Nothing has arrived at this mailbox yet.';
      action = { label: syncing ? 'Syncing…' : 'Sync now', run: onSync };
      break;
    case 'filter_empty':
      title = `Nothing in ${label} for ${mailbox ?? 'this mailbox'}`;
      body = 'Other mailboxes have threads here — clear the filter to see them.';
      action = { label: 'Clear the filter', run: onClearFilter };
      break;
    case 'search_empty':
      title = 'No matches';
      body = `No thread matches “${query}”.`;
      action = { label: 'Clear search', run: onClearQuery };
      break;
    case 'view_empty':
    default:
      title = `Nothing in ${label}`;
      body = 'No threads have this status.';
      break;
  }

  return (
    <div className="mail-empty" role="status">
      <p className="mail-empty-title">{title}</p>
      <p className="mail-empty-body">{body}</p>
      {action && (
        <button type="button" className="mail-empty-action" onClick={action.run} disabled={syncing}>
          {action.label}
        </button>
      )}
    </div>
  );
};
