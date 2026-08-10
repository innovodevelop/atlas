/**
 * Atlas Mail — the three-pane route (`/mail`).
 *
 * This is the only place `useAtlasMail()` is called; every child receives slices
 * as props (contract §6.1), which is what keeps the pane components free of data
 * access and lets I5's composer and rules editor land independently.
 *
 * Two things the design showed are deliberately absent: the `confidence 0.94`
 * badge and "matched 214 prior answers". Neither has a data source (audit §2.2).
 * What replaces them is `matchedOn` — the rule that actually fired, the sender
 * domain, the mailbox, the attachments — every pill read from a real row.
 *
 * Keyboard scheme (contract §6.5). Everything is ignored while focus sits in an
 * input, textarea or contenteditable, so typing a reply never archives a thread:
 *
 *   j / ArrowDown   next thread          k / ArrowUp   previous thread
 *   Enter           open the selection   Esc           clear the selection
 *   a               needs approval       e             handled
 *   s               snooze options       u             undo a pending send
 *   /               focus search
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, Cpu, Mail, Sparkles, Inbox } from 'lucide-react';
import { Dock, Empty } from '@/components/atlas-ui/primitives';
import { useAccountDockItem } from '@/components/atlas-ui/useAccountDockItem';
import { useAuth } from '@/hooks/useAuth';
import { useAtlasMail, type UseAtlasMail } from '@/hooks/useAtlasMail';
import { MAIL_AUDIT_ACTIONS, type MailThreadStatus } from '@/types/mail';
import { AtmosphereCanvas } from '@/components/atlas-ui/AtmosphereCanvas';
import { MailShell, useMailStacked } from '@/components/atlas-ui/mail/MailShell';
import { MailSidebar } from '@/components/atlas-ui/mail/MailSidebar';
import { MailThreadList } from '@/components/atlas-ui/mail/MailThreadList';
import { MailReadingPane } from '@/components/atlas-ui/mail/MailReadingPane';
import { MailEmptyState } from '@/components/atlas-ui/mail/MailEmptyState';
import { MailNotices } from '@/components/atlas-ui/mail/MailNotices';
import { MailRulesEditor } from '@/components/atlas-ui/mail/MailRulesEditor';
import { senderDomain } from '@/components/atlas-ui/mail/mailFormat';
import '@/styles/mail.css';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 */
export const surface = {
  path: '/mail',
  label: 'Mail',
  icon: 'Mail',
  entry: 'dock' as const,
  mock: false,
  edition: 'consumer' as const,
};

/** True when a keystroke belongs to whatever the user is typing into. */
const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
};

