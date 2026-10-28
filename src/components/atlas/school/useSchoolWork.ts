/**
 * The student's assignments as the School views draw them: LearnIT's from
 * the cache beside their own deadlines, read once per change of either
 * (betaSchoolWork.workItems).
 */
import { useMemo } from 'react';
import { useSchool } from '@/lib/betaSchoolStore';
import { useSchoolSync } from '@/lib/betaSchoolSync';
import { workItems, type WorkItem } from '@/lib/betaSchoolWork';

export function useWork(): WorkItem[] {
  const school = useSchool();
  const sync = useSchoolSync();
  const data = sync.moodle.cache?.data ?? null;
  const site = sync.conn?.moodle.site ?? sync.moodle.cache?.site ?? '';
  return useMemo(
    () => workItems(school, data ? { site, courses: data.courses, assignments: data.assignments } : null),
    [school, data, site],
  );
}
