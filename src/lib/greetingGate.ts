/**
 * The greeting gate — the half of "Atlas speaks first" that must never cost a
 * model call.
 *
 * Atlas has never opened its own mouth. The product rule, in the user's words,
 * is "not every launch, but every morning with first interaction, and at random
 * launches during the day if anything relevant". That splits cleanly in two:
 *
 *   STAGE 1 (this file)  WHETHER to speak. Pure, synchronous, free.
 *   STAGE 2 (the brain)  WHAT to say. One model call, made only if this file
 *                        already said yes.
 *
 * Everything here is a pure function of its arguments so the decision can be
 * exhaustively tested without a renderer, a network, or a clock — the same
 * convention as `resolvePresence` in useAtlasPresence.ts. The only impure code
 * is the memo store at the bottom, kept behind its own header.
 *
 * `reason` is not a debug string. It is the answer to "why did Atlas just talk
 * to me?", and — until the generated sentence exists — it is literally what the
 * greeting band renders. It is built from real rows (an alert title, an event
 * title, an error count) and never from anything invented.
 *
 * ---------------------------------------------------------------------------
 * TIME OF DAY: WHICH CLOCK WINS
 *
 * There were two disagreeing implementations. `timeOfDayGreeting()` in
 * src/pages/atlas/atlasHelpers.ts read the LOCAL machine hour and split at
 * 12/18. The brain's `getTimeOfDay(timezone)` in
 * supabase/functions/_shared/orchestrator.ts is TIMEZONE-AWARE and splits at
 * 5/12/17/21. Between 17:00 and 18:00 the written greeting said "Good
 * afternoon" while the prompt told Atlas it was evening — the same breath,
 * two different times of day. Away from the machine's own zone they diverge by
 * whole hours.
 *
 * DECISION: the TIMEZONE-AWARE definition is authoritative, and this file
 * implements it so the frontend can render before any network call. The
 * boundaries below are the brain's, deliberately identical. The frontend half
 * follows the brain, not the other way round, because the brain's version is
 * the one that is correct when the user travels, and because the spoken
 * greeting is the one a person will remember.
 *
 * `timeOfDayGreeting()` is now DELETED rather than deprecated. Leaving it in
 * atlasHelpers.ts kept AtlasHome.tsx rendering the 12/18 machine-clock split
 * while the dashboard rendered this one — two Atlas screens naming different
 * times of day from the same instant, and ignoring the user's own timezone on
 * one of them. `greetingPhrase` is the only implementation in the frontend.
 * `the_frontend_has_exactly_one_time_of_day` in greetingGate.test.ts is what
 * keeps a third from appearing.
 */

/** Bucket boundaries. IDENTICAL to orchestrator.ts getTimeOfDay — see above. */
const MORNING_START_HOUR = 5;
const AFTERNOON_START_HOUR = 12;
const EVENING_START_HOUR = 17;
const NIGHT_START_HOUR = 21;

/**
 * A "greeting day" starts at 05:00, not midnight.
 *
 * The rule is "first interaction of a day, in the morning". Anchored to the
 * calendar date, a 01:00 session burns the day: the 08:00 launch six hours
 * later is no longer the first of that date, and Atlas stays silent through
 * the entire morning. Anchoring to 05:00 — the same hour the brain already
 * calls the start of morning — makes a 01:00 session belong to the night
 * before, which is what it feels like. One constant, both uses.
 */
const DAY_START_HOUR = MORNING_START_HOUR;

/** Default silence between two unprompted greetings. */
export const DEFAULT_COOLDOWN_MS = 90 * 60 * 1000;

/** A signal has to clear this to be worth breaking silence over. */
const SPEAK_THRESHOLD = 0.7;

/** How far ahead a calendar event counts as imminent. */
const IMMINENT_MS = 90 * 60 * 1000;

/** Unresolved errors in the last day before Atlas admits it is unwell. */
const ERROR_FLOOR = 3;

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export type GreetingSource = 'calendar' | 'mail' | 'insight' | 'health';

export interface SalienceSignal {
  source: GreetingSource;
  /**
   * The user-facing clause. This is shown verbatim, so it must come from a
   * real row — an alert title, an event title, a counted number.
   */
  label: string;
  /**
   * When the signal became salient (ms). Anything at or before the last
   * greeting has already had its chance to be mentioned.
   */
  at: number;
  /** 0–1. Only >= SPEAK_THRESHOLD may break silence on its own. */
  weight: number;
}

