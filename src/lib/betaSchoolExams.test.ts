import { describe, expect, test } from 'bun:test';
import {
  allExams, daysUntil, deckReadiness, examKind, examReadiness, examTopics, isExamTitle, lectioExams, revisionPlan,
} from './betaSchoolExams';
import { newCard, type Card, type Deck } from './betaSchool';
import type { Lesson } from './betaSchoolIcs';

// Wednesday 28 October 2026, 12:00 local.
const NOW = new Date(2026, 9, 28, 12, 0, 0, 0).getTime();
const on = (mo: number, d: number, h: number) => new Date(2026, mo, d, h, 0, 0, 0).getTime();
const lesson = (id: string, title: string, start: number, extra: Partial<Lesson> = {}): Lesson => ({
  id, title, room: 'A1', teacher: '', start, end: start + 3600_000, allDay: false, state: 'normal', note: '', raw: title, ...extra,
});

describe('which events are exams', () => {
  test('the words a Danish school writes, at a word start', () => {
    expect(isExamTitle('Terminsprøve i matematik')).toBe(true);
    expect(isExamTitle('3b MA prøve')).toBe(true);
    expect(isExamTitle('Mundtlig eksamen, dansk')).toBe(true);
    expect(isExamTitle('Årsprøve fysik')).toBe(true);
    expect(isExamTitle('Eksamensforberedelse')).toBe(true);
    expect(isExamTitle('Vi afprøver forsøget')).toBe(false);
    expect(isExamTitle('3b MA')).toBe(false);
  });

  test('oral, written or just an exam', () => {
    expect(examKind('Mundtlig eksamen')).toBe('oral');
    expect(examKind('Skriftlig prøve')).toBe('written');
    expect(examKind('Terminsprøve')).toBe('exam');
  });

  test('one exam per title per day, cancelled and past ones left out', () => {
    const lessons = [
      lesson('a', 'Skriftlig terminsprøve MA', on(10, 12, 8)),
      lesson('b', 'Skriftlig terminsprøve MA', on(10, 12, 10)),
      lesson('c', 'Prøve FY', on(10, 13, 8), { state: 'cancelled' }),
      lesson('d', 'Prøve KE', on(9, 1, 8)),
      lesson('e', '3b DA', on(10, 14, 8)),
    ];
    const exams = lectioExams(lessons, NOW);
    expect(exams.map((e) => [e.key, e.kind, e.at])).toEqual([['lectio:a', 'written', on(10, 12, 8)]]);
    const all = allExams(lessons, [{ id: 'x', title: 'Dansk A', kind: 'oral', at: on(10, 2, 9) }, { id: 'old', title: 'Old', kind: 'exam', at: on(9, 1, 9) }], NOW);
    expect(all.map((e) => e.key)).toEqual(['own:x', 'lectio:a']);
  });

  test('countdowns are calendar days', () => {
    expect(daysUntil(on(9, 28, 23), NOW)).toBe(0);
    expect(daysUntil(on(9, 29, 8), NOW)).toBe(1);
    expect(daysUntil(on(10, 12, 8), NOW)).toBe(15);
  });
});

describe('revision readiness', () => {
  const decks: Deck[] = [{ id: 'd1', name: 'Derivatives', colour: '#000' }, { id: 'd2', name: 'Integrals', colour: '#111' }, { id: 'd3', name: 'Empty', colour: '#222' }];
  const card = (id: string, deckId: string, interval: number): Card => ({ ...newCard(deckId, 'q', 'a', NOW, id), interval });
  const cards = [card('1', 'd1', 7), card('2', 'd1', 21), card('3', 'd1', 3), card('4', 'd1', 0), card('5', 'd2', 1)];

  test('a topic is the share of its cards at an interval of 7 days or more', () => {
    expect(deckReadiness(cards, 'd1')).toEqual({ total: 4, ready: 2, share: 0.5 });
    expect(deckReadiness(cards, 'd3')).toEqual({ total: 0, ready: 0, share: null });
  });

  test('linked decks are the exam\'s topics; a deleted deck drops out', () => {
    const topics = examTopics('own:x', { 'own:x': ['d2', 'd1', 'gone', 'd3'] }, decks, cards);
    expect(topics.map((t) => [t.name, t.share])).toEqual([['Integrals', 0], ['Derivatives', 0.5], ['Empty', null]]);
    expect(examReadiness(topics)).toBe(2 / 5);
    expect(examReadiness([])).toBeNull();
  });

  test('revision sessions before the exam, weakest topic first', () => {
    const exam = allExams([], [{ id: 'x', title: 'Maths A', kind: 'written', at: on(10, 5, 9) }], NOW)[0];
    const topics = examTopics('own:x', { 'own:x': ['d1', 'd2'] }, decks, cards);
    const plan = revisionPlan(exam, topics, [], NOW, 3);
    expect(plan).toHaveLength(3);
    expect(plan.map((s) => s.title)).toEqual(['Revise Integrals · Maths A', 'Revise Derivatives · Maths A', 'Revise Integrals · Maths A']);
    expect(plan.every((s) => s.start > NOW && s.start < exam.at && s.deadlineId === null)).toBe(true);
  });
});
