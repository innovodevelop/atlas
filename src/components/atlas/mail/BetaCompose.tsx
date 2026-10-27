/**
 * Write — the compose sheet (`Atlas Mail Beta.dc.html`, "New message").
 *
 * From, To, Subject, the body, "Ask Atlas to write it" (the brain, streamed
 * into the body), and the first-contact line when nobody in your mail has
 * that address. What is not here: Send and Send later. Atlas has no path for
 * starting a conversation yet (replies go through the worker; sending itself
 * needs the Workers Paid plan), so the primary action opens the message in
 * the Mac's own mail app with everything filled in — real, and honest.
 */
import { useEffect, useRef, useState } from 'react';
import { AtlasIcon } from '../AtlasIcon';
import { askAtlas } from '@/lib/askAtlas';
import { composePrompt, isFirstContact, mailtoUrl } from '@/lib/betaMail';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import type { MailAccount } from '@/types/mail';

export interface BetaComposeProps {
  account: MailAccount | null;
  knownAddresses: string[];
  firstName: string | null;
  onClose: () => void;
  onToast: (text: string) => void;
}

export function BetaCompose({ account, knownAddresses, firstName, onClose, onToast }: BetaComposeProps) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const toRef = useRef<HTMLInputElement | null>(null);
  const canOpen = to.trim().length > 0 && (body.trim().length > 0 || subject.trim().length > 0);
  const firstContact = isFirstContact(to, knownAddresses);

  useEffect(() => { toRef.current?.focus(); return () => abort.current?.abort(); }, []);

  const ask = async () => {
    if (writing) return;
    setWriting(true);
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const result = await askAtlas(composePrompt({ to, subject, body, firstName }), {
        screen: 'Mail',
        signal: ctrl.signal,
        onText: (text) => setBody(text),
      });
      if (!ctrl.signal.aborted && !result.text) setError('Atlas did not come up with anything — try describing it in a few more words.');
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Atlas did not answer.');
    } finally {
      if (!ctrl.signal.aborted) setWriting(false);
    }
  };

  const open = () => {
    if (!canOpen) return;
    void openExternal(mailtoUrl(to, subject, body));
    onToast('Opened in your mail app');
    onClose();
  };

  return (
    <div className="b-mail-veil" onClick={onClose}>
      <div className="b-mail-sheet" role="dialog" aria-label="New message" onClick={(e) => e.stopPropagation()}>
        <div className="b-mail-sheet-head">
          <span className="b-mail-sheet-t">New message</span>
          <button type="button" className="b-mail-round b-mail-round--card" aria-label="Close" onClick={onClose}><AtlasIcon name="close" size={15} /></button>
        </div>
        <div className="b-mail-fields">
          <div className="b-mail-field b-mail-field--from">
            <span>From</span>
            {account ? (
              <span className="b-mail-from on"><i style={{ background: account.colour ?? 'var(--b-on-ink)' }} />{account.email_address}</span>
            ) : (
              <span className="b-mail-from">No mailbox connected</span>
            )}
          </div>
          <label className="b-mail-field"><span>To</span><input ref={toRef} value={to} onChange={(e) => setTo(e.target.value)} placeholder="Name or email" aria-label="To" /></label>
          <label className="b-mail-field"><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What’s it about?" aria-label="Subject" /></label>
        </div>
        {firstContact ? (
          <div className="b-mail-first"><i />First time writing to {to.trim()}. Atlas will never reply to them alone unless you allow it.</div>
        ) : null}
        <div className="b-mail-sheet-body">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); open(); } }}
            placeholder="Write, or describe what you want to say and press Ask Atlas"
            aria-label="Message"
          />
          {error ? <p className="b-mail-note b-mail-note--err">{error}</p> : null}
        </div>
        <div className="b-mail-sheet-actions">
          <button type="button" className={`b-btn b-mail-send${canOpen ? ' b-btn--primary' : ''}`} disabled={!canOpen} onClick={open} title="Opens the message in your mail app">Open in Mail app</button>
          <button type="button" className="b-btn b-btn--card b-mail-ask" disabled={writing} onClick={() => void ask()}>
            <AtlasIcon name="sparkle" size={15} />{writing ? 'Writing…' : 'Ask Atlas to write it'}
          </button>
          <span className="b-mail-sheet-sp" />
          <span className="b-mail-sheet-hint">Atlas can’t start new conversations yet · ⌘↵ opens</span>
        </div>
      </div>
    </div>
  );
}
