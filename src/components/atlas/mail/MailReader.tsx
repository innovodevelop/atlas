/**
 * The Beta Mail reading pane (`Atlas Mail Beta.dc.html`, section "Reading"):
 * status, subject, people, Reply / Snooze / Done, the snooze options, the
 * Atlas card (what Atlas did or is waiting for), the messages, and the reply
 * box fed by the thread's live draft.
 *
 * Sending goes through the hook's approve-and-send with its undo window; while
 * sending is blocked (Workers Paid plan) the hook refuses and the refusal lands
 * in the notices at the top of the page — the button never pretends.
 */
import { useEffect, useRef, useState } from 'react';
import { AtlasIcon } from '../AtlasIcon';
import { REWRITES, STATUS_CHIP, atlasCard, initialsOf, laterSendIso } from '@/lib/betaMail';
import { displayName, formatBytes, fullTime, participantSummary, snoozePresets } from '@/components/atlas-ui/mail/mailFormat';
import type { MailAccount, MailAuditEvent, MailDraft, MailMessage, MailThread, MailThreadStatus } from '@/types/mail';

export interface MailReaderProps {
  thread: MailThread;
  account: MailAccount | null;
  messages: MailMessage[];
  drafts: MailDraft[];
  audit: MailAuditEvent[];
  matchedOn: Array<{ label: string; value: string }>;
  pendingSend: { draftId: string; threadId: string; sendsAt: number } | null;
  busy: boolean;
  snoozeOpen: boolean;
  /** Set by the R shortcut: focus the reply, drafting one first if needed. */
  replyRequest: number;
  stacked: boolean;
  onBack: () => void;
  onStatus: (status: MailThreadStatus) => void;
  onToggleSnooze: () => void;
  onSnooze: (until: string, label: string) => void;
  onDraft: (opts?: { instruction?: string; tone?: string }) => Promise<MailDraft>;
  onSaveDraft: (draftId: string, body: string) => Promise<MailDraft>;
  onReviseDraft: (draftId: string, instruction: string) => Promise<MailDraft>;
  onDiscardDraft: (draftId: string) => Promise<void>;
  onScheduleDraft: (draftId: string, sendAt: string) => Promise<MailDraft>;
  onApproveAndSend: (draftId: string) => Promise<void>;
  onUndoSend: () => Promise<void>;
}

