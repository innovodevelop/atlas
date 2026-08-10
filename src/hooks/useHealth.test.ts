/**
 * The health surface used to be sample data with a label on it. This is what
 * replaced the label.
 *
 * The failure these tests exist to prevent is not a crash — it is a page that
 * looks right and is not. An Apple Health export is a snapshot of the past, and
 * every number on it belongs to a specific day; the moment a card drops that day
 * the screen starts asserting that a three-week-old step count is what the
 * person did today. So the dates are pinned harder than anything else here: no
 * label may say "Today" for a day that is not today, the dataset must carry its
 * own range, and a week-old import must reach the page as `stale`.
 *
 * `today` is a parameter of every projection, never `new Date()` inside one, so
 * these run the same in July as in December.
 */
import { describe, expect, test } from 'bun:test';
import {
  EXPORT_SOURCE_ID,
  STALE_AFTER_DAYS,
  captionOf,
  coverageOf,
  dayDiff,
  dayKicker,
  describeReport,
  emptyReason,
  exportSource,
  formatDay,
  localToday,
  msUntilLocalMidnight,
  minutesLabel,
  toCard,
  toSnapshot,
  toWorkoutCard,
  type ImportReport,
  type RawMetric,
  type RawSnapshot,
  type RawWorkout,
  type RealHealthSnapshot,
} from '@/hooks/useHealth';
import type { UseAtlasHealth } from '@/lib/mocks/health';
import { metricAvailability } from '@/lib/mocks/health';

const TODAY = '2026-08-08';

const metric = (over: Partial<RawMetric> = {}): RawMetric => ({
  metric: 'steps',
  name: 'Steps',
  category: 'move',
  value: '8,213',
  raw: 8213,
  unit: 'count',
  stat: 'sum',
  day: TODAY,
  sampleCount: 1,
  source: 'iPhone',
  low: null,
  high: null,
  range: null,
  ...over,
});

const workout = (over: Partial<RawWorkout> = {}): RawWorkout => ({
  activity: 'Running',
  startedAt: '2026-08-07T06:00:00Z',
  endedAt: '2026-08-07T06:42:00Z',
  day: '2026-08-07',
  durationMin: 42,
  distanceKm: 8.1,
  energyKcal: 420,
  avgHeartRate: 151,
  source: 'Apple Watch',
  ...over,
});

const snap = (over: Partial<RawSnapshot> = {}): RawSnapshot => ({
  capturedAt: '2026-08-08T07:40:00.000Z',
  hasData: true,
  sources: [{
    id: EXPORT_SOURCE_ID,
    name: 'Apple Health export',
    kind: 'apple_export',
    state: 'imported',
    detail: '31 days · 1 workout',
    enabled: true,
  }],
  metrics: [metric()],
  workouts: [],
  coverage: { metrics: 1, days: 1, workouts: 0, firstDay: TODAY, lastDay: TODAY },
  privacy: [{ id: 'on_device', name: 'Your export is read and stored only on this Mac', note: 'x', enabled: true, fixed: true }],
  signals: [],
  devices: [],
  clay: [],
  primaryDevice: null,
  ...over,
});

/* ── The contract with the surface ────────────────────────────────────────── */

describe('the mock contract', () => {
  test('the real return value is assignable to the interface the page was built against', () => {
    // A COMPILE-TIME assertion; `bun run build` typechecks this file. If the
    // real hook ever drifts from `UseAtlasHealth`, the build fails here rather
    // than the page failing at runtime.
    const real = {
      snapshot: null as RealHealthSnapshot | null,
      loading: false,
      error: null,
      isMock: false,
      setSourceEnabled: () => {},
      setSignalEnabled: () => {},
      refresh: async () => {},
    };
    const asContract: UseAtlasHealth = real;
    expect(asContract.isMock).toBe(false);
  });

  test('a card built here is readable by the availability rule the widgets use', () => {
    const s = toSnapshot(snap(), TODAY);
    // `metricAvailability` looks the card's `sourceId` up in `sources`. If the
    // hook stamped an id no source carries, EVERY card on the page would render
    // "Not measured" on top of perfectly good data.
    expect(metricAvailability(s, s.metrics[0]).available).toBe(true);
  });
});

/* ── Dates: the anti-fabrication rules ────────────────────────────────────── */

