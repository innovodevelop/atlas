/**
 * The Beta Answer screen's reading of a question (`Atlas Answer Views
 * Beta.dc.html`): which shape the answer takes, and what the screen says while
 * Atlas is thinking. The brain answers in markdown; the shape decides which
 * real strip sits above the composed answer (the hourly sky for weather, the
 * link to Money for spending, the brain's validated comparison table, the
 * person found in this Mac's mail and calendar) or replaces it (Rejseplanen's
 * departures board, see transit.ts) — never invented figures.
 */
export type AnswerShape = 'weather' | 'money' | 'travel' | 'compare' | 'person' | 'explain';

export const SHAPE_NAME: Record<AnswerShape, string> = {
  weather: 'Weather', money: 'Money', travel: 'Travel', compare: 'Comparison', person: 'Person', explain: 'Explainer',
};

/** The design's `classify(q)`, kept word for word where it was sensible. */
export function classify(q: string): AnswerShape {
  const t = q.toLowerCase();
  if (/umbrella|\brain(y|ing|s)?\b|weather|jacket|forecast|sunny|\bsnow|temperature|degrees/.test(t)) return 'weather';
  if (/spend|spent|cost|money|budget|€|\$|kr\b|invoice|paid|bill/.test(t)) return 'money';
  if (/train|bus|metro|flight|depart|leave for|get to|commute|next .* to /.test(t)) return 'travel';
  if (/compare|versus| vs |which is better|which one|or the /.test(t)) return 'compare';
  if (/who is|who's|what do i know about|tell me about/.test(t) || /about [A-Z][a-z]+ [A-Z]/.test(q)) return 'person';
  return 'explain';
}

export const STEPS: Record<AnswerShape, [string, string]> = {
  weather: ['Checking the forecast…', 'Matching it to your calendar…'],
  money: ['Reading your transactions…', 'Grouping by category…'],
  travel: ['Looking up departures…', 'Checking delays…'],
  compare: ['Reading both sides…', 'Weighing what you said matters…'],
  person: ['Searching mail and calendar…', 'Reading what Atlas remembers…'],
  explain: ['Reading up…', 'Writing it in plain words…'],
};

/** The headline: the answer's first sentence, as the design's header shows it. */
export function headlineOf(text: string, max = 140): string {
  const flat = text.replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const m = flat.match(/^(.{12,}?[.!?])(\s|$)/);
  const first = m ? m[1] : flat;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** The question the screen was opened with: `?q=` first, then router state. */
export function questionFrom(search: string, state: unknown): string | null {
  const q = new URLSearchParams(search).get('q')?.trim();
  if (q) return q;
  const s = state as { q?: unknown } | null;
  return typeof s?.q === 'string' && s.q.trim() ? s.q.trim() : null;
}

/**
 * Opened straight onto the departures board (Home's Transit widget): router
 * state `{ departures: true }`. The board is then the whole answer and the
 * brain is not asked anything.
 */
export function departuresFrom(state: unknown): boolean {
  return (state as { departures?: unknown } | null)?.departures === true;
}

/* ---- relative days ------------------------------------------------------- */

const DAY_MS = 86_400_000;
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today, 08:02", "Yesterday", "Thursday", "18 Oct" — the design's `when`. Future dates read the same way. */
export function relDay(when: string | null | undefined, now: Date = new Date(), withTime = false): string {
  const t = when ? Date.parse(when) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const days = Math.round((midnight(d) - midnight(now)) / DAY_MS);
  const time = withTime ? `, ${CLOCK.format(d)}` : '';
  if (days === 0) return `Today${time}`;
  if (days === -1) return `Yesterday${time}`;
  if (days === 1) return `Tomorrow${time}`;
  if (Math.abs(days) < 7) return `${WEEKDAY.format(d)}${time}`;
  return `${DAY_MONTH.format(d)}${time}`;
}

/* ---- the comparison shape (left-out row 27) ------------------------------ */

export interface ComparisonItem { name: string; note: string | null }
export interface ComparisonRow { attribute: string; values: string[]; best: number | null }
export interface Comparison {
  items: ComparisonItem[];
  rows: ComparisonRow[];
  /** The item Atlas would pick, or null when it is a matter of taste. */
  pick: number | null;
  verdict: string;
}

const MAX_ITEMS = 4;
const MAX_ROWS = 12;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
const index = (v: unknown, n: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? v : null);

/**
 * Every digit-run in `value` appears in `source` — the greeting route's
 * numeric grounding (services/atlas-brain/src/greeting.ts), applied per cell.
 * A rent, a distance or a date the answer never mentioned is the signature of
 * an invented figure, and the row carrying it is dropped.
 */
export function numbersGrounded(value: string, source: string): boolean {
  const NUM = /\d+(?:[.,]\d+)*/g;
  const digits = value.match(NUM);
  if (!digits) return true;
  // Whole numbers, compared without their thousands and decimal marks, so
  // "2,050" grounds "2050" but the 7 in "27 min" grounds nothing.
  const bare = (d: string) => d.replace(/[.,]/g, '');
  const known = new Set((source.match(NUM) ?? []).map(bare));
  return digits.every((d) => known.has(bare(d)));
}

/**
 * The brain's structured comparison, validated. Strict on shape (two to four
 * items, a value per item on every row, indices in range, a one-line verdict)
 * and on substance (rows whose figures the question and answer never stated
 * are dropped). Returns null — and the screen keeps the composed answer —
 * when what is left could not stand as a comparison.
 *
 * No score out of a hundred, although the design draws one: a number the
 * model makes up about two flats is precision nobody measured.
 */
export function parseComparison(raw: unknown, source: string): Comparison | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items) || !Array.isArray(r.rows)) return null;
  const items: ComparisonItem[] = [];
  for (const it of r.items) {
    const o = typeof it === 'object' && it !== null ? (it as Record<string, unknown>) : {};
    const name = text(o.name) ?? text(it);
    if (!name) return null;
    const note = text(o.note);
    items.push({ name: clip(name, 60), note: note ? clip(note, 80) : null });
  }
  if (items.length < 2 || items.length > MAX_ITEMS) return null;
  if (new Set(items.map((i) => i.name.toLowerCase())).size !== items.length) return null;
  const rows: ComparisonRow[] = [];
  for (const row of r.rows) {
    if (typeof row !== 'object' || row === null) continue;
    const o = row as Record<string, unknown>;
    const attribute = text(o.attribute);
    if (!attribute || !Array.isArray(o.values) || o.values.length !== items.length) continue;
    const cells: string[] = [];
    for (const v of o.values) {
      const t = text(v);
      if (t === null) break;
      cells.push(clip(t, 60));
    }
    if (cells.length !== items.length || !cells.every((v) => numbersGrounded(v, source))) continue;
    rows.push({ attribute: clip(attribute, 40), values: cells, best: index(o.best, items.length) });
    if (rows.length >= MAX_ROWS) break;
  }
  if (rows.length === 0) return null;
  const verdict = text(r.verdict);
  if (!verdict || !numbersGrounded(verdict, source)) return null;
  return { items, rows, pick: index(r.pick, items.length), verdict: clip(verdict, 200) };
}

