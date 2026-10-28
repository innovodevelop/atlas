/**
 * The connected mailboxes (Gmail, Outlook, IMAP) inside the Beta Mail's Inbox
 * and Archive lanes: what the last scan stored of each message (sender,
 * subject, the provider's preview line), with Archive, or Move to Inbox in the
 * Archive lane. The move happens at the provider (see mail_archive.rs).
 *
 * When the provider refuses, the row says why in place. A Gmail or Outlook
 * mailbox connected read-only offers "Reconnect <account> to archive", the
 * sign-in that asks for the one extra permission; an IMAP server without an
 * Archive folder is told so and left alone.
 */
import { AtlasIcon } from '../AtlasIcon';
import { canReconnectToArchive, refusalText, type ArchiveRefusal } from '@/lib/betaMail';
import { displayName, shortTime } from '@/components/atlas-ui/mail/mailFormat';
import type { MailboxMessage } from '@/hooks/useMailboxArchive';

export interface MailboxListProps {
  mode: 'inbox' | 'archive';
  rows: MailboxMessage[];
  refusals: Record<string, ArchiveRefusal>;
  working: string | null;
  /** A sign-in is under way (one at a time). */
  connecting: boolean;
  onArchive: (messageId: string, archive: boolean) => void;
  onReconnect: (provider: 'gmail' | 'outlook') => void;
}

export function MailboxList(p: MailboxListProps) {
  if (!p.rows.length) return null;
  const archiving = p.mode === 'inbox';
  return (
    <div className="b-mail-boxes" role="group" aria-label={archiving ? 'Connected mailboxes' : 'Archived from connected mailboxes'}>
      <span className="b-eyebrow b-mail-boxes-h">
        {archiving ? 'Connected mailboxes · as of the last scan' : 'Archived at the provider'}
      </span>
      {p.rows.map((m) => {
        const refusal = p.refusals[m.id];
        const busy = p.working === m.id;
        return (
          <div key={m.id} className="b-mail-box">
            <div className="b-mail-box-text">
              <span className="b-mail-row-l1">
                <span className="b-mail-row-from">{displayName(m.from)}</span>
                <span className="b-mail-row-time b-num">{shortTime(archiving ? m.receivedAt : m.archivedAt)}</span>
              </span>
              <span className="b-mail-row-subject">{m.subject || '(no subject)'}</span>
              {m.snippet ? <span className="b-mail-row-snippet">{m.snippet}</span> : null}
              <span className="b-mail-row-acct"><i />{m.mailbox}</span>
            </div>
            <button
              type="button"
              className="b-mail-round b-mail-box-act"
              title={archiving ? `Archive in ${m.mailbox}` : `Move back to the ${m.mailbox} inbox`}
              aria-label={archiving ? 'Archive' : 'Move to Inbox'}
              disabled={busy || !!p.working}
              onClick={() => p.onArchive(m.id, archiving)}
            >
              <AtlasIcon name={archiving ? 'folder' : 'inbox'} size={16} />
            </button>
            {refusal ? (
              <div className="b-mail-box-note" role="status">
                {refusal.reason === 'reconnect' && canReconnectToArchive(refusal.provider) ? (
                  <>
                    <span>{refusal.email} was connected read-only. Atlas needs your permission to move mail there; it still cannot send or delete.</span>
                    <button type="button" className="b-btn b-btn--tinted b-btn--row" disabled={p.connecting} onClick={() => p.onReconnect(refusal.provider as 'gmail' | 'outlook')}>
                      {p.connecting ? 'Waiting for the sign-in…' : refusalText(refusal, archiving)}
                    </button>
                  </>
                ) : (
                  <span>{refusalText(refusal, archiving)}</span>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
