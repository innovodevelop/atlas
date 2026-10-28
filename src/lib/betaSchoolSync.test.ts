import { afterEach, describe, expect, test } from 'bun:test';
import { _resetSchoolSync, _setSchoolInvoke, fetchMoodle, lectioErrorText } from './betaSchoolSync';
import type { MoodleData } from './betaSchoolMoodle';

afterEach(() => { _setSchoolInvoke(null); _resetSchoolSync(); });

/** A Moodle that answers each function from a table; a function given an Error rejects. */
function fakeMoodle(answers: Record<string, unknown>, calls: string[] = []) {
  _setSchoolInvoke(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    expect(cmd).toBe('school_moodle_call');
    const fn = String(args?.function);
    calls.push(`${fn} ${JSON.stringify(args?.params ?? {})}`);
    const a = answers[fn];
    if (a instanceof Error) throw a.message;
    return (typeof a === 'function' ? (a as (p: unknown) => unknown)(args?.params) : a) as T;
  });
}

const SITE = { sitename: 'LearnIT', fullname: 'A Student', userid: 7, functions: [] as { name: string }[] };

describe('one pass over Moodle', () => {
  test('courses first, then assignments, materials, messages and grades for those courses', async () => {
    const calls: string[] = [];
    fakeMoodle({
      core_webservice_get_site_info: SITE,
      core_enrol_get_users_courses: [{ id: 1, fullname: 'Maths' }, { id: 2, fullname: 'Physics' }],
      mod_assign_get_assignments: { courses: [{ id: 1, assignments: [{ id: 10, name: 'H1', duedate: 0 }] }] },
      core_course_get_contents: (p: { courseid: string }) => [{ name: 'W1', modules: [{ id: Number(p.courseid) * 100, modname: 'page', name: `Guide ${p.courseid}` }] }],
      core_message_get_conversations: { conversations: [] },
      gradereport_user_get_grade_items: { usergrades: [{ gradeitems: [] }] },
    }, calls);
    const data = await fetchMoodle(null);
    expect(data.courses.map((c) => c.name)).toEqual(['Maths', 'Physics']);
    expect(data.assignments.map((a) => a.id)).toEqual([10]);
    expect(data.materials.map((m) => m.name)).toEqual(['Guide 1', 'Guide 2']);
    expect(data.unavailable).toEqual([]);
    expect(calls).toContain('mod_assign_get_assignments {"courseids[0]":"1","courseids[1]":"2"}');
    expect(calls).toContain('core_enrol_get_users_courses {"userid":"7"}');
  });

  test('a part the site does not offer is unavailable; a part that fails keeps the last pass', async () => {
    const prev = {
      materials: [{ id: 5, courseId: 1, section: '', name: 'Kept', kind: 'page', url: '', description: '', files: [], modified: null }],
      grades: [], assignments: [], conversations: [], courses: [],
    } as unknown as MoodleData;
    fakeMoodle({
      core_webservice_get_site_info: { ...SITE, functions: ['core_enrol_get_users_courses', 'core_course_get_contents', 'mod_assign_get_assignments'] },
      core_enrol_get_users_courses: [{ id: 1, fullname: 'Maths' }],
      mod_assign_get_assignments: new Error('http:500'),
      core_course_get_contents: new Error('unreachable:Io'),
    });
    const data = await fetchMoodle(prev);
    expect(data.unavailable.sort()).toEqual(['grades', 'messages']);
    expect(data.materials.map((m) => m.name)).toEqual(['Kept']);
    expect(data.assignments).toEqual([]);
  });

  test('a site that is not Moodle fails the pass', async () => {
    fakeMoodle({ core_webservice_get_site_info: { error: 'nope' } });
    await expect(fetchMoodle(null)).rejects.toThrow('not-moodle');
  });
});

describe('Lectio errors, said plainly', () => {
  test('an expired link, a network failure, and Rust\'s own sentences', () => {
    expect(lectioErrorText('http:404')).toContain('no longer knows this link');
    expect(lectioErrorText('not-a-calendar')).toContain('copy a fresh one');
    expect(lectioErrorText('unreachable:Dns')).toContain('could not be reached');
    expect(lectioErrorText('That isn\'t a Lectio link. It should be on lectio.dk.')).toBe('That isn\'t a Lectio link. It should be on lectio.dk.');
  });
});
