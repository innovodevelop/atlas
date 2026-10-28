import { describe, expect, test } from 'bun:test';
import {
  courseColour, dayRibbon, lessonsFromIcs, lessonsOn, parseDuration, parseIcs, parseIcsTime, parseLectioCache,
  toLesson, unescapeIcs, unfoldIcs, zonedTime, type DayItem, type IcsEvent,
} from './betaSchoolIcs';
import { MIN, SUBJECT_COLOURS } from './betaSchool';

// Wednesday 28 October 2026, 12:00 local.
const NOW = new Date(2026, 9, 28, 12, 0, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0, 0).getTime();

// A calendar in the shape of a Lectio feed, written for these tests.
const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//Skema//DA',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Copenhagen',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:l-1',
  'DTSTART;TZID=Europe/Copenhagen:20261028T081500',
  'DTEND;TZID=Europe/Copenhagen:20261028T093000',
  'SUMMARY:3b MA',
  'LOCATION:M2.14',
  'DESCRIPTION:Lærer: Mette Kjær (MK)\\nHusk lommeregner\\, og bog',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:l-2',
  'DTSTART;TZID=Europe/Copenhagen:20261028T094500',
  'DTEND;TZID=Europe/Copenhagen:20261028T110000',
  'SUMMARY:Aflyst! 3b FY',
  'STATUS:CANCELLED',
  'BEGIN:VALARM',
  'DESCRIPTION:Reminder',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:l-3',
  'DTSTART:20261029T110000Z',
  'DURATION:PT1H30M',
  'SUMMARY:Ændret! Hold: 3b DA - Lærer: LH - Lokale: A1.03',
  'DESCRIPTION:Flyttet fra fredag. Læs tekst',
  '  2 til i dag',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:l-4',
  'DTSTART;VALUE=DATE:20261030',
  'SUMMARY:Studietur',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('reading a calendar', () => {
  test('continuation lines are joined and text is unescaped', () => {
    expect(unfoldIcs('A:one\r\n two\r\nB:x')).toEqual(['A:onetwo', 'B:x']);
    expect(unescapeIcs('a\\nb\\, c\\; d\\\\e')).toBe('a\nb, c; d\\e');
  });

  test('times in a zone, in UTC, floating and as dates', () => {
    // Copenhagen is UTC+1 after the October change and UTC+2 in June.
    expect(zonedTime(2026, 10, 28, 8, 15, 0, 'Europe/Copenhagen')).toBe(Date.UTC(2026, 9, 28, 7, 15));
    expect(zonedTime(2026, 6, 10, 8, 0, 0, 'Europe/Copenhagen')).toBe(Date.UTC(2026, 5, 10, 6, 0));
    expect(zonedTime(2026, 6, 10, 8, 0, 0, 'Romance Standard Time')).toBe(Date.UTC(2026, 5, 10, 6, 0));
    expect(zonedTime(2026, 6, 10, 8, 0, 0, 'Not/AZone')).toBeNull();
    expect(parseIcsTime('20261029T110000Z', {})).toEqual({ ms: Date.UTC(2026, 9, 29, 11), allDay: false });
    expect(parseIcsTime('20261029T110000', {})).toEqual({ ms: at(29, 11), allDay: false });
    expect(parseIcsTime('20261030', { VALUE: 'DATE' })).toEqual({ ms: at(30, 0), allDay: true });
    expect(parseIcsTime('soon', {})).toBeNull();
  });

  test('durations', () => {
    expect(parseDuration('PT1H30M')).toBe(90 * MIN);
    expect(parseDuration('P1D')).toBe(24 * 60 * MIN);
    expect(parseDuration('nope')).toBeNull();
  });

  test('events, with an alarm\'s description kept out of its event', () => {
    const evs = parseIcs(FEED);
    expect(evs.map((e) => e.uid)).toEqual(['l-1', 'l-2', 'l-3', 'l-4']);
    expect(evs[0].start).toBe(Date.UTC(2026, 9, 28, 7, 15));
    expect(evs[0].end).toBe(Date.UTC(2026, 9, 28, 8, 30));
    expect(evs[0].description).toBe('Lærer: Mette Kjær (MK)\nHusk lommeregner, og bog');
    expect(evs[1].status).toBe('CANCELLED');
    expect(evs[1].description).toBe('');
    expect(evs[2].end - evs[2].start).toBe(90 * MIN);
    expect(evs[2].description).toBe('Flyttet fra fredag. Læs tekst 2 til i dag');
    expect(evs[3].allDay).toBe(true);
    expect(evs[3].end - evs[3].start).toBe(24 * 60 * MIN);
  });

  test('an event without a start is skipped, not guessed', () => {
    expect(parseIcs('BEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT')).toEqual([]);
  });
});

