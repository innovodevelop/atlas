/**
 * The Beta School screen's logic — the card scheduler, the tutor's prompt,
 * the study plan's arithmetic, the focus timer, the writing helpers, the
 * spreadsheet's formula engine and the defensive reader for what is stored —
 * pure and tested here (betaSchool.test.ts), rendered by BetaSchool.tsx and
 * src/components/atlas/school/*.
 *
 * What the school sends — Lectio's schedule, LearnIT's assignments,
 * materials, messages and grades — is read in betaSchoolIcs.ts and
 * betaSchoolMoodle.ts and cached beside this store, never inside it. What is
 * here is the student's own — cards they write (or let Atlas draft and then
 * keep), a plan they fill in, exams they add, what Atlas prepared and they
 * accepted, a sheet they type, documents they write — kept on this Mac by
 * betaSchoolStore.ts. Nothing here invents a lesson, a grade or an exam.
 */

// ── Time ─────────────────────────────────────────────────────────────────────

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A short random id. Collisions only matter inside one person's local store. */
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Local midnight of the day `ms` falls in. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar arithmetic through Date, so a daylight-saving change does not shift the clock time. */
export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** `YYYY-MM-DD` in local time — the key the review log is counted under. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Monday 00:00 of the week `ms` falls in (the Danish school week starts on Monday). */
export function weekStart(ms: number): number {
  const d = new Date(startOfDay(ms));
  const back = (d.getDay() + 6) % 7;
  return addDays(d.getTime(), -back);
}

/** ISO 8601 week number — what a Danish school calls "uge 44". */
export function isoWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / DAY - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Wed 29 Oct". */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function weekdayLong(ms: number): string {
  return WEEKDAYS_LONG[new Date(ms).getDay()];
}

export function weekdayShort(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()];
}

/** "Wednesday 29 October · week 44" — the hero's eyebrow date. */
export function longDate(ms: number): string {
  const d = new Date(ms);
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()];
  return `${WEEKDAYS_LONG[d.getDay()]} ${d.getDate()} ${month} · week ${isoWeek(ms)}`;
}

