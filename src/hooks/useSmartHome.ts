/**
 * Smart home — the real adapter.
 *
 * This replaces `useSmartHome()` from `@/lib/mocks/smartHome`. The mock file
 * stays: it is the CONTRACT (`SmartHomeState`, `SmartDevice`, `SmartRoom`, …)
 * and the Rust module projects its field names deliberately. Everything below
 * returns those names and adds fields the mock never needed, all of which are
 * about one thing: telling the truth when the house is not answering.
 *
 * ── THE THREE STATES THIS FILE EXISTS FOR ───────────────────────────────────
 *
 * 1. NO BRIDGE. The common case, and a first-class state — not an empty room
 *    list. `bridgeConnected: false` with a headline that says Atlas has no
 *    bridge, and `linkHomeAssistant()` as the way out of it. A house with no
 *    bridge and a house with no devices are different sentences and must never
 *    render as the same blank grid.
 *
 * 2. STALE. `home_device_state.available` is 0 when the bridge last failed to
 *    reach a device — and Rust deliberately KEEPS the last known value rather
 *    than zeroing it (store.rs `apply_pull`). That last value is useful and it
 *    is also a trap: a lamp drawn at 62% is a claim about right now. So every
 *    unavailable device arrives here with `available: false`, its `state` line
 *    rewritten to lead with "Not responding", and its real last words moved to
 *    `lastKnownState` for the surface to show as history rather than as status.
 *    The page draws the stale treatment; this hook decides what is stale.
 *
 * 3. A FAILED ACTUATION. Optimistic UI that silently reverts is exactly the
 *    same pixels as a light that turned itself back off. So an actuation moves
 *    the control immediately (an overlay), and then one of three things is
 *    true and SAID:
 *      · the bridge confirmed it        → the overlay dissolves into real data
 *      · the command failed             → note tone `bad`, the control snaps
 *                                         back to the reported value, and the
 *                                         reason is carried on the device
 *      · nothing came back in time      → note tone `warn`: Atlas sent it, the
 *                                         bridge has not said so. NOT silence,
 *                                         and NOT a claim that it worked.
 *
 * ── WHY THE PURE FUNCTIONS ARE EXPORTED ─────────────────────────────────────
 * `decodeSnapshot`, `applyOverlays` and `deviceSetPlan` are the whole of the
 * honesty logic and none of them need React. They are exported so the test file
 * can pin them directly — the same shape `useApprovals.ts` uses, for the same
 * reason: a hook test that needs a renderer tests the renderer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri, localClient } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import type {
  AutonomyRule, Bridge, DeviceControl, DeviceKind, SmartDevice, SmartHomeSnapshot,
  SmartHomeState, SmartRoom,
} from '@/lib/mocks/smartHome';

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * Every command this hook may call, by name. Tauri v2 camelCases the Rust
 * parameter names, so `user_id` goes on the wire as `userId` — snake_case here
 * fails deserialization, which looks exactly like a command that did nothing.
 */
export const HOME_COMMANDS = {
  snapshot: 'home_snapshot',
  link: 'home_link_home_assistant',
  unlink: 'home_unlink',
  sync: 'home_sync',
  deviceSet: 'home_device_set',
  deviceColour: 'home_device_colour',
  lockSet: 'home_lock_set',
  sceneRun: 'home_scene_run',
  setAutonomy: 'home_set_autonomy',
  liveStart: 'home_live_start',
  liveStop: 'home_live_stop',
} as const;

export type InvokeFn = <T = unknown>(cmd: string, args: Record<string, unknown>) => Promise<T>;

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args);
}

/** Rust commands reject with a plain string, not an Error. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Atlas could not reach the home bridge.';
}

export const DESKTOP_ONLY = 'Atlas Smart Home only runs in the desktop app.';
export const SIGN_IN_REQUIRED = 'Sign in to use Atlas Smart Home.';
/** There is no `home_widget_set`, because there are no widgets. See below. */
export const NO_WIDGETS =
  'Atlas builds no home widgets — nothing the bridge reports is a summary it could compute without inventing one.';

// ---------------------------------------------------------------------------
// Types — the contract, plus what staleness needs
// ---------------------------------------------------------------------------