/* ---- the person shape (left-out row 28) ---------------------------------- */

/**
 * Who a person question is about: "What do I know about Priya Raman?" →
 * "Priya Raman". A name is capitalised words (or an email address), at most
 * four of them — "tell me about the weather" names nobody.
 */
export function personFromQuestion(q: string): string | null {
  const m = q.match(/\b(?:who\s+is|who's|who’s|what\s+do\s+i\s+know\s+about|tell\s+me\s+about|about)\s+(.+?)\s*(?:[?!]|\.(?:\s|$)|$)/i);
  if (!m) return null;
  const said = m[1].trim().replace(/^(?:my|our)\s+/i, '');
  const email = said.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (email) return email[0].toLowerCase();
  const words = said.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  if (!words.every((w) => /^[A-ZÆØÅÄÖÜÉ][\p{L}'’-]*$/u.test(w))) return null;
  return words.join(' ').slice(0, 60);
}

export interface PersonEvent { kind: 'mail-in' | 'mail-out' | 'meeting'; at: string; title: string; sub: string | null; threadId: string | null }
export interface PersonCard {
  name: string;
  address: string | null;
  emails: number;
  threads: number;
  meetings: number;
  lastContact: string | null;
  nextMeeting: { title: string; start: string; location: string | null } | null;
  /** Newest first: the last messages either way and the meetings already held. */
  recent: PersonEvent[];
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const isoOf = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/** The brain's `/answer/person` reply, validated; null when nobody was found. */
export function parsePersonCard(raw: unknown): PersonCard | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.found !== true) return null;
  const name = text(r.name);
  if (!name) return null;
  const nm = typeof r.nextMeeting === 'object' && r.nextMeeting !== null ? (r.nextMeeting as Record<string, unknown>) : null;
  const nmTitle = nm ? text(nm.title) : null;
  const nmStart = nm ? isoOf(nm.start) : null;
  const recent: PersonEvent[] = (Array.isArray(r.recent) ? r.recent : []).flatMap((e): PersonEvent[] => {
    if (typeof e !== 'object' || e === null) return [];
    const o = e as Record<string, unknown>;
    const kind = o.kind === 'mail-in' || o.kind === 'mail-out' || o.kind === 'meeting' ? o.kind : null;
    const at = isoOf(o.at);
    const title = text(o.title);
    if (!kind || !at || !title) return [];
    const sub = text(o.sub);
    return [{ kind, at, title: clip(title, 120), sub: sub ? clip(sub, 140) : null, threadId: text(o.threadId) }];
  });
  return {
    name: clip(name, 60),
    address: text(r.address),
    emails: count(r.emails),
    threads: count(r.threads),
    meetings: count(r.meetings),
    lastContact: isoOf(r.lastContact),
    nextMeeting: nm && nmTitle && nmStart ? { title: nmTitle, start: nmStart, location: text(nm.location) } : null,
    recent: recent.slice(0, 6),
  };
}

/** Initials for the avatar, from a name or an address. */
export function initials(name: string): string {
  const parts = name.replace(/[<>"]/g, '').split('@')[0].split(/[\s._-]+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '?';
}

/** The three tiles under the name: Emails, Meetings, Last contact. */
export function personStats(card: PersonCard, now: Date = new Date()): Array<{ k: string; v: string }> {
  return [
    { k: 'Emails', v: String(card.emails) },
    { k: 'Meetings', v: String(card.meetings) },
    { k: 'Last contact', v: card.lastContact ? relDay(card.lastContact, now) : 'None yet' },
  ];
}
