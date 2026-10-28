/**
 * Tasks — the ring of what is done, the list to tick, re-prioritise, re-date
 * and remove, the line to add one, and the tasks Atlas can be asked to take.
 *
 * `useTasks` throughout: the tick is `toggleTask`, the priority pill cycles
 * through `updateTask`, the date field writes `due_date`, × is `deleteTask`
 * (armed by the first tap, done by the second — a task does not come back),
 * Add is `addTask`. "Let Atlas do it" opens the Talk panel with the task as
 * the question (`openTalk`) — a real hand-off — and the hand-off is
 * remembered on this Mac (`delegated_at` in `atlas_item_notes`), so the
 * "Atlas is on it" badge is still there after a reload. "Research" (row 10)
 * asks the brain for a short note from the task's own title, due date and
 * priority (`researchQuestion`) and saves it with the task; that note is
 * the design's "what Atlas found" line, written only once Atlas has looked.
 */
import { useEffect, useState } from 'react';
import { useTasks, type Task } from '@/hooks/useTasks';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import type { RGB } from '@/lib/quickSphere';
import { openTalk } from '@/lib/talkBus';
import {
  delegable, dueInputValue, dueLabel, nextPriority, orderTasks, priorityTone, priorityWord, ringOffset, taskHeadline, taskSub,
} from '@/lib/betaViews';
import { useTick } from './useTick';
import { escapeBlurs } from './fieldKeys';
import { AtlasNote } from './AtlasNote';
import { useItemNotes } from '@/hooks/useItemNotes';
import { researchQuestion } from '@/lib/betaViews';

/** The ring's circumference (r 48, as the design). */
const RING_C = 2 * Math.PI * 48;
/** The panel paper the ring's sphere sits on. */
const PANEL: RGB = [241, 238, 234];

export function TasksView() {
  const { tasks, completedCount, toggleTask, addTask, updateTask, deleteTask, isLoading, error } = useTasks();
  const now = useTick(60000);
  const [draft, setDraft] = useState('');
  const notes = useItemNotes('task');
  const [armed, setArmed] = useState<string | null>(null);

  // An armed delete disarms itself if the second tap does not come.
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const ordered = orderTasks(tasks);
  const give = delegable(tasks);
  const open = tasks.length - completedCount;
  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    void addTask(title);
  };
  const delegate = (t: Task) => {
    openTalk(`Help me with: ${t.title}`);
    void notes.save(t.id, { delegated_at: new Date().toISOString() });
  };
  const setDue = (t: Task, value: string) => {
    // The date field gives a calendar day; the task is due at nine that morning.
    void updateTask(t.id, { due_date: value ? new Date(`${value}T09:00:00`).toISOString() : null });
  };
  const remove = (t: Task) => {
    if (armed !== t.id) { setArmed(t.id); return; }
    setArmed(null);
    void deleteTask(t.id);
  };

  return (
    <div className="b-wv-two b-wv-two--start">
      <section className="b-wv-tasks" aria-label="Tasks">
        <div className="b-wv-tasks-head">
          <div className="b-wv-ring">
            <svg viewBox="0 0 110 110" aria-hidden>
              <circle cx="55" cy="55" r="48" fill="none" stroke="var(--b-card)" strokeWidth="9" />
              <circle cx="55" cy="55" r="48" fill="none" stroke="var(--b-blue)" strokeWidth="9" strokeLinecap="round" strokeDasharray={RING_C.toFixed(1)} strokeDashoffset={ringOffset(RING_C, tasks.length ? completedCount / tasks.length : 0)} />
            </svg>
            <div className="b-wv-ring-sphere"><VeilSphere size="mini" count={2500} bg="transparent" tone={PANEL} /></div>
          </div>
          <div className="b-wv-tasks-title">
            <span className="b-wv-eyebrow">Tasks · {open} open</span>
            <span className="b-wv-h1">{isLoading && !tasks.length ? 'Reading…' : taskHeadline(completedCount, tasks.length)}</span>
            <span className="b-wv-sub">{taskSub(tasks, now)}</span>
          </div>
        </div>

        {ordered.map((t) => {
          const done = !!t.completed;
          const arm = armed === t.id;
          return (
            <div key={t.id} className={`b-wv-task${done ? ' done' : ''}`}>
              <button type="button" role="checkbox" aria-checked={done} aria-label={t.title} className={`b-wv-check${done ? ' on' : ''}`} onClick={() => void toggleTask(t.id)}>
                {done ? <AtlasIcon name="check" size={14} weight={2.4} /> : null}
              </button>
              <span className="b-wv-task-main">
                <span className="b-wv-task-t">{t.title}</span>
                <span className="b-wv-task-due">
                  <span>{dueLabel(t.due_date, now)}</span>
                  <input type="date" className="b-wv-date" value={dueInputValue(t.due_date)} aria-label={`Due date for ${t.title}`} title="Change the due date" onChange={(e) => setDue(t, e.target.value)} onKeyDown={escapeBlurs} />
                </span>
              </span>
              <button type="button" className={`b-wv-pill b-wv-pill--${priorityTone(t.priority)}`} title="Change the priority" aria-label={`Priority ${priorityWord(t.priority)} — change`} onClick={() => void updateTask(t.id, { priority: nextPriority(t.priority) })}>{priorityWord(t.priority)}</button>
              <button type="button" className={`b-wv-x${arm ? ' arm' : ''}`} aria-label={arm ? `Really delete ${t.title}?` : `Delete ${t.title}`} title={arm ? 'Tap again to delete' : 'Delete'} onClick={() => remove(t)}>
                {arm ? 'Delete?' : <AtlasIcon name="close" size={14} />}
              </button>
            </div>
          );
        })}
        {!tasks.length && !isLoading ? <div className="b-wv-empty">Nothing on the list. Add a task below.</div> : null}

        <div className="b-wv-add">
          <input
            className="b-wv-add-in"
            placeholder="Add a task, or say it to Atlas"
            aria-label="New task"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); else escapeBlurs(e); }}
          />
          <button type="button" className="b-wv-add-btn" onClick={submit} disabled={!draft.trim()}>Add</button>
        </div>
        {error ? <p className="b-wv-err">{error}</p> : null}
      </section>

      <aside className="b-wv-take" aria-label="Delegate to Atlas">
        <span className="b-wv-take-t">Atlas can take these</span>
        {give.map((t) => (
          <div key={t.id} className="b-wv-take-card">
            <span className="b-wv-take-card-t">{t.title}</span>
            <span className="b-wv-take-card-d">{dueLabel(t.due_date, now)} · {priorityWord(t.priority)} priority</span>
            <button type="button" className={`b-wv-take-btn${notes.notes[t.id]?.delegated_at ? ' on' : ''}`} onClick={() => delegate(t)}>
              {notes.notes[t.id]?.delegated_at ? 'Atlas is on it · ask again' : 'Let Atlas do it'}
            </button>
            <AtlasNote
              itemId={t.id}
              verb="Researched"
              action="Research"
              note={notes.notes[t.id]}
              asking={notes.asking}
              now={now}
              onAsk={() => void notes.ask(t.id, researchQuestion(t, now), 'tasks')}
              onCancel={notes.cancel}
              onForget={() => void notes.clear(t.id)}
            />
          </div>
        ))}
        {!give.length ? <div className="b-wv-take-empty">Nothing open. Add a task and Atlas can take it.</div> : null}
        {give.length ? <span className="b-wv-free-note">Research sends the task’s title, due date and priority to the AI provider Atlas uses; the note stays on this Mac.</span> : null}
      </aside>
    </div>
  );
}
