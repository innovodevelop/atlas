import { describe, expect, test } from 'bun:test';
import {
  DAY, EMPTY_SCHOOL, FOCUS_SECONDS, FRESH_FOCUS, HOUR, MIN, MIN_EASE, START_EASE,
  addDays, cardsPrompt, cleanRewrite, clock, deadlineProgress, dueCards, dueIn, dueLabel,
  evaluateSheet, focusLeft, forecast, formatCell, formatInterval, fromInputs, gradePreview,
  inRanges, isoWeek, lengthState, literal, moveRef, newCard, nextColour,
  nextDueAt, nextHintLevel, parseCardDrafts, parseNotes, parseSchool, pauseFocus, rangesIn,
  rewritePrompt, schedule, sheetPrompt, sheetText, spreadSessions, startFocus, startOfDay,
  todayRibbon, tutorPrompt, tutorTitle, upcomingDeadlines, weekStart, wordCount,
  type Card, type Deadline, type Session, type TutorTurn,
} from './betaSchool';

// Wednesday 28 October 2026, 12:00 local — ISO week 44.
const NOW = new Date(2026, 9, 28, 12, 0, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0, 0).getTime();

describe('time', () => {
  test('weeks start on Monday and are numbered the ISO way', () => {
    expect(weekStart(NOW)).toBe(at(26, 0));
    expect(isoWeek(NOW)).toBe(44);
    expect(isoWeek(new Date(2026, 0, 1).getTime())).toBe(1);
  });
  test('date and time inputs round-trip', () => {
    expect(fromInputs('2026-10-30', '23:59')).toBe(at(30, 23, 59));
    expect(fromInputs('nope', '10:00')).toBeNull();
  });
  test('due words count calendar days', () => {
    expect(dueIn(at(28, 23), NOW)).toBe('today');
    expect(dueIn(at(29, 8), NOW)).toBe('tomorrow');
    expect(dueIn(at(31, 12), NOW)).toBe('in 3 days');
    expect(dueIn(at(27, 12), NOW)).toBe('overdue');
    expect(dueLabel(at(28, 23, 59), NOW)).toBe('Today · 23:59');
    expect(dueLabel(at(31, 12), NOW)).toBe('Sat 31 Oct · 12:00');
  });
});

describe('the card scheduler', () => {
  const fresh = (): Card => newCard('d1', ' Front ', ' Back ', NOW, 'c1');

  test('a new card is due now, trimmed, at the starting ease', () => {
    const c = fresh();
    expect(c).toMatchObject({ front: 'Front', back: 'Back', due: NOW, interval: 0, ease: START_EASE });
  });
  test('learning: Again a minute, Hard ten, Good a day, Easy four days', () => {
    expect(gradePreview(fresh(), NOW)).toEqual({ again: '1 min', hard: '10 min', good: '1 day', easy: '4 days' });
    expect(schedule(fresh(), 'good', NOW)).toMatchObject({ interval: 1, due: NOW + DAY, reps: 1 });
    expect(schedule(fresh(), 'easy', NOW).ease).toBeCloseTo(START_EASE + 0.15);
  });
  test('review: Good grows by the ease, Hard less, Easy more', () => {
    const c: Card = { ...fresh(), interval: 4, ease: 2.5, reps: 3 };
    const hard = schedule(c, 'hard', NOW).interval;
    const good = schedule(c, 'good', NOW).interval;
    const easy = schedule(c, 'easy', NOW).interval;
    expect(good).toBe(10);
    expect(hard).toBeLessThan(good);
    expect(easy).toBeGreaterThan(good);
    expect(schedule(c, 'good', NOW).due).toBe(NOW + 10 * DAY);
  });
  test('Again is a lapse: back to learning, lower ease, floored', () => {
    const c: Card = { ...fresh(), interval: 12, ease: 1.35, reps: 6 };
    const r = schedule(c, 'again', NOW);
    expect(r).toMatchObject({ interval: 0, lapses: 1, due: NOW + MIN });
    expect(r.ease).toBe(MIN_EASE);
  });
  test('interval labels', () => {
    expect(formatInterval(30_000)).toBe('1 min');
    expect(formatInterval(3 * HOUR)).toBe('3 h');
    expect(formatInterval(DAY)).toBe('1 day');
    expect(formatInterval(60 * DAY)).toBe('2 mo');
    expect(formatInterval(438 * DAY)).toBe('1.2 yr');
  });
  test('due lists, the next due time and the seven-day forecast', () => {
    const cards: Card[] = [
      { ...fresh(), id: 'a', due: NOW - HOUR },
      { ...fresh(), id: 'b', due: NOW - 2 * HOUR, deckId: 'd2' },
      { ...fresh(), id: 'c', due: NOW + 3 * HOUR },
      { ...fresh(), id: 'd', due: addDays(NOW, 2) },
      { ...fresh(), id: 'e', due: addDays(NOW, 30) },
    ];
    expect(dueCards(cards, NOW).map((c) => c.id)).toEqual(['b', 'a']);
    expect(dueCards(cards, NOW, 'd1').map((c) => c.id)).toEqual(['a']);
    expect(nextDueAt(cards, NOW)).toBe(NOW + 3 * HOUR);
    expect(nextDueAt(cards, NOW, 'd2')).toBeNull();
    expect(forecast(cards, NOW)).toEqual([3, 0, 1, 0, 0, 0, 0]);
  });
});