export interface LiveDevice extends SmartDevice {
  /** The bridge reached this device on its last attempt. */
  available: boolean;
  /**
   * What the mirror actually last recorded. `state` is rewritten for an
   * unavailable device so the card cannot read as current; this keeps the real
   * words so the surface can show them as history.
   */
  lastKnownState: string;
  /** An actuation is in flight (`sending`) or sent but unconfirmed (`sent`). */
  pending: OverlayPhase | null;
  /** Why the last actuation for this device did not happen, in Rust's words. */
  note: DeviceNote | null;
}

export interface LiveRoom extends SmartRoom {
  devices: LiveDevice[];
}

export interface LiveBridge extends Bridge {
  /** `home_assistant` | `homekit_companion` — what `home_unlink` wants. */
  kind: string | null;
  /** The richer column behind `state`: connected / unauthorised / unreachable. */
  health: string | null;
}

/**
 * Three states, not two.
 *
 * `bridgeConnected` is a boolean and a house has three answers: nothing has
 * ever been linked, something is linked and answering, something is linked and
 * silent. Collapsing the first and third sent a user whose hub had rebooted to
 * the day-one "connect a home" screen — offering to link a bridge that was
 * already linked, on top of a mirror holding their whole house.
 */
export type BridgeState = 'none' | 'connected' | 'unreachable' | 'unauthorised' | 'unavailable';

export interface LiveSnapshot extends SmartHomeSnapshot {
  rooms: LiveRoom[];
  bridges: LiveBridge[];
  bridgeState: BridgeState;
  /** "40 minutes ago", or null if Atlas has never completed a sync. */
  lastReachedLabel: string | null;
  counts: { devices: number; rooms: number; scenes: number; unavailable: number };
}

/** `bad` — it did not happen. `warn` — it may have; nobody has confirmed. */
export interface DeviceNote {
  tone: 'bad' | 'warn';
  text: string;
}

export type OverlayPhase = 'sending' | 'sent';

export interface DeviceOverlay {
  phase: OverlayPhase;
  value?: number;
  colour?: string;
}

export interface UseSmartHome extends SmartHomeState {
  snapshot: LiveSnapshot;
  /** False in the browser dev server or signed out — with a reason, never silence. */
  usable: boolean;
  unusableReason: string | null;
  linking: boolean;
  syncing: boolean;
  /** Non-fatal: the page still works, something around it is degraded. */
  warning: string | null;
  /** The last scene Atlas applied. No bridge reports which scene is "on". */
  lastSceneRun: { id: string; label: string; at: number } | null;
  refresh(): Promise<void>;
  linkHomeAssistant(baseUrl: string, token: string): Promise<void>;
  unlink(kind: string): Promise<void>;
  sync(): Promise<void>;
  dismissError(): void;
  dismissWarning(): void;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the wire is serde_json::Value; every field is checked below
type Raw = Record<string, any>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown): boolean => v === true;

/**
 * "2 hours ago". Mirrors `store::relative` so a timestamp reads the same in
 * both halves of the app, and returns null for a clock that ran backwards —
 * "in -3 seconds" is not a duration anyone should be shown.
 */
export function relativeLabel(iso: string, nowMs: number): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const secs = Math.floor((nowMs - then) / 1000);
  if (secs < 0) return null;
  if (secs <= 1) return 'just now';
  if (secs < 60) return `${secs} seconds ago`;
  if (secs < 120) return 'a minute ago';
  if (secs < 3600) return `${Math.floor(secs / 60)} minutes ago`;
  if (secs < 7200) return 'an hour ago';
  if (secs < 86400) return `${Math.floor(secs / 3600)} hours ago`;
  if (secs < 172800) return 'yesterday';
  return `${Math.floor(secs / 86400)} days ago`;
}

/**
 * The state line a card prints. For a device the bridge cannot reach this
 * LEADS with "Not responding": `.sh-dev-state` is a single ellipsised line, so
 * the honest half has to come first or it is the half that gets cut off.
 */
export function stateLine(available: boolean, lastKnown: string, seen: string | null): string {
  if (available) return lastKnown || 'No reading yet';
  return seen ? `Not responding · last seen ${seen}` : 'Not responding';
}

