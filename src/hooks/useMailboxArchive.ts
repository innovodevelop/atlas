// The connected mailboxes (Gmail, Outlook, IMAP) in the Beta Mail's Inbox and
// Archive lanes, and the Archive action on their messages.
//
// These mailboxes are scanned for the Home inbox and the bill and deadline
// alerts; what a scan stores is message-shaped (sender, subject, the
// provider's preview line), not thread-shaped, so they are listed here apart
// from the admin mailbox's threads that useAtlasMail owns. Archive goes to the
// provider first, through mail_archive.rs, and only a move the provider
// confirmed shows up in the Archive lane. A refusal (a read-only grant, an IMAP
// server with no Archive folder) is kept per message for the row to explain.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTauri, localClient } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import { isUserMailbox } from '@/hooks/useMailIntelligence';
import type { ArchiveRefusal, ArchiveResult } from '@/lib/betaMail';

export interface MailboxMessage {
  id: string;
  accountId: string;
  provider: string;
  /** The mailbox it came through. */
  mailbox: string;
  from: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string | null;
  /** When Atlas archived it at the provider; null while it is in the inbox. */
  archivedAt: string | null;
}

/** How many inbox messages the lane lists; older ones stay in the mailbox and on Home. */
const INBOX_ROWS = 40;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB row shape is decided at runtime by the query
type Row = Record<string, any>;

export function useMailboxArchive() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [messages, setMessages] = useState<MailboxMessage[]>([]);
  const [refusals, setRefusals] = useState<Record<string, ArchiveRefusal>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId || !isTauri()) { setMessages([]); return; }
    const [accRes, msgRes, arcRes] = await Promise.all([
      localClient.from('mail_accounts').select('*').eq('user_id', userId),
      localClient.from('mail_messages').select('*').eq('user_id', userId).order('received_at', { ascending: false }),
      localClient.from('mail_archived_messages').select('*').eq('user_id', userId),
    ]);
    // Only id, provider and address leave this read: a mail_accounts row can
    // carry a legacy token column that must never reach React state.
    const mine = new Map<string, { provider: string; email: string }>();
    for (const a of (accRes.data ?? []) as Row[]) {
      if (isUserMailbox({ id: String(a.id), provider: String(a.provider) })) mine.set(String(a.id), { provider: String(a.provider), email: String(a.email_address) });
    }
    const archived = new Map<string, string>(((arcRes.data ?? []) as Row[]).map((r) => [String(r.message_id), String(r.archived_at)]));
    setMessages(
      ((msgRes.data ?? []) as Row[])
        .filter((m) => mine.has(String(m.account_id)))
        .map((m) => {
          const acct = mine.get(String(m.account_id))!;
          return {
            id: String(m.id),
            accountId: String(m.account_id),
            provider: acct.provider,
            mailbox: acct.email,
            from: m.from_address ?? null,
            subject: m.subject ?? null,
            snippet: m.snippet || null,
            receivedAt: m.received_at ?? null,
            archivedAt: archived.get(String(m.id)) ?? null,
          };
        }),
    );
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!isTauri() || !userId) return;
    const channel = localClient.channel('mailbox-archive');
    for (const table of ['mail_accounts', 'mail_messages', 'mail_archived_messages']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => { void load(); });
    }
    channel.subscribe();
    return () => { localClient.removeChannel(channel); };
  }, [userId, load]);

  /**
   * Archive (`archive` true) or move back to the inbox. Resolves with what the
   * provider said; a refusal is also kept for the row until the next attempt.
   */
  const setArchived = useCallback(async (messageId: string, archive: boolean): Promise<ArchiveResult | null> => {
    if (!userId || !isTauri()) { setError('Archiving works in the desktop app.'); return null; }
    setWorking(messageId);
    setError(null);
    setRefusals((prev) => {
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    try {
      const core = await import('@tauri-apps/api/core');
      const res = await core.invoke<ArchiveResult>('mail_archive_message', { userId, messageId, archive });
      if ('reason' in res) {
        const refusal: ArchiveRefusal = res;
        setRefusals((prev) => ({ ...prev, [messageId]: refusal }));
      }
      await load();
      return res;
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'Atlas could not reach the mailbox.');
      return null;
    } finally {
      setWorking(null);
    }
  }, [userId, load]);

  const inbox = useMemo(() => messages.filter((m) => !m.archivedAt).slice(0, INBOX_ROWS), [messages]);
  const archived = useMemo(
    () => messages.filter((m) => m.archivedAt).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
    [messages],
  );

  return { inbox, archived, refusals, working, error, dismissError: () => setError(null), setArchived };
}
