/**
 * The Beta Health — `/health` while the beta_ui flag is on (Beta redesign
 * phase 4, `Atlas Health Beta.dc.html`).
 *
 * Readiness rings from the day's own figures (sleep against 8 h, heart rate
 * against the week, active energy against 500 kcal), the heart from the last
 * export (not live — nothing on this Mac streams a watch), last night by
 * stage, steps over 7 or 30 days from the store's series, workouts, a day
 * log kept on this Mac, and the vitals' week as sparklines. The import, the
 * sources and the forget control are the Workshop page's own panels, reused.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeReport, useHealth } from '@/hooks/useHealth';
import { useHealthSeries } from '@/hooks/useHealthSeries';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import {
  GLASSES, GOALS, METRIC, MOODS, barsFrom, dayLabel, goalLinePct, headlineFor, logKey, parseLog, readiness, readinessWord, ringsFrom, sparkOf, stagesFrom, trendOf,
  type DayLog, type RingKey,
} from '@/lib/betaHealth';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { setTalkAnchor } from '@/lib/talkBus';
import type { QuickSphereState } from '@/lib/quickSphere';
import { ForgetPanel, ImportPanel, SourcesView } from './AtlasHealth';
import { isTyping } from './atlasHelpers';
import '@/styles/surfaces/health.css';

const RING_STATE: Record<RingKey, QuickSphereState> = { sleep: 'dissolving', recovery: 'success', activity: 'working' };
const VITALS: { id: string; label: string; colour: string }[] = [
  { id: METRIC.heart, label: 'Heart rate', colour: '#d0453a' },
  { id: METRIC.hrv, label: 'HRV', colour: '#0fae76' },
  { id: METRIC.steps, label: 'Steps', colour: '#3461f2' },
  { id: METRIC.exercise, label: 'Exercise', colour: '#e07a1f' },
  { id: METRIC.asleep, label: 'Asleep', colour: '#7854ff' },
];

function Vital({ id, label, colour, version }: { id: string; label: string; colour: string; version: string | null }) {
  const { rows } = useHealthSeries(id, 7, version);
  const trend = trendOf(rows);
  return (
    <div className="b-hl-vital">
      <span className="b-hl-vital-head"><span>{label}</span><span className={`t-${trend.dir}`}>{trend.text}</span></span>
      <span className="b-hl-vital-v b-num">{rows[0]?.value ?? '—'}</span>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden><polyline points={sparkOf(rows)} fill="none" stroke={colour} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" /></svg>
    </div>
  );
}

const BetaHealth = () => {
  const navigate = useBetaNavigate();
  const health = useHealth();
  const { snapshot, supported, today } = health;
  const version = snapshot?.capturedAt ?? null;
  const [ring, setRing] = useState<RingKey | null>(null);
  const [range, setRange] = useState<7 | 30>(7);
  const [grown, setGrown] = useState(false);
  const [view, setView] = useState<'body' | 'sources'>('body');
  const [sphereEl, setSphereEl] = useState<HTMLDivElement | null>(null);
  const [log, setLog] = useState<DayLog>(() => { try { return parseLog(window.localStorage.getItem(logKey(today))); } catch { return parseLog(null); } });

  useEffect(() => { const t = window.setTimeout(() => setGrown(true), 120); return () => window.clearTimeout(t); }, []);
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);
  useEffect(() => { try { setLog(parseLog(window.localStorage.getItem(logKey(today)))); } catch { /* keep what we have */ } }, [today]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!isTyping(e.target) && e.key === 'Escape') { if (view === 'sources') setView('body'); else navigate('/'); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, view]);

  const card = useCallback((id: string) => snapshot?.metrics.find((m) => m.id === id) ?? null, [snapshot]);
  const heart = useHealthSeries(METRIC.heart, 7, version);
  const steps = useHealthSeries(METRIC.steps, range, version);
  const sleepWeek = useHealthSeries(METRIC.asleep, 7, version);

  const rings = useMemo(() => ringsFrom({
    asleep: card(METRIC.asleep)?.value, deep: card(METRIC.deep)?.value, energy: card(METRIC.energy)?.value, exercise: card(METRIC.exercise)?.value, heart: heart.rows,
  }), [card, heart.rows]);
  const ready = readiness(rings);
  const head = headlineFor(ring, rings, ready);
  const stages = stagesFrom({ deep: card(METRIC.deep)?.value, core: card(METRIC.core)?.value, rem: card(METRIC.rem)?.value, awake: card(METRIC.awake)?.value });
  const stageTotal = stages.reduce((a, s) => a + s.minutes, 0) || 1;
  const bars = barsFrom(steps.rows, GOALS.steps);
  const best = bars.length ? bars.reduce((a, b) => (b.raw > a.raw ? b : a)) : null;
  const overDays = bars.filter((b) => b.over).length;
  const hasData = !!snapshot?.hasData;
  const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const sleepTrend = trendOf(sleepWeek.rows);
  const workouts = snapshot?.workoutRows ?? [];

  const writeLog = (next: DayLog) => { setLog(next); try { window.localStorage.setItem(logKey(today), JSON.stringify(next)); } catch { /* private window */ } };

  const sphereState: QuickSphereState | undefined = ring ? RING_STATE[ring] : health.importing ? 'working' : undefined;

  return (
    <div className="b-hl nosb" data-screen-label="Beta — Health">
      <div className="b-hl-top">
        <section className="b-hl-hero" data-beta-tone="ink" aria-label="Readiness">
          <div className="b-hl-ring">
            <div className="b-hl-ring-sphere" ref={setSphereEl}><VeilSphere size="mini" ink bg="#1e1e24" state={sphereState} /></div>
            <svg viewBox="0 0 300 300" className="b-hl-ring-svg" aria-hidden>
              {rings.map((g) => {
                const C = 2 * Math.PI * g.r;
                const f = grown && g.fraction != null ? g.fraction : 0;
                return (
                  <g key={g.key}>
                    <circle cx="150" cy="150" r={g.r} fill="none" stroke="rgba(249,247,244,.08)" strokeWidth="16" />
                    <circle cx="150" cy="150" r={g.r} fill="none" stroke={g.colour} strokeWidth="16" strokeLinecap="round" strokeDasharray={C.toFixed(1)} strokeDashoffset={(C * (1 - f)).toFixed(1)} style={{ transition: 'stroke-dashoffset 1.2s var(--b-spring)' }} />
                  </g>
                );
              })}
            </svg>
            <div className="b-hl-ring-mid">
              <span className="b-eyebrow b-eyebrow--onink">Readiness</span>
              <span className="b-hl-ready b-num">{ready ?? '—'}</span>
              <span className="b-hl-ready-word">{readinessWord(ready)}</span>
            </div>
          </div>
          <div className="b-hl-hero-text">
            <button type="button" className="b-eyebrow b-eyebrow--onink b-hl-back" title="Back to Home · Esc" onClick={() => navigate('/')}>Health · {dateLine}</button>
            <h1 className="b-hl-h1">{head.title}</h1>
            <p className="b-hl-sub">{head.sub}</p>
            <div className="b-hl-ringrows">
              {rings.map((g) => (
                <button type="button" key={g.key} className={`b-hl-ringrow${ring === g.key ? ' on' : ''}`} onClick={() => setRing(ring === g.key ? null : g.key)}>
                  <i style={{ background: g.colour }} />
                  <span><b>{g.label}</b><span>{g.why}</span></span>
                  <span className="b-num">{g.value}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="b-hl-heart" aria-label="Heart">
          <div className="b-hl-card-head"><span className="b-hl-card-t"><i className={heart.rows.length ? 'beat' : ''} />Heart</span><span>{heart.rows.length ? 'From your last export' : 'No heart rate yet'}</span></div>
          <div className="b-hl-bpm"><span className="b-num">{heart.rows[0] ? Math.round(heart.rows[0].raw) : '—'}</span><span>bpm · day average{heart.rows[0] ? ` · ${dayLabel(heart.rows[0].day, today).toLowerCase()}` : ''}</span></div>
          <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="b-hl-heart-line" aria-hidden><polyline points={sparkOf(heart.rows)} fill="none" stroke="#d0453a" strokeWidth="2.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" /></svg>
          <div className="b-hl-mini">
            <div><span>HRV</span><b className="b-num">{card(METRIC.hrv)?.value ?? '—'}</b><small>{card(METRIC.hrv)?.kicker ?? ''}</small></div>
            <div><span>Heart rate</span><b className="b-num">{card(METRIC.heart)?.value ?? '—'}</b><small className={`t-${trendOf(heart.rows).dir}`}>{trendOf(heart.rows).text}</small></div>
            <div><span>Stand</span><b className="b-num">{card(METRIC.stand)?.value ?? '—'}</b><small>{card(METRIC.stand)?.kicker ?? ''}</small></div>
          </div>
        </section>
      </div>

      <section className="b-hl-sleep" aria-label="Sleep">
        <div className="b-hl-sleep-head">
          <span className="b-hl-h2">Last night</span>
          <span className="b-hl-sleep-big b-num">{card(METRIC.asleep)?.value ?? '—'}</span>
          <span className={`b-hl-sleep-trend t-${sleepTrend.dir}`}>{sleepTrend.text}</span>
          <span className="b-hl-sp" />
          <span className="b-hl-stagekeys">{stages.map((s) => <span key={s.key}><i style={{ background: s.colour }} />{s.label} · {s.value}</span>)}</span>
        </div>
        {stages.length ? (
          <div className="b-hl-stagebar" role="img" aria-label={stages.map((s) => `${s.label} ${s.value}`).join(', ')}>
            {stages.map((s) => <span key={s.key} style={{ flex: s.minutes / stageTotal, background: s.colour }} title={`${s.label} · ${s.value}`} />)}
          </div>
        ) : (
          <div className="b-hl-note">{hasData ? 'This export carries no sleep stages.' : supported ? 'Sleep appears here after an import.' : 'Health data lives in the Mac app.'}</div>
        )}
        {sleepWeek.rows.length > 1 ? (
          <div className="b-hl-week">
            {barsFrom(sleepWeek.rows, GOALS.sleepMinutes).map((b) => (
              <span key={b.day} className="b-hl-week-day" title={`${dayLabel(b.day, today)} · ${b.label}`}><b style={{ height: `${b.pct}%`, background: b.over ? '#3461f2' : '#b6c6ff' }} /><span>{dayLabel(b.day, today).slice(0, 3)}</span></span>
            ))}
          </div>
        ) : null}
      </section>

      <div className="b-hl-tri">
        <section className="b-hl-card b-hl-steps" aria-label="Steps">
          <div className="b-hl-card-head">
            <span className="b-hl-h2">Steps</span>
            <div className="b-seg b-seg--small" role="radiogroup" aria-label="Range">
              <button type="button" role="radio" aria-checked={range === 7} className={range === 7 ? 'on' : ''} onClick={() => setRange(7)}>7 days</button>
              <button type="button" role="radio" aria-checked={range === 30} className={range === 30 ? 'on' : ''} onClick={() => setRange(30)}>30 days</button>
            </div>
          </div>
          <span className="b-hl-big b-num">{card(METRIC.steps)?.value ?? '—'}</span>
          <div className={`b-hl-bars${range === 30 ? ' dense' : ''}`}>
            {bars.length ? <span className="b-hl-goal" style={{ bottom: `${goalLinePct(GOALS.steps, bars)}%` }} /> : null}
            {bars.map((b) => <span key={b.day} className={`b-hl-bar${b.over ? ' over' : ''}${b.day === today ? ' today' : ''}`} style={{ height: `${b.pct}%` }} title={`${dayLabel(b.day, today)} · ${b.label} steps`} />)}
            {!bars.length ? <span className="b-hl-note">{supported ? 'No step days in the store yet.' : 'Steps appear in the Mac app.'}</span> : null}
          </div>
          <span className="b-hl-foot">Goal {GOALS.steps.toLocaleString()}{best ? ` · best ${dayLabel(best.day, today).toLowerCase()}, ${best.label}` : ''}{range === 30 && bars.length ? ` · ${overDays} ${overDays === 1 ? 'day' : 'days'} over goal` : ''}</span>
        </section>

        <section className="b-hl-card b-hl-workouts" aria-label="Workouts">
          <span className="b-hl-h2">Workouts</span>
          {workouts.slice(0, 5).map((w) => (
            <div key={`${w.startedAt}-${w.activity}`} className="b-hl-wo">
              <span className="b-hl-wo-ico">{w.activity.slice(0, 1).toUpperCase()}</span>
              <span className="b-hl-wo-text"><b>{w.activity}{w.distanceKm ? ` · ${w.distanceKm.toFixed(1)} km` : ''}</b><span>{dayLabel(w.day, today)}{w.energyKcal ? ` · ${Math.round(w.energyKcal)} kcal` : ''}{w.avgHeartRate ? ` · ${Math.round(w.avgHeartRate)} bpm` : ''}</span></span>
              <span className="b-num b-hl-wo-v">{Math.round(w.durationMin)} min</span>
            </div>
          ))}
          {!workouts.length ? <div className="b-hl-note">{hasData ? 'No workouts in this export.' : 'Workouts appear here after an import.'}</div> : null}
          {workouts.length ? <div className="b-hl-tip">{workouts.length} {workouts.length === 1 ? 'workout' : 'workouts'} in the store{snapshot?.workoutCard?.caption ? ` · ${snapshot.workoutCard.caption}` : ''}.</div> : null}
        </section>

        <section className="b-hl-card b-hl-log" aria-label="Today's log">
          <span className="b-hl-h2">Today’s log</span>
          <div className="b-hl-logcard">
            <span className="b-hl-log-l">Water<span>{log.water} of {GLASSES} glasses</span></span>
            <div className="b-hl-glasses">
              {Array.from({ length: GLASSES }, (_, i) => (
                <button type="button" key={i} className={i < log.water ? 'on' : ''} aria-label={`${i + 1} glasses`} onClick={() => writeLog({ ...log, water: log.water === i + 1 ? i : i + 1 })} />
              ))}
            </div>
          </div>
          <div className="b-hl-logcard">
            <span className="b-hl-log-l">How do you feel?</span>
            <div className="b-hl-moods">
              {MOODS.map((m) => <button type="button" key={m} className={log.mood === m ? 'on' : ''} onClick={() => writeLog({ ...log, mood: log.mood === m ? null : m })}>{m}</button>)}
            </div>
          </div>
          <span className="b-hl-note b-hl-note--quiet">Kept on this Mac, for today only.</span>
        </section>
      </div>

      <section className="b-hl-vitals" aria-label="Vitals">
        {VITALS.map((v) => <Vital key={v.id} {...v} version={version} />)}
      </section>

      <section className="b-hl-card b-hl-manage" aria-label="Sources and import">
        <div className="b-hl-card-head">
          <span className="b-hl-h2">Your data</span>
          <div className="b-seg b-seg--small" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'body'} className={view === 'body' ? 'on' : ''} onClick={() => setView('body')}>Import</button>
            <button type="button" role="tab" aria-selected={view === 'sources'} className={view === 'sources' ? 'on' : ''} onClick={() => setView('sources')}>Sources</button>
          </div>
        </div>
        {view === 'body' ? <><ImportPanel health={health} />{hasData ? <ForgetPanel health={health} /> : null}</> : <SourcesView health={health} />}
        {health.report ? <p className="b-hl-note">{describeReport(health.report, today)}</p> : null}
      </section>
      <p className="b-hl-footer"><AtlasIcon name="shield check" size={14} />From Apple Health on this Mac. Health data never leaves this Mac, and Atlas doesn’t give medical advice.</p>
    </div>
  );
};

export default BetaHealth;
