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
 *
 * Three things reach past the webview, all through the Mac app
 * (src/lib/betaClockNative.ts → src-tauri/src/clock.rs):
 *   - "Keep this Mac awake until then": while the switch is on for an alarm,
 *     `syncAwake` keeps one `caffeinate` hold matching that alarm's next ring,
 *     and lets it go when the alarm rings, is switched off or deleted.
 *   - An alarm set to ring on a Home Assistant speaker speaks there instead of
 *     chiming here, and chimes here after all — with a note saying why — when
 *     the speaker does not answer.
 *   - The brain's clock tools ("wake me at seven", "stop", "snooze") arrive as
 *     `clock:command` events and are answered by `answerCommand`, through the
 *     same actions the screen uses.
 */
import { useSyncExternalStore } from 'react';
import { isWindowActive } from '@/hooks/useWindowActivity';
import { getAtlasState, publishAtlasState, type AtlasStateSnapshot } from './atlasStateBus';
import {
  COUNTDOWN_IDLE, COUNTDOWN_MIN_MS, PREFS_KEY, RING_GRACE_MS, SNOOZE_MINUTES, TIMER_IDLE, afterFire, countdownLeft,
  countdownTotal, dueAlarms, hhmm, nextAlarm, nextFire, parsePrefs, snoozeUntil, sortAlarms, systemZone, validZone,
  zoneTime,
  type Alarm, type AlarmPlan, type CityRef, type ClockPrefs, type CountdownMode, type RingTarget,
} from './betaClock';
import { awakeTarget, settleAwake } from './betaClockAwake';
import {
  isNative, keepAwake, listenForCommands, messageOf, releaseAwake, replyToCommand, ringSpeaker, sessionUserId,
} from './betaClockNative';
import { fallbackNote, outLabel, ringMessage } from './betaClockSpeakers';
import {
  NOTHING_RINGING, mergeVoiceAlarm, readCommand, setReply, snoozeMinutes, voiceAlarm, type VoiceReply,
} from './betaClockVoice';

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
  /** Where the ringing alarm is ringing: "This Mac" or a speaker's name. */
  ringingOn: string;
  /** Why it is ringing somewhere other than where it was set to, or null. */
  ringingNote: string | null;
  /** The keep-awake hold the Mac app confirmed, until this instant; null when there is none. */
  awakeUntil: number | null;
  /** The brain's clock commands can reach this store (the Mac app is listening for them). */
  voiceReady: boolean;
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
/**
 * The Home widgets' subscribers (`useClockPrefs`). Like the dialog's, they
 * never make the store tick: a widget reads the saved state and runs its own
 * slow clock, so Home does not re-render every second for a city time.
 */
const prefListeners = new Set<Listener>();

let lastCheck = Date.now();
let timer: number | null = null;
let chimeLoop: number | null = null;
let chimeStartedAt = 0;
let audio: AudioContext | null = null;
let timerVisible = false;
let booted = false;
/** What the state bus said before an alarm took it over, to hand back afterwards. */
let busBefore: AtlasStateSnapshot | null = null;
/** Bumped on every ring and every stop, so a speaker call that answers late knows it is stale. */
let ringSeq = 0;
let speakTimer: number | null = null;

let snap: ClockSnapshot = {
  now: Date.now(),
  prefs: readPrefs(),
  ringing: null,
  ringingTest: false,
  missed: [],
  notice: null,
  alerts: 'unknown',
  ringingOn: 'This Mac',
  ringingNote: null,
  awakeUntil: null,
  voiceReady: false,
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
  prefListeners.forEach((l) => l());
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
  const next = update(snap.prefs);
  if (next === snap.prefs) return;
  // A keep-awake switch whose alarm was just deleted or switched off goes off with it.
  const prefs = settleAwake(next, Date.now(), alarmZone());
  persist(prefs);
  set({ prefs, now: Date.now() });
  schedule();
  syncAwake();
}

const inTauri = isNative;
const describe = messageOf;

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
  stopSpeaker();
  const seq = ++ringSeq;
  const speaker = plan.alarm.ringOn ?? null;
  const canSpeak = !!speaker && inTauri() && !!sessionUserId();
  set({
    ringing: plan,
    ringingTest: test,
    ringingOn: canSpeak && speaker ? speaker.name : 'This Mac',
    ringingNote: speaker && !canSpeak
      ? `${speaker.name} can only ring from the Atlas Mac app with someone signed in, so it is ringing on this Mac.`
      : null,
  });
  publishAtlasState('alert', 'clock');
  if (canSpeak && speaker) startSpeaker(plan, speaker, seq);
  else startChimeLoop();
  void notify(label, `${test ? 'Test ring' : 'Alarm'} · ${plan.alarm.time}. Open Clock to stop or snooze.`);
}

