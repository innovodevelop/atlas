/**
 * What the School views draw from more than one source — pure and tested
 * here (betaSchoolWork.test.ts).
 *
 *   - Work: the student's assignments in one list, from LearnIT (Moodle) and
 *     from their own deadlines in Study plan, each under one key
 *     (`moodle:<id>` or `own:<deadline id>`) that "Prepared by Atlas", "new"
 *     and "handed in" are stored against.
 *   - The day: Lectio's lessons and the student's study sessions side by side,
 *     for the hero ribbon and Today.
 *   - The week: Lectio's lessons per school day, for Schedule.
 *
 * Nothing here fetches or stores; the views pass in the cached school data
 * (betaSchoolSync.ts) and the student's own store (betaSchoolStore.ts).
 */

import {
  MIN, addDays, sessionsOn, startOfDay,
  type Deadline, type Prepared, type SchoolState, type Session, type Subject,
} from './betaSchool';
import { courseColour, lessonStateLabel, type DayItem, type Lesson } from './betaSchoolIcs';
import type { MoodleAssignment, MoodleCourse, MoodleFile } from './betaSchoolMoodle';

// ── Work ─────────────────────────────────────────────────────────────────────

export interface WorkItem {
  key: string;
  source: 'moodle' | 'own';
  title: string;
  course: string;
  colour: string;
  due: number | null;
  /** The brief as text: the assignment's description on LearnIT, empty for the student's own deadlines. */
  text: string;
  attachments: MoodleFile[];
  /** The assignment's page on the site, for "Open on LearnIT"; empty for the student's own. */
  url: string;
  done: boolean;
  /** Not seen in the list yet. */
  fresh: boolean;
  prepared: Prepared | null;
  /** The Study plan deadline it is tied to: the student's own, or the one Preparing made for it. */
  deadlineId: string | null;
}

export const moodleKey = (id: number): string => `moodle:${id}`;
export const ownKey = (deadlineId: string): string => `own:${deadlineId}`;

/** The assignment's own page on the site: Moodle's module view, by its course-module id. */
export function assignmentUrl(site: string, cmid: number): string {
  return site && cmid > 0 ? `${site.replace(/\/+$/, '')}/mod/assign/view.php?id=${cmid}` : '';
}

/**
 * Every assignment in one list, soonest first, undated last. A deadline that
 * Preparing made for a LearnIT assignment is that assignment, so it is not
 * listed a second time as the student's own.
 */
export function workItems(
  school: Pick<SchoolState, 'deadlines' | 'subjects' | 'prepared' | 'seen' | 'handedIn'>,
  moodle: { site: string; courses: readonly MoodleCourse[]; assignments: readonly MoodleAssignment[] } | null,
): WorkItem[] {
  const prepared = new Map(school.prepared.map((p) => [p.id, p]));
  const seen = new Set(school.seen);
  const handed = new Set(school.handedIn);
  const out: WorkItem[] = [];
  const mirrored = new Set<string>();
  for (const a of moodle?.assignments ?? []) {
    const key = moodleKey(a.id);
    const course = moodle?.courses.find((c) => c.id === a.courseId)?.name ?? '';
    const prep = prepared.get(key) ?? null;
    if (prep?.deadlineId) mirrored.add(prep.deadlineId);
    out.push({
      key, source: 'moodle', title: a.name, course, colour: courseColour(course || a.name), due: a.due, text: a.intro,
      attachments: a.attachments, url: assignmentUrl(moodle?.site ?? '', a.cmid), done: handed.has(key), fresh: !seen.has(key),
      prepared: prep, deadlineId: prep?.deadlineId ?? null,
    });
  }
  const subject = (id: string | null): Subject | undefined => (id ? school.subjects.find((s) => s.id === id) : undefined);
  for (const d of school.deadlines) {
    if (mirrored.has(d.id)) continue;
    const key = ownKey(d.id);
    const sub = subject(d.subjectId);
    out.push({
      key, source: 'own', title: d.title, course: sub?.name ?? '', colour: sub?.colour ?? 'var(--b-neutral)', due: d.due, text: '',
      attachments: [], url: '', done: d.done, fresh: false, prepared: prepared.get(key) ?? null, deadlineId: d.id,
    });
  }
  return out.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.title.localeCompare(b.title));
}

