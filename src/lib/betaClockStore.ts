/**
 * The Clock's running state — a module store (the talkBus.ts pattern), so a
 * timer started on /clock keeps counting while the user is on Mail, and an
 * alarm set there still rings. The page subscribes with `useClock()`; the
 * actions below are the only way the state changes, and every change that
 * matters is saved to localStorage 'atlas:clock' (parsed back by
 * `parsePrefs`, which treats anything unreadable as the default).
 *
 * One timer at a time. While the page is mounted AND the window is being
 * looked at (`isWindowActive`), it ticks at the rate the display needs: 50 ms
 * for the timer's centiseconds while the Timer tab shows them, 250 ms while a
 * countdown or the timer runs elsewhere on the page, once a second on the
 * second otherwise. Any other time there is no display tick at all — only one
 * `setTimeout` to the next event (a countdown reaching zero, an alarm),
 * re-checked at most every minute so a Mac that slept through the moment
 * catches up when it wakes. Nothing pending, nothing scheduled.
 *
 * The Beta shell mounts the ringing layer (components/atlas/clock/
 * ClockRinging.tsx) on every screen, and that calls `bootClock()` once, so
 * saved alarms ring wherever the user is, not only after Clock has been
 * opened this session.
 *
 * Firing never fails silently: the chime is Web Audio, the notification goes
 * through the Tauri notification plugin (the browser's Notification API
 * outside the app), and whatever either of them refused is written to
 * `notice` for the page to show. The ringing alarm itself is state here, so
 * the page shows it whenever the user comes back, and it is published to the
 * Atlas state bus as 'alert' so every sphere and the top bar say so too.
 */
import { useSyncExternalStore } from 'react';
import { isWindowActive } from '@/hooks/useWindowActivity';
import { getAtlasState, publishAtlasState, type AtlasStateSnapshot } from './atlasStateBus';
import {
  COUNTDOWN_IDLE, COUNTDOWN_MIN_MS, PREFS_KEY, RING_GRACE_MS, TIMER_IDLE, afterFire, countdownLeft, countdownTotal,
  dueAlarms, hhmm, nextAlarm, parsePrefs, snoozeUntil, sortAlarms, systemZone, validZone, zoneTime,
  type Alarm, type AlarmPlan, type CityRef, type ClockPrefs, type CountdownMode,
} from './betaClock';

export type AlertPermission = 'unknown' | 'granted' | 'denied';

export interface ClockSnapshot {
  /** The store's clock, refreshed on every tick. */
  now: number;
  prefs: ClockPrefs;
  /** The alarm ringing right now, if any. */
  ringing: AlarmPlan | null;
  /** True when `ringing` is a "Ring now to test" of an alarm that is not saved. */
  ringingTest: boolean;
  /** Alarms that came due while nothing could ring them (the Mac was asleep). */
  missed: AlarmPlan[];
  /** The last thing that went wrong on the way out; null when all is well. */
  notice: string | null;
  alerts: AlertPermission;
}

type Listener = () => void;
/** The page's subscribers: while any is mounted, the store ticks for the display. */
const listeners = new Set<Listener>();
/**
 * The ringing dialog's subscribers (the shell mounts one on every screen).
 * Kept apart on purpose: they only care about `ringing`, so they must not
 * make the store tick for a display that is not showing.
 */
const ringListeners = new Set<Listener>();

let lastCheck = Date.now();
let timer: number | null = null;
let chimeLoop: number | null = null;
let chimeStartedAt = 0;
let audio: AudioContext | null = null;
let timerVisible = false;
let booted = false;
/** What the state bus said before an alarm took it over, to hand back afterwards. */
let busBefore: AtlasStateSnapshot | null = null;

let snap: ClockSnapshot = {
  now: Date.now(),
  prefs: readPrefs(),
  ringing: null,
  ringingTest: false,
  missed: [],
  notice: null,
  alerts: 'unknown',
};

