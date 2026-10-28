/**
 * "Earlier conversations" (`Atlas Voice Beta.dc.html`, left-out row 29), on
 * the Beta Voice and Answer screens.
 *
 * The list is what this Mac already keeps: the brain writes every turn it
 * answers to the local `chat_turns` table, and its `/conversations/*` routes
 * read back only what was said (src/lib/earlierConversations.ts). Opening a
 * row reads that conversation in place; Back returns to the list. Nothing is
 * sent anywhere to draw this card.
 */
import { useCallback, useEffect, useState } from 'react';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { fetchConversation, fetchConversations } from '@/lib/answerBrain';
import {
  conversationRow, earlierThan, parseConversation, parseConversationList,
  type ConversationSummary, type ConversationTurn,
} from '@/lib/earlierConversations';
import '@/styles/beta/answer.css';

const SHOWN = 6;
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export interface EarlierConversationsProps {
  /** When the screen opened: conversations begun after it are this session's. */
  openedAt: number;
  /** The conversation under way on this screen, when the caller knows its id. */
  current?: string | null;
  /** Wrapper class: the Voice aside's card, or the Answer screen's. */
  className?: string;
}

export function EarlierConversations({ openedAt, current = null, className = 'b-voice-card' }: EarlierConversationsProps) {
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ConversationSummary | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchConversations(20)
      .then((raw) => { if (live) setList(earlierThan(parseConversationList(raw), openedAt, current).slice(0, SHOWN)); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'The brain did not answer.'); });
    return () => { live = false; };
  }, [openedAt, current]);

  const read = useCallback(async (c: ConversationSummary) => {
    setOpen(c);
    setTurns(null);
    setReadError(null);
    try {
      setTurns(parseConversation(await fetchConversation(c.id)));
    } catch (e) {
      setReadError(e instanceof Error ? e.message : 'That conversation could not be read.');
    }
  }, []);

  if (open) {
    const row = conversationRow(open);
    return (
      <section className={`${className} b-earlier`} aria-label="Earlier conversation">
        <div className="b-earlier-head">
          <button type="button" className="b-btn b-btn--row b-earlier-back" onClick={() => setOpen(null)}>
            <AtlasIcon name="chevron left" size={14} />Earlier conversations
          </button>
          <span className="b-earlier-when">{row.when}</span>
        </div>
        <p className="b-earlier-title">{open.title}</p>
        <span className="b-earlier-sub">{row.sub}</span>
        {readError ? <p role="alert" className="b-earlier-note">{readError}</p> : null}
        {turns === null && !readError ? <p className="b-earlier-note">Reading…</p> : null}
        {turns ? (
          <div className="b-earlier-turns nosb">
            {turns.map((t, i) => (
              <div key={`${t.at}-${i}`} className={`b-earlier-turn${t.role === 'assistant' ? ' atlas' : ''}`}>
                <span className="b-earlier-who">{t.role === 'assistant' ? 'Atlas' : 'You'}<small className="b-num">{TIME.format(new Date(t.at))}</small></span>
                <p>{t.content}</p>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className={`${className} b-earlier`} aria-label="Earlier conversations">
      <p className="b-earlier-h">Earlier conversations</p>
      {error ? <p className="b-earlier-note">{error.includes('desktop app') ? 'Earlier conversations are kept by the Atlas app on your Mac.' : error}</p> : null}
      {list === null && !error ? <p className="b-earlier-note">Reading this Mac’s history…</p> : null}
      {list && list.length === 0 ? <p className="b-earlier-note">Nothing earlier yet. What you say to Atlas is kept here, on this Mac.</p> : null}
      {list?.map((c) => {
        const row = conversationRow(c);
        return (
          <button key={c.id} type="button" className="b-earlier-row" onClick={() => void read(c)}>
            <span className="b-earlier-row-text">
              <b>{c.title}</b>
              <small>{row.sub}</small>
            </span>
            <span className="b-earlier-when">{row.when}</span>
          </button>
        );
      })}
    </section>
  );
}