export type WorkFilter = 'open' | 'done' | 'all';

export function filterWork(items: readonly WorkItem[], f: WorkFilter): WorkItem[] {
  return f === 'all' ? [...items] : items.filter((i) => (f === 'done' ? i.done : !i.done));
}

/**
 * What the Today card "Prepared by Atlas" lists: what Atlas laid out and the
 * student has not finished, then open assignments not prepared yet that are
 * still ahead, so Prepare is one tap away. Never more than `max`.
 */
export function preparedCard(items: readonly WorkItem[], now: number, max = 3): { item: WorkItem; ready: boolean }[] {
  const ready = items.filter((i) => i.prepared && !i.done && i.prepared.steps.some((s) => !s.done));
  const waiting = items.filter((i) => !i.prepared && !i.done && i.source === 'moodle' && (i.due === null || i.due >= now));
  return [...ready.map((item) => ({ item, ready: true })), ...waiting.map((item) => ({ item, ready: false }))].slice(0, max);
}

/** The keys of the LearnIT assignments in the list, to mark them seen once the list has been looked at. */
export function unseenKeys(items: readonly WorkItem[]): string[] {
  return items.filter((i) => i.fresh).map((i) => i.key);
}

/**
 * The Study plan deadline a LearnIT assignment becomes when it is prepared,
 * so its sessions have something to belong to and it shows in the week.
 */
export function deadlineFor(item: WorkItem, subjectId: string | null, id: string): Deadline | null {
  if (item.due === null) return null;
  return { id, subjectId, title: item.title.slice(0, 300), due: item.due, done: false };
}

// ── The day ──────────────────────────────────────────────────────────────────

/** Today's lessons and study sessions as one list for the ribbon (betaSchoolIcs.dayRibbon). */
export function dayItems(lessons: readonly Lesson[], sessions: readonly Session[], subjects: readonly Subject[], now: number): DayItem[] {
  const day0 = startOfDay(now);
  const day1 = addDays(day0, 1);
  const fromLectio = lessons
    .filter((l) => !l.allDay && l.start >= day0 && l.start < day1)
    .map((l): DayItem => ({
      id: `lesson:${l.id}`,
      title: l.title,
      start: l.start,
      end: l.end,
      sub: l.state === 'cancelled' ? lessonStateLabel(l.state) : [l.room, l.teacher].filter(Boolean).join(' · ') || lessonStateLabel(l.state),
      colour: courseColour(l.title),
      cancelled: l.state === 'cancelled',
      done: false,
    }));
  const own = sessionsOn(sessions, day0).map((s): DayItem => {
    const sub = s.subjectId ? subjects.find((x) => x.id === s.subjectId) : undefined;
    return {
      id: `session:${s.id}`, title: s.title, start: s.start, end: s.start + s.minutes * MIN,
      sub: sub?.name ?? `${s.minutes} min`, colour: sub?.colour ?? '#8fa9ff', cancelled: false, done: s.done,
    };
  });
  return [...fromLectio, ...own].sort((a, b) => a.start - b.start);
}

// ── The week ─────────────────────────────────────────────────────────────────

export interface ScheduleDay { day: number; lessons: Lesson[] }

/**
 * A week of lessons, Monday first. The school week is Monday to Friday; a
 * weekend day shows only when Lectio has something on it.
 */
export function scheduleWeek(lessons: readonly Lesson[], weekStartMs: number): ScheduleDay[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartMs, i))
    .map((day) => ({ day, lessons: lessons.filter((l) => l.start >= day && l.start < addDays(day, 1)).sort((a, b) => a.start - b.start) }))
    .filter((d, i) => i < 5 || d.lessons.length > 0);
}

/** "Changed" and "Cancelled" counted over a set of lessons, for the line above the week. */
export function changeCount(lessons: readonly Lesson[]): { changed: number; cancelled: number } {
  return {
    changed: lessons.filter((l) => l.state === 'changed').length,
    cancelled: lessons.filter((l) => l.state === 'cancelled').length,
  };
}
