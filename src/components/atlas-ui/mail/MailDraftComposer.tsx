import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, RotateCcw, Trash2, Clock, Undo2, Ban } from 'lucide-react';
import type { MailDraft } from '@/types/mail';

// Props are the contract in docs/design-sync/2026-07-27-mail-contract.md §6.3 —
// I4 renders this inside MailReadingPane and neither side may change the shape.
export interface MailDraftComposerProps {
  threadId: string;
  drafts: MailDraft[];
  pendingSend: { draftId: string; threadId: string; sendsAt: number } | null;
  busy: boolean;
  onDraft: (opts?: { instruction?: string; tone?: string }) => Promise<MailDraft>;
  onSave: (draftId: string, body: string) => Promise<MailDraft>;
  onRevise: (draftId: string, instruction: string) => Promise<MailDraft>;
  onDiscard: (draftId: string) => Promise<void>;
  onSchedule: (draftId: string, sendAt: string) => Promise<MailDraft>;
  onApproveAndSend: (draftId: string) => Promise<void>;
  onUndoSend: () => Promise<void>;
  matchedOn: Array<{ label: string; value: string }>;
}

// Sending is blocked at the source, not intermittently: contract §4.3 fixes
// `mail_send_reply` as **always Err**, and useAtlasMail's sendNow() throws
// MailSendBlockedError unconditionally. That makes it a property of this build
// rather than a runtime unknown, which is why the composer is allowed to state
// it up front instead of discovering it after the undo window runs out.
//
// Flip this to false in the same commit that unblocks the worker's reply route;
// the undo window itself is untouched and keeps working either way.
const SEND_IS_BLOCKED: boolean = true;

// The exact string sendNow() rejects with. Not a guess at the message — it is
// the one fixed value the hook's contract guarantees, which is what lets the
// composer name the reason without a channel back to the rejected promise.
const SEND_BLOCKED_REASON = 'Sending requires the Workers Paid plan';

function formatCountdown(msRemaining: number): string {
  const s = Math.max(0, Math.ceil(msRemaining / 1000));
  return `${s}s`;
}

