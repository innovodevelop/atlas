/**
 * Today — the School screen's first view (`Atlas School Beta.dc.html`, "I
 * dag"): today's lessons from Lectio beside the student's own sessions, what
 * Atlas prepared, what is due soon, and the cards waiting.
 *
 * "Prepared by Atlas" lists assignments the student had Atlas prepare and has
 * not finished, then open LearnIT assignments that could be prepared — each
 * opens the assignment, where Prepare is. Nothing is prepared on its own.
 */
import {
  MIN, deadlinesOn, dueCards, hhmm, reviewsToday, sessionsOn, startOfDay,
  type Session,
} from '@/lib/betaSchool';
import { courseColour, lessonStateLabel, lessonsOn } from '@/lib/betaSchoolIcs';
import { stepProgress } from '@/lib/betaSchoolAtlas';
import { updateSchool, useSchool } from '@/lib/betaSchoolStore';
import { useSchoolSync } from '@/lib/betaSchoolSync';
import { preparedCard } from '@/lib/betaSchoolWork';
import { WorkRow } from './SchoolAssignments';
import { useWork } from './useSchoolWork';
import type { SchoolTab } from './schoolTabs';

export function SchoolToday({ now, onTab, onOpen }: { now: number; onTab: (t: SchoolTab) => void; onOpen: (key: string) => void }) {
  const school = useSchool();
  const sync = useSchoolSync();
  const work = useWork();
  const day = startOfDay(now);
  const lessons = lessonsOn(sync.lectio.cache?.lessons ?? [], day);
  const sessions = sessionsOn(school.sessions, day);
  const dueToday = deadlinesOn(school.deadlines, day).filter((d) => !d.done);
  const soon = work.filter((w) => !w.done && w.due !== null).slice(0, 4);
  const prepared = preparedCard(work, now);
  const cardsDue = dueCards(school.cards, now).length;
  const reviewed = reviewsToday(school.reviewLog, now);
  const subject = (id: string | null) => (id ? school.subjects.find((s) => s.id === id) : undefined);
  const toggle = (s: Session) => updateSchool((st) => ({ ...st, sessions: st.sessions.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)) }));
  const moodleOn = !!sync.conn?.moodle.connected;

  // Lessons and sessions in time order, so the day reads as it runs.
  const rows = [
    ...lessons.map((l) => ({ at: l.start, key: `l:${l.id}`, el: (
      <div key={`l:${l.id}`} className={`b-sc-lesson b-sc-lectio-day ${l.state}${now >= l.end ? ' over' : ''}`}>
        <i style={{ background: courseColour(l.title) }} />
        <span>
          <span className="b-sc-lectio-head"><b>{l.title}</b>{l.state !== 'normal' ? <em className={`b-sc-badge ${l.state}`}>{lessonStateLabel(l.state)}</em> : null}</span>
          <span className="b-num">{l.allDay ? 'All day' : `${hhmm(l.start)}–${hhmm(l.end)}`}{l.room ? ` · ${l.room}` : ''}{l.teacher ? ` · ${l.teacher}` : ''}</span>
          {l.note ? <span className="b-sc-lectio-note">{l.note}</span> : null}
        </span>
      </div>
    ) })),
    ...sessions.map((s) => {
      const sub = subject(s.subjectId);
      const over = now >= s.start + s.minutes * MIN;
      return { at: s.start, key: `s:${s.id}`, el: (
        <div key={`s:${s.id}`} className={`b-sc-lesson${s.done ? ' done' : over ? ' over' : ''}`}>
          <i style={{ background: sub?.colour ?? 'var(--b-blue)' }} />
          <span><b>{s.title}</b><span className="b-num">{hhmm(s.start)}–{hhmm(s.start + s.minutes * MIN)} · study session{sub ? ` · ${sub.name}` : ''}</span></span>
          <button type="button" className={`b-sc-check${s.done ? ' on' : ''}`} aria-pressed={s.done} onClick={() => toggle(s)}>{s.done ? 'Done' : 'Mark done'}</button>
        </div>
      ) };
    }),
  ].sort((a, b) => a.at - b.at);

  return (
    <div className="b-sc-home">
      <section className="b-sc-panel" aria-label="Today">
        <div className="b-sc-panel-head">
          <span className="b-sc-h3">Today</span>
          <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => onTab(sync.conn?.lectio ? 'schedule' : 'plan')}>Whole week</button>
        </div>
        {dueToday.map((d) => (
          <div key={d.id} className="b-sc-lesson b-sc-lesson--due">
            <i style={{ background: subject(d.subjectId)?.colour ?? 'var(--b-ink)' }} />
            <span><b>{d.title}</b><span>Due {hhmm(d.due)}{subject(d.subjectId) ? ` · ${subject(d.subjectId)!.name}` : ''}</span></span>
          </div>
        ))}
        {rows.map((r) => r.el)}
        {!rows.length && !dueToday.length ? (
          <div className="b-sc-empty">
            {sync.conn?.lectio ? 'No lessons and nothing planned today.' : 'Nothing planned today.'}
            <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => onTab('plan')}>Plan a session</button>
          </div>
        ) : null}
      </section>

      <div className="b-sc-stack">
        {moodleOn || prepared.length ? (
          <section className="b-sc-card" aria-label="Prepared by Atlas">
            <div className="b-sc-panel-head">
              <span className="b-sc-h3">Prepared by Atlas</span>
              <span className="b-sc-muted">when you press Prepare</span>
            </div>
            {prepared.map(({ item, ready }) => {
              const p = item.prepared ? stepProgress(item.prepared.steps) : null;
              return (
                <button type="button" key={item.key} className={`b-sc-prep${ready ? ' ready' : ''}`} onClick={() => onOpen(item.key)}>
                  <i style={{ background: item.colour }} />
                  <span>
                    <span className="b-sc-prep-course">{item.course || 'LearnIT'}</span>
                    <b>{item.title}</b>
                    <span>{ready && p ? `${p.done} of ${p.total} steps done` : item.fresh ? 'New · not prepared yet' : 'Not prepared yet'}</span>
                  </span>
                  <span className="b-sc-prep-go">{ready ? 'Open →' : 'Prepare →'}</span>
                </button>
              );
            })}
            {!prepared.length ? <div className="b-sc-empty">Nothing waiting. Open an assignment and press Prepare to have Atlas lay it out.</div> : null}
          </section>
        ) : null}

        <section className="b-sc-card" aria-label="Due soon">
          <div className="b-sc-panel-head">
            <span className="b-sc-h3">Due soon</span>
            <button type="button" className="b-btn b-btn--row" onClick={() => onTab('assignments')}>All assignments</button>
          </div>
          {soon.map((w) => <WorkRow key={w.key} item={w} now={now} onOpen={onOpen} />)}
          {!soon.length ? <div className="b-sc-empty">Nothing due. {moodleOn ? 'LearnIT has no open assignments with a due date.' : 'Add what is due in Study plan, or connect LearnIT.'}</div> : null}
        </section>

        <section className="b-sc-card b-sc-cardsum" aria-label="Cards">
          <div className="b-sc-panel-head"><span className="b-sc-h3">Cards</span><span className="b-sc-muted">{reviewed} reviewed today</span></div>
          <span className="b-sc-cardsum-n b-num">{cardsDue}<small>{cardsDue === 1 ? 'card due' : 'cards due'}</small></span>
          <button type="button" className="b-btn b-btn--primary" onClick={() => onTab('cards')}>{cardsDue ? `Review ${cardsDue} ${cardsDue === 1 ? 'card' : 'cards'}` : school.cards.length ? 'Open your cards' : 'Write your first card'}</button>
        </section>
      </div>
    </div>
  );
}