function readPrefs(): ClockPrefs {
  try {
    return parsePrefs(typeof window === 'undefined' ? null : window.localStorage.getItem(PREFS_KEY));
  } catch {
    return parsePrefs(null);
  }
}

function persist(prefs: ClockPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private window: the session keeps the state, the next launch starts clean */
  }
}

/** The zone alarms are read in: the one the screen last said, else this Mac's. */
const alarmZone = (): string => snap.prefs.zone ?? systemZone();

function emit(): void {
  listeners.forEach((l) => l());
  ringListeners.forEach((l) => l());
}

function set(patch: Partial<ClockSnapshot>): void {
  snap = { ...snap, ...patch };
  emit();
}

/**
 * Say what went wrong. Notices add up rather than replace each other: an
 * alarm whose chime is held back AND whose notification is refused should
 * say both. The same sentence is never repeated.
 */
function joinNotice(cur: string | null, text: string): string {
  return cur && cur.includes(text) ? cur : cur ? `${cur} ${text}` : text;
}

function addNotice(text: string, patch: Partial<ClockSnapshot> = {}): void {
  set({ ...patch, notice: joinNotice(snap.notice, text) });
}

function setPrefs(update: (p: ClockPrefs) => ClockPrefs): void {
  const prefs = update(snap.prefs);
  if (prefs === snap.prefs) return;
  persist(prefs);
  set({ prefs, now: Date.now() });
  schedule();
}

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Sound ────────────────────────────────────────────────────────────────────
//
// One AudioContext for the app's lifetime, created (or woken) from a user
// gesture — Start, Save, a switch, or the first click anywhere once something
// is pending — because WebKit only lets a page make sound after one. It is
// never suspended between chimes on purpose: resuming later needs another
// gesture, and an alarm rings precisely when nobody is touching the Mac.

/** Create or wake the audio context. Call from a user gesture; safe to call often. */
export function primeAudio(): void {
  try {
    const ctx = audio ?? (audio = new AudioContext());
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  } catch {
    /* no audio device; the notification and the page still say so */
  }
}

const NOTES: Record<'alarm' | 'done', number[]> = { alarm: [880, 1174.66, 880, 1174.66], done: [659.25, 880, 1318.5] };

/** A short sine chime. Resolves false when nothing could be heard: no device, or sound still locked. */
async function chime(kind: 'alarm' | 'done'): Promise<boolean> {
  try {
    const ctx = audio ?? (audio = new AudioContext());
    if (ctx.state === 'suspended') {
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => window.setTimeout(r, 400))]);
    }
    if (ctx.state !== 'running') return false;
    const t0 = ctx.currentTime + 0.02;
    NOTES[kind].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = t0 + i * 0.19;
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.52);
    });
    return true;
  } catch {
    return false;
  }
}

const CHIME_FAILED = 'The chime could not play: there is no audio output, or the system is holding sound back until this window is clicked. The alert is still showing here.';

/** Ring every couple of seconds while an alarm is up, for a minute at most; the dialog stays. */
function startChimeLoop(): void {
  stopChimeLoop();
  chimeStartedAt = Date.now();
  const beat = () => {
    if (!snap.ringing || Date.now() - chimeStartedAt > 60_000) return stopChimeLoop();
    void chime('alarm').then((ok) => { if (!ok && snap.ringing) addNotice(CHIME_FAILED); });
    chimeLoop = window.setTimeout(beat, 2200);
  };
  beat();
}

function stopChimeLoop(): void {
  if (chimeLoop != null) window.clearTimeout(chimeLoop);
  chimeLoop = null;
}

// ── Notifications ────────────────────────────────────────────────────────────

async function tauriPermission(ask: boolean): Promise<AlertPermission> {
  const plugin = await import('@tauri-apps/plugin-notification');
  if (await plugin.isPermissionGranted()) return 'granted';
  if (!ask) return 'unknown';
  return (await plugin.requestPermission()) === 'granted' ? 'granted' : 'denied';
}

