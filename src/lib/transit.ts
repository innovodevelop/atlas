/**
 * Departures from Rejseplanen (Danish public transport), for the Answer
 * screen's departures shape and Home's Transit widget (Beta left-out rows 20
 * and 26).
 *
 * Rejseplanen's API needs a personal access ID — free for private use, by
 * request at labs.rejseplanen.dk. The ID lives in the macOS Keychain and the
 * requests are made by the Rust core (src-tauri/src/transit.rs), which hands
 * the webview Rejseplanen's own JSON and never the ID. Everything here is the
 * pure reading of that JSON and of the question, so tests can pin it.
 *
 * The API is HAFAS ReST (`location.name`, `departureBoard`). Its JSON is read
 * defensively: a lone object where a list is expected, times with or without
 * seconds, a realtime time that may be missing, a cancelled flag that may be
 * absent. Times are Danish local time, read as this Mac's local time — the
 * same assumption Rejseplanen's own apps make for a traveller in Denmark.
 */

export interface TransitStop {
  /** HAFAS's long id (`A=1@O=Nørreport St.@…`); what departureBoard accepts. */
  id: string;
  /** The short numeric stop number, when Rejseplanen gives one. */
  extId: string | null;
  name: string;
}

export type TransitKind = 'train' | 'metro' | 'bus' | 'tram' | 'ferry' | 'other';

export interface Departure {
  key: string;
  /** "Re 4529", "S A", "Bus 5C" — Rejseplanen's own name for the service. */
  line: string;
  kind: TransitKind;
  direction: string;
  /** "HH:MM", as timetabled. */
  planned: string;
  /** "HH:MM", realtime when Rejseplanen has it, else the timetable. */
  expected: string;
  /** Epoch ms of the expected departure. */
  at: number;
  /** Minutes late (negative when early); 0 without realtime. */
  delayMin: number;
  track: string | null;
  /** The realtime track differs from the timetabled one. */
  trackChanged: boolean;
  cancelled: boolean;
}

/* ---- the Keychain-free bits the screen keeps ------------------------------ */

/** Where the chosen stop is remembered. A stop is not a secret; the access ID never comes near this. */
export const STOP_KEY = 'atlas:transit_stop';

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(): KV | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readSavedStop(kv: KV | null = store()): TransitStop | null {
  try {
    const raw = kv?.getItem(STOP_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<TransitStop>;
    if (typeof v?.id !== 'string' || !v.id || typeof v.name !== 'string' || !v.name) return null;
    return { id: v.id, extId: typeof v.extId === 'string' ? v.extId : null, name: v.name };
  } catch {
    return null;
  }
}

export function writeSavedStop(stop: TransitStop | null, kv: KV | null = store()): void {
  try {
    if (!kv) return;
    if (stop) kv.setItem(STOP_KEY, JSON.stringify({ id: stop.id, extId: stop.extId, name: stop.name }));
    else kv.removeItem(STOP_KEY);
  } catch {
    /* the choice holds for this session; it is asked again next launch */
  }
}

/* ---- reading Rejseplanen's JSON ------------------------------------------ */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * The error Rejseplanen put in an otherwise successful reply, if any. HAFAS
 * answers a bad request with `{ errorCode, errorText }` rather than data.
 */
export function transitApiError(json: unknown): string | null {
  if (!isObj(json)) return null;
  const code = str(json.errorCode);
  if (!code) return null;
  if (/AUTH|KEY|ACCESS/i.test(code)) return 'Rejseplanen did not accept this access ID.';
  if (/QUOTA|LIMIT/i.test(code)) return 'This access ID has used its allowance for now.';
  const text = str(json.errorText);
  return `Rejseplanen could not answer that${text ? `: ${text}` : '.'}`;
}

/** Stops from `location.name`. Coordinates and addresses are not stops, so they are left out. */
export function parseStops(json: unknown, max = 8): TransitStop[] {
  if (!isObj(json)) return [];
  const raw = json.stopLocationOrCoordLocation !== undefined
    ? list(json.stopLocationOrCoordLocation).map((x) => (isObj(x) ? x.StopLocation : undefined))
    : list(isObj(json.LocationList) ? json.LocationList.StopLocation : json.StopLocation);
  const out: TransitStop[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (!isObj(s)) continue;
    const id = str(s.id);
    const name = str(s.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, extId: str(s.extId), name });
    if (out.length >= max) break;
  }
  return out;
}

