/**
 * Today — the School screen's first view (`Atlas School Beta.dc.html`, "I
 * dag"): today's sessions, what is due soon, and the cards waiting.
 *
 * The design fills this with the school day from Lectio and assignments Atlas
 * prepared; Atlas has neither source, so the day is the student's own plan.
 * The "Prepared by Atlas" card is not drawn: there is nothing for it to have
 * prepared from.
 */
import {
  DAY, MIN, deadlineProgress, deadlinesOn, dueCards, dueIn, dueLabel, hhmm, reviewsToday, sessionsOn,
  startOfDay, upcomingDeadlines, type Session,
} from '@/lib/betaSchool';
import { updateSchool, useSchool } from '@/lib/betaSchoolStore';
import type { SchoolTab } from './schoolTabs';

export function SchoolToday({ now, onTab }: { now: number; onTab: (t: SchoolTab) => void }) {
  const school = useSchool();
  const day = startOfDay(now);
  const sessions = sessionsOn(school.sessions, day);
  const dueToday = deadlinesOn(school.deadlines, day).filter((d) => !d.done);
  const soon = upcomingDeadlines(school.deadlines, 4);
  const cardsDue = dueCards(school.cards, now).length;
  const reviewed = reviewsToday(school.reviewLog, now);
  const subject = (id: string | null) => (id ? school.subjects.find((s) => s.id === id) : undefined);
  const toggle = (s: Session) => updateSchool((st) => ({ ...st, sessions: st.sessions.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x)) }));

  return (
    <div className="b-sc-home">
      <section className="b-sc-panel" aria-label="Today">
        <div className="b-sc-panel-head">
          <span className="b-sc-h3">Today</span>
          <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => onTab('plan')}>Whole week</button>
        </div>
        {dueToday.map((d) => (
          <div key={d.id} className="b-sc-lesson b-sc-lesson--due">
            <i style={{ background: subject(d.subjectId)?.colour ?? 'var(--b-ink)' }} />
            <span><b>{d.title}</b><span>Due {hhmm(d.due)}{subject(d.subjectId) ? ` · ${subject(d.subjectId)!.name}` : ''}</span></span>
          </div>
        ))}
        {sessions.map((s) => {
          const sub = subject(s.subjectId);
          const over = now >= s.start + s.minutes * MIN;
          return (
            <div key={s.id} className={`b-sc-lesson${s.done ? ' done' : over ? ' over' : ''}`}>
              <i style={{ background: sub?.colour ?? 'var(--b-blue)' }} />
              <span><b>{s.title}</b><span className="b-num">{hhmm(s.start)}–{hhmm(s.start + s.minutes * MIN)}{sub ? ` · ${sub.name}` : ''}</span></span>
              <button type="button" className={`b-sc-check${s.done ? ' on' : ''}`} aria-pressed={s.done} onClick={() => toggle(s)}>{s.done ? 'Done' : 'Mark done'}</button>
            </div>
          );
        })}
        {!sessions.length && !dueToday.length ? (
          <div className="b-sc-empty">
            Nothing planned today.
            <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => onTab('plan')}>Plan a session</button>
          </div>
        ) : null}
      </section>

      <div className="b-sc-stack">
        <section className="b-sc-card" aria-label="Due soon">
          <div className="b-sc-panel-head">
            <span className="b-sc-h3">Due soon</span>
            <button type="button" className="b-btn b-btn--row" onClick={() => onTab('plan')}>All deadlines</button>
          </div>
          {soon.map((d) => {
            const sub = subject(d.subjectId);
            const p = deadlineProgress(d, school.sessions);
            const late = d.due < now;
            const near = !late && d.due - now < 2 * DAY;
            return (
              <button type="button" key={d.id} className="b-sc-duerow" onClick={() => onTab('plan')}>
                <i style={{ background: sub?.colour ?? 'var(--b-neutral)' }} />
                <span><b>{d.title}</b><span>{sub ? `${sub.name} · ` : ''}{p.total ? `${p.done} of ${p.total} sessions done` : 'no sessions planned'}</span></span>
                <span className={`b-sc-duerow-when b-num${near || late ? ' near' : ''}`}>{dueLabel(d.due, now)}</span>
                <span className={`b-sc-tag${late ? ' late' : near ? ' near' : ''}`}>{late ? 'Overdue' : dueIn(d.due, now)}</span>
              </button>
            );
          })}
          {!soon.length ? <div className="b-sc-empty">No deadlines yet. Add what is due in Study plan and it shows here.</div> : null}
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