// ── Ringing on a speaker ─────────────────────────────────────────────────────
//
// The speaker says the alarm once, then again every half minute while it is
// still ringing, four times in all — one sentence is easy to sleep through, a
// minute of it is not. The first failure, at any point, moves the ring to this
// Mac's chime and says why, in the dialog and on the page.

const SPEAK_EVERY_MS = 30_000;
const SPEAK_TIMES = 4;

function startSpeaker(plan: AlarmPlan, speaker: RingTarget, seq: number): void {
  let said = 0;
  const say = async () => {
    speakTimer = null;
    if (seq !== ringSeq || !snap.ringing) return;
    said += 1;
    const r = await ringSpeaker(speaker.id, ringMessage(plan.alarm));
    if (seq !== ringSeq || !snap.ringing) return;
    if ('error' in r) {
      set({ ringingOn: 'This Mac', ringingNote: fallbackNote(speaker.name, r.error) });
      addNotice(`${plan.alarm.label || 'Alarm'} was set to ring on ${speaker.name}, which didn’t answer (${r.error.replace(/\.$/, '')}). It rang on this Mac instead.`);
      startChimeLoop();
      return;
    }
    if (said < SPEAK_TIMES) speakTimer = window.setTimeout(() => { void say(); }, SPEAK_EVERY_MS);
  };
  void say();
}

function stopSpeaker(): void {
  if (speakTimer != null) window.clearTimeout(speakTimer);
  speakTimer = null;
}

// ── Keep awake ───────────────────────────────────────────────────────────────
//
// One hold at a time, matched to the switch after every change. `awakeHeld` is
// what the Mac app last confirmed; a call in flight is never doubled, and a
// change that arrives during one is applied when it returns.

let awakeHeld: number | null = null;
let awakeBusy = false;
let awakeAgain = false;

function syncAwake(): void {
  if (!inTauri()) return;
  const want = awakeTarget(snap.prefs, Date.now(), alarmZone());
  const until = want ? want.until : null;
  if (until === awakeHeld) return;
  if (awakeBusy) { awakeAgain = true; return; }
  awakeBusy = true;
  void (async () => {
    try {
      const r = until == null ? await releaseAwake() : await keepAwake(until);
      awakeHeld = r.active ? r.untilMs : null;
      set({ awakeUntil: awakeHeld });
    } catch (e) {
      // Say so, and turn the switch off: it must not claim a hold macOS refused.
      awakeHeld = null;
      set({ awakeUntil: null });
      addNotice(`Atlas could not keep this Mac awake: ${describe(e)}`);
      if (until != null && snap.prefs.awake) {
        const prefs = { ...snap.prefs, awake: null };
        persist(prefs);
        set({ prefs });
      }
    } finally {
      awakeBusy = false;
      if (awakeAgain) { awakeAgain = false; syncAwake(); }
    }
  })();
}

/** Turn "Keep this Mac awake until then" on (for the next alarm) or off. */
export function setKeepAwake(on: boolean): void {
  if (!on) {
    setPrefs((p) => (p.awake ? { ...p, awake: null } : p));
    return;
  }
  const next = nextAlarm(snap.prefs.alarms, Date.now(), alarmZone());
  if (!next) return;
  setPrefs((p) => ({ ...p, awake: { alarmId: next.alarm.id } }));
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
    // The alarm a keep-awake hold was for has come: the hold has done its job.
    prefs = settleAwake(prefs, now, alarmZone(), [...spent]);
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
  if (changed) syncAwake();
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
  /** "This Mac" or the speaker's name. */
  on: string;
  /** Why it is not ringing where it was set to, or null. */
  note: string | null;
  /** The brain's "stop" and "snooze" can reach this alarm. */
  voice: boolean;
}

let ringingView: RingingState | null = null;

/** A stable object per ringing alarm, so the dialog re-renders only when that changes. */
function getRinging(): RingingState | null {
  const plan = snap.ringing;
  if (!plan) return (ringingView = null);
  const v = ringingView;
  if (v?.plan !== plan || v.test !== snap.ringingTest || v.on !== snap.ringingOn || v.note !== snap.ringingNote || v.voice !== snap.voiceReady) {
    ringingView = { plan, test: snap.ringingTest, on: snap.ringingOn, note: snap.ringingNote, voice: snap.voiceReady };
  }
  return ringingView;
}

