/**
 * Netbank CSV exports, read on this Mac — the first way transactions reach
 * the Beta Money screen (row 31 of docs/design-sync/2026-10-28-left-out-features.md).
 *
 * Danish banks do not agree on a format. Danske Bank writes `;`-separated
 * rows with no header at all, decimal commas and `dd.mm.yyyy`; Nordea writes
 * a header with `Bogføringsdato` and `yyyy/mm/dd`; Lunar writes commas and
 * ISO dates. Most of them write Windows-1252, not UTF-8. So nothing here
 * assumes: the delimiter, the decimal mark and the header are each detected,
 * every date and amount is parsed on its own, and when the header names are
 * not ones Atlas knows the screen shows a column-mapping step pre-filled with
 * a guess read from the data itself.
 *
 * Re-importing an overlapping export must not double anything. Each row gets
 * an id from its account, day, amount, text and how many identical rows came
 * before it in the same file, so the second coffee of a day stays a second
 * coffee and the same coffee read again from next month's export is skipped
 * by the store (`bank_store_transactions`, INSERT OR IGNORE).
 *
 * Pure: the page reads the file, this turns its bytes into rows.
 */

export type CsvDelimiter = ';' | ',' | '\t';
export type DecimalMark = ',' | '.';
export type ColumnRole = 'date' | 'text' | 'amount' | 'inflow' | 'outflow' | 'balance' | 'currency' | 'ignore';

export const ROLE_LABEL: Record<ColumnRole, string> = {
  date: 'Date',
  text: 'Text',
  amount: 'Amount',
  inflow: 'Money in',
  outflow: 'Money out',
  balance: 'Balance',
  currency: 'Currency',
  ignore: 'Ignore',
};

export const ROLES: readonly ColumnRole[] = ['date', 'text', 'amount', 'inflow', 'outflow', 'balance', 'currency', 'ignore'];

// --- Bytes and cells -----------------------------------------------------------------

/**
 * The file's text. UTF-8 when the bytes are valid UTF-8, otherwise
 * Windows-1252 — which is what most Danish netbanks still write, and which a
 * UTF-8 read would turn every æ, ø and å into a replacement character.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  let b = bytes;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    try { return new TextDecoder('utf-16le').decode(b.subarray(2)); } catch { /* fall through */ }
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(b);
    } catch {
      // Latin-1 agrees with Windows-1252 on every Danish letter.
      let out = '';
      for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
      return out;
    }
  }
}

/** Splits outside quotes, so a `;` inside a quoted text does not count. */
function countOutsideQuotes(line: string, ch: string): number {
  let n = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === ch) n++;
  }
  return n;
}

/**
 * The delimiter: the candidate that appears the same, non-zero number of
 * times on most of the first lines. `;` wins a tie, since a file with decimal
 * commas cannot also use commas between its columns.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const hint = /^sep=(.)\s*$/im.exec(text.split(/\r?\n/, 1)[0] ?? '');
  if (hint && (hint[1] === ';' || hint[1] === ',' || hint[1] === '\t')) return hint[1] as CsvDelimiter;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^sep=/i.test(l)).slice(0, 12);
  const candidates: CsvDelimiter[] = [';', '\t', ','];
  let best: CsvDelimiter = ';';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const nonzero = counts.filter((c) => c > 0);
    if (!nonzero.length) continue;
    const mode = [...nonzero].sort((a, b) => nonzero.filter((x) => x === b).length - nonzero.filter((x) => x === a).length)[0];
    const consistent = counts.filter((c) => c === mode).length;
    const score = consistent * 10 + Math.min(mode, 9);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** RFC 4180 rows: quoted cells, doubled quotes, line breaks inside quotes. */
export function parseCsv(input: string, delimiter: CsvDelimiter): string[][] {
  // Excel's "sep=;" hint is a line of its own, not a row.
  const text = input.replace(/^sep=.?[ \t]*\r?\n/i, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; continue; }
    if (c === delimiter) { row.push(cell); cell = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows
    .map((r) => r.map((x) => x.trim()))
    .filter((r) => r.some((x) => x !== '') && !(r.length === 1 && /^sep=/i.test(r[0])));
}

// --- Dates and amounts ---------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

function validDay(y: number, m: number, d: number): boolean {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * A bank date as `YYYY-MM-DD`: `yyyy-mm-dd`, `yyyy/mm/dd`, `yyyy.mm.dd`, and
 * the day-first forms Danish banks write — `dd-mm-yyyy`, `dd.mm.yyyy`,
 * `dd/mm/yyyy`, also with a two-digit year. Month-first is never assumed: no
 * Danish export writes it, and guessing it would move money between months.
 */
export function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/^"|"$/g, '');
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:$|[T\s])/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDay(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }
  m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{2}|\d{4})(?:$|\s)/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const [mo, d] = [Number(m[2]), Number(m[1])];
    return validDay(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }
  return null;
}

