/**
 * What Atlas drafts on the School screen, and how its answers are read back —
 * pure and tested here (betaSchoolAtlas.test.ts).
 *
 *   - Prepared by Atlas: an assignment broken into steps the student will do,
 *     with study sessions spread before the due date.
 *   - What you understood today: a summary of the student's own turns with
 *     the tutor.
 *   - Suggest a column: a header and formulas for the sheet's next empty
 *     column.
 *   - Margin notes anchored to the section they are about.
 *
 * Every one of these is a draft the student keeps or drops; nothing here
 * writes anything. And every prompt keeps the line School draws everywhere:
 * Atlas lays work out, explains and asks — it never does the work or writes
 * the answer.
 */

import {
  SHEET_COLS, SHEET_FUNCTIONS, SHEET_ROWS, dueLabel, evaluateSheet, isError, parseRef, refOf,
  type CellValue, type Session, type TutorTurn,
} from './betaSchool';

const clean = (line: string) => line.replace(/\*\*/g, '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();

// ── Prepared by Atlas ────────────────────────────────────────────────────────

export interface PrepInput { title: string; course: string; due: number | null; text: string }

/** The cap on assignment text sent for preparing: long enough for any brief, short enough to stay cheap. */
export const PREP_TEXT_MAX = 12_000;

export function prepPrompt(a: PrepInput, now: number): string {
  return [
    'You are Atlas, preparing a school assignment so a student can start on it. You lay the work out; you never do it.',
    'Break the assignment below into 3 to 8 steps the student will do themselves, in the order they would do them.',
    'Each step names one piece of the work (read, find, calculate, outline, write, check …) in a few words, in the assignment\'s own terms.',
    'Never answer a question from the assignment, never solve or draft any part of it, and never state a fact or result the student is meant to find.',
    'Write each step on its own line starting with "STEP: ". Nothing else.',
    'Write in the language the assignment is written in.',
    '',
    `Assignment: ${a.title.trim()}`,
    ...(a.course.trim() ? [`Course: ${a.course.trim()}`] : []),
    ...(a.due !== null ? [`Due: ${dueLabel(a.due, now)}`] : []),
    '',
    a.text.trim().slice(0, PREP_TEXT_MAX),
  ].join('\n');
}

/** The steps out of the answer: "STEP:" lines, or else its bullet or numbered lines. */
export function parseSteps(text: string, max = 8): string[] {
  const lines = text.split(/\r?\n/);
  const tagged = lines.map((l) => /^\s*(?:[-*•]|\d+[.)])?\s*(?:\*\*)?\s*(?:STEP|Step|Trin)\s*\d*\s*(?:\*\*)?\s*[:.]\s*(.+)$/.exec(l)?.[1]).filter((x): x is string => !!x);
  const picked = tagged.length ? tagged : lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l));
  return picked.map((l) => clean(l).replace(/\*\*/g, '').slice(0, 160)).filter(Boolean).slice(0, max);
}

/** Steps split into `n` runs in order, as evenly as they go — one run per study session. */
export function groupSteps(steps: readonly string[], n: number): string[][] {
  if (n <= 0 || !steps.length) return [];
  const k = Math.min(n, steps.length);
  const out: string[][] = [];
  let at = 0;
  for (let i = 0; i < k; i++) {
    const size = Math.floor(steps.length / k) + (i < steps.length % k ? 1 : 0);
    out.push(steps.slice(at, at + size));
    at += size;
  }
  return out;
}

/** Proposed sessions named for the steps they cover, so the plan reads as the work and not "1 of 3". */
export function nameSessions(sessions: readonly Session[], steps: readonly string[], title: string): Session[] {
  const groups = groupSteps(steps, sessions.length);
  return sessions.map((s, i) => {
    const g = groups[i];
    if (!g || !g.length) return s;
    const name = `${title}: ${g.join(' · ')}`;
    return { ...s, title: name.length > 140 ? `${name.slice(0, 139).trimEnd()}…` : name };
  });
}

/** A step list's progress, for the bar and "2 of 5 steps". */
export function stepProgress(steps: readonly { done: boolean }[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.done).length, total: steps.length };
}

// ── What you understood today ────────────────────────────────────────────────