describe('lessons', () => {
  const [ma, fy, da, trip] = parseIcs(FEED).map(toLesson);

  test('who and where come off the title into their own fields', () => {
    expect(ma).toMatchObject({ title: '3b MA', room: 'M2.14', teacher: 'Mette Kjær (MK)', state: 'normal', note: 'Husk lommeregner, og bog' });
    expect(da).toMatchObject({ title: '3b DA', room: 'A1.03', teacher: 'LH', state: 'changed', note: 'Flyttet fra fredag. Læs tekst 2 til i dag' });
  });

  test('Lectio\'s cancellation, by status or by its own marker', () => {
    expect(fy).toMatchObject({ title: '3b FY', state: 'cancelled' });
    const marked: IcsEvent = { uid: 'x', summary: 'Aflyst! 2.g EN', location: '', description: '', start: 0, end: 1, allDay: false, status: '' };
    expect(toLesson(marked)).toMatchObject({ title: '2.g EN', state: 'cancelled' });
  });

  test('all-day events stay all-day', () => {
    expect(trip.allDay).toBe(true);
    expect(trip.title).toBe('Studietur');
  });

  test('the feed becomes a sorted, windowed list', () => {
    const lessons = lessonsFromIcs(FEED, NOW);
    expect(lessons.map((l) => l.id)).toEqual(['l-1', 'l-2', 'l-3', 'l-4']);
    expect(lessonsOn(lessons, at(29, 0)).map((l) => l.id)).toEqual(['l-3']);
    expect(lessonsFromIcs(FEED, at(28, 12) + 500 * 24 * 60 * MIN)).toEqual([]);
  });

  test('each course keeps one colour from the palette', () => {
    expect(courseColour('3b MA')).toBe(courseColour(' 3B ma '));
    expect(SUBJECT_COLOURS).toContain(courseColour('3b FY'));
  });
});

describe('the ribbon', () => {
  const item = (id: string, h: number, mins: number, extra: Partial<DayItem> = {}): DayItem => ({
    id, title: id, start: at(28, h), end: at(28, h) + mins * MIN, sub: '', colour: '#000', cancelled: false, done: false, ...extra,
  });

  test('the running lesson fills; a cancelled one never runs', () => {
    const r = dayRibbon([item('a', 8, 60), item('b', 11, 90), item('c', 11, 90, { cancelled: true }), item('d', 14, 45)], NOW);
    expect(r.map((x) => [x.item.id, x.state])).toEqual([['a', 'past'], ['b', 'now'], ['c', 'next'], ['d', 'next']]);
    expect(r[1].fill).toBeCloseTo(60 / 90, 5);
    expect(r[1].minutesLeft).toBe(30);
  });

  test('more than fit: the window slides to what is still ahead', () => {
    const r = dayRibbon([item('a', 7, 30), item('b', 8, 30), item('c', 9, 30), item('d', 13, 30), item('e', 14, 30), item('f', 15, 30)], NOW, 4);
    expect(r.map((x) => x.item.id)).toEqual(['c', 'd', 'e', 'f']);
  });
});

describe('the cache', () => {
  test('a damaged cache is no cache; a good one round-trips', () => {
    expect(parseLectioCache('{nope')).toBeNull();
    expect(parseLectioCache(JSON.stringify({ fetchedAt: 'x', lessons: [] }))).toBeNull();
    const lessons = lessonsFromIcs(FEED, NOW);
    const back = parseLectioCache(JSON.stringify({ fetchedAt: NOW, lessons: [...lessons, { id: 'bad' }] }));
    expect(back?.fetchedAt).toBe(NOW);
    expect(back?.lessons).toEqual(lessons);
  });
});