describe('a number never borrows a day it does not have', () => {
  test('"Today" is reserved for today', () => {
    expect(dayKicker(TODAY, TODAY)).toBe('Today');
    expect(dayKicker('2026-08-07', TODAY)).toBe('Yesterday');
    expect(dayKicker('2026-08-02', TODAY)).toBe('6 days ago');
  });

  test('past a week it names the date rather than counting', () => {
    expect(dayKicker('2026-08-01', TODAY)).toBe('1 Aug');
    expect(dayKicker('2026-07-18', TODAY)).toBe('18 Jul');
    expect(dayKicker('2025-12-24', TODAY)).toBe('24 Dec 2025');
  });

  test('a three-week-old step count is not rendered as today', () => {
    // The exact fabrication named in the task.
    const card = toCard(metric({ day: '2026-07-18' }), TODAY);
    expect(card.kicker).toBe('18 Jul');
    expect(card.kicker).not.toBe('Today');
  });

  test('an unparseable day becomes "Unknown day", never day zero', () => {
    // `Date.parse('')` is NaN and a careless diff of 0 would print "Today".
    expect(dayKicker('', TODAY)).toBe('Unknown day');
    expect(dayKicker('not-a-day', TODAY)).toBe('Unknown day');
    expect(dayDiff('2026-02-31', TODAY)).toBeNull();
  });

  test('day arithmetic is calendar arithmetic, not 24-hour arithmetic', () => {
    // `bun test` PINS THE PROCESS TO UTC, where every day is 24 hours and a
    // local-time implementation of this function looks perfectly correct. So
    // the timezone is moved for the length of this test: Europe/Copenhagen
    // springs forward on 29 March 2026 and back on 25 October, making those two
    // local days 23h and 25h long. Nothing here rounds, so a `new Date(y,m,d)`
    // implementation returns 0.958 and 1.041 and this goes red.
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Copenhagen';
    try {
      expect(dayDiff('2026-03-29', '2026-03-30')).toBe(1);
      expect(dayDiff('2026-10-25', '2026-10-26')).toBe(1);
      expect(dayDiff('2026-02-28', '2026-03-01')).toBe(1); // not a leap year
      expect(dayDiff('2024-02-28', '2024-03-01')).toBe(2); // one that is
      expect(dayKicker('2026-03-29', '2026-03-30')).toBe('Yesterday');
    } finally {
      // Put the runner's zone back explicitly. `bun test` resolves to UTC while
      // leaving `process.env.TZ` UNSET, so deleting the variable does not undo
      // the change — it drops the process into the host's real zone and leaks
      // into every test after this one.
      process.env.TZ = tz ?? 'UTC';
    }
  });

  test('the year is only spelled out when it differs from today', () => {
    expect(formatDay('2026-08-02', TODAY)).toBe('2 Aug');
    expect(formatDay('2025-08-02', TODAY)).toBe('2 Aug 2025');
  });

  test('localToday reads the local calendar, not UTC', () => {
    // 23:30 local on the 8th is the 8th, whatever UTC thinks.
    const d = new Date(2026, 7, 8, 23, 30, 0);
    expect(localToday(d)).toBe('2026-08-08');
  });

  /**
   * `today` is what every kicker is measured against, and it was only
   * re-stamped inside a successful read — of which there is exactly one, on
   * mount. A window left open overnight therefore kept calling yesterday's
   * step count "Today", which is the single most direct way this surface can
   * state something false. The timer this arms is the reason the comment above
   * the re-stamp is now true.
   */
  test('the midnight tick lands ON midnight, not an hour either side of it', () => {
    const d = new Date(2026, 7, 8, 23, 30, 0);
    expect(msUntilLocalMidnight(d)).toBe(30 * 60 * 1000);

    // Computed from the wall clock, so a 23- or 25-hour DST day still lands on
    // 00:00 rather than drifting by the offset change.
    const midnight = new Date(d.getTime() + msUntilLocalMidnight(d));
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(0);
    expect(localToday(midnight)).toBe('2026-08-09');
  });

  test('a tick is never scheduled for zero, which would spin', () => {
    // Exactly midnight: the next boundary is a whole day out, not now.
    const atMidnight = new Date(2026, 7, 8, 0, 0, 0, 0);
    expect(msUntilLocalMidnight(atMidnight)).toBe(24 * 60 * 60 * 1000);
    // One millisecond before it, the floor keeps the timer sane.
    expect(msUntilLocalMidnight(new Date(2026, 7, 8, 23, 59, 59, 999))).toBeGreaterThanOrEqual(1000);
  });
});

