import { ArrowLeft, Paperclip } from 'lucide-react';
import type {
  MailAuditEvent, MailDraft, MailMessage, MailThread, MailThreadStatus,
} from '@/types/mail';
import { MailDraftComposer } from './MailDraftComposer';
import { MailAuditTrail } from './MailAuditTrail';
import { MailStatusChip } from './MailStatusChip';
import {
  displayName, formatBytes, fullTime, participantSummary, snoozePresets,
} from './mailFormat';

interface MailReadingPaneProps {
  thread: MailThread;
  messages: MailMessage[];
  drafts: MailDraft[];
  audit: MailAuditEvent[];
  matchedOn: Array<{ label: string; value: string }>;
  pendingSend: { draftId: string; threadId: string; sendsAt: number } | null;
  busy: boolean;
  /** True in the stacked (<820px) layout, where the pane replaces the list. */
  stacked: boolean;
  snoozeOpen: boolean;
  onBack: () => void;
  onStatus: (status: MailThreadStatus) => void;
  onToggleSnooze: () => void;
  onSnooze: (until: string) => void;
  onDraft: (opts?: { instruction?: string; tone?: string }) => Promise<MailDraft>;
  onSaveDraft: (draftId: string, body: string) => Promise<MailDraft>;
  onReviseDraft: (draftId: string, instruction: string) => Promise<MailDraft>;
  onDiscardDraft: (draftId: string) => Promise<void>;
  onScheduleDraft: (draftId: string, sendAt: string) => Promise<MailDraft>;
  onApproveAndSend: (draftId: string) => Promise<void>;
  onUndoSend: () => Promise<void>;
}

export const MailReadingPane = ({
  thread, messages, drafts, audit, matchedOn, pendingSend, busy, stacked, snoozeOpen,
  onBack, onStatus, onToggleSnooze, onSnooze,
  onDraft, onSaveDraft, onReviseDraft, onDiscardDraft, onScheduleDraft, onApproveAndSend, onUndoSend,
}: MailReadingPaneProps) => (
  <section className="mail-pane" aria-label={thread.subject || 'Thread'}>
    <header className="mail-pane-head">
      {stacked && (
        <button type="button" className="pbtn" onClick={onBack} aria-label="Back to the thread list">
          <ArrowLeft className="i16" aria-hidden />
        </button>
      )}
      <div>
        <h1 className="disp">{thread.subject || '(no subject)'}</h1>
        <p className="mail-muted trunc">{participantSummary(thread.participants)} · {thread.mailbox}</p>
      </div>
      <MailStatusChip status={thread.status} />

      <div className="mail-pane-actions">
        <button type="button" onClick={() => onStatus('approve')}>
          Approve <span className="mail-kbd" aria-hidden>a</span>
        </button>
        <button type="button" onClick={() => onStatus('handled')}>
          Handled <span className="mail-kbd" aria-hidden>e</span>
        </button>
        <button type="button" onClick={() => onStatus('escalate')}>Escalate</button>
        <button type="button" onClick={() => onStatus('handoff')}>Hand to a human</button>
        <button type="button" aria-expanded={snoozeOpen} onClick={onToggleSnooze}>
          Snooze <span className="mail-kbd" aria-hidden>s</span>
        </button>
      </div>

      {/* CONTRACT-GAP: §6.4 names no class for a snooze picker, so it renders as a
          second `mail-pane-actions` row rather than inventing a `mail-*` name.
          Every option is resolved in the user's own zone — see snoozePresets(). */}
      {snoozeOpen && (
        <div className="mail-pane-actions" role="group" aria-label="Snooze until">
          {snoozePresets().map((p) => (
            <button key={p.until} type="button" onClick={() => onSnooze(p.until)}>{p.label}</button>
          ))}
        </div>
      )}
    </header>

    <div className="mail-pane-body">
      {messages.length === 0 ? (
        <p className="mail-muted">No messages stored for this thread yet — open it again after a sync.</p>
      ) : (
        messages.map((m) => {
          const attachments = m.extracted?.attachments ?? [];
          return (
            <article key={m.id} className="mail-msg">
              <header className="mail-msg-head">
                <span>{displayName(m.from_address)}</span>
                <span className="mail-muted trunc">→ {m.extracted?.to_address || thread.mailbox}</span>
                <time className="tnum" dateTime={m.received_at ?? undefined}>{fullTime(m.received_at)}</time>
              </header>

              {/* body_html is deliberately not rendered: remote mail is untrusted
                  input, and the pane has no sanitiser. Plain text only. */}
              <div className="mail-msg-body">{m.extracted?.body_text || m.snippet || '(no text body stored)'}</div>

              {m.extracted?.truncated && (
                <p className="mail-msg-truncated">
                  Stored body was capped at ingest — this is not the full message.
                </p>
              )}

              {attachments.length > 0 && (
                <ul className="mail-attach">
                  {attachments.map((a, i) => (
                    // Metadata only: there is no R2 bucket and no byte-fetch route,
                    // so nothing here is a link and nothing pretends to download.
                    <li key={`${m.id}-${i}`} className="mail-attach-item">
                      <Paperclip className="i12" aria-hidden />
                      <span className="trunc">{a.filename || 'unnamed attachment'}</span>
                      <span className="mail-muted">{a.mime_type || 'unknown type'} · {formatBytes(a.size_bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })
      )}

      {/* The hook's `error` is deliberately NOT rendered here. It was invisible
          unless a thread happened to be open — approve a send, press Esc, and
          the refusal had nowhere to land. It lives in MailNotices, at the shell. */}
      <MailDraftComposer
        threadId={thread.id}
        drafts={drafts}
        pendingSend={pendingSend}
        busy={busy}
        onDraft={onDraft}
        onSave={onSaveDraft}
        onRevise={onReviseDraft}
        onDiscard={onDiscardDraft}
        onSchedule={onScheduleDraft}
        onApproveAndSend={onApproveAndSend}
        onUndoSend={onUndoSend}
        matchedOn={matchedOn}
      />

      <MailAuditTrail events={audit} />
    </div>
  </section>
);
