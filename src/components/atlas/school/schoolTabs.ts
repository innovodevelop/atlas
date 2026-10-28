/**
 * The School screen's views, in the design's tab order. School Tools
 * (Writing, Spreadsheet) are views of the same page rather than a second
 * route, so a student moves between their plan and their document without
 * leaving School. The hash names the view (`/school#cards`), which makes each
 * one linkable; an assignment opens as `#assignments/<key>`, so Back closes it.
 */
export type SchoolTab =
  | 'today' | 'schedule' | 'assignments' | 'plan' | 'cards' | 'tutor' | 'grades' | 'exams'
  | 'messages' | 'materials' | 'writing' | 'sheet' | 'school';

export const SCHOOL_TABS: readonly { key: SchoolTab; label: string; title: string }[] = [
  { key: 'today', label: 'Today', title: 'School' },
  { key: 'schedule', label: 'Schedule', title: 'Schedule' },
  { key: 'assignments', label: 'Assignments', title: 'Assignments' },
  { key: 'plan', label: 'Study plan', title: 'Study plan' },
  { key: 'cards', label: 'Cards', title: 'Cards' },
  { key: 'tutor', label: 'Tutor', title: 'Tutor' },
  { key: 'grades', label: 'Grades', title: 'Grades' },
  { key: 'exams', label: 'Exams', title: 'Exams' },
  { key: 'messages', label: 'Messages', title: 'Messages' },
  { key: 'materials', label: 'Materials', title: 'Materials' },
  { key: 'writing', label: 'Writing', title: 'Writing' },
  { key: 'sheet', label: 'Spreadsheet', title: 'Spreadsheet' },
  { key: 'school', label: 'Your school', title: 'Your school' },
];

export function tabFromHash(hash: string): SchoolTab {
  const k = hash.replace(/^#/, '').split('/')[0];
  return SCHOOL_TABS.find((t) => t.key === k)?.key ?? 'today';
}

/** The assignment open in `#assignments/<key>`, or null on the list. */
export function assignmentFromHash(hash: string): string | null {
  const m = /^#?assignments\/(.+)$/.exec(hash);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

export function assignmentHash(key: string | null): string {
  return key ? `assignments/${encodeURIComponent(key)}` : 'assignments';
}
