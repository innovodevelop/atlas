/**
 * The four bodies of the Beta Clock (`Atlas Clock Beta.dc.html`): Timer
 * (counts up, with laps), Countdown (a duration or a moment, past zero is a
 * state), Alarm (the honest note, the list, the editor) and Clocks (home and
 * the saved cities, add from the curated list, and where "your time" and the
 * sun come from).
 *
 * Every control calls the clock store (src/lib/betaClockStore.ts); every
 * figure comes from the store's state or the arithmetic in src/lib/betaClock.ts.
 * The page owns only what is the page's: which tab, the alarm being edited,
 * the city search text — and the editor's list of speakers, read from the
 * smart-home mirror when the editor opens.
 */
import { memo, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import {
  COUNTDOWN_PRESETS, CURATED_CITIES, DAY_LETTER, DAY_ORDER, DAY_SHORT, RING_C, RING_R,
  alarmWhen, cityForZone, cityRows, countdownCanStart, countdownLeft, countdownStatus, countdownTotal,
  currentLap, daysLabel, earlyNext, finishAlarm, fmtDuration, lapCountLabel, lapRows, nextAlarm, offsetLabel,
  ringOffset, searchCities, snoozeLine, splitRows, sunCaption, targetInputValue, timerElapsed, timerStatus,
  whenLabel, zoneOffsetMinutes,
  type Alarm, type ClockPrefs, type CityRef, type CountdownState, type SunReading, type TimerState, type ZoneSource,
} from '@/lib/betaClock';
import { awakeLabel, awakeTarget, showAwakeSwitch } from '@/lib/betaClockAwake';
import { isNative, listSpeakers, messageOf } from '@/lib/betaClockNative';
import { outLabel, outNote, ringOptions, speakersNote, type SpeakerList } from '@/lib/betaClockSpeakers';
import {
  addCity, checkAlerts, deleteAlarm, lapTimer, moveCity, pauseCountdown, pauseTimer, removeCity, requestAlerts,
  resetCountdown, resetTimer, ringNow, saveAlarm, setCountdownDuration, setCountdownMode, setCountdownTarget,
  setKeepAwake, splitCountdown, startCountdown, startTimer, stepCountdown, toggleAlarm, type AlertPermission,
} from '@/lib/betaClockStore';

// ── Timer ────────────────────────────────────────────────────────────────────

export const TimerPanel = memo(function TimerPanel({ timer, now }: { timer: TimerState; now: number }) {
  const elapsed = timerElapsed(timer, now);
  const laps = useMemo(() => lapRows(timer.laps), [timer.laps]);
  const lap = currentLap(elapsed, timer.laps);
  return (
    <div className="b-ck-two">
      <section className="b-ck-timer" aria-label="Timer">
        <span className={`b-ck-state${timer.running ? ' on' : ''}`}>{timerStatus(timer, elapsed)}</span>
        <span className="b-ck-tbig" role="timer" aria-live="off">{fmtDuration(elapsed, true)}</span>
        <span className="b-ck-curlap">{timer.laps.length ? `Lap ${timer.laps.length + 1} · ${fmtDuration(lap, true)}` : ''}</span>
        <div className="b-ck-acts">
          {timer.running
            ? <button type="button" className="b-ck-act" onClick={lapTimer}>Lap</button>
            : <button type="button" className="b-ck-act" disabled={elapsed === 0} onClick={resetTimer}>Reset</button>}
          {timer.running
            ? <button type="button" className="b-ck-act hold" onClick={pauseTimer}>Pause</button>
            : <button type="button" className="b-ck-act go" onClick={startTimer}>{elapsed > 0 ? 'Resume' : 'Start'}</button>}
        </div>
      </section>
      <section className="b-ck-laps" aria-label="Laps">
        <div className="b-ck-laps-head"><p className="b-ck-h2">Laps</p><span>{lapCountLabel(timer.laps.length)}</span></div>
        <div className="b-ck-lapcols" aria-hidden><span>#</span><span>Lap</span><span>vs previous</span><span>Total</span></div>
        <div className="b-ck-lapscroll">
          {laps.map((l) => (
            <div key={l.n} className="b-ck-lap">
              <span>{l.n}</span>
              <span className="b-ck-lap-split">{l.split}{l.tag ? <span className={`b-ck-tag${l.tag === 'Fastest' ? ' fast' : ''}`}>{l.tag}</span> : null}</span>
              <span className={l.deltaTone}>{l.delta}</span>
              <span>{l.total}</span>
            </div>
          ))}
          {!laps.length ? <div className="b-ck-empty">Start the timer and press Lap to mark a split. Each lap shows how it compares with the one before.</div> : null}
        </div>
      </section>
    </div>
  );
});

// ── Countdown ────────────────────────────────────────────────────────────────

export const CountdownPanel = memo(function CountdownPanel({ c, now, tz }: { c: CountdownState; now: number; tz: string }) {
  const left = countdownLeft(c, now);
  const total = countdownTotal(c, now);
  const over = left < 0;
  const splits = useMemo(() => splitRows(c.splits, total), [c.splits, total]);
  const locked = c.running;
  const canReset = c.pausedLeft != null || c.splits.length > 0;
  return (
    <div className="b-ck-two">
      <section className={`b-ck-count${over ? ' over' : ''}`} aria-label="Countdown">
        <div className="b-ck-ring">
          <svg viewBox="0 0 280 280" aria-hidden>
            <circle className="track" cx="140" cy="140" r={RING_R} />
            <circle className="arc" cx="140" cy="140" r={RING_R} strokeDasharray={RING_C} strokeDashoffset={ringOffset(left, total)} />
          </svg>
          <div className="b-ck-ringtext">
            <span className="b-ck-cbig" role="timer" aria-live="off">{over ? '+' : ''}{fmtDuration(left)}</span>
            <span className="b-ck-csub">of {fmtDuration(total)}</span>
          </div>
        </div>
        <span className="b-ck-cstate">{countdownStatus(c, now, tz)}</span>
        <div className="b-ck-acts">
          {c.running
            ? <button type="button" className="b-ck-act" onClick={splitCountdown}>Split</button>
            : <button type="button" className="b-ck-act" disabled={!canReset} onClick={resetCountdown}>Reset</button>}
          {c.running
            ? <button type="button" className="b-ck-act hold" onClick={pauseCountdown}>Pause</button>
            : <button type="button" className="b-ck-act go" disabled={!countdownCanStart(c, now)} onClick={startCountdown}>{c.pausedLeft != null ? 'Resume' : 'Start'}</button>}
        </div>
      </section>
      <div className="b-ck-col">
        <section className="b-ck-set" aria-label="Countdown settings">
          <div className="b-ck-seg" role="tablist" aria-label="Countdown type">
            {([['duration', 'Duration'], ['target', 'Until a date']] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={c.mode === k} className={c.mode === k ? 'on' : ''} disabled={locked} onClick={() => setCountdownMode(k)}>{l}</button>
            ))}
          </div>
          {c.mode === 'duration' ? (
            <>
              <div className="b-ck-presets">
                {COUNTDOWN_PRESETS.map((p) => (
                  <button key={p.minutes} type="button" className={`b-ck-preset${c.durMs === p.minutes * 60000 ? ' on' : ''}`} disabled={locked} aria-pressed={c.durMs === p.minutes * 60000} onClick={() => setCountdownDuration(p.minutes * 60000)}>{p.label}</button>
                ))}
              </div>
              <div className="b-ck-steps">
                <button type="button" className="b-ck-step" disabled={locked || c.durMs <= 60000} onClick={() => stepCountdown(-60000)}>− 1 min</button>
                <button type="button" className="b-ck-step" disabled={locked} onClick={() => stepCountdown(60000)}>+ 1 min</button>
                <button type="button" className="b-ck-step" disabled={locked} onClick={() => stepCountdown(600000)}>+ 10 min</button>
              </div>
            </>
          ) : (
            <>
              <input
                type="datetime-local"
                className="b-ck-target"
                aria-label="Count down to"
                value={c.target}
                min={targetInputValue(now)}
                disabled={locked}
                onChange={(e) => setCountdownTarget(e.currentTarget.value)}
              />
              <p className="b-ck-hint">Counts down to that moment, then keeps going past it. The date and time are this Mac's.</p>
            </>
          )}
        </section>
        <section className="b-ck-splits" aria-label="Splits">
          <p className="b-ck-h2">Splits</p>
          {splits.map((s) => (
            <div key={s.n} className="b-ck-split"><span>{s.n}</span><span>{s.left} left</span><span>{s.used} used</span></div>
          ))}
          {!splits.length ? <div className="b-ck-empty">Press Split while it runs to mark how much was left.</div> : null}
        </section>
      </div>
    </div>
  );
});

