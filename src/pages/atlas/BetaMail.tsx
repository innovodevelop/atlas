/**
 * The Beta Mail — `/mail` while the beta_ui flag is on (Beta redesign phase
 * 3, `Atlas Mail Beta.dc.html`).
 *
 * Hero band (sphere, "N things need you", what Atlas handled, search, Write),
 * lanes, the list, the reading pane with the Atlas card and the reply box,
 * the compose sheet, undo toasts. The data is the same `useAtlasMail()` the
 * Workshop page uses — this screen is the only other caller — so every lane,
 * chip and action reads and writes the real mail tables.
 *
 * Keys (the design's, plus the Workshop ones that still make sense):
 *   j / k  move   ·  Enter open   ·  Esc back out, step by step
 *   r reply · h snooze · e archive · c write · a needs approval · u undo send · / search
 *
 * The connected mailboxes (Gmail, Outlook, IMAP) sit under the threads in
 * Inbox and Archive (MailboxList), where Archive moves a message at the
 * provider. A mailbox finishing a connect or a disconnect, here or anywhere
 * else, shows as a toast (useMailboxToasts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useAtlasMail, type UseAtlasMail } from '@/hooks/useAtlasMail';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { useMailboxArchive } from '@/hooks/useMailboxArchive';
import { useMailboxToasts } from '@/hooks/useMailboxToasts';
import { MAIL_AUDIT_ACTIONS, type MailThreadStatus } from '@/types/mail';
import { MailNotices } from '@/components/atlas-ui/mail/MailNotices';
import { MailRulesEditor } from '@/components/atlas-ui/mail/MailRulesEditor';
import { fullTime, senderDomain } from '@/components/atlas-ui/mail/mailFormat';
import { MailLanes } from '@/components/atlas/mail/MailLanes';
import { MailList } from '@/components/atlas/mail/MailList';
import { MailReader } from '@/components/atlas/mail/MailReader';
import { BetaCompose } from '@/components/atlas/mail/BetaCompose';
import { MailboxList } from '@/components/atlas/mail/MailboxList';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { LANES, laneCount, mailGreeting } from '@/lib/betaMail';
import { setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isTyping } from './atlasHelpers';
import '@/styles/mail.css';
import '@/styles/beta/mail.css';

type Layout = 'wide' | 'mid' | 'narrow' | 'stacked';

function useLayout(): Layout {
  const pick = () => (window.innerWidth >= 1280 ? 'wide' : window.innerWidth >= 1000 ? 'mid' : window.innerWidth >= 760 ? 'narrow' : 'stacked') as Layout;
  const [layout, setLayout] = useState<Layout>(pick);
  useEffect(() => {
    const onResize = () => setLayout(pick());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return layout;
}

interface Toast { text: string; undo?: () => void }

const BetaMail = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const mail: UseAtlasMail = useAtlasMail({ archiveLane: true });
  const boxes = useMailboxArchive();
  const intel = useMailIntelligence();
  const layout = useLayout();
  const stacked = layout === 'stacked';
  const showSide = layout === 'wide' || layout === 'mid';

  const [rulesOpen, setRulesOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [replyRequest, setReplyRequest] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sphereRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { if (!authLoading && !user) plainNavigate('/auth'); }, [user, authLoading, plainNavigate]);

  // The hero sphere is this screen's talk entry point.
  useEffect(() => { setTalkAnchor(sphereRef.current); return () => setTalkAnchor(null); }, []);

  // The Beta opens on Needs you; the hook's own default is the Workshop's Triage.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!LANES.some((l) => l.view === mail.view)) mail.setView('needs_you');
  }, [mail]);

  const { selectedThreadId, thread, markRead } = mail;

  // Opening a thread marks it read, once per distinct unread state (see AtlasMail.tsx for why).
  const markReadAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!thread || thread.unread_count === 0) return;
    const attempt = `${thread.id}:${thread.unread_count}`;
    if (markReadAttempted.current.has(attempt)) return;
    markReadAttempted.current.add(attempt);
    markRead(thread.id).catch(() => {});
  }, [thread, markRead]);

  useEffect(() => { setSnoozeOpen(false); }, [selectedThreadId]);

  const showToast = useCallback((t: Toast) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = window.setTimeout(() => setToast(null), 3800);
  }, []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  const say = useCallback((text: string) => showToast({ text }), [showToast]);
  useMailboxToasts(intel.accounts, intel.isLoading, say);

  // A "Reconnect … to archive" sign-in that failed reports through the mail
  // hook's error, which only the next attempt clears; dismissing hides that one.
  const [hiddenSignInError, setHiddenSignInError] = useState<string | null>(null);
  const signInError = intel.error && intel.error !== hiddenSignInError ? intel.error : null;
  // Reconnecting a mailbox that is already active leaves the account list as
  // it was, so no "Mailbox connected" toast says the sign-in worked; this does.
  const wasConnecting = useRef(false);
  useEffect(() => {
    if (wasConnecting.current && !intel.isConnecting && !intel.error) say('Signed in again. Try Archive once more.');
    wasConnecting.current = intel.isConnecting;
  }, [intel.isConnecting, intel.error, say]);

  const snippets = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of mail.messages) {
      if (!m.thread_id) continue;
      if (!out[m.thread_id] && m.snippet) out[m.thread_id] = m.snippet;
    }
    return out;
  }, [mail.messages]);

  /** Fact pills: what the decision matched on — rows only, never a model's self-report. */
  const matchedOn = useMemo(() => {
    if (!thread) return [];
    const pills: Array<{ label: string; value: string }> = [];
    const ruleEvent = mail.audit.find((e) => e.action === MAIL_AUDIT_ACTIONS.RULE_MATCHED);
    if (ruleEvent) pills.push({ label: 'Rule', value: ruleEvent.detail });
    const inbound = mail.messages.find((m) => m.extracted?.direction === 'inbound');
    const domain = senderDomain(inbound?.from_address ?? thread.participants?.[0]);
    if (domain) pills.push({ label: 'Sender', value: domain });
    const files = mail.messages.reduce((n, m) => n + (m.extracted?.attachments?.length ?? 0), 0);
    if (files > 0) pills.push({ label: 'Attachments', value: `${files} file${files === 1 ? '' : 's'}` });
    return pills;
  }, [thread, mail.audit, mail.messages]);

  const setStatus = useCallback((status: MailThreadStatus) => {
    if (!thread) return;
    const prev = thread.status;
    const id = thread.id;
    void mail.setStatus(id, status);
    if (status === 'handled') showToast({ text: 'Done', undo: () => void mail.setStatus(id, prev) });
    else if (status === 'triage' && (prev === 'handled' || prev === 'snooze' || prev === 'handoff')) showToast({ text: 'Back in Needs you' });
  }, [mail, thread, showToast]);

  const snooze = useCallback((until: string, label: string, watch?: string) => {
    if (!thread) return;
    const prev = thread.status;
    const id = thread.id;
    setSnoozeOpen(false);
    // The hook reports a failure through its notices; the catch only keeps it from being unhandled.
    mail.snooze(id, until, watch ?? null).catch(() => {});
    showToast({ text: `Snoozed · ${label.split(' · ')[0]}`, undo: () => void mail.setStatus(id, prev) });
  }, [mail, thread, showToast]);

  const archiveThread = useCallback(() => {
    if (!thread || mail.archivedIds.has(thread.id)) return;
    const id = thread.id;
    // The design moves on to the next row, as Done does in every mail client.
    mail.selectRelative(1);
    mail.archive(id).then(
      () => showToast({ text: 'Archived', undo: () => void mail.unarchive(id) }),
      () => {},
    );
  }, [mail, thread, showToast]);

  const archiveMessage = useCallback((messageId: string, archive: boolean) => {
    void boxes.setArchived(messageId, archive).then((res) => {
      if (res?.ok) showToast({ text: archive ? 'Archived' : 'Back in the inbox', undo: () => void boxes.setArchived(messageId, !archive) });
    });
  }, [boxes, showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return; }
      if (composing) { if (e.key === 'Escape') setComposing(false); return; }
      if (rulesOpen) { if (e.key === 'Escape') setRulesOpen(false); return; }
      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); mail.selectRelative(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); mail.selectRelative(-1); break;
        case 'Enter': if (!selectedThreadId && mail.threads.length) mail.selectThread(mail.threads[0].id); break;
        case 'Escape':
          if (snoozeOpen) setSnoozeOpen(false);
          else if (selectedThreadId) mail.selectThread(null);
          else navigate('/');
          break;
        case 'e': if (selectedThreadId) archiveThread(); break;
        case 'a': if (selectedThreadId) setStatus('approve'); break;
        case 'h': if (selectedThreadId) setSnoozeOpen((v) => !v); break;
        case 'r': if (selectedThreadId) setReplyRequest((n) => n + 1); break;
        case 'c': e.preventDefault(); setComposing(true); break;
        case 'u': if (mail.pendingSend) void mail.undoSend(); break;
        case '/': e.preventDefault(); searchRef.current?.focus(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mail, selectedThreadId, setStatus, archiveThread, composing, rulesOpen, snoozeOpen, navigate]);

  // The connected mailboxes' rows belong to Inbox and Archive only, and only
  // to the unfiltered lane: search and the account filter work on threads.
  const boxRows = mail.query.trim() || mail.mailbox ? [] : mail.view === 'inbox' ? boxes.inbox : mail.view === 'archive' ? boxes.archived : [];
  const laneCounts = useMemo(
    () => ({ ...mail.counts, inbox: (mail.counts.inbox ?? 0) + boxes.inbox.length, archive: (mail.counts.archive ?? 0) + boxes.archived.length }),
    [mail.counts, boxes.inbox.length, boxes.archived.length],
  );

  const { greeting, subline, handledN } = mailGreeting(mail.counts);
  const eyebrow = `${mail.account ? '1 account' : 'No account'} · ${handledN} handled${mail.lastSyncedAt ? ` · synced ${fullTime(mail.lastSyncedAt)}` : ''}`;
  // The auth user carries only an id and an email; the profile name lives in the
  // Home session's gate. Until that is shared, Atlas signs nothing rather than guessing.
  const firstName = null;

  return (
    <div className={`b-mail b-mail--${layout}`} data-screen-label="Beta — Mail">
      <header className="b-band b-band--short b-mail-hero">
        <div className="b-band-sphere" ref={sphereRef}><VeilSphere size="short" bg="#f1eeea" /></div>
        <div className="b-mail-hero-text">
          <span className="b-eyebrow">Mail · {eyebrow}</span>
          <button type="button" className="b-mail-greet" title="Back to Home · Esc" onClick={() => navigate('/')}>{greeting}</button>
          <p className="b-intro">{subline}</p>
        </div>
        <div className="b-mail-hero-tools">
          <label className="b-mail-search">
            <AtlasIcon name="search" size={16} weight={1.6} />
            <input ref={searchRef} type="search" value={mail.query} placeholder="Search mail, people, rules" aria-label="Search mail" onChange={(e) => mail.setQuery(e.target.value)} />
            <kbd>/</kbd>
          </label>
          <button type="button" className="b-btn b-btn--primary b-mail-write" title="Write · C" onClick={() => setComposing(true)}>
            <AtlasIcon name="compose" size={16} weight={1.7} />Write
          </button>
        </div>
      </header>

      <MailNotices
        error={mail.error ?? boxes.error ?? signInError}
        warning={mail.warning}
        onDismissError={() => { mail.dismissError(); boxes.dismissError(); setHiddenSignInError(intel.error); }}
        onDismissWarning={mail.dismissWarning}
        lastSyncedAt={mail.lastSyncedAt}
      />

      {!showSide ? (
        <div className="b-mail-lanechips nosb" role="tablist" aria-label="Mail lanes">
          {LANES.map((l) => {
            const n = laneCount(laneCounts, l.view);
            const on = mail.view === l.view;
            return <button type="button" key={l.view} role="tab" aria-selected={on} className={`b-chip${on ? ' on' : ''}`} onClick={() => mail.setView(l.view)}>{l.label}{n ? <span className="b-num"> {n}</span> : null}</button>;
          })}
          <button type="button" className="b-chip" onClick={() => setRulesOpen(true)}>Rules</button>
        </div>
      ) : null}

      <div className="b-mail-grid">
        {showSide ? (
          <MailLanes
            view={mail.view}
            counts={laneCounts}
            account={mail.account}
            mailbox={mail.mailbox}
            handledInMailbox={mail.counts.handled ?? 0}
            onView={mail.setView}
            onMailbox={mail.setMailbox}
            onOpenRules={() => setRulesOpen(true)}
          />
        ) : null}
        {!stacked || !thread ? (
          <MailList
            view={mail.view}
            mailbox={mail.mailbox}
            query={mail.query}
            threads={mail.threads}
            selectedThreadId={selectedThreadId}
            snippets={snippets}
            account={mail.account}
            unreadOnly={unreadOnly}
            emptyReason={mail.emptyReason}
            syncing={mail.syncing}
            onUnreadOnly={setUnreadOnly}
            onSelect={mail.selectThread}
            onSync={() => void mail.sync()}
            onClearMailbox={() => mail.setMailbox(null)}
            onClearQuery={() => mail.setQuery('')}
            extra={boxRows.length ? (
              <MailboxList
                mode={mail.view === 'archive' ? 'archive' : 'inbox'}
                rows={boxRows}
                refusals={boxes.refusals}
                working={boxes.working}
                connecting={intel.isConnecting}
                onArchive={archiveMessage}
                onReconnect={(provider) => void intel.connect(provider, { archive: true })}
              />
            ) : null}
            extraCount={boxRows.length}
          />
        ) : null}
        {!stacked || thread ? (
          thread ? (
            <MailReader
              thread={thread}
              account={mail.account}
              messages={mail.messages}
              drafts={mail.drafts}
              audit={mail.audit}
              matchedOn={matchedOn}
              pendingSend={mail.pendingSend}
              busy={mail.syncing}
              snoozeOpen={snoozeOpen}
              watch={mail.watches[thread.id] ?? null}
              archived={mail.archivedIds.has(thread.id)}
              replyRequest={replyRequest}
              stacked={stacked}
              onBack={() => mail.selectThread(null)}
              onStatus={setStatus}
              onArchive={archiveThread}
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
            <section className="b-mail-read b-mail-none" aria-label="Nothing selected">
              <span className="b-mail-none-t">Nothing selected</span>
              <span className="b-mail-none-b">Pick a message, or press C to write one. J and K move through the list.</span>
              <button type="button" className="b-btn b-btn--tinted b-btn--row" disabled={mail.syncing} onClick={() => void mail.sync()}>{mail.syncing ? 'Syncing…' : 'Sync now'}</button>
            </section>
          )
        ) : null}
      </div>

      {composing ? (
        <BetaCompose account={mail.account} knownAddresses={mail.knownAddresses} firstName={firstName} onClose={() => setComposing(false)} onToast={(text) => showToast({ text })} />
      ) : null}

      {rulesOpen ? (
        <>
          <div className="b-veil" onClick={() => setRulesOpen(false)} />
          <aside className="b-mail-drawer" aria-label="Rules and autonomy">
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
      ) : null}

      {toast ? (
        <div className="b-mail-toast" role="status">
          {toast.text}
          {toast.undo ? <button type="button" onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button> : null}
        </div>
      ) : null}
    </div>
  );
};

export default BetaMail;
