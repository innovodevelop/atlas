import type { CSSProperties } from 'react';
import type { MailThread } from '@/types/mail';
import { MailStatusChip } from './MailStatusChip';
import { participantSummary, shortTime } from './mailFormat';

interface MailThreadRowProps {
  thread: MailThread;
  active: boolean;
  /**
   * Only present for threads whose messages have been fetched — a list sync
   * deliberately does not fan out a detail request per thread (contract §5.3),
   * so most rows legitimately have no preview text. Nothing is invented to fill it.
   */
  snippet?: string | null;
  /** Set while the list is virtualised; absolutely positions the row in the viewport. */
  style?: CSSProperties;
  onSelect: (threadId: string) => void;
}

export const MailThreadRow = ({ thread, active, snippet, style, onSelect }: MailThreadRowProps) => {
  const unread = thread.unread_count > 0;
  const className = [
    'mail-list-row',
    active ? 'mail-list-row-active' : '',
    unread ? 'mail-list-row-unread' : '',
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      id={`mail-row-${thread.id}`}
      className={className}
      style={style}
      role="option"
      aria-selected={active}
      onClick={() => onSelect(thread.id)}
    >
      {/* Status colour rail — the only place the row carries the status colour,
          so the chip below stays the single textual source. */}
      <span className={`mail-row-bar mail-chip-${thread.status}`} aria-hidden />
      <span className="mail-row-head">
        <span className="mail-row-from trunc">{participantSummary(thread.participants)}</span>
        <span className="mail-row-time tnum">{shortTime(thread.last_message_at)}</span>
      </span>
      <span className="mail-row-subject trunc">{thread.subject || '(no subject)'}</span>
      {snippet ? <span className="mail-row-snippet trunc">{snippet}</span> : null}
      <span className="mail-row-meta">
        <MailStatusChip status={thread.status} />
        <span className="mail-muted">{thread.mailbox}</span>
        {unread && <span className="mail-muted tnum">{thread.unread_count} unread</span>}
      </span>
    </button>
  );
};
