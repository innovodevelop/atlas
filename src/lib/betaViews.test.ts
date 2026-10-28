import { describe, expect, test } from 'bun:test';
import {
  airAdvice, aqiTone, aqiWord, bodyLook, briefingOrder, briefingText, cardEvent, ceilQuarter, clock24, dayBars, daylightLabel,
  dayWindow, delegable, dueInputValue, dueLabel, eventBox, eventsOnDay, focusTitle, freeSlots, hourOfLabel, iconWord,
  listenText, meetingsHeadline, moonPhase, nextPriority, nightAt, orderTasks, parseClockLabel, pm25Fraction, priorityTone,
  priorityWord, readingMinutes, ringOffset, skyMix, skyWord, slotPlans, startOfDay, storyUrlOk, sunArc, taskHeadline,
  taskSub, weekDays, whyQuestion,
} from './betaViews';
import type { CalendarEvent } from '@/hooks/useCalendarEvents';
import type { Task } from '@/hooks/useTasks';

const NOON = new Date(2026, 9, 27, 12, 0, 0).getTime(); // Tuesday 27 October 2026, local
const DAY = startOfDay(NOON);

const ev = (id: string, startH: number, lengthMin: number | null, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: id, description: null, location: null, event_type: 'meeting', attendees: [], created_at: '', updated_at: '',
  start_time: new Date(DAY + startH * 3600000).toISOString(),
  end_time: lengthMin == null ? null : new Date(DAY + startH * 3600000 + lengthMin * 60000).toISOString(),
  ...extra,
});

const task = (id: string, priority: string, completed = false, due: string | null = null): Task => ({
  id, title: id, completed, priority, due_date: due, created_at: '', updated_at: '',
});