describe('cards drafted from notes', () => {
  test('the prompt carries the notes and the format', () => {
    const p = cardsPrompt('Photosynthesis makes glucose.', 5);
    expect(p).toContain('at most 5 cards');
    expect(p).toContain('Q: the question');
    expect(p.endsWith('Photosynthesis makes glucose.')).toBe(true);
  });
  test('reads pairs through bullets, bold and numbering, in Danish too', () => {
    const text = 'Here you go:\n\n1. **Q:** What is the product rule?\n   **A:** (uv)′ = u′v + uv′\n\n- Spørgsmål: Hvornår kom Danmark i NATO?\n- Svar: 1949\n\nQ: orphan question\n';
    expect(parseCardDrafts(text)).toEqual([
      { front: 'What is the product rule?', back: '(uv)′ = u′v + uv′' },
      { front: 'Hvornår kom Danmark i NATO?', back: '1949' },
    ]);
  });
});

describe('the tutor', () => {
  const turns: TutorTurn[] = [
    { role: 'tutor', text: 'Which rule fits a product?', at: 1 },
    { role: 'student', text: 'The product rule?', at: 2 },
  ];
  test('forbids the answer and carries the problem and the conversation', () => {
    const p = tutorPrompt('Find f′(x) for f(x) = x² · ln(x).', turns, { kind: 'reply', text: 'u = x², v = ln x' });
    expect(p).toContain('Never give the final answer');
    expect(p).toContain('Find f′(x) for f(x) = x² · ln(x).');
    expect(p).toContain('Student: The product rule?');
    expect(p).toContain('The student just wrote:\nu = x², v = ln x');
  });
  test('hints climb the ladder, one step at a time', () => {
    expect(tutorPrompt('p', [], { kind: 'hint', level: 1 })).toContain('hint 1 of 3');
    expect(tutorPrompt('p', [], { kind: 'hint', level: 3 })).toContain("student's own numbers");
    expect(nextHintLevel({ hints: 0 })).toBe(1);
    expect(nextHintLevel({ hints: 2 })).toBe(3);
    expect(nextHintLevel({ hints: 3 })).toBeNull();
  });
  test('a long session sends only the recent turns', () => {
    const many: TutorTurn[] = Array.from({ length: 30 }, (_, i) => ({ role: 'student', text: `turn ${i}`, at: i }));
    const p = tutorPrompt('p', many, { kind: 'start' }, 5);
    expect(p).toContain('(earlier turns omitted)');
    expect(p).toContain('turn 29');
    expect(p).not.toContain('turn 24');
  });
  test('titles are the first line, short', () => {
    expect(tutorTitle('Opgave 3\nmore')).toBe('Opgave 3');
    expect(tutorTitle('x'.repeat(100)).length).toBeLessThanOrEqual(64);
    expect(tutorTitle('  ')).toBe('Untitled problem');
  });
});