function browserPermission(): AlertPermission {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'unknown';
}

/** Read the permission without prompting (the page calls this on mount). */
export async function checkAlerts(): Promise<void> {
  try {
    const alerts = inTauri() ? await tauriPermission(false) : browserPermission();
    if (alerts !== snap.alerts) set({ alerts });
  } catch (e) {
    addNotice(`Could not read the notification permission: ${describe(e)}`);
  }
}

const ALERTS_OFF = 'Notifications are off for Atlas, so alarms and countdowns only chime and show here. Allow Atlas in System Settings → Notifications to see them anywhere.';

/** Ask for the permission, from a user gesture. */
export async function requestAlerts(): Promise<void> {
  try {
    let alerts: AlertPermission;
    if (inTauri()) {
      alerts = await tauriPermission(true);
    } else if (typeof Notification === 'undefined') {
      alerts = 'denied';
    } else {
      alerts = (await Notification.requestPermission()) === 'granted' ? 'granted' : 'denied';
    }
    if (alerts === 'granted') set({ alerts });
    else addNotice(ALERTS_OFF, { alerts });
  } catch (e) {
    addNotice(`Could not ask for notifications: ${describe(e)}`);
  }
}

/** Ask once, when something is set that will need to reach the user later. */
function ensureAlerts(): void {
  if (snap.alerts === 'unknown') void requestAlerts();
}

async function notify(title: string, body: string): Promise<void> {
  try {
    if (inTauri()) {
      const alerts = await tauriPermission(true);
      if (alerts !== 'granted') {
        addNotice('macOS did not let Atlas post the notification — allow Atlas in System Settings → Notifications. The alert is only inside Atlas.', { alerts });
        return;
      }
      const plugin = await import('@tauri-apps/plugin-notification');
      plugin.sendNotification({ title, body });
      if (snap.alerts !== 'granted') set({ alerts: 'granted' });
      return;
    }
    if (typeof Notification === 'undefined') {
      addNotice('This browser has no notifications; the alert is only inside Atlas.', { alerts: 'denied' });
      return;
    }
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') {
      addNotice('Notifications are blocked for this page, so the alert is only inside Atlas.', { alerts: 'denied' });
      return;
    }
    new Notification(title, { body });
    if (snap.alerts !== 'granted') set({ alerts: 'granted' });
  } catch (e) {
    addNotice(`The notification did not go out: ${describe(e)}`);
  }
}

// ── The tick ─────────────────────────────────────────────────────────────────

function fireAlarm(plan: AlarmPlan, test: boolean): void {
  const label = plan.alarm.label || 'Alarm';
  if (!snap.ringing) busBefore = getAtlasState();
  set({ ringing: plan, ringingTest: test });
  publishAtlasState('alert', 'clock');
  startChimeLoop();
  void notify(label, `${test ? 'Test ring' : 'Alarm'} · ${plan.alarm.time}. Open Clock to stop or snooze.`);
}

/** Hand the state bus back to whoever had it, unless someone has spoken since. */
function releaseBus(): void {
  if (getAtlasState().source === 'clock') {
    const prev = busBefore && busBefore.source !== 'clock' ? busBefore : null;
    publishAtlasState(prev?.state ?? 'idle', prev?.source ?? 'clock');
  }
  busBefore = null;
}