/* ── Coverage and staleness ───────────────────────────────────────────────── */

describe('the dataset is labelled with what it actually covers', () => {
  test('a fresh import reads as fresh', () => {
    const c = coverageOf({ metrics: 40, days: 31, workouts: 4, firstDay: '2026-07-09', lastDay: TODAY }, TODAY);
    expect(c.level).toBe('fresh');
    expect(c.ageDays).toBe(0);
    expect(c.rangeLabel).toBe('9 Jul – 8 Aug · 31 days');
    expect(c.ageLabel).toBe('The newest reading is from today.');
  });

  test('a week-old import is "recent", an eight-day-old one is stale', () => {
    const recent = coverageOf({ metrics: 1, days: 1, workouts: 0, firstDay: '2026-08-01', lastDay: '2026-08-01' }, TODAY);
    expect(recent.ageDays).toBe(STALE_AFTER_DAYS);
    expect(recent.level).toBe('recent');

    const stale = coverageOf({ metrics: 1, days: 1, workouts: 0, firstDay: '2026-07-31', lastDay: '2026-07-31' }, TODAY);
    expect(stale.level).toBe('stale');
    expect(stale.ageLabel).toBe('The newest reading is 8 days old (31 Jul).');
  });

  test('a partial import says how many days inside its range are missing', () => {
    // 31 calendar days, 12 of them with readings. "31 days of data" would be a
    // claim about nineteen days nobody measured.
    const c = coverageOf({ metrics: 12, days: 12, workouts: 0, firstDay: '2026-07-09', lastDay: '2026-08-08' }, TODAY);
    expect(c.spanDays).toBe(31);
    expect(c.gapDays).toBe(19);
    expect(c.rangeLabel).toBe('9 Jul – 8 Aug · 12 of 31 days');
  });

  test('an empty store has no range and is not called fresh', () => {
    const c = coverageOf({ metrics: 0, days: 0, workouts: 0, firstDay: null, lastDay: null }, TODAY);
    expect(c.level).toBe('none');
    expect(c.ageDays).toBeNull();
    expect(c.rangeLabel).toBe('No days imported');
  });

  test('days later than today are flagged rather than passed off as fresh', () => {
    const c = coverageOf({ metrics: 1, days: 1, workouts: 0, firstDay: '2026-08-20', lastDay: '2026-08-20' }, TODAY);
    expect(c.level).toBe('stale');
    expect(c.ageLabel).toContain("clock");
  });
});

/* ── Cards ────────────────────────────────────────────────────────────────── */

describe('cards say only what the row carries', () => {
  test('no card invents a trend', () => {
    // `health_snapshot` returns ONE day per metric. A delta needs two.
    const card = toCard(metric(), TODAY);
    expect(card.delta).toBeUndefined();
    expect(card.bars).toBeUndefined();
    expect(card.pct).toBeUndefined();
  });

  test('the caption is the day range, the reading count and the device', () => {
    const card = toCard(metric({
      metric: 'heart_rate_bpm', name: 'Heart rate', category: 'heart',
      value: '62 bpm', stat: 'avg', sampleCount: 2, low: 58, high: 66,
      range: '58 bpm–66 bpm', source: 'Apple Watch',
    }), TODAY);
    expect(card.caption).toBe('58 bpm–66 bpm · 2 readings · Apple Watch');
    expect(card.category).toBe('heart');
  });

  test('a single-reading day says how it was reduced instead of faking a range', () => {
    expect(captionOf(metric())).toBe('daily total · iPhone');
    expect(captionOf(metric({ source: null }))).toBe('daily total');
  });

  test('a category Rust does not share with the design falls back rather than throwing', () => {
    expect(toCard(metric({ category: 'nutrition' }), TODAY).category).toBe('body');
  });

  test('cards are grouped by category, not ranked by value', () => {
    const s = toSnapshot(snap({
      metrics: [
        metric({ metric: 'body_mass_kg', name: 'Weight', category: 'body' }),
        metric({ metric: 'resting_heart_rate_bpm', name: 'Resting heart rate', category: 'heart' }),
        metric({ metric: 'steps', name: 'Steps', category: 'move' }),
      ],
    }), TODAY);
    expect(s.metrics.map((m) => m.id)).toEqual(['steps', 'resting_heart_rate_bpm', 'body_mass_kg']);
  });
});