describe('the study plan', () => {
  const deadline: Deadline = { id: 'dl', subjectId: 's1', title: 'Report', due: NOW, done: false };
  const due = { ...deadline, due: new Date(2026, 10, 2, 12, 0).getTime() }; // Mon 2 Nov, 12:00

  test('spreads sessions over the days before the deadline', () => {
    const s = spreadSessions(due, [], NOW, { count: 3 });
    expect(s).toHaveLength(3);
    const days = s.map((x) => new Date(x.start).getDate());
    expect(days).toEqual([29, 31, 1]);
    for (const x of s) {
      expect(new Date(x.start).getHours()).toBe(16);
      expect(x).toMatchObject({ deadlineId: 'dl', subjectId: 's1', minutes: 45, done: false });
    }
    expect(s[2].title).toBe('Report · 3 of 3');
  });
  test('moves past a taken slot, and gives up when the deadline is too close', () => {
    const busy: Session = { id: 'x', subjectId: null, deadlineId: null, title: 'Busy', start: at(29, 16), minutes: 60, done: false };
    const s = spreadSessions(due, [busy], NOW, { count: 1 });
    expect(new Date(s[0].start).getDate()).toBe(1);
    const all = spreadSessions(due, [busy], NOW, { count: 5 });
    expect(new Date(all[0].start).getHours()).toBe(18);
    expect(spreadSessions({ ...deadline, due: at(29, 10) }, [], NOW)).toEqual([]);
  });
  test('the ribbon fills the running session and slides to keep it in view', () => {
    const mk = (id: string, h: number, done = false): Session => ({ id, subjectId: null, deadlineId: null, title: id, start: at(28, h), minutes: 60, done });
    const items = todayRibbon([mk('a', 8), mk('b', 9, true), mk('c', 11, false), mk('d', 15), mk('e', 17), mk('f', 19)], at(28, 11, 30), 4);
    expect(items.map((i) => i.session.id)).toEqual(['c', 'd', 'e', 'f']);
    expect(items[0]).toMatchObject({ state: 'now', minutesLeft: 30 });
    expect(items[0].fill).toBeCloseTo(0.5);
    expect(items[1].state).toBe('next');
  });
  test('deadlines, progress and colours', () => {
    const list: Deadline[] = [
      { ...deadline, id: 'late', due: NOW - DAY },
      { ...deadline, id: 'soon', due: NOW + DAY },
      { ...deadline, id: 'done', due: NOW, done: true },
    ];
    expect(upcomingDeadlines(list).map((d) => d.id)).toEqual(['late', 'soon']);
    const sessions: Session[] = [
      { id: '1', subjectId: null, deadlineId: 'soon', title: '', start: NOW, minutes: 30, done: true },
      { id: '2', subjectId: null, deadlineId: 'soon', title: '', start: NOW, minutes: 30, done: false },
    ];
    expect(deadlineProgress({ id: 'soon' }, sessions)).toEqual({ done: 1, total: 2 });
    expect(nextColour([{ id: 'a', name: 'A', colour: '#3461f2' }])).toBe('#0a7a53');
    expect(startOfDay(NOW)).toBe(at(28, 0));
  });
});

describe('the focus timer', () => {
  test('runs from an end time, pauses with what is left, and starts over when spent', () => {
    expect(focusLeft(FRESH_FOCUS, NOW)).toBe(FOCUS_SECONDS);
    const running = startFocus(FRESH_FOCUS, NOW);
    expect(focusLeft(running, NOW + 60_000)).toBe(FOCUS_SECONDS - 60);
    const paused = pauseFocus(running, NOW + 90_000);
    expect(paused).toEqual({ endsAt: null, left: FOCUS_SECONDS - 90 });
    expect(focusLeft(paused, NOW + DAY)).toBe(FOCUS_SECONDS - 90);
    const spent = { endsAt: NOW - 1000, left: 10 };
    expect(focusLeft(spent, NOW)).toBe(0);
    expect(startFocus(spent, NOW).endsAt).toBe(NOW + FOCUS_SECONDS * 1000);
    expect(clock(FOCUS_SECONDS)).toBe('25:00');
    expect(clock(245)).toBe('4:05');
  });
});

