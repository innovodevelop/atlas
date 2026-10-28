/**
 * Cards — spaced repetition on the School screen (`Atlas School Beta.dc.html`,
 * the "Kort" tab).
 *
 * Every card is one the student wrote, or one Atlas drafted from notes they
 * pasted and they chose to keep. The scheduler is `schedule` in
 * lib/betaSchool.ts (SM-2 style); the four grades show what each would do to
 * the card in front of you. Keys: Space or Enter flips, 1–4 grades.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GRADES, addDays, cardsPrompt, dayKey, dueCards, forecast, formatInterval, gradePreview, newCard,
  nextColour, nextDueAt, parseCardDrafts, reviewsToday, schedule, startOfDay, uid, weekdayShort,
  type Card, type Deck, type Grade,
} from '@/lib/betaSchool';
import { updateSchool, useSchool } from '@/lib/betaSchoolStore';
import { isTyping } from '@/pages/atlas/atlasHelpers';
import { useAsk, useNow, type SchoolToast } from './useSchoolHooks';

const NEW_DECK = '__new';

export function SchoolCards({ onToast }: { onToast: SchoolToast }) {
  const school = useSchool();
  const now = useNow(15_000);
  const [deckId, setDeckId] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [target, setTarget] = useState<string>(() => school.decks[0]?.id ?? NEW_DECK);
  const [newDeckName, setNewDeckName] = useState('');
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [drafts, setDrafts] = useState<{ id: string; front: string; back: string }[]>([]);
  const atlas = useAsk();

  // A deck that was deleted elsewhere falls back to all decks.
  const deck = deckId ? school.decks.find((d) => d.id === deckId) ?? null : null;
  useEffect(() => { if (deckId && !deck) setDeckId(null); }, [deckId, deck]);
  useEffect(() => { if (target !== NEW_DECK && !school.decks.some((d) => d.id === target)) setTarget(school.decks[0]?.id ?? NEW_DECK); }, [school.decks, target]);

  const due = useMemo(() => dueCards(school.cards, now, deck?.id ?? null), [school.cards, now, deck]);
  const allDue = useMemo(() => dueCards(school.cards, now), [school.cards, now]);
  const current: Card | null = due[0] ?? null;
  const currentId = current?.id;
  // A new card always starts on its question.
  useEffect(() => { setFlipped(false); }, [currentId]);
  const preview = useMemo(() => (current ? gradePreview(current, now) : null), [current, now]);
  const reviewed = reviewsToday(school.reviewLog, now);
  const nextAt = nextDueAt(school.cards, now, deck?.id ?? null);
  const bars = useMemo(() => forecast(school.cards, now), [school.cards, now]);
  const barMax = Math.max(1, ...bars);
  const deckOf = useCallback((id: string): Deck | undefined => school.decks.find((d) => d.id === id), [school.decks]);

  const grade = useCallback((g: Grade) => {
    if (!current) return;
    const before = current;
    const at = Date.now();
    const key = dayKey(at);
    const after = schedule(before, g, at);
    updateSchool((s) => ({
      ...s,
      cards: s.cards.map((c) => (c.id === before.id ? after : c)),
      reviewLog: { ...s.reviewLog, [key]: (s.reviewLog[key] ?? 0) + 1 },
    }));
    const label = GRADES.find((x) => x.key === g)?.label ?? g;
    onToast(`${label} · back in ${formatInterval(after.due - at)}`, () => updateSchool((s) => ({
      ...s,
      cards: s.cards.map((c) => (c.id === before.id ? before : c)),
      reviewLog: { ...s.reviewLog, [key]: Math.max(0, (s.reviewLog[key] ?? 1) - 1) },
    })));
  }, [current, onToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !current) return;
      const onControl = e.target instanceof HTMLElement && !!e.target.closest('button, a, summary, select');
      if ((e.key === ' ' || e.key === 'Enter') && !onControl) { e.preventDefault(); setFlipped((f) => !f); return; }
      if (flipped && /^[1-4]$/.test(e.key)) { e.preventDefault(); grade(GRADES[Number(e.key) - 1].key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, flipped, grade]);

  /** The deck new cards go into, created on first use when the student named a new one. */
  const ensureDeck = useCallback((): string | null => {
    if (target !== NEW_DECK) return target;
    const name = newDeckName.trim();
    if (!name) return null;
    const id = uid('deck');
    updateSchool((s) => ({ ...s, decks: [...s.decks, { id, name, colour: nextColour(s.decks) }] }));
    setTarget(id);
    setNewDeckName('');
    return id;
  }, [target, newDeckName]);

  const addCard = () => {
    const id = ensureDeck();
    if (!id || !front.trim() || !back.trim()) return;
    updateSchool((s) => ({ ...s, cards: [...s.cards, newCard(id, front, back, Date.now())] }));
    setFront('');
    setBack('');
    onToast('Card added · due now');
  };

  const draftFromNotes = async () => {
    if (notes.trim().length < 20) return;
    const text = await atlas.ask(cardsPrompt(notes));
    if (text === null) return;
    const parsed = parseCardDrafts(text);
    if (!parsed.length) { onToast('Atlas answered, but not as cards. Try shorter notes.'); return; }
    setDrafts(parsed.map((d) => ({ ...d, id: uid('draft') })));
  };

  const keepDrafts = (ids: string[]) => {
    const id = ensureDeck();
    if (!id) { onToast('Pick or name a deck for the cards first'); return; }
    const at = Date.now();
    const keep = drafts.filter((d) => ids.includes(d.id));
    updateSchool((s) => ({ ...s, cards: [...s.cards, ...keep.map((d) => newCard(id, d.front, d.back, at))] }));
    setDrafts((list) => list.filter((d) => !ids.includes(d.id)));
    onToast(`${keep.length} ${keep.length === 1 ? 'card' : 'cards'} added`);
  };

  const removeCard = (card: Card) => {
    updateSchool((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== card.id) }));
    onToast('Card deleted', () => updateSchool((s) => ({ ...s, cards: [...s.cards, card] })));
  };

  const removeDeck = (d: Deck) => {
    const cards = school.cards.filter((c) => c.deckId === d.id);
    updateSchool((s) => ({ ...s, decks: s.decks.filter((x) => x.id !== d.id), cards: s.cards.filter((c) => c.deckId !== d.id) }));
    onToast(`Deleted ${d.name} and its ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`, () => updateSchool((s) => ({ ...s, decks: [...s.decks, d], cards: [...s.cards, ...cards] })));
  };

  const browse = useMemo(() => school.cards.filter((c) => !deck || c.deckId === deck.id).sort((a, b) => a.due - b.due), [school.cards, deck]);
  const day0 = startOfDay(now);
  const total = reviewed + allDue.length;
  const canAdd = !!front.trim() && !!back.trim() && (target !== NEW_DECK || !!newDeckName.trim());

  return (
    <div className="b-sc-two">
      <section className="b-sc-deckpane" aria-label="Review">
        <div className="b-sc-decks" role="tablist" aria-label="Decks">
          <button type="button" role="tab" aria-selected={!deck} className={`b-sc-deck${!deck ? ' on' : ''}`} onClick={() => setDeckId(null)}>
            All decks<span>{allDue.length}</span>
          </button>
          {school.decks.map((d) => (
            <button type="button" role="tab" key={d.id} aria-selected={deck?.id === d.id} className={`b-sc-deck${deck?.id === d.id ? ' on' : ''}`} onClick={() => setDeckId(d.id)}>
              <i style={{ background: d.colour }} />{d.name}<span>{dueCards(school.cards, now, d.id).length}</span>
            </button>
          ))}
        </div>

        {current ? (
          <button type="button" className={`b-sc-flash${flipped ? ' flipped' : ''}`} aria-label={flipped ? 'Answer. Flip back' : 'Question. Flip to see the answer'} onClick={() => setFlipped((f) => !f)}>
            <span className="b-sc-flash-side">{flipped ? 'Answer' : 'Question'}{!deck ? ` · ${deckOf(current.deckId)?.name ?? ''}` : ''}</span>
            <span key={`${current.id}${flipped ? 'b' : 'f'}`} className="b-sc-flash-text">{flipped ? current.back : current.front}</span>
            <span className="b-sc-flash-hint">{flipped ? 'How well did you know it?' : 'Tap or press Space to flip'}</span>
          </button>
        ) : (
          <div className="b-sc-flash b-sc-flash--empty" role="status">
            <span className="b-sc-flash-side">{school.cards.length ? 'All caught up' : 'No cards yet'}</span>
            <span className="b-sc-flash-text">
              {!school.cards.length
                ? 'Write your first card, or let Atlas draft some from your notes.'
                : nextAt !== null
                  ? `Nothing due${deck ? ` in ${deck.name}` : ''}. The next card is back in ${formatInterval(nextAt - now)}.`
                  : `Nothing due${deck ? ` in ${deck.name}` : ''}.`}
            </span>
          </div>
        )}

        {current && flipped && preview ? (
          <div className="b-sc-grades">
            {GRADES.map((g, i) => (
              <button type="button" key={g.key} className={`b-sc-grade b-sc-grade--${g.tone}`} title={`${g.label} · ${i + 1}`} onClick={() => grade(g.key)}>
                <span>{g.label}</span><small>{preview[g.key]}</small>
              </button>
            ))}
          </div>
        ) : null}

        <div className="b-sc-progress">
          <span className="b-sc-bar"><span style={{ width: `${total ? Math.round((reviewed / total) * 100) : 0}%` }} /></span>
          <span className="b-num">{reviewed} reviewed today · {allDue.length} due</span>
        </div>
      </section>

      <section className="b-sc-side" aria-label="Your cards">
        <div className="b-sc-note b-sc-note--emphasis">
          <strong>You write these cards,</strong> or Atlas drafts them from notes you paste and you keep the ones you want. Each comes back just before you would forget it. Rate honestly: Again brings it back in a minute.
        </div>

        <div className="b-sc-card b-sc-forecast">
          <span className="b-sc-label">Next 7 days</span>
          <div className="b-sc-forecast-bars">
            {bars.map((n, i) => {
              const day = addDays(day0, i);
              return (
                <span key={day} className="b-sc-forecast-col" title={`${n} due ${i === 0 ? 'today' : weekdayShort(day)}`}>
                  <b className="b-num">{n || ''}</b>
                  <span className={i === 0 ? 'today' : ''} style={{ height: `${Math.round((n / barMax) * 64)}px` }} />
                  <small>{i === 0 ? 'Today' : weekdayShort(day)}</small>
                </span>
              );
            })}
          </div>
        </div>

        <div className="b-sc-card b-sc-form">
          <span className="b-sc-label">New cards go into</span>
          <select className="b-input b-sc-select" value={target} aria-label="Deck for new cards" onChange={(e) => setTarget(e.target.value)}>
            {school.decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            <option value={NEW_DECK}>A new deck…</option>
          </select>
          {target === NEW_DECK ? <input className="b-input" value={newDeckName} placeholder="Deck name, e.g. Maths: derivatives" aria-label="New deck name" onChange={(e) => setNewDeckName(e.target.value)} /> : null}
          <textarea className="b-input" value={front} placeholder="Question" aria-label="Question" onChange={(e) => setFront(e.target.value)} />
          <textarea className="b-input" value={back} placeholder="Answer" aria-label="Answer" onChange={(e) => setBack(e.target.value)} />
          <button type="button" className="b-btn b-btn--primary" disabled={!canAdd} onClick={addCard}>Add card</button>
        </div>

        <button type="button" className="b-sc-inkbtn" aria-expanded={notesOpen} onClick={() => setNotesOpen((o) => !o)}>
          {notesOpen ? 'Close notes' : 'Draft cards from my notes'}
        </button>
        {notesOpen ? (
          <div className="b-sc-card b-sc-form">
            <textarea className="b-input b-sc-notes" value={notes} placeholder="Paste your notes. Atlas writes question-and-answer cards from them, and nothing that is not in them." aria-label="Notes" onChange={(e) => setNotes(e.target.value)} />
            <div className="b-sc-row-actions">
              <button type="button" className="b-btn b-btn--tinted" disabled={atlas.busy || notes.trim().length < 20} onClick={() => void draftFromNotes()}>{atlas.busy ? 'Atlas is reading…' : 'Ask Atlas for cards'}</button>
              {atlas.busy ? <button type="button" className="b-btn b-btn--ghost" onClick={atlas.cancel}>Stop</button> : null}
            </div>
            {atlas.error ? <p className="b-sc-err" role="alert">{atlas.error}</p> : null}
            {drafts.length ? (
              <div className="b-sc-drafts">
                <div className="b-sc-row-actions"><span className="b-sc-label">{drafts.length} drafts · nothing is added until you keep it</span><button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => keepDrafts(drafts.map((d) => d.id))}>Keep all</button></div>
                {drafts.map((d) => (
                  <div key={d.id} className="b-sc-draft">
                    <span><b>{d.front}</b><span>{d.back}</span></span>
                    <span className="b-sc-row-actions">
                      <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => keepDrafts([d.id])}>Keep</button>
                      <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setDrafts((list) => list.filter((x) => x.id !== d.id))}>Discard</button>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {school.cards.length || school.decks.length ? (
          <details className="b-sc-card b-sc-browse">
            <summary>{deck ? `${deck.name} · ${browse.length} ${browse.length === 1 ? 'card' : 'cards'}` : `All cards · ${browse.length}`}</summary>
            {browse.map((c) => (
              <div key={c.id} className="b-sc-browse-row">
                <i style={{ background: deckOf(c.deckId)?.colour }} />
                <span><b>{c.front}</b><span>{c.due <= now ? 'Due now' : `In ${formatInterval(c.due - now)}`}{c.lapses ? ` · forgotten ${c.lapses}×` : ''}</span></span>
                <button type="button" className="b-sc-x" aria-label={`Delete card: ${c.front}`} onClick={() => removeCard(c)}>×</button>
              </div>
            ))}
            {deck ? <button type="button" className="b-btn b-btn--danger b-btn--row" onClick={() => removeDeck(deck)}>Delete this deck</button> : null}
          </details>
        ) : null}
      </section>
    </div>
  );
}
