/**
 * The greeting gate decides whether Atlas breaks silence. It is the only thing
 * standing between "Atlas noticed something" and "Atlas talks at you every
 * time you open the app", so the interesting cases are all boundaries: noon,
 * the cooldown edge, midnight, and a signal that is present but not important
 * enough.
 *
 * Everything is pure, so the clock is injected and every case is exact — there
 * is no reason for thin coverage here.
 *
 * Run: bun test src/lib/greetingGate.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  shouldGreet, collectSalience, timeOfDay, greetingPhrase, greetingDayKey,
  loadGreetingMemo, saveGreetingMemo, DEFAULT_COOLDOWN_MS,
  type SalienceSignal, type SalienceSources,
} from '@/lib/greetingGate';

/** Instants are written as UTC and read back in UTC unless a test says otherwise. */
const at = (iso: string) => Date.parse(iso);
const UTC = 'UTC';
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A signal that clears the threshold, dated `at`. */
const strong = (ms: number, label = 'Something happened.'): SalienceSignal =>
  ({ source: 'mail', label, at: ms, weight: 0.9 });
/** A signal that is real but not worth interrupting for. */
const weak = (ms: number, label = 'A newsletter arrived.'): SalienceSignal =>
  ({ source: 'mail', label, at: ms, weight: 0.5 });

const base = {
  timeZone: UTC,
  muted: false,
  signals: [] as SalienceSignal[],
};

// ---------------------------------------------------------------------------