export interface GreetingGateInput {
  /** Wall clock, ms. Injected rather than read, so the tests own the clock. */
  now: number;
  /** IANA zone the user lives in (profiles.timezone). Null falls back to the device. */
  timeZone?: string | null;
  /** When Atlas last greeted unprompted, ms. Null = never. */
  lastGreetedAt: number | null;
  /** Microphone gated off by the user. */
  muted: boolean;
  signals: SalienceSignal[];
  cooldownMs?: number;
}

export interface GreetingDecision {
  speak: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Clock

// Intl.DateTimeFormat construction is expensive and this runs on every render
// path that renders the band. Memoising per zone keeps the function's output a
// pure function of its inputs while making repeated calls cheap.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone?: string | null): Intl.DateTimeFormat {
  const key = timeZone || '';
  const cached = formatters.get(key);
  if (cached) return cached;
  // en-GB, not en-US: it formats hours on a 23-hour cycle natively, so we never
  // have to reason about the "24" that en-US + hour12:false emits at midnight
  // on some ICU builds. (The brain's getTimeOfDay has exactly that hazard; it
  // happens to be harmless there because 24 and 0 both land in "night".)
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', timeZone ? { ...opts, timeZone } : opts);
  } catch {
    // A profile can hold a zone this ICU build does not know. Falling back to
    // the device zone is strictly better than throwing on the greeting path.
    fmt = new Intl.DateTimeFormat('en-GB', opts);
  }
  formatters.set(key, fmt);
  return fmt;
}

interface ZonedInstant {
  /** Calendar date in the zone, YYYY-MM-DD. */
  date: string;
  /** Hour in the zone, 0–23. */
  hour: number;
}

function zoned(ms: number, timeZone?: string | null): ZonedInstant {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // Normalised anyway: a locale/ICU pair that reports midnight as 24 would
  // otherwise fail the `hour < 12` morning test at exactly the wrong moment.
  const hour = Number(pick('hour')) % 24;
  return { date: `${pick('year')}-${pick('month')}-${pick('day')}`, hour };
}

function previousDate(date: string): string {
  // String arithmetic on the already-resolved local date, so a DST jump on the
  // day in question cannot move the answer.
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The bucket the brain names in the prompt, computed the brain's way. */
export function timeOfDay(now: number, timeZone?: string | null): TimeOfDay {
  const { hour } = zoned(now, timeZone);
  if (hour >= MORNING_START_HOUR && hour < AFTERNOON_START_HOUR) return 'morning';
  if (hour >= AFTERNOON_START_HOUR && hour < EVENING_START_HOUR) return 'afternoon';
  if (hour >= EVENING_START_HOUR && hour < NIGHT_START_HOUR) return 'evening';
  return 'night';
}

/**
 * The written greeting, derived from the same bucket the spoken one will use.
 *
 * "Still up" for night is a copy call, not a technical one: it is the only
 * phrase in the set that is never factually wrong. "Good evening" at 03:00
 * names the wrong time of day, which is the exact failure this reconciliation
 * exists to remove; "Still up" merely runs a little early at 21:00.
 */
export function greetingPhrase(now: number, timeZone?: string | null): string {
  switch (timeOfDay(now, timeZone)) {
    case 'morning': return 'Good morning';
    case 'afternoon': return 'Good afternoon';
    case 'evening': return 'Good evening';
    default: return 'Still up';
  }
}

/** Which greeting day an instant belongs to (see DAY_START_HOUR). */
export function greetingDayKey(now: number, timeZone?: string | null): string {
  const { date, hour } = zoned(now, timeZone);
  return hour < DAY_START_HOUR ? previousDate(date) : date;
}

// ---------------------------------------------------------------------------
// Salience

export interface SalienceSources {
  now: number;
  /** useCalendarEvents rows. */
  events: Array<{ title?: string | null; start_time?: string | null }>;
  /** Unacknowledged useMailIntelligence alerts. */
  mailAlerts: Array<{ alert_type?: string | null; title?: string | null; created_at?: string | null }>;
  /** ai_insights rows the digest wrote and nothing has surfaced yet. */
  insights: Array<{ title?: string | null; priority?: number | null; created_at?: string | null }>;
  /** Unresolved atlas_error_logs rows in the last 24h. */
  unresolvedErrors: number;
  /** The same count at the last greeting, so health edge-triggers. Null = never greeted. */
  errorsAtLastGreeting: number | null;
  /** profiles.timezone. Only used to name an event's clock time. */
  timeZone?: string | null;
}

/** Mail alert types carry their own urgency; the brain's classifier set them. */
const MAIL_WEIGHTS: Record<string, number> = {
  deadline: 0.9,
  bill: 0.85,
  important: 0.75,
  document: 0.5,
};

/**
 * An unspoken insight exists because the digest already judged it worth
 * saying — the gate's remaining job is only "is it new". `priority` therefore
 * shifts the weight rather than deciding it, and only an explicitly low
 * priority drops one below the speaking threshold.
 */
function insightWeight(priority?: number | null): number {
  const p = typeof priority === 'number' && Number.isFinite(priority) ? priority : 5;
  if (p >= 8) return 0.95;
  if (p >= 4) return 0.8;
  return 0.5;
}

function parseTime(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The event's own clock time, in the user's zone. NOT a countdown.
 *
 * A countdown was the obvious phrasing and it is the one thing this label must
 * not be: the dashboard latches the decision the first time Atlas speaks and
 * never recomputes it, so "Standup starts in 25 minutes" was rendered from the
 * launch instant and then pinned to the band for the life of the window. At
 * 11:00 it still said the 10:00 standup started in 25 minutes.
 *
 * Fixing the latch instead was the alternative and it is the wrong one: the
 * latch is what stops Atlas retracting something it already said. A wall-clock
 * time is true whenever it is read, which makes the sentence safe to freeze —
 * and it is what the brain's own greeting route says ("\"Dentist\" at 10:00").
 */
function eventLabel(title: string, startMs: number, timeZone?: string | null): string {
  return `${title} at ${clockTime(startMs, timeZone)}.`;
}

/** "10:00" in the user's zone, 24-hour, falling back to the device clock. */
export function clockTime(at: number, timeZone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (timeZone) opts.timeZone = timeZone;
  try {
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(at));
  } catch {
    // An unknown IANA zone throws. The device clock is a worse answer than the
    // user's own zone and a much better one than no time at all.
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(at));
  }
}