describe('weather: labels and the sky', () => {
  test('clock labels', () => {
    expect(parseClockLabel('6:42 AM')).toBe(402);
    expect(parseClockLabel('5:24 PM')).toBe(1044);
    expect(parseClockLabel('12PM')).toBe(720);
    expect(parseClockLabel('12AM')).toBe(0);
    expect(parseClockLabel('3PM')).toBe(900);
    expect(parseClockLabel('Now')).toBeNull();
    expect(hourOfLabel('Now', 14)).toBe(14);
    expect(hourOfLabel('9PM', 14)).toBe(21);
    expect(clock24(402)).toBe('06:42');
    expect(clock24(-30)).toBe('23:30');
  });
  test('night follows the sun', () => {
    expect(nightAt(12, 402, 1044)).toBe(0);
    expect(nightAt(6, 402, 1044)).toBe(0.5);
    expect(nightAt(17, 402, 1044)).toBe(0.5);
    expect(nightAt(22, 402, 1044)).toBe(1);
    expect(nightAt(12, null, null)).toBe(0);
    expect(nightAt(20, null, null)).toBe(1);
  });
  test('icons map to mixes; night darkens the sun; fog comes from the condition', () => {
    const sunny = skyMix('sunny', 'Clear', 6, 12, 402, 1044);
    expect(sunny.cloud).toBeLessThan(0.2);
    expect(sunny.sun).toBe(1);
    expect(sunny.night).toBe(0);
    const rain = skyMix('rainy', 'Rain', 3, 12, 402, 1044);
    expect(rain.rain).toBeGreaterThan(0.6);
    expect(rain.wind).toBeGreaterThanOrEqual(0.35);
    const night = skyMix('sunny', 'Clear', 0, 23, 402, 1044);
    expect(night.night).toBe(1);
    expect(night.sun).toBe(0);
    expect(skyMix('cloudy', 'Mist', 0, 12, null, null).fog).toBeGreaterThanOrEqual(0.8);
    expect(skyMix('unknown', 'Clouds', 0, 12, null, null).cloud).toBe(0.86);
    expect(skyMix('sunny', 'Clear', 60, 12, null, null).wind).toBe(1);
  });
  test('icon words read as words', () => {
    expect(iconWord('partly-cloudy')).toBe('Partly cloudy');
    expect(iconWord('sunny')).toBe('Sunny');
    expect(iconWord('')).toBe('Unknown');
  });
  test('the word and the body', () => {
    expect(skyWord({ cloud: 0.95, rain: 0.8, wind: 0.4, sun: 0.2, night: 0, fog: 0 })).toBe('Heavy rain');
    expect(skyWord({ cloud: 0.5, rain: 0, wind: 0, sun: 1, night: 1, fog: 0 })).toBe('Clear night');
    expect(skyWord({ cloud: 0.6, rain: 0, wind: 0, sun: 1, night: 0, fog: 0 })).toBe('Cloudy');
    expect(skyWord({ cloud: 0.1, rain: 0, wind: 0.9, sun: 1, night: 0, fog: 0 })).toBe('Windy');
    expect(bodyLook({ cloud: 0, rain: 0, wind: 0, sun: 1, night: 0, fog: 0 })).toEqual({ opacity: 1, blurPx: 0 });
    expect(bodyLook({ cloud: 1, rain: 1, wind: 0, sun: 0, night: 0, fog: 1 }).opacity).toBe(0.18);
  });
  test('the sun crosses the arc left to right and the moon takes the night', () => {
    const rise = sunArc(402, 402, 1044);
    expect(rise.day).toBe(true);
    expect(rise.frac).toBe(0);
    expect(rise.x).toBeCloseTo(4.8, 0);
    const noon = sunArc(723, 402, 1044);
    expect(noon.x).toBeCloseTo(50, 0);
    expect(noon.y).toBeCloseTo(9, 0);
    const set = sunArc(1044, 402, 1044);
    expect(set.frac).toBe(1);
    expect(set.x).toBeCloseTo(95.2, 0);
    const night = sunArc(1300, 402, 1044);
    expect(night.day).toBe(false);
    expect(night.frac).toBeGreaterThan(0);
    expect(night.frac).toBeLessThan(1);
  });
  test('daylight', () => {
    expect(daylightLabel(402, 1044)).toBe('10h 42m of light');
    expect(daylightLabel(null, 1044)).toBeNull();
    expect(daylightLabel(1044, 402)).toBeNull();
  });
  test('moon phase from the synodic month', () => {
    const newMoon = moonPhase(Date.UTC(2000, 0, 6, 18, 14));
    expect(newMoon.name).toBe('New moon');
    expect(newMoon.illumination).toBe(0);
    const full = moonPhase(Date.UTC(2000, 0, 6, 18, 14) + 14.765 * 86400000);
    expect(full.name).toBe('Full moon');
    expect(full.illumination).toBe(100);
    const before = moonPhase(Date.UTC(1999, 11, 30));
    expect(before.age).toBeGreaterThan(0);
    expect(before.age).toBeLessThan(29.6);
  });
  test('week bars lie against the week range', () => {
    const bars = dayBars([{ day: 'Today', high: 60, low: 50, icon: 'sunny' }, { day: 'Wed', high: 70, low: 55, icon: 'cloudy' }]);
    expect(bars[0].left).toBe(0);
    expect(bars[0].width).toBe(50);
    expect(bars[1].left).toBe(25);
    expect(bars[1].warm).toBe(true);
    expect(bars[0].warm).toBe(false);
    expect(dayBars([])).toEqual([]);
  });
  test('air words', () => {
    expect(aqiWord(1)).toBe('Good');
    expect(aqiWord(9)).toBe('Unknown');
    expect(aqiTone(2)).toBe('good');
    expect(aqiTone(3)).toBe('mid');
    expect(aqiTone(5)).toBe('bad');
    expect(pm25Fraction(150)).toBe(1);
    expect(pm25Fraction(37.5)).toBe(0.5);
    expect(airAdvice(1, 4)).toMatch(/open the windows/);
    expect(airAdvice(4, 61.2)).toMatch(/61 µg/);
  });
});

