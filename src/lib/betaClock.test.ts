import { describe, expect, test } from 'bun:test';
import {
  COUNTDOWN_IDLE, DEFAULT_CITIES, RING_C, TIMER_IDLE, afterFire, alarmWhen, bandCells, bandPills, bandX, cellAlpha,
  cityForZone, pillWidth, cityRows, countdownCanStart, countdownLeft, countdownStatus, countdownTotal, currentLap, dateLine,
  dayDelta, daysLabel, diffLabel, draftAlarm, dueAlarms, earlyNext, finishAlarm, fmtDuration, heroLine, homeSun,
  homeZone, hourDiff, inLabel, lapCountLabel, lapRows, nextAlarm, nextFire, offsetLabel, parseClockTime, parseHHMM,
  parsePrefs, ringOffset, searchCities, snoozeLine, splitRows, sunCaption, sunSpan, sunUp, timerElapsed, timerStatus,
  validZone, whenLabel, zoneForPlace, zoneInstant, zoneOffsetMinutes, zoneTime,
  type Alarm,
} from './betaClock';

// 2026-01-14 10:30:00 UTC — a Wednesday, deep in northern winter (no DST anywhere north).
const WINTER = Date.UTC(2026, 0, 14, 10, 30, 0);
// 2026-07-15 10:30:00 UTC — a Wednesday in northern summer.
const SUMMER = Date.UTC(2026, 6, 15, 10, 30, 0);

const alarm = (over: Partial<Alarm> = {}): Alarm => ({ id: 'a1', time: '07:30', label: 'Wake up', days: [1, 2, 3, 4, 5], on: true, snoozedUntil: null, ...over });

describe('zones', () => {
  test('zoneTime reads the wall clock in a zone', () => {
    const cph = zoneTime('Europe/Copenhagen', WINTER);
    expect([cph.hour, cph.minute, cph.weekday, cph.dateKey]).toEqual([11, 30, 3, '2026-01-14']);
    const tokyo = zoneTime('Asia/Tokyo', WINTER);
    expect([tokyo.hour, tokyo.minuteOfDay]).toEqual([19, 19 * 60 + 30]);
    const la = zoneTime('America/Los_Angeles', WINTER);
    expect(la.hour).toBe(2);
  });
  test('offsets follow daylight saving', () => {
    expect(zoneOffsetMinutes('Europe/Copenhagen', WINTER)).toBe(60);
    expect(zoneOffsetMinutes('Europe/Copenhagen', SUMMER)).toBe(120);
    expect(zoneOffsetMinutes('America/Los_Angeles', WINTER)).toBe(-480);
    expect(zoneOffsetMinutes('Asia/Kolkata', WINTER)).toBe(330);
    expect(zoneOffsetMinutes('UTC', WINTER + 123)).toBe(0);
  });
  test('zoneInstant lands on the wall clock asked for', () => {
    const at = zoneInstant('Europe/Copenhagen', 2026, 1, 14, 7, 30);
    expect(zoneTime('Europe/Copenhagen', at).minuteOfDay).toBe(450);
    expect(at).toBe(Date.UTC(2026, 0, 14, 6, 30));
    // Across a DST change: 29 March 2026, 02:00 CET does not exist; 07:30 CEST does.
    const spring = zoneInstant('Europe/Copenhagen', 2026, 3, 29, 7, 30);
    expect(zoneTime('Europe/Copenhagen', spring).minuteOfDay).toBe(450);
    expect(spring).toBe(Date.UTC(2026, 2, 29, 5, 30));
  });
  test('day deltas, hour differences and their labels', () => {
    expect(dayDelta('2026-01-14', '2026-01-15')).toBe(1);
    expect(dayDelta('2026-01-14', '2026-01-13')).toBe(-1);
    expect(hourDiff('Asia/Tokyo', 'Europe/Copenhagen', WINTER)).toBe(8);
    expect(hourDiff('Asia/Kolkata', 'Europe/Copenhagen', WINTER)).toBe(4.5);
    expect(diffLabel(0)).toBe('Same time');
    expect(diffLabel(8)).toBe('+8 h');
    expect(diffLabel(-9)).toBe('−9 h');
    expect(diffLabel(4.5)).toBe('+4.5 h');
  });
  test('validZone accepts IANA names and rejects junk', () => {
    expect(validZone('Europe/Copenhagen')).toBe('Europe/Copenhagen');
    expect(validZone('Mars/Olympus')).toBeNull();
    expect(validZone('')).toBeNull();
    expect(validZone(undefined)).toBeNull();
  });
  test('cityForZone names an unknown zone from its leaf', () => {
    expect(cityForZone('Europe/Copenhagen').name).toBe('Copenhagen');
    expect(cityForZone('America/Argentina/Buenos_Aires')).toEqual({ name: 'Buenos Aires', tz: 'America/Argentina/Buenos_Aires' });
  });
});