function subscribePrefs(fn: Listener): () => void {
  prefListeners.add(fn);
  return () => { prefListeners.delete(fn); };
}

const getPrefs = (): ClockPrefs => snap.prefs;

/**
 * The saved Clock state — cities, alarms, the timer and the countdown — for
 * the Home widgets. Never makes the store tick; the caller keeps its own time.
 */
export function useClockPrefs(): ClockPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
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
  // A keep-awake switch left on when Atlas last quit takes its hold again.
  syncAwake();
  void armVoice();
}

// ── Voice: the brain's clock tools ───────────────────────────────────────────

async function armVoice(): Promise<void> {
  try {
    const unlisten = await listenForCommands((payload) => { void answerCommand(payload); });
    if (unlisten) set({ voiceReady: true });
  } catch (e) {
    // The hints stay hidden: they only show once the path works.
    console.warn('[clock] could not listen for voice commands', e);
  }
}

async function answerCommand(payload: unknown): Promise<void> {
  const cmd = readCommand(payload);
  if (!cmd) return;
  let reply: VoiceReply;
  try {
    reply = handleCommand(cmd.action, cmd.args);
  } catch (e) {
    reply = { ok: false, message: `The Clock could not do that: ${describe(e)}` };
  }
  await replyToCommand(cmd.id, reply.ok, reply.message, reply.data ?? null);
}

/** One command from the brain, through the same actions the screen uses. Exported for tests. */
export function handleCommand(action: string, args: unknown): VoiceReply {
  const now = Date.now();
  const tz = alarmZone();
  switch (action) {
    case 'set_alarm': {
      const parsed = voiceAlarm(args, now);
      if ('error' in parsed) return { ok: false, message: parsed.error };
      const labelGiven = typeof (args as { label?: unknown } | null)?.label === 'string';
      const { alarm, existed } = mergeVoiceAlarm(snap.prefs.alarms, parsed.alarm, labelGiven);
      saveAlarm(alarm);
      const at = nextFire(alarm, now, tz);
      return {
        ok: true,
        message: setReply(alarm, at, now, tz, existed, outLabel(alarm)),
        data: { id: alarm.id, time: alarm.time, label: alarm.label, days: alarm.days, next_at: at == null ? null : new Date(at).toISOString() },
      };
    }
    case 'stop_alarm': {
      const r = snap.ringing;
      if (!r) return { ok: false, message: NOTHING_RINGING };
      stopRinging();
      return { ok: true, message: `Stopped ${r.alarm.label || 'the alarm'} (${r.alarm.time}).` };
    }
    case 'snooze_alarm': {
      const r = snap.ringing;
      if (!r) return { ok: false, message: NOTHING_RINGING };
      const minutes = snoozeMinutes(args, SNOOZE_MINUTES);
      const until = snoozeRinging(minutes);
      if (until == null) return { ok: true, message: 'That was a test ring of an alarm that is not saved, so it simply stopped.' };
      return { ok: true, message: `Snoozed ${r.alarm.label || 'the alarm'} for ${minutes} minutes, until ${hhmm(zoneTime(tz, until))}.` };
    }
    default:
      return { ok: false, message: `The Clock has no action “${action}”.` };
  }
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

/**
 * Snooze the ringing alarm, by the design's nine minutes unless told otherwise.
 * A test ring of an unsaved alarm has nothing to snooze, so it just stops.
 * Returns when it rings again, or null when it will not.
 */
export function snoozeRinging(minutes: number = SNOOZE_MINUTES): number | null {
  const r = snap.ringing;
  if (!r) return null;
  const saved = snap.prefs.alarms.some((a) => a.id === r.alarm.id);
  stopRinging();
  if (!saved) return null;
  const until = snoozeUntil(Date.now(), minutes);
  setPrefs((p) => ({ ...p, alarms: p.alarms.map((a) => (a.id === r.alarm.id ? { ...a, on: true, snoozedUntil: until } : a)) }));
  return until;
}

export function stopRinging(): void {
  stopChimeLoop();
  stopSpeaker();
  ringSeq += 1;
  if (snap.ringing) {
    set({ ringing: null, ringingTest: false, ringingOn: 'This Mac', ringingNote: null });
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
