import { describe, expect, test } from 'bun:test';
import {
  anchoredMarginPrompt, columnPrompt, columnTaken, dataRows, groupSteps, mergeUnderstood, nameSessions, newStudentTurns,
  nextEmptyColumn, parseAnchoredNotes, parseColumn, parseSteps, parseUnderstood, prepPrompt, previewColumn, stepProgress,
  understoodPrompt,
} from './betaSchoolAtlas';
import { spreadSessions, type Deadline, type TutorTurn } from './betaSchool';

const NOW = new Date(2026, 9, 28, 12, 0, 0, 0).getTime();
const at = (d: number, h: number) => new Date(2026, 9, d, h, 0, 0, 0).getTime();

describe('Prepared by Atlas', () => {
  test('the prompt lays out, never answers, and carries the brief', () => {
    const p = prepPrompt({ title: 'Hand-in 7', course: 'Maths A', due: at(30, 23), text: '  Solve 1–6.  ' }, NOW);
    expect(p).toContain('never do it');
    expect(p).toContain('Never answer a question from the assignment');
    expect(p).toContain('Assignment: Hand-in 7');
    expect(p).toContain('Course: Maths A');
    expect(p).toContain('Due: Fri 30 Oct · 23:00');
    expect(p.endsWith('Solve 1–6.')).toBe(true);
    expect(prepPrompt({ title: 'X', course: '', due: null, text: 't' }, NOW)).not.toContain('Course:');
  });

  test('steps from STEP lines, or from a list when the model forgot the tag', () => {
    expect(parseSteps('Sure!\nSTEP: Read chapter 4\n**Step 2:** Collect the data\n1. STEP: Write the method\nThanks')).toEqual(['Read chapter 4', 'Collect the data', 'Write the method']);
    expect(parseSteps('Here:\n- Read the brief\n- Outline\n2) Draft')).toEqual(['Read the brief', 'Outline', 'Draft']);
    expect(parseSteps('No list here.')).toEqual([]);
    expect(parseSteps(Array.from({ length: 12 }, (_, i) => `STEP: s${i}`).join('\n'))).toHaveLength(8);
  });

  test('steps are shared out over the sessions, in order', () => {
    expect(groupSteps(['a', 'b', 'c', 'd', 'e'], 3)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(groupSteps(['a', 'b'], 4)).toEqual([['a'], ['b']]);
    expect(groupSteps([], 3)).toEqual([]);
    const d: Deadline = { id: 'd', subjectId: null, title: 'Hand-in 7', due: at(31, 23), done: false };
    const sessions = nameSessions(spreadSessions(d, [], NOW, { count: 2 }), ['Read', 'Solve 1–3', 'Check'], 'Hand-in 7');
    expect(sessions.map((s) => s.title)).toEqual(['Hand-in 7: Read · Solve 1–3', 'Hand-in 7: Check']);
    expect(stepProgress([{ done: true }, { done: false }])).toEqual({ done: 1, total: 2 });
  });
});

describe('What you understood today', () => {
  const turns: TutorTurn[] = [
    { role: 'student', text: 'Is it the product rule?', at: at(28, 9) },
    { role: 'tutor', text: 'The answer is 2x·ln(x) + x', at: at(28, 9) },
    { role: 'student', text: 'So u = x² and v = ln x', at: at(28, 10) },
    { role: 'student', text: 'yesterday', at: at(27, 10) },
  ];

  test('only the student\'s own turns go in', () => {
    const p = understoodPrompt('Find f′(x) for x² · ln(x)', turns.filter((t) => t.role === 'student'));
    expect(p).toContain('- So u = x² and v = ln x');
    expect(p).not.toContain('2x·ln(x) + x');
    expect(p).toContain('Do not solve the problem');
  });

  test('new turns are today\'s student turns since the last summary', () => {
    const today = (t: number) => t >= at(28, 0);
    expect(newStudentTurns(turns, 0, today).map((t) => t.text)).toEqual(['Is it the product rule?', 'So u = x² and v = ln x']);
    expect(newStudentTurns(turns, at(28, 9), today).map((t) => t.text)).toEqual(['So u = x² and v = ln x']);
  });

  test('SHOWN and NOT YET lines, and the same thing said once', () => {
    expect(parseUnderstood('Here you go:\nSHOWN: The product rule\n- NOT YET: Why there are two terms\n**SHOWN:** Differentiating ln(x)\nrandom'))
      .toEqual([{ text: 'The product rule', ok: true }, { text: 'Why there are two terms', ok: false }, { text: 'Differentiating ln(x)', ok: true }]);
    expect(mergeUnderstood([{ items: [{ text: 'Product rule', ok: false }] }, { items: [{ text: 'product rule ', ok: true }, { text: 'Chain rule', ok: false }] }]))
      .toEqual([{ text: 'Product rule', ok: true }, { text: 'Chain rule', ok: false }]);
  });
});

describe('Suggest a column', () => {
  const sheet = { A1: 'Angle', B1: 'Range', A2: '30', B2: '3.42', A3: '40', B3: '3.88', D9: '' };

  test('the next empty column is the one after the last in use', () => {
    expect(nextEmptyColumn(sheet)).toBe(2);
    expect(nextEmptyColumn({})).toBe(0);
    expect(nextEmptyColumn({ F1: 'x' })).toBeNull();
    expect(dataRows(sheet)).toEqual([2, 3]);
  });

  test('the prompt names the column and the cells, and keeps to the parser\'s functions', () => {
    const p = columnPrompt('(sheet)', 2, [2, 3]);
    expect(p).toContain('The next empty column is C');
    expect(p).toContain('C2, C3');
    expect(p).toContain('RADIANS');
    expect(p).toContain('never change their cells');
  });

  test('only the target column, rows 2 and down, formulas only', () => {
    const d = parseColumn('Sure:\nHEADER: "Ratio"\nC2: =B2/A2\n`C3: =B3/A3`\nC1: =1\nA2: =999\nC13: =1\nD2: =1\nWHY: Range per degree.', 2);
    expect(d).toEqual({ col: 2, header: 'Ratio', cells: { C2: '=B2/A2', C3: '=B3/A3' }, why: 'Range per degree.' });
    expect(parseColumn('HEADER: =SUM(A1)\nC2: =1', 2)).toBeNull();
    expect(parseColumn('HEADER: x\nC2: 5', 2)).toBeNull();
  });

  test('the draft is evaluated over the sheet without touching it, and refuses once its cells are taken', () => {
    const d = parseColumn('HEADER: Ratio\nC2: =B2/A2\nC3: =B3/Z9', 2);
    expect(d).not.toBeNull();
    const { values, errors } = previewColumn(sheet, d!);
    expect(values.C2).toBeCloseTo(0.114, 3);
    expect(errors).toBe(1);
    expect(sheet).not.toHaveProperty('C2');
    expect(columnTaken(sheet, d!)).toBe(false);
    expect(columnTaken({ ...sheet, C3: 'mine' }, d!)).toBe(true);
  });
});

describe('Margin notes, anchored', () => {
  test('the prompt asks for the section number first', () => {
    expect(anchoredMarginPrompt('T', '[1] A\nx', 1)).toContain('- [2] the note');
  });

  test('section numbers are read and checked against the sections there are', () => {
    expect(parseAnchoredNotes('- [2] Where is your question?\n- [9] Out of range\n* No anchor here\nnot a bullet\n- [§1]: Cite it', 2, 5))
      .toEqual([{ text: 'Where is your question?', section: 2 }, { text: 'Out of range', section: null }, { text: 'No anchor here', section: null }, { text: 'Cite it', section: 1 }]);
  });

  test('the prompt says what it may not do, and an answer without a list keeps its questions', () => {
    expect(anchoredMarginPrompt('T', '[1] A\nx', 1)).toContain('Never rewrite their sentences');
    expect(parseAnchoredNotes('Good start. What is your claim? Where is the source?', 2))
      .toEqual([{ text: 'What is your claim?', section: null }, { text: 'Where is the source?', section: null }]);
  });
});