const AtlasMail = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const mail: UseAtlasMail = useAtlasMail();
  const stacked = useMailStacked();

  const [rulesOpen, setRulesOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Mail has no Settings overlay of its own, so the account menu routes to
  // `/settings` — the addressable copy of the same component. Closing it
  // navigates back, which lands you here again.
  const openSettings = useCallback(
    (tab?: 'memory') => navigate(tab ? `/settings?tab=${tab}` : '/settings'),
    [navigate],
  );
  const accountItem = useAccountDockItem(openSettings);

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const { selectedThreadId, thread, markRead } = mail;

  // Opening a thread is what marks it read — the list row cannot, because the
  // server owns `unread_count` and re-assigns it on the next sync (contract §5.2).
  //
  // `thread` is a fresh object on every load, so an effect that only tested
  // unread_count re-fired on every `db:changed` re-query; if markRead rejected
  // (worker down, offline) the hook reverted the row, the effect saw the same
  // unread count again, and the two chased each other unbounded — one rejected
  // promise per pass, all of them unhandled.
  //
  // The key is thread id *plus* unread count, not the id alone: it bounds every
  // distinct unread state to a single attempt, and still lets a thread that is
  // open when new mail lands in it be marked read again. Keying on the id alone
  // would silence that case for the rest of the session.
  const markReadAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!thread || thread.unread_count === 0) return;
    const attempt = `${thread.id}:${thread.unread_count}`;
    if (markReadAttempted.current.has(attempt)) return;
    markReadAttempted.current.add(attempt);
    // markRead re-throws after reverting the local row and setting the hook's
    // `error`, which the notice bar renders. Caught rather than dropped with
    // `void`: an unhandled rejection is not a report to anyone.
    markRead(thread.id).catch(() => {});
  }, [thread, markRead]);

  // A new selection closes the snooze options; leaving them open would apply the
  // next click to a thread the user is no longer looking at.
  useEffect(() => { setSnoozeOpen(false); }, [selectedThreadId]);

  /**
   * Preview text, only for threads whose messages are local. A list sync does not
   * fan out a detail fetch per thread, so this is usually just the open thread —
   * an empty snippet is honest, an invented one is not.
   */
  const snippets = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of mail.messages) {
      if (!m.thread_id) continue;
      if (!out[m.thread_id] && m.snippet) out[m.thread_id] = m.snippet;
    }
    return out;
  }, [mail.messages]);

  /** Fact pills: what the decision matched on. Built from rows, never from a model's self-report. */
  const matchedOn = useMemo(() => {
    if (!thread) return [];
    const pills: Array<{ label: string; value: string }> = [];

    const ruleEvent = mail.audit.find((e) => e.action === MAIL_AUDIT_ACTIONS.RULE_MATCHED);
    if (ruleEvent) pills.push({ label: 'Rule', value: ruleEvent.detail });

    const inbound = mail.messages.find((m) => m.extracted?.direction === 'inbound');
    const domain = senderDomain(inbound?.from_address ?? thread.participants?.[0]);
    if (domain) pills.push({ label: 'Sender', value: domain });

    pills.push({ label: 'Mailbox', value: thread.mailbox });

    const files = mail.messages.reduce((n, m) => n + (m.extracted?.attachments?.length ?? 0), 0);
    if (files > 0) pills.push({ label: 'Attachments', value: `${files} file${files === 1 ? '' : 's'}` });

    return pills;
  }, [thread, mail.audit, mail.messages]);

  const mailboxes = useMemo(
    () => (mail.account ? [mail.account.email_address] : []),
    [mail.account],
  );

  const setStatus = useCallback(
    (status: MailThreadStatus) => {
      if (selectedThreadId) void mail.setStatus(selectedThreadId, status);
    },
    [mail, selectedThreadId],
  );

  const snooze = useCallback(
    (until: string) => {
      if (!selectedThreadId) return;
      setSnoozeOpen(false);
      void mail.snooze(selectedThreadId, until);
    },
    [mail, selectedThreadId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) {
        // Esc still has to work from the search field, or the only way out is the mouse.
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); mail.selectRelative(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); mail.selectRelative(-1); break;
        case 'Enter':
          // Selection *is* opening in the side-by-side layout; in the stacked one
          // the pane only appears once a thread is selected, so this is the swap.
          if (!selectedThreadId && mail.threads.length) mail.selectThread(mail.threads[0].id);
          break;
        case 'Escape': setSnoozeOpen(false); mail.selectThread(null); break;
        case 'a': if (selectedThreadId) setStatus('approve'); break;
        case 'e': if (selectedThreadId) setStatus('handled'); break;
        case 's': if (selectedThreadId) setSnoozeOpen((v) => !v); break;
        case 'u': if (mail.pendingSend) void mail.undoSend(); break;
        case '/': e.preventDefault(); searchRef.current?.focus(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mail, selectedThreadId, setStatus]);

  const emptyState = mail.emptyReason ? (
    <MailEmptyState
      reason={mail.emptyReason}
      view={mail.view}
      mailbox={mail.mailbox}
      query={mail.query}
      syncing={mail.syncing}
      onSync={() => void mail.sync()}
      onClearFilter={() => mail.setMailbox(null)}
      onClearQuery={() => mail.setQuery('')}
    />
  ) : null;

  return (
    <div className="page" data-screen-label="Atlas — Mail">
      {/* Decorative only; it carries no information the pane does not. */}
      <AtmosphereCanvas />
      <div className="grain" aria-hidden />

      <MailShell
        paneVisible={!!thread}
        // Route level, not pane level: a send refusal, a failed status write or
        // a lost inbound message has to be visible whether or not a thread
        // happens to be open.
        notices={
          <MailNotices
            error={mail.error}
            warning={mail.warning}
            onDismissError={mail.dismissError}
            onDismissWarning={mail.dismissWarning}
            lastSyncedAt={mail.lastSyncedAt}
          />
        }
        sidebar={
          <MailSidebar
            view={mail.view}
            counts={mail.counts}
            mailbox={mail.mailbox}
            mailboxes={mailboxes}
            query={mail.query}
            syncing={mail.syncing}
            lastSyncedAt={mail.lastSyncedAt}
            searchRef={searchRef}
            onView={mail.setView}
            onMailbox={mail.setMailbox}
            onQuery={mail.setQuery}
            onSync={() => void mail.sync()}
            onOpenRules={() => setRulesOpen(true)}
          />
        }
        list={
          <MailThreadList
            threads={mail.threads}
            selectedThreadId={selectedThreadId}
            snippets={snippets}
            onSelect={mail.selectThread}
            empty={emptyState}
          />
        }
        pane={
          thread ? (
            <MailReadingPane
              thread={thread}
              messages={mail.messages}
              drafts={mail.drafts}
              audit={mail.audit}
              matchedOn={matchedOn}
              pendingSend={mail.pendingSend}
              busy={mail.syncing}
              stacked={stacked}
              snoozeOpen={snoozeOpen}
              onBack={() => mail.selectThread(null)}
              onStatus={setStatus}
              onToggleSnooze={() => setSnoozeOpen((v) => !v)}
              onSnooze={snooze}
              onDraft={(opts) => mail.draft(thread.id, opts)}
              onSaveDraft={mail.saveDraft}
              onReviseDraft={mail.reviseDraft}
              onDiscardDraft={mail.discardDraft}
              onScheduleDraft={mail.scheduleDraft}
              onApproveAndSend={mail.approveAndSend}
              onUndoSend={mail.undoSend}
            />
          ) : (
            <div className="mail-pane">
              <Empty
                className="mail-empty"
                size="block"
                icon={<Inbox className="i20" />}
                title="No thread open"
                body={
                  <>
                    Pick a thread, or press <span className="mail-kbd">j</span> and{' '}
                    <span className="mail-kbd">k</span> to move through the list.
                  </>
                }
              />
            </div>
          )
        }
      />

      {/* Rules + autonomy are route-level, not per-thread: a rule that fires on
          one thread applies to the mailbox, and autonomy applies to the account. */}
      {rulesOpen && (
        <>
          <div className="backdrop" onClick={() => setRulesOpen(false)} />
          <aside className="drawer" aria-label="Rules and autonomy">
            <MailRulesEditor
              rules={mail.rules}
              accounts={mail.account ? [mail.account] : []}
              busy={mail.syncing}
              onSave={mail.saveRule}
              onDelete={mail.deleteRule}
              onReorder={mail.reorderRules}
              onSetAutonomy={mail.setAutonomy}
              onClose={() => setRulesOpen(false)}
            />
          </aside>
        </>
      )}

      {/* Same component as the dashboard's dock, different items. `current`
          is what makes Mail the one item carrying a visible label; the sync
          CTA is the documented exception, because its label is the only place
          the sync reports that it is running.

          The account chip is shared, not re-declared: it carries the app's only
          sign-out, plan badge and privacy/delete-account entry, and this dock
          shipped without it — so a user sitting in Mail had to go back to the
          dashboard to sign out. It goes LAST; `<Dock>` asserts that in DEV. */}
      <Dock
        current="mail"
        items={[
          { id: 'home', label: 'Home', icon: <Home className="i16" />, to: '/' },
          { id: 'core', label: 'Core', icon: <Cpu className="i16" />, to: '/atlas-core' },
          { id: 'mail', label: 'Mail', icon: <Mail className="i16" />, to: '/mail' },
          { id: 'sync', label: 'Sync', icon: <Sparkles className="i16" />, kind: 'cta',
            busy: mail.syncing, busyLabel: 'Syncing…', onClick: () => void mail.sync() },
          accountItem,
        ]}
      />
    </div>
  );
};

export default AtlasMail;
