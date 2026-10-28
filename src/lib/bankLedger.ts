/**
 * The bank ledger, read — categories, the budget ring and its pace tick,
 * recurring payments, the subscriptions found among them, the thirty-day
 * projection with its event chips, savings goals, and the "Ask Atlas to sort
 * these" round trip. Rows 33–37 of docs/design-sync/2026-10-28-left-out-features.md.
 *
 * Everything here is arithmetic over rows the bank store on this Mac holds
 * (src/hooks/useBank.ts reads them; BetaMoney.tsx and the Home widgets draw
 * the result). Nothing is invented: a figure with no rows behind it is null
 * or zero and the screen says so, never a plausible number.
 *
 * Categories are a fixed set, chosen by rules: the user's own merchant
 * patterns first, then those Atlas sorted when asked, then the built-in
 * Danish merchant list below. A payment no rule names is "Other" and counts
 * as unsorted, which is what the Ask Atlas button offers to fix.
 */

// --- Rows, as the store returns them ----------------------------------------------------

export interface BankAccountRow {
  id: string;
  name: string;
  institution: string | null;
  iban_last4: string | null;
  currency: string;
  source: 'csv' | 'gocardless';
  link_id: string | null;
  balance: number | null;
  balance_at: string | null;
  /** Left out of the budget and the projection (a savings or shared account). */
  is_excluded: boolean;
}

export interface BankTxRow {
  id: string;
  account_id: string;
  booked_on: string;
  amount: number;
  currency: string | null;
  text: string;
  balance_after: number | null;
  source: string;
}

export type RuleOrigin = 'user' | 'atlas';
export interface BankRuleRow { id: string; pattern: string; category: string; origin: RuleOrigin }
export interface BankBudgetRow { id: string; category: string; monthly_limit: number }
export interface BankGoalRow { id: string; name: string; target: number; due_on: string | null; account_id: string | null; currency: string | null }
export interface BankGoalMoveRow { id: string; goal_id: string; amount: number; made_on: string }
export type SubscriptionMarkStatus = 'cancelled' | 'ignored';
export interface BankSubMarkRow { id: string; merchant: string; status: SubscriptionMarkStatus; task_id: string | null; created_at: string }
export interface BankLinkRow {
  id: string;
  institution_id: string;
  institution_name: string | null;
  status: string;
  linked_at: string | null;
  expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
}

// --- Categories -------------------------------------------------------------------------

export type CategoryId = 'home' | 'food' | 'transport' | 'fun' | 'shopping' | 'subscriptions' | 'other' | 'income' | 'transfer';
export type CategoryKind = 'spend' | 'income' | 'transfer';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  kind: CategoryKind;
  /** The arc and chip colour on the ink hero. */
  ring: string;
  /** The transaction tile's colour on paper. */
  tint: string;
}

/** The design's five (Home, Food, Travel, Going out, Other) plus what a real ledger needs beside them. */
export const CATEGORIES: readonly CategoryDef[] = [
  { id: 'home', label: 'Home', kind: 'spend', ring: '#8fa9ff', tint: '#3461f2' },
  { id: 'food', label: 'Food', kind: 'spend', ring: '#50dca0', tint: '#0fae76' },
  { id: 'transport', label: 'Transport', kind: 'spend', ring: '#ffb36b', tint: '#e07a1f' },
  { id: 'fun', label: 'Going out', kind: 'spend', ring: '#b6a8ff', tint: '#7854ff' },
  { id: 'shopping', label: 'Shopping', kind: 'spend', ring: '#ff9a9a', tint: '#d0453a' },
  { id: 'subscriptions', label: 'Subscriptions', kind: 'spend', ring: '#7fd6e8', tint: '#1f8aa3' },
  { id: 'other', label: 'Other', kind: 'spend', ring: 'rgba(249, 247, 244, .5)', tint: '#8b8681' },
  { id: 'income', label: 'Income', kind: 'income', ring: '#50dca0', tint: '#0a7a53' },
  { id: 'transfer', label: 'Transfers', kind: 'transfer', ring: 'rgba(249, 247, 244, .3)', tint: '#b6b1aa' },
];

export const CATEGORY_BY_ID: ReadonlyMap<CategoryId, CategoryDef> = new Map(CATEGORIES.map((c) => [c.id, c]));
export const SPEND_CATEGORIES: readonly CategoryDef[] = CATEGORIES.filter((c) => c.kind === 'spend');
export const isCategoryId = (s: string): s is CategoryId => CATEGORY_BY_ID.has(s as CategoryId);
export const categoryOf = (id: CategoryId): CategoryDef => CATEGORY_BY_ID.get(id) ?? CATEGORIES[6];

/**
 * Danish merchants as their names appear on a statement. Whole words only,
 * so "bar" does not catch "barber". Income words only ever match money in.
 */