describe('timeOfDay — the brain\'s boundaries, implemented on the frontend', () => {
  const cases: Array<[string, string]> = [
    ['2026-08-08T04:59:00Z', 'night'],
    ['2026-08-08T05:00:00Z', 'morning'],
    ['2026-08-08T11:59:00Z', 'morning'],
    ['2026-08-08T12:00:00Z', 'afternoon'],
    ['2026-08-08T16:59:00Z', 'afternoon'],
    ['2026-08-08T17:00:00Z', 'evening'],
    ['2026-08-08T20:59:00Z', 'evening'],
    ['2026-08-08T21:00:00Z', 'night'],
    ['2026-08-08T00:00:00Z', 'night'],
  ];
  for (const [iso, bucket] of cases) {
    test(`${iso} is ${bucket}`, () => {
      expect(timeOfDay(at(iso), UTC)).toBe(bucket as never);
    });
  }

  test('17:00–18:00 is evening, which is where the old local-clock helper disagreed', () => {
    // atlasHelpers.timeOfDayGreeting() split at 18 and said "Good afternoon"
    // here while the brain's prompt said evening. One authority now.
    expect(timeOfDay(at('2026-08-08T17:30:00Z'), UTC)).toBe('evening');
    expect(greetingPhrase(at('2026-08-08T17:30:00Z'), UTC)).toBe('Good evening');
  });

  /**
   * THE RECONCILIATION, ENFORCED RATHER THAN DESCRIBED.
   *
   * Declaring `greetingPhrase` authoritative did not make it so: AtlasHome.tsx
   * went on rendering `timeOfDayGreeting()` from atlasHelpers, so `/` and the
   * voice landing screen named different times of day from the same instant
   * (17:30 → "Good evening" vs "Good afternoon"; 03:30 → "Still up" vs "Good
   * morning") and one of them ignored the user's own timezone entirely. The
   * helper is deleted; this is what stops a third implementation appearing.
   */
  test('the frontend has exactly one time of day', async () => {
    const helpers = await Bun.file(new URL('../pages/atlas/atlasHelpers.ts', import.meta.url)).text();
    expect(helpers.includes('timeOfDayGreeting')).toBe(false);

    const home = await Bun.file(new URL('../pages/atlas/AtlasHome.tsx', import.meta.url)).text();
    expect(home.includes('greetingPhrase(')).toBe(true);
    expect(home.includes('timeOfDayGreeting')).toBe(false);
    // And it is given the user's zone, not left on the device clock.
    expect(/greetingPhrase\(.*profile\?\.timezone/.test(home)).toBe(true);

    const dash = await Bun.file(new URL('../pages/atlas/AtlasDashboard.tsx', import.meta.url)).text();
    expect(dash.includes('greetingPhrase(')).toBe(true);
  });

  test('the zone, not the machine, decides', () => {
    const instant = at('2026-08-08T02:00:00Z');
    expect(timeOfDay(instant, UTC)).toBe('night');
    expect(timeOfDay(instant, 'Asia/Tokyo')).toBe('morning');       // 11:00
    expect(timeOfDay(instant, 'America/Los_Angeles')).toBe('evening'); // 19:00
  });

  test('an unknown zone falls back to the device instead of throwing', () => {
    expect(() => timeOfDay(at('2026-08-08T09:00:00Z'), 'Mars/Olympus_Mons')).not.toThrow();
    expect(['morning', 'afternoon', 'evening', 'night']).toContain(
      timeOfDay(at('2026-08-08T09:00:00Z'), 'Mars/Olympus_Mons'),
    );
  });

  test('night gets a phrase that is never factually wrong', () => {
    expect(greetingPhrase(at('2026-08-08T03:00:00Z'), UTC)).toBe('Still up');
    expect(greetingPhrase(at('2026-08-08T08:00:00Z'), UTC)).toBe('Good morning');
    expect(greetingPhrase(at('2026-08-08T13:00:00Z'), UTC)).toBe('Good afternoon');
  });
});

describe('greetingDayKey — a day starts at 05:00, not midnight', () => {
  test('the small hours belong to the night before', () => {
    expect(greetingDayKey(at('2026-08-08T01:00:00Z'), UTC)).toBe('2026-08-07');
    expect(greetingDayKey(at('2026-08-08T04:59:00Z'), UTC)).toBe('2026-08-07');
    expect(greetingDayKey(at('2026-08-08T05:00:00Z'), UTC)).toBe('2026-08-08');
  });

  test('it rolls back across a month boundary', () => {
    expect(greetingDayKey(at('2026-08-01T02:00:00Z'), UTC)).toBe('2026-07-31');
  });

  test('it is computed in the user\'s zone', () => {
    // 22:00 in Los Angeles on the 7th is 05:00 UTC on the 8th.
    const instant = at('2026-08-08T05:00:00Z');
    expect(greetingDayKey(instant, UTC)).toBe('2026-08-08');
    expect(greetingDayKey(instant, 'America/Los_Angeles')).toBe('2026-08-07');
  });
});

// ---------------------------------------------------------------------------

describe('shouldGreet — muted', () => {
  test('muted outranks even the morning-first-of-day rule', () => {
    const d = shouldGreet({
      ...base, now: at('2026-08-08T08:00:00Z'), lastGreetedAt: null, muted: true,
      signals: [strong(at('2026-08-08T07:55:00Z'))],
    });
    expect(d.speak).toBe(false);
    expect(d.reason).toContain('Muted');
  });

  test('unmuting the same launch lets the greeting through', () => {
    const args = { ...base, now: at('2026-08-08T08:00:00Z'), lastGreetedAt: null };
    expect(shouldGreet({ ...args, muted: true }).speak).toBe(false);
    expect(shouldGreet({ ...args, muted: false }).speak).toBe(true);
  });
});

describe('shouldGreet — the morning rule', () => {
  // These all pass a real timestamp from a PREVIOUS day rather than null.
  // `null` now means "never greeted at all", which speaks unconditionally (see
  // the never-greeted block at the end of this file) — a different rule that
  // would short-circuit every case here. The two states were conflated while
  // null happened to satisfy both; separating them is what made that visible.
  const YESTERDAY = at('2026-08-07T08:00:00Z');

  test('first interaction of the day, in the morning, always speaks', () => {
    const d = shouldGreet({ ...base, now: at('2026-08-08T07:00:00Z'), lastGreetedAt: YESTERDAY });
    expect(d.speak).toBe(true);
    expect(d.reason).toBe("First time we've spoken today.");
  });

  test('it speaks with nothing at all going on — that is the point of "always"', () => {
    const d = shouldGreet({
      ...base, now: at('2026-08-08T11:59:00Z'), lastGreetedAt: YESTERDAY, signals: [],
    });
    expect(d.speak).toBe(true);
  });

  test('the top signal rides along even below the speaking threshold', () => {
    const d = shouldGreet({
      ...base, now: at('2026-08-08T08:00:00Z'), lastGreetedAt: YESTERDAY,
      signals: [weak(at('2026-08-08T07:00:00Z'), 'Two newsletters arrived.')],
    });
    expect(d.speak).toBe(true);
    expect(d.reason).toBe("First time we've spoken today — two newsletters arrived.");
  });

  test('an acronym is not lower-cased when it rides along', () => {
    const d = shouldGreet({
      ...base, now: at('2026-08-08T08:00:00Z'), lastGreetedAt: YESTERDAY,
      signals: [strong(at('2026-08-08T07:00:00Z'), 'AWS invoice is due today.')],
    });
    expect(d.reason).toBe("First time we've spoken today — AWS invoice is due today.");
  });

  test('after noon, a first launch with nothing relevant stays quiet', () => {
    const d = shouldGreet({ ...base, now: at('2026-08-08T12:00:00Z'), lastGreetedAt: YESTERDAY });
    expect(d.speak).toBe(false);
    expect(d.reason).toContain('morning has passed');
  });

  test('11:59 speaks and 12:00 does not — the noon boundary is exact', () => {
    expect(shouldGreet({ ...base, now: at('2026-08-08T11:59:59Z'), lastGreetedAt: YESTERDAY }).speak).toBe(true);
    expect(shouldGreet({ ...base, now: at('2026-08-08T12:00:00Z'), lastGreetedAt: YESTERDAY }).speak).toBe(false);
  });

  test('04:00 is not morning, so a 4am launch is not greeted for nothing', () => {
    // Before noon, but "every morning" does not mean 4am. The bucket is the
    // brain's, so the written and spoken halves agree about what morning is.
    expect(shouldGreet({ ...base, now: at('2026-08-08T04:00:00Z'), lastGreetedAt: YESTERDAY }).speak).toBe(false);
  });

  test('a repeat launch the same greeting day, still morning, stays quiet', () => {
    const yesterdayMorning = at('2026-08-08T07:00:00Z');
    const d = shouldGreet({
      ...base, now: at('2026-08-08T10:00:00Z'), lastGreetedAt: yesterdayMorning,
    });
    expect(d.speak).toBe(false);
    expect(d.reason).toContain('Nothing new');
  });

  test('the next morning speaks again', () => {
    const d = shouldGreet({
      ...base, now: at('2026-08-09T07:00:00Z'), lastGreetedAt: at('2026-08-08T07:00:00Z'),
    });
    expect(d.speak).toBe(true);
  });
});

describe('shouldGreet — the cooldown', () => {
  const now = at('2026-08-08T14:00:00Z');
  const signals = [strong(now - MIN)];

  test('one millisecond inside the window is silent', () => {
    const d = shouldGreet({ ...base, now, lastGreetedAt: now - DEFAULT_COOLDOWN_MS + 1, signals });
    expect(d.speak).toBe(false);
    expect(d.reason).toContain('minutes');
  });

  test('exactly at the window it may speak again', () => {
    const d = shouldGreet({ ...base, now, lastGreetedAt: now - DEFAULT_COOLDOWN_MS, signals });
    expect(d.speak).toBe(true);
  });

  test('the cooldown is configurable and respected', () => {
    const args = { ...base, now, signals, lastGreetedAt: now - 10 * MIN };
    expect(shouldGreet({ ...args, cooldownMs: 20 * MIN }).speak).toBe(false);
    expect(shouldGreet({ ...args, cooldownMs: 5 * MIN }).speak).toBe(true);
  });

  test('a memo dated in the future is treated as "just now", not as a licence to speak', () => {
    // A backwards clock step (NTP, timezone change, sleep) must not open the gate.
    const d = shouldGreet({ ...base, now, lastGreetedAt: now + HOUR, signals });
    expect(d.speak).toBe(false);
  });

  test('the cooldown outranks the morning rule', () => {
    // 04:50 greeting, 05:10 relaunch: a brand-new greeting day, and morning,
    // but twenty minutes is not a new conversation.
    const d = shouldGreet({
      ...base, now: at('2026-08-08T05:10:00Z'), lastGreetedAt: at('2026-08-08T04:50:00Z'),
    });
    expect(d.speak).toBe(false);
    expect(d.reason).toContain('20 minutes ago');
  });

  test('and the morning is not lost — the next interaction after the cooldown gets it', () => {
    const d = shouldGreet({
      ...base, now: at('2026-08-08T07:00:00Z'), lastGreetedAt: at('2026-08-08T04:50:00Z'),
    });
    expect(d.speak).toBe(true);
    expect(d.reason).toContain("First time we've spoken today");
  });
});

describe('shouldGreet — the clock crossing midnight between calls', () => {
  test('a new calendar date twenty minutes later is not a new day', () => {
    const d = shouldGreet({
      ...base, now: at('2026-08-09T00:10:00Z'), lastGreetedAt: at('2026-08-08T23:50:00Z'),
    });
    expect(d.speak).toBe(false);
  });

  test('and it is still not a new day once the cooldown has expired', () => {
    // The cooldown alone would have let this through at 01:30. The 05:00 day
    // anchor is what keeps Atlas from saying good morning at half past one.
    const d = shouldGreet({
      ...base, now: at('2026-08-09T01:30:00Z'), lastGreetedAt: at('2026-08-08T23:50:00Z'),
    });
    expect(d.speak).toBe(false);
    expect(greetingDayKey(at('2026-08-09T01:30:00Z'), UTC)).toBe('2026-08-08');
  });

  test('a 01:00 session does not burn the morning that follows it', () => {
    // The night-owl case the calendar-date rule gets wrong: greeted at 01:00,
    // the 08:00 launch is the same DATE but a different greeting day.
    const d = shouldGreet({
      ...base, now: at('2026-08-08T08:00:00Z'), lastGreetedAt: at('2026-08-08T01:00:00Z'),
    });
    expect(d.speak).toBe(true);
    expect(d.reason).toContain("First time we've spoken today");
  });
});

describe('shouldGreet — salience outside the morning', () => {
  const now = at('2026-08-08T15:00:00Z');
  const lastGreetedAt = at('2026-08-08T08:00:00Z');

  test('nothing new: silent', () => {
    expect(shouldGreet({ ...base, now, lastGreetedAt, signals: [] }).speak).toBe(false);
  });

  test('an unseen high signal speaks, and the reason is the signal itself', () => {
    const d = shouldGreet({
      ...base, now, lastGreetedAt,
      signals: [strong(at('2026-08-08T14:40:00Z'), 'Your electricity bill is due Friday.')],
    });
    expect(d).toEqual({ speak: true, reason: 'Your electricity bill is due Friday.' });
  });

  test('a signal older than the last greeting is not unseen', () => {
    const d = shouldGreet({
      ...base, now, lastGreetedAt,
      signals: [strong(at('2026-08-08T07:00:00Z'))],
    });
    expect(d.speak).toBe(false);
  });

  test('a signal at exactly the last greeting is not unseen either', () => {
    expect(shouldGreet({ ...base, now, lastGreetedAt, signals: [strong(lastGreetedAt)] }).speak).toBe(false);
  });

  test('a real but low-weight signal is not worth interrupting for', () => {
    const d = shouldGreet({ ...base, now, lastGreetedAt, signals: [weak(now - MIN)] });
    expect(d.speak).toBe(false);
    expect(d.reason).toContain('worth interrupting');
  });

  test('the heaviest unseen signal wins the reason', () => {
    const d = shouldGreet({
      ...base, now, lastGreetedAt,
      signals: [
        { source: 'insight', label: 'Lower.', at: now - MIN, weight: 0.75 },
        { source: 'mail', label: 'Higher.', at: now - 10 * MIN, weight: 0.9 },
      ],
    });
    expect(d.reason).toBe('Higher.');
  });

  test('evening and night are eligible too — relevance is not a morning-only thing', () => {
    for (const iso of ['2026-08-08T19:00:00Z', '2026-08-08T23:00:00Z']) {
      const d = shouldGreet({
        ...base, now: at(iso), lastGreetedAt: at('2026-08-08T08:00:00Z'),
        signals: [strong(at(iso) - MIN, 'Your flight is delayed.')],
      });
      expect(d.speak).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe('collectSalience — each source, present and absent', () => {
  const now = at('2026-08-08T15:00:00Z');
  const empty: SalienceSources = {
    now, events: [], mailAlerts: [], insights: [],
    unresolvedErrors: 0, errorsAtLastGreeting: 0,
  };

  test('nothing in, nothing out', () => {
    expect(collectSalience(empty)).toEqual([]);
  });

  // --- calendar ---
  test('an imminent event is salient', () => {
    const s = collectSalience({
      ...empty,
      events: [{ title: 'Standup', start_time: '2026-08-08T15:25:00Z' }],
    });
    expect(s).toHaveLength(1);
    expect(s[0].source).toBe('calendar');
    // The event's own clock time, NOT "in 25 minutes" — see below.
    expect(s[0].label).toBe('Standup at 15:25.');
    expect(s[0].weight).toBeGreaterThanOrEqual(0.7);
  });

  test('it becomes salient when it enters the window, not when the row was written', () => {
    const start = at('2026-08-08T15:25:00Z');
    const s = collectSalience({ ...empty, events: [{ title: 'Standup', start_time: '2026-08-08T15:25:00Z' }] });
    expect(s[0].at).toBe(start - 90 * MIN);
  });

  test('an event further out than the window is not salient yet', () => {
    expect(collectSalience({
      ...empty, events: [{ title: 'Dinner', start_time: '2026-08-08T19:00:00Z' }],
    })).toEqual([]);
  });

  test('an event that already started is not salient', () => {
    expect(collectSalience({
      ...empty, events: [{ title: 'Standup', start_time: '2026-08-08T14:00:00Z' }],
    })).toEqual([]);
  });

  test('an untitled or undated event is dropped rather than announced as blank', () => {
    expect(collectSalience({
      ...empty,
      events: [
        { title: '', start_time: '2026-08-08T15:10:00Z' },
        { title: 'No date', start_time: null },
        { title: 'Garbage date', start_time: 'not-a-date' },
      ],
    })).toEqual([]);
  });

  /**
   * THE LABEL MUST NOT GO STALE, because the thing that renders it is latched.
   *
   * AtlasDashboard freezes the decision the first time Atlas speaks (so the
   * band can never retract something it already said) and then renders
   * `reason` verbatim for the life of the window. A countdown composed at the
   * launch instant — which is what this used to be — was therefore still
   * claiming "Standup starts in 25 minutes" an hour after the standup ended.
   * A wall-clock time is true whenever it is read.
   */
  test('the label carries no relative time, so latching it cannot make it false', () => {
    const s = collectSalience({ ...empty, events: [{ title: 'Standup', start_time: '2026-08-08T15:01:00Z' }] });
    expect(s[0].label).toBe('Standup at 15:01.');
    for (const banned of ['starts in', 'minute', 'now', 'ago', 'soon']) {
      expect(s[0].label.includes(banned)).toBe(false);
    }
  });

  test('the same label is produced whatever "now" is inside the window', () => {
    const ev = [{ title: 'Standup', start_time: '2026-08-08T15:25:00Z' }];
    const early = collectSalience({ ...empty, now: at('2026-08-08T14:00:00Z'), events: ev });
    const late = collectSalience({ ...empty, now: at('2026-08-08T15:24:00Z'), events: ev });
    expect(early[0].label).toBe(late[0].label);
  });

  test('the clock time is the USER\u2019s, not the machine\u2019s', () => {
    const ev = [{ title: 'Standup', start_time: '2026-08-08T15:25:00Z' }];
    // The suite runs pinned to UTC, so this would read 15:25 on the device.
    expect(collectSalience({ ...empty, events: ev, timeZone: 'Asia/Tokyo' })[0].label)
      .toBe('Standup at 00:25.');
    // A zone this ICU build does not know must not take the greeting down.
    expect(collectSalience({ ...empty, events: ev, timeZone: 'Mars/Olympus' })[0].label)
      .toBe('Standup at 15:25.');
  });

  // --- mail ---
  test('a deadline or bill alert clears the threshold; a document does not', () => {
    const s = collectSalience({
      ...empty,
      mailAlerts: [
        { alert_type: 'deadline', title: 'Tax return due Monday', created_at: '2026-08-08T14:00:00Z' },
        { alert_type: 'bill', title: 'Electricity bill', created_at: '2026-08-08T14:00:00Z' },
        { alert_type: 'important', title: 'Reply requested', created_at: '2026-08-08T14:00:00Z' },
        { alert_type: 'document', title: 'Contract attached', created_at: '2026-08-08T14:00:00Z' },
      ],
    });
    const byLabel = Object.fromEntries(s.map((x) => [x.label, x.weight]));
    expect(byLabel['Tax return due Monday']).toBeGreaterThanOrEqual(0.7);
    expect(byLabel['Electricity bill']).toBeGreaterThanOrEqual(0.7);
    expect(byLabel['Reply requested']).toBeGreaterThanOrEqual(0.7);
    expect(byLabel['Contract attached']).toBeLessThan(0.7);
  });

  test('an alert of an unknown type is kept but does not get to interrupt', () => {
    const s = collectSalience({
      ...empty, mailAlerts: [{ alert_type: 'newsletter', title: 'Weekly digest', created_at: '2026-08-08T14:00:00Z' }],
    });
    expect(s[0].weight).toBeLessThan(0.7);
  });

  test('an alert with no title is dropped rather than shown empty', () => {
    expect(collectSalience({
      ...empty, mailAlerts: [{ alert_type: 'bill', title: '', created_at: '2026-08-08T14:00:00Z' }],
    })).toEqual([]);
  });

  test('an alert with no timestamp is treated as new right now', () => {
    const s = collectSalience({ ...empty, mailAlerts: [{ alert_type: 'bill', title: 'X', created_at: null }] });
    expect(s[0].at).toBe(now);
  });

  // --- insights ---
  test('a default-priority insight speaks: the digest already decided it was worth saying', () => {
    const s = collectSalience({
      ...empty, insights: [{ title: 'You have three meetings back to back.', priority: 5, created_at: '2026-08-08T14:30:00Z' }],
    });
    expect(s[0].source).toBe('insight');
    expect(s[0].weight).toBeGreaterThanOrEqual(0.7);
  });

  test('an insight with no priority is treated as the schema default', () => {
    const s = collectSalience({ ...empty, insights: [{ title: 'X', priority: null, created_at: null }] });
    expect(s[0].weight).toBeGreaterThanOrEqual(0.7);
  });

  test('an explicitly low-priority insight does not interrupt', () => {
    const s = collectSalience({ ...empty, insights: [{ title: 'X', priority: 2, created_at: null }] });
    expect(s[0].weight).toBeLessThan(0.7);
  });

  test('a high-priority insight outweighs a bill', () => {
    const s = collectSalience({
      ...empty,
      insights: [{ title: 'Urgent', priority: 9, created_at: '2026-08-08T14:30:00Z' }],
      mailAlerts: [{ alert_type: 'bill', title: 'Bill', created_at: '2026-08-08T14:30:00Z' }],
    });
    const insight = s.find((x) => x.source === 'insight');
    const mail = s.find((x) => x.source === 'mail');
    expect(insight.weight).toBeGreaterThan(mail.weight);
  });

  // --- health ---
  test('errors below the floor are not worth mentioning', () => {
    expect(collectSalience({ ...empty, unresolvedErrors: 2, errorsAtLastGreeting: 0 })).toEqual([]);
  });

  test('errors above the floor, and worse than last time, are', () => {
    const s = collectSalience({ ...empty, unresolvedErrors: 5, errorsAtLastGreeting: 1 });
    expect(s).toHaveLength(1);
    expect(s[0].source).toBe('health');
    expect(s[0].label).toContain('5 unresolved errors');
    expect(s[0].weight).toBeGreaterThanOrEqual(0.7);
  });

  test('the same fault is not announced twice — health edge-triggers', () => {
    expect(collectSalience({ ...empty, unresolvedErrors: 5, errorsAtLastGreeting: 5 })).toEqual([]);
    expect(collectSalience({ ...empty, unresolvedErrors: 4, errorsAtLastGreeting: 5 })).toEqual([]);
  });

  test('a first-ever greeting sees the fault it inherited', () => {
    const s = collectSalience({ ...empty, unresolvedErrors: 5, errorsAtLastGreeting: null });
    expect(s).toHaveLength(1);
  });

  // --- together ---
  test('all four sources at once produce four signals', () => {
    const s = collectSalience({
      now,
      events: [{ title: 'Standup', start_time: '2026-08-08T15:20:00Z' }],
      mailAlerts: [{ alert_type: 'bill', title: 'Bill', created_at: '2026-08-08T14:00:00Z' }],
      insights: [{ title: 'Insight', priority: 5, created_at: '2026-08-08T14:00:00Z' }],
      unresolvedErrors: 9, errorsAtLastGreeting: 0,
    });
    expect(s.map((x) => x.source).sort()).toEqual(['calendar', 'health', 'insight', 'mail']);
  });

  test('the collected signals actually drive the gate end to end', () => {
    const signals = collectSalience({
      ...empty,
      mailAlerts: [{ alert_type: 'deadline', title: 'Passport expires in a week', created_at: '2026-08-08T14:30:00Z' }],
    });
    const d = shouldGreet({
      now, timeZone: UTC, muted: false, signals, lastGreetedAt: at('2026-08-08T08:00:00Z'),
    });
    expect(d).toEqual({ speak: true, reason: 'Passport expires in a week' });
  });
});

// ---------------------------------------------------------------------------

describe('the memo', () => {
  let store: Record<string, string>;
  const original = (globalThis as { localStorage?: Storage }).localStorage;

  beforeEach(() => {
    store = {};
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  test('round-trips', () => {
    saveGreetingMemo({ userId: 'u1', at: 123, errorCount: 4 });
    expect(loadGreetingMemo('u1')).toEqual({ userId: 'u1', at: 123, errorCount: 4 });
  });

  test('another user does not inherit the first one\'s silence', () => {
    saveGreetingMemo({ userId: 'u1', at: 123, errorCount: 4 });
    expect(loadGreetingMemo('u2')).toBeNull();
  });

  test('no user, no memo', () => {
    saveGreetingMemo({ userId: 'u1', at: 123, errorCount: 4 });
    expect(loadGreetingMemo(null)).toBeNull();
    expect(loadGreetingMemo(undefined)).toBeNull();
  });

  test('an absent memo reads as "never greeted", which is what makes the first launch speak', () => {
    expect(loadGreetingMemo('u1')).toBeNull();
    expect(shouldGreet({ ...base, now: at('2026-08-08T08:00:00Z'), lastGreetedAt: null }).speak).toBe(true);
  });

  test('a corrupt memo cannot stop Atlas from greeting', () => {
    store['atlas-greeting-memo'] = '{not json';
    expect(loadGreetingMemo('u1')).toBeNull();
    store['atlas-greeting-memo'] = JSON.stringify({ userId: 'u1', at: 'yesterday' });
    expect(loadGreetingMemo('u1')).toBeNull();
  });

  test('a memo missing errorCount reads as zero rather than blocking the health signal', () => {
    store['atlas-greeting-memo'] = JSON.stringify({ userId: 'u1', at: 123 });
    expect(loadGreetingMemo('u1')).toEqual({ userId: 'u1', at: 123, errorCount: 0 });
  });

  test('a storage that throws does not take the render path down', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    };
    expect(() => saveGreetingMemo({ userId: 'u1', at: 1, errorCount: 0 })).not.toThrow();
    expect(loadGreetingMemo('u1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The never-greeted rule. Product decision: the FIRST time Atlas ever runs it
// always speaks — whatever the hour, whatever the signals.
//
// Why it earns an exception to every other rule: opening in silence on first
// launch is the one case where saying nothing is unambiguously wrong. A product
// whose premise is that it talks to you should not leave a new user wondering
// whether the voice works at all. Every other silence is a judgement about
// whether anything is worth interrupting for; this one has no history to weigh.
// ---------------------------------------------------------------------------

describe('shouldGreet — never greeted before', () => {
  test('speaks in the afternoon with no signals at all', () => {
    // Every other rule would say no here: past the morning window, nothing
    // unseen, nothing above the salience threshold.
    const d = shouldGreet({
      ...base,
      now: at('2026-08-10T15:30:00Z'),
      lastGreetedAt: null,
    });
    expect(d.speak).toBe(true);
    expect(d.reason).toContain('First time');
  });

  test('speaks at night too — the hour is not a reason to stay silent once', () => {
    const d = shouldGreet({ ...base, now: at('2026-08-10T23:10:00Z'), lastGreetedAt: null });
    expect(d.speak).toBe(true);
  });

  test('mentions the top signal when there is one, without needing it', () => {
    const withSignal = shouldGreet({
      ...base,
      now: at('2026-08-10T15:30:00Z'),
      lastGreetedAt: null,
      signals: [weak(at('2026-08-10T15:00:00Z'), 'A newsletter arrived.')],
    });
    expect(withSignal.speak).toBe(true);
    // A weak signal cannot break silence on its own, but if Atlas is talking
    // anyway it is the most useful thing it can say.
    expect(withSignal.reason).toContain('newsletter');
  });

  test('MUTE STILL WINS — "always" does not outrank a microphone the user turned off', () => {
    const d = shouldGreet({
      ...base,
      muted: true,
      now: at('2026-08-10T15:30:00Z'),
      lastGreetedAt: null,
    });
    expect(d.speak).toBe(false);
  });

  test('and once it HAS greeted, the ordinary rules resume', () => {
    // Same afternoon, same absence of signals — but now there is a history, so
    // the exception no longer applies and Atlas goes quiet.
    const d = shouldGreet({
      ...base,
      now: at('2026-08-10T15:30:00Z'),
      lastGreetedAt: at('2026-08-09T08:00:00Z'),
    });
    expect(d.speak).toBe(false);
  });
});
