import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '@/hooks/useCalendarEvents';
import {
  contextLine, eventDuration, focusEvent, focusIn, joinUrl, shortTitle, suggestedAsks, thenEvents, todaysEvents,
} from './stageFocus';

const NOW = Date.parse('2026-10-27T10:00:00');

function ev(id: string, start: string, end: string | null = null, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, title: `Event ${id}`, description: null, start_time: start, end_time: end, location: null,
    event_type: 'meeting', attendees: [], created_at: start, updated_at: start, ...extra,
  };
}

const DAY = [
  ev('a', '2026-10-27T08:00:00', '2026-10-27T08:30:00'),
  ev('b', '2026-10-27T09:45:00', '2026-10-27T10:30:00'),
  ev('c', '2026-10-27T11:00:00', '2026-10-27T12:00:00'),
  ev('d', '2026-10-27T14:00:00', '2026-10-27T15:30:00'),
  ev('x', '2026-10-28T09:00:00', null),
];

describe('todaysEvents', () => {
  test('keeps only the local day, sorted by start', () => {
    expect(todaysEvents(DAY, NOW).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('focusEvent', () => {
  test('is the event that is on right now', () => {
    expect(focusEvent(DAY, NOW)?.id).toBe('b');
  });
  test('is the next one when nothing is on', () => {
    expect(focusEvent(DAY, Date.parse('2026-10-27T10:45:00'))?.id).toBe('c');
  });
  test('is the last of the day once everything is over', () => {
    expect(focusEvent(todaysEvents(DAY, NOW), Date.parse('2026-10-27T18:00:00'))?.id).toBe('d');
  });
  test('is null with no events', () => {
    expect(focusEvent([], NOW)).toBeNull();
  });
});

describe('focusIn', () => {
  test('counts down in minutes, then hours', () => {
    expect(focusIn(DAY[2], NOW)).toBe('in 60 min');
    expect(focusIn(DAY[3], NOW)).toBe('in 4 h');
  });
  test('says now and done', () => {
    expect(focusIn(DAY[1], NOW)).toBe('now');
    expect(focusIn(DAY[0], NOW)).toBe('done');
  });
  test('an event without an end lasts 45 minutes', () => {
    expect(focusIn(ev('o', '2026-10-27T09:30:00'), NOW)).toBe('now');
    expect(focusIn(ev('o', '2026-10-27T09:00:00'), NOW)).toBe('done');
  });
});

describe('thenEvents', () => {
  test('lists what follows the focus event', () => {
    expect(thenEvents(todaysEvents(DAY, NOW), DAY[1]).map((e) => e.id)).toEqual(['c', 'd']);
  });
  test('is empty without a focus', () => {
    expect(thenEvents(DAY, null)).toEqual([]);
  });
});

describe('eventDuration', () => {
  test('formats minutes and hours', () => {
    expect(eventDuration(DAY[1])).toBe('45 min');
    expect(eventDuration(DAY[2])).toBe('1 hour');
    expect(eventDuration(DAY[3])).toBe('1h 30m');
    expect(eventDuration(DAY[4])).toBeNull();
  });
});

describe('joinUrl', () => {
  test('finds a link in the location or the notes', () => {
    expect(joinUrl(ev('j', '2026-10-27T11:00:00', null, { location: 'https://meet.example/abc' }))).toBe('https://meet.example/abc');
    expect(joinUrl(ev('j', '2026-10-27T11:00:00', null, { description: 'Dial in: https://zoom.example/1 (pw 1)' }))).toBe('https://zoom.example/1');
    expect(joinUrl(ev('j', '2026-10-27T11:00:00', null, { location: 'Room 4' }))).toBeNull();
    expect(joinUrl(null)).toBeNull();
  });
});

describe('suggestedAsks', () => {
  test('leads with the next event and the mail count', () => {
    const asks = suggestedAsks(DAY, NOW, 2);
    expect(asks).toHaveLength(3);
    expect(asks[0].t).toBe('Brief me on Event b');
    expect(asks[0].q).toBe('Brief me before Event b');
    expect(asks[1].t).toBe('2 mails need me');
    expect(asks[2].q).toBe('Do I need an umbrella today?');
  });
  test('falls back when there is nothing on and no mail', () => {
    const asks = suggestedAsks([], NOW, 0);
    expect(asks.map((a) => a.t)).toEqual(['Check my mail', 'Do I need an umbrella?', 'Plan my evening']);
  });
  test('shortens long titles', () => {
    expect(shortTitle('Quarterly planning with the whole platform team')).toBe('Quarterly planning w…');
  });
});

describe('contextLine', () => {
  test('joins the real counts', () => {
    expect(contextLine({ events: 4, needsYou: 2, tasksOpen: 1, weather: '12° and clear' })).toBe('4 events today, 2 mails need you, 1 open task, 12° and clear.');
    expect(contextLine({ events: 1, needsYou: 1, tasksOpen: 0 })).toBe('1 event today, 1 mail needs you.');
  });
  test('has something to say on an empty day', () => {
    expect(contextLine({ events: 0, needsYou: 0, tasksOpen: 0 })).toBe('A clear day. Ask Atlas anything.');
  });
});
