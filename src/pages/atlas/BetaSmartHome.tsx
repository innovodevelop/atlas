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
 * What the design shows and this screen does not: the Home/Away/Night modes,
 * the energy card, the automation switches and the Atlas tip. Atlas has no
 * source for any of them — no presence, no meter, no scheduler, no history —
 * so none is drawn rather than drawn from nothing.
 *
 * three.js is loaded lazily inside an effect, so it stays out of the main
 * bundle, and the stage only exists while there is a device to put on it.
 * Under prefers-reduced-motion the turning stage is a still render of the
 * same model.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { relativeLabel, useSmartHome, type LiveBridge, type LiveDevice } from '@/hooks/useSmartHome';
import { useWeather } from '@/hooks/useWeather';
import { isRoutable } from '@/surfaces';
import type { Stage, StageKind } from '@/lib/devices3d';
import {
  SWATCHES, controlKind, countOn, fToC, fmtTemp, hasPower, isSecured, lit, powerLabel, powerValue, roomSub, roomTemp, sceneInitial,
  stageKindOf, stageStateOf, statusOf, stepTemp, thermNote,
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

  const now = useTick(30_000, !!live.lastSceneRun);
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
  const sphereState = live.syncing || live.linking || sceneRunning ? 'working' : undefined;

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
            {device && !reduced && three !== 'failed' ? <canvas ref={setCanvasEl} className="b-sh-canvas" aria-hidden /> : null}
            {device && reduced && still ? <img className="b-sh-still" src={still} alt="" /> : null}
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
                      <button type="button" aria-label="Cooler" disabled={inert} onClick={() => setValue(stepTemp(device.value, -0.5))}>−</button>
                      <span className="b-num">{fmtTemp(device.value)}</span>
                      <button type="button" aria-label="Warmer" disabled={inert} onClick={() => setValue(stepTemp(device.value, 0.5))}>+</button>
                    </div>
                    {/* For a device that is not answering, the truth line below says what the number is. */}
                    {device.available ? <span className="b-sh-ctl-note">{thermNote(device)}</span> : null}
                  </>
                ) : null}

                {ctl === 'lock' ? (
                  <>
                    <button type="button" className={`b-sh-lock${secured ? ' locked' : ''}`} disabled={inert} onClick={() => setValue(secured ? 0 : 1)}>{secured ? 'Locked · tap to unlock' : 'Unlocked · tap to lock'}</button>
                    <span className="b-sh-ctl-note">Locks ask for your approval every time — Atlas never turns one on its own.</span>
                  </>
                ) : null}

                {ctl === 'garage' ? (
                  <>
                    {/* Commanded as a lock (closed = locked), read as a position. */}
                    <button type="button" className={`b-sh-lock${secured ? ' locked' : ''}`} disabled={inert} onClick={() => setValue(secured ? 0 : 1)}>{secured ? 'Closed · tap to open' : 'Open · tap to close'}</button>
                    <span className="b-sh-ctl-note">A garage door is a lock to Atlas: it asks for your approval every time.</span>
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
                    <span className="b-sh-live"><i data-on={lit(device)} />{statusOf(device)}</span>
                    <span className="b-sh-ctl-note">Recordings stay on your home hub — Atlas keeps none.</span>
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
