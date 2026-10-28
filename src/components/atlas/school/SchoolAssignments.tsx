/**
 * Assignments, and "Prepared by Atlas" (`Atlas School Beta.dc.html`,
 * "Afleveringer" and the assignment view).
 *
 * The list is LearnIT's assignments and the student's own deadlines from
 * Study plan, grouped by week (betaSchoolWork.ts). An assignment opens as
 * `#assignments/<key>`, so Back closes it.
 *
 * Prepare is the student's to press, never automatic. Atlas then:
 *   1. breaks the brief into the steps the student will do (prepPrompt — it
 *      lays the work out and never does any of it);
 *   2. spreads study sessions before the due date, named for those steps
 *      (spreadSessions, the same planner Study plan uses);
 *   3. drafts cards from the attached material Atlas can read as text.
 * All of it is a draft until the student keeps it: nothing reaches Study plan
 * or Cards before "Keep this plan", and Undo takes it back out.
 *
 * What leaves the Mac: the brief and the readable material, to the brain,
 * when the student presses Prepare.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DAY, dueIn, dueLabel, hhmm, parseCardDrafts, cardsPrompt, shortDate, spreadSessions, uid,
  type Deadline, type Prepared, type SchoolState, type Session,
} from '@/lib/betaSchool';
import { PREP_TEXT_MAX, nameSessions, parseSteps, prepPrompt, stepProgress } from '@/lib/betaSchoolAtlas';
import { assignmentGroup, isReadable, type AssignmentGroup } from '@/lib/betaSchoolMoodle';
import { getSchool, updateSchool, useSchool } from '@/lib/betaSchoolStore';
import { readMoodleText, useSchoolSync } from '@/lib/betaSchoolSync';
import { deadlineFor, filterWork, unseenKeys, type WorkFilter, type WorkItem } from '@/lib/betaSchoolWork';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import { keepCards, withSubject } from './schoolActions';
import { SyncLine } from './SchoolBits';
import { useWork } from './useSchoolWork';
import { useAsk, type SchoolToast } from './useSchoolHooks';
import type { SchoolTab } from './schoolTabs';

const GROUPS: readonly { key: AssignmentGroup; label: string }[] = [
  { key: 'past', label: 'Past the due date' },
  { key: 'week', label: 'This week' },
  { key: 'next', label: 'Next week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No due date' },
];

const FILTERS: readonly { key: WorkFilter; label: string }[] = [
  { key: 'open', label: 'To do' },
  { key: 'done', label: 'Handed in' },
  { key: 'all', label: 'All' },
];

export function WorkRow({ item, now, onOpen }: { item: WorkItem; now: number; onOpen: (key: string) => void }) {
  const late = item.due !== null && item.due < now && !item.done;
  const near = !late && item.due !== null && item.due - now < 2 * DAY;
  const p = item.prepared ? stepProgress(item.prepared.steps) : null;
  const tag = item.done ? 'Handed in' : item.prepared ? `Prepared · ${p?.done ?? 0}/${p?.total ?? 0}` : item.fresh ? 'New' : late ? 'Overdue' : item.due !== null ? dueIn(item.due, now) : 'Open';
  const tone = item.done ? 'done' : item.prepared || item.fresh ? 'near' : late ? 'late' : near ? 'near' : '';
  return (
    <button type="button" className="b-sc-duerow" onClick={() => onOpen(item.key)}>
      <i style={{ background: item.colour }} />
      <span><b>{item.title}</b><span>{[item.course, item.source === 'moodle' ? 'LearnIT' : 'Your deadline'].filter(Boolean).join(' · ')}</span></span>
      {item.due !== null ? <span className={`b-sc-duerow-when b-num${near || late ? ' near' : ''}`}>{dueLabel(item.due, now)}</span> : null}
      <span className={`b-sc-tag ${tone}`}>{tag}</span>
    </button>
  );
}

export function SchoolAssignments({ now, openKey, onOpen, onTab, onToast }: {
  now: number;
  openKey: string | null;
  onOpen: (key: string | null) => void;
  onTab: (t: SchoolTab) => void;
  onToast: SchoolToast;
}) {
  const sync = useSchoolSync();
  const items = useWork();
  const [filter, setFilter] = useState<WorkFilter>('open');
  const open = openKey ? items.find((i) => i.key === openKey) ?? null : null;

  // What was new when the list was opened stays marked "New" until the student leaves it.
  const fresh = useMemo(() => unseenKeys(items), [items]);
  useEffect(() => () => {
    if (!fresh.length) return;
    updateSchool((s) => ({ ...s, seen: [...s.seen, ...fresh.filter((k) => !s.seen.includes(k))].slice(-2000) }));
  }, [fresh]);

  if (openKey) {
    if (!open) {
      return (
        <section className="b-sc-card b-sc-needs">
          <span className="b-sc-h3">This assignment is not here any more</span>
          <p className="b-sc-muted">It may have been removed on LearnIT, or LearnIT was disconnected.</p>
          <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => onOpen(null)}>All assignments</button>
        </section>
      );
    }
    return <AssignmentDetail key={open.key} item={open} now={now} onBack={() => onOpen(null)} onToast={onToast} />;
  }

  const shown = filterWork(items, filter);
  const moodleOn = !!sync.conn?.moodle.connected;
  return (
    <div className="b-sc-assign">
      <div className="b-sc-sched-bar">
        <div className="b-sc-seg" role="tablist" aria-label="Filter">
          {FILTERS.map((f) => (
            <button type="button" role="tab" key={f.key} aria-selected={filter === f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
        {!moodleOn ? (
          <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => onTab('school')}>Connect LearnIT for your assignments</button>
        ) : null}
      </div>
      {GROUPS.map((g) => {
        const rows = shown.filter((i) => assignmentGroup(i.due, now) === g.key);
        if (!rows.length) return null;
        return (
          <section key={g.key} className="b-sc-card" aria-label={g.label}>
            <span className="b-sc-group">{g.label}</span>
            {rows.map((i) => <WorkRow key={i.key} item={i} now={now} onOpen={onOpen} />)}
          </section>
        );
      })}
      {!shown.length ? (
        <div className="b-sc-empty">
          {filter === 'done' ? 'Nothing handed in yet.' : moodleOn ? 'Nothing to do. LearnIT has no open assignments for you, and you have no deadlines in Study plan.' : 'No assignments yet. Connect LearnIT, or add a deadline in Study plan.'}
        </div>
      ) : null}
      {moodleOn ? <SyncLine which="moodle" /> : null}
    </div>
  );
}

// ── One assignment ───────────────────────────────────────────────────────────

interface PrepDraft {
  steps: string[];
  sessions: Session[];
  /** The Study plan deadline the sessions belong to: the student's own, or a new one for a LearnIT assignment. */
  deadline: Deadline | null;
  newDeadline: boolean;
  cards: { id: string; front: string; back: string; keep: boolean }[];
  /** Why there are no card drafts, when there are none. */
  cardsNote: string;
}