function tick(): void {
  const now = Date.now();
  let prefs = snap.prefs;
  let changed = false;
  const patch: Partial<ClockSnapshot> = { now };

  // A countdown reaching zero is announced once, at the moment of its endAt.
  // Found long after (Atlas was closed, or the Mac asleep), it is reported
  // rather than chimed: a chime at nine for something that ended at seven
  // would read as a new event.
  const c = prefs.countdown;
  if (c.running && c.endAt <= now && c.announcedEnd !== c.endAt) {
    prefs = { ...prefs, countdown: { ...c, announcedEnd: c.endAt } };
    changed = true;
    if (now - c.endAt > RING_GRACE_MS) {
      patch.notice = joinNotice(snap.notice, `The countdown reached zero at ${hhmm(zoneTime(alarmZone(), c.endAt))}, while Atlas could not ring it. It has kept counting since.`);
    } else {
      void chime('done').then((ok) => { if (!ok) addNotice(CHIME_FAILED); });
      void notify('Countdown finished', c.mode === 'target' ? 'The moment you were counting down to is here.' : 'Time is up. It keeps counting past zero until you reset it.');
    }
  }

  // Alarms due since the last look. The look happens every tick, so `lastCheck`
  // is normally a second ago; after sleep it is however long the Mac was away.
  const due = dueAlarms(prefs.alarms, lastCheck, now, alarmZone());
  if (due.ring.length || due.missed.length) {
    const spent = new Set([...due.ring, ...due.missed].map((p) => p.alarm.id));
    prefs = { ...prefs, alarms: prefs.alarms.map((a) => (spent.has(a.id) ? afterFire(a) : a)) };
    changed = true;
    if (due.missed.length) {
      patch.missed = [...snap.missed, ...due.missed];
      for (const m of due.missed) void notify(`Missed: ${m.alarm.label || 'Alarm'}`, `It was due at ${m.alarm.time}; Atlas was not awake to ring it.`);
    }
  }
  lastCheck = now;

  if (changed) persist(prefs);
  set({ ...patch, prefs: changed ? prefs : snap.prefs });
  // The last due alarm wins the dialog; the ones before it are spent above.
  if (due.ring.length) fireAlarm(due.ring[due.ring.length - 1], false);
  schedule();
}

/** Pick the next tick from what is on screen and what is pending. */
function schedule(): void {
  if (typeof window === 'undefined') return;
  if (timer != null) window.clearTimeout(timer);
  timer = null;
  const { prefs } = snap;
  const now = Date.now();
  let delay: number | null;
  if (listeners.size > 0 && isWindowActive()) {
    delay = prefs.timer.running && timerVisible ? 50
      : prefs.timer.running || prefs.countdown.running ? 250
        : 1000 - (now % 1000) + 5;
  } else {
    const events: number[] = [];
    if (prefs.countdown.running && prefs.countdown.announcedEnd !== prefs.countdown.endAt) events.push(prefs.countdown.endAt);
    const next = nextAlarm(prefs.alarms, now, alarmZone());
    if (next) events.push(next.at);
    delay = events.length ? Math.min(60_000, Math.max(250, Math.min(...events) - now + 20)) : null;
  }
  if (delay != null) timer = window.setTimeout(tick, delay);
}

// ── Subscription ─────────────────────────────────────────────────────────────

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  schedule();
  return () => {
    listeners.delete(fn);
    schedule();
  };
}

const getSnapshot = (): ClockSnapshot => snap;

export function useClock(): ClockSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getClock(): ClockSnapshot {
  return snap;
}

export interface RingingState {
  plan: AlarmPlan;
  test: boolean;
}

let ringingView: RingingState | null = null;

/** A stable object per ringing alarm, so the dialog re-renders only when that changes. */
function getRinging(): RingingState | null {
  const plan = snap.ringing;
  if (!plan) return (ringingView = null);
  if (ringingView?.plan !== plan || ringingView.test !== snap.ringingTest) ringingView = { plan, test: snap.ringingTest };
  return ringingView;
}

function subscribeRinging(fn: Listener): () => void {
  ringListeners.add(fn);
  return () => { ringListeners.delete(fn); };
}

/** The alarm ringing now, for the dialog. Does not make the store tick. */
export function useClockRinging(): RingingState | null {
  return useSyncExternalStore(subscribeRinging, getRinging, getRinging);
}

/**
 * Start the store once per app run: arm the next event, and unlock sound on
 * the first click anywhere if something is pending that will need it.
 */