/** "14:22:00" or "14:22" → "14:22"; anything else → null. */
export function hhmm(t: unknown): string | null {
  const m = typeof t === 'string' ? t.match(/^(\d{1,2}):(\d{2})/) : null;
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** A local "YYYY-MM-DD" + "HH:MM" as epoch ms, or null. */
function epoch(date: unknown, time: unknown, fallback: Date): number | null {
  const t = hhmm(time);
  if (!t) return null;
  const [h, min] = t.split(':').map(Number);
  const d = typeof date === 'string' ? date.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  const at = d
    ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h, min, 0, 0)
    : new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate(), h, min, 0, 0);
  return Number.isFinite(at.getTime()) ? at.getTime() : null;
}

/** The kind of vehicle, from Rejseplanen's category codes (catOut / catOutL / type). */
export function kindOf(...codes: Array<string | null>): TransitKind {
  const c = codes.filter(Boolean).join(' ').toLowerCase();
  if (!c) return 'other';
  if (/metro|\bm\b/.test(c)) return 'metro';
  if (/letbane|tram|light rail/.test(c)) return 'tram';
  if (/færge|faerge|ferry|\bf\b/.test(c)) return 'ferry';
  if (/bus/.test(c)) return 'bus';
  if (/tog|train|\bs\b|\bic|\bre\b|\breg|øresund|oresund|lyn|\bl\b|\bet\b|\bit\b/.test(c)) return 'train';
  return 'other';
}

export const KIND_NOUN: Record<TransitKind, string> = {
  train: 'train', metro: 'metro', bus: 'bus', tram: 'light rail', ferry: 'ferry', other: 'departure',
};

/**
 * Departures from `departureBoard`, soonest first, without the ones that have
 * already left. `now` decides "already left" and the day a dateless time is on.
 */
export function parseDepartures(json: unknown, now: Date = new Date()): Departure[] {
  if (!isObj(json)) return [];
  const raw = list(json.Departure !== undefined ? json.Departure : isObj(json.DepartureBoard) ? json.DepartureBoard.Departure : undefined);
  const out: Departure[] = [];
  raw.forEach((d, i) => {
    if (!isObj(d)) return;
    const product = isObj(d.ProductAtStop) ? d.ProductAtStop : isObj(list(d.Product)[0]) ? (list(d.Product)[0] as Obj) : {};
    const planned = hhmm(d.time);
    const plannedAt = epoch(d.date, d.time, now);
    if (!planned || plannedAt == null) return;
    const rt = hhmm(d.rtTime);
    const rtAt = rt ? epoch(d.rtDate ?? d.date, d.rtTime, now) : null;
    const at = rtAt ?? plannedAt;
    const track = str(d.rtTrack) ?? str(d.track);
    const line = str(d.name) ?? str(product.name) ?? 'Departure';
    const cancelled = d.cancelled === true || d.cancelled === 'true' || d.reachable === false || d.reachable === 'false';
    out.push({
      key: `${line}-${planned}-${i}`,
      line: line.replace(/\s+/g, ' '),
      kind: kindOf(str(product.catOutL), str(product.catOut), str(d.type), line),
      direction: str(d.direction) ?? '',
      planned,
      expected: rt ?? planned,
      at,
      delayMin: rtAt != null ? Math.round((rtAt - plannedAt) / 60000) : 0,
      track,
      trackChanged: !!str(d.rtTrack) && !!str(d.track) && str(d.rtTrack) !== str(d.track),
      cancelled,
    });
  });
  const cutoff = now.getTime() - 60_000;
  return out.filter((d) => d.at >= cutoff).sort((a, b) => a.at - b.at);
}

/* ---- the question ---------------------------------------------------------- */

const STOP_WORDS = '(?:from|fra|at|by|before|after|today|tonight|tomorrow|now|i dag|i morgen)';

/**
 * Where a travel question goes from and to: "When's the next train to Lund?"
 * → to Lund; "next bus from Nørreport to Lund C" → both. Place names are the
 * capitalised words after the preposition, so "how long to get to Lund"
 * reads Lund rather than "get to Lund".
 */
