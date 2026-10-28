/**
 * The Beta Smart Home — `/smart-home` while the beta_ui flag is on (Beta
 * redesign phase 4, `Atlas Smart Home Beta.dc.html`).
 *
 * The header (sphere, the hub, the inside and outside temperatures, what is
 * on), the scenes strip, the rooms, the 3D stage with one device and its
 * controls, the room's device grid with 3D thumbnails, and an aside with the
 * hub's facts, the bridge and what was touched recently. The data is the same
 * `useSmartHome()` the Workshop page uses — the Rust `home` module mirroring
 * Home Assistant over the LAN — so every pill and slider here commands a real
 * device, and every honesty rule that hook enforces (not responding, sending,
 * never confirmed, did not go through) is printed where the design prints a
 * status.
 *
 * The Beta extras come from the same bridge (src-tauri/src/home/beta.rs):
 * Home / Away / Night, each running the scene or script the user mapped to
 * it, with a Home/Away suggestion when Home Assistant knows where people are;
 * the energy card from its power sensors and its own statistics; its
 * automations with their switches; a camera's motion events and a still on
 * request; and the tips and the lock note, read from the history Atlas keeps
 * of what the devices did and which commands it sent. Each of them says what
 * it needs when the bridge does not have it, and draws nothing invented.
 *
 * three.js is loaded lazily inside an effect, so it stays out of the main
 * bundle, and the stage only exists while there is a device to put on it.
 * Under prefers-reduced-motion the turning stage is a still render of the
 * same model.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HOME_MODES, relativeLabel, useSmartHome, type EnergyToday, type HomeEvent, type HomeMode, type LiveBridge, type LiveDevice, type UseSmartHome,
} from '@/hooks/useSmartHome';
import { useWeather } from '@/hooks/useWeather';
import { isRoutable } from '@/surfaces';
import type { Stage, StageKind } from '@/lib/devices3d';
import {
  MODE_LABEL, SWATCHES, cameraEventLine, cameraSensors, clockLabel, controlKind, countOn, energyView, fToC, fmtKwh, fmtTemp, fmtWatts,
  hasPower, historyLine, homeTips, isSecured, lastMotion, lit, lockNote, powerLabel, powerValue, presenceSuggestion, roomSub, roomTemp,
  sceneInitial, stageKindOf, stageStateOf, statusOf, stepTemp, stepperValue, thermNote, type Tip,
} from '@/lib/betaSmartHome';
import { DeviceControl } from '@/components/atlas-ui/smartHome/DeviceControls';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import type { IconName } from '@/components/atlas/icons';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { LinkForm, OutageNotice } from './AtlasSmartHome';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/smartHome.css';

type Devices3d = typeof import('@/lib/devices3d');
type ThreeState = 'loading' | 'ready' | 'failed';

/** The stage and the thumbnails sit on panel paper, like the design's. */
const STAGE_BG = '#f1eeea';
const THUMB_PX = 220;
const STILL_PX = 640;
const RECENT_PX = 96;
const WARM = '#ffd9a0';
/** How long a scene pill may say "Running…" if neither an answer nor an error arrives. */
const SCENE_PATIENCE_MS = 15_000;
/** The history window the screen reads: a week, newest first, capped. */
const HISTORY_DAYS_READ = 7;
const HISTORY_LIMIT = 500;
/** The history is re-read after a change, at most this often. */
const HISTORY_SETTLE_MS = 4_000;
/** Today's energy is re-read this often while the screen is open. */
const ENERGY_EVERY_MS = 5 * 60_000;
const MODE_DOT: Record<HomeMode, string> = { home: 'var(--b-green)', away: '#e07a1f', night: '#7854ff' };

const ICON_OF: Record<StageKind, IconName> = {
  lamp: 'sun', bulb: 'sun', speaker: 'speaker', thermostat: 'temperature', lock: 'lock', camera: 'camera', blinds: 'sliders', plug: 'energy',
};

/** A thumbnail, or null when WebGL will not give one. Never throws into render. */
function safeThumb(mod: Devices3d | null, d: LiveDevice, size: number): string | null {
  if (!mod) return null;
  try { return mod.thumb(stageKindOf(d.kind), stageStateOf(d), STAGE_BG, size); } catch { return null; }
}