function decodeDevice(raw: Raw, nowMs: number): LiveDevice {
  const available = bool(raw.available);
  const lastKnown = str(raw.state);
  const seen = typeof raw.lastChanged === 'string' ? relativeLabel(raw.lastChanged, nowMs) : null;
  const device: LiveDevice = {
    id: str(raw.id),
    name: str(raw.name, 'Unnamed device'),
    roomId: str(raw.roomId),
    roomName: str(raw.roomName),
    kind: str(raw.kind, 'plug') as DeviceKind,
    control: str(raw.control, 'status') as DeviceControl,
    value: num(raw.value),
    state: stateLine(available, lastKnown, seen),
    available,
    lastKnownState: lastKnown,
    pending: null,
    note: null,
  };
  if (typeof raw.colour === 'string') device.colour = raw.colour;
  if (seen) device.lastChanged = seen;
  return device;
}

function decodeRoom(raw: Raw, nowMs: number): LiveRoom {
  const tone = raw.tone === 'error' || raw.tone === 'warn' ? raw.tone : 'ok';
  return {
    id: str(raw.id),
    name: str(raw.name, 'Room'),
    status: str(raw.status),
    tone,
    devices: Array.isArray(raw.devices) ? raw.devices.map((d: Raw) => decodeDevice(d, nowMs)) : [],
  };
}

function decodeBridge(raw: Raw): LiveBridge {
  return {
    id: str(raw.id),
    name: str(raw.name, 'Bridge'),
    detail: str(raw.detail),
    state: raw.state === 'connected' ? 'connected' : 'not-linked',
    kind: typeof raw.kind === 'string' ? raw.kind : null,
    health: typeof raw.health === 'string' ? raw.health : null,
  };
}

const BRIDGE_STATES: readonly BridgeState[] = [
  'none', 'connected', 'unreachable', 'unauthorised', 'unavailable',
];

/**
 * `bridgeState` off the wire. The `connected` fallback keeps an older payload
 * (one with no `bridgeState` at all) behaving exactly as it did.
 */
export function decodeBridgeState(raw: unknown, connected: boolean): BridgeState {
  if (typeof raw === 'string' && (BRIDGE_STATES as readonly string[]).includes(raw)) {
    return raw as BridgeState;
  }
  if (typeof raw === 'string' && raw.length > 0) return 'unreachable';
  return connected ? 'connected' : 'none';
}

/**
 * Day one, and every case where there is nothing to ask. Note `autonomy: []`
 * rather than the mock's five rules: the real list is composed in Rust from the
 * tiers it enforces, so inventing one here would be the drift the Rust comment
 * exists to prevent. The page renders an empty autonomy list as its own state.
 */
export const NO_BRIDGE_SNAPSHOT: LiveSnapshot = {
  bridgeConnected: false,
  hub: null,
  headline: {
    lead: 'No home is ',
    accent: 'connected.',
    subline:
      'Atlas has no bridge to your house yet. Link Home Assistant and your rooms, devices and scenes appear here.',
    metaBig: '0',
    metaSmall: 'devices linked',
  },
  scenes: [],
  activeSceneId: null,
  widgets: [],
  rooms: [],
  recentIds: [],
  discovery: { live: false, scope: '', found: [] },
  bridges: [],
  bridgeState: 'none',
  lastReachedLabel: null,
  autonomy: [],
  counts: { devices: 0, rooms: 0, scenes: 0, unavailable: 0 },
};

/**
 * `home_snapshot`'s payload → what the page binds to.
 *
 * Anything missing decodes to its honest empty rather than throwing: a bridge
 * that answered with a field Atlas does not understand should cost that field,
 * not the whole surface.
 */