export function routeFromQuestion(q: string): { from: string | null; to: string | null } {
  const name = '([A-ZÆØÅ0-9][^?!,;]*?)';
  const end = `(?=\\s+${STOP_WORDS}\\b|\\s+(?:to|til|towards|mod)\\s|[?!,;]|\\.(?:\\s|$)|$)`;
  const to = q.match(new RegExp(`\\b(?:[Tt]o|[Tt]il|[Tt]owards|[Mm]od)\\s+${name}${end}`));
  const from = q.match(new RegExp(`\\b(?:[Ff]rom|[Ff]ra)\\s+${name}${end}`));
  const clean = (m: RegExpMatchArray | null) => (m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 60) || null : null);
  return { from: clean(from), to: clean(to) };
}

/* ---- what the screen says ------------------------------------------------- */

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const minutesWords = (n: number) => `${n <= 10 ? SMALL[n] : n} minute${n === 1 ? '' : 's'}`;

/** "in 8 min", "now", "in 1 h 5 min". */
export function countdown(d: Pick<Departure, 'at'>, now: Date = new Date()): string {
  const min = Math.round((d.at - now.getTime()) / 60000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return `in ${h} h${rest ? ` ${rest} min` : ''}`;
}

/** The status line under a departure: late, early, cancelled, a changed track. */
export function departureNote(d: Departure): string {
  if (d.cancelled) return 'Cancelled';
  const parts: string[] = [];
  if (d.delayMin > 0) parts.push(`${d.delayMin} min late · ${d.expected}`);
  else if (d.delayMin < 0) parts.push(`${-d.delayMin} min early · ${d.expected}`);
  else parts.push('On time');
  if (d.trackChanged && d.track) parts.push(`now from platform ${d.track}`);
  return parts.join(' · ');
}

/**
 * The header's one sentence, from the board itself — the design's "The next
 * train to Lund leaves at 14:22 from platform 2, six minutes late." Nothing
 * here is asked of a model: the board is the answer.
 */
export function departuresHeadline(deps: readonly Departure[], stop: string, to?: string | null): string {
  const next = deps.find((d) => !d.cancelled);
  if (!next) {
    return deps.length
      ? `Every departure from ${stop} in the next hours is cancelled.`
      : `Nothing leaves ${stop}${to ? ` for ${to}` : ''} in the next two hours.`;
  }
  const where = next.track ? ` from platform ${next.track}` : '';
  const late = next.delayMin > 0 ? `, ${minutesWords(next.delayMin)} late` : '';
  return `The next ${KIND_NOUN[next.kind]}${to ? ` to ${to}` : ''} leaves ${stop} at ${next.planned}${where}${late}.`;
}

/**
 * The note under the board, when there is something worth saying: the first
 * departure is late or cancelled and a later one is not.
 */
export function boardNote(deps: readonly Departure[]): string | null {
  const first = deps[0];
  if (!first) return null;
  const nextGood = deps.slice(1).find((d) => !d.cancelled && d.delayMin <= 0);
  if (first.cancelled) return nextGood ? `The ${first.planned} is cancelled; the ${nextGood.planned} runs on time.` : `The ${first.planned} is cancelled.`;
  if (first.delayMin >= 3) return nextGood ? `The ${first.planned} is ${minutesWords(first.delayMin)} late; the ${nextGood.planned} after it is on time.` : `The ${first.planned} is ${minutesWords(first.delayMin)} late.`;
  return null;
}

/** A Rust error string, as the line the screen shows. */
export function transitErrorCopy(message: string): string {
  if (/no access id|not configured/i.test(message)) return 'Add your Rejseplanen access ID to see departures.';
  if (/HTTP 40[13]/.test(message)) return 'Rejseplanen did not accept this access ID. Check it, or request a new one.';
  if (/HTTP 429/.test(message)) return 'This access ID has used its allowance for now. Try again later.';
  if (/HTTP 5\d\d|unreachable|timed? ?out|transport/i.test(message)) return 'Rejseplanen could not be reached. Try again in a moment.';
  if (/not found|Command transit_/i.test(message)) return 'Departures need the Atlas app on your Mac.';
  return message || 'Rejseplanen did not answer.';
}