/**
 * Turn the dashboard's raw hook data into weighted, timestamped signals.
 *
 * Pure, and separate from the decision, so "what counts as relevant" can be
 * tested independently of "may Atlas speak right now".
 */
export function collectSalience(src: SalienceSources): SalienceSignal[] {
  const out: SalienceSignal[] = [];

  for (const e of src.events) {
    const start = parseTime(e.start_time);
    if (start === null || start < src.now) continue;
    if (start - src.now > IMMINENT_MS) continue;
    const title = (e.title || '').trim();
    if (!title) continue;
    out.push({
      source: 'calendar',
      label: eventLabel(title, start, src.timeZone),
      // An event becomes salient when it comes INTO the imminent window, not
      // when the row was created — that is the moment worth mentioning, and it
      // is what makes "unseen since the last greeting" mean the right thing.
      at: start - IMMINENT_MS,
      weight: 0.8,
    });
  }

  for (const a of src.mailAlerts) {
    const title = (a.title || '').trim();
    if (!title) continue;
    out.push({
      source: 'mail',
      label: `${title}`,
      at: parseTime(a.created_at) ?? src.now,
      weight: MAIL_WEIGHTS[a.alert_type ?? ''] ?? 0.5,
    });
  }

  for (const i of src.insights) {
    const title = (i.title || '').trim();
    if (!title) continue;
    out.push({
      source: 'insight',
      label: `${title}`,
      at: parseTime(i.created_at) ?? src.now,
      weight: insightWeight(i.priority),
    });
  }

  // Health is a LEVEL, not an event: there is no timestamp that makes it
  // "new". Edge-triggering on the count recorded at the last greeting is what
  // stops a persistent fault from being announced once per cooldown forever —
  // Atlas says it got worse, then holds its tongue until it does again.
  const worse = src.errorsAtLastGreeting === null || src.unresolvedErrors > src.errorsAtLastGreeting;
  if (src.unresolvedErrors >= ERROR_FLOOR && worse) {
    out.push({
      source: 'health',
      label: `${src.unresolvedErrors} unresolved errors in the last day — something in Atlas needs a look.`,
      at: src.now,
      weight: 0.75,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// The gate

function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * WHETHER Atlas speaks. Precedence, highest first:
 *
 *   1. muted     the user reached for the mute button; Atlas does not start
 *                conversations it has been told not to have
 *   2. cooldown  never twice inside the window — including across midnight,
 *                which is the case a naive "new calendar day" rule gets wrong:
 *                greeted 23:50, relaunched 00:10, a new date, before noon, and
 *                Atlas would greet you twenty minutes later
 *   3. first-of-day, in the morning — ALWAYS, regardless of whether anything
 *                is going on. "Always" here means "regardless of salience",
 *                not "regardless of the cooldown above"
 *   4. an unseen high-salience signal
 *   5. otherwise silence, with a reason for that too
 */
export function shouldGreet(input: GreetingGateInput): GreetingDecision {
  const { now, timeZone, lastGreetedAt, muted } = input;
  const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  if (muted) {
    return { speak: false, reason: "Muted — Atlas doesn't start conversations while the microphone is off." };
  }

  if (lastGreetedAt !== null) {
    const since = now - lastGreetedAt;
    // A memo from the future (clock moved backwards) is treated as "just now"
    // rather than trusted into a negative age that would open the gate.
    if (since < cooldownMs) {
      const mins = Math.max(0, Math.round(since / 60000));
      return {
        speak: false,
        reason: `Atlas said something ${mins === 0 ? 'a moment' : `${mins} minute${mins === 1 ? '' : 's'}`} ago — quiet for another ${Math.max(1, Math.round((cooldownMs - since) / 60000))} minutes.`,
      };
    }
  }

  // Only signals that appeared since the last greeting count; anything older
  // was already on screen when Atlas last spoke.
  const floor = lastGreetedAt ?? Number.NEGATIVE_INFINITY;
  const unseen = input.signals
    .filter((s) => s.at > floor)
    .sort((a, b) => b.weight - a.weight || b.at - a.at);
  const top = unseen[0];

  // NEVER GREETED BEFORE — always speak, whatever the hour and whatever the
  // signals. This outranks the morning rule and the salience threshold both.
  //
  // The first time you ever open Atlas is the one moment where saying nothing
  // is unambiguously wrong: a product whose whole premise is that it talks to
  // you should not open in silence and leave you to wonder whether the voice
  // works at all. Every later silence is a judgement about whether there is
  // anything worth interrupting for; this one has no such question to weigh,
  // because there is no history to compare against.
  //
  // It is deliberately placed AFTER the mute and cooldown checks: a muted
  // microphone still means "not now", and the cooldown cannot apply here
  // anyway, since it only exists once a greeting has happened.
  if (lastGreetedAt === null) {
    return {
      speak: true,
      reason: top ? `First time we've met — ${lowerFirst(top.label)}` : "First time we've met.",
    };
  }

  const firstOfDay = greetingDayKey(lastGreetedAt, timeZone) !== greetingDayKey(now, timeZone);

  if (firstOfDay && timeOfDay(now, timeZone) === 'morning') {
    // The top signal rides along even below the threshold: it is not enough to
    // break silence on its own, but if Atlas is already talking it is the most
    // useful thing it can say.
    return {
      speak: true,
      reason: top
        ? `First time we've spoken today — ${lowerFirst(top.label)}`
        : "First time we've spoken today.",
    };
  }

  if (top && top.weight >= SPEAK_THRESHOLD) {
    return { speak: true, reason: top.label };
  }

  if (firstOfDay) {
    return {
      speak: false,
      reason: 'First launch of the day, but the morning has passed and nothing new needs saying.',
    };
  }
  return {
    speak: false,
    reason: top
      ? 'Nothing new since Atlas last spoke that is worth interrupting for.'
      : 'Nothing new since Atlas last spoke.',
  };
}

// ---------------------------------------------------------------------------
// The memo — the ONLY impure code in this file
//
// WHERE last_greeted_at LIVES, AND WHY: localStorage, not SQLite.
//
// The gate has to produce an answer before first paint. A SQLite read through
// the Tauri IPC bridge is async, so persisting there would either delay the
// band or let it flap — silent on mount, greeting a moment later. It is also
// per-device presence state, not user data: two machines each saying good
// morning once is the behaviour you want, and a synced row would give one of
// them the silent treatment. Same store, same reasoning, as
// `atlas-demo-settings` in useAtlasSettings.ts.
//
// The cost is that clearing the webview's data re-greets once. That is the
// correct trade for a greeting.

const MEMO_KEY = 'atlas-greeting-memo';

export interface GreetingMemo {
  /** Whose greeting this was. A different signed-in user gets a fresh slate. */
  userId: string;
  /** Wall clock of the greeting, ms. */
  at: number;
  /** Unresolved-error count at that moment; the health signal edge-triggers off it. */
  errorCount: number;
}

export function loadGreetingMemo(userId?: string | null): GreetingMemo | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(MEMO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GreetingMemo>;
    if (parsed.userId !== userId) return null;
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null;
    return {
      userId,
      at: parsed.at,
      errorCount: typeof parsed.errorCount === 'number' ? parsed.errorCount : 0,
    };
  } catch {
    // A corrupt memo must not be able to stop Atlas from greeting.
    return null;
  }
}

export function saveGreetingMemo(memo: GreetingMemo): void {
  try {
    localStorage.setItem(MEMO_KEY, JSON.stringify(memo));
  } catch {
    // Storage full or disabled. Atlas greets again next launch, which is a far
    // smaller failure than throwing on the render path.
  }
}
