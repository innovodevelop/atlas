/**
 * The Beta Clock — `/clock` (Beta redesign phase 4, `Atlas Clock Beta.dc.html`).
 *
 * The hero is the giant time and the 24-hour day/night band: one cell an
 * hour, lit by the sun where the weather reading allows (the reading has to
 * be for a place that keeps the home zone's time, or the band says it is
 * drawing a generic day), the now line, and a pill per city at its own local
 * hour. "Your time" is the profile's zone when it names one, else this Mac's.
 *
 * Below it the four modes — Timer, Countdown, Alarm, Clocks — are real local
 * features. Their state lives in a module store (src/lib/betaClockStore.ts),
 * saved to localStorage 'atlas:clock', so a timer keeps running and an alarm
 * keeps its schedule while the user is elsewhere; the shell's ringing layer
 * (components/atlas/clock/ClockRinging.tsx) rings it on whatever screen is
 * up. The arithmetic is src/lib/betaClock.ts, tested.
 *
 * In the Mac app the Alarm tab also keeps the Mac awake until an early alarm
 * (betaClockAwake.ts), rings an alarm on a Home Assistant speaker
 * (betaClockSpeakers.ts), and takes "wake me at seven", "stop" and "snooze"
 * from Atlas (betaClockVoice.ts) — the voice hints show only once that path
 * is listening.
 *
 * Keys: Esc closes the alarm editor, then goes Home — except while an alarm
 * rings, which needs Snooze or Stop.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useWeather } from '@/hooks/useWeather';
import { useWindowActivity } from '@/hooks/useWindowActivity';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import type { IconName } from '@/components/atlas/icons';
import ClockRinging from '@/components/atlas/clock/ClockRinging';
import { AlarmPanel, ClocksPanel, CountdownPanel, TimerPanel } from '@/components/atlas/clock/ClockPanels';
import {
  CLOCK_TABS, bandCells, bandPills, bandX, cellAlpha, cityForZone, countdownLeft, dateLine, draftAlarm, fmtDuration,
  heroLine, homeSun, homeZone, minutesLabel, nextAlarm, pad2, sunCaption, systemZone, timerElapsed, zoneTime,
  type Alarm, type ClockTab, type CityRef, type SunReading,
} from '@/lib/betaClock';
import {
  bootClock, checkAlerts, clearNotice, dismissMissed, getClock, refreshClock, setClockZone, setTimerVisible, useClock,
} from '@/lib/betaClockStore';
import { isBetaUi } from '@/lib/betaFlag';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/clock.css';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree. A new surface: there is no Workshop clock to override.
 */
export const surface = {
  path: '/clock',
  label: 'Clock',
  icon: 'Clock',
  entry: 'menu' as const,
  mock: false,
  edition: 'consumer' as const,
};

const TABS: readonly { k: ClockTab; label: string; icon: IconName }[] = [
  { k: 'timer', label: 'Timer', icon: 'stopwatch' },
  { k: 'countdown', label: 'Countdown', icon: 'countdown' },
  { k: 'alarm', label: 'Alarm', icon: 'alarm' },
  { k: 'clocks', label: 'Clocks', icon: 'clock' },
];

const isTab = (s: string): s is ClockTab => (CLOCK_TABS as readonly string[]).includes(s);