type Phase = null | 'steps' | 'material' | 'cards';
const PHASE_LINE: Record<Exclude<Phase, null>, [string, number]> = {
  steps: ['Laying out the steps', 0.3],
  material: ['Reading the attached material', 0.6],
  cards: ['Drafting cards from it', 0.85],
};

const MAX_FILES = 3;

function AssignmentDetail({ item, now, onBack, onToast }: { item: WorkItem; now: number; onBack: () => void; onToast: SchoolToast }) {
  const school = useSchool();
  const atlas = useAsk();
  const [pasted, setPasted] = useState('');
  const [phase, setPhase] = useState<Phase>(null);
  const [draft, setDraft] = useState<PrepDraft | null>(null);
  // Each Prepare gets a number; Stop moves it on, so a run that was stopped
  // between its steps (reading a file is not abortable) drops what it finds.
  const run = useRef(0);
  const brief = (item.text || pasted).trim();
  const readable = item.attachments.filter((f) => isReadable(f.mime));

  const prepare = async () => {
    if (!brief || atlas.busy) return;
    const id = ++run.current;
    const live = () => run.current === id;
    setDraft(null);
    setPhase('steps');
    const answer = await atlas.ask(prepPrompt({ title: item.title, course: item.course, due: item.due, text: brief.slice(0, PREP_TEXT_MAX) }, Date.now()));
    if (!live()) return;
    if (answer === null) { setPhase(null); return; }
    const steps = parseSteps(answer);
    if (!steps.length) { setPhase(null); onToast('Atlas answered, but not as steps. Try Prepare again.'); return; }

    // Sessions before the due date, around what is already planned.
    const state = getSchool();
    const own = item.deadlineId ? state.deadlines.find((d) => d.id === item.deadlineId) ?? null : null;
    const deadline = own ?? deadlineFor(item, null, uid('dl'));
    const sessions = deadline ? nameSessions(spreadSessions(deadline, state.sessions, Date.now(), { count: Math.min(3, steps.length) }), steps, item.title) : [];

    // Cards, only from material Atlas can read as text.
    let cards: PrepDraft['cards'] = [];
    let cardsNote = '';
    if (!readable.length) {
      cardsNote = item.attachments.length
        ? 'The attached files are not text Atlas can read (PDFs, slides and images are not). Make cards from your notes in Cards.'
        : 'No material is attached, so there are no cards to draft. Make cards from your notes in Cards.';
    } else {
      setPhase('material');
      const texts: string[] = [];
      for (const f of readable.slice(0, MAX_FILES)) {
        const r = await readMoodleText(f.url);
        if (!live()) return;
        if ('text' in r) texts.push(`${f.name}\n${r.text}`);
      }
      if (!texts.length) {
        cardsNote = 'Atlas could not read the attached material just now.';
      } else {
        setPhase('cards');
        const cardText = await atlas.ask(cardsPrompt(texts.join('\n\n').slice(0, PREP_TEXT_MAX)));
        if (!live()) return;
        cards = cardText ? parseCardDrafts(cardText).map((c) => ({ ...c, id: uid('draft'), keep: true })) : [];
        if (!cards.length) cardsNote = 'Atlas read the material but drafted no cards from it.';
      }
    }
    setPhase(null);
    setDraft({ steps, sessions, deadline, newDeadline: !own && !!deadline, cards, cardsNote });
  };

  const keep = () => {
    if (!draft) return;
    const before: Pick<SchoolState, 'subjects' | 'deadlines' | 'sessions' | 'prepared' | 'seen'> = getSchool();
    let subjectId: string | null = draft.deadline?.subjectId ?? null;
    updateSchool((s) => {
      let next = s;
      if (draft.newDeadline && item.course) {
        const [s2, id] = withSubject(s, item.course);
        next = s2;
        subjectId = id;
      }
      const deadlines = draft.newDeadline && draft.deadline ? [...next.deadlines, { ...draft.deadline, subjectId }] : next.deadlines;
      const sessions = [...next.sessions, ...draft.sessions.map((x) => ({ ...x, subjectId }))];
      return { ...next, deadlines, sessions };
    });
    const kept = draft.cards.filter((c) => c.keep);
    const cardsKept = kept.length ? keepCards(item.course || item.title, kept) : null;
    const entry: Prepared = {
      id: item.key, title: item.title, course: item.course, due: item.due,
      steps: draft.steps.map((text) => ({ text, done: false })),
      deadlineId: draft.deadline?.id ?? null, deckId: cardsKept?.deckId ?? null, at: Date.now(),
    };
    updateSchool((s) => ({
      ...s,
      prepared: [...s.prepared.filter((p) => p.id !== item.key), entry],
      seen: s.seen.includes(item.key) ? s.seen : [...s.seen, item.key],
    }));
    setDraft(null);
    const parts = [`${draft.steps.length} steps`, draft.sessions.length ? `${draft.sessions.length} sessions in Study plan` : '', kept.length ? `${kept.length} cards` : ''].filter(Boolean);
    onToast(`Kept: ${parts.join(', ')}`, () => {
      cardsKept?.undo();
      updateSchool((s) => ({ ...s, subjects: before.subjects, deadlines: before.deadlines, sessions: before.sessions, prepared: before.prepared, seen: before.seen }));
    });
  };

  const prepared = item.prepared;
  const toggleStep = (i: number) => updateSchool((s) => ({
    ...s,
    prepared: s.prepared.map((p) => (p.id === item.key ? { ...p, steps: p.steps.map((x, j) => (j === i ? { ...x, done: !x.done } : x)) } : p)),
  }));

  const toggleDone = () => {
    if (item.source === 'own' && item.deadlineId) {
      const id = item.deadlineId;
      updateSchool((s) => ({ ...s, deadlines: s.deadlines.map((d) => (d.id === id ? { ...d, done: !d.done } : d)) }));
    } else {
      updateSchool((s) => ({ ...s, handedIn: s.handedIn.includes(item.key) ? s.handedIn.filter((k) => k !== item.key) : [...s.handedIn, item.key] }));
    }
  };

  const unprepare = () => {
    if (!prepared) return;
    const before = { prepared: school.prepared, sessions: school.sessions };
    const id = prepared.deadlineId;
    updateSchool((s) => ({
      ...s,
      prepared: s.prepared.filter((p) => p.id !== item.key),
      sessions: id ? s.sessions.filter((x) => x.deadlineId !== id || x.done) : s.sessions,
    }));
    onToast('Plan removed, with its sessions that were not done', () => updateSchool((s) => ({ ...s, ...before })));
  };

  const progress = prepared ? stepProgress(prepared.steps) : null;
  const [phaseLine, phasePct] = phase ? PHASE_LINE[phase] : ['', 0];

  return (
    <div className="b-sc-adetail">
      <section className="b-sc-card b-sc-ahead" aria-label={item.title}>
        <button type="button" className="b-btn b-btn--ghost b-btn--row b-sc-back" onClick={onBack}>‹ All assignments</button>
        <span className="b-sc-ahead-course"><i style={{ background: item.colour }} />{item.course || (item.source === 'own' ? 'Your deadline' : 'LearnIT')}</span>
        <span className="b-sc-h2">{item.title}</span>
        <span className="b-sc-muted">
          {item.due !== null ? `Due ${dueLabel(item.due, now)} · ${item.due < now ? 'past the due date' : dueIn(item.due, now)}` : 'No due date'}
          {item.done ? ' · handed in' : ''}
        </span>
        <div className="b-sc-row-actions">
          <button type="button" className={`b-sc-check${item.done ? ' on' : ''}`} aria-pressed={item.done} onClick={toggleDone}>{item.done ? 'Handed in' : 'Mark handed in'}</button>
          {item.url ? <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void openExternal(item.url)}>Open on LearnIT</button> : null}
        </div>
        {item.source === 'moodle' ? <p className="b-sc-muted">“Handed in” is your own mark: Atlas reads LearnIT and never hands anything in.</p> : null}
      </section>

      {phase ? (
        <div className="b-sc-prepping" role="status">
          <span className="b-sc-prepping-dot" />
          <span>
            <b>{phaseLine}…</b>
            <span className="b-sc-bar"><span style={{ width: `${Math.round(phasePct * 100)}%` }} /></span>
          </span>
          <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => { run.current += 1; atlas.cancel(); setPhase(null); }}>Stop</button>
        </div>
      ) : null}
      {atlas.error ? <p className="b-sc-err" role="alert">{atlas.error}</p> : null}

      <div className="b-sc-two">
        <div className="b-sc-stack">
          {prepared && !draft ? (
            <section className="b-sc-card" aria-label="Prepared by Atlas">
              <div className="b-sc-panel-head">
                <span className="b-sc-h3">Prepared by Atlas</span>
                <span className="b-sc-muted">{shortDate(prepared.at)} · {hhmm(prepared.at)}</span>
              </div>
              {progress && progress.total ? (
                <div className="b-sc-progress"><span className="b-sc-bar"><span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} /></span><span className="b-num">{progress.done} of {progress.total} steps</span></div>
              ) : null}
              {prepared.steps.map((s, i) => (
                <button type="button" key={i} className={`b-sc-step-row${s.done ? ' done' : ''}`} aria-pressed={s.done} onClick={() => toggleStep(i)}>
                  <span className="b-sc-step-n b-num">{s.done ? '✓' : i + 1}</span><span>{s.text}</span>
                </button>
              ))}
              <p className="b-sc-muted">The steps are the work laid out, not the work. Every answer is yours.</p>
              <div className="b-sc-row-actions">
                <button type="button" className="b-btn b-btn--card b-btn--row" disabled={!brief || atlas.busy} onClick={() => void prepare()}>Prepare again</button>
                <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={unprepare}>Remove plan</button>
              </div>
            </section>
          ) : null}

          {draft ? (
            <section className="b-sc-card b-sc-prepdraft" aria-label="Atlas’s draft plan">
              <span className="b-sc-label">A draft · nothing is kept until you keep it</span>
              <span className="b-sc-h3">Steps</span>
              {draft.steps.map((s, i) => (
                <div key={i} className="b-sc-step-row">
                  <span className="b-sc-step-n b-num">{i + 1}</span><span>{s}</span>
                  <button type="button" className="b-sc-x" aria-label={`Drop step ${i + 1}`} onClick={() => setDraft((d) => (d ? { ...d, steps: d.steps.filter((_, j) => j !== i) } : d))}>×</button>
                </div>
              ))}
              <span className="b-sc-h3">Sessions in Study plan</span>
              {draft.sessions.map((s) => (
                <div key={s.id} className="b-sc-step-row">
                  <span className="b-sc-step-n b-num">{hhmm(s.start)}</span><span>{shortDate(s.start)} · {s.minutes} min · {s.title}</span>
                  <button type="button" className="b-sc-x" aria-label="Drop this session" onClick={() => setDraft((d) => (d ? { ...d, sessions: d.sessions.filter((x) => x.id !== s.id) } : d))}>×</button>
                </div>
              ))}
              {!draft.sessions.length ? <p className="b-sc-muted">{item.due === null ? 'No due date, so no sessions are planned.' : 'There is no free day left before the due date to plan a session on.'}</p> : null}
              <span className="b-sc-h3">Cards</span>
              {draft.cards.map((c) => (
                <label key={c.id} className="b-sc-draft">
                  <span><b>{c.front}</b><span>{c.back}</span></span>
                  <input type="checkbox" checked={c.keep} aria-label="Keep this card" onChange={() => setDraft((d) => (d ? { ...d, cards: d.cards.map((x) => (x.id === c.id ? { ...x, keep: !x.keep } : x)) } : d))} />
                </label>
              ))}
              {draft.cardsNote ? <p className="b-sc-muted">{draft.cardsNote}</p> : null}
              <div className="b-sc-row-actions">
                <button type="button" className="b-btn b-btn--primary b-btn--row" disabled={!draft.steps.length} onClick={keep}>Keep this plan</button>
                <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setDraft(null)}>Discard</button>
              </div>
            </section>
          ) : null}

          {!prepared && !draft && !phase ? (
            <section className="b-sc-card b-sc-prepcta" aria-label="Prepare">
              <span className="b-sc-h3">Let Atlas prepare it</span>
              <p className="b-sc-muted">Atlas breaks the brief into steps you will do, plans sessions before the due date, and drafts cards from material it can read. You keep what you want. It never writes your answer.</p>
              {!item.text ? (
                <textarea className="b-input" value={pasted} placeholder="Paste the assignment text here…" aria-label="The assignment text" onChange={(e) => setPasted(e.target.value)} />
              ) : null}
              <button type="button" className="b-btn b-btn--primary b-btn--row" disabled={!brief || atlas.busy} onClick={() => void prepare()}>Prepare</button>
              <p className="b-sc-leaves">Sent to Atlas when you press Prepare: the brief{readable.length ? ' and the attached text files' : ''}.</p>
            </section>
          ) : null}
        </div>

        <div className="b-sc-stack">
          {item.text ? (
            <section className="b-sc-card" aria-label="The brief">
              <span className="b-sc-h3">The brief</span>
              <p className="b-sc-brief">{item.text}</p>
            </section>
          ) : null}
          {item.attachments.length ? (
            <section className="b-sc-card" aria-label="Attached">
              <span className="b-sc-h3">Attached</span>
              {item.attachments.map((f) => (
                <div key={f.url} className="b-sc-file">
                  <b>{f.name}</b>
                  <span>{isReadable(f.mime) ? 'Text Atlas can read' : 'Atlas cannot read this file'}</span>
                </div>
              ))}
              {item.url ? <p className="b-sc-muted">Open the files on LearnIT.</p> : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