export function bootClock(): void {
  if (booted || typeof window === 'undefined') return;
  booted = true;
  lastCheck = Date.now();
  schedule();
  const unlock = () => {
    const p = snap.prefs;
    if (p.alarms.some((a) => a.on) || p.countdown.running) primeAudio();
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true, passive: true });
}

/** Catch up now — the page calls this when the window becomes active again. */
export function refreshClock(): void {
  tick();
}

/** The Timer tab is showing its centiseconds; tick fast while it runs. */
export function setTimerVisible(on: boolean): void {
  if (timerVisible === on) return;
  timerVisible = on;
  schedule();
}

/** The zone alarms are read in (the screen's home zone), saved for the next launch. */
export function setClockZone(tz: string): void {
  const zone = validZone(tz);
  if (!zone || zone === snap.prefs.zone) return;
  setPrefs((p) => ({ ...p, zone }));
}

export function clearNotice(): void {
  if (snap.notice) set({ notice: null });
}

// ── Timer ────────────────────────────────────────────────────────────────────

export function startTimer(): void {
  primeAudio();
  setPrefs((p) => (p.timer.running ? p : { ...p, timer: { ...p.timer, running: true, startedAt: Date.now() } }));
}

export function pauseTimer(): void {
  setPrefs((p) => {
    if (!p.timer.running) return p;
    const now = Date.now();
    return { ...p, timer: { ...p.timer, running: false, accMs: p.timer.accMs + Math.max(0, now - p.timer.startedAt), startedAt: 0 } };
  });
}

export function resetTimer(): void {
  setPrefs((p) => ({ ...p, timer: { ...TIMER_IDLE, laps: [] } }));
}

export function lapTimer(): void {
  setPrefs((p) => {
    if (!p.timer.running) return p;
    const elapsed = p.timer.accMs + Math.max(0, Date.now() - p.timer.startedAt);
    return { ...p, timer: { ...p.timer, laps: [...p.timer.laps, elapsed] } };
  });
}

// ── Countdown ────────────────────────────────────────────────────────────────

export function setCountdownMode(mode: CountdownMode): void {
  setPrefs((p) => (p.countdown.running || p.countdown.mode === mode ? p : { ...p, countdown: { ...p.countdown, mode, pausedLeft: null, splits: [], spanMs: 0 } }));
}

export function setCountdownDuration(ms: number): void {
  setPrefs((p) => (p.countdown.running ? p : { ...p, countdown: { ...p.countdown, durMs: Math.max(COUNTDOWN_MIN_MS, ms), pausedLeft: null, splits: [], spanMs: 0 } }));
}

export function stepCountdown(deltaMs: number): void {
  setPrefs((p) => (p.countdown.running ? p : { ...p, countdown: { ...p.countdown, durMs: Math.max(COUNTDOWN_MIN_MS, p.countdown.durMs + deltaMs), pausedLeft: null, splits: [], spanMs: 0 } }));
}

export function setCountdownTarget(target: string): void {
  setPrefs((p) => (p.countdown.running ? p : { ...p, countdown: { ...p.countdown, target, pausedLeft: null, splits: [], spanMs: 0 } }));
}

/** Start, or resume from a pause. Nothing happens when there is nothing to count. */
export function startCountdown(): void {
  primeAudio();
  ensureAlerts();
  setPrefs((p) => {
    if (p.countdown.running) return p;
    const now = Date.now();
    const left = p.countdown.pausedLeft ?? countdownTotal(p.countdown, now);
    if (left <= 0 && p.countdown.pausedLeft == null) return p;
    const endAt = now + left;
    const spanMs = p.countdown.pausedLeft != null && p.countdown.spanMs > 0 ? p.countdown.spanMs : left;
    // Resuming a countdown paused past zero must not announce zero again.
    return { ...p, countdown: { ...p.countdown, running: true, endAt, pausedLeft: null, spanMs, announcedEnd: left <= 0 ? endAt : 0 } };
  });
}

