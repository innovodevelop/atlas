import { describe, expect, test } from 'bun:test';
import { EMPTY_SCHOOL, MIN, type Prepared, type Session } from './betaSchool';
import type { Lesson } from './betaSchoolIcs';
import type { MoodleAssignment } from './betaSchoolMoodle';
import {
  assignmentUrl, changeCount, dayItems, deadlineFor, filterWork, moodleKey, ownKey, preparedCard, scheduleWeek, unseenKeys, workItems,
} from './betaSchoolWork';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0, 0).getTime();
const NOW = at(28, 12);

const assignment = (id: number, due: number | null, courseId = 1): MoodleAssignment => ({
  id, cmid: id * 10, courseId, name: `Hand-in ${id}`, due, opens: null, cutoff: null, intro: `Brief ${id}`, attachments: [],
});

const prep = (id: string, steps: boolean[], deadlineId: string | null = null): Prepared => ({
  id, title: id, course: '', due: null, steps: steps.map((done, i) => ({ text: `s${i}`, done })), deadlineId, deckId: null, at: NOW,
});

const moodle = {
  site: 'https://learnit.itu.dk',
  courses: [{ id: 1, name: 'Maths', short: 'MA' }],
  assignments: [assignment(1, at(30, 23)), assignment(2, null), assignment(3, at(29, 12))],
};

describe('work', () => {
  test('LearnIT and own deadlines in one list, soonest first, undated last', () => {
    const school = { ...EMPTY_SCHOOL, deadlines: [{ id: 'd1', subjectId: null, title: 'Essay', due: at(29, 8), done: false }], seen: [moodleKey(3)] };
    const items = workItems(school, moodle);
    expect(items.map((i) => i.key)).toEqual(['own:d1', 'moodle:3', 'moodle:1', 'moodle:2']);
    expect(items.find((i) => i.key === 'moodle:1')).toMatchObject({ course: 'Maths', fresh: true, url: 'https://learnit.itu.dk/mod/assign/view.php?id=10', text: 'Brief 1' });
    expect(items.find((i) => i.key === 'moodle:3')?.fresh).toBe(false);
    expect(items.find((i) => i.key === 'own:d1')).toMatchObject({ source: 'own', fresh: false, deadlineId: 'd1' });
  });

  test('a deadline Preparing made for an assignment is not listed twice', () => {
    const school = {
      ...EMPTY_SCHOOL,
      deadlines: [{ id: 'dm', subjectId: null, title: 'Hand-in 1', due: at(30, 23), done: false }],
      prepared: [prep(moodleKey(1), [false], 'dm')],
    };
    const items = workItems(school, moodle);
    expect(items.some((i) => i.key === ownKey('dm'))).toBe(false);
    expect(items.find((i) => i.key === 'moodle:1')).toMatchObject({ deadlineId: 'dm' });
  });

  test('handed in, filters and unseen keys', () => {
    const items = workItems({ ...EMPTY_SCHOOL, handedIn: [moodleKey(2)] }, moodle);
    expect(filterWork(items, 'done').map((i) => i.key)).toEqual(['moodle:2']);
    expect(filterWork(items, 'open')).toHaveLength(2);
    expect(filterWork(items, 'all')).toHaveLength(3);
    expect(unseenKeys(items)).toEqual(['moodle:3', 'moodle:1', 'moodle:2']);
    expect(workItems(EMPTY_SCHOOL, null)).toEqual([]);
  });

  test('the Today card: unfinished preparations, then what could be prepared', () => {
    const school = { ...EMPTY_SCHOOL, prepared: [prep(moodleKey(1), [true, false]), prep(moodleKey(3), [true])] };
    const card = preparedCard(workItems(school, { ...moodle, assignments: [...moodle.assignments, assignment(4, at(20, 9))] }), NOW);
    expect(card.map((c) => [c.item.key, c.ready])).toEqual([['moodle:1', true], ['moodle:2', false]]);
  });

  test('a prepared assignment becomes a Study plan deadline only with a due date', () => {
    const [dated, undated] = workItems(EMPTY_SCHOOL, { ...moodle, assignments: [assignment(1, at(30, 23)), assignment(2, null)] });
    expect(deadlineFor(dated, 's1', 'd9')).toEqual({ id: 'd9', subjectId: 's1', title: 'Hand-in 1', due: at(30, 23), done: false });
    expect(deadlineFor(undated, null, 'd9')).toBeNull();
    expect(assignmentUrl('https://x.dk/', 0)).toBe('');
  });
});

const lesson = (id: string, d: number, h: number, state: Lesson['state'] = 'normal'): Lesson => ({
  id, title: `Lesson ${id}`, room: 'R1', teacher: 'MK', start: at(d, h), end: at(d, h) + 45 * MIN, allDay: false, state, note: '', raw: `Lesson ${id}`,
});

describe('the day and the week', () => {
  test('lessons and sessions side by side, a cancelled lesson marked', () => {
    const sessions: Session[] = [{ id: 's', subjectId: null, deadlineId: null, title: 'Read', start: at(28, 16), minutes: 30, done: true }];
    const items = dayItems([lesson('a', 28, 8), lesson('b', 28, 10, 'cancelled'), lesson('c', 29, 8)], sessions, [], NOW);
    expect(items.map((i) => i.id)).toEqual(['lesson:a', 'lesson:b', 'session:s']);
    expect(items[0].sub).toBe('R1 · MK');
    expect(items[1]).toMatchObject({ cancelled: true, sub: 'Cancelled' });
    expect(items[2]).toMatchObject({ done: true, end: at(28, 16, 30), sub: '30 min' });
  });

  test('the week is Monday to Friday, plus a weekend day only when it has lessons', () => {
    const monday = at(26, 0);
    const week = scheduleWeek([lesson('a', 27, 8), lesson('n', 33, 9)], monday);
    expect(week).toHaveLength(5);
    expect(week[1].lessons.map((l) => l.id)).toEqual(['a']);
    expect(scheduleWeek([lesson('s', 31, 10)], monday)).toHaveLength(6);
    expect(changeCount([lesson('a', 27, 8, 'changed'), lesson('b', 27, 9, 'cancelled'), lesson('c', 27, 10)])).toEqual({ changed: 1, cancelled: 1 });
  });
});
