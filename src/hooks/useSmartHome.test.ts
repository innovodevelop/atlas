/**
 * The smart-home adapter's honesty, pinned.
 *
 * The three failures this surface can have are not rendering bugs, they are
 * lies: a house that looks empty when Atlas simply cannot see it, a light drawn
 * at 62% that has been unreachable since lunch, and a switch that slides back
 * with no explanation after a command the bridge refused. Each of the three has
 * a group below, and each group would go green on a version of this file that
 * looked perfectly reasonable.
 *
 * These test the pure core, not React: `decodeSnapshot`, `applyOverlays` and
 * `deviceSetPlan` are where every one of those decisions is made, and a test
 * that needed a renderer would be testing the renderer. Same shape, and same
 * reason, as `useApprovals.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  CONFIRM_WINDOW_MS,
  HOME_COMMANDS,
  NO_BRIDGE_SNAPSHOT,
  NO_WIDGETS,
  applyOverlays,
  decodeSnapshot,
  decodeBridgeState,
  deviceMark,
  deviceSetPlan,
  expiredWarnNotes,
  isLockDevice,
  messageOf,
  relativeLabel,
  stateLine,
  type DeviceNote,
  type DeviceOverlay,
  type LiveSnapshot,
} from '@/hooks/useSmartHome';

const NOW = Date.parse('2026-08-08T12:00:00Z');
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString();

/** What `home_snapshot` puts on the wire for a small, healthy house. */
const wire = (over: Record<string, unknown> = {}) => ({
  bridgeConnected: true,
  hub: { name: 'Home Assistant', accessories: 2, lastSyncLabel: 'Last sync 40 seconds ago' },
  headline: {
    lead: 'Your home is ', accent: 'responding.',
    subline: '2 devices across 1 room, all responding.',
    metaBig: '2', metaSmall: 'devices linked',
  },
  scenes: [{ id: 'sc1', label: 'Evening', touchesLocks: false }],
  activeSceneId: null,
  widgets: [],
  rooms: [{
    id: 'r1', name: 'Living room', status: 'All responding', tone: 'ok',
    devices: [
      {
        id: 'd1', name: 'Arc floor lamp', roomId: 'r1', roomName: 'Living room',
        kind: 'floorlamp', control: 'slider', value: 62, state: 'Warm white',
        available: true, lastChanged: ago(120),
      },
      {
        id: 'd2', name: 'Front door', roomId: 'r1', roomName: 'Living room',
        kind: 'lock', control: 'toggle', value: 1, state: 'Locked',
        available: true, lastChanged: ago(7200),
      },
    ],
  }],
  recentIds: ['d1', 'd2'],
  discovery: { live: false, scope: '', found: [] },
  bridges: [{
    id: 'b1', name: 'Home Assistant', kind: 'home_assistant',
    detail: 'Two-way · 2 accessories', state: 'connected', health: 'connected',
  }],
  autonomy: [{ id: 'unlock', name: 'Unlock doors', note: 'Never.', allowed: false }],
  counts: { devices: 2, rooms: 1, scenes: 1, unavailable: 0 },
  ...over,
});

const deviceOf = (snap: LiveSnapshot, id: string) => {
  for (const room of snap.rooms) {
    const d = room.devices.find((x) => x.id === id);
    if (d) return d;
  }
  throw new Error(`no device ${id}`);
};

// ---------------------------------------------------------------------------

