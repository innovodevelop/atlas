/**
 * Focus — a 25 or 50 minute session during which Atlas holds its own
 * notifications (Beta row 12, `Atlas Widget Screens Beta.dc.html` #focus:
 * the ink hero, the ring with the sphere and the clock, Start / Pause /
 * Resume beside the lengths, three figures under it).
 *
 * The session lives in the focus gate (src/lib/focusGate.ts), so it keeps
 * running on any screen and ends on time wherever the user is. While it runs,
 * Atlas's own notifiers ask the gate first and stay quiet (alarms and
 * approvals still come through); when it ends this screen says what was held.
 * The design's 90-minute length is left out: the task fixes 25 and 50.
 *
 * The optional macOS Focus: an app cannot switch a system Focus itself, but
 * the user's own Shortcut can. Name one for the start and one for the end and
 * the gate runs them through Apple's `shortcuts` tool (focus_mode.rs). Nothing
 * about a session leaves the Mac.
 */
import { useEffect, useState } from 'react';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { useTasks } from '@/hooks/useTasks';
import {
  FOCUS_LENGTHS, checkShortcutName, dayStats, fmtClock, fmtFocusMinutes, heldBySource, heldLabel, isRunning, leftMs, progress,
} from '@/lib/betaFocus';
import {
  dismissFocusSummary, endFocus, listShortcuts, pauseFocus, resumeFocus, setFocusLength, setFocusShortcut, startFocus, useFocus,
} from '@/lib/focusGate';
import { escapeBlurs } from './fieldKeys';
import { useTick } from './useTick';

/** The ring's circumference (r 196, as the design). */
const RING_C = 2 * Math.PI * 196;

export function FocusView() {
  const focus = useFocus();
  const s = focus.session;
  const running = isRunning(s);
  const now = useTick(1000, running);
  const { tasks } = useTasks();
  const open = tasks.filter((t) => !t.completed);
  const [task, setTask] = useState('');
  const today = dayStats(focus.log, now);
  const left = s ? leftMs(s, now) : focus.prefs.lengthMin * 60000;
  const frac = s ? progress(s, now) : 0;

  const primary = () => {
    if (!s) startFocus(task || null);
    else if (running) pauseFocus();
    else resumeFocus();
  };
  const label = !s ? 'Start' : running ? 'Pause' : 'Resume';

  return (
    <>
      <section className="b-wv-focus" aria-label="Focus">
        <span className="b-wv-eyebrow b-wv-eyebrow--onink">
          Focus{s?.task ? ` · ${s.task}` : ''}{s ? ` · ${running ? 'holding notifications' : 'paused'}` : ''}
        </span>
        <div className="b-wv-focus-ring">
          <svg viewBox="0 0 420 420" aria-hidden>
            <circle cx="210" cy="210" r="196" fill="none" stroke="rgba(249,247,244,.08)" strokeWidth="10" />
            <circle cx="210" cy="210" r="196" fill="none" stroke="#8fa9ff" strokeWidth="10" strokeLinecap="round" strokeDasharray={RING_C.toFixed(1)} strokeDashoffset={(RING_C * (1 - frac)).toFixed(1)} />
          </svg>
          <div className="b-wv-focus-sphere"><VeilSphere size="panel" ink bg="#1e1e24" state={running ? 'working' : 'idle'} /></div>
          <span className="b-wv-focus-clock b-num" role="timer" aria-label={`${fmtClock(left)} left`}>{fmtClock(left)}</span>
        </div>

        {!s ? (
          <label className="b-wv-focus-task">
            <span>For</span>
            <select value={task} onChange={(e) => setTask(e.target.value)} onKeyDown={escapeBlurs} aria-label="The task this session is for">
              <option value="">No particular task</option>
              {open.map((t) => <option key={t.id} value={t.title}>{t.title}</option>)}
            </select>
          </label>
        ) : null}

        <div className="b-wv-focus-actions">
          <button type="button" className="b-wv-focus-go" onClick={primary}>{label}</button>
          {s ? (
            <button type="button" className="b-wv-focus-len" onClick={endFocus}>End now</button>
          ) : (
            FOCUS_LENGTHS.map((m) => (
              <button key={m} type="button" className={`b-wv-focus-len${focus.prefs.lengthMin === m ? ' on' : ''}`} aria-pressed={focus.prefs.lengthMin === m} onClick={() => setFocusLength(m)}>{m} min</button>
            ))
          )}
        </div>

        <div className="b-wv-focus-stats">
          <div><span>Today</span><b>{fmtFocusMinutes(today.minutes)}</b></div>
          <div><span>Held for you</span><b>{s ? s.held.length : today.held}</b></div>
          <div><span>Longest run</span><b>{today.longest ? `${today.longest} min` : '—'}</b></div>
        </div>
        {focus.busy ? <span className="b-wv-focus-note">Running your Shortcut…</span> : null}
        {focus.notice ? <span className="b-wv-focus-note b-wv-focus-note--err">{focus.notice}</span> : null}
      </section>

      <div className="b-wv-two b-wv-two--start">
        <FocusHeld />
        <FocusShortcuts />
      </div>
    </>
  );
}

