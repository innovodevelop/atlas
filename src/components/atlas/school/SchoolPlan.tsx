/**
 * Study plan — the week the student plans (`Atlas School Beta.dc.html`, the
 * "Studieplan" tab), and the focus timer beside it.
 *
 * There is no school schedule to plan around (no Lectio feed), so the week
 * holds what the student puts in it: study sessions and deadlines, by
 * subject. "Plan sessions" is the auto-planned part: `spreadSessions` spreads
 * three sessions over the days before a deadline, around what is already in
 * the week, and the student deletes any they do not want.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  FOCUS_SECONDS, addDays, clock, deadlineProgress, deadlinesOn, dueLabel, focusLeft, fromInputs, hhmm,
  isoWeek, nextColour, pauseFocus, sessionsOn, shortDate, spreadSessions, startFocus, startOfDay,
  toDateInput, todayRibbon, uid, weekDays, weekStart, weekdayShort,
  type Deadline, type Session, type Subject,
} from '@/lib/betaSchool';
import { updateSchool, useSchool } from '@/lib/betaSchoolStore';
import { useNow, type SchoolToast } from './useSchoolHooks';

const RING = 2 * Math.PI * 88;

/** The focus card: 25 minutes from an end time, so it keeps running while the student is elsewhere. */
export function FocusCard({ task, onToast }: { task: string; onToast: SchoolToast }) {
  const { focus } = useSchool();
  const running = focus.endsAt !== null;
  const now = useNow(1000, running);
  const left = focusLeft(focus, now);

  useEffect(() => {
    if (running && left === 0) {
      updateSchool((s) => ({ ...s, focus: { endsAt: null, left: 0 } }));
      onToast('Focus block done. Take five minutes.');
    }
  }, [running, left, onToast]);

  const label = running ? 'Pause' : left === 0 || left === FOCUS_SECONDS ? 'Start 25 min' : 'Resume';
  const line = running
    ? 'It keeps time even if you leave this screen.'
    : left === 0 ? 'Good work. Take five minutes before the next block.' : 'One block of 25 minutes, then a five-minute break.';

  return (
    <section className="b-sc-focus" data-beta-tone="ink" aria-label="Focus timer">
      <span className="b-sc-focus-t">Focus · {task}</span>
      <div className="b-sc-focus-ring">
        <svg viewBox="0 0 200 200" aria-hidden>
          <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(249,247,244,.12)" strokeWidth="10" />
          <circle cx="100" cy="100" r="88" fill="none" stroke="#8fa9ff" strokeWidth="10" strokeLinecap="round" strokeDasharray={RING.toFixed(1)} strokeDashoffset={(RING * (1 - left / FOCUS_SECONDS)).toFixed(1)} />
        </svg>
        <span className="b-num" role="timer" aria-live="off">{clock(left)}</span>
      </div>
      <span className="b-sc-focus-line">{line}</span>
      <div className="b-sc-focus-actions">
        <button type="button" className="b-btn b-btn--paper" onClick={() => updateSchool((s) => ({ ...s, focus: running ? pauseFocus(s.focus, Date.now()) : startFocus(s.focus, Date.now()) }))}>{label}</button>
        <button type="button" className="b-btn b-btn--onink" disabled={!running && left === FOCUS_SECONDS} onClick={() => updateSchool((s) => ({ ...s, focus: { endsAt: null, left: FOCUS_SECONDS } }))}>Reset</button>
      </div>
    </section>
  );
}

type AddKind = 'session' | 'deadline' | 'subject';

