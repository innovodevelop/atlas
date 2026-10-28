import { describe, expect, test } from 'bun:test';
import {
  feelsLine, notedLabel, pollutantBand, pollutantFraction, pollutantRows, prepareQuestion, rainFraction, researchQuestion,
  sliceRain, upNextEvents, upNextWhen, windFrom, withLine,
} from './betaViews';
import type { CalendarEvent } from '@/hooks/useCalendarEvents';

// The left-out features of package F6 in betaViews.ts: weather detail (row 4),
// Prepare (row 9), Research (row 10) and Up next (row 15).

const NOON = new Date(2026, 9, 27, 12, 0, 0).getTime(); // Tuesday 27 October 2026, local
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 27 + dayOffset, h, m, 0).toISOString();
const ev = (id: string, start: string, end: string | null, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: `Event ${id}`, description: null, start_time: start, end_time: end, location: null, event_type: 'meeting',
  attendees: [], created_at: start, updated_at: start, ...extra,
});

describe('weather detail', () => {
  test('wind direction is the compass point it blows from', () => {
    expect(windFrom(0)).toBe('N');
    expect(windFrom(290)).toBe('W');
    expect(windFrom(359)).toBe('N');
    expect(windFrom(-45)).toBe('NW');
    expect(windFrom(null)).toBeNull();
    expect(windFrom(Number.NaN)).toBeNull();
  });

  test('a slice says its chance and its millimetres, and nothing when dry', () => {
    expect(sliceRain(60, 1.23)).toBe('60% · 1.2 mm');
    expect(sliceRain(20, 0)).toBe('20%');
    expect(sliceRain(0, 0.4)).toBe('0.4 mm');
    expect(sliceRain(0, 0)).toBeNull();
    expect(sliceRain(null, undefined)).toBeNull();
    expect(rainFraction(2.5)).toBe(0.5);
    expect(rainFraction(12)).toBe(1);
    expect(rainFraction(null)).toBe(0);
  });

  test('pollutants keep only what the station reports, banded on OpenWeather’s table', () => {
    const rows = pollutantRows({ pm25: 6, pm10: 55, o3: null, no2: 210 });
    expect(rows.map((r) => r.kind)).toEqual(['pm25', 'pm10', 'no2']);
    expect(rows.map((r) => r.band)).toEqual([1, 3, 5]);
    expect(pollutantBand('o3', 100)).toBe(3);
    expect(pollutantFraction('pm25', 150)).toBe(1);
  });

  test('feels-like shows only when it differs by a degree', () => {
    expect(feelsLine(51.4, 47.6)).toBe('Feels 48°');
    expect(feelsLine(51.4, 51.2)).toBeNull();
    expect(feelsLine(50, null)).toBeNull();
  });
});

describe('Prepare and Research', () => {
  test('the Prepare question carries the event’s own fields and nothing else', () => {
    const q = prepareQuestion(ev('a', at(14), at(15), {
      title: ' Budget review ', location: 'Room 4', attendees: ['maya@example.com'], description: 'Q4 numbers',
    }));
    expect(q).toContain('Title: Budget review');
    expect(q).toContain('Where: Room 4');
    expect(q).toContain('With: maya@example.com');
    expect(q).toContain('Notes on the event: Q4 numbers');
    const bare = prepareQuestion(ev('b', at(9), null));
    expect(bare).not.toContain('Where:');
    expect(bare).not.toContain('With:');
  });

  test('the Research question names the task, its due day and priority', () => {
    const q = researchQuestion({ title: 'Book flights', due_date: at(9), priority: 'high' }, NOON);
    expect(q).toContain('Task: Book flights');
    expect(q).toContain('Due: today');
    expect(q).toContain('Priority: High');
    expect(researchQuestion({ title: 'x', due_date: null, priority: 'low' }, NOON)).toContain('Due: No due date');
  });

  test('a note says how old it is', () => {
    expect(notedLabel('Prepared', null, NOON)).toBe('Prepared');
    expect(notedLabel('Prepared', new Date(NOON - 20_000).toISOString(), NOON)).toBe('Prepared just now');
    expect(notedLabel('Prepared', new Date(NOON - 12 * 60000).toISOString(), NOON)).toBe('Prepared 12 min ago');
    expect(notedLabel('Researched', at(9), NOON)).toBe('Researched 3 h ago');
    expect(notedLabel('Prepared', at(18, 0, -1), NOON)).toBe('Prepared yesterday');
    expect(notedLabel('Prepared', at(18, 0, -3), NOON)).toBe('Prepared 3 days ago');
  });
});

describe('Up next', () => {
  test('lists what is on now or still to come, soonest first', () => {
    const list = upNextEvents([
      ev('later', at(16), at(17)),
      ev('past', at(9), at(10)),
      ev('now', at(11, 30), at(12, 30)),
      ev('tomorrow', at(9, 30, 1), at(10, 30, 1)),
    ], NOON);
    expect(list.map((e) => e.id)).toEqual(['now', 'later', 'tomorrow']);
    expect(upNextEvents(list, NOON, 1)).toHaveLength(1);
  });

  test('says when, in the shortest honest words', () => {
    expect(upNextWhen(ev('a', at(11), at(13)), NOON)).toBe('now');
    expect(upNextWhen(ev('a', at(12, 18), null), NOON)).toBe('in 18 min');
    expect(upNextWhen(ev('a', at(15), null), NOON)).toBe('in 3 h');
    expect(upNextWhen(ev('a', at(9, 30, 1), null), NOON)).toMatch(/^tomorrow /);
    expect(upNextWhen(ev('a', at(9, 30, 3), null), NOON)).not.toMatch(/^tomorrow/);
  });

  test('the with-line names the place and up to two people', () => {
    expect(withLine({ location: 'Room 4', attendees: ['Maya'] })).toBe('Room 4 · with Maya');
    expect(withLine({ location: null, attendees: ['Ida', 'Lukas', 'Ana', 'Bo'] })).toBe('with Ida, Lukas and 2 more');
    expect(withLine({ location: ' ', attendees: [] })).toBeNull();
  });
});