/** The pill next to a bridge. `health` is the real column; `state` has two values. */
function bridgePill(b: LiveBridge): { text: string; tone: 'ready' | 'failed' | 'paused' } {
  if (b.state === 'connected') return { text: 'Connected', tone: 'ready' };
  switch (b.health) {
    case 'unreachable': return { text: 'Not answering', tone: 'failed' };
    case 'unauthorised': return { text: 'Token rejected', tone: 'failed' };
    case 'unavailable': return { text: 'Unavailable', tone: 'failed' };
    default: return { text: 'Not linked', tone: 'paused' };
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Re-renders every `ms` while `on`, so "applied a minute ago" keeps meaning it. */
function useTick(ms: number, on: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setT(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
  return t;
}

/**
 * The design's 44px track with the readout inside it. Dragging moves a local
 * value and the device is commanded once, on release — a slider that sends
 * every pixel is thirty LAN calls for one dim. The local value is dropped the
 * moment the hook reports a new reading, so the track never argues with it.
 */
function RangeField({ value, min, max, fill, ariaLabel, readout, disabled, onCommit }: {
  value: number; min: number; max: number; fill?: string; ariaLabel: string; disabled?: boolean;
  readout: (v: number) => string; onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  useEffect(() => { setLocal(null); }, [value]);
  const v = local ?? Math.round(Math.max(min, Math.min(max, value)));
  const commit = () => { if (local != null && local !== Math.round(value)) onCommit(local); };
  return (
    <div className="b-sh-range" style={fill ? { ['--b-sh-fill' as string]: fill } : undefined}>
      <input
        type="range" min={min} max={max} step={1} value={v} aria-label={ariaLabel} disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit} onTouchEnd={commit} onKeyUp={commit} onBlur={commit}
      />
      <span className="b-sh-range-label">{readout(v)}</span>
    </div>
  );
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The history Atlas keeps (`home_events`), read for the last week and read
 * again shortly after the house changes. Throttled rather than debounced: the
 * push channel can signal every second, and a debounce would never fire.
 */
function useHomeHistory(live: UseSmartHome, active: boolean): { events: HomeEvent[]; error: string | null; keptDays: number } {
  const { loadHistory, snapshot } = live;
  const [events, setEvents] = useState<HomeEvent[]>([]);
  const [keptDays, setKeptDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<number | null>(null);
  const last = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
    if (pending.current != null) window.clearTimeout(pending.current);
  }, []);
  useEffect(() => {
    if (!active) { setEvents([]); return; }
    if (pending.current != null) return;
    const wait = Math.max(0, last.current + HISTORY_SETTLE_MS - Date.now());
    pending.current = window.setTimeout(() => {
      pending.current = null;
      last.current = Date.now();
      const since = new Date(Date.now() - HISTORY_DAYS_READ * 86_400_000).toISOString();
      loadHistory({ since, limit: HISTORY_LIMIT })
        .then((h) => { if (alive.current) { setEvents(h.events); setKeptDays(h.keptDays); setError(null); } })
        .catch((e) => { if (alive.current) setError(errText(e)); });
    }, wait);
  }, [active, snapshot, loadHistory]);
  return { events, error, keptDays };
}

/** Today's energy from Home Assistant's statistics, only when there are energy sensors to ask about. */
function useEnergyToday(live: UseSmartHome, sensors: number, active: boolean): { today: EnergyToday | null; error: string | null } {
  const { loadEnergy } = live;
  const [today, setToday] = useState<EnergyToday | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || sensors === 0) { setToday(null); return; }
    let on = true;
    const read = () => {
      loadEnergy()
        .then((t) => { if (on) { setToday(t); setError(null); } })
        .catch((e) => { if (on) setError(errText(e)); });
    };
    read();
    const id = window.setInterval(read, ENERGY_EVERY_MS);
    return () => { on = false; window.clearInterval(id); };
  }, [active, sensors, loadEnergy]);
  return { today, error };
}