export function MailReader(p: MailReaderProps) {
  const { thread } = p;
  const chip = STATUS_CHIP[thread.status];
  const live = p.drafts.find((d) => d.state === 'proposed' || d.state === 'scheduled') ?? null;
  const pending = !!p.pendingSend && p.pendingSend.threadId === thread.id;
  const card = atlasCard(thread, p.audit, live, pending, p.matchedOn);
  const own = thread.mailbox;
  const canReply = thread.status !== 'handled' && thread.status !== 'snooze';

  // The reply box edits a local copy and writes it back on blur / before
  // sending, so typing never races the hook's re-query.
  const [body, setBody] = useState(live?.body ?? '');
  const [edited, setEdited] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const original = useRef<string>(live?.body ?? '');
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setBody(live?.body ?? '');
    setEdited(false);
    if (live && !original.current) original.current = live.body;
    if (!live) original.current = '';
  }, [live?.id, live?.body]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [pending]);

  // R: focus the reply, drafting first when there is nothing to edit yet.
  const lastReq = useRef(0);
  useEffect(() => {
    if (!p.replyRequest || p.replyRequest === lastReq.current) return;
    lastReq.current = p.replyRequest;
    if (live) { textRef.current?.focus(); return; }
    if (canReply) void draftNow();
  }, [p.replyRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setWorking(label);
    try { await fn(); } catch { /* the hook reports through its notices */ } finally { setWorking(null); }
  };
  const draftNow = () => run('draft', () => p.onDraft());
  const flush = async () => { if (live && edited && body !== live.body) { await p.onSaveDraft(live.id, body); setEdited(false); } };
  const send = () => live && run('send', async () => { await flush(); await p.onApproveAndSend(live.id); });
  const rewrite = (instruction: string) => live && run('rewrite', async () => { await flush(); await p.onReviseDraft(live.id, instruction); });
  const restore = () => { if (!live) return; setBody(original.current || live.body); setEdited(true); };
  const later = () => live && run('schedule', async () => { await flush(); await p.onScheduleDraft(live.id, laterSendIso()); });
  const discard = () => live && run('discard', () => p.onDiscardDraft(live.id));

  const secondsLeft = pending && p.pendingSend ? Math.max(0, Math.ceil((p.pendingSend.sendsAt - now) / 1000)) : 0;

  return (
    <section className="b-mail-read" aria-label={thread.subject || 'Thread'}>
      <div className="b-mail-read-head">
        {p.stacked ? <button type="button" className="b-mail-round" onClick={p.onBack} aria-label="Back to the list"><AtlasIcon name="chevron left" size={16} /></button> : null}
        <div className="b-mail-read-title">
          <span className="b-mail-read-chips">
            <span className={`b-mail-chip b-mail-chip--${chip.tone}`}><i />{chip.label}</span>
            <span className="b-mail-row-acct"><i style={{ background: p.account?.colour ?? 'var(--b-blue)' }} />{own}</span>
          </span>
          <h1 className="b-mail-h1">{thread.subject || '(no subject)'}</h1>
          <p className="b-mail-people">{participantSummary(thread.participants)}</p>
        </div>
        <div className="b-mail-read-actions">
          <button type="button" className="b-mail-round" title="Reply · R" aria-label="Reply" disabled={!canReply || working === 'draft'} onClick={() => (live ? textRef.current?.focus() : void draftNow())}><AtlasIcon name="reply" size={16} /></button>
          <button type="button" className={`b-mail-round${p.snoozeOpen ? ' on' : ''}`} title="Snooze · H" aria-label="Snooze" aria-expanded={p.snoozeOpen} onClick={p.onToggleSnooze}><AtlasIcon name="clock" size={16} /></button>
          <button type="button" className="b-mail-round" title="Done · E" aria-label="Mark done" disabled={thread.status === 'handled'} onClick={() => p.onStatus('handled')}><AtlasIcon name="check" size={16} /></button>
        </div>
      </div>
      {p.snoozeOpen ? (
        <div className="b-mail-snooze" role="group" aria-label="Snooze until">
          {snoozePresets().map((o) => {
            const [l, t] = o.label.split(' · ');
            return <button type="button" key={o.until} onClick={() => p.onSnooze(o.until, o.label)}>{l}{t ? <span>{t}</span> : null}</button>;
          })}
        </div>
      ) : null}

      <div className="b-mail-read-body nosb">
        <div className={`b-mail-card b-mail-card--${card.tone}`} key={`${thread.id}-${thread.status}`}>
          <span className="b-mail-card-ico"><AtlasIcon name="sparkle" size={16} /></span>
          <div className="b-mail-card-text">
            <p className="b-mail-card-t">{card.title}</p>
            <p className="b-mail-card-b">{card.body}</p>
            {card.facts.length ? <span className="b-mail-facts">{card.facts.map((f) => <span key={f}>{f}</span>)}</span> : null}
            {card.decision && live ? (
              <span className="b-mail-card-actions">
                <button type="button" className="b-btn b-btn--primary" disabled={!!working || p.busy} onClick={send}>{working === 'send' ? 'Sending…' : card.decision.label}</button>
                <button type="button" className="b-btn b-btn--card" disabled={!!working} onClick={discard}>Don’t send</button>
              </span>
            ) : null}
            {card.pending ? (
              <button type="button" className="b-btn b-btn--card b-btn--row b-mail-undo" onClick={() => void p.onUndoSend()}>Undo · {secondsLeft}s</button>
            ) : card.undo ? (
              <button type="button" className="b-btn b-btn--card b-btn--row b-mail-undo" onClick={() => p.onStatus(card.undo!.status)}>{card.undo.label}</button>
            ) : null}
          </div>
        </div>

        {p.messages.length === 0 ? (
          <p className="b-mail-note">No messages stored for this thread yet — open it again after a sync.</p>
        ) : p.messages.map((m) => {
          const out = m.extracted?.direction === 'outbound';
          const who = out ? 'You' : displayName(m.from_address);
          const att = m.extracted?.attachments ?? [];
          return (
            <article key={m.id} className={`b-mail-msg${out ? ' b-mail-msg--out' : ''}`}>
              <header>
                <span className="b-mail-av">{out ? <AtlasIcon name="person" size={14} /> : initialsOf(m.from_address ?? '?')}</span>
                <span className="b-mail-msg-who"><b>{who}</b><span>{out ? `Sent from ${own}` : `to ${m.extracted?.to_address || own}`}</span></span>
                <time className="b-num" dateTime={m.received_at ?? undefined}>{fullTime(m.received_at)}</time>
              </header>
              {/* Plain text only: remote mail is untrusted and there is no sanitiser. */}
              <p className="b-mail-msg-body">{m.extracted?.body_text || m.snippet || '(no text body stored)'}</p>
              {m.extracted?.truncated ? <p className="b-mail-note">Stored body was capped at ingest — this is not the full message.</p> : null}
              {att.length ? (
                <span className="b-mail-att">{att.map((a, i) => <span key={`${m.id}-${i}`}><AtlasIcon name="attach" size={14} />{a.filename || 'unnamed attachment'}<small>{formatBytes(a.size_bytes)}</small></span>)}</span>
              ) : null}
            </article>
          );
        })}

        {live && !pending ? (
          <div className="b-mail-reply">
            <div className="b-mail-reply-head">
              <AtlasIcon name="sparkle" size={14} />
              <span>{edited || live.body !== original.current ? 'Your reply' : 'Atlas drafted a reply'}{live.state === 'scheduled' && live.scheduled_for ? ` · sends ${fullTime(live.scheduled_for)}` : ''}</span>
              <span className="b-mail-reply-hint">In your tone · edit freely</span>
            </div>
            <textarea
              ref={textRef}
              className="b-mail-reply-text"
              aria-label="Reply"
              rows={3}
              value={body}
              onChange={(e) => { setBody(e.target.value); setEdited(true); }}
              onBlur={() => void flush()}
            />
            <div className="b-mail-reply-actions">
              <button type="button" className="b-btn b-btn--primary b-btn--row" disabled={!!working || p.busy || !body.trim()} onClick={send}>{working === 'send' ? 'Sending…' : 'Send'}</button>
              {REWRITES.map((r) => (
                <button type="button" key={r.key} className="b-mail-rewrite" disabled={!!working} onClick={() => rewrite(r.instruction)}>{working === 'rewrite' ? '…' : r.label}</button>
              ))}
              <button type="button" className="b-mail-rewrite" disabled={!!working || body === original.current} onClick={restore}>Original</button>
              <button type="button" className="b-mail-rewrite" disabled={!!working} onClick={later} title="Tomorrow 08:00">{live.state === 'scheduled' ? 'Rescheduled' : 'Send later'}</button>
              <span className="b-mail-reply-sp" />
              <button type="button" className="b-mail-rewrite b-mail-rewrite--quiet" disabled={!!working} onClick={discard}>Discard</button>
            </div>
          </div>
        ) : !pending && canReply ? (
          <div className="b-mail-reply b-mail-reply--empty">
            <button type="button" className="b-btn b-btn--tinted" disabled={working === 'draft' || p.busy} onClick={() => void draftNow()}>
              <AtlasIcon name="sparkle" size={14} />{working === 'draft' ? 'Drafting…' : 'Draft a reply with Atlas'}
            </button>
            <span className="b-mail-reply-hint">Or press R. Atlas writes in your tone; you send.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