// ── Alarm ────────────────────────────────────────────────────────────────────

interface AlarmPanelProps {
  alarms: Alarm[];
  now: number;
  tz: string;
  alerts: AlertPermission;
  draft: Alarm | null;
  draftIsNew: boolean;
  onEdit: (a: Alarm, isNew: boolean) => void;
  onDraft: (a: Alarm) => void;
  onClose: () => void;
  onNew: () => void;
  /** The stored "Keep this Mac awake until then" switch. */
  awake: ClockPrefs['awake'];
  /** The hold the Mac app confirmed, or null. */
  awakeUntil: number | null;
  /** The brain's clock tools reach the store, so the voice hint can show. */
  voiceReady: boolean;
}

/** The speakers an alarm can ring on, read from the smart-home mirror while the editor is open. */
function useSpeakers(open: boolean): { list: SpeakerList | null; error: string | null; native: boolean } {
  const native = isNative();
  const [list, setList] = useState<SpeakerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !native) return;
    let live = true;
    listSpeakers().then(
      (l) => { if (live) { setList(l); setError(null); } },
      (e: unknown) => { if (live) setError(messageOf(e)); },
    );
    return () => { live = false; };
  }, [open, native]);
  return { list, error, native };
}

function AlertsRow({ alerts }: { alerts: AlertPermission }) {
  if (alerts === 'granted') return null;
  return alerts === 'unknown' ? (
    <div className="b-ck-alerts">
      <span>Notifications aren't allowed yet, so a ringing alarm only shows inside Atlas.</span>
      <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => void requestAlerts()}>Allow notifications</button>
    </div>
  ) : (
    <div className="b-ck-alerts">
      <span>Notifications are off for Atlas, so alarms only chime and show inside Atlas. Allow Atlas in System Settings → Notifications.</span>
      <button type="button" className="b-btn b-btn--row" onClick={() => void checkAlerts()}>Check again</button>
    </div>
  );
}

