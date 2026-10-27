/**
 * The Beta Mail list (`Atlas Mail Beta.dc.html`, section "Messages"): the
 * lane's title and meaning, All/Unread, and one row per thread with the
 * status chip and the account it came through.
 */
import { LANE_BY_VIEW, STATUS_CHIP } from '@/lib/betaMail';
import { displayName, senderDomain, shortTime } from '@/components/atlas-ui/mail/mailFormat';
import type { MailAccount, MailEmptyReason, MailThread, MailView } from '@/types/mail';

export interface MailListProps {
  view: MailView;
  mailbox: string | null;
  query: string;
  threads: MailThread[];
  selectedThreadId: string | null;
  snippets: Record<string, string>;
  account: MailAccount | null;
  unreadOnly: boolean;
  emptyReason: MailEmptyReason | null;
  syncing: boolean;
  onUnreadOnly: (on: boolean) => void;
  onSelect: (id: string) => void;
  onSync: () => void;
  onClearMailbox: () => void;
  onClearQuery: () => void;
}

/** Who the row is from: the first participant that is not our own mailbox. */
export function senderOf(t: MailThread): string | null {
  const own = t.mailbox.toLowerCase();
  return t.participants.find((p) => p.toLowerCase() !== own) ?? t.participants[0] ?? null;
}

function emptyCopy(reason: MailEmptyReason, view: MailView): { title: string; body: string; action?: 'sync' | 'mailbox' | 'query' } {
  const lane = LANE_BY_VIEW.get(view);
  switch (reason) {
    case 'not_synced_yet': return { title: 'Not synced yet', body: 'Atlas has not looked at this mailbox on this Mac. Sync to bring it in.', action: 'sync' };
    case 'no_threads_at_all': return { title: 'Nothing has arrived', body: 'The mailbox is connected and empty so far. New mail lands here as it comes.' };
    case 'view_empty': return view === 'needs_you'
      ? { title: 'Nothing needs you', body: 'Atlas is answering what it can and will bring anything new here.' }
      : { title: `Nothing in ${lane?.label ?? 'this lane'}`, body: lane?.desc ?? 'Messages land here as they arrive.' };
    case 'filter_empty': return { title: 'Nothing in this account', body: 'The lane has mail, just not through this account.', action: 'mailbox' };
    case 'search_empty': return { title: 'No matches', body: 'Nothing in this lane mentions that. Try fewer words.', action: 'query' };
  }
}

export function MailList(p: MailListProps) {
  const lane = LANE_BY_VIEW.get(p.view);
  const rows = p.unreadOnly ? p.threads.filter((t) => t.unread_count > 0) : p.threads;
  const q = p.query.trim();
  const title = q ? 'Search' : p.mailbox ? p.mailbox : lane?.label ?? 'Mail';
  const meta = q ? `${rows.length} ${rows.length === 1 ? 'result' : 'results'} for “${q}”` : p.mailbox ? 'Everything in this account' : lane?.desc ?? '';
  const empty = p.emptyReason ? emptyCopy(p.emptyReason, p.view) : rows.length === 0 && p.unreadOnly ? { title: 'Nothing unread', body: 'Everything here has been opened.' } : null;
  const acctDot = p.account?.colour ?? 'var(--b-blue)';
  const acctName = p.account?.email_address.split('@')[0] ?? '';

  return (
    <section className="b-mail-list" aria-label="Messages">
      <div className="b-mail-list-head">
        <div className="b-mail-list-title"><span>{title}</span><span>{meta}</span></div>
        <div className="b-seg b-seg--small" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={!p.unreadOnly} className={!p.unreadOnly ? 'on' : ''} onClick={() => p.onUnreadOnly(false)}>All</button>
          <button type="button" role="radio" aria-checked={p.unreadOnly} className={p.unreadOnly ? 'on' : ''} onClick={() => p.onUnreadOnly(true)}>Unread</button>
        </div>
      </div>
      <div className="b-mail-rows nosb">
        {rows.map((t) => {
          const on = t.id === p.selectedThreadId;
          const unread = t.unread_count > 0;
          const from = senderOf(t);
          const chip = STATUS_CHIP[t.status];
          return (
            <button type="button" key={t.id} className={`b-mail-row${on ? ' on' : ''}${unread ? ' unread' : ''}`} onClick={() => p.onSelect(t.id)} aria-current={on ? 'true' : undefined}>
              <span className="b-mail-row-l1">
                {unread ? <span className="b-mail-unread" aria-label="Unread" /> : null}
                <span className="b-mail-row-from">{displayName(from)}</span>
                <span className="b-mail-row-org">{senderDomain(from) ?? ''}</span>
                <span className="b-mail-row-time b-num">{shortTime(t.last_message_at)}</span>
              </span>
              <span className="b-mail-row-subject">{t.subject || '(no subject)'}</span>
              <span className="b-mail-row-snippet">{p.snippets[t.id] ?? (t.participants.length > 2 ? `${t.participants.length} people` : '')}</span>
              <span className="b-mail-row-l4">
                <span className={`b-mail-chip b-mail-chip--${chip.tone}`}><i />{chip.label}</span>
                <span className="b-mail-row-acct"><i style={{ background: acctDot }} />{acctName || t.mailbox}</span>
              </span>
            </button>
          );
        })}
        {empty ? (
          <div className="b-mail-empty">
            <span className="b-mail-empty-t">{empty.title}</span>
            <span className="b-mail-empty-b">{empty.body}</span>
            {empty.action === 'sync' ? <button type="button" className="b-btn b-btn--tinted b-btn--row" disabled={p.syncing} onClick={p.onSync}>{p.syncing ? 'Syncing…' : 'Sync now'}</button> : null}
            {empty.action === 'mailbox' ? <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={p.onClearMailbox}>Show every account</button> : null}
            {empty.action === 'query' ? <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={p.onClearQuery}>Clear search</button> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
