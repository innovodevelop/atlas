/**
 * Store changes more than one School view makes: putting kept cards into the
 * deck named for where they came from, and finding or making the subject a
 * course becomes in the study plan. Each returns an undo for the page's toast.
 */
import { newCard, nextColour, uid, type SchoolState } from '@/lib/betaSchool';
import { updateSchool } from '@/lib/betaSchoolStore';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The deck called `name` (case aside), made when there is none. */
export function withDeck(s: SchoolState, name: string): [SchoolState, string, boolean] {
  const found = s.decks.find((d) => same(d.name, name));
  if (found) return [s, found.id, false];
  const id = uid('deck');
  return [{ ...s, decks: [...s.decks, { id, name: name.trim().slice(0, 120) || 'School', colour: nextColour(s.decks) }] }, id, true];
}

/** The subject called `name` (case aside), made when there is none. */
export function withSubject(s: SchoolState, name: string): [SchoolState, string, boolean] {
  const found = s.subjects.find((x) => same(x.name, name));
  if (found) return [s, found.id, false];
  const id = uid('subj');
  return [{ ...s, subjects: [...s.subjects, { id, name: name.trim().slice(0, 120), colour: nextColour(s.subjects) }] }, id, true];
}

/** Keeps card drafts in the deck named `deckName`. Returns the deck's id and an undo. */
export function keepCards(deckName: string, drafts: readonly { front: string; back: string }[]): { deckId: string; undo: () => void } {
  let deckId = '';
  let madeDeck = false;
  const at = Date.now();
  const cards = drafts.map((d) => newCard('', d.front, d.back, at));
  updateSchool((s) => {
    const [s2, id, made] = withDeck(s, deckName);
    deckId = id;
    madeDeck = made;
    return { ...s2, cards: [...s2.cards, ...cards.map((c) => ({ ...c, deckId: id }))] };
  });
  const ids = new Set(cards.map((c) => c.id));
  return {
    deckId,
    undo: () => updateSchool((s) => ({
      ...s,
      cards: s.cards.filter((c) => !ids.has(c.id)),
      decks: madeDeck && !s.cards.some((c) => c.deckId === deckId && !ids.has(c.id)) ? s.decks.filter((d) => d.id !== deckId) : s.decks,
    })),
  };
}
