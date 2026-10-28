/**
 * Schedule — Lectio's lessons (`Atlas School Beta.dc.html`, "Skema"): the
 * week as columns, or one day as a list, with what Lectio marks as changed or
 * cancelled. Everything here comes from the calendar feed the student
 * connected (betaSchoolIcs.ts); without it, the view says what it needs.
 */
import { useMemo, useState } from 'react';
import { addDays, hhmm, isoWeek, shortDate, startOfDay, weekStart, weekdayShort } from '@/lib/betaSchool';
import { courseColour, lessonStateLabel, type Lesson } from '@/lib/betaSchoolIcs';
import { useSchoolSync } from '@/lib/betaSchoolSync';
import { changeCount, scheduleWeek } from '@/lib/betaSchoolWork';
import { NeedsSchool, SyncLine } from './SchoolBits';
import type { SchoolTab } from './schoolTabs';

function LessonRow({ l, compact }: { l: Lesson; compact?: boolean }) {
  const label = lessonStateLabel(l.state);
  return (
    <div className={`b-sc-lectio${compact ? ' b-sc-lectio--slot' : ''} ${l.state}`}>
      <i style={{ background: courseColour(l.title) }} />
      <span>
        <span className="b-sc-lectio-head"><b>{l.title}</b>{label ? <em className={`b-sc-badge ${l.state}`}>{label}</em> : null}</span>
        <span className="b-num">{l.allDay ? 'All day' : `${hhmm(l.start)}–${hhmm(l.end)}`}{l.room ? ` · ${l.room}` : ''}{!compact && l.teacher ? ` · ${l.teacher}` : ''}</span>
        {compact && l.teacher ? <span>{l.teacher}</span> : null}
        {!compact && l.note ? <span className="b-sc-lectio-note">{l.note}</span> : null}
      </span>
    </div>
  );
}

export function SchoolSchedule({ now, onTab }: { now: number; onTab: (t: SchoolTab) => void }) {
  const sync = useSchoolSync();
  const [view, setView] = useState<'week' | 'day'>('week');
  const [offset, setOffset] = useState(0);
  const [dayIdx, setDayIdx] = useState(() => Math.min(4, (new Date(now).getDay() + 6) % 7));
  const lessons = useMemo(() => sync.lectio.cache?.lessons ?? [], [sync.lectio.cache]);
  const monday = addDays(weekStart(now), offset * 7);
  const week = useMemo(() => scheduleWeek(lessons, monday), [lessons, monday]);
  const counts = changeCount(week.flatMap((d) => d.lessons));
  const today = startOfDay(now);

  if (!sync.conn?.lectio && !sync.lectio.cache) {
    return <NeedsSchool source="Lectio" line="Your schedule comes from Lectio’s calendar feed. Paste its link once and your lessons, rooms and teachers show here, with cancellations marked." onTab={onTab} />;
  }

  const day = week[Math.min(dayIdx, week.length - 1)];
  const dayLessons = day?.lessons ?? [];

  return (
    <div className="b-sc-sched">
      <div className="b-sc-sched-bar">
        <div className="b-sc-seg" role="tablist" aria-label="Schedule view">
          {(['week', 'day'] as const).map((v) => (
            <button type="button" role="tab" key={v} aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'week' ? 'Week' : 'Day'}</button>
          ))}
        </div>
        <div className="b-sc-seg" aria-label="Week">
          <button type="button" aria-label="Previous week" onClick={() => setOffset((o) => o - 1)}>‹</button>
          <button type="button" className={offset === 0 ? 'on' : ''} onClick={() => setOffset(0)}>Week {isoWeek(monday)}</button>
          <button type="button" aria-label="Next week" onClick={() => setOffset((o) => o + 1)}>›</button>
        </div>
        {view === 'day' ? (
          <div className="b-sc-chips">
            {week.map((d, i) => (
              <button type="button" key={d.day} className={`b-sc-chip${i === dayIdx ? ' on' : ''}`} onClick={() => setDayIdx(i)}>{weekdayShort(d.day)} {new Date(d.day).getDate()}</button>
            ))}
          </div>
        ) : null}
        <span className="b-sc-legend">
          <em className="b-sc-badge changed">Changed</em>{counts.changed ? `${counts.changed} this week` : 'moved or added'}
          <em className="b-sc-badge cancelled">Cancelled</em>{counts.cancelled ? `${counts.cancelled} this week` : 'cancelled'}
        </span>
      </div>

      {view === 'week' ? (
        <div className="b-sc-weekgrid-scroll nosb">
          <div className="b-sc-weekgrid" style={{ gridTemplateColumns: `repeat(${week.length}, minmax(150px, 1fr))` }}>
            {week.map((d) => (
              <div key={d.day} className="b-sc-weekcol">
                <span className={`b-sc-wday-t${d.day === today ? ' today' : ''}`}>{weekdayShort(d.day)} {shortDate(d.day)}</span>
                {d.lessons.map((l) => <LessonRow key={l.id} l={l} compact />)}
                {!d.lessons.length ? <span className="b-sc-wday-free">No lessons</span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <section className="b-sc-panel" aria-label={day ? `Lessons on ${shortDate(day.day)}` : 'Lessons'}>
          {dayLessons.map((l) => <LessonRow key={l.id} l={l} />)}
          {!dayLessons.length ? <div className="b-sc-empty">No lessons in Lectio that day.</div> : null}
        </section>
      )}
      <SyncLine which="lectio" />
    </div>
  );
}