describe('city rows', () => {
  const home = { name: 'Copenhagen', tz: 'Europe/Copenhagen' };
  test('home first, then the saved cities, each with its own clock and badge', () => {
    const rows = cityRows(home, [{ name: 'Tokyo', tz: 'Asia/Tokyo' }, { name: 'Auckland', tz: 'Pacific/Auckland' }, { name: 'San Francisco', tz: 'America/Los_Angeles' }], WINTER);
    expect(rows.map((r) => r.time)).toEqual(['11:30', '19:30', '23:30', '02:30']);
    expect(rows.map((r) => r.diff)).toEqual(['Home', '+8 h', '+12 h', '−9 h']);
    expect(rows.map((r) => r.badge)).toEqual(['Today', 'Today', 'Today', 'Today']);
    expect(rows.map((r) => r.night)).toEqual([false, false, true, true]);
    expect(rows[0].home).toBe(true);
  });
  test('a city across midnight is Tomorrow', () => {
    const late = Date.UTC(2026, 0, 14, 22, 0, 0); // 23:00 in Copenhagen, 07:00 next day in Tokyo
    const rows = cityRows(home, [{ name: 'Tokyo', tz: 'Asia/Tokyo' }], late);
    expect(rows[1].badge).toBe('Tomorrow');
  });
  test('searchCities skips home and what is already shown, five at most', () => {
    expect(searchCities('lon', [], 'Europe/Copenhagen').map((c) => c.name)).toEqual(['London']);
    expect(searchCities('lon', [{ name: 'London', tz: 'Europe/London' }], 'Europe/Copenhagen')).toEqual([]);
    expect(searchCities('copen', [], 'Europe/Copenhagen')).toEqual([]);
    expect(searchCities('a', [], 'UTC').length).toBeLessThanOrEqual(5);
    expect(searchCities('   ', [], 'UTC')).toEqual([]);
  });
  test('the default extra clocks are the Home widget\'s three', () => {
    expect(DEFAULT_CITIES.map((c) => c.name)).toEqual(['San Francisco', 'London', 'Tokyo']);
  });
});