/** The tab to open on: the link's `#timer`, else whatever is running, else Alarm (the design's default). */
function firstTab(hash: string): ClockTab {
  const h = hash.replace(/^#/, '');
  if (isTab(h)) return h;
  const { prefs } = getClock();
  if (prefs.timer.running) return 'timer';
  if (prefs.countdown.running) return 'countdown';
  return 'alarm';
}

/** The band's width in px, so the pills can be packed to fit it (bandPills). */
function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Home plus this many cities, at most, on the band; fewer when they do not fit. */
const BAND_CITIES = 4;

/** A sunrise or sunset label's centre: its minute, kept far enough in that a far-north 02:40 sunrise is not cut off. */
const markX = (minuteOfDay: number): number => Math.min(95, Math.max(5, bandX(minuteOfDay)));

// ── Hero ─────────────────────────────────────────────────────────────────────

interface HeroProps {
  /** Whole seconds; the hero only changes on the second. */
  sec: number;
  tz: string;
  cities: CityRef[];
  alarms: Alarm[];
  sun: SunReading;
  onHome: () => void;
  onSphere: (el: HTMLButtonElement | null) => void;
}

const ClockHero = memo(function ClockHero({ sec, tz, cities, alarms, sun, onHome, onSphere }: HeroProps) {
  const now = sec * 1000;
  const z = zoneTime(tz, now);
  const minute = Math.floor(sec / 60);
  const daylight = sun.kind === 'here' ? sun.sun : null;
  const [bandRef, bandPx] = useWidth<HTMLDivElement>();
  const cells = useMemo(() => bandCells(daylight), [daylight]);
  // Pills move with the minute, not the second.
  const pills = useMemo(
    () => (bandPx ? bandPills(cityForZone(tz), cities, minute * 60000, BAND_CITIES + 1, bandPx) : []),
    [tz, cities, minute, bandPx],
  );
  const next = nextAlarm(alarms, now, tz);
  return (
    <header className="b-ck-hero" data-beta-tone="ink" aria-label="Clock">
      <button type="button" className="b-ck-sphere" ref={onSphere} onClick={() => openTalk()} aria-label="Talk to Atlas" title="Talk to Atlas · ⌥ Space">
        <VeilSphere size="hero" count={12000} ink bg="#1e1e24" />
      </button>
      <div className="b-ck-head">
        <span className="b-ck-eyebrow">Clock · {dateLine(tz, now)}</span>
        <button type="button" className="b-ck-big" title="Back to Home · Esc" onClick={onHome}>
          {pad2(z.hour)}:{pad2(z.minute)}<small>:{pad2(z.second)}</small>
        </button>
        <p className="b-ck-sub">{heroLine(next, alarms, now, tz)}</p>
      </div>
      <div className="b-ck-bandwrap">
        <div className="b-ck-band" ref={bandRef} role="img" aria-label={`The day in ${cityForZone(tz).name}: ${pills.map((p) => `${p.name} ${p.time}`).join(', ')}`}>
          {cells.map((c) => <i key={c.hour} style={{ background: `rgba(249, 247, 244, ${cellAlpha(c)})` }} />)}
          <span className="b-ck-now" style={{ left: `${bandX(z.minuteOfDay)}%` }} />
          {pills.map((p) => (
            <span key={p.tz} className={`b-ck-pill${p.home ? ' home' : ''}`} title={`${p.name} · ${p.time}`} style={{ left: `${p.x}%`, top: `${p.y}%` }}>
              <b>{p.time}</b>{p.compact ? null : p.name}
            </span>
          ))}
        </div>
        {daylight ? (
          <div className="b-ck-suns" aria-hidden>
            <span className="b-ck-sunmark" style={{ left: `${markX(daylight.sunrise)}%` }}><AtlasIcon name="sunrise" size={13} weight={1.6} />{minutesLabel(daylight.sunrise)}</span>
            <span className="b-ck-sunmark" style={{ left: `${markX(daylight.sunset)}%` }}><AtlasIcon name="sunset" size={13} weight={1.6} />{minutesLabel(daylight.sunset)}</span>
          </div>
        ) : null}
        <div className="b-ck-axis" aria-hidden><span>00</span><span>06</span><span>12</span><span>18</span><span>24 · your time</span></div>
        {daylight ? null : <p className="b-ck-sunnote">{sunCaption(sun)}</p>}
      </div>
    </header>
  );
});

// ── Page ─────────────────────────────────────────────────────────────────────

const BetaClock = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const location = useLocation();
  const clock = useClock();
  const { profile } = useUserProfile();
  const { weather, isFallback } = useWeather();
  const active = useWindowActivity();

  const [tab, setTab] = useState<ClockTab>(() => firstTab(location.hash));
  const [draft, setDraft] = useState<Alarm | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [sphereEl, setSphereEl] = useState<HTMLButtonElement | null>(null);

  const macTz = systemZone();
  const home = useMemo(() => homeZone(profile?.timezone, macTz), [profile?.timezone, macTz]);
  const { now, prefs } = clock;
  const tz = home.tz;

  useEffect(() => { bootClock(); void checkAlerts(); }, []);
  useEffect(() => { setClockZone(tz); }, [tz]);
  // Coming back to the window: catch up at once instead of on the next minute's check.
  useEffect(() => { if (active) refreshClock(); }, [active]);
  useEffect(() => { setTimerVisible(tab === 'timer'); return () => setTimerVisible(false); }, [tab]);
  // The hero sphere is this screen's talk entry point.
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);
  // A link to /clock#countdown while already here switches the tab.
  useEffect(() => { const h = location.hash.replace(/^#/, ''); if (isTab(h)) setTab(h); }, [location.hash]);

  const pickTab = useCallback((k: ClockTab) => {
    setTab(k);
    setDraft(null);
    plainNavigate({ pathname: location.pathname, search: location.search, hash: `#${k}` }, { replace: true });
  }, [plainNavigate, location.pathname, location.search]);

  const goHome = useCallback(() => navigate('/'), [navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      if (getClock().ringing) return;
      if (draft) { setDraft(null); return; }
      navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, draft]);

  // The sun, re-judged on the minute: a zone's offset can change under it (DST).
  const minute = Math.floor(now / 60000);
  const sun = useMemo(
    () => homeSun(weather, tz, minute * 60000, isFallback),
    [weather, tz, minute, isFallback],
  );

  const elapsed = timerElapsed(prefs.timer, now);
  const left = countdownLeft(prefs.countdown, now);
  const over = left < 0;
  const running = [
    prefs.timer.running ? { k: 'timer' as const, label: 'Timer', value: fmtDuration(elapsed), over: false } : null,
    prefs.countdown.running ? { k: 'countdown' as const, label: over ? 'Over by' : 'Countdown', value: `${over ? '+' : ''}${fmtDuration(left)}`, over } : null,
  ].filter((r): r is NonNullable<typeof r> => r !== null && r.k !== tab);
  const live: Record<ClockTab, { on: boolean; red: boolean }> = {
    timer: { on: prefs.timer.running, red: false },
    countdown: { on: prefs.countdown.running, red: false },
    alarm: { on: !!clock.ringing, red: true },
    clocks: { on: false, red: false },
  };

  const edit = useCallback((a: Alarm, isNew: boolean) => { setDraft({ ...a, days: [...a.days] }); setDraftIsNew(isNew); }, []);
  const newAlarm = useCallback(() => edit(draftAlarm(Date.now()), true), [edit]);
  const closeEditor = useCallback(() => setDraft(null), []);

  return (
    <div className="b-ck" data-screen-label={`Beta — Clock · ${TABS.find((t) => t.k === tab)?.label ?? ''}`}>
      <ClockHero
        sec={Math.floor(now / 1000)}
        tz={tz}
        cities={prefs.cities}
        alarms={prefs.alarms}
        sun={sun}
        onHome={goHome}
        onSphere={setSphereEl}
      />

      <div className="b-ck-modes">
        <div className="b-ck-tabs" role="tablist" aria-label="Clock mode">
          {TABS.map((t) => (
            <button
              key={t.k}
              type="button"
              role="tab"
              aria-selected={tab === t.k}
              aria-label={live[t.k].on ? `${t.label}, ${live[t.k].red ? 'ringing' : 'running'}` : undefined}
              className={`b-ck-tab${tab === t.k ? ' on' : ''}`}
              onClick={() => pickTab(t.k)}
            >
              <AtlasIcon name={t.icon} size={16} weight={1.6} />{t.label}
              {live[t.k].on && tab !== t.k ? <span className={`b-ck-dot${live[t.k].red ? ' red' : ''}`} aria-hidden /> : null}
            </button>
          ))}
        </div>
        <span className="b-ck-spacer" />
        {running.map((r) => (
          <button key={r.k} type="button" className={`b-ck-run${r.over ? ' over' : ''}`} title={`Open ${r.label}`} onClick={() => pickTab(r.k)}>
            <span className="b-ck-dot" />{r.label}<span>{r.value}</span>
          </button>
        ))}
      </div>

      {clock.notice ? (
        <div className="b-ck-banner" role="status">
          <p>{clock.notice}</p>
          <button type="button" className="b-btn b-btn--row" onClick={clearNotice}>Dismiss</button>
        </div>
      ) : null}
      {clock.missed.length ? (
        <div className="b-ck-banner calm" role="status">
          <p>
            Missed while this Mac was asleep: {clock.missed.map((m) => `${m.alarm.label || 'Alarm'} at ${m.alarm.time}`).join(', ')}.
            {' '}Atlas could not ring {clock.missed.length === 1 ? 'it' : 'them'}.
          </p>
          <button type="button" className="b-btn b-btn--row" onClick={dismissMissed}>Dismiss</button>
        </div>
      ) : null}

      {tab === 'timer' ? <TimerPanel timer={prefs.timer} now={now} /> : null}
      {tab === 'countdown' ? <CountdownPanel c={prefs.countdown} now={now} tz={tz} /> : null}
      {tab === 'alarm' ? (
        <AlarmPanel
          alarms={prefs.alarms}
          now={now}
          tz={tz}
          alerts={clock.alerts}
          draft={draft}
          draftIsNew={draftIsNew}
          onEdit={edit}
          onDraft={setDraft}
          onClose={closeEditor}
          onNew={newAlarm}
          awake={prefs.awake}
          awakeUntil={clock.awakeUntil}
          voiceReady={clock.voiceReady}
        />
      ) : null}
      {tab === 'clocks' ? (
        <ClocksPanel
          cities={prefs.cities}
          now={now}
          tz={tz}
          source={home.source}
          macTz={macTz}
          sun={sun}
          bandCount={Math.min(BAND_CITIES, prefs.cities.length)}
        />
      ) : null}

      {/* Under the Beta shell the shell's ringing layer shows the alarm on every screen; without it, this page does. */}
      {isBetaUi() ? null : <ClockRinging />}
    </div>
  );
};

export default BetaClock;