describe('calendar', () => {
  const events = [ev('a', 9.5, 30), ev('b', 11, 45), ev('c', 14, 60), ev('d', 16.5, null)];
  test('events on the day, by start, and the window widens to hold them', () => {
    expect(eventsOnDay(events, DAY).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(eventsOnDay(events, DAY + 86400000)).toEqual([]);
    expect(dayWindow(events, DAY)).toEqual({ startHour: 8, endHour: 18 });
    expect(dayWindow([ev('e', 6.5, 30), ev('f', 19, 120)], DAY)).toEqual({ startHour: 6, endHour: 21 });
    expect(dayWindow([], DAY)).toEqual({ startHour: 8, endHour: 18 });
  });
  test('event boxes', () => {
    expect(eventBox(events[0], DAY, 8, 64)).toEqual({ top: 98, height: 28 });
    expect(eventBox(events[3], DAY, 8, 64)).toEqual({ top: 546, height: 44 });
  });
  test('free slots skip busy time, cap at an hour and offer the end of a long gap', () => {
    const slots = freeSlots(events, DAY, 8, 18, DAY + 8 * 3600000);
    expect(slots.length).toBe(3);
    expect(slots[0]).toEqual({ start: DAY + 8 * 3600000, end: DAY + 9 * 3600000, minutes: 60 });
    expect(slots[1].start).toBe(DAY + 10 * 3600000);
    expect(slots[1].minutes).toBe(60);
    expect(slots[2].start).toBe(DAY + 11.75 * 3600000);
    const afternoon = freeSlots(events, DAY, 8, 18, DAY + 15 * 3600000);
    expect(afternoon[0]).toEqual({ start: DAY + 15 * 3600000, end: DAY + 16 * 3600000, minutes: 60 });
    expect(afternoon[1].start).toBe(DAY + 17.25 * 3600000);
    expect(afternoon[1].minutes).toBe(45);
    const empty = freeSlots([], DAY, 8, 18, DAY + 8 * 3600000);
    expect(empty.map((s) => s.minutes)).toEqual([60, 60]);
    expect(freeSlots([ev('x', 8, 600)], DAY, 8, 18, DAY + 8 * 3600000)).toEqual([]);
  });
  test('a slot offered now starts on the next quarter hour', () => {
    const at = DAY + 12 * 3600000 + 7 * 60000 + 33000; // 12:07:33
    expect(ceilQuarter(at)).toBe(DAY + 12.25 * 3600000);
    expect(ceilQuarter(DAY + 12.5 * 3600000)).toBe(DAY + 12.5 * 3600000);
    expect(ceilQuarter(DAY + 12.5 * 3600000 + 1000)).toBe(DAY + 12.75 * 3600000);
    expect(ceilQuarter(DAY + 13 * 3600000 - 60000)).toBe(DAY + 13 * 3600000);
    expect(freeSlots([], DAY, 8, 18, at)[0].start).toBe(DAY + 12.25 * 3600000);
  });
  test('each slot is booked for the next open task that has no block yet', () => {
    const open = [task('Budget notes', 'high'), task('Brand review', 'medium'), task('Done one', 'high', true)];
    expect(slotPlans(3, open, []).map((t) => t?.id ?? null)).toEqual(['Budget notes', 'Brand review', null]);
    expect(slotPlans(2, open, ['Focus: Budget notes']).map((t) => t?.id ?? null)).toEqual(['Brand review', null]);
    expect(focusTitle(open[0])).toBe('Focus: Budget notes');
    expect(focusTitle(null)).toBe('Focus block');
  });
  test('the headline and the card', () => {
    expect(meetingsHeadline(events)).toBe('4 meetings, 3h');
    expect(meetingsHeadline([events[0]])).toBe('1 meeting, 30 min');
    expect(meetingsHeadline([])).toBe('A free day');
    expect(cardEvent(events, 'c', NOON)?.id).toBe('c');
    expect(cardEvent(events, null, NOON)?.id).toBe('c');
    expect(cardEvent(events, null, DAY + 20 * 3600000)?.id).toBe('a');
    expect(cardEvent([], null, NOON)).toBeNull();
  });
  test('the week runs Monday to Sunday with today marked', () => {
    const week = weekDays(NOON);
    expect(week.map((d) => d.letter).join('')).toBe('MTWTFSS');
    expect(week[1].today).toBe(true);
    expect(week[0].past).toBe(true);
    expect(week[2].past).toBe(false);
    expect(week[1].number).toBe(27);
    expect(week[6].number).toBe(1);
  });
});

describe('tasks', () => {
  const tasks = [task('a', 'high'), task('b', 'medium', true), task('c', 'low', false, new Date(DAY - 86400000).toISOString()), task('d', 'high', false, new Date(DAY + 2 * 86400000).toISOString())];
  test('headline and sub', () => {
    expect(taskHeadline(1, 4)).toBe('1 of 4 done');
    expect(taskHeadline(0, 0)).toBe('Nothing on the list');
    expect(taskSub([], NOON)).toMatch(/Add a task/);
    expect(taskSub([task('x', 'low', true)], NOON)).toBe('Everything is done.');
    expect(taskSub(tasks, NOON)).toBe('1 task is overdue.');
    expect(taskSub([task('a', 'high'), task('b', 'high')], NOON)).toBe('2 high-priority tasks still open.');
    expect(taskSub([task('a', 'low')], NOON)).toBe('Nothing urgent left.');
  });
  test('priority cycle and words', () => {
    expect(priorityTone('High')).toBe('high');
    expect(priorityTone('med')).toBe('med');
    expect(priorityTone('medium')).toBe('med');
    expect(priorityWord('low')).toBe('Low');
    expect(nextPriority('low')).toBe('medium');
    expect(nextPriority('medium')).toBe('high');
    expect(nextPriority('high')).toBe('low');
  });
  test('due labels and the input value', () => {
    expect(dueLabel(null, NOON)).toBe('No due date');
    expect(dueLabel('nope', NOON)).toBe('No due date');
    expect(dueLabel(new Date(DAY + 3600000).toISOString(), NOON)).toBe('Due today');
    expect(dueLabel(new Date(DAY + 25 * 3600000).toISOString(), NOON)).toBe('Due tomorrow');
    expect(dueLabel(new Date(DAY - 3600000).toISOString(), NOON)).toMatch(/^Overdue · /);
    expect(dueLabel(new Date(DAY + 5 * 86400000).toISOString(), NOON)).toMatch(/^Due /);
    expect(dueInputValue(new Date(2026, 10, 3, 9).toISOString())).toBe('2026-11-03');
    expect(dueInputValue(null)).toBe('');
  });
  test('what Atlas can take, and the list order', () => {
    expect(delegable(tasks).map((t) => t.id)).toEqual(['d', 'a', 'c']);
    expect(delegable(tasks, 1).map((t) => t.id)).toEqual(['d']);
    expect(orderTasks(tasks).map((t) => t.id)).toEqual(['a', 'c', 'd', 'b']);
    expect(ringOffset(301.6, 0.25)).toBe(226.2);
    expect(ringOffset(100, 2)).toBe(0);
  });
});

describe('briefing', () => {
  const story = { id: '1', title: ' Headline ', description: 'The body. ', source: 'Reuters', time: '2h ago', url: 'https://x.y/z', category: 'World', trending: false };
  test('links, reading and the question', () => {
    expect(storyUrlOk('#')).toBe(false);
    expect(storyUrlOk(undefined)).toBe(false);
    expect(storyUrlOk('https://reuters.com')).toBe(true);
    expect(listenText(story)).toBe('Headline. The body.');
    expect(listenText({ ...story, description: undefined })).toBe('Headline');
    expect(whyQuestion(story)).toContain('"Headline" (Reuters: The body.)');
    expect(whyQuestion({ ...story, description: '' })).toContain('(Reuters)');
  });
  test('the reading starts at the story on screen and wraps, six at most', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(briefingOrder(ids, 0)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(briefingOrder(ids, 6)).toEqual(['g', 'h', 'a', 'b', 'c', 'd']);
    expect(briefingOrder(['a', 'b'], 1)).toEqual(['b', 'a']);
    expect(briefingOrder([], 3)).toEqual([]);
    expect(briefingText([story, { ...story, title: 'Two', description: undefined }])).toBe('Headline. The body.\n\nTwo');
  });
  test('reading time', () => {
    expect(readingMinutes('')).toBe(1);
    expect(readingMinutes(Array.from({ length: 800 }, () => 'word').join(' '))).toBe(5);
  });
});