describe('the band', () => {
  test('parses the weather\'s 12-hour clock and a 24-hour one', () => {
    expect(parseClockTime('6:42 AM')).toBe(402);
    expect(parseClockTime('5:24 PM')).toBe(1044);
    expect(parseClockTime('12:05 AM')).toBe(5);
    expect(parseClockTime('12:05 PM')).toBe(725);
    expect(parseClockTime('17:24')).toBe(1044);
    expect(parseClockTime('24:00')).toBeNull();
    expect(parseClockTime('soon')).toBeNull();
    expect(parseClockTime(null)).toBeNull();
    expect(sunSpan('6:42 AM', '5:24 PM')).toEqual({ sunrise: 402, sunset: 1044 });
    expect(sunSpan('5:24 PM', '6:42 AM')).toBeNull();
  });
  test('cells follow the sun, with the design\'s three opacities', () => {
    const cells = bandCells({ sunrise: 402, sunset: 1044 });
    expect(cells).toHaveLength(24);
    expect(cells[3].light).toBe(0);
    expect(cells[6].light).toBe(0.3); // 06:42–07:00
    expect(cells[12].light).toBe(1);
    expect(cells[17].light).toBe(0.4); // 17:00–17:24
    expect(cells[12].high).toBe(true);
    expect(cells[8].high).toBe(false);
    expect(cellAlpha(cells[3])).toBe(0.04);
    expect(cellAlpha(cells[12])).toBe(0.18);
    expect(cellAlpha(cells[8])).toBe(0.11);
  });
  test('without a sun the generic day stands in: 06–20, brighter 09–17', () => {
    const cells = bandCells(null);
    expect(cells.filter((c) => c.light > 0).map((c) => c.hour)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(cells.filter((c) => c.high).map((c) => c.hour)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });
  test('positions and pills', () => {
    expect(bandX(0)).toBe(0);
    expect(bandX(720)).toBe(50);
    expect(bandX(1439)).toBe(99.93);
  });
  test('pills sit on their hour and inside the band', () => {
    const home = { name: 'Copenhagen', tz: 'Europe/Copenhagen' };
    const pills = bandPills(home, [{ name: 'Tokyo', tz: 'Asia/Tokyo' }, { name: 'San Francisco', tz: 'America/Los_Angeles' }], WINTER, 5, 1000);
    expect(pills.map((p) => p.name)).toEqual(['San Francisco', 'Copenhagen', 'Tokyo']);
    // Wide band: nobody collides, so everyone sits in the first row, named, on their own hour.
    expect(pills.map((p) => [p.y, p.compact])).toEqual([[28, false], [28, false], [28, false]]);
    expect(pills[1].home).toBe(true);
    expect(pills[1].x).toBeCloseTo(47.92, 1);
    expect(pills[1].hourX).toBeCloseTo(47.92, 1);
    // On a 600px band San Francisco at 02:30 would hang off the left end; its centre moves in, its hour does not.
    const sf = bandPills(home, [{ name: 'San Francisco', tz: 'America/Los_Angeles' }], WINTER, 5, 600).find((p) => !p.home)!;
    expect(sf.hourX).toBeCloseTo(10.42, 1);
    expect(sf.x).toBeGreaterThan(sf.hourX);
    expect((sf.x / 100) * 600 - pillWidth('02:30', 'San Francisco') / 2).toBeGreaterThanOrEqual(5.9);
  });
  test('a narrow band stacks, then drops names, then cities', () => {
    const home = { name: 'Copenhagen', tz: 'Europe/Copenhagen' };
    const cities = [{ name: 'San Francisco', tz: 'America/Los_Angeles' }, { name: 'Sydney', tz: 'Australia/Sydney' }];
    // 300px: Copenhagen 11:30 and San Francisco 02:30 overlap, so San Francisco takes row two.
    const narrow = bandPills(home, cities, WINTER, 3, 300);
    const byName = Object.fromEntries(narrow.map((p) => [p.name, p]));
    expect(byName.Copenhagen.y).toBe(28);
    expect(byName['San Francisco'].y).toBe(72);
    // No two pills in a row overlap.
    for (const row of [28, 72]) {
      const spans = narrow.filter((p) => p.y === row).map((p) => {
        const w = pillWidth(p.time, p.compact ? null : p.name);
        return [(p.x / 100) * 300 - w / 2, (p.x / 100) * 300 + w / 2];
      }).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    }
    // Very narrow: names go before cities do, and home keeps its name longest.
    const tiny = bandPills(home, cities, WINTER, 3, 160);
    expect(tiny.find((p) => p.home)?.compact).toBe(false);
    expect(tiny.some((p) => !p.home && p.compact) || tiny.length < 3).toBe(true);
    // The cap: home plus max − 1.
    expect(bandPills(home, [...cities, { name: 'Tokyo', tz: 'Asia/Tokyo' }], WINTER, 2, 1000).map((p) => p.name).sort()).toEqual(['Copenhagen', 'San Francisco']);
  });
  test('sunUp needs a reading', () => {
    expect(sunUp(null, 600)).toBeNull();
    expect(sunUp({ sunrise: 402, sunset: 1044 }, 600)).toBe(true);
    expect(sunUp({ sunrise: 402, sunset: 1044 }, 1044)).toBe(false);
  });
});

describe('durations', () => {
  test('fmtDuration', () => {
    expect(fmtDuration(0)).toBe('00:00');
    expect(fmtDuration(65_000)).toBe('01:05');
    expect(fmtDuration(3_725_000)).toBe('1:02:05');
    expect(fmtDuration(12_340, true)).toBe('00:12.34');
    expect(fmtDuration(-90_000)).toBe('01:30');
  });
  test('inLabel', () => {
    expect(inLabel(12 * 60000)).toBe('in 12 min');
    expect(inLabel(125 * 60000)).toBe('in 2 h 5 min');
    expect(inLabel(50 * 3600000)).toBe('in 2 d 2 h');
  });
});

describe('timer', () => {
  test('elapsed banks earlier runs and adds the live one', () => {
    expect(timerElapsed(TIMER_IDLE, 1000)).toBe(0);
    expect(timerElapsed({ running: false, startedAt: 0, accMs: 4000, laps: [] }, 9000)).toBe(4000);
    expect(timerElapsed({ running: true, startedAt: 5000, accMs: 4000, laps: [] }, 9000)).toBe(8000);
  });
  test('laps read newest first with deltas, and tags once there are more than two', () => {
    const two = lapRows([60_000, 125_000]);
    expect(two.map((l) => l.n)).toEqual([2, 1]);
    expect(two[0].split).toBe('01:05.00');
    expect(two[0].delta).toBe('+00:05.00');
    expect(two[0].deltaTone).toBe('slower');
    expect(two[1].delta).toBe('—');
    expect(two.every((l) => l.tag === null)).toBe(true);
    const three = lapRows([60_000, 125_000, 170_000]);
    expect(three[0].delta).toBe('−00:20.00');
    expect(three[0].deltaTone).toBe('faster');
    expect(three[0].tag).toBe('Fastest');
    expect(three[1].tag).toBe('Slowest');
    expect(currentLap(200_000, [60_000, 125_000, 170_000])).toBe(30_000);
    expect(currentLap(200_000, [])).toBe(200_000);
  });
});

describe('countdown', () => {
  test('total and left in each state', () => {
    const idle = { ...COUNTDOWN_IDLE };
    expect(countdownTotal(idle, WINTER)).toBe(25 * 60000);
    expect(countdownLeft(idle, WINTER)).toBe(25 * 60000);
    const running = { ...idle, running: true, endAt: WINTER + 90_000 };
    expect(countdownLeft(running, WINTER)).toBe(90_000);
    expect(countdownLeft(running, WINTER + 100_000)).toBe(-10_000);
    const paused = { ...idle, pausedLeft: 42_000 };
    expect(countdownLeft(paused, WINTER)).toBe(42_000);
    const past = { ...idle, mode: 'target' as const, target: '2000-01-01T00:00' };
    expect(countdownTotal(past, WINTER)).toBe(0);
    expect(countdownTotal({ ...past, target: 'nonsense' }, WINTER)).toBe(0);
  });
  test('ring offset empties toward zero and stays empty past it', () => {
    expect(ringOffset(100, 100)).toBe(0);
    expect(ringOffset(50, 100)).toBeCloseTo(RING_C / 2, 0);
    expect(ringOffset(0, 100)).toBeCloseTo(RING_C, 0);
    expect(ringOffset(-5, 100)).toBeCloseTo(RING_C, 0);
    expect(ringOffset(5, 0)).toBeCloseTo(RING_C, 0);
  });
  test('splits say what was left and what the stretch took', () => {
    const rows = splitRows([20 * 60000, 5 * 60000, -30_000], 25 * 60000);
    expect(rows.map((r) => r.n)).toEqual([3, 2, 1]);
    expect(rows[2]).toEqual({ n: 1, left: '20:00', used: '05:00' });
    expect(rows[1].used).toBe('15:00');
    expect(rows[0].left).toBe('+00:30');
    expect(rows[0].used).toBe('05:30');
  });
});

describe('alarms', () => {
  const TZ = 'Europe/Copenhagen';
  test('labels and parsing', () => {
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(daysLabel([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(daysLabel([0, 6])).toBe('Weekends');
    expect(daysLabel([])).toBe('Once');
    expect(daysLabel([4, 1])).toBe('Mon, Thu');
    expect(parseHHMM('07:30')).toEqual({ hh: 7, mm: 30 });
    expect(parseHHMM('7:30')).toEqual({ hh: 7, mm: 30 });
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('seven')).toBeNull();
  });
  test('nextFire finds the next allowed weekday in the zone', () => {
    // Wednesday 11:30 CET: a 07:30 weekday alarm is tomorrow, Thursday.
    const at = nextFire(alarm(), WINTER, TZ);
    expect(at).toBe(zoneInstant(TZ, 2026, 1, 15, 7, 30));
    // Later today still counts.
    expect(nextFire(alarm({ time: '15:00' }), WINTER, TZ)).toBe(zoneInstant(TZ, 2026, 1, 14, 15, 0));
    // Weekends only, from a Wednesday: Saturday.
    const sat = nextFire(alarm({ days: [0, 6] }), WINTER, TZ);
    expect(zoneTime(TZ, sat!).weekday).toBe(6);
    // Once: tomorrow, whatever the day.
    expect(nextFire(alarm({ days: [] }), WINTER, TZ)).toBe(zoneInstant(TZ, 2026, 1, 15, 7, 30));
    // A pending snooze wins; a spent one is ignored.
    expect(nextFire(alarm({ snoozedUntil: WINTER + 60_000 }), WINTER, TZ)).toBe(WINTER + 60_000);
    expect(nextFire(alarm({ snoozedUntil: WINTER - 60_000 }), WINTER, TZ)).toBe(zoneInstant(TZ, 2026, 1, 15, 7, 30));
    expect(nextFire(alarm({ time: 'bad' }), WINTER, TZ)).toBeNull();
  });
  test('nextAlarm picks the soonest enabled one', () => {
    const list = [alarm({ id: 'late', time: '18:00' }), alarm({ id: 'soon', time: '12:00' }), alarm({ id: 'off', time: '11:45', on: false })];
    expect(nextAlarm(list, WINTER, TZ)?.alarm.id).toBe('soon');
    expect(nextAlarm([], WINTER, TZ)).toBeNull();
  });
  test('dueAlarms rings within the grace and reports the rest as missed', () => {
    const a = alarm({ time: '11:31', days: [] }); // one minute after WINTER in Copenhagen
    const fire = zoneInstant(TZ, 2026, 1, 14, 11, 31);
    expect(dueAlarms([a], WINTER, WINTER + 30_000, TZ)).toEqual({ ring: [], missed: [] });
    expect(dueAlarms([a], WINTER, fire + 1000, TZ).ring.map((p) => p.alarm.id)).toEqual(['a1']);
    expect(dueAlarms([a], WINTER, fire + 11 * 60000, TZ).missed.map((p) => p.alarm.id)).toEqual(['a1']);
    expect(dueAlarms([alarm({ time: '11:31', on: false })], WINTER, fire + 1000, TZ).ring).toEqual([]);
  });
  test('afterFire spends the snooze and switches a one-off off', () => {
    expect(afterFire(alarm({ snoozedUntil: 5 })).snoozedUntil).toBeNull();
    expect(afterFire(alarm()).on).toBe(true);
    expect(afterFire(alarm({ days: [] })).on).toBe(false);
  });
  test('earlyNext: before ten and more than three hours off', () => {
    expect(earlyNext({ alarm: alarm(), at: zoneInstant(TZ, 2026, 1, 15, 7, 30) }, WINTER, TZ)).toBe(true);
    expect(earlyNext({ alarm: alarm(), at: zoneInstant(TZ, 2026, 1, 14, 15, 0) }, WINTER, TZ)).toBe(false);
    expect(earlyNext({ alarm: alarm(), at: WINTER + 60_000 }, WINTER, TZ)).toBe(false);
    expect(earlyNext(null, WINTER, TZ)).toBe(false);
  });
});

describe('parsePrefs', () => {
  test('nothing saved is the default', () => {
    const p = parsePrefs(null);
    expect(p.cities).toEqual([...DEFAULT_CITIES]);
    expect(p.alarms).toEqual([]);
    expect(p.timer.running).toBe(false);
    expect(p.countdown.durMs).toBe(25 * 60000);
  });
  test('garbage is the default, not a crash', () => {
    expect(parsePrefs('{nope').alarms).toEqual([]);
    expect(parsePrefs('[1,2]').cities).toEqual([...DEFAULT_CITIES]);
  });
  test('keeps what is valid and drops what is not, field by field', () => {
    const p = parsePrefs(JSON.stringify({
      cities: [{ name: 'Tokyo', tz: 'Asia/Tokyo' }, { name: 'Nowhere', tz: 'Mars/Olympus' }, 'junk'],
      alarms: [
        { id: 'a', time: '07:30', label: 'Run', days: [1, 3, 9, 'x'], on: true },
        { id: 'b', time: '25:00', label: 'Bad', days: [], on: true },
        { time: '08:00' },
      ],
      timer: { running: true, startedAt: 1000, accMs: -5, laps: [3000, 2000] },
      countdown: { mode: 'target', durMs: 10, target: '2026-01-01T07:00', running: true, endAt: 0, splits: [1, 'x'] },
    }));
    expect(p.cities).toEqual([{ name: 'Tokyo', tz: 'Asia/Tokyo' }]);
    expect(p.alarms).toHaveLength(1);
    expect(p.alarms[0]).toEqual({ id: 'a', time: '07:30', label: 'Run', days: [1, 3], on: true, snoozedUntil: null });
    expect(p.timer).toEqual({ running: true, startedAt: 1000, accMs: 0, laps: [] });
    expect(p.countdown.mode).toBe('target');
    expect(p.countdown.durMs).toBe(60000);
    expect(p.countdown.running).toBe(false);
    expect(p.countdown.splits).toEqual([1]);
  });
  test('an emptied city list stays empty', () => {
    expect(parsePrefs(JSON.stringify({ cities: [] })).cities).toEqual([]);
  });
});

describe('whose time, and whose sun', () => {
  test('the profile zone wins unless it is the schema default', () => {
    expect(homeZone('Europe/Copenhagen', 'America/New_York')).toEqual({ tz: 'Europe/Copenhagen', source: 'profile' });
    // profiles.timezone defaults to 'UTC' and nothing sets it: that is "unset".
    expect(homeZone('UTC', 'Europe/Copenhagen')).toEqual({ tz: 'Europe/Copenhagen', source: 'mac' });
    expect(homeZone('Etc/UTC', 'Europe/Copenhagen').source).toBe('mac');
    expect(homeZone('Mars/Olympus', 'Asia/Tokyo')).toEqual({ tz: 'Asia/Tokyo', source: 'mac' });
    expect(homeZone(null, 'Asia/Tokyo').tz).toBe('Asia/Tokyo');
    expect(homeZone(undefined, 'nonsense').tz).toBe('UTC');
  });
  test('offset labels', () => {
    expect(offsetLabel(60)).toBe('UTC+1');
    expect(offsetLabel(330)).toBe('UTC+5:30');
    expect(offsetLabel(-480)).toBe('UTC−8');
    expect(offsetLabel(0)).toBe('UTC');
  });
  test('a place name finds its zone in the curated list or the zones given', () => {
    expect(zoneForPlace('San Francisco')).toBe('America/Los_Angeles');
    expect(zoneForPlace('Copenhagen, DK')).toBe('Europe/Copenhagen');
    expect(zoneForPlace('reykjavik')).toBe('Atlantic/Reykjavik');
    expect(zoneForPlace('Buenos Aires', ['America/Argentina/Buenos_Aires'])).toBe('America/Argentina/Buenos_Aires');
    expect(zoneForPlace('Aarhus')).toBeNull();
    expect(zoneForPlace('')).toBeNull();
  });
  test('the sun goes on the band only from a reading in the home zone\'s time', () => {
    const cph = { location: 'Copenhagen', sunrise: '8:31 AM', sunset: '4:03 PM' };
    const here = homeSun(cph, 'Europe/Copenhagen', WINTER, false);
    expect(here).toEqual({ kind: 'here', sun: { sunrise: 511, sunset: 963 }, place: 'Copenhagen' });
    // Berlin keeps Copenhagen's time, so a Berlin reading still counts.
    expect(homeSun({ ...cph, location: 'Berlin' }, 'Europe/Copenhagen', WINTER, false).kind).toBe('here');
    expect(homeSun({ ...cph, location: 'San Francisco' }, 'Europe/Copenhagen', WINTER, false)).toEqual({ kind: 'elsewhere', place: 'San Francisco' });
    expect(homeSun({ ...cph, location: 'Aarhus' }, 'Europe/Copenhagen', WINTER, false)).toEqual({ kind: 'unknown', place: 'Aarhus' });
    // The built-in sample is not a reading.
    expect(homeSun(cph, 'Europe/Copenhagen', WINTER, true)).toEqual({ kind: 'none' });
    expect(homeSun({ ...cph, sunrise: 'soon' }, 'Europe/Copenhagen', WINTER, false)).toEqual({ kind: 'none' });
    expect(homeSun(null, 'Europe/Copenhagen', WINTER, false)).toEqual({ kind: 'none' });
  });
  test('the caption says where the daylight came from', () => {
    expect(sunCaption({ kind: 'here', sun: { sunrise: 511, sunset: 963 }, place: 'Copenhagen' })).toBe('Sunrise 08:31 · sunset 16:03 · Copenhagen');
    expect(sunCaption({ kind: 'elsewhere', place: 'San Francisco' })).toContain('San Francisco');
    expect(sunCaption({ kind: 'unknown', place: 'Aarhus' })).toContain('Aarhus');
    expect(sunCaption({ kind: 'none' })).toContain('generic 06–20');
  });
  test('dates and instants read in the home zone', () => {
    expect(dateLine('Europe/Copenhagen', WINTER)).toBe('Wednesday 14 January');
    // 23:30 UTC on the 14th is already Thursday in Tokyo.
    expect(dateLine('Asia/Tokyo', Date.UTC(2026, 0, 14, 23, 30))).toBe('Thursday 15 January');
    const TZ = 'Europe/Copenhagen';
    expect(whenLabel(TZ, zoneInstant(TZ, 2026, 1, 14, 15, 0), WINTER)).toBe('15:00');
    expect(whenLabel(TZ, zoneInstant(TZ, 2026, 1, 15, 7, 30), WINTER)).toBe('Thu 07:30');
    expect(whenLabel(TZ, zoneInstant(TZ, 2026, 2, 3, 9, 0), WINTER)).toBe('3 Feb 09:00');
  });
});

describe('status lines', () => {
  const TZ = 'Europe/Copenhagen';
  test('timer', () => {
    expect(timerStatus(TIMER_IDLE, 0)).toBe('Ready');
    expect(timerStatus({ ...TIMER_IDLE, accMs: 5 }, 5)).toBe('Paused');
    expect(timerStatus({ ...TIMER_IDLE, running: true, startedAt: 1 }, 0)).toBe('Running');
    expect(lapCountLabel(1)).toBe('1 lap');
    expect(lapCountLabel(0)).toBe('0 laps');
  });
  test('countdown: each state, and a target in the past cannot start', () => {
    const idle = { ...COUNTDOWN_IDLE };
    expect(countdownStatus(idle, WINTER, TZ)).toBe('Ready');
    expect(countdownCanStart(idle, WINTER)).toBe(true);
    const running = { ...idle, running: true, endAt: WINTER + 30 * 60000, spanMs: 30 * 60000 };
    expect(countdownStatus(running, WINTER, TZ)).toBe('Running · ends 12:00');
    expect(countdownStatus(running, WINTER + 31 * 60000, TZ)).toBe('Past zero · still counting');
    expect(countdownCanStart(running, WINTER)).toBe(false);
    expect(countdownStatus({ ...idle, pausedLeft: 1000 }, WINTER, TZ)).toBe('Paused');
    expect(countdownStatus({ ...idle, pausedLeft: -1000 }, WINTER, TZ)).toBe('Paused past zero');
    const target = { ...idle, mode: 'target' as const };
    expect(countdownStatus({ ...target, target: '' }, WINTER, TZ)).toBe('Pick a date and time');
    expect(countdownStatus({ ...target, target: '2000-01-01T00:00' }, WINTER, TZ)).toBe('That moment has passed');
    expect(countdownCanStart({ ...target, target: '2000-01-01T00:00' }, WINTER)).toBe(false);
    // Paused past zero can still resume.
    expect(countdownCanStart({ ...target, target: '2000-01-01T00:00', pausedLeft: -5000 }, WINTER)).toBe(true);
  });
  test('a started countdown keeps the span it started with, so the ring empties', () => {
    const t = { ...COUNTDOWN_IDLE, mode: 'target' as const, target: '2099-01-01T00:00', running: true, endAt: WINTER + 60_000, spanMs: 120_000 };
    expect(countdownTotal(t, WINTER)).toBe(120_000);
    expect(ringOffset(countdownLeft(t, WINTER), countdownTotal(t, WINTER))).toBeCloseTo(RING_C / 2, 0);
    // Before a start there is no span yet; the duration stands in.
    expect(countdownTotal({ ...COUNTDOWN_IDLE, spanMs: 0 }, WINTER)).toBe(25 * 60000);
  });
  test('alarm rows and the hero line', () => {
    expect(alarmWhen(alarm({ on: false }), WINTER, TZ)).toBe('Off');
    expect(alarmWhen(alarm({ time: '15:00' }), WINTER, TZ)).toBe('in 3 h 30 min');
    expect(snoozeLine(alarm({ snoozedUntil: zoneInstant(TZ, 2026, 1, 14, 11, 39) }), WINTER, TZ)).toBe('Snoozed until 11:39');
    expect(snoozeLine(alarm({ snoozedUntil: WINTER - 1 }), WINTER, TZ)).toBeNull();
    const next = nextAlarm([alarm({ label: 'Run', time: '15:00' })], WINTER, TZ);
    expect(heroLine(next, [alarm()], WINTER, TZ)).toBe('Next alarm: Run at 15:00, in 3 h 30 min. Rings only while Atlas is running.');
    expect(heroLine(null, [alarm({ on: false })], WINTER, TZ)).toBe('No alarms are switched on.');
    expect(heroLine(null, [], WINTER, TZ)).toBe('No alarms yet.');
  });
  test('the editor\'s draft and what Save stores', () => {
    const d = draftAlarm(WINTER);
    expect(d.time).toBe('07:00');
    expect(d.days).toEqual([1, 2, 3, 4, 5]);
    expect(d.id).toMatch(/^al_/);
    expect(finishAlarm({ ...d, time: '7:05', label: '   ', days: [0, 3, 1], on: false, snoozedUntil: 99 }))
      .toEqual({ ...d, time: '07:05', label: 'Alarm', days: [1, 3, 0], on: true, snoozedUntil: null });
    expect(finishAlarm({ ...d, time: '' })).toBeNull();
  });
});

describe('parsePrefs, the newer fields', () => {
  test('the alarm zone is kept when real and dropped when not', () => {
    expect(parsePrefs(null).zone).toBeNull();
    expect(parsePrefs(JSON.stringify({ zone: 'Europe/Copenhagen' })).zone).toBe('Europe/Copenhagen');
    expect(parsePrefs(JSON.stringify({ zone: 'Mars/Olympus' })).zone).toBeNull();
    expect(parsePrefs(JSON.stringify({ zone: 7 })).zone).toBeNull();
  });
  test('a countdown span is never negative, and missing is zero', () => {
    expect(parsePrefs(JSON.stringify({ countdown: { spanMs: -4 } })).countdown.spanMs).toBe(0);
    expect(parsePrefs(JSON.stringify({ countdown: { spanMs: 9000 } })).countdown.spanMs).toBe(9000);
    expect(parsePrefs(JSON.stringify({ countdown: {} })).countdown.spanMs).toBe(0);
  });
});