export function AlarmPanel({ alarms, now, tz, alerts, draft, draftIsNew, onEdit, onDraft, onClose, onNew, awake, awakeUntil, voiceReady }: AlarmPanelProps) {
  const next = nextAlarm(alarms, now, tz);
  const early = earlyNext(next, now, tz);
  const finished = draft ? finishAlarm(draft) : null;
  const hold = awakeTarget({ awake, alarms }, now, tz);
  const awakeOn = !!hold;
  const native = isNative();
  const speakers = useSpeakers(!!draft);
  const options = draft ? ringOptions(speakers.list, draft.ringOn ?? null) : [];
  const speakerNote = speakersNote(speakers.list, speakers.native, speakers.error);
  const toggleDay = (d: number) => {
    if (!draft) return;
    onDraft({ ...draft, days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d] });
  };
  return (
    <>
      <section role="note" className={`b-ck-note${early ? ' ink' : ''}`}>
        <div className="b-ck-note-row">
          <AtlasIcon name="mac" size={20} weight={1.6} />
          <div className="b-ck-note-text">
            <p className="b-ck-note-title">
              {early && next
                ? `For ${next.alarm.label || 'Alarm'} at ${whenLabel(tz, next.at, now)}, this Mac has to stay awake and Atlas has to stay open.`
                : 'Alarms ring only while Atlas is running.'}
            </p>
            <p className="b-ck-note-body">A Mac that is asleep, lid closed or with Atlas quit won’t ring. macOS doesn’t let apps wake it. For anything you can’t miss, set one on your phone too.</p>
          </div>
        </div>
        {showAwakeSwitch(early, awakeOn) ? (
          <button
            type="button"
            role="switch"
            aria-checked={awakeOn}
            className={`b-ck-awake${awakeOn ? ' on' : ''}`}
            disabled={!native}
            onClick={() => setKeepAwake(!awakeOn)}
          >
            <span>{native ? awakeLabel(awakeOn, hold, awakeUntil, tz, now) : 'Keeping this Mac awake needs the Atlas Mac app.'}</span>
            <span className="b-ck-awake-sw" aria-hidden><span /></span>
          </button>
        ) : null}
        <AlertsRow alerts={alerts} />
      </section>

      <div className="b-ck-two">
        <section className="b-ck-list" aria-label="Alarms">
          <div className="b-ck-list-head"><p className="b-ck-h2">Alarms</p><button type="button" className="b-ck-new" onClick={onNew}>New alarm</button></div>
          {alarms.map((a) => {
            const snz = snoozeLine(a, now, tz);
            return (
              <div key={a.id} className={`b-ck-alarm${a.on ? ' on' : ''}`}>
                <button type="button" className="b-ck-alarm-edit" onClick={() => onEdit(a, false)} aria-label={`Edit ${a.label} at ${a.time}`}>
                  <span className="b-ck-alarm-t">{a.time}</span>
                  <span className="b-ck-alarm-meta">
                    <span className="b-ck-alarm-line"><b>{a.label}</b><em>{alarmWhen(a, now, tz)}</em></span>
                    <span className="b-ck-alarm-days">
                      <span className="b-ck-days" title={daysLabel(a.days)} aria-label={daysLabel(a.days)}>
                        {DAY_ORDER.map((d) => <i key={d} className={a.days.includes(d) ? 'in' : ''}>{DAY_LETTER[d]}</i>)}
                      </span>
                      <span className="b-ck-out"><AtlasIcon name={a.ringOn ? 'speaker' : 'mac'} size={13} weight={1.6} />{outLabel(a)}</span>
                    </span>
                    {snz ? <span className="b-ck-snz">{snz}</span> : null}
                  </span>
                </button>
                <button type="button" role="switch" aria-checked={a.on} aria-label={`${a.label} at ${a.time}`} className={`b-ck-switch${a.on ? ' on' : ''}`} onClick={() => toggleAlarm(a.id)}><span /></button>
              </div>
            );
          })}
          {!alarms.length ? (
            <div className="b-ck-none">
              <p>No alarms</p>
              <p>
                {voiceReady
                  ? 'Set one here, or just tell Atlas “wake me at seven”. It rings on this Mac, with a notification, while Atlas is running.'
                  : 'Set one here. It rings on this Mac, with a notification, while Atlas is running.'}
              </p>
              <button type="button" className="b-ck-new" onClick={onNew}>New alarm</button>
            </div>
          ) : null}
        </section>

        {draft ? (
          <section className="b-ck-editor" aria-label={draftIsNew ? 'New alarm' : 'Edit alarm'}>
            <p className="b-ck-h2">{draftIsNew ? 'New alarm' : 'Edit alarm'}</p>
            <div className="b-ck-ed-fields">
              <input type="time" className="b-ck-ed-time" aria-label="Time" value={draft.time} onChange={(e) => onDraft({ ...draft, time: e.currentTarget.value })} />
              <input className="b-ck-ed-label" aria-label="Label" placeholder="Label" value={draft.label} maxLength={60} onChange={(e) => onDraft({ ...draft, label: e.currentTarget.value })} />
            </div>
            <span className="b-ck-ed-cap">Repeat · {daysLabel(DAY_ORDER.filter((d) => draft.days.includes(d)))}</span>
            <div className="b-ck-ed-days">
              {DAY_ORDER.map((d) => (
                <button key={d} type="button" className={`b-ck-ed-day${draft.days.includes(d) ? ' on' : ''}`} aria-pressed={draft.days.includes(d)} onClick={() => toggleDay(d)}>{DAY_SHORT[d]}</button>
              ))}
            </div>
            <span className="b-ck-ed-cap" id="b-ck-ringon">Ring on</span>
            <div className="b-ck-ed-outs" role="radiogroup" aria-labelledby="b-ck-ringon">
              {options.map((o) => {
                const picked = (o.target?.id ?? null) === (draft.ringOn?.id ?? null);
                return (
                  <button
                    key={o.target?.id ?? 'mac'}
                    type="button"
                    role="radio"
                    aria-checked={picked}
                    className={`b-ck-ed-out${picked ? ' on' : ''}${o.missing ? ' missing' : ''}`}
                    onClick={() => onDraft({ ...draft, ringOn: o.target })}
                  >
                    <AtlasIcon name={o.target ? 'speaker' : 'mac'} size={16} weight={1.5} />
                    <span className="b-ck-ed-out-t"><b>{o.label}</b>{o.sub ? <small>{o.sub}</small> : null}</span>
                  </button>
                );
              })}
            </div>
            {speakerNote ? <p className="b-ck-hint">{speakerNote}</p> : null}
            <p className="b-ck-hint">{outNote(draft.ringOn ?? null)}</p>
            <div className="b-ck-ed-acts">
              <button type="button" className="b-btn b-btn--primary" disabled={!finished} onClick={() => { if (finished) { saveAlarm(finished); onClose(); } }}>Save</button>
              <button type="button" className="b-btn" disabled={!finished} onClick={() => { if (finished) ringNow(finished); }}>Ring now to test</button>
              <button type="button" className="b-btn b-btn--ghost" onClick={onClose}>Cancel</button>
              <span className="b-ck-spacer" />
              {!draftIsNew ? <button type="button" className="b-btn b-btn--danger" onClick={() => { deleteAlarm(draft.id); onClose(); }}>Delete</button> : null}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

// ── Clocks ───────────────────────────────────────────────────────────────────

interface ClocksPanelProps {
  cities: CityRef[];
  now: number;
  tz: string;
  source: ZoneSource;
  macTz: string;
  sun: SunReading;
  bandCount: number;
}

export function ClocksPanel({ cities, now, tz, source, macTz, sun, bandCount }: ClocksPanelProps) {
  const [query, setQuery] = useState('');
  const home = cityForZone(tz);
  const rows = cityRows(home, cities, now);
  const hits = searchCities(query, cities, tz);
  const q = query.trim().toLowerCase();
  const shown = q && !hits.length && CURATED_CITIES.some((c) => c.name.toLowerCase().includes(q));
  const add = (c: CityRef) => { addCity(c); setQuery(''); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && hits[0]) { e.preventDefault(); add(hits[0]); }
  };
  const offset = zoneOffsetMinutes(tz, now);
  const mac = cityForZone(macTz);
  return (
    <div className="b-ck-two">
      <section className="b-ck-list" aria-label="Clocks">
        {rows.map((r, i) => {
          const idx = i - 1;
          return (
            <div key={r.tz} className={`b-ck-city${r.night ? ' night' : ''}`}>
              <div className="b-ck-city-name">
                <p>{r.name}</p>
                <p className="b-ck-city-sub"><span className={`b-ck-badge${r.badge === 'Today' ? '' : ' off'}`}>{r.badge}</span>{r.diff}</p>
              </div>
              <span className="b-ck-city-t">{r.time}</span>
              {r.home ? null : (
                <span className="b-ck-city-ctl">
                  {idx > 0 ? <button type="button" aria-label={`Move ${r.name} up`} onClick={() => moveCity(idx, -1)}>↑</button> : null}
                  {idx < cities.length - 1 ? <button type="button" aria-label={`Move ${r.name} down`} onClick={() => moveCity(idx, 1)}>↓</button> : null}
                  <button type="button" aria-label={`Remove ${r.name}`} onClick={() => removeCity(idx)}><AtlasIcon name="close" size={14} /></button>
                </span>
              )}
            </div>
          );
        })}
        <div className="b-ck-add">
          <input className="b-ck-addq" placeholder="Add a city" aria-label="Add a city" value={query} onChange={(e) => setQuery(e.currentTarget.value)} onKeyDown={onKey} />
          {hits.length ? (
            <div className="b-ck-hits">
              {hits.map((h) => (
                <button key={h.tz} type="button" className="b-ck-hit" onClick={() => add(h)}><b>{h.name}</b><span>{h.tz}</span></button>
              ))}
            </div>
          ) : null}
          {q && !hits.length ? <p className="b-ck-nohit">{shown ? 'That city is already on your list.' : 'No city by that name in the list.'}</p> : null}
        </div>
      </section>

      <section className="b-ck-col" aria-label="Your time">
        <span className="b-ck-cap">Your time</span>
        <div className="b-ck-zone">
          <div className="b-ck-zone-top"><b>{home.name}</b><span>{offsetLabel(offset)}</span></div>
          <p>
            {source === 'profile' ? `From your profile (${tz}).` : `From this Mac's settings (${tz}).`}
            {source === 'profile' && macTz !== tz ? ` This Mac is set to ${mac.name}, ${offsetLabel(zoneOffsetMinutes(macTz, now))}.` : ''}
            {' '}The giant time, the band and your alarms all read this clock.
          </p>
          <div className="b-ck-zone-sun"><AtlasIcon name={sun.kind === 'here' ? 'sunrise' : 'sun'} size={16} />{sunCaption(sun)}</div>
        </div>
        <p className="b-ck-foot">
          {bandCount === 0
            ? 'Add a city and it joins home on the band above.'
            : `The band above shows home and your first ${bandCount === 1 ? 'city' : `${bandCount} cities`}, as many as fit. Move a city up to give it a place there.`}
        </p>
      </section>
    </div>
  );
}
