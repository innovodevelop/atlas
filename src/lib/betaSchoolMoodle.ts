/**
 * LearnIT (Moodle) for the School screen — pure and tested here
 * (betaSchoolMoodle.test.ts).
 *
 * The student creates a web-service token in Moodle (Preferences → Security
 * keys) and Rust keeps it in the Keychain and makes every call
 * (src-tauri/src/school.rs). What comes back is Moodle's own JSON, which this
 * module reads into the few shapes the screen draws: courses, assignments,
 * materials, conversations and grade items. Each reader is defensive — a
 * field Moodle leaves out (sites differ by version and by what the report
 * settings show) is an empty value, never a crash.
 *
 * The cache keeps only these shapes, on this Mac. It holds no token: Moodle's
 * file URLs carry none until Rust adds it at the moment of a download.
 */

import { DAY, addDays, startOfDay } from './betaSchool';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
/** Moodle times are Unix seconds; 0 means "not set". */
const secs = (v: unknown): number | null => { const n = num(v); return n && n > 0 ? n * 1000 : null; };

// ── HTML to text ─────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  aelig: 'æ', oslash: 'ø', aring: 'å', AElig: 'Æ', Oslash: 'Ø', Aring: 'Å', auml: 'ä', ouml: 'ö', uuml: 'ü', eacute: 'é', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Moodle's HTML (assignment descriptions, messages, pages) as plain text with its paragraphs kept. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(p|h[1-6]|ul|ol|table|blockquote)>/gi, '\n\n')
      .replace(/<\/(div|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface MoodleSite { name: string; user: string; userId: number; release: string; functions: string[] }
export interface MoodleCourse { id: number; name: string; short: string }
export interface MoodleFile { name: string; url: string; mime: string; size: number }
export interface MoodleAssignment {
  id: number;
  cmid: number;
  courseId: number;
  name: string;
  due: number | null;
  opens: number | null;
  cutoff: number | null;
  /** The description, as text. Empty when the site hides it until the assignment opens. */
  intro: string;
  attachments: MoodleFile[];
}
export interface MoodleMaterial {
  id: number;
  courseId: number;
  section: string;
  name: string;
  /** Moodle's module type: resource, page, url, folder, book … */
  kind: string;
  /** The module's own page on the site, for "Open on LearnIT". */
  url: string;
  description: string;
  files: MoodleFile[];
  modified: number | null;
}
export interface MoodleConversation {
  id: number;
  name: string;
  members: string[];
  unread: number;
  lastText: string;
  lastAt: number | null;
  lastFromMe: boolean;
}
export interface MoodleGradeItem {
  id: number;
  courseId: number;
  name: string;
  /** 'course' is the course total; 'mod', 'manual' and 'category' are the rest. */
  type: string;
  raw: number | null;
  min: number;
  max: number;
  formatted: string;
  percentage: number | null;
  graded: number | null;
}

// ── Readers ──────────────────────────────────────────────────────────────────

export function readSiteInfo(v: unknown): MoodleSite | null {
  if (!isObj(v)) return null;
  const userId = num(v.userid);
  if (userId === null) return null;
  return {
    name: str(v.sitename, 200) || 'Moodle',
    user: str(v.fullname, 200),
    userId,
    release: str(v.release, 80),
    functions: arr(v.functions).map((f) => (typeof f === 'string' ? f : isObj(f) ? str(f.name, 120) : '')).filter(Boolean),
  };
}

export function readCourses(v: unknown): MoodleCourse[] {
  return arr(v).flatMap((c) => {
    if (!isObj(c)) return [];
    const id = num(c.id);
    if (id === null || c.hidden === true) return [];
    const name = htmlToText(str(c.displayname, 300) || str(c.fullname, 300));
    return [{ id, name: name || str(c.shortname, 120) || `Course ${id}`, short: str(c.shortname, 120) }];
  });
}

/** A page's content arrives as an `index.html` some sites send without a MIME type. */
function guessMime(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return ({ html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? '';
}

function readFiles(v: unknown): MoodleFile[] {
  return arr(v).flatMap((f) => {
    if (!isObj(f) || f.type === 'url') return [];
    const url = str(f.fileurl, 1000);
    if (!url) return [];
    const name = str(f.filename, 300) || 'File';
    return [{ name, url, mime: str(f.mimetype, 120) || guessMime(name), size: num(f.filesize) ?? 0 }];
  });
}

export function readAssignments(v: unknown): MoodleAssignment[] {
  if (!isObj(v)) return [];
  return arr(v.courses).flatMap((c) => {
    if (!isObj(c)) return [];
    const courseId = num(c.id);
    if (courseId === null) return [];
    return arr(c.assignments).flatMap((a): MoodleAssignment[] => {
      if (!isObj(a)) return [];
      const id = num(a.id);
      if (id === null) return [];
      return [{
        id,
        cmid: num(a.cmid) ?? 0,
        courseId,
        name: htmlToText(str(a.name, 400)) || 'Assignment',
        due: secs(a.duedate),
        opens: secs(a.allowsubmissionsfromdate),
        cutoff: secs(a.cutoffdate),
        intro: htmlToText(str(a.intro, 60_000)).slice(0, 20_000),
        attachments: readFiles(a.introattachments).slice(0, 20),
      }];
    });
  });
}

/** One course's sections and modules, as materials. Labels and forums are not materials. */
export function readContents(courseId: number, v: unknown): MoodleMaterial[] {
  const skip = new Set(['label', 'forum', 'assign', 'quiz', 'choice', 'feedback', 'attendance', 'chat', 'lti']);
  return arr(v).flatMap((s) => {
    if (!isObj(s) || s.uservisible === false) return [];
    const section = htmlToText(str(s.name, 200));
    return arr(s.modules).flatMap((m): MoodleMaterial[] => {
      if (!isObj(m) || m.uservisible === false) return [];
      const id = num(m.id);
      const kind = str(m.modname, 40);
      if (id === null || skip.has(kind)) return [];
      return [{
        id,
        courseId,
        section,
        name: htmlToText(str(m.name, 300)) || 'Material',
        kind,
        url: str(m.url, 1000),
        description: htmlToText(str(m.description, 4000)).slice(0, 1200),
        files: readFiles(m.contents).slice(0, 30),
        modified: secs(isObj(m.contentsinfo) ? m.contentsinfo.lastmodified : null),
      }];
    });
  }).slice(0, 400);
}

export function readConversations(v: unknown, userId: number): MoodleConversation[] {
  if (!isObj(v)) return [];
  return arr(v.conversations).flatMap((c): MoodleConversation[] => {
    if (!isObj(c)) return [];
    const id = num(c.id);
    if (id === null) return [];
    const members = arr(c.members).flatMap((m) => (isObj(m) && num(m.id) !== userId ? [str(m.fullname, 120)] : [])).filter(Boolean);
    const last = arr(c.messages).filter(isObj).sort((a, b) => (num(b.timecreated) ?? 0) - (num(a.timecreated) ?? 0))[0];
    return [{
      id,
      name: htmlToText(str(c.name, 200)) || members.join(', ') || 'Conversation',
      members,
      unread: Math.max(0, num(c.unreadcount) ?? 0),
      lastText: last ? htmlToText(str(last.text, 8000)).slice(0, 4000) : '',
      lastAt: last ? secs(last.timecreated) : null,
      lastFromMe: !!last && num(last.useridfrom) === userId,
    }];
  });
}

const pct = (v: unknown): number | null => {
  const m = /(-?\d+(?:[.,]\d+)?)\s*%/.exec(str(v, 40));
  return m ? Number(m[1].replace(',', '.')) : null;
};

export function readGradeItems(courseId: number, v: unknown): MoodleGradeItem[] {
  if (!isObj(v)) return [];
  const user = arr(v.usergrades).find(isObj);
  if (!user) return [];
  return arr(user.gradeitems).flatMap((g): MoodleGradeItem[] => {
    if (!isObj(g)) return [];
    const id = num(g.id);
    if (id === null || g.gradeishidden === true) return [];
    const raw = num(g.graderaw);
    const min = num(g.grademin) ?? 0;
    const max = num(g.grademax) ?? 100;
    const formatted = str(g.gradeformatted, 40).trim();
    const percentage = pct(g.percentageformatted) ?? (raw !== null && max > min ? Math.round(((raw - min) / (max - min)) * 1000) / 10 : null);
    return [{
      id, courseId, type: str(g.itemtype, 20) || 'mod', name: htmlToText(str(g.itemname, 300)),
      raw, min, max, formatted: formatted && formatted !== '-' ? formatted : '', percentage, graded: secs(g.gradedategraded),
    }];
  });
}

// ── What the views draw ──────────────────────────────────────────────────────

/** Files Atlas can read as text for cards; PDFs, slides and images it cannot. */
export function isReadable(mime: string): boolean {
  return /^text\//.test(mime) || mime === 'application/xhtml+xml';
}

export interface CourseGrades {
  courseId: number;
  name: string;
  /** The course total, when Moodle shows one. */
  total: MoodleGradeItem | null;
  /** Graded items other than the totals, oldest first. */
  items: MoodleGradeItem[];
  trend: 'up' | 'down' | 'steady' | null;
}

/** Grades per course: the total, the graded items in order, and which way the last two went. */
export function courseGrades(courses: readonly MoodleCourse[], grades: readonly MoodleGradeItem[]): CourseGrades[] {
  return courses.flatMap((c) => {
    const mine = grades.filter((g) => g.courseId === c.id);
    const total = mine.find((g) => g.type === 'course' && (g.raw !== null || g.formatted)) ?? null;
    const items = mine
      .filter((g) => g.type !== 'course' && g.type !== 'category' && (g.raw !== null || g.formatted))
      .sort((a, b) => (a.graded ?? 0) - (b.graded ?? 0));
    if (!total && !items.length) return [];
    const scored = items.filter((g) => g.percentage !== null);
    let trend: CourseGrades['trend'] = null;
    if (scored.length >= 2) {
      const d = (scored[scored.length - 1].percentage ?? 0) - (scored[scored.length - 2].percentage ?? 0);
      trend = d > 2 ? 'up' : d < -2 ? 'down' : 'steady';
    }
    return [{ courseId: c.id, name: c.name, total, items, trend }];
  });
}

/** The mean of the course totals that have a percentage, or null. */
export function averagePercentage(rows: readonly CourseGrades[]): number | null {
  const p = rows.map((r) => r.total?.percentage).filter((x): x is number => typeof x === 'number');
  return p.length ? Math.round((p.reduce((a, b) => a + b, 0) / p.length) * 10) / 10 : null;
}

export type AssignmentGroup = 'week' | 'next' | 'later' | 'none' | 'past';

/** This week, next week, later — the design's grouping, by Monday-to-Sunday weeks. */
export function assignmentGroup(due: number | null, now: number): AssignmentGroup {
  if (due === null) return 'none';
  if (due < now) return 'past';
  const monday = (ms: number) => { const d = startOfDay(ms); return addDays(d, -((new Date(d).getDay() + 6) % 7)); };
  const weeks = Math.round((monday(due) - monday(now)) / (7 * DAY));
  return weeks <= 0 ? 'week' : weeks === 1 ? 'next' : 'later';
}

/** What a Moodle error string from Rust means, said plainly for the screen. */
export function moodleErrorText(err: string): string {
  if (err === 'not-connected') return 'LearnIT is not connected.';
  if (err === 'not-moodle') return 'That address did not answer like a Moodle site. Check the site address.';
  if (err.startsWith('unreachable')) return 'The site could not be reached. Check your connection.';
  if (err.startsWith('http:')) return `The site answered with an error (HTTP ${err.slice(5)}).`;
  if (err === 'too-large') return 'The site sent more than Atlas will read in one go.';
  const m = /^moodle:([a-z0-9_]+):?(.*)$/i.exec(err);
  if (m) {
    const code = m[1];
    if (code === 'invalidtoken') return 'The site did not accept this key. Create a new one under Preferences → Security keys.';
    if (/servicenotavailable|enablewsdescription|webservicesnotenabled|wsaccess/i.test(code)) {
      return 'This site does not issue keys to students for the mobile web service, so Atlas cannot connect to it.';
    }
    if (/accessexception|nopermission|requireloginerror/i.test(code)) return 'The site would not let this key read that.';
    return m[2] ? `Moodle said: ${m[2]}` : `Moodle refused (${code}).`;
  }
  return err.slice(0, 200) || 'Something went wrong.';
}

// ── The cache on this Mac ────────────────────────────────────────────────────

export interface MoodleData {
  site: MoodleSite;
  courses: MoodleCourse[];
  assignments: MoodleAssignment[];
  materials: MoodleMaterial[];
  conversations: MoodleConversation[];
  grades: MoodleGradeItem[];
  /** The parts this site's service does not offer, so their views can say so. */
  unavailable: string[];
}

export interface MoodleCache { fetchedAt: number; site: string; data: MoodleData }

/**
 * The cache read back through the same readers' rules: the shapes are
 * re-checked field by field, so a damaged or older entry opens as what it can
 * still say rather than breaking the screen.
 */
export function parseMoodleCache(raw: string | null): MoodleCache | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || typeof v.fetchedAt !== 'number' || !isObj(v.data)) return null;
  const d = v.data;
  if (!isObj(d.site)) return null;
  const site = readSiteInfo({ sitename: d.site.name, fullname: d.site.user, userid: d.site.userId, release: d.site.release, functions: d.site.functions });
  if (!site) return null;
  const files = (x: unknown): MoodleFile[] => arr(x).flatMap((f) => (isObj(f) && str(f.url) ? [{ name: str(f.name, 300), url: str(f.url, 1000), mime: str(f.mime, 120), size: num(f.size) ?? 0 }] : []));
  const nul = (x: unknown) => num(x);
  return {
    fetchedAt: v.fetchedAt,
    site: str(v.site, 300),
    data: {
      site,
      courses: arr(d.courses).flatMap((c) => (isObj(c) && num(c.id) !== null ? [{ id: num(c.id) as number, name: str(c.name, 300), short: str(c.short, 120) }] : [])),
      assignments: arr(d.assignments).flatMap((a) => (isObj(a) && num(a.id) !== null ? [{
        id: num(a.id) as number, cmid: num(a.cmid) ?? 0, courseId: num(a.courseId) ?? 0, name: str(a.name, 400), due: nul(a.due), opens: nul(a.opens), cutoff: nul(a.cutoff),
        intro: str(a.intro, 20_000), attachments: files(a.attachments),
      }] : [])),
      materials: arr(d.materials).flatMap((m) => (isObj(m) && num(m.id) !== null ? [{
        id: num(m.id) as number, courseId: num(m.courseId) ?? 0, section: str(m.section, 200), name: str(m.name, 300), kind: str(m.kind, 40), url: str(m.url, 1000),
        description: str(m.description, 1200), files: files(m.files), modified: nul(m.modified),
      }] : [])),
      conversations: arr(d.conversations).flatMap((c) => (isObj(c) && num(c.id) !== null ? [{
        id: num(c.id) as number, name: str(c.name, 200), members: arr(c.members).map((x) => str(x, 120)).filter(Boolean), unread: num(c.unread) ?? 0,
        lastText: str(c.lastText, 4000), lastAt: nul(c.lastAt), lastFromMe: c.lastFromMe === true,
      }] : [])),
      grades: arr(d.grades).flatMap((g) => (isObj(g) && num(g.id) !== null ? [{
        id: num(g.id) as number, courseId: num(g.courseId) ?? 0, name: str(g.name, 300), type: str(g.type, 20), raw: nul(g.raw), min: num(g.min) ?? 0, max: num(g.max) ?? 100,
        formatted: str(g.formatted, 40), percentage: nul(g.percentage), graded: nul(g.graded),
      }] : [])),
      unavailable: arr(d.unavailable).map((x) => str(x, 40)).filter(Boolean),
    },
  };
}