export function decodeSnapshot(raw: unknown, nowMs: number): LiveSnapshot {
  if (!raw || typeof raw !== 'object') return NO_BRIDGE_SNAPSHOT;
  const r = raw as Raw;
  const rooms: LiveRoom[] = Array.isArray(r.rooms)
    ? r.rooms.map((room: Raw) => decodeRoom(room, nowMs))
    : [];
  const headline = (r.headline ?? {}) as Raw;
  const hub = r.hub && typeof r.hub === 'object' ? (r.hub as Raw) : null;
  const counts = (r.counts ?? {}) as Raw;
  const deviceCount = rooms.reduce((n, room) => n + room.devices.length, 0);

  return {
    bridgeConnected: bool(r.bridgeConnected),
    // Unrecognised values fall to 'unreachable', not to 'none': a bridge row
    // whose health word this build does not know is still a linked bridge, and
    // reading it as "you have no home" is the exact failure this field fixes.
    bridgeState: decodeBridgeState(r.bridgeState, bool(r.bridgeConnected)),
    lastReachedLabel: typeof r.lastReachedLabel === 'string' ? r.lastReachedLabel : null,
    hub: hub
      ? {
        name: str(hub.name, 'Home hub'),
        accessories: num(hub.accessories, deviceCount),
        lastSyncLabel: str(hub.lastSyncLabel, 'Not synced yet'),
      }
      : null,
    headline: {
      lead: str(headline.lead, NO_BRIDGE_SNAPSHOT.headline.lead),
      accent: str(headline.accent, NO_BRIDGE_SNAPSHOT.headline.accent),
      subline: str(headline.subline, NO_BRIDGE_SNAPSHOT.headline.subline),
      metaBig: str(headline.metaBig, String(deviceCount)),
      metaSmall: str(headline.metaSmall, 'devices linked'),
    },
    scenes: Array.isArray(r.scenes)
      ? r.scenes.map((s: Raw) => ({ id: str(s.id), label: str(s.label, 'Scene') }))
      : [],
    // Always null, and that is a fact about bridges, not a gap here: Home
    // Assistant applies a scene and forgets it, so "the Evening scene is on"
    // would be Atlas guessing that nothing has changed since.
    activeSceneId: null,
    // Always empty. See NO_WIDGETS.
    widgets: [],
    rooms,
    recentIds: Array.isArray(r.recentIds) ? r.recentIds.filter((x: unknown) => typeof x === 'string') : [],
    discovery: { live: false, scope: '', found: [] },
    bridges: Array.isArray(r.bridges) ? r.bridges.map((b: Raw) => decodeBridge(b)) : [],
    autonomy: Array.isArray(r.autonomy)
      ? r.autonomy.map((a: Raw): AutonomyRule => ({
        id: str(a.id),
        name: str(a.name),
        note: str(a.note),
        allowed: bool(a.allowed),
      }))
      : [],
    counts: {
      devices: num(counts.devices, deviceCount),
      rooms: num(counts.rooms, rooms.length),
      scenes: num(counts.scenes, Array.isArray(r.scenes) ? r.scenes.length : 0),
      unavailable: num(
        counts.unavailable,
        rooms.reduce((n, room) => n + room.devices.filter((d) => !d.available).length, 0),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Overlays — what an in-flight or failed actuation does to a card
// ---------------------------------------------------------------------------

/** Short, because `.sh-dev-state` ellipsises. The long version is the note. */
const PENDING_LINE: Record<OverlayPhase, string> = {
  sending: 'Sending…',
  sent: 'Sent · waiting for the device',
};
const FAILED_LINE = 'Did not go through';
const UNCONFIRMED_LINE = 'Sent · never confirmed';

/**
 * Everything about a device that a bridge report can change. Two snapshots with
 * the same mark are the same reading; a different mark is the device speaking.
 */
export function deviceMark(d: LiveDevice): string {
  return `${d.value}|${d.colour ?? ''}|${d.available ? 1 : 0}|${d.lastKnownState}`;
}

/**
 * Which `warn` notes the newest snapshot has made false.
 *
 * A `warn` note says, in the user's words, "the device has not reported the
 * change". Nothing used to withdraw it: once set it survived every later push
 * and sync for the rest of the session — and because `applyOverlays` replaces a
 * noted device's whole state line, the card kept printing "Sent · never
 * confirmed" over readings the bridge was actively sending. The note outranked
 * reality, permanently.
 *
 * So: baseline each noted device on the first snapshot after the note appears,
 * and drop the note the moment that device's reading moves. A `bad` note is NOT
 * cleared here — "it did not happen" stays true until the next actuation.
 *
 * Pure, and returns the next mark table rather than mutating one, so the whole
 * lifecycle is testable without a renderer.
 */
export function expiredWarnNotes(
  notes: Record<string, DeviceNote>,
  marks: Record<string, string>,
  findDevice: (id: string) => LiveDevice | null,
): { clear: string[]; marks: Record<string, string> } {
  const ids = Object.keys(notes);
  if (ids.length === 0) return { clear: [], marks: {} };
  const clear: string[] = [];
  const next: Record<string, string> = {};
  for (const id of ids) {
    if (notes[id].tone !== 'warn') continue;
    const d = findDevice(id);
    // A device that has left the store cannot confirm anything; the note stays
    // until the store answers for it again.
    if (!d) { if (marks[id] !== undefined) next[id] = marks[id]; continue; }
    const mark = deviceMark(d);
    if (marks[id] === undefined) next[id] = mark;
    else if (marks[id] === mark) next[id] = mark;
    else clear.push(id);
  }
  return { clear, marks: next };
}

/**
 * Fold the in-flight and failed state back onto the snapshot.
 *
 * The order matters: a note beats an overlay, because a command that failed has
 * no in-flight value any more and the control must show what the bridge last
 * reported — with the failure attached, never on its own.
 */
export function applyOverlays(
  snapshot: LiveSnapshot,
  overlays: Record<string, DeviceOverlay>,
  notes: Record<string, DeviceNote>,
): LiveSnapshot {
  if (Object.keys(overlays).length === 0 && Object.keys(notes).length === 0) return snapshot;
  return {
    ...snapshot,
    rooms: snapshot.rooms.map((room) => ({
      ...room,
      devices: room.devices.map((d) => {
        const note = notes[d.id];
        if (note) {
          return {
            ...d,
            note,
            pending: null,
            state: note.tone === 'bad'
              ? FAILED_LINE
              : d.available ? UNCONFIRMED_LINE : d.state,
          };
        }
        const overlay = overlays[d.id];
        if (!overlay) return d;
        return {
          ...d,
          value: overlay.value ?? d.value,
          colour: overlay.colour ?? d.colour,
          pending: overlay.phase,
          state: PENDING_LINE[overlay.phase],
        };
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Which command a control maps to
// ---------------------------------------------------------------------------

const LOCK_KINDS: DeviceKind[] = ['lock', 'garage'];
export const isLockDevice = (kind: string): boolean => LOCK_KINDS.includes(kind as DeviceKind);

export interface CommandPlan {
  cmd: string;
  args: Record<string, unknown>;
}

export interface DeviceSetPlan extends CommandPlan {
  /**
   * The value the control shows while this is in flight. Not always the value
   * that was asked for: a lock is commanded with a boolean, and the card reads
   * `value > 0`, so the two have to be derived from one another in one place.
   */
  optimistic: number;
}

/**
 * `setDeviceValue` on a lock is `home_lock_set`, not `home_device_set`.
 *
 * `home_device_set` REFUSES a lock outright (mod.rs `device_set_allowed`) so
 * the Actuate tier cannot be used as a way around the Approval tier on locks.
 * That refusal is the safety rule, and routing here is what stops the user
 * meeting it as an unexplained error every time they touch the front door: the
 * lock path is the one Rust wants, and the approval it triggers is the point.
 */
export function deviceSetPlan(
  userId: string,
  device: Pick<SmartDevice, 'id' | 'kind'>,
  value: number,
): DeviceSetPlan {
  if (isLockDevice(device.kind)) {
    const locked = value > 0;
    return {
      cmd: HOME_COMMANDS.lockSet,
      args: { userId, deviceId: device.id, locked },
      optimistic: locked ? 1 : 0,
    };
  }
  return {
    cmd: HOME_COMMANDS.deviceSet,
    args: { userId, deviceId: device.id, value },
    optimistic: value,
  };
}

/**
 * How long an actuation may stay optimistic before the surface stops implying
 * it worked. Home Assistant pushes `state_changed` within a second or two on a
 * healthy LAN; a Zigbee bulb behind a slow coordinator can take several. Ten
 * seconds is past both, and what happens at the end is a sentence, not a
 * silent revert.
 */
export const CONFIRM_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface SmartHomeDeps {
  invoke?: InvokeFn;
  now?: () => number;
}

export function useSmartHome(deps?: SmartHomeDeps): UseSmartHome {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const invoke = deps?.invoke ?? (tauriInvoke as InvokeFn);
  const now = deps?.now ?? Date.now;

  const [raw, setRaw] = useState<LiveSnapshot>(NO_BRIDGE_SNAPSHOT);
  const [overlays, setOverlays] = useState<Record<string, DeviceOverlay>>({});
  const [notes, setNotes] = useState<Record<string, DeviceNote>>({});
  /** Per device: the reading that was on screen when its `warn` note was set. */
  const seenAtNote = useRef<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [lastSceneRun, setLastSceneRun] = useState<UseSmartHome['lastSceneRun']>(null);

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /**
   * Read by the confirm-window timeout. It has to know whether the overlay is
   * STILL in flight without depending on the closure it was created in — an
   * actuation whose value the bridge already reported confirms before the
   * timer fires, and a timer that could not see that would announce "never
   * confirmed" about a change that was confirmed immediately.
   */
  const overlaysRef = useRef<Record<string, DeviceOverlay>>({});
  overlaysRef.current = overlays;
  const usable = isTauri() && !!userId;
  const unusableReason = !isTauri() ? DESKTOP_ONLY : !userId ? SIGN_IN_REQUIRED : null;

  const clearTimer = useCallback((deviceId: string) => {
    const t = timers.current[deviceId];
    if (t) {
      clearTimeout(t);
      delete timers.current[deviceId];
    }
  }, []);

  useEffect(() => () => {
    for (const t of Object.values(timers.current)) clearTimeout(t);
    timers.current = {};
  }, []);

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!usable || !userId) {
      setRaw(NO_BRIDGE_SNAPSHOT);
      setLoading(false);
      return;
    }
    try {
      const payload = await invoke(HOME_COMMANDS.snapshot, { userId });
      setRaw(decodeSnapshot(payload, now()));
    } catch (e) {
      // A snapshot that cannot be read is not an empty house. Keep whatever was
      // last true on screen and say the read failed.
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [usable, userId, invoke, now]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Every mutation in home/mod.rs emits `db:changed`, so a subscription is
  // enough — no polling, and the push socket coalesces its own storm upstream.
  useEffect(() => {
    if (!usable) return;
    const channel = localClient.channel('smart-home');
    for (const table of ['home_bridges', 'home_rooms', 'home_devices', 'home_scenes']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        void refresh();
      });
    }
    channel.subscribe();
    return () => {
      localClient.removeChannel(channel);
    };
  }, [usable, refresh]);

  /**
   * The push channel is off by default in Rust: an open socket is LAN traffic
   * and a live thread, and neither should exist while nobody is looking at this
   * page. So it opens on mount and closes on unmount, and only when there is a
   * bridge to open it against — `home_live_start` errors without one, which
   * would be a scary banner for the ordinary day-one case.
   */
  useEffect(() => {
    if (!usable || !userId || !raw.bridgeConnected) return;
    let stopped = false;
    void invoke(HOME_COMMANDS.liveStart, { userId }).catch((e) => {
      // Live updates are an enhancement; the page reads correctly without them.
      if (!stopped) setWarning(`Live updates are off: ${messageOf(e)}`);
    });
    return () => {
      stopped = true;
      void invoke(HOME_COMMANDS.liveStop, {}).catch(() => {
        /* Unmounting; there is nobody left to tell. Rust stops it on exit too. */
      });
    };
  }, [usable, userId, raw.bridgeConnected, invoke]);

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** Throws the sentence the surface should render. Callers surface it as-is. */
  const requireSession = useCallback((): string => {
    if (!isTauri()) throw new Error(DESKTOP_ONLY);
    if (!userId) throw new Error(SIGN_IN_REQUIRED);
    return userId;
  }, [userId]);

  const findDevice = useCallback(
    (deviceId: string): LiveDevice | null => {
      for (const room of raw.rooms) {
        const d = room.devices.find((x) => x.id === deviceId);
        if (d) return d;
      }
      return null;
    },
    [raw.rooms],
  );

  /**
   * One actuation, start to finish, including what it says when it does not
   * work. Everything that touches a device goes through here so there is
   * exactly one place that can leave a control lying about its device.
   */
  const actuate = useCallback(
    async (deviceId: string, overlay: DeviceOverlay, plan: CommandPlan) => {
      clearTimer(deviceId);
      // Drop the previous note AND the reading it was measured against, so the
      // effect below re-baselines against whatever this actuation leaves behind
      // rather than against a reading from the last one.
      delete seenAtNote.current[deviceId];
      setNotes((n) => {
        if (!n[deviceId]) return n;
        const next = { ...n };
        delete next[deviceId];
        return next;
      });
      setOverlays((o) => ({ ...o, [deviceId]: overlay }));
      setError(null);
      try {
        await invoke(plan.cmd, plan.args);
      } catch (e) {
        // The command failed. Drop the optimistic value — the control must show
        // what the bridge last reported — and attach the reason, so the snap
        // back is explained rather than looking like the device undid itself.
        setOverlays((o) => {
          const next = { ...o };
          delete next[deviceId];
          return next;
        });
        const text = messageOf(e);
        setNotes((n) => ({ ...n, [deviceId]: { tone: 'bad', text } }));
        setError(text);
        return;
      }
      // Accepted, not confirmed. Rust deliberately does NOT write the mirror
      // optimistically — the bridge is the source of truth for what the device
      // is now doing — so the overlay holds the requested value until a push or
      // a sync brings the real one, and gives up out loud if neither does.
      setOverlays((o) => (o[deviceId] ? { ...o, [deviceId]: { ...o[deviceId], phase: 'sent' } } : o));
      timers.current[deviceId] = setTimeout(() => {
        delete timers.current[deviceId];
        // Confirmed while the window was open — the real data already says what
        // the overlay said, and there is nothing to warn about.
        if (!overlaysRef.current[deviceId]) return;
        setOverlays((o) => {
          if (!o[deviceId]) return o;
          const next = { ...o };
          delete next[deviceId];
          return next;
        });
        setNotes((n) => ({
          ...n,
          [deviceId]: {
            tone: 'warn',
            text: 'Atlas sent this and the bridge accepted it, but the device has not reported the change. '
              + 'The reading below is the last one Atlas actually received.',
          },
        }));
      }, CONFIRM_WINDOW_MS);
    },
    [invoke, clearTimer],
  );

  /**
   * A push or a sync arrived. Anything the bridge has now confirmed stops being
   * an overlay — that is the ONLY way an overlay disappears quietly, because it
   * is the only case where the real data says the same thing.
   */
  useEffect(() => {
    const confirmed: string[] = [];
    for (const [deviceId, overlay] of Object.entries(overlays)) {
      const d = findDevice(deviceId);
      if (!d) {
        confirmed.push(deviceId);   // the device is gone; the overlay cannot outlive it
        continue;
      }
      if (overlay.value !== undefined && Math.abs(d.value - overlay.value) < 0.001) confirmed.push(deviceId);
      else if (overlay.colour !== undefined && d.colour === overlay.colour) confirmed.push(deviceId);
    }
    if (confirmed.length === 0) return;
    for (const id of confirmed) clearTimer(id);
    setOverlays((o) => {
      const next = { ...o };
      for (const id of confirmed) delete next[id];
      return next;
    });
    // And the warning goes with it. A `warn` note says "the device has not
    // reported the change" — once it has, that sentence is false, and it was
    // outranking reality: `applyOverlays` replaces a noted device's whole state
    // line, so the note survived every later push and pinned "Sent · never
    // confirmed" onto a device the bridge was actively confirming.
    //
    // A `bad` note is different and is left alone: "it did not happen" stays
    // true, and it is cleared by the next actuation on that device.
    setNotes((n) => {
      let touched = false;
      const next = { ...n };
      for (const id of confirmed) {
        if (next[id]?.tone === 'warn') { delete next[id]; touched = true; }
      }
      return touched ? next : n;
    });
  }, [raw, overlays, findDevice, clearTimer]);

  /**
   * A `warn` note outliving its own snapshot.
   *
   * The effect above only clears a note for a device that had an OVERLAY to
   * confirm — and the "never confirmed" timeout deletes the overlay on its way
   * out. So a device that reported after the window closed had no overlay left
   * to match, and kept the warning for the rest of the session. A fresh reading
   * for that device is the report the note says never arrived.
   */
  useEffect(() => {
    const { clear, marks } = expiredWarnNotes(notes, seenAtNote.current, findDevice);
    seenAtNote.current = marks;
    if (clear.length === 0) return;
    setNotes((n) => {
      const next = { ...n };
      for (const id of clear) delete next[id];
      return next;
    });
  }, [raw, notes, findDevice]);

  const setDeviceValue = useCallback(
    (deviceId: string, value: number) => {
      let uid: string;
      try {
        uid = requireSession();
      } catch (e) {
        setError(messageOf(e));
        return;
      }
      const device = findDevice(deviceId);
      if (!device) {
        setError('That device is no longer in Atlas’ home store.');
        return;
      }
      const plan = deviceSetPlan(uid, device, value);
      void actuate(deviceId, { phase: 'sending', value: plan.optimistic }, plan);
    },
    [requireSession, findDevice, actuate],
  );

  const setDeviceColour = useCallback(
    (deviceId: string, colour: string) => {
      let uid: string;
      try {
        uid = requireSession();
      } catch (e) {
        setError(messageOf(e));
        return;
      }
      void actuate(
        deviceId,
        { phase: 'sending', colour },
        { cmd: HOME_COMMANDS.deviceColour, args: { userId: uid, deviceId, colour } },
      );
    },
    [requireSession, actuate],
  );

  /**
   * There is no `home_widget_set` because `widgets` is permanently empty —
   * nothing in the home tables is an energy history, and a widget built from
   * what is there would be a number Atlas made up. This exists to satisfy the
   * contract and to fail honestly if anything ever calls it.
   */
  const setWidgetOn = useCallback((_widgetId: string, _on: boolean) => {
    setError(NO_WIDGETS);
  }, []);

  const runScene = useCallback(
    (sceneId: string) => {
      let uid: string;
      try {
        uid = requireSession();
      } catch (e) {
        setError(messageOf(e));
        return;
      }
      const scene = raw.scenes.find((s) => s.id === sceneId);
      setError(null);
      void invoke<{ scene?: string }>(HOME_COMMANDS.sceneRun, { userId: uid, sceneId })
        .then((res) => {
          // Recorded as "Atlas applied this", never as "the house is in this
          // scene": no bridge reports a current scene, and activeSceneId stays
          // null for exactly that reason.
          setLastSceneRun({ id: sceneId, label: res?.scene ?? scene?.label ?? sceneId, at: now() });
        })
        .catch((e) => setError(messageOf(e)));
    },
    [requireSession, invoke, raw.scenes, now],
  );

  /**
   * Always fails, and that is the feature. Home autonomy is enforced by the
   * control port's approval tiers in Rust — locks always ask — so there is no
   * stored preference to flip and Rust says so in the rejection. The switch
   * exists to show what is enforced; touching it explains why it cannot move.
   */
  const setAutonomy = useCallback(
    (ruleId: string, allowed: boolean) => {
      void invoke(HOME_COMMANDS.setAutonomy, { ruleId, allowed })
        .then(() => setError(null))
        .catch((e) => setError(messageOf(e)));
    },
    [invoke],
  );

  const linkHomeAssistant = useCallback(
    async (baseUrl: string, token: string) => {
      const uid = requireSession();
      setLinking(true);
      setError(null);
      try {
        // The token goes straight to Rust, which probes with it and only writes
        // it to the Keychain once the probe succeeded. It is never stored here,
        // never logged, and never put in a query string.
        await invoke(HOME_COMMANDS.link, { userId: uid, baseUrl, token });
        await refresh();
      } catch (e) {
        setError(messageOf(e));
        throw e instanceof Error ? e : new Error(messageOf(e));
      } finally {
        setLinking(false);
      }
    },
    [requireSession, invoke, refresh],
  );

  const unlink = useCallback(
    async (kind: string) => {
      const uid = requireSession();
      setError(null);
      try {
        await invoke(HOME_COMMANDS.unlink, { userId: uid, kind });
        setOverlays({});
        setNotes({});
        await refresh();
      } catch (e) {
        setError(messageOf(e));
      }
    },
    [requireSession, invoke, refresh],
  );

  const sync = useCallback(async () => {
    const uid = requireSession();
    setSyncing(true);
    setError(null);
    try {
      await invoke(HOME_COMMANDS.sync, { userId: uid });
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSyncing(false);
    }
  }, [requireSession, invoke, refresh]);

  const snapshot = useMemo(() => applyOverlays(raw, overlays, notes), [raw, overlays, notes]);

  const dismissError = useCallback(() => setError(null), []);
  const dismissWarning = useCallback(() => setWarning(null), []);

  return {
    snapshot,
    loading,
    error,
    warning,
    usable,
    unusableReason,
    linking,
    syncing,
    lastSceneRun,
    setDeviceValue,
    setDeviceColour,
    setWidgetOn,
    runScene,
    setAutonomy,
    refresh,
    linkHomeAssistant,
    unlink,
    sync,
    dismissError,
    dismissWarning,
  };
}

export default useSmartHome;