describe('workouts', () => {
  test('no workouts means no card at all', () => {
    // An empty "Workouts" card asserts the person did not train. An import that
    // predates the gym is not evidence of that.
    expect(toWorkoutCard([], TODAY)).toBeNull();
    expect(toSnapshot(snap(), TODAY).workoutCard).toBeNull();
  });

  test('each workout row carries its own day', () => {
    const card = toWorkoutCard([workout(), workout({ day: '2026-07-20', activity: 'Cycling', durationMin: 95 })], TODAY);
    expect(card.rows).toEqual([
      { label: 'Running · 42m', value: 'Yesterday' },
      { label: 'Cycling · 1h 35m', value: '20 Jul' },
    ]);
    expect(card.value).toBe('2 imported');
  });

  test('a long list says it is showing only the most recent', () => {
    const many = Array.from({ length: 9 }, (_, i) => workout({ day: '2026-08-0' + ((i % 8) + 1) }));
    const card = toWorkoutCard(many, TODAY);
    expect(card.rows).toHaveLength(5);
    expect(card.caption).toBe('Showing the 5 most recent');
    expect(card.value).toBe('9 imported');
  });

  test('durations read as durations', () => {
    expect(minutesLabel(42)).toBe('42m');
    expect(minutesLabel(95)).toBe('1h 35m');
    expect(minutesLabel(60)).toBe('1h 0m');
  });
});

/* ── The empty states ─────────────────────────────────────────────────────── */

describe('being empty is the normal state, and it says which kind', () => {
  const base = { supported: true, userId: 'u1', loading: false, error: null, snapshot: null as RealHealthSnapshot | null };

  test('a browser cannot reach the store at all', () => {
    expect(emptyReason({ ...base, supported: false })).toBe('desktop_only');
  });

  test('no identity is not the same as no data', () => {
    expect(emptyReason({ ...base, userId: null })).toBe('signed_out');
  });

  test('day one — nothing has ever been imported', () => {
    const s = toSnapshot(snap({ hasData: false, metrics: [], sources: [], coverage: { metrics: 0, days: 0, workouts: 0, firstDay: null, lastDay: null } }), TODAY);
    expect(emptyReason({ ...base, snapshot: s })).toBe('no_import');
  });

  test('an import that produced nothing is a different problem from never importing', () => {
    // The file was read and every record in it was refused — a wrong file, or
    // units Atlas will not guess at. Telling this person to "import a file"
    // sends them round the same loop.
    const s = toSnapshot(snap({
      hasData: false, metrics: [],
      coverage: { metrics: 0, days: 0, workouts: 0, firstDay: null, lastDay: null },
    }), TODAY);
    expect(emptyReason({ ...base, snapshot: s })).toBe('imported_nothing');
    expect(exportSource(snap()).state).toBe('imported');
  });

  test('data present means no empty state', () => {
    expect(emptyReason({ ...base, snapshot: toSnapshot(snap(), TODAY) })).toBeNull();
  });

  test('an error outranks a spinner', () => {
    expect(emptyReason({ ...base, loading: true, error: 'the local health store failed' })).toBe('error');
  });
});

/* ── The import report ────────────────────────────────────────────────────── */

describe('an import reports what it did, including what it refused', () => {
  const report = (over: Partial<ImportReport> = {}): ImportReport => ({
    fileName: 'export.zip', fileBytes: 402_653_184, exportDate: null,
    recordsRead: 40_000, recordsUsed: 39_000, recordsIgnored: 1_000, recordsRejected: 0,
    rejectionReasons: [], workouts: 4, days: 31,
    firstDay: '2026-07-09', lastDay: TODAY, detail: '',
    ...over,
  });

  test('the sentence carries the range, so nobody has to guess what was imported', () => {
    expect(describeReport(report(), TODAY)).toBe('31 days from export.zip · 9 Jul – 8 Aug · 4 workouts');
  });

  test('skipped records are never silent', () => {
    // An import that used 4 of 40,000 records must not look like a success.
    const s = describeReport(report({
      recordsUsed: 4, recordsRejected: 39_996,
      rejectionReasons: [{ reason: 'a unit Atlas does not know', count: 39_996 }],
    }), TODAY);
    expect(s).toContain('39996 records skipped');
    expect(s).toContain('a unit Atlas does not know');
  });

  test('a one-day import does not print a range of one day twice', () => {
    expect(describeReport(report({ days: 1, firstDay: TODAY, lastDay: TODAY, workouts: 0 }), TODAY))
      .toBe('1 day from export.zip · 8 Aug');
  });
});

