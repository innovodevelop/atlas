import type { RefObject } from 'react';
import { RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { MailCounts, MailView } from '@/types/mail';
import { MAIL_VIEWS, VIEW_LABELS, fullTime } from './mailFormat';

interface MailSidebarProps {
  view: MailView;
  counts: MailCounts;
  mailbox: string | null;
  mailboxes: string[];
  query: string;
  syncing: boolean;
  lastSyncedAt: string | null;
  searchRef: RefObject<HTMLInputElement>;
  onView: (view: MailView) => void;
  onMailbox: (mailbox: string | null) => void;
  onQuery: (query: string) => void;
  onSync: () => void;
  onOpenRules: () => void;
}

export const MailSidebar = ({
  view, counts, mailbox, mailboxes, query, syncing, lastSyncedAt, searchRef,
  onView, onMailbox, onQuery, onSync, onOpenRules,
}: MailSidebarProps) => (
  <nav className="mail-side" aria-label="Mail views">
    <div className="mail-side-group">
      <div className="mail-side-filter">
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search mail"
          aria-label="Search mail"
          onChange={(e) => onQuery(e.target.value)}
        />
        <span className="mail-kbd" aria-hidden>/</span>
      </div>
    </div>

    <div className="mail-side-group">
      {MAIL_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          className={`mail-side-item${v === view ? ' mail-side-item-active' : ''}`}
          aria-current={v === view ? 'page' : undefined}
          onClick={() => onView(v)}
        >
          <span>{VIEW_LABELS[v]}</span>
          <span className="mail-side-count tnum">{counts[v] ?? 0}</span>
        </button>
      ))}
    </div>

    {/* Mailbox filter. One hosted mailbox exists today, but the filter is what
        makes `filter_empty` reachable — and that empty state is the one the
        audit found missing, so it ships with the surface that produces it. */}
    <div className="mail-side-group">
      <button
        type="button"
        className={`mail-side-item${mailbox === null ? ' mail-side-item-active' : ''}`}
        onClick={() => onMailbox(null)}
      >
        <span>All mailboxes</span>
      </button>
      {mailboxes.map((m) => (
        <button
          key={m}
          type="button"
          className={`mail-side-item${mailbox === m ? ' mail-side-item-active' : ''}`}
          onClick={() => onMailbox(m)}
        >
          <span className="trunc">{m}</span>
        </button>
      ))}
    </div>

    <div className="mail-side-group">
      <button type="button" className="mail-side-item" onClick={onSync} disabled={syncing}>
        <RefreshCw className="i14" aria-hidden />
        <span>{syncing ? 'Syncing…' : 'Sync'}</span>
      </button>
      <button type="button" className="mail-side-item" onClick={onOpenRules}>
        <SlidersHorizontal className="i14" aria-hidden />
        <span>Rules &amp; autonomy</span>
      </button>
      <p className="mail-muted">
        {lastSyncedAt ? `Last synced ${fullTime(lastSyncedAt)}` : 'Never synced on this Mac'}
      </p>
    </div>
  </nav>
);
