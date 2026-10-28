/**
 * The note Atlas wrote for one calendar event ("Prepare", row 9) or one task
 * ("Research", row 10): the saved note with its age, the answer streaming in
 * while Atlas writes it, and the buttons to ask, stop, ask again or forget.
 * The state is `useItemNotes`; this only draws it, so the Calendar's dark
 * card and the Tasks side list share one behaviour.
 */
import type { AskState, ItemNote } from '@/hooks/useItemNotes';
import { notedLabel } from '@/lib/betaViews';

export interface AtlasNoteProps {
  itemId: string;
  /** "Prepared" · "Researched" — the age line's verb. */
  verb: string;
  /** "Prepare" · "Research" — the button. */
  action: string;
  note: ItemNote | undefined;
  asking: AskState | null;
  now: number;
  onAsk: () => void;
  onCancel: () => void;
  onForget: () => void;
  /** The Calendar's card is ink; the Tasks list is paper. */
  onInk?: boolean;
}

export function AtlasNote({ itemId, verb, action, note, asking, now, onAsk, onCancel, onForget, onInk }: AtlasNoteProps) {
  const live = asking && asking.itemId === itemId ? asking : null;
  const busyElsewhere = !!asking?.busy && !live;
  const btn = onInk ? 'b-btn b-btn--onink' : 'b-wv-take-btn';
  return (
    <div className={`b-wv-note${onInk ? ' b-wv-note--ink' : ''}`}>
      {live?.busy ? (
        <>
          <span className="b-wv-note-h">Atlas is writing…</span>
          <p className="b-wv-note-p">{live.text}<i className="b-wv-caret" aria-hidden /></p>
          <div className="b-wv-note-actions"><button type="button" className={btn} onClick={onCancel}>Stop</button></div>
        </>
      ) : (
        <>
          {note?.body ? (
            <>
              <span className="b-wv-note-h">{notedLabel(verb, note.noted_at, now)} by Atlas</span>
              <p className="b-wv-note-p">{note.body}</p>
            </>
          ) : null}
          {live?.error ? <p className="b-wv-err">{live.error}</p> : null}
          <div className="b-wv-note-actions">
            <button type="button" className={btn} disabled={busyElsewhere} onClick={onAsk} title={busyElsewhere ? 'Atlas is writing another note' : undefined}>
              {note?.body ? `${action} again` : action}
            </button>
            {note?.body ? <button type="button" className={btn} onClick={onForget}>Forget the note</button> : null}
          </div>
        </>
      )}
    </div>
  );
}