/** The design's switch: a 46×28 pill with a sliding knob. */
function Switch({ on, label, disabled, busy, onChange }: { on: boolean; label: string; disabled?: boolean; busy?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} aria-busy={busy || undefined} disabled={disabled || busy} className={`b-sh-switch${on ? ' on' : ''}${busy ? ' busy' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

/** The energy card: live watts, today's kWh by hour, and the devices behind them. */
function EnergyCard({ devices, today, error, usable, hasBridge }: {
  devices: readonly LiveDevice[]; today: EnergyToday | null; error: string | null; usable: boolean; hasBridge: boolean;
}) {
  const view = useMemo(() => energyView(devices, today?.sensors ?? null), [devices, today]);
  const max = Math.max(0, ...view.hours.map((h) => h ?? 0));
  const nowHour = new Date().getHours();
  if (!usable || !hasBridge || view.none) {
    return (
      <section className="b-sh-card b-sh-card--ink" aria-label="Energy today">
        <span className="b-sh-card-eyebrow">Energy today</span>
        <span className="b-sh-card-big">—</span>
        <span className="b-sh-card-foot">
          {!usable ? 'Energy is read from Home Assistant, in the Mac app.'
            : !hasBridge ? 'Link Home Assistant and its power and energy sensors show here.'
              : 'Your bridge reports no power or energy sensor. A smart plug or an energy meter in Home Assistant fills this card; nothing leaves your network.'}
        </span>
      </section>
    );
  }
  return (
    <section className="b-sh-card b-sh-card--ink" aria-label="Energy today">
      <span className="b-sh-card-eyebrow">Energy today</span>
      <span className="b-sh-energy-big">
        {view.energySensors ? <>{fmtKwh(view.kwh)}<span> kWh</span></> : <>{fmtWatts(view.watts)}<span> now</span></>}
      </span>
      {view.energySensors ? (
        <div className="b-sh-energy-bars" role="img" aria-label={`Energy by hour today, ${fmtKwh(view.kwh)} kWh so far`}>
          {view.hours.map((h, i) => (
            <span key={i} data-now={i === nowHour} data-none={h == null} style={{ height: h == null || max <= 0 ? undefined : `${Math.max(4, (h / max) * 100)}%` }} />
          ))}
        </div>
      ) : null}
      <span className="b-sh-card-foot">
        {view.energySensors ? `${view.kwh == null ? 'Home Assistant keeps no statistics for these yet' : view.kwhFrom}` : ''}
        {view.energySensors && view.watts != null ? ' · ' : ''}
        {view.watts != null && view.energySensors ? `${fmtWatts(view.watts)} now, ${view.wattsFrom}` : !view.energySensors ? view.wattsFrom : ''}
      </span>
      {error ? <span className="b-sh-card-foot">Today’s total could not be read: {error}</span> : null}
      {view.rows.length ? (
        <div className="b-sh-energy-rows">
          {view.rows.slice(0, 5).map((r) => (
            <div key={r.key} className="b-sh-energy-row">
              <span>{r.name}</span>
              <b className="b-num">{[r.watts != null ? fmtWatts(r.watts) : null, r.kwh != null ? `${fmtKwh(r.kwh)} kWh` : null].filter(Boolean).join(' · ') || '—'}</b>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Home Assistant's automations, each with its switch. */
function AutomationsCard({ live, inert }: { live: UseSmartHome; inert: boolean }) {
  const list = live.snapshot.automations;
  const now = Date.now();
  return (
    <section className="b-sh-card b-sh-autos" aria-label="Automations">
      <span className="b-card-title">Home Assistant runs these</span>
      {list.length ? list.map((a) => {
        const pending = live.automationPending[a.id];
        const on = pending ?? a.on;
        const fired = a.lastTriggered ? clockLabel(a.lastTriggered, now) : null;
        return (
          <div key={a.id} className={`b-sh-auto${!a.available ? ' stale' : ''}`}>
            <span className="b-sh-auto-text">
              <b>{a.label}</b>
              <span>{!a.available ? 'Not responding' : pending !== undefined ? (pending ? 'Switching on…' : 'Switching off…') : fired ? `Last ran ${fired}` : 'Has not run yet'}</span>
            </span>
            <Switch on={on} label={a.label} disabled={inert || !a.available} busy={pending !== undefined} onChange={(v) => live.setAutomation(a.id, v)} />
          </div>
        );
      }) : (
        <p className="b-sh-card-p">{!live.usable ? 'Automations are read from Home Assistant, in the Mac app.' : live.snapshot.bridgeState === 'none' ? 'Link Home Assistant and its automations show here, with their switches.' : 'Your Home Assistant has no automations. Atlas lists them; it does not invent them.'}</p>
      )}
      {list.length ? <p className="b-sh-card-p">Switching one off stops it from running on its triggers; it does not stop a run already under way. Only your tap here changes them — Atlas never does it on its own.</p> : null}
    </section>
  );
}

/** Which scene or script each mode runs. */
function ModesCard({ live, inert }: { live: UseSmartHome; inert: boolean }) {
  const { snapshot } = live;
  const [busy, setBusy] = useState<HomeMode | null>(null);
  const locked = new Set(snapshot.lockedSceneIds);
  const choose = (mode: HomeMode, id: string) => {
    setBusy(mode);
    live.mapMode(mode, id || null).catch(() => { /* the hook shows the error */ }).finally(() => setBusy(null));
  };
  return (
    <section className="b-sh-card" aria-label="Modes">
      <span className="b-card-title">Modes</span>
      <p className="b-sh-card-p">Each mode runs the scene or script you choose for it in Home Assistant. Ones that might touch a lock stay out — run those from Home Assistant.</p>
      {HOME_MODES.map((m) => {
        const row = snapshot.modes.map.find((x) => x.mode === m);
        const missing = !!row?.externalId && !row.routineId;
        return (
          <label key={m} className="b-sh-mode-map">
            <span className="b-sh-mode-name"><i style={{ background: MODE_DOT[m] }} />{MODE_LABEL[m]}</span>
            <select
              className="b-sh-select" value={row?.routineId ?? ''} disabled={inert || busy === m}
              aria-label={`What ${MODE_LABEL[m]} runs`} onChange={(e) => choose(m, e.target.value)}
            >
              <option value="">{missing ? `${row?.label ?? 'A routine'} (no longer reported)` : 'Nothing — only marks the mode'}</option>
              {snapshot.scenes.length ? (
                <optgroup label="Scenes">
                  {snapshot.scenes.map((sc) => <option key={sc.id} value={sc.id} disabled={locked.has(sc.id)}>{sc.label}{locked.has(sc.id) ? ' · may touch a lock' : ''}</option>)}
                </optgroup>
              ) : null}
              {snapshot.scripts.length ? (
                <optgroup label="Scripts">
                  {snapshot.scripts.map((sc) => <option key={sc.id} value={sc.id} disabled={!sc.runnable}>{sc.label}{!sc.runnable ? ' · may touch a lock' : ''}</option>)}
                </optgroup>
              ) : null}
            </select>
          </label>
        );
      })}
    </section>
  );
}

/** Atlas' tips, each with the one action the screen can take on it. */
function TipsCard({ tips, inert, onSet, onOpen }: { tips: Tip[]; inert: boolean; onSet: (ids: string[], value: number) => void; onOpen: (id: string) => void }) {
  if (!tips.length) return null;
  return (
    <div className="b-sh-tips" role="status">
      {tips.slice(0, 3).map((t) => (
        <div key={t.id} className="b-sh-tip">
          <span><strong>Atlas:</strong> {t.text}</span>
          {t.action ? (
            <button
              type="button" className="b-btn b-btn--card b-btn--row" disabled={inert && t.action.kind === 'set'}
              onClick={() => {
                const a = t.action;
                if (!a) return;
                if (a.kind === 'set') onSet(a.deviceIds, a.value);
                else onOpen(a.deviceId);
              }}
            >{t.action.label}</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** What the selected device did, and what Atlas told it to do. */
function HistoryCard({ device, events, error, keptDays }: { device: LiveDevice | null; events: HomeEvent[]; error: string | null; keptDays: number }) {
  const mine = device ? events.filter((e) => e.deviceId === device.id).slice(0, 8) : [];
  const now = Date.now();
  return (
    <section className="b-sh-card" aria-label="History">
      <span className="b-card-title">{device ? `${device.name}, lately` : 'History'}</span>
      {error ? <p className="b-sh-card-p">The history could not be read: {error}</p> : null}
      {device && mine.length ? (
        <div className="b-sh-history">
          {mine.map((e) => (
            <div key={e.id} className="b-sh-history-row" data-kind={e.kind}>
              <span className="b-num">{clockLabel(e.at, now) ?? ''}</span>
              <span>{historyLine(e, device)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="b-sh-card-p">
          {device ? 'Nothing recorded for it this week. ' : ''}
          Atlas keeps what your devices do and what it tells them, on this Mac, for {keptDays} days. Sensor readings are not kept.
        </p>
      )}
    </section>
  );
}

const BetaSmartHome = () => {
  const navigate = useBetaNavigate();
  const live = useSmartHome();
  const { snapshot } = live;
  const { weather, isFallback: weatherSample } = useWeather();
  const reduced = useReducedMotion();

  const [roomId, setRoomId] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [sphereEl, setSphereEl] = useState<HTMLButtonElement | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [mod, setMod] = useState<Devices3d | null>(null);
  const [three, setThree] = useState<ThreeState>('loading');
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [unlinkArmed, setUnlinkArmed] = useState(false);
  const [sceneRunning, setSceneRunning] = useState<string | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const stageKey = useRef('');
  /** The level each dimmable device last ran at, so "On" brings it back there. */
  const lastOn = useRef<Record<string, number>>({});

  // The header sphere is this screen's talk entry point.
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      // Esc steps out one level: an armed unlink first, then the screen.
      if (unlinkArmed) { setUnlinkArmed(false); return; }
      navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, unlinkArmed]);

  // three.js arrives after the page does, and only here.
  useEffect(() => {
    let alive = true;
    import('@/lib/devices3d')
      .then((m) => { if (alive) { setMod(m); setThree('ready'); } })
      .catch(() => { if (alive) setThree('failed'); });
    return () => { alive = false; };
  }, []);

  const rooms = snapshot.rooms;
  const allDevices = useMemo(() => rooms.flatMap((r) => r.devices), [rooms]);
  const byId = useMemo(() => new Map(allDevices.map((d) => [d.id, d])), [allDevices]);
  const room = useMemo(() => rooms.find((r) => r.id === roomId) ?? rooms[0] ?? null, [rooms, roomId]);
  const device = useMemo(() => room?.devices.find((d) => d.id === selId) ?? room?.devices[0] ?? null, [room, selId]);

  useEffect(() => {
    for (const d of allDevices) if (d.value > 0 && (d.control === 'slider' || d.control === 'colour')) lastOn.current[d.id] = d.value;
  }, [allDevices]);

  const pickRoom = useCallback((id: string) => { setRoomId(id); setSelId(null); }, []);
  const pickDevice = useCallback((d: LiveDevice) => {
    const home = rooms.find((r) => r.devices.some((x) => x.id === d.id));
    if (home) setRoomId(home.id);
    setSelId(d.id);
  }, [rooms]);

  // The live stage: mounted while its canvas exists, which is while there is
  // a device to show, three.js has loaded, and motion is welcome. An empty
  // house therefore runs no render loop at all.
  useEffect(() => {
    if (!mod || !canvasEl) return;
    let stage: Stage;
    try { stage = mod.mountStage(canvasEl, { bg: STAGE_BG }); } catch { setThree('failed'); return; }
    stageRef.current = stage;
    stageKey.current = '';
    return () => { stage.destroy(); stageRef.current = null; };
  }, [mod, canvasEl]);

  const deviceKey = device ? `${device.id}|${JSON.stringify(stageStateOf(device))}` : '';
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !device || stageKey.current === deviceKey) return;
    stageKey.current = deviceKey;
    stage.set(stageKindOf(device.kind), stageStateOf(device));
  }, [device, deviceKey, mod, canvasEl]);

  const thumbs = useMemo(() => {
    const out: Record<string, string> = {};
    if (!mod || !room) return out;
    for (const d of room.devices) { const u = safeThumb(mod, d, THUMB_PX); if (u) out[d.id] = u; }
    return out;
  }, [mod, room]);
  const still = useMemo(() => (reduced && device ? safeThumb(mod, device, STILL_PX) : null), [reduced, device, mod]);

  const recent = useMemo(
    () => snapshot.recentIds.map((id) => byId.get(id)).filter((d): d is LiveDevice => !!d).slice(0, 6),
    [snapshot.recentIds, byId],
  );

  // A scene is "running" from the tap until the hook records it as applied or
  // reports why it was not — the design's busy sphere, for as long as it is true.
  // Only a NEW error ends it: the run itself clears the previous one on its
  // way out, and that must not read as the run having failed.
  const lastRunAt = live.lastSceneRun?.at ?? 0;
  useEffect(() => { setSceneRunning(null); }, [lastRunAt]);
  useEffect(() => { if (live.error) setSceneRunning(null); }, [live.error]);
  useEffect(() => {
    if (!sceneRunning) return;
    const t = window.setTimeout(() => setSceneRunning(null), SCENE_PATIENCE_MS);
    return () => window.clearTimeout(t);
  }, [sceneRunning]);
  const runScene = useCallback((id: string) => { setSceneRunning(id); live.runScene(id); }, [live]);

  // Ticks while the screen is open: "applied a minute ago", the lock note's
  // day, and the tips' "late at night" all read the clock.
  const now = useTick(30_000, true);
  // The tick only moves every thirty seconds, so a run newer than it would read
  // as being in the future; it is at least "just now".
  const sceneAgo = live.lastSceneRun ? relativeLabel(new Date(live.lastSceneRun.at).toISOString(), Math.max(now, live.lastSceneRun.at)) : null;

  // The temperatures are readings, and two things would make them lie. An
  // unreachable thermostat's last reading is history, not the temperature
  // inside, so only answering devices count. And while a stepper command is in
  // flight the hook shows the REQUESTED degree as the device's value — right
  // for the stepper, wrong for "21° inside" — so a pending device counts with
  // the last reading it settled on.
  const settled = useRef<Record<string, number>>({});
  const readings = useMemo(() => allDevices.filter((d) => d.available).map((d) => {
    if (!d.pending) { settled.current[d.id] = d.value; return d; }
    const v = settled.current[d.id];
    return v == null ? d : { ...d, value: v };
  }), [allDevices]);
  const tempOf = useCallback((roomDevices: readonly LiveDevice[]) => {
    const ids = new Set(roomDevices.map((d) => d.id));
    return roomTemp(readings.filter((d) => ids.has(d.id)));
  }, [readings]);
  const inside = roomTemp(readings);
  const onCount = countOn(allDevices);
  const outside = fToC(weather.temp);
  const hasBridge = snapshot.bridgeState !== 'none';
  const outage = hasBridge && snapshot.bridgeState !== 'connected';
  const haBridge = snapshot.bridges.find((b) => b.kind === 'home_assistant');
  const usable = live.usable;
  /** Nothing can be commanded: the browser, signed out, or a bridge that is not answering. */
  const inert = !usable || outage;
  const musicRoutable = isRoutable('/music');

  const pill = !usable ? { tone: 'paused', text: 'Mac app only' }
    : live.syncing ? { tone: 'syncing', text: 'Syncing…' }
      : outage ? { tone: 'failed', text: snapshot.bridgeState === 'unauthorised' ? 'Token rejected' : snapshot.bridgeState === 'unavailable' ? 'Unavailable' : 'Not answering' }
        : hasBridge ? { tone: 'ready', text: 'Connected' }
          : { tone: 'paused', text: 'No bridge' };

  const doSync = useCallback(() => { void live.sync(); }, [live]);
  const doUnlink = useCallback(() => { setUnlinkArmed(false); void live.unlink(haBridge?.kind ?? 'home_assistant'); }, [live, haBridge]);
  const setValue = useCallback((v: number) => { if (device) live.setDeviceValue(device.id, v); }, [live, device]);

  const roomsEmpty = !usable ? 'Rooms appear in the Mac app.' : hasBridge ? 'Your bridge reports no rooms yet.' : 'Rooms arrive with a connected home.';
  const stageEmpty = !usable
    ? 'Atlas Smart Home runs in the Mac app. Nothing is read from a bridge in the browser.'
    : live.loading ? 'Reading Atlas’ home store…'
      : hasBridge ? (room ? `${room.name} has no devices in it yet.` : 'Your bridge has reported no devices yet.')
        : 'Connect Home Assistant and its devices appear here, as it names them.';

  const ctl = device ? controlKind(device) : null;
  const dOn = !!device && device.value > 0;
  const secured = !!device && isSecured(device);
  const pow = device ? powerLabel(device) : null;
  const sphereState = live.syncing || live.linking || sceneRunning || live.modePending ? 'working' : undefined;

  // The Beta extras: the history Atlas keeps, today's energy, the tips, the
  // Home/Away suggestion, the camera's events and its still.
  const extrasOn = usable && hasBridge;
  const { events, error: historyError, keptDays } = useHomeHistory(live, extrasOn);
  const energySensors = useMemo(() => allDevices.filter((d) => d.deviceClass === 'energy').length, [allDevices]);
  const { today: energyToday, error: energyError } = useEnergyToday(live, energySensors, extrasOn && !outage);
  const modes = snapshot.modes;
  const currentMode = modes.current;
  const tips = useMemo(
    () => (extrasOn ? homeTips({ devices: allDevices, events, mode: currentMode, nowMs: now }) : []),
    [extrasOn, allDevices, events, currentMode, now],
  );
  const suggestion = useMemo(() => presenceSuggestion(snapshot.presence, currentMode), [snapshot.presence, currentMode]);
  const lockLine = device && (ctl === 'lock' || ctl === 'garage') ? lockNote(device, events, now) : null;
  const camLine = device && ctl === 'camera' ? cameraEventLine(lastMotion(cameraSensors(device, allDevices), events), now) : null;
  const [camShot, setCamShot] = useState<{ id: string; url: string; at: string } | null>(null);
  const [stillBusy, setStillBusy] = useState(false);
  const [stillError, setStillError] = useState<string | null>(null);
  useEffect(() => { setStillError(null); }, [device?.id]);
  const askStill = useCallback((id: string) => {
    setStillBusy(true);
    setStillError(null);
    live.cameraStill(id)
      .then((r) => setCamShot({ id, url: r.dataUrl, at: r.at }))
      .catch((e) => setStillError(errText(e)))
      .finally(() => setStillBusy(false));
  }, [live]);
  const setMany = useCallback((ids: string[], value: number) => { for (const id of ids) live.setDeviceValue(id, value); }, [live]);
  const openDevice = useCallback((id: string) => { const d = byId.get(id); if (d) pickDevice(d); }, [byId, pickDevice]);
  const modeTitle = (m: HomeMode): string => {
    const row = modes.map.find((x) => x.mode === m);
    if (inert) return outage ? 'The bridge is not answering' : 'Modes run in the Mac app';
    if (row?.label) return `${MODE_LABEL[m]} runs ${row.label}`;
    return `Nothing is chosen for ${MODE_LABEL[m]} yet — pick a scene under Modes. Switching only marks the mode.`;
  };

  return (
    <div className="b-sh" data-screen-label="Beta — Smart home">
      <header className="b-sh-head">
        <button type="button" className="b-sh-sphere" ref={setSphereEl} aria-label="Talk to Atlas" title="Talk to Atlas · ⌥ Space" onClick={() => openTalk()}>
          <VeilSphere size="mini" bg="transparent" tone={[249, 247, 244]} state={sphereState} />
        </button>
        <div className="b-sh-head-text">
          <button type="button" className="b-sh-back" title="Back to Home · Esc" onClick={() => navigate('/')}>Home · {snapshot.hub?.name ?? 'No hub'}</button>
          <div className="b-sh-head-line">
            <span className="b-sh-inside">{fmtTemp(inside)}</span>
            <span className="b-sh-head-sub">
              {inside != null ? 'inside' : 'no reading inside'} · {outside}° and {weather.condition.toLowerCase()} out
              {weatherSample ? <span className="sampleB" title="Sample weather — no reading has arrived yet">Sample</span> : null}
              {' · '}<span className="b-sh-nowrap">{onCount} on</span>
            </span>
          </div>
        </div>
        <div className="b-sh-modes" role="group" aria-label="Mode">
          {HOME_MODES.map((m) => {
            const cur = modes.current === m;
            const pendingHere = live.modePending === m;
            return (
              <button
                type="button" key={m} className={`b-sh-mode${cur ? ' on' : ''}`} aria-pressed={cur} disabled={inert || !!live.modePending}
                title={modeTitle(m)} onClick={() => live.setMode(m)}
              >
                <i style={{ background: MODE_DOT[m] }} />{pendingHere ? `${MODE_LABEL[m]}…` : MODE_LABEL[m]}
              </button>
            );
          })}
        </div>
        <div className="b-sh-head-tools">
          <span className={`b-status b-status--${pill.tone}`}><i />{pill.text}</span>
          {usable && hasBridge ? <button type="button" className="b-btn b-btn--card" disabled={live.syncing} onClick={doSync}><AtlasIcon name="sync" size={15} weight={1.8} />{live.syncing ? 'Syncing…' : 'Sync'}</button> : null}
        </div>
      </header>

      {!usable && live.unusableReason ? (
        <div className="b-sh-notice" role="note">
          <AtlasIcon name="mac" size={18} weight={1.7} />
          <div><b>Nothing is being read</b><span>{live.unusableReason} The rooms, devices and scenes below come from Home Assistant on your own network, which only the Mac app can reach.</span></div>
        </div>
      ) : null}
      {live.error ? (
        <div className="b-sh-notice b-sh-notice--bad" role="alert">
          <AtlasIcon name="warning" size={18} weight={1.7} />
          <div><b>That did not happen</b><span>{live.error}</span></div>
          <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={live.dismissError}>Dismiss</button>
        </div>
      ) : null}
      {live.warning ? (
        <div className="b-sh-notice" role="note">
          <AtlasIcon name="offline" size={18} weight={1.7} />
          <div><b>Working, with something switched off</b><span>{live.warning}</span></div>
          <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={live.dismissWarning}>Dismiss</button>
        </div>
      ) : null}
      {suggestion && !inert ? (
        <div className="b-sh-notice b-sh-notice--suggest" role="note">
          <AtlasIcon name="home" size={18} weight={1.7} />
          <div><b>Switch to {MODE_LABEL[suggestion.mode]}?</b><span>{suggestion.text} Atlas only suggests it; switching runs what you chose for {MODE_LABEL[suggestion.mode]}.</span></div>
          <button type="button" className="b-btn b-btn--card b-btn--row" disabled={!!live.modePending} onClick={() => live.setMode(suggestion.mode)}>Switch to {MODE_LABEL[suggestion.mode]}</button>
        </div>
      ) : null}

      <div className="b-sh-scenes nosb" role="group" aria-label="Scenes">
        {snapshot.scenes.map((s) => {
          // "Atlas applied it", never "the house is in it": no bridge reports
          // a current scene, so the pill marks Atlas' own last act.
          const ran = live.lastSceneRun?.id === s.id;
          const running = sceneRunning === s.id;
          return (
            <button type="button" key={s.id} className={`b-sh-scene${ran ? ' ran' : ''}`} disabled={inert || running} title={outage ? 'The bridge is not answering' : `Run ${s.label}`} onClick={() => runScene(s.id)}>
              <span className="b-sh-scene-sw">{sceneInitial(s.label)}</span>
              <span className="b-sh-scene-text"><span>{s.label}</span><span>{running ? 'Running…' : ran ? `Atlas applied it${sceneAgo ? ` ${sceneAgo}` : ''}` : 'Scene · tap to run'}</span></span>
            </button>
          );
        })}
        {!snapshot.scenes.length ? (
          <span className="b-sh-scenes-empty">{!usable ? 'Scenes run in the Mac app.' : hasBridge ? 'Your bridge reports no scenes. Atlas does not invent them.' : 'Scenes arrive with a connected home — Atlas does not invent them.'}</span>
        ) : null}
      </div>

      <div className="b-sh-grid">
        <nav className="b-sh-rooms nosb" aria-label="Rooms">
          {rooms.map((r) => {
            const cur = r.id === room?.id;
            const t = tempOf(r.devices);
            return (
              <button type="button" key={r.id} className={`b-sh-room${cur ? ' on' : ''}`} aria-current={cur ? 'page' : undefined} onClick={() => pickRoom(r.id)}>
                <span className="b-sh-room-top"><span>{r.name}</span>{t != null ? <span className="b-sh-room-temp">{fmtTemp(t)}</span> : null}</span>
                <span className="b-sh-room-sub" title={r.status || undefined}><i data-tone={r.tone} />{r.tone === 'ok' ? roomSub(r.devices) : r.status}</span>
              </button>
            );
          })}
          {!rooms.length ? <span className="b-sh-rooms-empty">{roomsEmpty}</span> : null}
        </nav>

        <section className="b-sh-main" aria-label={room ? room.name : 'Devices'}>
          <div className={`b-sh-stage${device && !device.available ? ' stale' : ''}`}>
            {device && !reduced && three !== 'failed' && camShot?.id !== device.id ? <canvas ref={setCanvasEl} className="b-sh-canvas" aria-hidden /> : null}
            {device && reduced && still && camShot?.id !== device.id ? <img className="b-sh-still" src={still} alt="" /> : null}
            {device && camShot?.id === device.id ? <img className="b-sh-still b-sh-camshot" src={camShot.url} alt={`${device.name}, still frame`} /> : null}
            <div className="b-sh-stage-head">
              <div>
                <span className="b-sh-stage-room">{room?.name ?? 'No room'}</span>
                <span className="b-sh-stage-name">{device?.name ?? (usable ? 'Nothing to show' : 'Runs in the Mac app')}</span>
                {device ? <span className={`b-sh-stage-status${!device.available ? ' stale' : ''}`}><i data-on={lit(device)} />{statusOf(device)}</span> : null}
              </div>
              {device && !reduced && three === 'ready' ? <span className="b-sh-stage-hint">Drag to turn</span> : null}
            </div>
            {device && !reduced && three === 'loading' ? <div className="b-sh-stage-note">Loading the model…</div> : null}
            {device && three === 'failed' ? <div className="b-sh-stage-note">The 3D model needs WebGL, which this window does not have. The controls still work.</div> : null}
            {!device ? <div className="b-sh-stage-note b-sh-stage-empty">{stageEmpty}</div> : null}

            {device && ctl ? (
              <div className="b-sh-controls">
                {hasPower(device) && pow ? (
                  <button type="button" role="switch" aria-checked={dOn} aria-label={pow.name} disabled={inert} className={`b-sh-pow${dOn ? ' on' : ''}`} onClick={() => setValue(powerValue(device, lastOn.current[device.id]))}>{pow.text}</button>
                ) : null}

                {ctl === 'light' ? (
                  <>
                    <RangeField value={device.value} min={1} max={100} fill={device.colour ?? WARM} ariaLabel="Brightness" disabled={inert} readout={(v) => `${v}%`} onCommit={setValue} />
                    {device.control === 'colour' ? (
                      <div className="b-sh-swatches" role="group" aria-label="Colour">
                        {SWATCHES.map((w) => (
                          <button type="button" key={w.c} aria-label={w.l} title={w.l} aria-pressed={device.colour?.toLowerCase() === w.c} disabled={inert} className="b-sh-swatch" style={{ background: w.c }} onClick={() => live.setDeviceColour(device.id, w.c)} />
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : null}

                {ctl === 'thermostat' ? (
                  <>
                    <div className="b-sh-stepper">
                      <button type="button" aria-label="Cooler" disabled={inert} onClick={() => setValue(stepTemp(stepperValue(device), -0.5))}>−</button>
                      <span className="b-num">{fmtTemp(stepperValue(device))}</span>
                      <button type="button" aria-label="Warmer" disabled={inert} onClick={() => setValue(stepTemp(stepperValue(device), 0.5))}>+</button>
                    </div>
                    {/* For a device that is not answering, the truth line below says what the number is. */}
                    {device.available ? <span className="b-sh-ctl-note">{thermNote(device)}</span> : null}
                  </>
                ) : null}

                {ctl === 'lock' ? (
                  <>
                    <button type="button" className={`b-sh-lock${secured ? ' locked' : ''}`} disabled={inert} onClick={() => setValue(secured ? 0 : 1)}>{secured ? 'Locked · tap to unlock' : 'Unlocked · tap to lock'}</button>
                    <span className="b-sh-ctl-note">{lockLine ? `${lockLine}. ` : ''}Locks ask for your approval every time — Atlas never turns one on its own.</span>
                  </>
                ) : null}

                {ctl === 'garage' ? (
                  <>
                    {/* Commanded as a lock (closed = locked), read as a position. */}
                    <button type="button" className={`b-sh-lock${secured ? ' locked' : ''}`} disabled={inert} onClick={() => setValue(secured ? 0 : 1)}>{secured ? 'Closed · tap to open' : 'Open · tap to close'}</button>
                    <span className="b-sh-ctl-note">{lockLine ? `${lockLine}. ` : ''}A garage door is a lock to Atlas: it asks for your approval every time.</span>
                  </>
                ) : null}

                {ctl === 'speaker' ? (
                  <>
                    <RangeField value={device.value} min={0} max={100} ariaLabel="Volume" disabled={inert} readout={(v) => `Volume ${v}%`} onCommit={setValue} />
                    {musicRoutable && device.kind === 'speaker' ? <button type="button" className="b-sh-link" onClick={() => navigate('/music')}>Open Music</button> : null}
                  </>
                ) : null}

                {ctl === 'camera' ? (
                  <>
                    <span className="b-sh-live"><i data-on={lit(device)} />{camLine ?? statusOf(device)}</span>
                    <button type="button" className="b-sh-link" disabled={inert || stillBusy} onClick={() => askStill(device.id)}>{stillBusy ? 'Fetching…' : camShot?.id === device.id ? 'New still' : 'Show a still'}</button>
                    <span className="b-sh-ctl-note">
                      {stillError ? `No still: ${stillError} ` : ''}
                      {camShot?.id === device.id ? `Still from ${clockLabel(camShot.at, now) ?? 'just now'}, fetched from your hub and kept only on this screen. ` : ''}
                      {camLine ? '' : 'No motion sensor of this camera’s has reported yet. '}Recordings stay on your home hub — Atlas keeps none.
                    </span>
                  </>
                ) : null}

                {ctl === 'blinds' ? (
                  <RangeField value={device.value} min={0} max={100} ariaLabel="Open" disabled={inert} readout={(v) => `${v}% open`} onCommit={setValue} />
                ) : null}

                {ctl === 'level' ? (
                  <RangeField value={device.value} min={0} max={100} ariaLabel={`${device.name} level`} disabled={inert} readout={(v) => `${v}%`} onCommit={setValue} />
                ) : null}

                {ctl === 'generic' ? (
                  // The Workshop's control for what the design never drew (a fan's
                  // speeds, a sensor's "reports only" pill). Its buttons take no
                  // `disabled`, so the fieldset carries it for them.
                  <fieldset className="b-sh-generic" disabled={inert}>
                    <DeviceControl device={device} onValue={setValue} onColour={(c) => live.setDeviceColour(device.id, c)} />
                  </fieldset>
                ) : null}

                {device.note ? (
                  <p className="b-sh-truth" data-tone={device.note.tone} role="status">{device.note.text}</p>
                ) : !device.available ? (
                  <p className="b-sh-truth" data-tone="stale" role="status">
                    Not responding. The reading above is the last one Atlas received
                    {device.lastKnownState ? ` — “${device.lastKnownState}”` : ''}{device.lastChanged ? `, ${device.lastChanged}` : ''}. It is not a claim about now.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          {room?.devices.length ? (
            <div className="b-sh-devices">
              {room.devices.map((v) => {
                const sel = v.id === device?.id;
                const img = thumbs[v.id];
                return (
                  <button type="button" key={v.id} className={`b-sh-tile${sel ? ' on' : ''}${!v.available ? ' stale' : ''}`} aria-pressed={sel} onClick={() => setSelId(v.id)}>
                    <span className="b-sh-tile-img" style={img ? { backgroundImage: `url(${img})` } : undefined}>{!img ? <AtlasIcon name={ICON_OF[stageKindOf(v.kind)]} size={28} weight={1.5} /> : null}</span>
                    <span className="b-sh-tile-row"><span className="b-sh-tile-name">{v.name}</span><i className="b-sh-dot" data-on={lit(v)} /></span>
                    <span className="b-sh-tile-status">{statusOf(v)}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>

        <aside className="b-sh-aside">
          <section className="b-sh-card b-sh-card--ink" aria-label="Hub">
            {/* A linked bridge with no hub row (it has not synced yet, or it is
                down) is still linked — never "Nothing linked". */}
            <span className="b-sh-card-eyebrow">{snapshot.hub ? 'Home hub' : hasBridge ? 'Bridge' : 'No hub'}</span>
            <span className="b-sh-card-big">{snapshot.hub?.name ?? (hasBridge ? haBridge?.name ?? snapshot.bridges[0]?.name ?? 'Home Assistant' : usable ? 'Nothing linked' : 'Mac app only')}</span>
            <div className="b-sh-facts">
              <div><b className="b-num">{snapshot.counts.devices}</b><span>devices</span></div>
              <div><b className="b-num">{snapshot.counts.rooms}</b><span>rooms</span></div>
              <div><b className="b-num">{snapshot.counts.scenes}</b><span>scenes</span></div>
              {snapshot.counts.unavailable ? <div><b className="b-num">{snapshot.counts.unavailable}</b><span>not responding</span></div> : null}
            </div>
            <span className="b-sh-card-foot">
              {snapshot.hub ? snapshot.hub.lastSyncLabel : snapshot.lastReachedLabel ? `Last reached ${snapshot.lastReachedLabel}` : usable ? 'Nothing has been read from a bridge yet.' : 'Smart home runs in the Mac app.'}
            </span>
            {usable && hasBridge ? (
              <div className="b-sh-card-actions">
                <button type="button" className="b-btn b-btn--onink b-btn--row" disabled={live.syncing} onClick={doSync}>{live.syncing ? 'Syncing…' : 'Sync now'}</button>
                <button type="button" className="b-btn b-btn--onink b-btn--row" aria-expanded={bridgeOpen} onClick={() => { setBridgeOpen((v) => !v); setUnlinkArmed(false); }}>{bridgeOpen ? 'Hide bridge settings' : 'Bridge settings'}</button>
              </div>
            ) : null}
          </section>

          <EnergyCard devices={allDevices} today={energyToday} error={energyError} usable={usable} hasBridge={hasBridge} />
          <AutomationsCard live={live} inert={inert} />
          <TipsCard tips={tips} inert={inert} onSet={setMany} onOpen={openDevice} />
          {extrasOn ? <HistoryCard device={device} events={events} error={historyError} keptDays={keptDays} /> : null}
          {extrasOn ? <ModesCard live={live} inert={inert} /> : null}

          <section className="b-sh-card" aria-label="Bridge">
            <span className="b-card-title">Bridge</span>
            {!usable ? (
              <p className="b-sh-card-p">Home Assistant is on your own network, and only the Mac app can reach it. Open Atlas on the Mac to link it.</p>
            ) : outage ? (
              <OutageNotice state={snapshot.bridgeState} lastReached={snapshot.lastReachedLabel} onRetry={doSync} onSetup={() => setBridgeOpen(true)} retrying={live.syncing} />
            ) : !hasBridge ? (
              <LinkForm onLink={live.linkHomeAssistant} linking={live.linking} />
            ) : (
              <p className="b-sh-card-p">Home Assistant is linked. Rooms, devices and scenes are mirrored from it; Atlas adds nothing of its own, and writes commands only — never a renamed room back.</p>
            )}
            {hasBridge && snapshot.bridges.length ? (
              <div className="b-sh-bridges">
                {snapshot.bridges.map((b) => {
                  const p = bridgePill(b);
                  return (
                    <div key={b.id} className="b-sh-bridge">
                      <span className="b-sh-bridge-text"><b>{b.name}</b><span>{b.detail}</span></span>
                      <span className={`b-status b-status--${p.tone}`}><i />{p.text}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {usable && hasBridge && bridgeOpen ? (
              <div className="b-sh-unlink">
                {unlinkArmed ? (
                  <>
                    <span className="b-sh-card-p">Unlinking removes the mirrored rooms and devices from Atlas and deletes the token from the Keychain. It changes nothing in Home Assistant.</span>
                    <div className="b-sh-card-actions">
                      <button type="button" className="b-btn b-btn--danger-fill b-btn--row" onClick={doUnlink}>Unlink Home Assistant</button>
                      <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setUnlinkArmed(false)}>Keep it</button>
                    </div>
                  </>
                ) : (
                  <button type="button" className="b-btn b-btn--danger b-btn--row" onClick={() => setUnlinkArmed(true)}>{snapshot.bridgeState === 'unauthorised' ? 'Unlink, then link with a new token' : 'Unlink…'}</button>
                )}
              </div>
            ) : null}
          </section>

          <section className="b-sh-card" aria-label="Recently used">
            <span className="b-card-title">Recently used</span>
            {recent.length ? (
              <div className="b-sh-recents">
                {recent.map((d) => {
                  const img = safeThumb(mod, d, RECENT_PX);
                  return (
                    <button type="button" key={d.id} className={`b-row clickable b-sh-recent${d.id === device?.id ? ' on' : ''}`} onClick={() => pickDevice(d)}>
                      <span className="b-sh-recent-img" style={img ? { backgroundImage: `url(${img})` } : undefined}>{!img ? <AtlasIcon name={ICON_OF[stageKindOf(d.kind)]} size={16} weight={1.6} /> : null}</span>
                      <span className="b-sh-recent-text"><b>{d.name}</b><span>{[d.roomName, statusOf(d)].filter(Boolean).join(' · ')}</span></span>
                      <i className="b-sh-dot" data-on={lit(d)} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="b-sh-card-p">{usable ? 'Nothing has been operated yet — this fills in as you and Atlas touch things.' : 'What you and Atlas touch shows up here, in the Mac app.'}</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
};

export default BetaSmartHome;