// datetime-local has no timezone of its own — the browser parses it as local
// wall-clock time, and Date#toISOString() then emits the correct UTC instant
// (offset "Z"). That round-trip is what makes this timezone-correct rather
// than a bare local string with no offset at all.
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function MailDraftComposer({
  threadId,
  drafts,
  pendingSend,
  busy,
  onDraft,
  onSave,
  onRevise,
  onDiscard,
  onSchedule,
  onApproveAndSend,
  onUndoSend,
  matchedOn,
}: MailDraftComposerProps) {
  const draft = drafts[0] ?? null;
  const [body, setBody] = useState(draft?.body ?? '');
  const [instruction, setInstruction] = useState('');
  const [tone, setTone] = useState('');
  const [reviseOpen, setReviseOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState('');
  const [busyLocal, setBusyLocal] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [windowElapsed, setWindowElapsed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hitZeroRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const thisPending = pendingSend && pendingSend.threadId === threadId ? pendingSend : null;

  // Keep the textarea in sync when a fresh draft arrives (new draft/revise),
  // but never clobber text the user is mid-edit on for the same draft id.
  const lastDraftId = useRef<string | null>(null);
  useEffect(() => {
    if (draft && draft.id !== lastDraftId.current) {
      setBody(draft.body);
      lastDraftId.current = draft.id;
      setWindowElapsed(false);
      setSaveError(null);
    }
  }, [draft]);

  // A pending autosave must never land after the composer has moved on: the
  // timer's closure holds the old draft id and the old text, so 600ms after the
  // last keystroke it would write them into whatever the user switched to. The
  // cleanup runs on unmount *and* on every thread/draft change, because this
  // component keeps its instance when the reading pane swaps threads.
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
  }, [threadId, draft?.id]);

  // Countdown tick while an approved send sits in its undo window. `now` is
  // re-read immediately: it is otherwise whatever it was when the last window
  // closed, and the strip would show a stale figure until the first tick.
  useEffect(() => {
    if (!thisPending) return;
    setNow(Date.now());
    // A second approval starts a live window; the notice must stop reporting the
    // outcome of the previous one.
    setWindowElapsed(false);
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [thisPending]);

  useEffect(() => {
    if (thisPending && now >= thisPending.sendsAt) hitZeroRef.current = true;
  }, [now, thisPending]);

  // The window elapsed locally and then pendingSend cleared — that is the hook's
  // automatic sendNow() landing. It rejects; the verbatim refusal comes back
  // through the hook's `error` and is rendered by MailNotices at the shell. All
  // this flag does is stop the standing notice from still saying "will run".
  useEffect(() => {
    if (hitZeroRef.current && !thisPending) {
      setWindowElapsed(true);
      hitZeroRef.current = false;
    }
  }, [thisPending]);

  if (!draft) {
    return (
      <div className="mail-compose">
        <div className="mail-compose-actions">
          <button
            type="button"
            disabled={busy || busyLocal}
            onClick={async () => {
              setBusyLocal(true);
              try {
                await onDraft();
              } finally {
                setBusyLocal(false);
              }
            }}
          >
            <Sparkles size={14} aria-hidden />
            {busy || busyLocal ? 'Drafting…' : 'Draft a reply'}
          </button>
        </div>
      </div>
    );
  }

  const dirty = body !== draft.body;

  // The value is passed in rather than read from `body`. onChange fires with the
  // state setter still queued, so the surviving timer's closure captured `body`
  // from the render *before* the keystroke that scheduled it — type "Thanks!"
  // and the row stored "Thanks", every time, because the final character only
  // ever debounced the save it was meant to be part of.
  const scheduleSave = (value: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      // saveDraft throws rather than setting the hook's error, and an autosave
      // that fails silently is an edit the user believes is on disk.
      onSave(draft.id, value)
        .then(() => setSaveError(null))
        .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)));
    }, 600);
  };

  return (
    <div className="mail-compose">
      {matchedOn.length > 0 && (
        <div className="mail-compose-pills">
          {matchedOn.map((m) => (
            <span key={`${m.label}:${m.value}`} className="mail-compose-pill">
              {m.label}: {m.value}
            </span>
          ))}
        </div>
      )}

      <textarea
        className="mail-compose-body"
        value={body}
        disabled={busy || busyLocal}
        onChange={(e) => {
          setBody(e.target.value);
          scheduleSave(e.target.value);
        }}
        rows={8}
      />

      {draft.model && (
        <p className="mail-muted">
          Drafted by {draft.model}
          {draft.prompt_version ? ` · ${draft.prompt_version}` : ''}
          {dirty ? ' · edited' : ''}
        </p>
      )}

      {reviseOpen && (
        <div className="mail-rules-form">
          <input
            className="mail-compose-body"
            placeholder="Revision instruction (e.g. shorter, more formal)"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="mail-compose-actions">
            <button
              type="button"
              disabled={!instruction.trim() || busy || busyLocal}
              onClick={async () => {
                setBusyLocal(true);
                try {
                  await onRevise(draft.id, instruction.trim());
                  setInstruction('');
                  setReviseOpen(false);
                } finally {
                  setBusyLocal(false);
                }
              }}
            >
              Revise
            </button>
            <button type="button" className="mail-muted" onClick={() => setReviseOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {scheduleOpen && (
        <div className="mail-rules-form">
          <input
            type="datetime-local"
            className="mail-compose-body"
            value={scheduleValue}
            onChange={(e) => setScheduleValue(e.target.value)}
          />
          <div className="mail-compose-actions">
            <button
              type="button"
              disabled={!scheduleValue || busy || busyLocal}
              onClick={async () => {
                const iso = localInputToIso(scheduleValue);
                if (!iso) return;
                setBusyLocal(true);
                try {
                  await onSchedule(draft.id, iso);
                  setScheduleOpen(false);
                } finally {
                  setBusyLocal(false);
                }
              }}
            >
              Confirm time
            </button>
            <button type="button" className="mail-muted" onClick={() => setScheduleOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Stated BEFORE the user approves, not after the countdown. The undo
          window is real and stays — it is the control that has to exist the day
          the plan is bought — but while sending is off the countdown is a hold
          on a decision, not on an outgoing message, and it must not be dressed
          as one. */}
      {SEND_IS_BLOCKED && (
        <p className="mail-compose-blocked" role="status">
          {windowElapsed
            ? `The undo window ran out and nothing was sent: ${SEND_BLOCKED_REASON}. The reply is still here, unsent.`
            : `Sending is off in this build: ${SEND_BLOCKED_REASON}. Approving records your decision and starts the undo window — no mail leaves this Mac.`}
        </p>
      )}

      {thisPending ? (
        <div className="mail-compose-undo">
          <span>
            {SEND_IS_BLOCKED
              ? <>Undo window: {formatCountdown(thisPending.sendsAt - now)} left — <span className="mail-kbd">u</span> to take the approval back. Nothing is being sent.</>
              : <>Sending in {formatCountdown(thisPending.sendsAt - now)} — <span className="mail-kbd">u</span> to undo</>}
          </span>
          <button type="button" onClick={() => void onUndoSend()}>
            <Undo2 size={14} aria-hidden /> Undo
          </button>
        </div>
      ) : (
        <div className="mail-compose-actions">
          <button
            type="button"
            disabled={busy || busyLocal || draft.state === 'discarded' || draft.state === 'sent'}
            onClick={async () => {
              setBusyLocal(true);
              try {
                await onApproveAndSend(draft.id);
              } finally {
                setBusyLocal(false);
              }
            }}
          >
            {SEND_IS_BLOCKED ? (
              <><Ban size={14} aria-hidden /> Approve (sending is off)</>
            ) : (
              <><Send size={14} aria-hidden /> Approve &amp; send</>
            )}
          </button>
          <button type="button" onClick={() => setScheduleOpen((v) => !v)}>
            <Clock size={14} aria-hidden /> Schedule
          </button>
          <button type="button" onClick={() => setReviseOpen((v) => !v)}>
            <RotateCcw size={14} aria-hidden /> Revise
          </button>
          <button
            type="button"
            className="mail-danger"
            disabled={busy || busyLocal}
            onClick={() => void onDiscard(draft.id)}
          >
            <Trash2 size={14} aria-hidden /> Discard
          </button>
        </div>
      )}

      {saveError && (
        <p className="mail-compose-blocked" role="alert">
          Your edit is not saved: {saveError}
        </p>
      )}
    </div>
  );
}
