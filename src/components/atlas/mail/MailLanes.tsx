/**
 * The Beta Mail sidebar (`Atlas Mail Beta.dc.html`, the aside): lanes with
 * counts, the accounts with their autonomy in one line, and the "How Atlas
 * handles mail" card that opens the rules editor.
 */
import { AtlasIcon } from '../AtlasIcon';
import { LANES, laneCount } from '@/lib/betaMail';
import type { MailAccount, MailCounts, MailView } from '@/types/mail';

export const AUTONOMY_LINE: Record<MailAccount['autonomy_mode'], string> = {
  approve_all: 'Holds everything for you',
  conditional: 'Replies alone to known people',
  autonomous: 'Replies alone under your rules',
};

export const AUTONOMY_BODY: Record<MailAccount['autonomy_mode'], string> = {
  approve_all: 'Drafts replies and holds every one of them for your approval. Nothing leaves without you.',
  conditional: 'Replies alone to people you’ve written to before. Holds anything about money, or to someone new.',
  autonomous: 'Replies alone wherever your rules allow, and shows you each one in Atlas handled.',
};

export interface MailLanesProps {
  view: MailView;
  counts: Partial<MailCounts>;
  account: MailAccount | null;
  mailbox: string | null;
  handledInMailbox: number;
  onView: (view: MailView) => void;
  onMailbox: (mailbox: string | null) => void;
  onOpenRules: () => void;
}

export function MailLanes({ view, counts, account, mailbox, handledInMailbox, onView, onMailbox, onOpenRules }: MailLanesProps) {
  const mode = account?.autonomy_mode ?? 'approve_all';
  return (
    <aside className="b-mail-side nosb" aria-label="Mail lanes">
      <div className="b-mail-lanes">
        {LANES.map((l) => {
          const n = laneCount(counts, l.view);
          const on = view === l.view && !mailbox;
          return (
            <button type="button" key={l.view} className={`b-mail-lane${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => { onMailbox(null); onView(l.view); }} title={l.desc}>
              <AtlasIcon name={l.icon} size={17} weight={1.5} />
              <span className="b-mail-lane-l">{l.label}</span>
              <span className={`b-mail-lane-n b-num${l.urgent && n ? ' hot' : ''}`}>{n ? n : ''}</span>
            </button>
          );
        })}
      </div>

      <div className="b-mail-accts">
        <span className="b-eyebrow">Accounts</span>
        {account ? (
          <button type="button" className={`b-mail-acct${mailbox === account.email_address ? ' on' : ''}`} onClick={() => onMailbox(mailbox === account.email_address ? null : account.email_address)} title={mailbox === account.email_address ? 'Show every account' : 'Only this account'}>
            <span className="b-mail-dot" style={{ background: account.colour ?? 'var(--b-blue)' }} />
            <span className="b-mail-acct-text"><b>{account.email_address}</b><span>{AUTONOMY_LINE[mode]}{account.status !== 'active' ? ` · ${account.status}` : ''}</span></span>
            <span className="b-mail-acct-n b-num">{handledInMailbox} auto</span>
          </button>
        ) : (
          <div className="b-mail-acct b-mail-acct--none"><span className="b-mail-acct-text"><b>No mailbox yet</b><span>Connect one in Settings → Mail</span></span></div>
        )}
      </div>

      <div className="b-mail-how">
        <span className="b-mail-how-t">How Atlas handles mail</span>
        <span className="b-mail-how-b">{AUTONOMY_BODY[mode]}</span>
        <button type="button" className="b-btn b-btn--row" onClick={onOpenRules}>Edit rules</button>
      </div>
    </aside>
  );
}
