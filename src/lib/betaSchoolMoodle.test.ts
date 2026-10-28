import { describe, expect, test } from 'bun:test';
import {
  assignmentGroup, averagePercentage, courseGrades, decodeEntities, htmlToText, isReadable, moodleErrorText,
  parseMoodleCache, readAssignments, readContents, readConversations, readCourses, readGradeItems, readSiteInfo,
  type MoodleData,
} from './betaSchoolMoodle';

// Wednesday 28 October 2026, 12:00 local.
const NOW = new Date(2026, 9, 28, 12, 0, 0, 0).getTime();
const at = (d: number, h: number) => new Date(2026, 9, d, h, 0, 0, 0).getTime();
const unix = (ms: number) => Math.round(ms / 1000);

describe('text out of Moodle\'s HTML', () => {
  test('entities, breaks, paragraphs and lists', () => {
    expect(decodeEntities('&aelig;&oslash;&aring; &amp; &#8211; &#x2014; &bogus;')).toBe('æøå & – — &bogus;');
    expect(htmlToText('<p>Read <b>chapter 4</b>.</p><p>Then:<br>answer</p><ul><li>one</li><li>two</li></ul><script>x()</script>'))
      .toBe('Read chapter 4.\n\nThen:\nanswer\n\n• one\n• two');
  });
});

describe('readers', () => {
  test('site info needs a user; functions are names', () => {
    expect(readSiteInfo({ sitename: 'LearnIT', fullname: 'A Student', userid: 7, functions: [{ name: 'mod_assign_get_assignments' }] }))
      .toEqual({ name: 'LearnIT', user: 'A Student', userId: 7, release: '', functions: ['mod_assign_get_assignments'] });
    expect(readSiteInfo({ sitename: 'x' })).toBeNull();
  });

  test('courses: hidden ones are left out, names are text', () => {
    expect(readCourses([{ id: 1, fullname: 'Algorithms &amp; Data', shortname: 'AD' }, { id: 2, fullname: 'Old', hidden: true }, 'junk']))
      .toEqual([{ id: 1, name: 'Algorithms & Data', short: 'AD' }]);
  });

  test('assignments: seconds become milliseconds, 0 is "not set", the description becomes text', () => {
    const [a] = readAssignments({
      courses: [{ id: 1, assignments: [{
        id: 10, cmid: 99, name: 'Hand-in 3', duedate: unix(at(30, 23)), allowsubmissionsfromdate: 0, cutoffdate: '0',
        intro: '<p>Solve exercises 1&ndash;3.</p>',
        introattachments: [{ filename: 'notes.txt', fileurl: 'https://site/webservice/pluginfile.php/1/notes.txt', mimetype: 'text/plain', filesize: 120 }],
      }] }],
    });
    expect(a).toMatchObject({ id: 10, cmid: 99, courseId: 1, name: 'Hand-in 3', due: at(30, 23), opens: null, cutoff: null, intro: 'Solve exercises 1–3.' });
    expect(a.attachments).toEqual([{ name: 'notes.txt', url: 'https://site/webservice/pluginfile.php/1/notes.txt', mime: 'text/plain', size: 120 }]);
  });

  test('materials: modules that are not materials stay out; pages get a MIME type from their name', () => {
    const mats = readContents(1, [{
      name: 'Week 1', modules: [
        { id: 1, modname: 'resource', name: 'Slides', url: 'https://site/mod/resource/view.php?id=1', contents: [{ type: 'file', filename: 'slides.pdf', fileurl: 'https://site/pluginfile.php/1/slides.pdf', mimetype: 'application/pdf' }] },
        { id: 2, modname: 'page', name: 'Reading guide', url: 'https://site/mod/page/view.php?id=2', contents: [{ type: 'file', filename: 'index.html', fileurl: 'https://site/pluginfile.php/2/index.html' }] },
        { id: 3, modname: 'forum', name: 'Announcements' },
        { id: 4, modname: 'url', name: 'Link', contents: [{ type: 'url', fileurl: 'https://example.org' }] },
        { id: 5, modname: 'page', name: 'Hidden', uservisible: false },
      ],
    }]);
    expect(mats.map((m) => m.name)).toEqual(['Slides', 'Reading guide', 'Link']);
    expect(mats[1].files[0].mime).toBe('text/html');
    expect(mats[2].files).toEqual([]);
    expect(isReadable('text/html')).toBe(true);
    expect(isReadable('application/pdf')).toBe(false);
  });

  test('conversations: the student is not a member of their own list; the latest message wins', () => {
    const [c] = readConversations({ conversations: [{
      id: 5, name: '', unreadcount: 2,
      members: [{ id: 7, fullname: 'Me' }, { id: 8, fullname: 'Teacher T' }],
      messages: [{ useridfrom: 8, text: '<p>Old</p>', timecreated: 100 }, { useridfrom: 7, text: '<p>New</p>', timecreated: 200 }],
    }] }, 7);
    expect(c).toEqual({ id: 5, name: 'Teacher T', members: ['Teacher T'], unread: 2, lastText: 'New', lastAt: 200_000, lastFromMe: true });
  });

  test('grade items: a percentage from Moodle or from the range; hidden items stay out', () => {
    const items = readGradeItems(1, { usergrades: [{ gradeitems: [
      { id: 1, itemtype: 'mod', itemname: 'Quiz 1', graderaw: 7, grademin: 0, grademax: 10, gradeformatted: '7.00', percentageformatted: '70.00 %', gradedategraded: 100 },
      { id: 2, itemtype: 'mod', itemname: 'Quiz 2', graderaw: 9, grademin: 0, grademax: 10, gradeformatted: '9.00', gradedategraded: 200 },
      { id: 3, itemtype: 'mod', itemname: 'Secret', graderaw: 1, gradeishidden: true },
      { id: 4, itemtype: 'course', itemname: '', graderaw: 16, grademin: 0, grademax: 20, gradeformatted: '16.00', percentageformatted: '80,00 %' },
      { id: 5, itemtype: 'mod', itemname: 'Not graded yet', graderaw: null, gradeformatted: '-' },
    ] }] });
    expect(items.map((g) => [g.id, g.percentage])).toEqual([[1, 70], [2, 90], [4, 80], [5, null]]);
    const rows = courseGrades([{ id: 1, name: 'Maths', short: 'MA' }, { id: 2, name: 'Empty', short: '' }], items);
    expect(rows).toHaveLength(1);
    expect(rows[0].total?.id).toBe(4);
    expect(rows[0].items.map((g) => g.id)).toEqual([1, 2]);
    expect(rows[0].trend).toBe('up');
    expect(averagePercentage(rows)).toBe(80);
  });
});

