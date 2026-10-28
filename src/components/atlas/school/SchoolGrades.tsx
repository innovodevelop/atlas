/**
 * Grades (`Atlas School Beta.dc.html`, "Karakterer"): marks per course from
 * LearnIT's grade report, the graded items as bars, and which way the last
 * two went. Absence has no source — Lectio has no API and its calendar feed
 * carries none — so its card says that instead of a number. Nothing here is
 * computed that Moodle did not send, apart from the mean of the course totals.
 */
import { useMemo } from 'react';
import { shortDate } from '@/lib/betaSchool';
import { courseColour } from '@/lib/betaSchoolIcs';
import { averagePercentage, courseGrades, type MoodleGradeItem } from '@/lib/betaSchoolMoodle';
import { useSchoolSync } from '@/lib/betaSchoolSync';
import { NeedsSchool, SyncLine } from './SchoolBits';
import type { SchoolTab } from './schoolTabs';

const TREND = { up: ['Rising', 'up'], down: ['Falling', 'down'], steady: ['Steady', ''] } as const;
const shown = (g: MoodleGradeItem | null) => (g ? g.formatted || (g.raw !== null ? String(g.raw) : '–') : '–');

export function SchoolGrades({ onTab }: { onTab: (t: SchoolTab) => void }) {
  const sync = useSchoolSync();
  const data = sync.moodle.cache?.data ?? null;
  const rows = useMemo(() => (data ? courseGrades(data.courses, data.grades) : []), [data]);
  const avg = averagePercentage(rows);

  if (!sync.conn?.moodle.connected && !data) {
    return <NeedsSchool source="LearnIT" line="Grades come from LearnIT’s grade report. Connect it with a security key and your marks per course show here." onTab={onTab} />;
  }

  const noGrades = data?.unavailable.includes('grades');
  return (
    <div className="b-sc-gr">
      <div className="b-sc-gr-stats">
        <div className="b-sc-gr-stat" data-beta-tone="ink">
          <span>Average</span>
          <b className="b-num">{avg === null ? '–' : `${avg.toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`}</b>
          <span>{avg === null ? 'No course totals yet' : `Mean of ${rows.filter((r) => r.total?.percentage != null).length} course totals on LearnIT`}</span>
        </div>
        <div className="b-sc-gr-stat b-sc-gr-stat--muted">
          <span>Absence</span>
          <b>No source</b>
          <span>Lectio has no API, and its calendar feed carries no absence. Check it in Lectio.</span>
        </div>
      </div>

      {noGrades ? <p className="b-sc-banner"><b>This site does not share grades with your key.</b> <span>The grade report is not part of the web service your school allows.</span></p> : null}

      <section className="b-sc-panel b-sc-gr-list" aria-label="Grades per course">
        {rows.map((r) => {
          const last = r.items[r.items.length - 1];
          const bars = r.items.filter((g) => g.percentage !== null).slice(-6);
          const trend = r.trend ? TREND[r.trend] : null;
          return (
            <div key={r.courseId} className="b-sc-gr-row">
              <span className="b-sc-gr-name">
                <i style={{ background: courseColour(r.name) }} />
                <span><b>{r.name}</b><span>{last ? `${last.name || 'Last item'} · ${shown(last)}${last.graded ? ` · ${shortDate(last.graded)}` : ''}` : 'No graded items yet'}</span></span>
              </span>
              <span className="b-sc-gr-bars" aria-label={`${bars.length} graded items`}>
                {bars.map((g) => <span key={g.id} title={`${g.name}: ${shown(g)}`} style={{ height: `${Math.max(8, Math.min(100, g.percentage ?? 0))}%` }} />)}
              </span>
              <span className="b-sc-gr-total"><small>Course total</small><b className="b-num">{shown(r.total)}</b></span>
              <span className={`b-sc-gr-trend ${trend?.[1] ?? ''}`}>{trend ? trend[0] : ''}</span>
            </div>
          );
        })}
        {!rows.length ? <div className="b-sc-empty">{data ? 'No grades on LearnIT yet.' : 'Fetching your grades…'}</div> : null}
      </section>
      <SyncLine which="moodle" />
    </div>
  );
}
