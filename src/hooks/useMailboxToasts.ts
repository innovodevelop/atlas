// "Mailbox connected" / "Mailbox disconnected" toasts, from the account list
// itself changing rather than from the button that started it. A Gmail or
// Outlook sign-in finishes in the browser, minutes later, through Rust; an
// IMAP connect, a reconnect and a disconnect each end in a re-read of the
// list. Watching the list is the one signal all of them share, and it can only
// announce what actually landed.

import { useEffect, useRef } from 'react';
import { isUserMailbox, type MailAccount } from '@/hooks/useMailIntelligence';
import { mailboxChanges, mailboxToasts } from '@/lib/betaMail';

export function useMailboxToasts(accounts: readonly MailAccount[], loading: boolean, say: (text: string) => void): void {
  // null until the first finished read: what is there when a screen opens is
  // the starting point, not news.
  const seen = useRef<readonly MailAccount[] | null>(null);
  useEffect(() => {
    if (loading) return;
    const prev = seen.current;
    seen.current = accounts;
    if (!prev) return;
    const lines = mailboxToasts(mailboxChanges(prev, accounts, isUserMailbox));
    // One toast line at a time: the newest says the most, and two at once
    // only happens when a list read was missed.
    if (lines.length) say(lines.length === 1 ? lines[0] : `${lines[0]} and ${lines.length - 1} more`);
  }, [accounts, loading, say]);
}