describe('the views', () => {
  test('assignments group by Monday-to-Sunday weeks', () => {
    expect(assignmentGroup(at(30, 12), NOW)).toBe('week');
    expect(assignmentGroup(at(1, 12), NOW)).toBe('past');
    expect(assignmentGroup(new Date(2026, 10, 1, 20).getTime(), NOW)).toBe('week');
    expect(assignmentGroup(new Date(2026, 10, 4).getTime(), NOW)).toBe('next');
    expect(assignmentGroup(at(28, 9), NOW)).toBe('past');
    expect(assignmentGroup(null, NOW)).toBe('none');
    expect(assignmentGroup(new Date(2026, 11, 1).getTime(), NOW)).toBe('later');
  });

  test('errors are said plainly, and a site without tokens says so', () => {
    expect(moodleErrorText('moodle:invalidtoken:Invalid token - token not found')).toContain('did not accept this key');
    expect(moodleErrorText('moodle:servicenotavailable:Web service is not available')).toContain('does not issue keys');
    expect(moodleErrorText('moodle:somethingelse:Odd')).toBe('Moodle said: Odd');
    expect(moodleErrorText('http:503')).toContain('HTTP 503');
    expect(moodleErrorText('not-moodle')).toContain('Moodle site');
  });

  test('the cache round-trips and refuses a damaged entry', () => {
    const data: MoodleData = {
      site: { name: 'LearnIT', user: 'A', userId: 7, release: '4.3', functions: ['x'] },
      courses: [{ id: 1, name: 'Maths', short: 'MA' }],
      assignments: [{ id: 10, cmid: 9, courseId: 1, name: 'H3', due: 1, opens: null, cutoff: null, intro: 'i', attachments: [] }],
      materials: [{ id: 2, courseId: 1, section: 'W1', name: 'Guide', kind: 'page', url: 'u', description: '', files: [{ name: 'index.html', url: 'f', mime: 'text/html', size: 1 }], modified: null }],
      conversations: [{ id: 5, name: 'T', members: ['T'], unread: 0, lastText: 'hi', lastAt: 1, lastFromMe: false }],
      grades: [{ id: 4, courseId: 1, name: '', type: 'course', raw: 1, min: 0, max: 2, formatted: '1', percentage: 50, graded: null }],
      unavailable: ['grades'],
    };
    expect(parseMoodleCache(JSON.stringify({ fetchedAt: NOW, site: 'https://learnit.itu.dk', data }))).toEqual({ fetchedAt: NOW, site: 'https://learnit.itu.dk', data });
    expect(parseMoodleCache('{')).toBeNull();
    expect(parseMoodleCache(JSON.stringify({ fetchedAt: NOW, data: { site: {} } }))).toBeNull();
  });
});
