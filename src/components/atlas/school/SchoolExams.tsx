/**
 * Exams (`Atlas School Beta.dc.html`, "Eksamen"): Lectio's exams (lessons
 * whose title marks one) and the ones the student adds, each counting down in
 * days. Revision readiness is measured from the student's own cards: they link
 * decks to an exam as its topics, and a topic is as ready as the share of its
 * cards the scheduler already trusts for a week or more (betaSchoolExams.ts).
 * "Plan revision" spreads sessions before the exam, weakest topic first, and
 * adds them to Study plan with an Undo.
 */
import { useMemo, useState } from 'react';
import { fromInputs, longDate, hhmm, toDateInput, uid, type ExamKind } from '@/lib/betaSchool';
import { EXAM_KINDS, allExams, daysUntil, examReadiness, examTopics, revisionPlan, type Exam } from '@/lib/betaSchoolExams';
import { updateSchool, useSchool } from '@/lib/betaSchoolStore';
import { useSchoolSync } from '@/lib/betaSchoolSync';
import type { SchoolToast } from './useSchoolHooks';
import type { SchoolTab } from './schoolTabs';

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const kindLabel = (k: ExamKind) => EXAM_KINDS.find((x) => x.key === k)?.label ?? 'Exam';

export function SchoolExams({ now, onTab, onToast }: { now: number; onTab: (t: SchoolTab) => void; onToast: SchoolToast }) {
  const school = useSchool();
  const sync = useSchoolSync();
  const lessons = useMemo(() => sync.lectio.cache?.lessons ?? [], [sync.lectio.cache]);
  const exams = useMemo(() => allExams(lessons, school.exams, now), [lessons, school.exams, now]);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ExamKind>('written');
  const [date, setDate] = useState(() => toDateInput(now + 14 * 86_400_000));
  const [time, setTime] = useState('09:00');

  const add = () => {
    const at = fromInputs(date, time);
    if (!title.trim() || at === null) return;
    updateSchool((s) => ({ ...s, exams: [...s.exams, { id: uid('exam'), title: title.trim().slice(0, 300), kind, at }] }));
    setTitle('');
    onToast('Exam added');
  };

  const remove = (e: Exam) => {
    const own = school.exams.find((x) => x.id === e.ownId);
    if (!own) return;
    const links = school.examDecks[e.key];
    updateSchool((s) => {
      const examDecks = { ...s.examDecks };
      delete examDecks[e.key];
      return { ...s, exams: s.exams.filter((x) => x.id !== own.id), examDecks };
    });
    onToast(`Removed ${own.title}`, () => updateSchool((s) => ({ ...s, exams: [...s.exams, own], examDecks: links ? { ...s.examDecks, [e.key]: links } : s.examDecks })));
  };

  const link = (key: string, deckId: string) => updateSchool((s) => {
    const cur = s.examDecks[key] ?? [];
    return cur.includes(deckId) ? s : { ...s, examDecks: { ...s.examDecks, [key]: [...cur, deckId] } };
  });
  const unlink = (key: string, deckId: string) => updateSchool((s) => {
    const left = (s.examDecks[key] ?? []).filter((d) => d !== deckId);
    const examDecks = { ...s.examDecks };
    if (left.length) examDecks[key] = left; else delete examDecks[key];
    return { ...s, examDecks };
  });

  const plan = (e: Exam) => {
    const topics = examTopics(e.key, school.examDecks, school.decks, school.cards);
    const proposed = revisionPlan(e, topics, school.sessions, Date.now());
    if (!proposed.length) { onToast('There is no free day left before the exam to plan revision on'); return; }
    updateSchool((s) => ({ ...s, sessions: [...s.sessions, ...proposed] }));
    const ids = new Set(proposed.map((p) => p.id));
    onToast(`Planned ${proposed.length} revision ${proposed.length === 1 ? 'session' : 'sessions'} in Study plan`, () => updateSchool((s) => ({ ...s, sessions: s.sessions.filter((x) => !ids.has(x.id)) })));
  };

  return (
    <div className="b-sc-exams">
      <div className="b-sc-exam-grid">
        {exams.map((e, i) => {
          const topics = examTopics(e.key, school.examDecks, school.decks, school.cards);
          const ready = examReadiness(topics);
          const free = school.decks.filter((d) => !topics.some((t) => t.deckId === d.id));
          const days = daysUntil(e.at, now);
          return (
            <section key={e.key} className={`b-sc-exam${i === 0 ? ' b-sc-exam--next' : ''}`} data-beta-tone={i === 0 ? 'ink' : undefined} aria-label={e.title}>
              <span className="b-sc-exam-top"><span>{kindLabel(e.kind)} · {e.source === 'lectio' ? 'Lectio' : 'Added by you'}</span><span>{longDate(e.at)} · {hhmm(e.at)}</span></span>
              <span className="b-sc-exam-title">{e.title}</span>
              <span className="b-sc-exam-days"><b className="b-num">{days}</b><span>{days === 0 ? 'today' : days === 1 ? 'day' : 'days'}{e.room ? ` · ${e.room}` : ''}</span></span>
              <span className="b-sc-exam-ready">Revision readiness {pct(ready)}</span>
              {topics.map((t) => (
                <span key={t.deckId} className="b-sc-exam-topic">
                  <span>{t.name}</span>
                  <span className="b-sc-exam-track"><span style={{ width: `${Math.round((t.share ?? 0) * 100)}%` }} /></span>
                  <span className="b-num">{t.total ? pct(t.share) : 'no cards'}</span>
                  <button type="button" className="b-sc-x" aria-label={`Unlink ${t.name}`} onClick={() => unlink(e.key, t.deckId)}>×</button>
                </span>
              ))}
              {!topics.length ? <span className="b-sc-exam-hint">Link the decks you revise from. A topic is ready when its cards are scheduled a week or more out.</span> : null}
              <div className="b-sc-row-actions">
                {free.length ? (
                  <select className="b-sc-exam-link" value="" aria-label="Link a deck as a topic" onChange={(ev) => { if (ev.target.value) link(e.key, ev.target.value); }}>
                    <option value="">Link a deck…</option>
                    {free.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                ) : !school.decks.length ? (
                  <button type="button" className="b-sc-exam-btn" onClick={() => onTab('cards')}>Make a deck in Cards</button>
                ) : null}
                <button type="button" className="b-sc-exam-btn" onClick={() => plan(e)}>Plan revision</button>
                {e.source === 'own' ? <button type="button" className="b-sc-exam-btn" onClick={() => remove(e)}>Remove</button> : null}
              </div>
            </section>
          );
        })}
      </div>
      {!exams.length ? (
        <div className="b-sc-empty">
          {sync.conn?.lectio ? 'No exams in your Lectio schedule. Add one below.' : 'No exams yet. Add one below, or connect Lectio and the exams in your schedule show here.'}
        </div>
      ) : null}

      <form className="b-sc-card b-sc-form" onSubmit={(ev) => { ev.preventDefault(); add(); }} aria-label="Add an exam">
        <span className="b-sc-h3">Add an exam</span>
        <div className="b-sc-fields">
          <input className="b-input" value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="Matematik A, skriftlig" aria-label="Exam" />
          <select className="b-input" value={kind} onChange={(ev) => setKind(ev.target.value as ExamKind)} aria-label="Kind">
            {EXAM_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          <input className="b-input" type="date" value={date} onChange={(ev) => setDate(ev.target.value)} aria-label="Date" />
          <input className="b-input" type="time" value={time} onChange={(ev) => setTime(ev.target.value)} aria-label="Time" />
        </div>
        <button type="submit" className="b-btn b-btn--primary b-btn--row" disabled={!title.trim() || fromInputs(date, time) === null}>Add exam</button>
      </form>

      <p className="b-sc-note b-sc-note--emphasis"><strong>Revision plan:</strong> Atlas spreads revision before an exam, weakest topic first, and puts the sessions in Study plan. Readiness is your own cards: the share of each linked deck scheduled a week or more out.</p>
    </div>
  );
}