/**
 * Only the student's own turns go in — the tutor's questions and hints are
 * left out on purpose, so the summary rests on what the student showed, not
 * on what they were told. The problem itself is there for context.
 */
export function understoodPrompt(problem: string, studentTurns: readonly Pick<TutorTurn, 'text'>[]): string {
  return [
    'You are Atlas. Below is a problem a student worked on, and the lines the student wrote while working on it. The tutor\'s turns are left out on purpose.',
    'From the student\'s lines only, say what they showed they understood, and what they have not shown yet.',
    'Judge only from what the student wrote. Do not solve the problem and do not give the answer.',
    'Write at most four lines, each one short (a concept or a skill, a few words), and nothing else:',
    'SHOWN: something the student showed they understood',
    'NOT YET: something they have not shown yet',
    'Write in the language the student writes in.',
    '',
    'The problem:',
    problem.trim().slice(0, 4000),
    '',
    'The student\'s lines:',
    ...studentTurns.slice(-20).map((t) => `- ${t.text.trim().slice(0, 800)}`),
  ].join('\n');
}

export function parseUnderstood(text: string, max = 4): { text: string; ok: boolean }[] {
  const out: { text: string; ok: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\*\*/g, '').trim();
    const shown = /^(?:[-*•]\s*)?(?:SHOWN|Shown|✓|✔|\+)\s*:?\s*(.+)$/.exec(line);
    const notYet = /^(?:[-*•]\s*)?(?:NOT YET|Not yet|·)\s*:?\s*(.+)$/.exec(line);
    if (notYet) out.push({ text: notYet[1].trim().slice(0, 120), ok: false });
    else if (shown) out.push({ text: shown[1].trim().slice(0, 120), ok: true });
  }
  return out.filter((x) => x.text).slice(0, max);
}

/** Student turns on the day `dayKey` names, after `since`: what a new summary would be about. */
export function newStudentTurns(turns: readonly TutorTurn[], since: number, isToday: (at: number) => boolean): TutorTurn[] {
  return turns.filter((t) => t.role === 'student' && t.at > since && isToday(t.at));
}

/** Today's items across problems, each said once; "shown" wins over "not yet" for the same thing. */
export function mergeUnderstood(entries: readonly { items: { text: string; ok: boolean }[] }[]): { text: string; ok: boolean }[] {
  const map = new Map<string, { text: string; ok: boolean }>();
  for (const e of entries) {
    for (const it of e.items) {
      const k = it.text.trim().toLowerCase();
      const had = map.get(k);
      if (!had) map.set(k, it);
      else if (it.ok && !had.ok) map.set(k, { ...had, ok: true });
    }
  }
  return [...map.values()];
}

// ── Suggest a column ─────────────────────────────────────────────────────────

/** The column after the last one in use, or null when the sheet is full to F. */
export function nextEmptyColumn(sheet: Readonly<Record<string, string>>): number | null {
  let last = -1;
  for (const [ref, raw] of Object.entries(sheet)) {
    const p = parseRef(ref);
    if (p && raw) last = Math.max(last, p.col);
  }
  return last + 1 < SHEET_COLS.length ? last + 1 : null;
}

/** The rows below the header that hold data, i.e. the rows a new column should fill. */
export function dataRows(sheet: Readonly<Record<string, string>>): number[] {
  const rows = new Set<number>();
  for (const [ref, raw] of Object.entries(sheet)) {
    const p = parseRef(ref);
    if (p && raw && p.row >= 2) rows.add(p.row);
  }
  return [...rows].sort((a, b) => a - b);
}

export function columnPrompt(sheetText: string, col: number, rows: readonly number[]): string {
  const c = SHEET_COLS[col];
  const targets = rows.length ? rows : [2];
  return [
    'You are Atlas, suggesting one new column for a spreadsheet a student built. You propose; the student decides whether to keep it, and you never change their cells.',
    `The next empty column is ${c}. Suggest a header for ${c}1 and one formula for each of these cells: ${targets.map((r) => `${c}${r}`).join(', ')}.`,
    'The column should compute something useful from the columns already there: a derived quantity, a difference, a ratio or a check.',
    `Formulas start with "=" and use cell references like A2, numbers, + - * / ^, brackets, and only these functions: ${SHEET_FUNCTIONS.join(', ')}. Ranges like B2:B6 work inside functions. Trigonometry is in radians; use RADIANS() to convert degrees.`,
    'Answer in exactly this shape and nothing else:',
    'HEADER: the header text',
    ...targets.slice(0, 2).map((r) => `${c}${r}: =formula`),
    ...(targets.length > 2 ? ['(one line per cell)'] : []),
    'WHY: one sentence on what the column shows',
    'Write the header and the sentence in the language of the sheet.',
    '',
    'The sheet:',
    sheetText,
  ].join('\n');
}