/** What the running session is holding, or what the last one held once it ended. */
function FocusHeld() {
  const focus = useFocus();
  const s = focus.session;
  const ended = focus.ended;
  const held = s ? s.held : ended?.held ?? [];
  const title = s
    ? heldLabel(held.length)
    : ended
      ? `${ended.entry.completed ? 'Done' : 'Ended'} · ${ended.entry.minutes} min · ${heldLabel(held.length).toLowerCase()}`
      : 'Nothing held yet';
  return (
    <section className="b-wv-take b-wv-take--paper" aria-label="Held notifications">
      <span className="b-wv-take-t">{title}</span>
      {held.length ? <span className="b-wv-take-card-d">{heldBySource(held)}</span> : null}
      {held.slice().reverse().map((h) => (
        <div key={`${h.at}-${h.title}`} className="b-wv-take-card">
          <span className="b-wv-take-card-d">{h.source} · {new Date(h.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
          <span className="b-wv-take-card-t">{h.title}</span>
          {h.body ? <span className="b-wv-take-card-d">{h.body}</span> : null}
        </div>
      ))}
      {!held.length ? (
        <div className="b-wv-take-empty">
          {s ? 'Atlas holds its own notifications until the session ends. Alarms and approvals still come through.' : 'Start a session and anything Atlas would have notified you about waits here.'}
        </div>
      ) : null}
      {!s && ended ? <button type="button" className="b-wv-take-btn" onClick={dismissFocusSummary}>Clear</button> : null}
    </section>
  );
}

/** The optional system Focus: a Shortcut to run at the start and one at the end. */
function FocusShortcuts() {
  const focus = useFocus();
  const [names, setNames] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ start: focus.prefs.startShortcut, end: focus.prefs.endShortcut });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setDraft({ start: focus.prefs.startShortcut, end: focus.prefs.endShortcut }); }, [focus.prefs.startShortcut, focus.prefs.endShortcut]);

  const load = async () => {
    setListError(null);
    try { setNames(await listShortcuts()); } catch (e) { setListError(e instanceof Error ? e.message : String(e)); }
  };
  const save = (which: 'start' | 'end') => {
    const check = checkShortcutName(draft[which]);
    if ('reason' in check) { setErr(check.reason); return; }
    setErr(null);
    setFocusShortcut(which, check.name);
  };
  const field = (which: 'start' | 'end', label: string) => (
    <label className="b-wv-focus-sc">
      <span className="b-wv-take-card-d">{label}</span>
      <input
        className="b-wv-add-in"
        list="b-wv-focus-shortcuts"
        placeholder="No shortcut"
        value={draft[which]}
        maxLength={120}
        onChange={(e) => setDraft((d) => ({ ...d, [which]: e.target.value }))}
        onBlur={() => save(which)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(which); else escapeBlurs(e); }}
      />
    </label>
  );

  return (
    <section className="b-wv-take" aria-label="macOS Focus">
      <span className="b-wv-take-t">Turn on a macOS Focus too</span>
      <span className="b-wv-take-card-d">
        Apps cannot switch a Focus themselves, but your own Shortcuts can. Make one with “Set Focus” in the Shortcuts app and
        name it here; Atlas runs it with Apple’s shortcuts tool when a session starts or ends. Nothing leaves this Mac.
      </span>
      <div className="b-wv-take-card">
        {field('start', 'When a session starts')}
        {field('end', 'When it ends')}
        <datalist id="b-wv-focus-shortcuts">{(names ?? []).map((n) => <option key={n} value={n} />)}</datalist>
        <button type="button" className="b-wv-take-btn" onClick={() => void load()}>{names ? `${names.length} shortcuts found · list again` : 'List my shortcuts'}</button>
        {listError ? <p className="b-wv-err">{listError}</p> : null}
        {err ? <p className="b-wv-err">{err}</p> : null}
      </div>
    </section>
  );
}