/** `YYYY-MM-DD` and `HH:MM` for date and time inputs, and back. */
export function toDateInput(ms: number): string { return dayKey(ms); }
export function toTimeInput(ms: number): string { return hhmm(ms); }
export function fromInputs(date: string, time: string): number | null {
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = (time || '00:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// ── Cards: an SM-2-style scheduler ──────────────────────────────────────────

export type Grade = 'again' | 'hard' | 'good' | 'easy';
export const GRADES: readonly { key: Grade; label: string; tone: 'red' | 'amber' | 'green' | 'blue' }[] = [
  { key: 'again', label: 'Again', tone: 'red' },
  { key: 'hard', label: 'Hard', tone: 'amber' },
  { key: 'good', label: 'Good', tone: 'green' },
  { key: 'easy', label: 'Easy', tone: 'blue' },
];

export interface Deck { id: string; name: string; colour: string }

export interface Card {
  id: string;
  deckId: string;
  front: string;
  back: string;
  created: number;
  /** When the card is next shown. A new card is due the moment it is written. */
  due: number;
  /** Days between reviews; 0 while the card is still being learned. */
  interval: number;
  /** SM-2's ease factor: how much the interval grows on "Good". */
  ease: number;
  reps: number;
  lapses: number;
}

export const START_EASE = 2.5;
export const MIN_EASE = 1.3;

export function newCard(deckId: string, front: string, back: string, now: number, id = uid('card')): Card {
  return { id, deckId, front: front.trim(), back: back.trim(), created: now, due: now, interval: 0, ease: START_EASE, reps: 0, lapses: 0 };
}

/**
 * One review. A card still being learned (interval 0) comes back in a minute
 * on Again, ten on Hard, and graduates to a day on Good or four on Easy — the
 * design's "1 min · 10 min · 1 day · 4 days". A card in review grows by its
 * ease on Good, a little on Hard, more on Easy; Again is a lapse that drops it
 * back to learning and lowers its ease, so a card you keep forgetting comes
 * round more often for good.
 */
export function schedule(card: Card, grade: Grade, now: number): Card {
  const reps = card.reps + 1;
  if (card.interval === 0) {
    switch (grade) {
      case 'again': return { ...card, reps, due: now + MIN };
      case 'hard': return { ...card, reps, due: now + 10 * MIN };
      case 'good': return { ...card, reps, interval: 1, due: now + DAY };
      case 'easy': return { ...card, reps, interval: 4, ease: card.ease + 0.15, due: now + 4 * DAY };
    }
  }
  switch (grade) {
    case 'again': return { ...card, reps, lapses: card.lapses + 1, interval: 0, ease: Math.max(MIN_EASE, card.ease - 0.2), due: now + MIN };
    case 'hard': {
      const interval = Math.max(1, Math.round(card.interval * 1.2));
      return { ...card, reps, interval, ease: Math.max(MIN_EASE, card.ease - 0.15), due: now + interval * DAY };
    }
    case 'good': {
      const interval = Math.max(card.interval + 1, Math.round(card.interval * card.ease));
      return { ...card, reps, interval, due: now + interval * DAY };
    }
    case 'easy': {
      const good = Math.max(card.interval + 1, Math.round(card.interval * card.ease));
      const interval = Math.max(good + 1, Math.round(card.interval * card.ease * 1.3));
      return { ...card, reps, interval, ease: card.ease + 0.15, due: now + interval * DAY };
    }
  }
}

/** "1 min", "10 min", "3 h", "1 day", "4 days", "2 mo", "1.2 yr" — the label under each grade. */
export function formatInterval(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  const days = Math.round(ms / DAY);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} yr`;
}

/** What each grade would do to this card, for the labels under the buttons. */
export function gradePreview(card: Card, now: number): Record<Grade, string> {
  const out = {} as Record<Grade, string>;
  for (const g of GRADES) out[g.key] = formatInterval(schedule(card, g.key, now).due - now);
  return out;
}

/** Cards due now, oldest first; `deckId` null means every deck. */
export function dueCards(cards: readonly Card[], now: number, deckId: string | null = null): Card[] {
  return cards.filter((c) => c.due <= now && (deckId === null || c.deckId === deckId)).sort((a, b) => a.due - b.due);
}

/** When the next card in the deck comes due, or null when it has none waiting. */
export function nextDueAt(cards: readonly Card[], now: number, deckId: string | null = null): number | null {
  let best: number | null = null;
  for (const c of cards) {
    if (c.due <= now || (deckId !== null && c.deckId !== deckId)) continue;
    if (best === null || c.due < best) best = c.due;
  }
  return best;
}

/** Cards due on each of the next `days` days; today's bar includes anything overdue. */
export function forecast(cards: readonly Card[], now: number, days = 7): number[] {
  const out = new Array<number>(days).fill(0);
  const day0 = startOfDay(now);
  const ends: number[] = [];
  for (let i = 0; i < days; i++) ends.push(addDays(day0, i + 1));
  for (const c of cards) {
    const i = ends.findIndex((end) => c.due < end);
    if (i >= 0) out[i] += 1;
  }
  return out;
}

export function reviewsToday(log: Readonly<Record<string, number>>, now: number): number {
  return log[dayKey(now)] ?? 0;
}

/** The prompt that turns pasted notes into card drafts the student keeps or discards. */
export function cardsPrompt(notes: string, max = 12): string {
  return [
    'You are Atlas, helping a student make flashcards for spaced repetition.',
    `From the notes below, write at most ${max} cards. Each card tests one fact or idea from the notes, and nothing that is not in them.`,
    'Write each card as exactly two lines and nothing else:',
    'Q: the question',
    'A: the short answer',
    'Leave one empty line between cards. No numbering, no headings, no commentary before or after.',
    'Write the cards in the language the notes are written in.',
    '',
    'Notes:',
    notes.trim(),
  ].join('\n');
}

/** Reads "Q: … / A: …" pairs out of the brain's answer, forgiving bullets, bold and numbering. */
export function parseCardDrafts(text: string): { front: string; back: string }[] {
  const out: { front: string; back: string }[] = [];
  let front: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    // Bold first: a leading "**Q:**" would otherwise read as a "*" bullet.
    const line = rawLine.replace(/\*\*/g, '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    const q = line.match(/^(?:Q|Question|Spørgsmål)\s*[:.]\s*(.+)$/i);
    if (q) { front = q[1].trim(); continue; }
    const a = line.match(/^(?:A|Answer|Svar)\s*[:.]\s*(.+)$/i);
    if (a && front) {
      out.push({ front, back: a[1].trim() });
      front = null;
    }
  }
  return out;
}

// ── Tutor ────────────────────────────────────────────────────────────────────

export type TutorRole = 'student' | 'tutor' | 'hint';
export interface TutorTurn { role: TutorRole; text: string; at: number }
export interface TutorThread {
  id: string;
  problem: string;
  turns: TutorTurn[];
  /** Hints taken so far, 0–3. They come one at a time, in order. */
  hints: number;
  created: number;
  updated: number;
}

/** The three-step hint ladder: each step gives a little more, none gives the answer. */
export const HINT_LADDER = [
  'a nudge: point at the idea or the kind of problem this is, without naming the method or formula',
  'name the rule, method or formula that applies and say why it fits, without applying it to this problem',
  "set up the first step with the student's own numbers or words, then stop and ask them to carry on",
] as const;

export type TutorAsk = { kind: 'start' } | { kind: 'reply'; text: string } | { kind: 'hint'; level: 1 | 2 | 3 };

/**
 * The preamble that makes the brain a Socratic tutor, then the problem, the
 * conversation so far and the one thing asked for now. The Talk endpoint takes
 * a single message, so the transcript travels inside it; it is trimmed to the
 * last `maxTurns` turns so a long session does not grow without bound.
 */
export function tutorPrompt(problem: string, turns: readonly TutorTurn[], ask: TutorAsk, maxTurns = 12): string {
  const recent = turns.slice(-maxTurns);
  const said = recent.map((t) => `${t.role === 'student' ? 'Student' : t.role === 'tutor' ? 'Tutor' : 'Hint given'}: ${t.text}`);
  const now = ask.kind === 'start'
    ? 'Open the session: ask the student one question that finds out what they already understand. Do not start solving.'
    : ask.kind === 'reply'
      ? `The student just wrote:\n${ask.text.trim()}\n\nRespond as the tutor.`
      : `The student asked for hint ${ask.level} of 3. Give exactly this and no more: ${HINT_LADDER[ask.level - 1]}. End with a question. Still do not give the final answer.`;
  return [
    'You are Atlas, working as a Socratic tutor for a student on the School screen.',
    'Rules you keep whatever the student asks:',
    '- Never give the final answer, a worked solution, or any text the student could hand in.',
    "- Never write the student's assignment for them, not even as an example.",
    '- Reply with one short question that moves them one step forward, or with the hint asked for below. Three sentences at most.',
    '- When the student is right, say so briefly and ask them to explain why in their own words.',
    '- When the student asks you to just tell them, decline kindly and offer the next hint instead.',
    '- Answer in the language the student writes in.',
    '',
    'The problem:',
    problem.trim(),
    '',
    'The conversation so far:',
    ...(turns.length > recent.length ? ['(earlier turns omitted)'] : []),
    said.length ? said.join('\n') : '(nothing yet)',
    '',
    now,
  ].join('\n');
}

/** The hint the student may take next, or null when all three are used. */
export function nextHintLevel(thread: Pick<TutorThread, 'hints'>): 1 | 2 | 3 | null {
  return thread.hints >= 3 ? null : ((thread.hints + 1) as 1 | 2 | 3);
}

/** A thread's name in the list: its first line, short. */
export function tutorTitle(problem: string): string {
  const first = problem.trim().split(/\r?\n/)[0] ?? '';
  return first.length > 64 ? `${first.slice(0, 61).trimEnd()}…` : first || 'Untitled problem';
}

// ── Study plan ───────────────────────────────────────────────────────────────

export interface Subject { id: string; name: string; colour: string }
export interface Deadline { id: string; subjectId: string | null; title: string; due: number; done: boolean }
export interface Session {
  id: string;
  subjectId: string | null;
  deadlineId: string | null;
  title: string;
  start: number;
  minutes: number;
  done: boolean;
}

/** The design's course palette, assigned to subjects in turn. */
export const SUBJECT_COLOURS = ['#3461f2', '#0a7a53', '#a3352c', '#7854ff', '#9a5a00', '#16a0c0', '#6d6a67', '#0fae76'];

export function nextColour(subjects: readonly Subject[]): string {
  const used = new Set(subjects.map((s) => s.colour));
  return SUBJECT_COLOURS.find((c) => !used.has(c)) ?? SUBJECT_COLOURS[subjects.length % SUBJECT_COLOURS.length];
}

export function weekDays(weekStartMs: number, n = 7): number[] {
  return Array.from({ length: n }, (_, i) => addDays(weekStartMs, i));
}

export function sessionsOn(sessions: readonly Session[], dayStartMs: number): Session[] {
  const end = addDays(dayStartMs, 1);
  return sessions.filter((s) => s.start >= dayStartMs && s.start < end).sort((a, b) => a.start - b.start);
}

export function deadlinesOn(deadlines: readonly Deadline[], dayStartMs: number): Deadline[] {
  const end = addDays(dayStartMs, 1);
  return deadlines.filter((d) => d.due >= dayStartMs && d.due < end).sort((a, b) => a.due - b.due);
}

export type RibbonState = 'past' | 'now' | 'next';
export interface RibbonItem { session: Session; state: RibbonState; fill: number; minutesLeft: number }

/**
 * Today's sessions for the hero ribbon, at most `max`, with the one under way
 * filled as far as it has run. When there are more than fit, the window
 * slides so the running and upcoming ones stay in view.
 */
export function todayRibbon(sessions: readonly Session[], now: number, max = 4): RibbonItem[] {
  const today = sessionsOn(sessions, startOfDay(now));
  const items = today.map((s): RibbonItem => {
    const end = s.start + s.minutes * MIN;
    const state: RibbonState = now >= end || s.done ? 'past' : now >= s.start ? 'now' : 'next';
    const fill = state === 'now' ? Math.min(1, (now - s.start) / (end - s.start || 1)) : 0;
    return { session: s, state, fill, minutesLeft: state === 'now' ? Math.ceil((end - now) / MIN) : 0 };
  });
  if (items.length <= max) return items;
  const firstLive = items.findIndex((i) => i.state !== 'past');
  const from = firstLive < 0 ? items.length - max : Math.min(firstLive, items.length - max);
  return items.slice(from, from + max);
}

/** Open deadlines, soonest first; an overdue one sorts ahead of everything. */
export function upcomingDeadlines(deadlines: readonly Deadline[], n = 4): Deadline[] {
  return deadlines.filter((d) => !d.done).sort((a, b) => a.due - b.due).slice(0, n);
}

/** "today", "tomorrow", "in 3 days", "overdue" — relative to calendar days, not hours. */
export function dueIn(due: number, now: number): string {
  if (due < now) return 'overdue';
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** "Today · 23:59", "Tomorrow · 12:00", "Fri 31 Oct · 12:00". */
export function dueLabel(due: number, now: number): string {
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : shortDate(due);
  return `${day} · ${hhmm(due)}`;
}

export function deadlineProgress(deadline: Pick<Deadline, 'id'>, sessions: readonly Session[]): { done: number; total: number } {
  const linked = sessions.filter((s) => s.deadlineId === deadline.id);
  return { done: linked.filter((s) => s.done).length, total: linked.length };
}

export function weekSummary(sessions: readonly Session[], weekStartMs: number): { planned: number; done: number; minutes: number } {
  const end = addDays(weekStartMs, 7);
  const inWeek = sessions.filter((s) => s.start >= weekStartMs && s.start < end);
  return { planned: inWeek.length, done: inWeek.filter((s) => s.done).length, minutes: inWeek.reduce((a, s) => a + s.minutes, 0) };
}

function overlaps(sessions: readonly Session[], start: number, minutes: number): boolean {
  const end = start + minutes * MIN;
  return sessions.some((s) => start < s.start + s.minutes * MIN && s.start < end);
}

/**
 * Atlas's plan for one deadline: `count` sessions spread evenly over the days
 * between tomorrow and the deadline, at `hour`, moved two hours later when the
 * slot is taken and skipped when that is taken too. Proposed, not saved — the
 * screen adds them, and the student can delete any.
 */
export function spreadSessions(
  deadline: Deadline,
  sessions: readonly Session[],
  now: number,
  opts: { count?: number; minutes?: number; hour?: number } = {},
): Session[] {
  const count = Math.max(1, opts.count ?? 3);
  const minutes = opts.minutes ?? 45;
  const hour = opts.hour ?? 16;
  const at = (day: number, h: number) => { const d = new Date(day); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const days: number[] = [];
  for (let day = addDays(startOfDay(now), 1); day <= startOfDay(deadline.due); day = addDays(day, 1)) {
    // The deadline's own day counts only when the session ends before it is due.
    if (day === startOfDay(deadline.due) && at(day, hour) + minutes * MIN > deadline.due) break;
    days.push(day);
  }
  if (!days.length) return [];
  const picked = days.length <= count
    ? days
    : Array.from(new Set(Array.from({ length: count }, (_, i) => days[count === 1 ? days.length - 1 : Math.round((i * (days.length - 1)) / (count - 1))])));
  const out: Session[] = [];
  for (const day of picked) {
    const taken = [...sessions, ...out];
    const start = [hour, hour + 2].map((h) => at(day, h)).find((s) => !overlaps(taken, s, minutes));
    if (start === undefined) continue;
    out.push({ id: uid('ses'), subjectId: deadline.subjectId, deadlineId: deadline.id, title: deadline.title, start, minutes, done: false });
  }
  return out.map((s, i) => ({ ...s, title: `${deadline.title} · ${i + 1} of ${out.length}` }));
}

// ── Focus timer ──────────────────────────────────────────────────────────────

export const FOCUS_SECONDS = 25 * 60;
/** Running when `endsAt` is set; paused or fresh otherwise, with `left` seconds to go. */
export interface FocusState { endsAt: number | null; left: number }
export const FRESH_FOCUS: FocusState = { endsAt: null, left: FOCUS_SECONDS };

export function focusLeft(f: FocusState, now: number): number {
  return f.endsAt !== null ? Math.max(0, Math.ceil((f.endsAt - now) / 1000)) : f.left;
}

export function startFocus(f: FocusState, now: number): FocusState {
  const left = focusLeft(f, now) || FOCUS_SECONDS;
  return { endsAt: now + left * 1000, left };
}

export function pauseFocus(f: FocusState, now: number): FocusState {
  return { endsAt: null, left: focusLeft(f, now) };
}

/** "25:00", "4:05". */
export function clock(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface Doc {
  id: string;
  title: string;
  body: string;
  updated: number;
  /** The word range the assignment asks for, when the student sets one. */
  min: number | null;
  max: number | null;
  /** How many Atlas rewrites the student has accepted into this document — the honesty line counts them. */
  atlasEdits: number;
  /** Atlas's margin notes, each anchored to the section it is about (see betaSchoolSections.ts). */
  notes: MarginNote[];
}

/** A question or pointer in the margin; `anchor` is the heading of its section ('' before the first heading). */
export interface MarginNote { id: string; text: string; anchor: string | null }

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function lengthState(words: number, min: number | null, max: number | null): 'none' | 'under' | 'within' | 'over' {
  if (min === null && max === null) return 'none';
  if (min !== null && words < min) return 'under';
  if (max !== null && words > max) return 'over';
  return 'within';
}

export type RewriteMode = 'shorter' | 'clearer' | 'formal';
export const REWRITES: readonly { key: RewriteMode; label: string; instruction: string }[] = [
  { key: 'shorter', label: 'Shorter', instruction: 'Make it shorter: keep every point, cut repetition and filler.' },
  { key: 'clearer', label: 'Clearer', instruction: 'Make it clearer: simpler sentences, the main point first, the same meaning.' },
  { key: 'formal', label: 'More formal', instruction: 'Make it more formal: an academic register, no slang or contractions, the same meaning.' },
];

export function rewritePrompt(passage: string, mode: RewriteMode): string {
  const r = REWRITES.find((x) => x.key === mode) ?? REWRITES[0];
  return [
    'You are Atlas, editing a passage the student wrote. Rewrite only the passage below.',
    r.instruction,
    'Keep its language, its facts and its argument; add nothing new.',
    'Return only the rewritten passage: no quotation marks, no heading, no commentary.',
    '',
    'Passage:',
    passage.trim(),
  ].join('\n');
}

/** Strips what models wrap around a rewrite: code fences, a "Here is…" line, surrounding quotes. */
export function cleanRewrite(text: string): string {
  let t = text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  const lines = t.split('\n');
  if (lines.length > 1 && /^(here('| i)s|sure|okay|of course)\b.*:\s*$/i.test(lines[0].trim())) t = lines.slice(1).join('\n').trim();
  const q = t.match(/^["“'](.*)["”']$/s);
  return (q ? q[1] : t).trim();
}

/**
 * Margin notes out of the brain's answer: bullet lines, or else its questions.
 * The prompt that asks for them anchors each to a section (betaSchoolAtlas.ts).
 */
export function parseNotes(text: string, max = 3): string[] {
  const bullets = text.split(/\r?\n/).map((l) => l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/)?.[1]?.replace(/\*\*/g, '').trim()).filter((l): l is string => !!l);
  if (bullets.length) return bullets.slice(0, max);
  const questions = text.match(/[^.?!\n]+\?/g)?.map((q) => q.trim()) ?? [];
  if (questions.length) return questions.slice(0, max);
  const whole = text.trim();
  return whole ? [whole] : [];
}

// ── Spreadsheet ──────────────────────────────────────────────────────────────

export const SHEET_COLS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export const SHEET_ROWS = 12;
export type CellValue = number | string;
export const SHEET_FUNCTIONS = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'ROUND', 'ABS', 'SQRT', 'POWER', 'PI', 'RADIANS', 'SIN', 'COS', 'TAN'] as const;

export function parseRef(ref: string): { col: number; row: number } | null {
  const m = ref.toUpperCase().match(/^([A-Z])(\d{1,3})$/);
  if (!m) return null;
  const col = SHEET_COLS.indexOf(m[1] as (typeof SHEET_COLS)[number]);
  const row = Number(m[2]);
  return col < 0 || row < 1 || row > SHEET_ROWS ? null : { col, row };
}

export function refOf(col: number, row: number): string {
  return `${SHEET_COLS[col]}${row}`;
}

export function moveRef(ref: string, dc: number, dr: number): string {
  const p = parseRef(ref) ?? { col: 0, row: 1 };
  return refOf(Math.min(SHEET_COLS.length - 1, Math.max(0, p.col + dc)), Math.min(SHEET_ROWS, Math.max(1, p.row + dr)));
}

/** A typed value that is not a formula: empty, a number (a decimal comma reads as a point), or text. */
export function literal(raw: string): CellValue {
  const t = raw.trim();
  if (!t) return '';
  if (/^[-+]?\d+([.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  return t;
}

/**
 * A plain boolean, not a `v is string` guard: text that is not an error is
 * also a string, and a guard would tell the compiler that a non-error value
 * can only be a number.
 */
export const isError = (v: CellValue): boolean => typeof v === 'string' && v.startsWith('#');

class SheetError extends Error {
  constructor(readonly code: string) { super(code); }
}

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = src.slice(i).match(/^\d+(\.\d+)?/);
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = src.slice(i).match(/^[A-Za-z]+\d*/);
    if (id) { out.push({ t: 'id', v: id[0].toUpperCase() }); i += id[0].length; continue; }
    if ('+-*/^(),;:'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new SheetError('#ERR');
  }
  return out;
}

/**
 * Evaluates every non-empty cell. Formulas start with "=" and take numbers,
 * cell references (A1), + − × ÷ ^ and brackets, and the functions in
 * SHEET_FUNCTIONS (ranges like B2:B6 inside them; arguments split by "," or
 * ";"). Trigonometry is in radians, as in every spreadsheet — RADIANS()
 * converts. A minus sign binds looser than "^", as in maths: =-2^2 is −4.
 * A parser, not `eval`: nothing a cell says can run as code.
 *
 * Errors read as values: #ERR (cannot parse), #REF (outside A1:F12), #NAME
 * (unknown function), #VALUE (text in arithmetic), #DIV/0, #CYCLE (a cell
 * that depends on itself). An error in a referenced cell carries forward.
 */
export function evaluateSheet(cells: Readonly<Record<string, string>>): Record<string, CellValue> {
  const memo: Record<string, CellValue> = {};
  const visiting = new Set<string>();

  const valueOf = (ref: string): CellValue => {
    if (ref in memo) return memo[ref];
    if (visiting.has(ref)) throw new SheetError('#CYCLE');
    const raw = cells[ref] ?? '';
    if (!raw.startsWith('=')) return (memo[ref] = literal(raw));
    visiting.add(ref);
    let v: CellValue;
    try {
      v = run(raw.slice(1));
    } catch (e) {
      v = e instanceof SheetError ? e.code : '#ERR';
    }
    visiting.delete(ref);
    return (memo[ref] = v);
  };

  const numberOf = (v: CellValue): number => {
    if (isError(v)) throw new SheetError(String(v));
    if (v === '') return 0;
    if (typeof v === 'string') throw new SheetError('#VALUE');
    return v;
  };

  const run = (src: string): CellValue => {
    const toks = tokenize(src);
    let p = 0;
    const peek = (): Token | undefined => toks[p];
    const isOp = (v: string) => { const t = peek(); return !!t && t.t === 'op' && t.v === v; };
    const expect = (v: string) => { if (!isOp(v)) throw new SheetError('#ERR'); p++; };

    const cellRef = (id: string): string => {
      if (!/^[A-Z]\d+$/.test(id)) throw new SheetError('#NAME');
      if (!parseRef(id)) throw new SheetError('#REF');
      return id;
    };

    const rangeValues = (a: string, b: string): CellValue[] => {
      const pa = parseRef(a), pb = parseRef(b);
      if (!pa || !pb) throw new SheetError('#REF');
      const vals: CellValue[] = [];
      for (let c = Math.min(pa.col, pb.col); c <= Math.max(pa.col, pb.col); c++) {
        for (let r = Math.min(pa.row, pb.row); r <= Math.max(pa.row, pb.row); r++) vals.push(valueOf(refOf(c, r)));
      }
      return vals;
    };

    // One argument: a range (its values, spread) or an expression (one value).
    const arg = (): CellValue[] => {
      const t = peek(), n = toks[p + 1], m = toks[p + 2];
      if (t?.t === 'id' && n?.t === 'op' && n.v === ':' && m?.t === 'id') {
        p += 3;
        return rangeValues(cellRef(t.v), cellRef(m.v));
      }
      return [expr()];
    };

    const call = (name: string): number => {
      expect('(');
      const args: CellValue[][] = [];
      if (!isOp(')')) {
        args.push(arg());
        while (isOp(',') || isOp(';')) { p++; args.push(arg()); }
      }
      expect(')');
      const flat = args.flat();
      for (const v of flat) if (isError(v)) throw new SheetError(String(v));
      const nums = flat.filter((v): v is number => typeof v === 'number');
      const one = (i: number) => numberOf(args[i]?.[0] ?? '');
      switch (name) {
        case 'SUM': return nums.reduce((a, b) => a + b, 0);
        case 'AVERAGE': if (!nums.length) throw new SheetError('#DIV/0'); return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'MIN': return nums.length ? Math.min(...nums) : 0;
        case 'MAX': return nums.length ? Math.max(...nums) : 0;
        case 'COUNT': return nums.length;
        case 'ROUND': { const k = 10 ** Math.round(args.length > 1 ? one(1) : 0); return Math.round(one(0) * k) / k; }
        case 'ABS': return Math.abs(one(0));
        case 'SQRT': { const x = one(0); if (x < 0) throw new SheetError('#VALUE'); return Math.sqrt(x); }
        case 'POWER': return one(0) ** one(1);
        case 'PI': return Math.PI;
        case 'RADIANS': return (one(0) * Math.PI) / 180;
        case 'SIN': return Math.sin(one(0));
        case 'COS': return Math.cos(one(0));
        case 'TAN': return Math.tan(one(0));
        default: throw new SheetError('#NAME');
      }
    };

    const primary = (): number => {
      const t = peek();
      if (!t) throw new SheetError('#ERR');
      if (t.t === 'num') { p++; return t.v; }
      if (t.t === 'op' && t.v === '(') { p++; const v = expr(); expect(')'); return v; }
      if (t.t === 'id') {
        p++;
        if (isOp('(')) {
          if (!(SHEET_FUNCTIONS as readonly string[]).includes(t.v)) throw new SheetError('#NAME');
          return call(t.v);
        }
        return numberOf(valueOf(cellRef(t.v)));
      }
      throw new SheetError('#ERR');
    };

    const unary = (): number => {
      if (isOp('-')) { p++; return -unary(); }
      if (isOp('+')) { p++; return unary(); }
      return power();
    };
    const power = (): number => {
      const base = primary();
      if (isOp('^')) { p++; return base ** unary(); }
      return base;
    };
    const term = (): number => {
      let v = unary();
      while (isOp('*') || isOp('/')) {
        const op = toks[p++].v;
        const r = unary();
        if (op === '/' && r === 0) throw new SheetError('#DIV/0');
        v = op === '*' ? v * r : v / r;
      }
      return v;
    };
    function expr(): number {
      let v = term();
      while (isOp('+') || isOp('-')) {
        const op = toks[p++].v;
        const r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }

    const v = expr();
    if (p !== toks.length) throw new SheetError('#ERR');
    if (!Number.isFinite(v)) throw new SheetError('#VALUE');
    return v;
  };

  const out: Record<string, CellValue> = {};
  for (const [ref, raw] of Object.entries(cells)) {
    if (!raw || !parseRef(ref)) continue;
    out[ref] = valueOf(ref);
  }
  return out;
}

/** Numbers to at most four decimals, trailing zeros dropped. */
export function formatCell(v: CellValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'number') return String(Math.round(v * 10000) / 10000);
  return v;
}

/** The ranges a formula reads, for the lighter-blue highlight. */
export function rangesIn(raw: string): { from: string; to: string }[] {
  if (!raw.startsWith('=')) return [];
  return [...raw.toUpperCase().matchAll(/([A-Z]\d+):([A-Z]\d+)/g)].map((m) => ({ from: m[1], to: m[2] }));
}

export function inRanges(ref: string, ranges: readonly { from: string; to: string }[]): boolean {
  const p = parseRef(ref);
  if (!p) return false;
  return ranges.some((r) => {
    const a = parseRef(r.from), b = parseRef(r.to);
    return !!a && !!b && p.col >= Math.min(a.col, b.col) && p.col <= Math.max(a.col, b.col) && p.row >= Math.min(a.row, b.row) && p.row <= Math.max(a.row, b.row);
  });
}

/** The used part of the sheet as CSV of values, then each formula on its own line — what Atlas reads. */
export function sheetText(cells: Readonly<Record<string, string>>, values: Readonly<Record<string, CellValue>>): string {
  const used = Object.keys(cells).filter((r) => cells[r] && parseRef(r)).map((r) => parseRef(r)!);
  if (!used.length) return '(the sheet is empty)';
  const maxCol = Math.max(...used.map((u) => u.col));
  const maxRow = Math.max(...used.map((u) => u.row));
  const rows: string[] = [`,${SHEET_COLS.slice(0, maxCol + 1).join(',')}`];
  for (let r = 1; r <= maxRow; r++) {
    const line = [String(r)];
    for (let c = 0; c <= maxCol; c++) {
      const v = formatCell(values[refOf(c, r)]);
      line.push(/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    }
    rows.push(line.join(','));
  }
  const formulas = Object.entries(cells).filter(([r, raw]) => raw.startsWith('=') && parseRef(r)).map(([r, raw]) => `${r}: ${raw}`);
  return [rows.join('\n'), formulas.length ? `\nFormulas:\n${formulas.join('\n')}` : ''].join('');
}

export type SheetAsk = 'explain' | 'check';

export function sheetPrompt(ask: SheetAsk, sheet: string, selected: { ref: string; raw: string; value: string } | null): string {
  const intro = 'You are Atlas, looking at a small spreadsheet a student built. You explain and point things out; you never change their cells.';
  const what = ask === 'explain' && selected
    ? `Explain in plain words what cell ${selected.ref} does${selected.raw.startsWith('=') ? ` (its formula is ${selected.raw})` : ''} and what its value ${selected.value || '(empty)'} means in this sheet. Three sentences at most.`
    : 'Look at the data and say briefly whether anything looks odd: an outlier, a gap, a formula that reads the wrong cells, units that do not match. Three sentences at most. If nothing looks odd, say so.';
  return [intro, what, '', 'The sheet:', sheet].join('\n');
}

// ── What is stored, read back defensively ────────────────────────────────────

// ── Exams, preparations and what the tutor saw ──────────────────────────────

export type ExamKind = 'written' | 'oral' | 'exam';
/** An exam the student added; Lectio's come from the schedule and are not stored (betaSchoolExams.ts). */
export interface OwnExam { id: string; title: string; kind: ExamKind; at: number }

export interface PreparedStep { text: string; done: boolean }
/**
 * An assignment Atlas laid out and the student accepted: the steps, and where
 * the sessions and cards went. `id` names the source — `moodle:<id>` or
 * `own:<deadline id>` — so an assignment is prepared once.
 */
export interface Prepared {
  id: string;
  title: string;
  course: string;
  due: number | null;
  steps: PreparedStep[];
  deadlineId: string | null;
  deckId: string | null;
  at: number;
}

export interface UnderstoodItem { text: string; ok: boolean }
/** What the student showed they understood in one problem on one day, from their own turns. */
export interface UnderstoodEntry { day: string; threadId: string; items: UnderstoodItem[]; at: number }

export interface SchoolState {
  decks: Deck[];
  cards: Card[];
  /** Reviews done per local day (`YYYY-MM-DD`), for "N reviewed today". */
  reviewLog: Record<string, number>;
  subjects: Subject[];
  deadlines: Deadline[];
  sessions: Session[];
  tutor: TutorThread[];
  docs: Doc[];
  sheet: Record<string, string>;
  focus: FocusState;
  exams: OwnExam[];
  /** Decks linked to an exam, by exam key (`own:<id>` or `lectio:<lesson id>`): its topics. */
  examDecks: Record<string, string[]>;
  prepared: Prepared[];
  /** Assignment keys the student has seen in the list, so the rest can be marked new. */
  seen: string[];
  /**
   * LearnIT assignments the student marked handed in. Moodle would say so
   * itself only through a submission call School does not make; the student's
   * own deadlines keep this on `Deadline.done`.
   */
  handedIn: string[];
  understood: UnderstoodEntry[];
}

export const EMPTY_SCHOOL: SchoolState = {
  decks: [], cards: [], reviewLog: {}, subjects: [], deadlines: [], sessions: [], tutor: [], docs: [], sheet: {}, focus: FRESH_FOCUS,
  exams: [], examDecks: {}, prepared: [], seen: [], handedIn: [], understood: [],
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 20_000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function each<T>(v: unknown, read: (o: Obj) => T | null, cap: number): T[] {
  const out: T[] = [];
  for (const item of arr(v)) {
    if (!isObj(item)) continue;
    const r = read(item);
    if (r) out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * The stored JSON, read so that nothing in it can break the screen: a wrong
 * type drops that one item, an unknown deck drops its cards, a missing field
 * falls back to the empty value. Hand-edited, truncated or older data still
 * opens.
 */
export function parseSchool(raw: string | null): SchoolState {
  if (!raw) return EMPTY_SCHOOL;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return EMPTY_SCHOOL; }
  if (!isObj(data)) return EMPTY_SCHOOL;

  const decks = each(data.decks, (o): Deck | null => {
    const id = str(o.id, 80), name = str(o.name, 120);
    return id && name ? { id, name, colour: str(o.colour, 32) ?? SUBJECT_COLOURS[0] } : null;
  }, 200);
  const deckIds = new Set(decks.map((d) => d.id));
  const cards = each(data.cards, (o): Card | null => {
    const id = str(o.id, 80), deckId = str(o.deckId, 80), front = str(o.front, 4000), back = str(o.back, 4000);
    const due = num(o.due), created = num(o.created);
    if (!id || !deckId || !deckIds.has(deckId) || front === null || back === null || due === null) return null;
    return {
      id, deckId, front, back, due, created: created ?? due,
      interval: Math.max(0, num(o.interval) ?? 0),
      ease: Math.max(MIN_EASE, num(o.ease) ?? START_EASE),
      reps: Math.max(0, num(o.reps) ?? 0),
      lapses: Math.max(0, num(o.lapses) ?? 0),
    };
  }, 10_000);
  const reviewLog: Record<string, number> = {};
  if (isObj(data.reviewLog)) {
    for (const [k, v] of Object.entries(data.reviewLog)) {
      const n = num(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && n !== null && n >= 0) reviewLog[k] = n;
    }
  }
  const subjects = each(data.subjects, (o): Subject | null => {
    const id = str(o.id, 80), name = str(o.name, 120);
    return id && name ? { id, name, colour: str(o.colour, 32) ?? SUBJECT_COLOURS[0] } : null;
  }, 100);
  const deadlines = each(data.deadlines, (o): Deadline | null => {
    const id = str(o.id, 80), title = str(o.title, 300), due = num(o.due);
    return id && title && due !== null ? { id, title, due, subjectId: nullableStr(o.subjectId), done: o.done === true } : null;
  }, 1000);
  const sessions = each(data.sessions, (o): Session | null => {
    const id = str(o.id, 80), title = str(o.title, 300), start = num(o.start), minutes = num(o.minutes);
    if (!id || !title || start === null || minutes === null || minutes <= 0) return null;
    return { id, title, start, minutes: Math.min(minutes, 24 * 60), subjectId: nullableStr(o.subjectId), deadlineId: nullableStr(o.deadlineId), done: o.done === true };
  }, 5000);
  const tutor = each(data.tutor, (o): TutorThread | null => {
    const id = str(o.id, 80), problem = str(o.problem, 8000), created = num(o.created);
    if (!id || !problem || created === null) return null;
    const turns = each(o.turns, (t): TutorTurn | null => {
      const text = str(t.text, 8000), at = num(t.at);
      const role = t.role === 'student' || t.role === 'tutor' || t.role === 'hint' ? t.role : null;
      return text !== null && at !== null && role ? { role, text, at } : null;
    }, 400);
    return { id, problem, turns, created, updated: num(o.updated) ?? created, hints: Math.min(3, Math.max(0, num(o.hints) ?? 0)) };
  }, 100);
  const docs = each(data.docs, (o): Doc | null => {
    const id = str(o.id, 80), title = str(o.title, 300), body = str(o.body, 400_000), updated = num(o.updated);
    if (!id || title === null || body === null || updated === null) return null;
    const notes = each(o.notes, (n): MarginNote | null => {
      const nid = str(n.id, 80), text = str(n.text, 2000);
      return nid && text ? { id: nid, text, anchor: typeof n.anchor === 'string' ? n.anchor.slice(0, 300) : null } : null;
    }, 12);
    return { id, title, body, updated, min: num(o.min), max: num(o.max), atlasEdits: Math.max(0, num(o.atlasEdits) ?? 0), notes };
  }, 200);
  const sheet: Record<string, string> = {};
  if (isObj(data.sheet)) {
    for (const [k, v] of Object.entries(data.sheet)) {
      const s = str(v, 1000);
      if (parseRef(k) && s) sheet[k.toUpperCase()] = s;
    }
  }
  let focus = FRESH_FOCUS;
  if (isObj(data.focus)) {
    const left = num(data.focus.left), endsAt = num(data.focus.endsAt);
    focus = { endsAt, left: left === null ? FOCUS_SECONDS : Math.min(FOCUS_SECONDS, Math.max(0, left)) };
  }
  const exams = each(data.exams, (o): OwnExam | null => {
    const id = str(o.id, 80), title = str(o.title, 300), at = num(o.at);
    const kind: ExamKind = o.kind === 'written' || o.kind === 'oral' ? o.kind : 'exam';
    return id && title && at !== null ? { id, title, kind, at } : null;
  }, 200);
  const examDecks: Record<string, string[]> = {};
  if (isObj(data.examDecks)) {
    for (const [k, v] of Object.entries(data.examDecks).slice(0, 400)) {
      const ids = arr(v).filter((x): x is string => typeof x === 'string' && deckIds.has(x)).slice(0, 40);
      if (k.length <= 200 && ids.length) examDecks[k] = ids;
    }
  }
  const prepared = each(data.prepared, (o): Prepared | null => {
    const id = str(o.id, 120), title = str(o.title, 400), at = num(o.at);
    if (!id || !title || at === null) return null;
    const steps = each(o.steps, (x): PreparedStep | null => {
      const text = str(x.text, 400);
      return text ? { text, done: x.done === true } : null;
    }, 20);
    return { id, title, course: str(o.course, 300) ?? '', due: num(o.due), steps, deadlineId: nullableStr(o.deadlineId), deckId: nullableStr(o.deckId), at };
  }, 500);
  const seen = arr(data.seen).filter((x): x is string => typeof x === 'string' && x.length <= 120).slice(-2000);
  const handedIn = arr(data.handedIn).filter((x): x is string => typeof x === 'string' && x.length <= 120).slice(-2000);
  const understood = each(data.understood, (o): UnderstoodEntry | null => {
    const day = str(o.day, 10), threadId = str(o.threadId, 80), at = num(o.at);
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !threadId || at === null) return null;
    const items = each(o.items, (x): UnderstoodItem | null => {
      const text = str(x.text, 200);
      return text ? { text, ok: x.ok === true } : null;
    }, 8);
    return { day, threadId, items, at };
  }, 400);
  return { decks, cards, reviewLog, subjects, deadlines, sessions, tutor, docs, sheet, focus, exams, examDecks, prepared, seen, handedIn, understood };
}
