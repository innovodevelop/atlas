/**
 * The School screen's views, in tab order. School Tools (Writing,
 * Spreadsheet) are views of the same page rather than a second route, so a
 * student moves between their plan and their document without leaving School.
 * The hash names the view (`/school#cards`), which makes each one linkable.
 */
export type SchoolTab = 'today' | 'plan' | 'cards' | 'tutor' | 'writing' | 'sheet' | 'school';

export const SCHOOL_TABS: readonly { key: SchoolTab; label: string; title: string }[] = [
  { key: 'today', label: 'Today', title: 'School' },
  { key: 'plan', label: 'Study plan', title: 'Study plan' },
  { key: 'cards', label: 'Cards', title: 'Cards' },
  { key: 'tutor', label: 'Tutor', title: 'Tutor' },
  { key: 'writing', label: 'Writing', title: 'Writing' },
  { key: 'sheet', label: 'Spreadsheet', title: 'Spreadsheet' },
  { key: 'school', label: 'Your school', title: 'Your school' },
];

export function tabFromHash(hash: string): SchoolTab {
  const k = hash.replace(/^#/, '');
  return SCHOOL_TABS.find((t) => t.key === k)?.key ?? 'today';
}