export function SchoolPlan({ onToast }: { onToast: SchoolToast }) {
  const school = useSchool();
  const now = useNow(30_000);
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState<AddKind>(() => (school.subjects.length ? 'session' : 'subject'));
  const [title, setTitle] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [deadlineId, setDeadlineId] = useState('');
  const [date, setDate] = useState(() => toDateInput(Date.now()));
  // A session defaults to the afternoon, a deadline to the end of the day.
  const [time, setTime] = useState('16:00');
  const [dueTime, setDueTime] = useState('23:59');
  const [minutes, setMinutes] = useState('45');
  const [showDone, setShowDone] = useState(false);

  const week0 = addDays(weekStart(now), offset * 7);
  const days = weekDays(week0);
  const today = startOfDay(now);
  const subjectOf = (id: string | null): Subject | undefined => (id ? school.subjects.find((s) => s.id === id) : undefined);
  const open = useMemo(() => school.deadlines.filter((d) => !d.done).sort((a, b) => a.due - b.due), [school.deadlines]);
  const done = useMemo(() => school.deadlines.filter((d) => d.done).sort((a, b) => b.due - a.due), [school.deadlines]);
  const ribbon = todayRibbon(school.sessions, now, 1);
  const focusTask = ribbon.find((r) => r.state !== 'past')?.session.title ?? 'your next session';

  const add = () => {
    const t = title.trim();
    if (!t) return;
    if (kind === 'subject') {
      if (school.subjects.some((s) => s.name.toLowerCase() === t.toLowerCase())) { onToast(`${t} is already a subject`); return; }
      const id = uid('subj');
      updateSchool((s) => ({ ...s, subjects: [...s.subjects, { id, name: t, colour: nextColour(s.subjects) }] }));
      setTitle('');
      setSubjectId(id);
      setKind('session');
      onToast(`Added ${t}`);
      return;
    }
    const at = fromInputs(date, kind === 'deadline' ? dueTime : time);
    if (at === null) { onToast('Pick a date and a time first'); return; }
    if (kind === 'deadline') {
      const d: Deadline = { id: uid('dl'), subjectId: subjectId || null, title: t, due: at, done: false };
      updateSchool((s) => ({ ...s, deadlines: [...s.deadlines, d] }));
      onToast(`Deadline added · ${dueLabel(at, Date.now())}`);
    } else {
      const m = Math.round(Number(minutes));
      if (!Number.isFinite(m) || m < 5 || m > 600) { onToast('A session is between 5 and 600 minutes'); return; }
      const linked = school.deadlines.find((d) => d.id === deadlineId);
      const ses: Session = { id: uid('ses'), subjectId: subjectId || linked?.subjectId || null, deadlineId: linked?.id ?? null, title: t, start: at, minutes: m, done: false };
      updateSchool((s) => ({ ...s, sessions: [...s.sessions, ses] }));
      setOffset(Math.round((weekStart(at) - weekStart(Date.now())) / (7 * 86_400_000)));
      onToast(`Session added · ${shortDate(at)} ${hhmm(at)}`);
    }
    setTitle('');
  };

  const planFor = (d: Deadline) => {
    const proposed = spreadSessions(d, school.sessions, Date.now(), { count: 3 });
    if (!proposed.length) { onToast('Too close to the deadline to spread sessions out'); return; }
    updateSchool((s) => ({ ...s, sessions: [...s.sessions, ...proposed] }));
    const ids = new Set(proposed.map((p) => p.id));
    onToast(`Planned ${proposed.length} ${proposed.length === 1 ? 'session' : 'sessions'} before ${shortDate(d.due)}`, () => updateSchool((s) => ({ ...s, sessions: s.sessions.filter((x) => !ids.has(x.id)) })));
  };

  const toggleSession = (ses: Session) => updateSchool((s) => ({ ...s, sessions: s.sessions.map((x) => (x.id === ses.id ? { ...x, done: !x.done } : x)) }));
  const removeSession = (ses: Session) => {
    updateSchool((s) => ({ ...s, sessions: s.sessions.filter((x) => x.id !== ses.id) }));
    onToast('Session removed', () => updateSchool((s) => ({ ...s, sessions: [...s.sessions, ses] })));
  };
  const toggleDeadline = (d: Deadline) => updateSchool((s) => ({ ...s, deadlines: s.deadlines.map((x) => (x.id === d.id ? { ...x, done: !x.done } : x)) }));
  const removeDeadline = (d: Deadline) => {
    const linked = school.sessions.filter((x) => x.deadlineId === d.id);
    updateSchool((s) => ({ ...s, deadlines: s.deadlines.filter((x) => x.id !== d.id), sessions: s.sessions.map((x) => (x.deadlineId === d.id ? { ...x, deadlineId: null } : x)) }));
    onToast('Deadline removed', () => updateSchool((s) => ({
      ...s,
      deadlines: [...s.deadlines, d],
      sessions: s.sessions.map((x) => (linked.some((l) => l.id === x.id) ? { ...x, deadlineId: d.id } : x)),
    })));
  };
  const removeSubject = (sub: Subject) => {
    const before = { deadlines: school.deadlines, sessions: school.sessions };
    updateSchool((s) => ({
      ...s,
      subjects: s.subjects.filter((x) => x.id !== sub.id),
      deadlines: s.deadlines.map((x) => (x.subjectId === sub.id ? { ...x, subjectId: null } : x)),
      sessions: s.sessions.map((x) => (x.subjectId === sub.id ? { ...x, subjectId: null } : x)),
    }));
    if (subjectId === sub.id) setSubjectId('');
    onToast(`Removed ${sub.name}`, () => updateSchool((s) => ({ ...s, subjects: [...s.subjects, sub], deadlines: before.deadlines, sessions: before.sessions })));
  };

  return (
    <div className="b-sc-two">
      <div className="b-sc-stack">
        <section className="b-sc-week" aria-label={`Week ${isoWeek(week0)}`}>
          <div className="b-sc-week-head">
            <button type="button" className="b-btn b-btn--card b-btn--row" aria-label="Previous week" onClick={() => setOffset((o) => o - 1)}>‹</button>
            <span className="b-sc-h3">Week {isoWeek(week0)} · {shortDate(days[0])} – {shortDate(days[6])}</span>
            <button type="button" className="b-btn b-btn--card b-btn--row" aria-label="Next week" onClick={() => setOffset((o) => o + 1)}>›</button>
            {offset !== 0 ? <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setOffset(0)}>This week</button> : null}
          </div>
          <div className="b-sc-week-scroll nosb">
            <div className="b-sc-week-grid">
              {days.map((day) => {
                const isToday = day === today;
                const dls = deadlinesOn(school.deadlines, day);
                const ses = sessionsOn(school.sessions, day);
                return (
                  <div key={day} className="b-sc-wday">
                    <span className={`b-sc-wday-t${isToday ? ' today' : ''}`}>{weekdayShort(day)} {new Date(day).getDate()}{isToday ? ' · today' : ''}</span>
                    {dls.map((d) => (
                      <div key={d.id} className={`b-sc-due${d.done ? ' done' : ''}`}>
                        <span className="b-num">Due {hhmm(d.due)}</span>
                        <b>{d.title}</b>
                      </div>
                    ))}
                    {ses.map((x) => {
                      const sub = subjectOf(x.subjectId);
                      return (
                        <div key={x.id} className={`b-sc-block${x.done ? ' done' : ''}`}>
                          <button type="button" className="b-sc-block-main" aria-pressed={x.done} title={x.done ? 'Mark not done' : 'Mark done'} onClick={() => toggleSession(x)}>
                            <span className="b-num">{hhmm(x.start)} · {x.minutes} min</span>
                            <b>{sub ? <i style={{ background: sub.colour }} /> : null}{x.title}</b>
                          </button>
                          <button type="button" className="b-sc-x" aria-label={`Remove ${x.title}`} onClick={() => removeSession(x)}>×</button>
                        </div>
                      );
                    })}
                    {!dls.length && !ses.length ? <span className="b-sc-wday-free">Free</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="b-sc-card b-sc-form" aria-label="Add to the plan">
          <div className="b-sc-row-actions">
            <span className="b-sc-h3">Add to the plan</span>
            <div className="b-seg b-seg--small" role="tablist" aria-label="What to add">
              {(['session', 'deadline', 'subject'] as const).map((k) => (
                <button type="button" role="tab" key={k} aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'session' ? 'Session' : k === 'deadline' ? 'Deadline' : 'Subject'}</button>
              ))}
            </div>
          </div>
          <input className="b-input" value={title} aria-label={kind === 'subject' ? 'Subject name' : 'Title'} placeholder={kind === 'subject' ? 'Subject, e.g. Physics B' : kind === 'deadline' ? 'What is due, e.g. Lab report: projectile motion' : 'What you will do, e.g. Exercises 1–2'} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          {kind !== 'subject' ? (
            <div className="b-sc-fields">
              <select className="b-input" value={subjectId} aria-label="Subject" onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">No subject</option>
                {school.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {kind === 'session' ? (
                <select className="b-input" value={deadlineId} aria-label="For deadline" onChange={(e) => setDeadlineId(e.target.value)}>
                  <option value="">Not for a deadline</option>
                  {open.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                </select>
              ) : null}
              <input className="b-input" type="date" value={date} aria-label="Date" onChange={(e) => setDate(e.target.value)} />
              {kind === 'deadline'
                ? <input className="b-input" type="time" value={dueTime} aria-label="Due at" onChange={(e) => setDueTime(e.target.value)} />
                : <input className="b-input" type="time" value={time} aria-label="Starts at" onChange={(e) => setTime(e.target.value)} />}
              {kind === 'session' ? <input className="b-input" type="number" min={5} max={600} step={5} value={minutes} aria-label="Minutes" onChange={(e) => setMinutes(e.target.value)} /> : null}
            </div>
          ) : null}
          <button type="button" className="b-btn b-btn--primary" disabled={!title.trim()} onClick={add}>Add {kind}</button>
          {school.subjects.length ? (
            <div className="b-sc-subjects" aria-label="Subjects">
              {school.subjects.map((s) => (
                <span key={s.id} className="b-sc-subject"><i style={{ background: s.colour }} />{s.name}<button type="button" aria-label={`Remove ${s.name}`} onClick={() => removeSubject(s)}>×</button></span>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      <div className="b-sc-side">
        <FocusCard task={focusTask} onToast={onToast} />
        <section className="b-sc-list" aria-label="Deadlines">
          <div className="b-sc-list-head"><span className="b-sc-label">Deadlines</span>{done.length ? <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => setShowDone((v) => !v)}>{showDone ? 'Hide done' : `${done.length} done`}</button> : null}</div>
          {open.map((d) => {
            const sub = subjectOf(d.subjectId);
            const p = deadlineProgress(d, school.sessions);
            const late = d.due < now;
            return (
              <div key={d.id} className="b-sc-dl">
                <div className="b-sc-dl-top">
                  <i style={{ background: sub?.colour ?? 'var(--b-neutral)' }} />
                  <span><b>{d.title}</b><span className={late ? 'late' : ''}>{sub ? `${sub.name} · ` : ''}{late ? 'Overdue · ' : ''}{dueLabel(d.due, now)}</span></span>
                  <button type="button" className="b-sc-x" aria-label={`Remove ${d.title}`} onClick={() => removeDeadline(d)}>×</button>
                </div>
                <div className="b-sc-row-actions">
                  <span className="b-sc-muted">{p.total ? `${p.done} of ${p.total} sessions done` : 'No sessions planned for it'}</span>
                  {!p.total && !late ? <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => planFor(d)}>Plan 3 sessions</button> : null}
                  <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => toggleDeadline(d)}>Handed in</button>
                </div>
              </div>
            );
          })}
          {!open.length ? <div className="b-sc-empty">No deadlines. Add one and Atlas can spread study sessions before it.</div> : null}
          {showDone ? done.map((d) => (
            <div key={d.id} className="b-sc-dl done">
              <div className="b-sc-dl-top">
                <i style={{ background: subjectOf(d.subjectId)?.colour ?? 'var(--b-neutral)' }} />
                <span><b>{d.title}</b><span>Handed in · was due {shortDate(d.due)}</span></span>
                <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => toggleDeadline(d)}>Reopen</button>
              </div>
            </div>
          )) : null}
        </section>
      </div>
    </div>
  );
}