const BUILTIN: readonly (readonly [CategoryId, readonly string[]])[] = [
  ['food', ['netto', 'føtex', 'fotex', 'bilka', 'rema 1000', 'rema1000', 'lidl', 'aldi', 'irma', 'meny', 'coop', 'superbrugsen', 'kvickly', 'dagli brugsen', 'brugsen', '365discount', 'spar', 'løvbjerg', 'lovbjerg', 'min købmand', 'nemlig.com', 'nemlig', 'fakta', 'lagkagehuset', 'bager', 'bageri', 'slagter']],
  ['fun', ['wolt', 'just eat', 'justeat', 'foodora', 'mcdonalds', "mcdonald's", 'burger king', 'sunset boulevard', 'max burgers', 'joe & the juice', 'starbucks', 'espresso house', 'baresso', 'café', 'cafe', 'restaurant', 'pizza', 'pizzeria', 'sushi', 'bodega', 'bar', 'pub', 'vinbar', 'bryggeri', 'mikkeller', 'nordisk film', 'biograf', 'kino', 'cinemaxx', 'tivoli', 'billetlugen', 'ticketmaster', 'billetto']],
  ['transport', ['dsb', 'rejsekort', 'movia', 'metro', 'midttrafik', 'arriva', 'flixbus', 'sas', 'norwegian', 'circle k', 'q8', 'shell', 'ok benzin', 'ingo', 'uno-x', 'f24', 'uber', 'bolt', 'taxa', 'dantaxi', 'parkering', 'easypark', 'parkman', 'apcoa', 'brobizz', 'storebælt', 'øresundsbron', 'donkey republic', 'lime', 'voi']],
  ['home', ['husleje', 'boligforening', 'boligselskab', 'andelsbolig', 'ejendomsadministration', 'ørsted', 'orsted', 'andel energi', 'norlys', 'ewii', 'seas-nve', 'radius', 'hofor', 'vandværk', 'fjernvarme', 'forsikring', 'tryg', 'topdanmark', 'alm. brand', 'codan', 'gjensidige', 'bauhaus', 'silvan', 'jem & fix', 'harald nyborg', 'ejendomsskat', 'renovation']],
  ['shopping', ['ikea', 'h&m', 'zara', 'magasin', 'matas', 'normal', 'flying tiger', 'power', 'elgiganten', 'proshop', 'amazon', 'zalando', 'boozt', 'apple store', 'imerco', 'intersport', 'sport24', 'jysk', 'søstrene grene', 'illum', 'vinted', 'temu', 'shein', 'aliexpress']],
  ['subscriptions', ['netflix', 'spotify', 'hbo', 'max.com', 'viaplay', 'disney', 'disney plus', 'tv 2 play', 'tv2 play', 'apple.com', 'itunes', 'icloud', 'google', 'youtube', 'microsoft', 'adobe', 'dropbox', 'audible', 'storytel', 'mofibo', 'chatgpt', 'openai', 'anthropic', 'patreon', 'fitness world', 'sats', 'puregym', 'yousee', 'telia', 'telenor', 'cbb', 'lebara', 'oister', 'hiper', 'norlys fiber']],
  ['transfer', ['overførsel', 'overfoersel', 'overført', 'opsparing', 'egen konto', 'budgetkonto', 'transfer', 'own account']],
  ['income', ['løn', 'loen', 'lønoverførsel', 'salary', 'su', 'feriepenge', 'skattestyrelsen', 'udbetaling danmark', 'børne- og ungeydelse', 'boerneydelse']],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A pattern as a whole-word match: no letter or digit on either side. */
const wordRe = (p: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(p.toLowerCase())}(?=$|[^\\p{L}\\p{N}])`, 'u');

const BUILTIN_RULES: readonly { re: RegExp; len: number; category: CategoryId }[] = BUILTIN.flatMap(([category, words]) => words.map((w) => ({ re: wordRe(w), len: w.length, category })));

// --- Merchants --------------------------------------------------------------------------

/** How a payment was made, not who was paid — stripped from the front of a statement line. */
const METHOD_WORDS = new Set([
  'dankort-nota', 'dankort', 'visa/dankort', 'visa', 'mastercard', 'maestro', 'mc/maestro', 'kortkøb', 'nota', 'køb', 'dk-nota', 'ec-nota',
  'bs', 'bs-betaling', 'betaling', 'betalingsservice', 'pbs', 'apple', 'google', 'pay', 'mobilepay', 'mobilepay:', 'kort', 'card', 'purchase', 'købt',
]);

const titleCase = (w: string) => (w === w.toUpperCase() && /\p{L}{2}/u.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w);

/**
 * The merchant a statement line names: method words off the front, then
 * references, dates, amounts and store numbers out, first words kept. The
 * key groups payments for recurrence and rules; the label is what the list
 * shows.
 */
export function merchantOf(text: string): { key: string; label: string } {
  const raw = text.replace(/\s+/g, ' ').trim();
  let words = raw.split(' ').filter(Boolean);
  // "Apple Pay" and "Google Pay" are wallets; "Apple.com" and "Google One" are merchants.
  while (words.length > 1) {
    const w = words[0].toLowerCase().replace(/[.:,]+$/, '');
    const nextIsPay = words[1]?.toLowerCase() === 'pay';
    if ((w === 'apple' || w === 'google') && !nextIsPay) break;
    if (!METHOD_WORDS.has(w) && !METHOD_WORDS.has(words[0].toLowerCase())) break;
    words = words.slice(1);
  }
  const kept = words.filter((w) => {
    if (/\d/.test(w) && (w.match(/\d/g) ?? []).length >= 3) return false; // references, card masks, store numbers
    if (/^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/.test(w)) return false; // dates
    if (/^[-+]?\d+([.,]\d+)*$/.test(w)) return false; // amounts
    if (/^(dkk|kr\.?|eur|d\.)$/i.test(w)) return false;
    if (/^x{2,}\d*$/i.test(w) || /^\*+\d*$/.test(w)) return false;
    return true;
  });
  const clean = (kept.length ? kept : words).map((w) => w.replace(/^[*#:,.-]+|[*#:,-]+$/g, '')).filter(Boolean);
  const label = clean.slice(0, 3).map(titleCase).join(' ') || raw.slice(0, 40) || 'Transaction';
  const key = clean.slice(0, 2).join(' ').toLowerCase() || label.toLowerCase();
  return { key, label };
}

// --- Categorising -----------------------------------------------------------------------

export type CategoryOrigin = RuleOrigin | 'builtin';

/**
 * The category for one payment: the most specific user rule, else the most
 * specific rule Atlas wrote, else the built-in list. Unmatched money in is
 * income; unmatched money out is Other, and unsorted.
 */
export function categorise(text: string, amount: number, rules: readonly Pick<BankRuleRow, 'pattern' | 'category' | 'origin'>[]): { category: CategoryId; origin: CategoryOrigin | null; unsorted: boolean } {
  const hay = ` ${text.toLowerCase().replace(/\s+/g, ' ')} ${merchantOf(text).key} `;
  for (const origin of ['user', 'atlas'] as const) {
    let best: { category: CategoryId; len: number } | null = null;
    for (const r of rules) {
      if (r.origin !== origin || !isCategoryId(r.category) || !r.pattern.trim()) continue;
      if (!wordRe(r.pattern.trim()).test(hay)) continue;
      if (!best || r.pattern.length > best.len) best = { category: r.category, len: r.pattern.length };
    }
    if (best) return { category: best.category, origin, unsorted: false };
  }
  let best: { category: CategoryId; len: number } | null = null;
  for (const r of BUILTIN_RULES) {
    if (r.category === 'income' && amount <= 0) continue;
    if (!r.re.test(hay)) continue;
    if (!best || r.len > best.len) best = { category: r.category, len: r.len };
  }
  if (best) return { category: best.category, origin: 'builtin', unsorted: false };
  return amount > 0 ? { category: 'income', origin: null, unsorted: false } : { category: 'other', origin: null, unsorted: true };
}

export interface LedgerTx extends BankTxRow {
  merchant: string;
  merchantKey: string;
  category: CategoryId;
  origin: CategoryOrigin | null;
  unsorted: boolean;
  /** Its account is left out of the budget and the projection. */
  excluded: boolean;
}

/** Every row with its merchant and category, newest first. */
export function buildLedger(txs: readonly BankTxRow[], rules: readonly BankRuleRow[], accounts: readonly Pick<BankAccountRow, 'id' | 'is_excluded'>[]): LedgerTx[] {
  const excluded = new Set(accounts.filter((a) => a.is_excluded).map((a) => a.id));
  return txs
    .map((t) => {
      const m = merchantOf(t.text);
      const c = categorise(t.text, t.amount, rules);
      return { ...t, merchant: m.label, merchantKey: m.key, category: c.category, origin: c.origin, unsorted: c.unsorted, excluded: excluded.has(t.account_id) };
    })
    .sort((a, b) => (a.booked_on === b.booked_on ? 0 : a.booked_on < b.booked_on ? 1 : -1));
}

// --- Days -------------------------------------------------------------------------------

const DAY_MS = 86400000;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** A local calendar day as YYYY-MM-DD. */
export function dayOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const utc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY_MS);
export function addDays(day: string, n: number): string {
  const d = new Date(utc(day) + n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** The same day of the month n months on, clamped to the month's last day (31 Jan + 1 is 28 Feb). */
export function addMonths(day: string, n: number): string {
  const y0 = Number(day.slice(0, 4));
  const m0 = Number(day.slice(5, 7)) - 1 + n;
  const y = y0 + Math.floor(m0 / 12);
  const m = ((m0 % 12) + 12) % 12 + 1;
  const d = Math.min(Number(day.slice(8, 10)), daysInMonth(y, m));
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
export const monthOf = (day: string) => day.slice(0, 7);

// --- Spend and the budget ring ----------------------------------------------------------

/**
 * Net spend per spend category in a month (YYYY-MM): money out less refunds,
 * from accounts in the budget. Never below zero for a category.
 */
export function monthSpend(ledger: readonly LedgerTx[], month: string, uptoDay?: number): Map<CategoryId, number> {
  const out = new Map<CategoryId, number>();
  for (const t of ledger) {
    if (t.excluded || monthOf(t.booked_on) !== month) continue;
    if (uptoDay !== undefined && Number(t.booked_on.slice(8, 10)) > uptoDay) continue;
    if (categoryOf(t.category).kind !== 'spend') continue;
    out.set(t.category, (out.get(t.category) ?? 0) - t.amount);
  }
  for (const [k, v] of out) out.set(k, Math.max(0, Math.round(v * 100) / 100));
  return out;
}

export const sumOf = (m: ReadonlyMap<unknown, number>) => [...m.values()].reduce((a, v) => a + v, 0);

export const RING_R = 138;
const RING_C = 2 * Math.PI * RING_R;

export interface BudgetArc { id: CategoryId; label: string; colour: string; dash: string; offset: number; spent: number; limit: number | null; share: number }
export interface BudgetRing {
  /** `budget`: limits are set and the ring is the budget. `spend`: no limits, the ring is this month's spend. */
  mode: 'budget' | 'spend' | 'empty';
  budget: number;
  spent: number;
  left: number;
  /** How far through the month today is, 0–1. */
  pace: number;
  /** stroke-dashoffset that puts the pace tick on the ring. */
  paceOffset: number;
  paceDash: string;
  /** Spend minus where an even pace would be; positive is ahead of pace. */
  aheadBy: number;
  over: boolean;
  arcs: BudgetArc[];
}

/** The ring: each category's spend laid end to end on the budget's circle, and the even-pace tick. */
export function budgetRing(spend: ReadonlyMap<CategoryId, number>, limits: ReadonlyMap<CategoryId, number>, today: string, grown: boolean): BudgetRing {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const pace = Number(today.slice(8, 10)) / daysInMonth(y, m);
  const budget = SPEND_CATEGORIES.reduce((a, c) => a + Math.max(0, limits.get(c.id) ?? 0), 0);
  const spent = sumOf(spend);
  const mode: BudgetRing['mode'] = budget > 0 ? 'budget' : spent > 0 ? 'spend' : 'empty';
  const whole = mode === 'budget' ? Math.max(budget, spent) : spent || 1;
  let acc = 0;
  const arcs: BudgetArc[] = SPEND_CATEGORIES.filter((c) => (spend.get(c.id) ?? 0) > 0 || (limits.get(c.id) ?? 0) > 0).map((c) => {
    const s = spend.get(c.id) ?? 0;
    const len = grown ? Math.min(RING_C - acc, (s / whole) * RING_C) : 0;
    const arc = { id: c.id, label: c.label, colour: c.ring, dash: `${Math.max(0, len).toFixed(1)} ${RING_C.toFixed(1)}`, offset: acc === 0 ? 0 : -Number(acc.toFixed(1)), spent: s, limit: (limits.get(c.id) ?? 0) > 0 ? limits.get(c.id) ?? null : null, share: spent > 0 ? s / spent : 0 };
    acc += Math.max(0, len);
    return arc;
  });
  const aheadBy = mode === 'budget' ? spent - budget * pace : 0;
  return {
    mode, budget, spent, left: budget - spent, pace,
    paceOffset: -Number((RING_C * Math.min(1, pace)).toFixed(1)),
    paceDash: `2 ${(RING_C - 2).toFixed(1)}`,
    aheadBy, over: mode === 'budget' && spent > budget * pace,
    arcs,
  };
}

/** The line under the big number, in the design's words. */
export function paceSentence(r: BudgetRing, fmt: (n: number) => string): string {
  if (r.mode === 'empty') return 'Nothing spent this month yet';
  if (r.mode === 'spend') return 'Set monthly limits to see your pace';
  if (r.spent > r.budget) return `Over budget by ${fmt(r.spent - r.budget)}`;
  if (r.aheadBy > 0.5) return `Ahead of an even pace by ${fmt(r.aheadBy)}`;
  return 'On pace for the month';
}

/** A category's month so far, day by day — the line when a category is picked. */
export function categoryMonth(ledger: readonly LedgerTx[], cat: CategoryId, today: string): { cumulative: number[]; total: number; dim: number } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const dim = daysInMonth(y, m);
  const upto = Number(today.slice(8, 10));
  const daily = new Array<number>(upto).fill(0);
  const month = today.slice(0, 7);
  for (const t of ledger) {
    if (t.excluded || t.category !== cat || monthOf(t.booked_on) !== month) continue;
    const d = Number(t.booked_on.slice(8, 10));
    if (d >= 1 && d <= upto) daily[d - 1] -= t.amount;
  }
  const cumulative: number[] = [];
  let run = 0;
  for (const v of daily) { run += v; cumulative.push(Math.max(0, Math.round(run * 100) / 100)); }
  return { cumulative, total: cumulative[cumulative.length - 1] ?? 0, dim };
}

/** The category line on the 300×100 box: spend so far, the even-pace diagonal to the limit, and the limit itself. */
export function categoryLinePoints(cumulative: readonly number[], dim: number, limit: number | null): { line: string; area: string; pace: string; limitY: number | null } {
  const top = Math.max(limit ?? 0, ...cumulative, 1) * 1.08;
  const y = (v: number) => (100 - (v / top) * 92).toFixed(1);
  const x = (day: number) => ((day / dim) * 300).toFixed(1);
  const pts = [`0,${y(0)}`, ...cumulative.map((v, i) => `${x(i + 1)},${y(v)}`)];
  const line = pts.join(' ');
  const lastX = x(cumulative.length);
  return {
    line,
    area: `0,100 ${line} ${lastX},100`,
    pace: limit ? `0,${y(0)} 300,${y(limit)}` : '',
    limitY: limit ? Number(y(limit)) : null,
  };
}

// --- Recurring payments -----------------------------------------------------------------

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface Recurring {
  /** merchant key + direction, stable across imports. */
  key: string;
  merchant: string;
  merchantKey: string;
  category: CategoryId;
  cadence: Cadence;
  /** Median signed amount per charge. */
  amount: number;
  count: number;
  last: string;
  next: string;
  accountIds: string[];
  /** Every account it was seen on is left out of the budget. */
  excluded: boolean;
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function stepOf(cadence: Cadence, day: string, n = 1): string {
  if (cadence === 'weekly') return addDays(day, 7 * n);
  return addMonths(day, n * (cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12));
}

const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, monthly: 30.4, quarterly: 91, yearly: 365 };

/**
 * Payments that repeat: the same merchant, the same direction, at a steady
 * interval and a steady amount, and seen recently enough to still be going.
 * Two monthly charges count only when they are the same amount to the øre
 * neighbourhood; otherwise three are needed.
 */
export function detectRecurring(ledger: readonly LedgerTx[], today: string): Recurring[] {
  const groups = new Map<string, LedgerTx[]>();
  for (const t of ledger) {
    if (!t.amount) continue;
    const key = `${t.merchantKey}|${t.amount < 0 ? 'out' : 'in'}`;
    const g = groups.get(key);
    if (g) g.push(t); else groups.set(key, [t]);
  }
  const out: Recurring[] = [];
  for (const [key, txs] of groups) {
    const byDay = new Map<string, number>();
    for (const t of txs) byDay.set(t.booked_on, (byDay.get(t.booked_on) ?? 0) + t.amount);
    const days = [...byDay.keys()].sort();
    if (days.length < 2) continue;
    const amounts = days.map((d) => byDay.get(d) ?? 0);
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d));
    const g = median(gaps);
    const share = (lo: number, hi: number) => gaps.filter((x) => x >= lo && x <= hi).length / gaps.length;
    let cadence: Cadence | null = null;
    if (g >= 6 && g <= 8 && days.length >= 4 && share(5, 9) >= 0.75) cadence = 'weekly';
    else if (g >= 26 && g <= 35 && share(24, 38) >= 0.7) cadence = 'monthly';
    else if (g >= 84 && g <= 98 && share(80, 102) === 1) cadence = 'quarterly';
    else if (g >= 350 && g <= 380 && share(340, 390) === 1) cadence = 'yearly';
    if (!cadence) continue;
    const m = median(amounts);
    const steady = amounts.filter((a) => Math.abs(a - m) <= Math.abs(m) * 0.25).length / amounts.length;
    if (steady < 0.7) continue;
    if (cadence === 'monthly' && days.length === 2 && Math.abs(amounts[0] - amounts[1]) > Math.abs(m) * 0.02) continue;
    if (cadence === 'weekly' && days.length < 4) continue;
    const last = days[days.length - 1];
    const since = daysBetween(last, today);
    if (since > CADENCE_DAYS[cadence] + Math.max(7, CADENCE_DAYS[cadence] * 0.25)) continue;
    let next = stepOf(cadence, last);
    // Due a few days ago and not booked yet: it is late, not skipped.
    for (let guard = 0; next < today && guard < 60; guard++) {
      if (daysBetween(next, today) <= 5) { next = today; break; }
      next = stepOf(cadence, next);
    }
    const newest = txs.reduce((a, t) => (t.booked_on > a.booked_on ? t : a), txs[0]);
    const accountIds = [...new Set(txs.map((t) => t.account_id))];
    out.push({
      key, merchant: newest.merchant, merchantKey: newest.merchantKey, category: newest.category, cadence,
      amount: Math.round(m * 100) / 100, count: days.length, last, next, accountIds,
      excluded: txs.every((t) => t.excluded),
    });
  }
  return out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

// --- Subscriptions ----------------------------------------------------------------------

export interface Subscription {
  key: string;
  merchant: string;
  merchantKey: string;
  category: CategoryId;
  cadence: Cadence;
  /** Per charge, positive. */
  amount: number;
  /** What it costs a month. */
  monthly: number;
  next: string;
  status: 'active' | 'cancelled';
  markId: string | null;
  taskId: string | null;
  /** The merchant's own page for ending it, when Atlas knows it. */
  url: string | null;
}

/** Account pages where a subscription is ended. Only addresses that are the merchant's own. */
const CANCEL_PAGES: readonly (readonly [string, string])[] = [
  ['netflix', 'https://www.netflix.com/cancelplan'],
  ['spotify', 'https://www.spotify.com/account/subscription/'],
  ['youtube', 'https://www.youtube.com/paid_memberships'],
  ['apple.com', 'https://apps.apple.com/account/subscriptions'],
  ['itunes', 'https://apps.apple.com/account/subscriptions'],
  ['icloud', 'https://apps.apple.com/account/subscriptions'],
  ['google', 'https://myaccount.google.com/payments-and-subscriptions'],
  ['adobe', 'https://account.adobe.com/plans'],
  ['disney', 'https://www.disneyplus.com/account'],
  ['microsoft', 'https://account.microsoft.com/services'],
  ['dropbox', 'https://www.dropbox.com/account/plan'],
  ['viaplay', 'https://viaplay.dk/account'],
];

export function cancelPageFor(merchantKey: string): string | null {
  const k = merchantKey.toLowerCase();
  for (const [word, url] of CANCEL_PAGES) if (wordRe(word).test(` ${k} `)) return url;
  return null;
}

const NOT_SUBSCRIPTIONS: ReadonlySet<CategoryId> = new Set(['home', 'transfer', 'income']);

/**
 * Subscriptions are the recurring payments out that are monthly, quarterly or
 * yearly and are not rent, bills or transfers. One the user marked cancelled
 * stays listed, struck through, and stops counting; one marked "not a
 * subscription" leaves the list.
 */
export function subscriptionsOf(recurring: readonly Recurring[], marks: readonly BankSubMarkRow[]): Subscription[] {
  const byMerchant = new Map(marks.map((m) => [m.merchant, m]));
  return recurring
    .filter((r) => r.amount < 0 && r.cadence !== 'weekly' && !NOT_SUBSCRIPTIONS.has(r.category))
    .flatMap<Subscription>((r) => {
      const mark = byMerchant.get(r.key);
      if (mark?.status === 'ignored') return [];
      const amount = Math.abs(r.amount);
      const monthly = r.cadence === 'monthly' ? amount : r.cadence === 'quarterly' ? amount / 3 : amount / 12;
      return [{
        key: r.key, merchant: r.merchant, merchantKey: r.merchantKey, category: r.category, cadence: r.cadence, amount,
        monthly: Math.round(monthly * 100) / 100, next: r.next,
        status: mark?.status === 'cancelled' ? 'cancelled' : 'active', markId: mark?.id ?? null, taskId: mark?.task_id ?? null,
        url: cancelPageFor(r.merchantKey),
      }];
    })
    .sort((a, b) => (a.status === b.status ? b.monthly - a.monthly : a.status === 'active' ? -1 : 1));
}

export function subscriptionTotals(subs: readonly Subscription[]): { monthly: number; count: number; saved: number } {
  const active = subs.filter((s) => s.status === 'active');
  return {
    monthly: Math.round(active.reduce((a, s) => a + s.monthly, 0) * 100) / 100,
    count: active.length,
    saved: Math.round(subs.filter((s) => s.status === 'cancelled').reduce((a, s) => a + s.monthly, 0) * 100) / 100,
  };
}

// --- The thirty-day projection ----------------------------------------------------------

/**
 * Everyday spending per day: money out over the last `window` days that is
 * not a recurring payment and not a transfer, divided by the days the ledger
 * actually covers in that window.
 */
export function dailySpend(ledger: readonly LedgerTx[], recurring: readonly Recurring[], today: string, window = 60): { perDay: number; days: number } {
  const recurringKeys = new Set(recurring.map((r) => r.key));
  const from = addDays(today, -window);
  let earliest: string | null = null;
  let total = 0;
  for (const t of ledger) {
    if (t.excluded || t.booked_on < from || t.booked_on > today) continue;
    if (!earliest || t.booked_on < earliest) earliest = t.booked_on;
    if (categoryOf(t.category).kind !== 'spend') continue;
    if (recurringKeys.has(`${t.merchantKey}|${t.amount < 0 ? 'out' : 'in'}`)) continue;
    total -= t.amount;
  }
  if (!earliest) return { perDay: 0, days: 0 };
  const days = Math.max(1, daysBetween(earliest, today));
  return { perDay: Math.max(0, total / days), days };
}

export interface FlowEvent {
  id: string;
  /** Days from today, 1–30. */
  day: number;
  date: string;
  label: string;
  amount: number;
  balanceAfter: number;
  category: CategoryId;
  cadence: Cadence;
}

export interface Projection {
  start: number;
  /** A real starting balance was known; otherwise the line is the change from today. */
  known: boolean;
  /** Balance at the end of each day, today first (31 values for 30 days). */
  points: number[];
  events: FlowEvent[];
  perDay: number;
  min: number;
  max: number;
}

/** The next `days` days: everyday spending each day, recurring payments and income on their dates. */
export function projectCashflow(opts: { start: number | null; recurring: readonly Recurring[]; perDay: number; today: string; days?: number; skip?: ReadonlySet<string> }): Projection {
  const { recurring, perDay, today } = opts;
  const days = opts.days ?? 30;
  const skip = opts.skip ?? new Set<string>();
  const known = opts.start !== null;
  let bal = opts.start ?? 0;
  const due = new Map<number, { r: Recurring; date: string }[]>();
  for (const r of recurring) {
    if (r.excluded || skip.has(r.key)) continue;
    let date = r.next;
    for (let guard = 0; guard < 40 && daysBetween(today, date) <= days; guard++) {
      const d = daysBetween(today, date);
      if (d >= 1) { const list = due.get(d) ?? []; list.push({ r, date }); due.set(d, list); }
      if (d === 0) { const list = due.get(1) ?? []; list.push({ r, date: addDays(today, 1) }); due.set(1, list); }
      date = stepOf(r.cadence, date);
    }
  }
  const points = [bal];
  const events: FlowEvent[] = [];
  for (let d = 1; d <= days; d++) {
    bal -= perDay;
    const today_ = due.get(d) ?? [];
    for (const { r } of today_) bal += r.amount;
    for (const { r, date } of today_) {
      if (r.cadence === 'weekly') continue;
      events.push({ id: `${r.key}@${date}`, day: d, date, label: r.merchant, amount: r.amount, balanceAfter: Math.round(bal), category: r.category, cadence: r.cadence });
    }
    points.push(Math.round(bal * 100) / 100);
  }
  return { start: opts.start ?? 0, known, points, events, perDay, min: Math.min(...points), max: Math.max(...points) };
}

/** The projection on the 300×100 box, with a zero line when the balance is projected to cross it. */
export function projectionPoints(p: Projection): { line: string; area: string; y: (v: number) => number; zeroY: number | null } {
  const lo = Math.min(p.min, p.known && p.min < 0 ? 0 : p.min);
  const hi = Math.max(p.max, lo + 1);
  const y = (v: number) => Number((100 - ((v - lo) / (hi - lo)) * 84 - 8).toFixed(1));
  const n = Math.max(1, p.points.length - 1);
  const line = p.points.map((v, i) => `${((i / n) * 300).toFixed(1)},${y(v)}`).join(' ');
  return { line, area: `0,100 ${line} 300,100`, y, zeroY: p.known && p.min < 0 ? y(0) : null };
}

/** The chips worth drawing: the largest events, at most `max`, in date order. */
export function chipEvents(events: readonly FlowEvent[], max = 6): FlowEvent[] {
  return [...events].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, max).sort((a, b) => a.day - b.day);
}

/** One sentence for the picked chip, from the projection and nothing else. */
export function eventSentence(ev: FlowEvent, p: Projection, fmt: (n: number) => string, fmtDay: (day: string) => string): string {
  const when = fmtDay(ev.date);
  if (ev.amount > 0) {
    const how = ev.cadence === 'monthly' ? 'as it does every month' : ev.cadence === 'yearly' ? 'as it does every year' : 'as it does every quarter';
    return `${ev.label} of ${fmt(ev.amount)} is due around ${when}, ${how}.`;
  }
  const verb = ev.cadence === 'yearly' ? 'renews' : 'leaves';
  if (!p.known) return `${ev.label}, ${fmt(-ev.amount)}, ${verb} around ${when}.`;
  const income = p.events.find((e) => e.amount > 0 && e.day > ev.day);
  const after = `About ${fmt(ev.balanceAfter)} is left after it`;
  return `${ev.label}, ${fmt(-ev.amount)}, ${verb} around ${when}. ${after}${income ? `, ${income.day - ev.day} days before ${income.label} arrives.` : '.'}`;
}

// --- Goals ------------------------------------------------------------------------------

export interface GoalView {
  id: string;
  name: string;
  target: number;
  saved: number;
  /** 0–100. */
  pct: number;
  left: number;
  due_on: string | null;
  /** What it takes a month to arrive by the date; null without a date or once reached. */
  perMonth: number | null;
  /** The saved amount is the linked account's balance, not the contributions. */
  linked: boolean;
  accountName: string | null;
  done: boolean;
}

export function goalView(goal: BankGoalRow, moves: readonly BankGoalMoveRow[], accounts: readonly Pick<BankAccountRow, 'id' | 'name' | 'balance'>[], today: string): GoalView {
  const acct = goal.account_id ? accounts.find((a) => a.id === goal.account_id) ?? null : null;
  const linked = !!acct && acct.balance !== null;
  const saved = linked ? Math.max(0, acct?.balance ?? 0) : moves.filter((m) => m.goal_id === goal.id).reduce((a, m) => a + m.amount, 0);
  const target = Math.max(0, goal.target);
  const left = Math.max(0, target - saved);
  let perMonth: number | null = null;
  if (goal.due_on && left > 0 && goal.due_on > today) {
    const months = Math.max(1, Math.ceil(daysBetween(today, goal.due_on) / 30.44));
    perMonth = Math.ceil(left / months);
  }
  return {
    id: goal.id, name: goal.name, target, saved: Math.round(saved * 100) / 100,
    pct: target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0,
    left, due_on: goal.due_on, perMonth, linked, accountName: acct?.name ?? null, done: target > 0 && saved >= target,
  };
}

/** The quick-add step on a goal card: a round sum in the goal's currency. */
export const quickStep = (currency: string) => (/^(DKK|SEK|NOK|CZK|ISK)$/.test(currency) ? 500 : 100);

// --- Balances ---------------------------------------------------------------------------

/** The currency most of the budget's accounts are in. */
export function primaryCurrency(accounts: readonly Pick<BankAccountRow, 'currency' | 'is_excluded'>[]): string {
  const counts = new Map<string, number>();
  for (const a of accounts) if (!a.is_excluded) counts.set(a.currency, (counts.get(a.currency) ?? 0) + 1);
  let best = 'DKK';
  let n = 0;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best;
}

/** What the budget's accounts hold now, when every one of them says. */
export function budgetBalance(accounts: readonly Pick<BankAccountRow, 'balance' | 'is_excluded'>[]): number | null {
  const inBudget = accounts.filter((a) => !a.is_excluded);
  if (!inBudget.length || inBudget.some((a) => a.balance === null)) return null;
  return inBudget.reduce((a, x) => a + (x.balance ?? 0), 0);
}

// --- Ask Atlas to sort these ------------------------------------------------------------

export interface SortItem { key: string; merchant: string; total: number; count: number }

/** Unsorted merchants, biggest first: what the button offers to send. */
export function unsortedMerchants(ledger: readonly LedgerTx[], limit = 40): SortItem[] {
  const by = new Map<string, SortItem>();
  for (const t of ledger) {
    if (!t.unsorted) continue;
    const cur = by.get(t.merchantKey) ?? { key: t.merchantKey, merchant: t.merchant, total: 0, count: 0 };
    cur.total += -t.amount;
    cur.count += 1;
    by.set(t.merchantKey, cur);
  }
  return [...by.values()].map((s) => ({ ...s, total: Math.round(s.total * 100) / 100 })).sort((a, b) => b.total - a.total).slice(0, limit);
}

const SORTABLE: readonly CategoryId[] = ['home', 'food', 'transport', 'fun', 'shopping', 'subscriptions', 'other', 'transfer'];

/**
 * The question sent to Atlas. Merchant names and amounts only — no dates, no
 * accounts, no balances — and the reply is asked for as JSON so it can be
 * read back without guessing.
 */
export function buildSortPrompt(items: readonly SortItem[], currency: string): string {
  const lines = items.map((i) => `- ${i.merchant}: ${i.total.toFixed(2)} ${currency} over ${i.count} ${i.count === 1 ? 'payment' : 'payments'}`);
  return [
    'Sort these card payments into budget categories for me.',
    `Categories: ${SORTABLE.join(', ')}. ("fun" is eating out, bars and entertainment; "home" is rent, utilities and insurance.)`,
    'Reply with JSON only: one object mapping each merchant name, exactly as written below, to one category. Use "other" when you are not sure. This is a one-off sorting job; do not remember it.',
    '',
    ...lines,
  ].join('\n');
}

/** Read Atlas's reply back into rules; anything not one of the listed merchants or categories is dropped. */
export function parseSortAnswer(text: string, items: readonly SortItem[]): { key: string; merchant: string; category: CategoryId }[] {
  const byName = new Map(items.map((i) => [i.merchant.toLowerCase().trim(), i]));
  const pairs: [string, string][] = [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (typeof v === 'string') pairs.push([k, v]);
    } catch { /* fall back to lines */ }
  }
  if (!pairs.length) {
    for (const line of text.split('\n')) {
      const m = /^[\s\-*•]*"?(.+?)"?\s*(?::|=>|->|—|–)\s*"?([a-z]+)"?[\s,.]*$/i.exec(line);
      if (m) pairs.push([m[1], m[2]]);
    }
  }
  const out: { key: string; merchant: string; category: CategoryId }[] = [];
  const seen = new Set<string>();
  for (const [name, cat] of pairs) {
    const item = byName.get(name.toLowerCase().trim());
    const c = cat.toLowerCase().trim();
    if (!item || seen.has(item.key) || !(SORTABLE as readonly string[]).includes(c)) continue;
    seen.add(item.key);
    out.push({ key: item.key, merchant: item.merchant, category: c as CategoryId });
  }
  return out;
}