describe('state 1 — no bridge is a state, not an empty house', () => {
  test('nothing on the wire decodes to the day-one snapshot, not to a blank one', () => {
    const snap = decodeSnapshot(null, NOW);
    expect(snap.bridgeConnected).toBe(false);
    expect(snap.rooms).toEqual([]);
    // The distinction the whole state exists for: the headline has to say Atlas
    // has no bridge. "0 devices" alone reads as "you own nothing".
    expect(snap.headline.subline).toContain('no bridge');
    expect(snap.headline.accent).toBe('connected.');
    expect(snap.hub).toBeNull();
  });

  test('a real day-one payload keeps saying so rather than borrowing sample copy', () => {
    const snap = decodeSnapshot({
      bridgeConnected: false, hub: null,
      headline: {
        lead: 'No home is ', accent: 'connected.',
        subline: 'Atlas has no bridge to your house yet. Link Home Assistant and your rooms, devices and scenes appear here.',
        metaBig: '0', metaSmall: 'devices linked',
      },
      scenes: [], rooms: [], recentIds: [], bridges: [], autonomy: [],
      counts: { devices: 0, rooms: 0, scenes: 0, unavailable: 0 },
    }, NOW);
    expect(snap.bridgeConnected).toBe(false);
    expect(snap.headline.subline).toContain('Link Home Assistant');
  });

  test('day one invents no autonomy rules', () => {
    // The mock ships five; Rust reports the four it actually enforces. Filling
    // this in locally is how the switches drift away from the code that means
    // something — so with nothing read, there is nothing to show.
    expect(NO_BRIDGE_SNAPSHOT.autonomy).toEqual([]);
    expect(NO_BRIDGE_SNAPSHOT.discovery).toEqual({ live: false, scope: '', found: [] });
    expect(NO_BRIDGE_SNAPSHOT.widgets).toEqual([]);
  });

  test('an unreadable payload is day one, not a crash', () => {
    for (const junk of [undefined, 'nope', 42]) {
      expect(decodeSnapshot(junk, NOW).bridgeConnected).toBe(false);
    }
    // A payload missing every optional field still decodes.
    const partial = decodeSnapshot({ bridgeConnected: true }, NOW);
    expect(partial.rooms).toEqual([]);
    expect(partial.counts.devices).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('state 2 — a stale device looks stale', () => {
  test('an unreachable device keeps its last value and is marked unavailable', () => {
    const raw = wire();
    raw.rooms[0].devices[0].available = false;
    const d = deviceOf(decodeSnapshot(raw, NOW), 'd1');
    // The value is kept on purpose (Rust refuses to zero it), which is exactly
    // why it must not be presented as current.
    expect(d.value).toBe(62);
    expect(d.available).toBe(false);
  });

  test('the state line LEADS with "Not responding"', () => {
    // `.sh-dev-state` is one ellipsised line. If the honest half is not first,
    // the honest half is the half that gets cut off on a narrow card.
    const raw = wire();
    raw.rooms[0].devices[0].available = false;
    const d = deviceOf(decodeSnapshot(raw, NOW), 'd1');
    expect(d.state.startsWith('Not responding')).toBe(true);
    expect(d.state).toBe('Not responding · last seen 2 minutes ago');
    // And the words it last said survive, as history rather than as status.
    expect(d.lastKnownState).toBe('Warm white');
  });

  test('a responding device reads as itself', () => {
    const d = deviceOf(decodeSnapshot(wire(), NOW), 'd1');
    expect(d.state).toBe('Warm white');
    expect(d.available).toBe(true);
  });

  test('stateLine never presents a last-known reading as current', () => {
    expect(stateLine(false, 'Warm white', null)).toBe('Not responding');
    expect(stateLine(false, 'Warm white', '2 hours ago')).toBe('Not responding · last seen 2 hours ago');
    expect(stateLine(false, 'Warm white', null)).not.toContain('Warm white');
    expect(stateLine(true, 'Warm white', 'x')).toBe('Warm white');
    expect(stateLine(true, '', null)).toBe('No reading yet');
  });

  test('lastChanged is relative time, never the raw ISO the store holds', () => {
    // The mock's type says "already formatted by whoever owns the clock", and
    // RecentDeviceStrip prints it verbatim — an unformatted timestamp would ship
    // `2026-08-08T11:58:00Z` into the card.
    const d = deviceOf(decodeSnapshot(wire(), NOW), 'd1');
    expect(d.lastChanged).toBe('2 minutes ago');
    expect(deviceOf(decodeSnapshot(wire(), NOW), 'd2').lastChanged).toBe('2 hours ago');
  });

  test('a clock that ran backwards produces no duration at all', () => {
    expect(relativeLabel(new Date(NOW + 5000).toISOString(), NOW)).toBeNull();
    expect(relativeLabel('not a date', NOW)).toBeNull();
    const raw = wire();
    raw.rooms[0].devices[0].lastChanged = new Date(NOW + 60_000).toISOString();
    expect(deviceOf(decodeSnapshot(raw, NOW), 'd1').lastChanged).toBeUndefined();
  });

  test('the unavailable count survives so the page can total it', () => {
    const raw = wire();
    raw.rooms[0].devices[0].available = false;
    raw.counts.unavailable = 1;
    expect(decodeSnapshot(raw, NOW).counts.unavailable).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('state 3 — a failed actuation says so', () => {
  const base = () => decodeSnapshot(wire(), NOW);

  test('a failure drops the optimistic value AND attaches the reason', () => {
    // Dropping it alone is the bug: the control slides back and the user reads
    // that as the device changing its own mind.
    const note: DeviceNote = { tone: 'bad', text: 'the hub did not answer in time' };
    const snap = applyOverlays(base(), {}, { d1: note });
    const d = deviceOf(snap, 'd1');
    expect(d.value).toBe(62);                 // what the bridge last reported
    expect(d.note).toEqual(note);
    expect(d.state).toBe('Did not go through');
    expect(d.pending).toBeNull();
  });

  test('a note beats an overlay — a failed command has no in-flight value left', () => {
    const overlays: Record<string, DeviceOverlay> = { d1: { phase: 'sent', value: 5 } };
    const d = deviceOf(applyOverlays(base(), overlays, { d1: { tone: 'bad', text: 'refused' } }), 'd1');
    expect(d.value).toBe(62);
    expect(d.state).toBe('Did not go through');
  });

  test('in flight, the control shows what was asked for and says it is in flight', () => {
    const d = deviceOf(applyOverlays(base(), { d1: { phase: 'sending', value: 10 } }, {}), 'd1');
    expect(d.value).toBe(10);
    expect(d.pending).toBe('sending');
    expect(d.state).toBe('Sending…');
  });

  test('accepted but unconfirmed is its own answer, not success and not silence', () => {
    const sent = deviceOf(applyOverlays(base(), { d1: { phase: 'sent', value: 10 } }, {}), 'd1');
    expect(sent.state).toBe('Sent · waiting for the device');

    const expired = deviceOf(applyOverlays(base(), {}, {
      d1: { tone: 'warn', text: 'Atlas sent this and the bridge accepted it, but the device has not reported the change.' },
    }), 'd1');
    expect(expired.state).toBe('Sent · never confirmed');
    expect(expired.note?.tone).toBe('warn');
    expect(expired.value).toBe(62);
  });

  test('an unconfirmed change on an already-unreachable device keeps the stale line', () => {
    // "Sent · never confirmed" would replace the more important fact, which is
    // that this device has not been reachable at all.
    const raw = wire();
    raw.rooms[0].devices[0].available = false;
    const snap = decodeSnapshot(raw, NOW);
    const d = deviceOf(applyOverlays(snap, {}, { d1: { tone: 'warn', text: 'not confirmed' } }), 'd1');
    expect(d.state.startsWith('Not responding')).toBe(true);
    expect(d.note?.tone).toBe('warn');
  });

  test('a colour overlay moves the swatch, not the brightness', () => {
    const d = deviceOf(applyOverlays(base(), { d1: { phase: 'sending', colour: '#8fb6ff' } }, {}), 'd1');
    expect(d.colour).toBe('#8fb6ff');
    expect(d.value).toBe(62);
  });

  test('with nothing pending and nothing failed the snapshot is untouched', () => {
    const snap = base();
    expect(applyOverlays(snap, {}, {})).toBe(snap);
  });

  test('the confirm window is a real window, not zero and not forever', () => {
    expect(CONFIRM_WINDOW_MS).toBeGreaterThanOrEqual(3000);
    expect(CONFIRM_WINDOW_MS).toBeLessThanOrEqual(60_000);
  });
});

// ---------------------------------------------------------------------------

describe('the wire', () => {
  test('the command names are the ones lib.rs registers', () => {
    expect(HOME_COMMANDS.snapshot).toBe('home_snapshot');
    expect(HOME_COMMANDS.link).toBe('home_link_home_assistant');
    expect(HOME_COMMANDS.deviceSet).toBe('home_device_set');
    expect(HOME_COMMANDS.lockSet).toBe('home_lock_set');
    expect(HOME_COMMANDS.sceneRun).toBe('home_scene_run');
    expect(HOME_COMMANDS.setAutonomy).toBe('home_set_autonomy');
    expect(HOME_COMMANDS.liveStart).toBe('home_live_start');
    expect(HOME_COMMANDS.liveStop).toBe('home_live_stop');
  });

  test('arguments are camelCase, which is what Tauri v2 deserializes', () => {
    // snake_case is rejected at deserialization — and a rejected command looks
    // exactly like a command that quietly did nothing.
    const plan = deviceSetPlan('u1', { id: 'd1', kind: 'floorlamp' }, 40);
    expect(plan.args).toEqual({ userId: 'u1', deviceId: 'd1', value: 40 });
    expect(Object.keys(plan.args)).not.toContain('device_id');
  });

  test('a lock is commanded through home_lock_set, never home_device_set', () => {
    // THE SAFETY RULE. `home_device_set` is Actuate tier and refuses a lock
    // outright so it cannot be used around the Approval tier on `home_lock_set`.
    // Routing here is what makes the front door reach the path that asks the
    // user, instead of an unexplained refusal every time it is touched.
    for (const kind of ['lock', 'garage'] as const) {
      const on = deviceSetPlan('u1', { id: 'd2', kind }, 1);
      expect(on.cmd).toBe('home_lock_set');
      expect(on.args).toEqual({ userId: 'u1', deviceId: 'd2', locked: true });
      expect(on.optimistic).toBe(1);

      const off = deviceSetPlan('u1', { id: 'd2', kind }, 0);
      expect(off.args).toEqual({ userId: 'u1', deviceId: 'd2', locked: false });
      expect(off.optimistic).toBe(0);
    }
    expect(isLockDevice('lock')).toBe(true);
    expect(isLockDevice('garage')).toBe(true);
    for (const notALock of ['blind', 'curtain', 'bulb', 'plug', 'camera', '']) {
      expect(isLockDevice(notALock)).toBe(false);
    }
  });

  test('a rejection from Rust arrives as its own sentence', () => {
    // Commands reject with a plain string, not an Error.
    expect(messageOf('that device is not in Atlas’ home store')).toBe('that device is not in Atlas’ home store');
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf({})).toContain('could not reach');
  });
});

// ---------------------------------------------------------------------------

describe('what the adapter refuses to invent', () => {
  test('widgets stay empty even if something ever puts one on the wire', () => {
    const snap = decodeSnapshot(wire({
      widgets: [{ id: 'energy', name: 'Energy today', kind: 'bars', bars: [1, 2, 3] }],
    }), NOW);
    // Nothing in the home tables is a history, so a widget built from them is a
    // number Atlas made up — and there is no command to toggle one either.
    expect(snap.widgets).toEqual([]);
    expect(NO_WIDGETS).toContain('inventing');
  });

  test('no scene is ever reported as the active one', () => {
    const snap = decodeSnapshot(wire({ activeSceneId: 'sc1' }), NOW);
    expect(snap.scenes).toHaveLength(1);
    // Home Assistant applies a scene and forgets it. A lit pill would be Atlas
    // guessing that nothing has changed since.
    expect(snap.activeSceneId).toBeNull();
  });

  test('discovery is never live, whatever arrives', () => {
    const snap = decodeSnapshot(wire({
      discovery: { live: true, scope: 'Matter · Thread', found: [{ id: 'x', name: 'Bulb' }] },
    }), NOW);
    expect(snap.discovery).toEqual({ live: false, scope: '', found: [] });
  });

  test('the bridge carries its kind and health so the surface can act on them', () => {
    const snap = decodeSnapshot(wire({
      bridges: [{ id: 'b1', name: 'Home Assistant', kind: 'home_assistant', detail: 'The token was rejected', state: 'not-linked', health: 'unauthorised' }],
    }), NOW);
    expect(snap.bridges[0].kind).toBe('home_assistant');   // what home_unlink wants
    expect(snap.bridges[0].health).toBe('unauthorised');
    // "unreachable" and "unauthorised" need different fixes and must not both
    // arrive at the surface as the same grey pill.
    expect(snap.bridges[0].detail).toBe('The token was rejected');
  });
});

/* ── 4. LINKED, AND SILENT ──────────────────────────────────────────────────
   The fourth state, which used to render as the first one. `bridgeConnected`
   is a boolean and a house has three answers — nothing linked, linked and
   answering, linked and quiet — so a hub that had rebooted produced the exact
   payload of a machine that had never seen a smart home, and the page offered
   to connect a bridge that was already connected. */

describe('a bridge that is linked and not answering', () => {
  const silent = () => decodeSnapshot(wire({
    bridgeConnected: false,
    bridgeState: 'unreachable',
    lastReachedLabel: '40 minutes ago',
    headline: {
      lead: 'Home Assistant is ', accent: 'not answering.',
      subline: 'Atlas cannot reach your bridge. Last reached 40 minutes ago.',
      metaBig: '2', metaSmall: 'devices, last known',
    },
  }), NOW);

  test('is not the day-one house', () => {
    const snap = silent();
    expect(snap.bridgeState).toBe('unreachable');
    expect(snap.bridgeConnected).toBe(false);
    // The distinction the page branches on. Both are false; only one of them
    // means "offer to connect a home".
    expect(snap.bridgeState === 'none').toBe(false);
    expect(snap.lastReachedLabel).toBe('40 minutes ago');
    expect(snap.rooms.length).toBe(1);
  });

  test('day one is still day one', () => {
    expect(decodeSnapshot(null, NOW).bridgeState).toBe('none');
    expect(decodeSnapshot({}, NOW).bridgeState).toBe('none');
    expect(NO_BRIDGE_SNAPSHOT.bridgeState).toBe('none');
  });

  test('a rejected token is its own state, because it needs a different fix', () => {
    expect(decodeSnapshot(wire({ bridgeConnected: false, bridgeState: 'unauthorised' }), NOW).bridgeState)
      .toBe('unauthorised');
  });

  test('a health word this build does not know is still a linked bridge', () => {
    // Falling to 'none' here would put the user back on the day-one screen for
    // nothing worse than a Rust-side vocabulary change.
    expect(decodeBridgeState('rate_limited', false)).toBe('unreachable');
    expect(decodeBridgeState(undefined, true)).toBe('connected');
    expect(decodeBridgeState(undefined, false)).toBe('none');
  });
});

/* ── 5. A WARNING THAT OUTLIVED ITS OWN FACTS ───────────────────────────────
   `warn` notes were set and never cleared. Because `applyOverlays` replaces a
   noted device's entire state line, one timeout pinned "Sent · never
   confirmed" onto a device for the rest of the session — over every real
   reading the bridge sent afterwards. */

describe('a warn note is withdrawn when the device does report', () => {
  const lamp = (over: Partial<Record<string, unknown>> = {}) => {
    const raw = wire();
    Object.assign(raw.rooms[0].devices[0], over);
    return deviceOf(decodeSnapshot(raw, NOW), 'd1');
  };
  const warn: Record<string, DeviceNote> = { d1: { tone: 'warn', text: 'has not reported the change' } };

  test('the first snapshot after the note only baselines it', () => {
    const d = lamp();
    const r = expiredWarnNotes(warn, {}, () => d);
    expect(r.clear).toEqual([]);
    expect(r.marks.d1).toBe(deviceMark(d));
  });

  test('an unchanged reading keeps the warning', () => {
    const d = lamp();
    const r = expiredWarnNotes(warn, { d1: deviceMark(d) }, () => d);
    expect(r.clear).toEqual([]);
  });

  test('a reading that moved clears it — that IS the report it says never came', () => {
    const before = lamp();
    const after = lamp({ value: 10, state: 'Dim' });
    const r = expiredWarnNotes(warn, { d1: deviceMark(before) }, () => after);
    expect(r.clear).toEqual(['d1']);
    expect(r.marks.d1).toBeUndefined();
  });

  test('a device going unreachable also counts as news', () => {
    const before = lamp();
    const after = lamp({ available: false });
    expect(expiredWarnNotes(warn, { d1: deviceMark(before) }, () => after).clear).toEqual(['d1']);
  });

  test('a bad note is never withdrawn this way — "it did not happen" stays true', () => {
    const bad: Record<string, DeviceNote> = { d1: { tone: 'bad', text: 'The bridge refused it.' } };
    const before = lamp();
    const after = lamp({ value: 10 });
    const r = expiredWarnNotes(bad, { d1: deviceMark(before) }, () => after);
    expect(r.clear).toEqual([]);
  });

  test('a device that has left the store cannot confirm anything', () => {
    const r = expiredWarnNotes(warn, { d1: 'old-mark' }, () => null);
    expect(r.clear).toEqual([]);
    expect(r.marks.d1).toBe('old-mark');
  });

  test('with no notes there is nothing to carry', () => {
    expect(expiredWarnNotes({}, { d1: 'x' }, () => null)).toEqual({ clear: [], marks: {} });
  });
});