export function pauseCountdown(): void {
  setPrefs((p) => (p.countdown.running ? { ...p, countdown: { ...p.countdown, running: false, pausedLeft: countdownLeft(p.countdown, Date.now()), endAt: 0 } } : p));
}

export function resetCountdown(): void {
  setPrefs((p) => ({ ...p, countdown: { ...p.countdown, running: false, endAt: 0, pausedLeft: null, splits: [], announcedEnd: 0, spanMs: 0 } }));
}

export function splitCountdown(): void {
  setPrefs((p) => (p.countdown.running ? { ...p, countdown: { ...p.countdown, splits: [...p.countdown.splits, countdownLeft(p.countdown, Date.now())] } } : p));
}

/** Back to the idle preset, used when the saved countdown has become meaningless. */
export function clearCountdown(): void {
  setPrefs((p) => ({ ...p, countdown: { ...COUNTDOWN_IDLE, splits: [] } }));
}

// ── Alarms ───────────────────────────────────────────────────────────────────

export function saveAlarm(alarm: Alarm): void {
  primeAudio();
  ensureAlerts();
  setPrefs((p) => {
    const exists = p.alarms.some((a) => a.id === alarm.id);
    const alarms = exists ? p.alarms.map((a) => (a.id === alarm.id ? alarm : a)) : [...p.alarms, alarm];
    return { ...p, alarms: sortAlarms(alarms) };
  });
}

export function deleteAlarm(id: string): void {
  if (snap.ringing?.alarm.id === id) stopRinging();
  setPrefs((p) => ({ ...p, alarms: p.alarms.filter((a) => a.id !== id) }));
}

export function toggleAlarm(id: string): void {
  primeAudio();
  const turningOn = snap.prefs.alarms.some((a) => a.id === id && !a.on);
  if (turningOn) ensureAlerts();
  setPrefs((p) => ({ ...p, alarms: p.alarms.map((a) => (a.id === id ? { ...a, on: !a.on, snoozedUntil: null } : a)) }));
}

/** "Ring now to test": the full path — chime, notification, dialog — for an alarm that need not be saved. */
export function ringNow(alarm: Alarm): void {
  primeAudio();
  fireAlarm({ alarm, at: Date.now() }, !snap.prefs.alarms.some((a) => a.id === alarm.id));
  schedule();
}

/** Snooze the ringing alarm. A test ring of an unsaved alarm has nothing to snooze, so it just stops. */
export function snoozeRinging(): void {
  const r = snap.ringing;
  if (!r) return;
  const saved = snap.prefs.alarms.some((a) => a.id === r.alarm.id);
  stopRinging();
  if (!saved) return;
  const until = snoozeUntil(Date.now());
  setPrefs((p) => ({ ...p, alarms: p.alarms.map((a) => (a.id === r.alarm.id ? { ...a, on: true, snoozedUntil: until } : a)) }));
}

export function stopRinging(): void {
  stopChimeLoop();
  if (snap.ringing) {
    set({ ringing: null, ringingTest: false });
    releaseBus();
  }
  schedule();
}

export function dismissMissed(): void {
  if (snap.missed.length) set({ missed: [] });
}

// ── Cities ───────────────────────────────────────────────────────────────────

export function addCity(city: CityRef): void {
  setPrefs((p) => (p.cities.some((c) => c.tz === city.tz) ? p : { ...p, cities: [...p.cities, city] }));
}

export function removeCity(index: number): void {
  setPrefs((p) => (index < 0 || index >= p.cities.length ? p : { ...p, cities: p.cities.filter((_, i) => i !== index) }));
}

export function moveCity(index: number, delta: -1 | 1): void {
  setPrefs((p) => {
    const j = index + delta;
    if (index < 0 || index >= p.cities.length || j < 0 || j >= p.cities.length) return p;
    const cities = [...p.cities];
    [cities[index], cities[j]] = [cities[j], cities[index]];
    return { ...p, cities };
  });
}