export interface ColumnDraft {
  col: number;
  header: string;
  /** Cell ref → formula, rows 2 and down in the target column only. */
  cells: Record<string, string>;
  why: string;
}

/**
 * The suggestion out of the answer, checked: only the target column, rows 2
 * to the sheet's last, formulas that start with "=", a header that is text.
 * Anything else in the answer is ignored, so Atlas cannot reach another cell.
 */
export function parseColumn(text: string, col: number): ColumnDraft | null {
  const c = SHEET_COLS[col];
  let header = '';
  let why = '';
  const cells: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\*\*/g, '').replace(/`/g, '').trim();
    const h = /^HEADER\s*:\s*(.+)$/i.exec(line);
    if (h) { header = h[1].trim().replace(/^["“]|["”]$/g, '').slice(0, 60); continue; }
    const w = /^WHY\s*:\s*(.+)$/i.exec(line);
    if (w) { why = w[1].trim().slice(0, 300); continue; }
    const f = /^([A-Z])(\d{1,2})\s*[:=]\s*(=.+)$/i.exec(line);
    if (!f || f[1].toUpperCase() !== c) continue;
    const row = Number(f[2]);
    if (row < 2 || row > SHEET_ROWS) continue;
    cells[refOf(col, row)] = f[3].trim().slice(0, 200);
  }
  if (!header || header.startsWith('=') || !Object.keys(cells).length) return null;
  return { col, header, cells, why };
}

/** The sheet with the draft laid over it, evaluated — the pale cells the grid shows. */
export function previewColumn(sheet: Readonly<Record<string, string>>, draft: ColumnDraft): { values: Record<string, CellValue>; errors: number } {
  const merged: Record<string, string> = { ...sheet, [refOf(draft.col, 1)]: draft.header, ...draft.cells };
  const values = evaluateSheet(merged);
  const errors = Object.keys(draft.cells).filter((r) => { const v = values[r]; return v !== undefined && isError(v); }).length;
  return { values, errors };
}

/** True when a cell the draft would write has been filled since it was drafted. */
export function columnTaken(sheet: Readonly<Record<string, string>>, draft: ColumnDraft): boolean {
  return [refOf(draft.col, 1), ...Object.keys(draft.cells)].some((r) => !!sheet[r]);
}

// ── Margin notes, anchored ───────────────────────────────────────────────────

export function anchoredMarginPrompt(title: string, sectionsText: string, count: number): string {
  return [
    "You are Atlas, reading a student's draft as a writing tutor.",
    'Leave at most three notes in the margin: questions or pointers that help them improve it themselves.',
    'Never rewrite their sentences and never suggest replacement text.',
    `The draft is split into ${count} numbered ${count === 1 ? 'section' : 'sections'}. Start each note with the number of the section it is about, in square brackets, like this:`,
    '- [2] the note',
    'Write each note on its own line. Nothing else.',
    'Write in the language the draft is written in.',
    '',
    `Title: ${title.trim() || '(untitled)'}`,
    '',
    sectionsText,
  ].join('\n');
}

/** Notes with their section numbers (1-based, or null when Atlas gave none or one out of range). */
export function parseAnchoredNotes(text: string, count: number, max = 3): { text: string; section: number | null }[] {
  const out: { text: string; section: number | null }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const body = m[1].replace(/\*\*/g, '').trim();
    const a = /^\[(?:§\s*)?(\d{1,2})\]\s*[:.-]?\s*(.+)$/.exec(body);
    const n = a ? Number(a[1]) : null;
    out.push({ text: (a ? a[2] : body).trim(), section: n !== null && n >= 1 && n <= count ? n : null });
  }
  return out.filter((x) => x.text).slice(0, max);
}
