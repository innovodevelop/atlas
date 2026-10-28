/**
 * Exams on the School screen (`Atlas School Beta.dc.html`, "Eksamen") — pure
 * and tested here (betaSchoolExams.test.ts).
 *
 * Two sources and nothing invented: Lectio events whose title marks an exam
 * (eksamen, prøve, terminsprøve, årsprøve, mundtlig), read from the schedule
 * the student connected, and exams the student adds. Each counts down in
 * calendar days. Revision readiness is measured, not guessed: the student
 * links decks to an exam as its topics, and a topic is as ready as the share
 * of its cards the scheduler already trusts for a week or more (an interval
 * of 7 days or longer).
 */

import {
  DAY, spreadSessions, startOfDay,
  type Card, type Deadline, type Deck, type ExamKind, type OwnExam, type Session,
} from './betaSchool';
import type { Lesson } from './betaSchoolIcs';

export interface Exam {
  /** `lectio:<lesson id>` or `own:<id>` — what decks are linked under. */
  key: string;
  title: string;
  kind: ExamKind;
  at: number;
  source: 'lectio' | 'own';
  room: string;
  ownId: string | null;
}

// A word start, then one of the words a Danish school writes on an exam. Not
// \b: JavaScript's word boundary does not know æ, ø and å.
const EXAM_WORDS = /(^|[^a-zæøå])(eksamen|terminsprøve|årsprøve|prøve|mundtlig)/i;

export function isExamTitle(title: string): boolean {
  return EXAM_WORDS.test(title);
}

export function examKind(title: string): ExamKind {
  if (/mundtlig|\boral\b/i.test(title)) return 'oral';
  if (/skriftlig|\bwritten\b/i.test(title)) return 'written';
  return 'exam';
}

export const EXAM_KINDS: readonly { key: ExamKind; label: string }[] = [
  { key: 'written', label: 'Written' },
  { key: 'oral', label: 'Oral' },
  { key: 'exam', label: 'Exam' },
];

/**
 * Exams in the Lectio schedule from today on. A five-hour written exam is
 * several modules in Lectio; the same title on the same day is one exam,
 * starting with its first module.
 */
export function lectioExams(lessons: readonly Lesson[], now: number): Exam[] {
  const from = startOfDay(now);
  const seen = new Set<string>();
  const out: Exam[] = [];
  for (const l of [...lessons].sort((a, b) => a.start - b.start)) {
    if (l.state === 'cancelled' || l.end < from || !isExamTitle(l.raw || l.title)) continue;
    const day = `${l.title.trim().toLowerCase()}|${startOfDay(l.start)}`;
    if (seen.has(day)) continue;
    seen.add(day);
    out.push({ key: `lectio:${l.id}`, title: l.title, kind: examKind(l.raw || l.title), at: l.start, source: 'lectio', room: l.room, ownId: null });
  }
  return out;
}

/** Lectio's exams and the student's own, soonest first; exams before today are left out. */
export function allExams(lessons: readonly Lesson[], own: readonly OwnExam[], now: number): Exam[] {
  const from = startOfDay(now);
  const mine = own
    .filter((e) => e.at >= from)
    .map((e): Exam => ({ key: `own:${e.id}`, title: e.title, kind: e.kind, at: e.at, source: 'own', room: '', ownId: e.id }));
  return [...lectioExams(lessons, now), ...mine].sort((a, b) => a.at - b.at);
}

/** Whole calendar days from today to the exam's day; 0 on the day itself. */
export function daysUntil(at: number, now: number): number {
  return Math.max(0, Math.round((startOfDay(at) - startOfDay(now)) / DAY));
}

/** A card counts as revised once the scheduler would not show it again for a week. */
export const READY_INTERVAL = 7;

export interface Topic {
  deckId: string;
  name: string;
  colour: string;
  total: number;
  ready: number;
  /** Ready over total, 0–1; null for a deck with no cards yet. */
  share: number | null;
}

export function deckReadiness(cards: readonly Card[], deckId: string): { total: number; ready: number; share: number | null } {
  const mine = cards.filter((c) => c.deckId === deckId);
  const ready = mine.filter((c) => c.interval >= READY_INTERVAL).length;
  return { total: mine.length, ready, share: mine.length ? ready / mine.length : null };
}

/** The topics linked to an exam, in the order they were linked; decks since deleted drop out. */
export function examTopics(key: string, examDecks: Readonly<Record<string, string[]>>, decks: readonly Deck[], cards: readonly Card[]): Topic[] {
  return (examDecks[key] ?? []).flatMap((id) => {
    const deck = decks.find((d) => d.id === id);
    return deck ? [{ deckId: id, name: deck.name, colour: deck.colour, ...deckReadiness(cards, id) }] : [];
  });
}

/** All the exam's cards together: the one number for "how ready am I". */
export function examReadiness(topics: readonly Topic[]): number | null {
  const total = topics.reduce((a, t) => a + t.total, 0);
  return total ? topics.reduce((a, t) => a + t.ready, 0) / total : null;
}

/**
 * Revision sessions before an exam, spread the way Study plan spreads them
 * before a deadline, each one named for a topic, weakest first. Proposed, not
 * saved: the screen adds them with an Undo.
 */
export function revisionPlan(exam: Exam, topics: readonly Topic[], sessions: readonly Session[], now: number, count = 3): Session[] {
  const target: Deadline = { id: exam.key, subjectId: null, title: `Revise for ${exam.title}`, due: exam.at, done: false };
  const proposed = spreadSessions(target, sessions, now, { count });
  const order = [...topics].sort((a, b) => (a.share ?? 0) - (b.share ?? 0));
  return proposed.map((s, i) => ({
    ...s,
    deadlineId: null,
    title: order.length ? `Revise ${order[i % order.length].name} · ${exam.title}` : s.title,
  }));
}