const CURRENCY_AFFIX = /^(?:kr\.?|dkk|eur|€|\$|usd|sek|nok|gbp|£)|(?:kr\.?|dkk|eur|€|usd|sek|nok|gbp|£)$/gi;

/**
 * Which mark is the decimal one in this file: each value with two or fewer
 * digits after its last `,` or `.` votes for that mark; a value with both
 * marks votes for the last one. A file that never says defaults to the
 * Danish comma.
 */
export function detectDecimal(values: readonly string[]): DecimalMark {
  let comma = 0;
  let dot = 0;
  for (const raw of values) {
    const v = raw.replace(CURRENCY_AFFIX, '').replace(/[\s']/g, '');
    const lc = v.lastIndexOf(',');
    const ld = v.lastIndexOf('.');
    if (lc >= 0 && ld >= 0) { if (lc > ld) comma++; else dot++; continue; }
    if (lc >= 0 && /^\d{1,2}$/.test(v.slice(lc + 1).replace(/-$/, ''))) comma++;
    else if (ld >= 0 && /^\d{1,2}$/.test(v.slice(ld + 1).replace(/-$/, ''))) dot++;
  }
  return dot > comma ? '.' : ',';
}

/**
 * An amount as a number: `-1.234,56`, `1,234.56`, `−45,00`, `45,00-`,
 * `(45.00)`, `kr. 45,00`, `1 234,56`. Null when the cell is not a number at
 * all, so a header or a status column never becomes money.
 */
export function parseAmount(raw: string, decimal: DecimalMark = ','): number | null {
  let s = raw.trim().replace(/^"|"$/g, '').replace(/−/g, '-').replace(CURRENCY_AFFIX, '').replace(/[\s']/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lc = s.lastIndexOf(',');
  const ld = s.lastIndexOf('.');
  let mark: DecimalMark | null;
  if (lc >= 0 && ld >= 0) mark = lc > ld ? ',' : '.';
  else if (lc >= 0) mark = decimal === ',' ? ',' : /^\d{1,3}(,\d{3})+$/.test(s) ? null : ',';
  else if (ld >= 0) mark = decimal === '.' ? '.' : /^\d{1,3}(\.\d{3})+$/.test(s) ? null : '.';
  else mark = null;
  let digits: string;
  if (mark === null) digits = s.replace(/[.,]/g, '');
  else {
    const at = s.lastIndexOf(mark);
    const whole = s.slice(0, at);
    // Thousands groups must be real groups of three under the other mark;
    // "1.2.3,4,5" is not a number however it is read.
    const other = mark === ',' ? '.' : ',';
    if (whole.includes(mark)) return null;
    const groups = mark === ',' ? /^\d{1,3}(\.\d{3})+$/ : /^\d{1,3}(,\d{3})+$/;
    if (whole.includes(other) && !groups.test(whole)) return null;
    digits = `${whole.replace(/[.,]/g, '')}.${s.slice(at + 1)}`;
  }
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// --- Headers -------------------------------------------------------------------------

const HEADER_WORDS: Record<Exclude<ColumnRole, 'ignore'>, readonly string[]> = {
  date: ['dato', 'bogføringsdato', 'bogføringsdag', 'bogført', 'bogfort', 'bogfoert', 'date', 'booking date', 'bookingdate', 'posting date', 'transaction date', 'transaktionsdato', 'købsdato'],
  text: ['tekst', 'beskrivelse', 'description', 'text', 'posteringstekst', 'transaktionstekst', 'navn', 'modtager', 'afsender', 'merchant', 'payee', 'details', 'meddelelse', 'name', 'reference'],
  amount: ['beløb', 'belob', 'beloeb', 'amount', 'transaktionsbeløb', 'sum', 'value'],
  inflow: ['indbetaling', 'ind', 'kredit', 'credit', 'indsat', 'money in', 'paid in'],
  outflow: ['udbetaling', 'ud', 'debet', 'debit', 'hævet', 'money out', 'paid out'],
  balance: ['saldo', 'balance', 'bogført saldo', 'disponibel saldo', 'running balance'],
  currency: ['valuta', 'currency', 'møntsort'],
};

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\b(dkk|eur|usd|sek|nok|kr)\b/g, ' ').replace(/[^a-z0-9æøåäöü ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The role a header name names, or null when Atlas does not know the word. */
export function headerRole(name: string): Exclude<ColumnRole, 'ignore'> | null {
  const n = normaliseHeader(name);
  if (!n) return null;
  for (const role of Object.keys(HEADER_WORDS) as Exclude<ColumnRole, 'ignore'>[]) {
    if (HEADER_WORDS[role].includes(n)) return role;
  }
  // "Beløb i DKK", "Rentedato" read after the exact words fail.
  if (/^bel(ø|o|oe)b/.test(n)) return 'amount';
  if (/saldo|balance/.test(n)) return 'balance';
  if (/^(bogf|dato|date)/.test(n)) return 'date';
  return null;
}

// --- Plan ----------------------------------------------------------------------------

export interface CsvPlan {
  delimiter: CsvDelimiter;
  decimal: DecimalMark;
  hasHeader: boolean;
  /** Header names, or "Column 1"… when the file has none. */
  headers: string[];
  /** Data rows, header removed. */
  rows: string[][];
  mapping: ColumnRole[];
  /** True when the header named every column Atlas needs; false means the mapping step shows. */
  known: boolean;
}

function looksLikeHeader(row: readonly string[]): boolean {
  const roles = row.map(headerRole).filter(Boolean).length;
  const dataLike = row.filter((c) => parseDate(c) || parseAmount(c) !== null).length;
  return roles >= 1 && dataLike === 0;
}

/** First column per role wins; later duplicates are ignored, except text, which may be several. */
function dedupeRoles(mapping: ColumnRole[]): ColumnRole[] {
  const seen = new Set<ColumnRole>();
  return mapping.map((r) => {
    if (r === 'ignore' || r === 'text') return r;
    if (seen.has(r)) return 'ignore';
    seen.add(r);
    return r;
  });
}

/**
 * A guess read from the data: the first column that is nearly all dates is
 * the date, the first nearly-all-number column the amount and the next the
 * balance (Danske Bank's Dato;Tekst;Beløb;Saldo), and the column with the
 * longest words the text.
 */
export function guessMapping(rows: readonly string[][]): ColumnRole[] {
  const sample = rows.slice(0, 40);
  const width = Math.max(0, ...sample.map((r) => r.length));
  const decimal = detectDecimal(sample.flat());
  const out: ColumnRole[] = new Array(width).fill('ignore');
  const stats = Array.from({ length: width }, (_, c) => {
    const cells = sample.map((r) => r[c] ?? '').filter((x) => x !== '');
    const n = Math.max(1, cells.length);
    return {
      dates: cells.filter((x) => parseDate(x)).length / n,
      nums: cells.filter((x) => parseAmount(x, decimal) !== null).length / n,
      len: cells.reduce((a, x) => a + x.length, 0) / n,
      filled: cells.length / Math.max(1, sample.length),
    };
  });
  const dateCol = stats.findIndex((s) => s.dates >= 0.8);
  if (dateCol >= 0) out[dateCol] = 'date';
  const numCols = stats.map((s, i) => ({ s, i })).filter(({ s, i }) => i !== dateCol && s.nums >= 0.8 && s.dates < 0.5).map(({ i }) => i);
  if (numCols[0] !== undefined) out[numCols[0]] = 'amount';
  if (numCols[1] !== undefined) out[numCols[1]] = 'balance';
  let textCol = -1;
  stats.forEach((s, i) => {
    if (out[i] !== 'ignore' || s.nums >= 0.5 || s.dates >= 0.5 || s.filled < 0.5) return;
    if (textCol < 0 || s.len > stats[textCol].len) textCol = i;
  });
  if (textCol >= 0) out[textCol] = 'text';
  return out;
}

/** Read a file's text into a plan: delimiter, decimal mark, header and mapping. */
export function planCsv(text: string): CsvPlan {
  const delimiter = detectDelimiter(text);
  const all = parseCsv(text, delimiter);
  const first = all[0] ?? [];
  const hasHeader = looksLikeHeader(first);
  const rows = hasHeader ? all.slice(1) : all;
  const width = Math.max(first.length, ...rows.slice(0, 40).map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => (hasHeader ? first[i] || `Column ${i + 1}` : `Column ${i + 1}`));
  const decimal = detectDecimal(rows.slice(0, 200).flat());
  let mapping: ColumnRole[];
  let known = false;
  if (hasHeader) {
    mapping = dedupeRoles(headers.map((h) => headerRole(h) ?? 'ignore'));
    known = mappingProblems(mapping).length === 0;
    if (!known) {
      const guess = guessMapping(rows);
      mapping = dedupeRoles(mapping.map((r, i) => (r === 'ignore' ? guess[i] ?? 'ignore' : r)));
    }
  } else {
    mapping = guessMapping(rows);
  }
  while (mapping.length < width) mapping.push('ignore');
  return { delimiter, decimal, hasHeader, headers, rows, mapping, known };
}

/** What the mapping still lacks, in the words the mapping step shows. Empty means it can import. */
export function mappingProblems(mapping: readonly ColumnRole[]): string[] {
  const has = (r: ColumnRole) => mapping.includes(r);
  const out: string[] = [];
  if (!has('date')) out.push('Choose the column with the date.');
  if (!has('amount') && !has('inflow') && !has('outflow')) out.push('Choose the column with the amount.');
  if (!has('text')) out.push('Choose the column with the text.');
  return out;
}

// --- Rows ----------------------------------------------------------------------------

export interface ParsedTx {
  booked_on: string;
  amount: number;
  text: string;
  balance_after: number | null;
  currency: string | null;
}

/** Rows to transactions under a mapping; a row without a date or an amount is counted, not guessed. */
export function rowsToTransactions(rows: readonly string[][], mapping: readonly ColumnRole[], decimal: DecimalMark): { txs: ParsedTx[]; rejected: number } {
  const col = (r: ColumnRole) => mapping.indexOf(r);
  const [dc, ac, ic, oc, bc, cc] = [col('date'), col('amount'), col('inflow'), col('outflow'), col('balance'), col('currency')];
  const textCols = mapping.map((r, i) => (r === 'text' ? i : -1)).filter((i) => i >= 0);
  const txs: ParsedTx[] = [];
  let rejected = 0;
  for (const r of rows) {
    const day = dc >= 0 ? parseDate(r[dc] ?? '') : null;
    let amount: number | null = null;
    if (ac >= 0) amount = parseAmount(r[ac] ?? '', decimal);
    else {
      const inn = ic >= 0 ? parseAmount(r[ic] ?? '', decimal) : null;
      const out = oc >= 0 ? parseAmount(r[oc] ?? '', decimal) : null;
      if (inn !== null || out !== null) amount = (inn ?? 0) - Math.abs(out ?? 0);
    }
    if (!day || amount === null) { rejected++; continue; }
    const text = textCols.map((i) => (r[i] ?? '').trim()).filter(Boolean).join(' · ').replace(/\s+/g, ' ').slice(0, 300) || 'Transaction';
    const bal = bc >= 0 ? parseAmount(r[bc] ?? '', decimal) : null;
    const cur = cc >= 0 ? (r[cc] ?? '').trim().toUpperCase() : '';
    txs.push({ booked_on: day, amount: Math.round(amount * 100) / 100, text, balance_after: bal, currency: /^[A-Z]{3}$/.test(cur) ? cur : null });
  }
  return { txs, rejected };
}

/** cyrb53: a fast, well-spread 53-bit string hash, as base-36. Ids, not security. */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * One stable id per row: the account, the day, the amount in øre, the text
 * squeezed of spacing and case, and the row's place among identical rows of
 * the same file. Read the same export twice and every id repeats.
 */
export function transactionIds(accountId: string, txs: readonly ParsedTx[]): string[] {
  const seen = new Map<string, number>();
  return txs.map((t) => {
    const base = `${accountId}|${t.booked_on}|${Math.round(t.amount * 100)}|${t.text.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `csv-${hash53(`${base}|${n}`)}`;
  });
}

/**
 * The account's balance after the newest row, when the file carries one.
 * Several rows can share the newest day and exports sort either way, so the
 * last of them is the row whose balance no other same-day row started from.
 */
export function latestBalance(txs: readonly ParsedTx[]): { balance: number; on: string } | null {
  const withBal = txs.filter((t) => t.balance_after !== null);
  if (!withBal.length) return null;
  const last = withBal.reduce((a, t) => (t.booked_on > a ? t.booked_on : a), withBal[0].booked_on);
  const day = withBal.filter((t) => t.booked_on === last);
  const before = new Set(day.map((t) => Math.round(((t.balance_after ?? 0) - t.amount) * 100)));
  const end = day.find((t) => !before.has(Math.round((t.balance_after ?? 0) * 100))) ?? day[0];
  return { balance: end.balance_after ?? 0, on: last };
}

/** The span a set of rows covers, for the import summary. */
export function spanOf(txs: readonly ParsedTx[]): { from: string; to: string } | null {
  if (!txs.length) return null;
  let from = txs[0].booked_on;
  let to = from;
  for (const t of txs) { if (t.booked_on < from) from = t.booked_on; if (t.booked_on > to) to = t.booked_on; }
  return { from, to };
}