describe('writing', () => {
  test('counts words and reads the target range', () => {
    expect(wordCount('  one two\nthree  ')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(lengthState(500, 900, 1200)).toBe('under');
    expect(lengthState(1000, 900, 1200)).toBe('within');
    expect(lengthState(1300, 900, 1200)).toBe('over');
    expect(lengthState(10, null, null)).toBe('none');
  });
  test('the rewrite prompt says what it may not do', () => {
    expect(rewritePrompt('My text.', 'formal')).toContain('more formal');
    expect(rewritePrompt('My text.', 'shorter').endsWith('My text.')).toBe(true);
  });
  test('cleans what models wrap around a rewrite', () => {
    expect(cleanRewrite('Here is the rewritten passage:\n"Short and clear."')).toBe('Short and clear.');
    expect(cleanRewrite('```\nPlain.\n```')).toBe('Plain.');
    expect(cleanRewrite('Already clean.')).toBe('Already clean.');
  });
  test('margin notes from bullets, or else from questions', () => {
    expect(parseNotes('- What is your claim?\n- Which text says this?\n- Why now?\n- Fourth')).toEqual(['What is your claim?', 'Which text says this?', 'Why now?']);
    expect(parseNotes('Good start. What is your question? Where is the source?')).toEqual(['What is your question?', 'Where is the source?']);
  });
});

describe('the spreadsheet', () => {
  test('arithmetic with precedence, brackets, powers and references', () => {
    const v = evaluateSheet({ A1: '2', A2: '3,5', A3: '=A1+A2*2', A4: '=(A1+A2)*2', A5: '=-A1^2', A6: '=2^3^2', B1: 'Text', B2: '' });
    expect(v.A2).toBe(3.5);
    expect(v.A3).toBe(9);
    expect(v.A4).toBe(11);
    expect(v.A5).toBe(-4);
    expect(v.A6).toBe(512);
    expect(v.B1).toBe('Text');
    expect('B2' in v).toBe(false);
  });
  test('functions over ranges skip text and empties', () => {
    const v = evaluateSheet({
      A1: 'Range', A2: '3.42', A3: '3.88', A4: '', A5: '3.97',
      B1: '=SUM(A1:A5)', B2: '=AVERAGE(A2:A5)', B3: '=MIN(A2:A5; 1)', B4: '=MAX(A2:A5)', B5: '=COUNT(A1:A5)',
      B6: '=ROUND(B2, 2)', B7: '=SQRT(16)+ABS(-1)', B8: '=ROUND(COS(RADIANS(60)), 3)', B9: '=POWER(2, 10)', B10: '=ROUND(PI(), 2)',
    });
    expect(v.B1).toBeCloseTo(11.27);
    expect(v.B2).toBeCloseTo(3.7567, 3);
    expect(v.B3).toBe(1);
    expect(v.B4).toBe(3.97);
    expect(v.B5).toBe(3);
    expect(v.B6).toBe(3.76);
    expect(v.B7).toBe(5);
    expect(v.B8).toBe(0.5);
    expect(v.B9).toBe(1024);
    expect(v.B10).toBe(3.14);
  });
  test('errors read as values and carry forward', () => {
    const v = evaluateSheet({
      A1: '=1/0', A2: '=A1+1', A3: '=A4', A4: '=A3', A5: '=G1', A6: '=FOO(1)', A7: '=B1*2', B1: 'word', A8: '=1+', A9: '=AVERAGE(C1:C3)', A10: '=SUM(A10:A11)',
      A11: '=alert(1)', A12: '=SQRT(-1)',
    });
    expect(v.A1).toBe('#DIV/0');
    expect(v.A2).toBe('#DIV/0');
    expect(v.A3).toBe('#CYCLE');
    expect(v.A4).toBe('#CYCLE');
    expect(v.A5).toBe('#REF');
    expect(v.A6).toBe('#NAME');
    expect(v.A7).toBe('#VALUE');
    expect(v.A8).toBe('#ERR');
    expect(v.A9).toBe('#DIV/0');
    expect(v.A10).toBe('#CYCLE');
    expect(v.A11).toBe('#NAME');
    expect(v.A12).toBe('#VALUE');
  });
  test('formatting, ranges for the highlight, and moving the selection', () => {
    expect(formatCell(3.756666)).toBe('3.7567');
    expect(formatCell(4)).toBe('4');
    expect(formatCell(undefined)).toBe('');
    expect(literal(' 12,5 ')).toBe(12.5);
    expect(rangesIn('=AVERAGE(B2:B6)+SUM(c1:c2)')).toEqual([{ from: 'B2', to: 'B6' }, { from: 'C1', to: 'C2' }]);
    expect(inRanges('B4', [{ from: 'B2', to: 'B6' }])).toBe(true);
    expect(inRanges('C4', [{ from: 'B2', to: 'B6' }])).toBe(false);
    expect(moveRef('A1', -1, -1)).toBe('A1');
    expect(moveRef('F12', 1, 1)).toBe('F12');
    expect(moveRef('B2', 1, 3)).toBe('C5');
  });
  test('what Atlas reads: the used block as CSV, then the formulas', () => {
    const cells = { A1: 'Angle', B1: 'Range, m', A2: '30', B2: '=A2/10' };
    const text = sheetText(cells, evaluateSheet(cells));
    expect(text).toBe(',A,B\n1,Angle,"Range, m"\n2,30,3\nFormulas:\nB2: =A2/10');
    expect(sheetText({}, {})).toBe('(the sheet is empty)');
    expect(sheetPrompt('explain', text, { ref: 'B2', raw: '=A2/10', value: '3' })).toContain('cell B2');
    expect(sheetPrompt('check', text, null)).toContain('never change their cells');
  });
});

describe('parseSchool', () => {
  test('garbage reads as empty', () => {
    expect(parseSchool(null)).toEqual(EMPTY_SCHOOL);
    expect(parseSchool('{not json')).toEqual(EMPTY_SCHOOL);
    expect(parseSchool('[1,2]')).toEqual(EMPTY_SCHOOL);
  });
  test('keeps what is well formed and drops the rest, item by item', () => {
    const s = parseSchool(JSON.stringify({
      decks: [{ id: 'd1', name: 'Maths', colour: '#3461f2' }, { id: 7 }],
      cards: [
        { id: 'c1', deckId: 'd1', front: 'Q', back: 'A', due: 5, interval: 2, ease: 0.5 },
        { id: 'c2', deckId: 'gone', front: 'Q', back: 'A', due: 5 },
        { id: 'c3', deckId: 'd1', front: 'Q', due: 5 },
      ],
      reviewLog: { '2026-10-28': 4, bad: 2, '2026-10-27': 'x' },
      sessions: [{ id: 's', title: 'Read', start: 1, minutes: 0 }, { id: 't', title: 'Read', start: 1, minutes: 30, deadlineId: 'dl' }],
      tutor: [{ id: 't1', problem: 'P', created: 1, hints: 9, turns: [{ role: 'tutor', text: 'Q?', at: 1 }, { role: 'evil', text: 'x', at: 2 }] }],
      sheet: { a1: '5', Z99: '1', B2: 3 },
      focus: { endsAt: 'soon', left: 99999 },
    }));
    expect(s.decks).toEqual([{ id: 'd1', name: 'Maths', colour: '#3461f2' }]);
    expect(s.cards.map((c) => c.id)).toEqual(['c1']);
    expect(s.cards[0]).toMatchObject({ ease: MIN_EASE, created: 5, reps: 0 });
    expect(s.reviewLog).toEqual({ '2026-10-28': 4 });
    expect(s.sessions.map((x) => x.id)).toEqual(['t']);
    expect(s.sessions[0]).toMatchObject({ deadlineId: 'dl', subjectId: null, done: false });
    expect(s.tutor[0].hints).toBe(3);
    expect(s.tutor[0].turns).toHaveLength(1);
    expect(s.sheet).toEqual({ A1: '5' });
    expect(s.focus).toEqual({ endsAt: null, left: FOCUS_SECONDS });
  });
  test('exams, preparations, what the tutor saw and anchored notes are read the same way', () => {
    const s = parseSchool(JSON.stringify({
      decks: [{ id: 'd1', name: 'Maths' }],
      exams: [{ id: 'e1', title: 'Maths A', kind: 'oral', at: 5 }, { id: 'e2', title: 'No date' }, { id: 'e3', title: 'Odd', kind: 'sung', at: 6 }],
      examDecks: { 'own:e1': ['d1', 'gone', 3], 'own:e9': ['gone'] },
      prepared: [{ id: 'moodle:10', title: 'H7', at: 1, due: 9, steps: [{ text: 'Read', done: true }, { done: true }], deadlineId: 'dl' }, { id: 'x', title: 'No time' }],
      seen: ['moodle:10', 5],
      handedIn: ['moodle:11'],
      understood: [{ day: '2026-10-28', threadId: 't1', at: 1, items: [{ text: 'Product rule', ok: true }, { ok: true }] }, { day: 'today', threadId: 't1', at: 1, items: [] }],
      docs: [{ id: 'doc', title: '', body: 'b', updated: 1, notes: [{ id: 'n1', text: 'Why?', anchor: 'Intro' }, { id: 'n2', text: 'Loose' }, { text: 'no id' }] }],
    }));
    expect(s.exams).toEqual([{ id: 'e1', title: 'Maths A', kind: 'oral', at: 5 }, { id: 'e3', title: 'Odd', kind: 'exam', at: 6 }]);
    expect(s.examDecks).toEqual({ 'own:e1': ['d1'] });
    expect(s.prepared).toEqual([{ id: 'moodle:10', title: 'H7', course: '', due: 9, steps: [{ text: 'Read', done: true }], deadlineId: 'dl', deckId: null, at: 1 }]);
    expect(s.seen).toEqual(['moodle:10']);
    expect(s.handedIn).toEqual(['moodle:11']);
    expect(s.understood).toEqual([{ day: '2026-10-28', threadId: 't1', at: 1, items: [{ text: 'Product rule', ok: true }] }]);
    expect(s.docs[0].notes).toEqual([{ id: 'n1', text: 'Why?', anchor: 'Intro' }, { id: 'n2', text: 'Loose', anchor: null }]);
  });
});
