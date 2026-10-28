/**
 * Tutor — a Socratic tutor on the brain (`Atlas School Beta.dc.html`, the
 * "Tutor" tab).
 *
 * The student pastes the problem they are stuck on; every turn goes to the
 * brain through `askAtlas` with the preamble from `tutorPrompt`, which forbids
 * the answer and asks for one question or one hint. Hints come as the
 * explicit three-step ladder (nudge → the method → the first step set up),
 * one at a time. Threads are kept on this Mac so a problem can be picked up
 * again; nothing is sent anywhere except the turn being asked.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { nextHintLevel, shortDate, tutorPrompt, tutorTitle, uid, type TutorAsk, type TutorThread, type TutorTurn } from '@/lib/betaSchool';
import { updateSchool, useSchool } from '@/lib/betaSchoolStore';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { useAsk, type SchoolToast } from './useSchoolHooks';

function patchThread(id: string, fn: (t: TutorThread) => TutorThread) {
  updateSchool((s) => ({ ...s, tutor: s.tutor.map((t) => (t.id === id ? fn(t) : t)) }));
}

export function SchoolTutor({ onToast }: { onToast: SchoolToast }) {
  const school = useSchool();
  const threads = useMemo(() => [...school.tutor].sort((a, b) => b.updated - a.updated), [school.tutor]);
  const [activeId, setActiveId] = useState<string | null>(() => threads[0]?.id ?? null);
  const [problem, setProblem] = useState('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<{ role: 'tutor' | 'hint'; text: string } | null>(null);
  const atlas = useAsk();
  const scroller = useRef<HTMLDivElement | null>(null);

  const thread = activeId ? school.tutor.find((t) => t.id === activeId) ?? null : null;
  useEffect(() => { if (activeId && !thread) setActiveId(null); }, [activeId, thread]);

  const turnCount = thread?.turns.length ?? 0;
  const pendingText = pending?.text;
  // Follow the conversation as it grows, including while a reply streams in.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turnCount, pendingText, activeId]);

  // Each run gets a number, so a run that was stopped can never clear or
  // overwrite the bubble of the one that replaced it.
  const runSeq = useRef(0);

  /** Asks the brain for the tutor's next turn and saves it when it is complete. */
  const run = async (t: TutorThread, before: readonly TutorTurn[], ask: TutorAsk) => {
    const role = ask.kind === 'hint' ? 'hint' : 'tutor';
    const seq = ++runSeq.current;
    setPending({ role, text: '' });
    const text = await atlas.ask(tutorPrompt(t.problem, before, ask), (partial) => { if (seq === runSeq.current) setPending({ role, text: partial }); });
    if (seq === runSeq.current) setPending(null);
    if (text === null) return;
    patchThread(t.id, (x) => ({
      ...x,
      turns: [...x.turns, { role, text: text.trim(), at: Date.now() }],
      hints: ask.kind === 'hint' ? Math.max(x.hints, ask.level) : x.hints,
      updated: Date.now(),
    }));
  };

  const start = () => {
    const p = problem.trim();
    if (!p || atlas.busy) return;
    const now = Date.now();
    const t: TutorThread = { id: uid('tutor'), problem: p, turns: [], hints: 0, created: now, updated: now };
    updateSchool((s) => ({ ...s, tutor: [...s.tutor, t] }));
    setActiveId(t.id);
    setProblem('');
    void run(t, [], { kind: 'start' });
  };

  const send = () => {
    const text = draft.trim();
    if (!thread || !text || atlas.busy) return;
    const turn: TutorTurn = { role: 'student', text, at: Date.now() };
    const before = thread.turns;
    patchThread(thread.id, (x) => ({ ...x, turns: [...x.turns, turn], updated: turn.at }));
    setDraft('');
    void run(thread, before, { kind: 'reply', text });
  };

  const hint = (level: 1 | 2 | 3) => {
    if (!thread || atlas.busy) return;
    const next = nextHintLevel(thread);
    if (next === null || level < next) return;
    if (level > next) { onToast(`One hint at a time: hint ${next} first`); return; }
    void run(thread, thread.turns, { kind: 'hint', level });
  };

  // A reply that failed or was cut off (the student left the tab) can be asked again.
  const last = thread?.turns[thread.turns.length - 1];
  const retry = () => {
    if (!thread || atlas.busy) return;
    if (!last) { void run(thread, [], { kind: 'start' }); return; }
    if (last.role === 'student') void run(thread, thread.turns.slice(0, -1), { kind: 'reply', text: last.text });
  };
  const needsRetry = !!thread && !atlas.busy && !pending && (!last || last.role === 'student');

  /**
   * Moving to another problem stops the reply in flight: it belongs to the
   * thread it was asked for, and streaming it under a different problem would
   * read as that problem's answer. The student turn stays, so "Ask Atlas
   * again" picks it up when they come back.
   */
  const open = (id: string | null) => {
    if (id === activeId) return;
    if (atlas.busy) atlas.cancel();
    runSeq.current += 1;
    setPending(null);
    setActiveId(id);
  };

  const remove = (t: TutorThread) => {
    if (activeId === t.id) open(null);
    updateSchool((s) => ({ ...s, tutor: s.tutor.filter((x) => x.id !== t.id) }));
    onToast('Problem deleted', () => updateSchool((s) => ({ ...s, tutor: [...s.tutor, t] })));
  };

  const nextHint = thread ? nextHintLevel(thread) : null;
  let hintN = 0;

  return (
    <div className="b-sc-two">
      <section className="b-sc-tutor" aria-label="Tutor">
        {thread ? (
          <>
            <div className="b-sc-tutor-head">
              <span className="b-sc-label">Working on</span>
              <span className="b-sc-pill" title={thread.problem}><i />{tutorTitle(thread.problem)}</span>
            </div>
            <div ref={scroller} className="b-sc-msgs nosb" aria-live="polite">
              <div className="b-sc-msg b-sc-msg--problem">{thread.problem}</div>
              {thread.turns.map((t, i) => {
                if (t.role === 'hint') hintN += 1;
                return (
                  <div key={`${t.at}-${i}`} className={`b-sc-msg b-sc-msg--${t.role}`}>
                    {t.role === 'hint' ? <small>Hint {hintN}</small> : null}
                    {t.text}
                  </div>
                );
              })}
              {pending ? (
                <div className={`b-sc-msg b-sc-msg--${pending.role}`}>
                  {pending.role === 'hint' ? <small>Hint {hintN + 1}</small> : null}
                  {pending.text || <span className="b-sc-typing" aria-label="Atlas is thinking"><i /><i /><i /></span>}
                </div>
              ) : null}
              {needsRetry ? (
                <button type="button" className="b-btn b-btn--tinted b-btn--row b-sc-retry" onClick={retry}>Ask Atlas again</button>
              ) : null}
            </div>
            {atlas.error ? <p className="b-sc-err" role="alert">{atlas.error}</p> : null}
            <div className="b-sc-hints">
              {([1, 2, 3] as const).map((level) => {
                const taken = level <= thread.hints;
                return (
                  <button type="button" key={level} className={`b-sc-hint${taken ? ' taken' : ''}${nextHint === level ? ' next' : ''}`} disabled={taken || atlas.busy} title={taken ? `Hint ${level} taken` : nextHint === level ? `Ask for hint ${level} of 3` : `Hint ${nextHint ?? 3} comes first`} onClick={() => hint(level)}>
                    Hint {level}
                  </button>
                );
              })}
              <span className="b-sc-hints-note">{thread.hints >= 3 ? 'All three hints used. The rest is yours.' : 'A nudge, then the method, then the first step set up.'}</span>
            </div>
            <div className="b-sc-ask">
              <input value={draft} placeholder="Write what you think, even if you are unsure" aria-label="Your reply" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
              {atlas.busy ? (
                <button type="button" className="b-sc-ask-send" aria-label="Stop" onClick={atlas.cancel}><AtlasIcon name="close" size={16} /></button>
              ) : (
                <button type="button" className="b-sc-ask-send" aria-label="Send" disabled={!draft.trim()} onClick={send}><AtlasIcon name="send" size={16} /></button>
              )}
            </div>
          </>
        ) : (
          <div className="b-sc-tutor-start">
            <span className="b-sc-h2">What are you working on?</span>
            <p className="b-sc-muted">Paste the problem or the question, as your teacher wrote it. Atlas asks you questions and gives hints; it does not solve it for you.</p>
            <textarea className="b-input b-sc-problem" value={problem} placeholder="For example: Find f′(x) for f(x) = x² · ln(x)." aria-label="The problem" onChange={(e) => setProblem(e.target.value)} />
            <button type="button" className="b-btn b-btn--primary" disabled={!problem.trim() || atlas.busy} onClick={start}>Start with Atlas</button>
            {atlas.error ? <p className="b-sc-err" role="alert">{atlas.error}</p> : null}
          </div>
        )}
      </section>

      <section className="b-sc-side" aria-label="About the tutor">
        <div className="b-sc-note b-sc-note--ink">
          <b>Atlas is your tutor, not your ghostwriter</b>
          <span>It asks questions and gives hints in three steps. It never writes your answer; ask it to and you get the next hint instead.</span>
        </div>
        <div className="b-sc-list">
          <div className="b-sc-list-head">
            <span className="b-sc-label">Your problems</span>
            {thread ? <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => open(null)}>New problem</button> : null}
          </div>
          {threads.map((t) => (
            <div key={t.id} className={`b-sc-list-row${t.id === activeId ? ' on' : ''}`}>
              <button type="button" className="b-sc-list-main" onClick={() => open(t.id)}>
                <b>{tutorTitle(t.problem)}</b>
                <span>{t.turns.filter((x) => x.role === 'student').length} replies · {t.hints} of 3 hints · {shortDate(t.updated)}</span>
              </button>
              <button type="button" className="b-sc-x" aria-label={`Delete ${tutorTitle(t.problem)}`} onClick={() => remove(t)}>×</button>
            </div>
          ))}
          {!threads.length ? <div className="b-sc-empty">Problems you work through appear here, so you can pick them up again.</div> : null}
        </div>
      </section>
    </div>
  );
}