/* ── The design vocabulary with nothing behind it ─────────────────────────── */

describe('what the surface refuses to draw', () => {
  test('signals, devices, clay and the paired device stay empty', () => {
    // These describe a live paired device. An import is a file. Filling any of
    // them from one would be inventing a connection out of a month-old zip —
    // and this stays empty even if a future backend starts sending content.
    const s = toSnapshot(snap({
      signals: [{ id: 'g1' }], devices: [{ id: 'd1' }], clay: [{ mode: 'recovery' }],
      primaryDevice: { name: 'Apple Watch' },
    }), TODAY);
    expect(s.signals).toEqual([]);
    expect(s.devices).toEqual([]);
    expect(s.clay).toEqual([]);
    expect(s.primaryDevice).toBeNull();
  });

  test('privacy arrives as statements from Rust, not as invented copy', () => {
    const s = toSnapshot(snap(), TODAY);
    expect(s.privacy).toHaveLength(1);
    expect(s.privacy[0].name).toBe('Your export is read and stored only on this Mac');
  });

  /**
   * THE PROMISE AND THE THING THAT COULD BREAK IT, BOUND TOGETHER.
   *
   * The page used to state, flatly, "Nothing leaves this Mac". In the same
   * change, `src-tauri/src/control/ops_health.rs` registered three read ops
   * whose own header says the point of them is to put a person's sleep, weight
   * and resting heart rate into a model's context. Both files were right about
   * themselves; the user-facing one was wrong about the app. It stayed true
   * only because `ATLAS_TOOL_OPS` in orchestrator.ts declares no `atlas_health`
   * group — a fact nobody had written down, in a file nobody was watching.
   *
   * So: the absolute claim is gone, and the day the group appears, the sentence
   * that says the model has no such tool has to go with it. This is what fails
   * if it does not.
   */
  test('the health privacy copy matches what the model can actually reach', async () => {
    const page = await Bun.file(new URL('../pages/atlas/AtlasHealth.tsx', import.meta.url)).text();
    // `title=` only: the string also appears in the comment above the row that
    // explains why it is not the title any more, and that comment should stay.
    expect(page.includes('title="Nothing leaves this Mac"'), 'the unscoped claim is back').toBe(false);
    expect(page.includes('Your export is read and stored only on this Mac')).toBe(true);

    const orchestrator = await Bun.file(
      new URL('../../supabase/functions/_shared/orchestrator.ts', import.meta.url),
    ).text();
    const declaresHealthGroup = (src: string) => /^\s*atlas_health\s*:/m.test(src);
    // The detector, checked against a synthetic declaration and against the
    // shape of the groups that really exist — otherwise a regex that matched
    // nothing would make the whole test pass by always taking the else branch.
    expect(declaresHealthGroup('const X = {\n  atlas_health: {\n    summary: "health.summary",')).toBe(true);
    expect(/^\s*atlas_mail\s*:/m.test(orchestrator), 'the group regex no longer matches ANY group').toBe(true);

    const modelCanReadHealth = declaresHealthGroup(orchestrator);
    const claimsNoTool = page.includes('today it has none');

    if (modelCanReadHealth) {
      expect(
        claimsNoTool,
        'orchestrator.ts now declares an atlas_health tool group, so AtlasHealth.tsx must stop '
        + 'telling the user Atlas has no tool that reads these figures',
      ).toBe(false);
    } else {
      expect(
        claimsNoTool,
        'no atlas_health tool group exists, and the page must say so rather than leaving the '
        + 'reader to assume health data is unreachable by the model forever',
      ).toBe(true);
    }
  });

  test('the surface is never marked as sample data again', () => {
    const s = toSnapshot(snap(), TODAY);
    expect(s.hasData).toBe(true);
    expect(s.coverage.rangeLabel).toBe('8 Aug · one day');
  });
});
