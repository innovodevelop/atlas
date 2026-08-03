/**
 * Smart home — the mock adapter.
 *
 * THERE IS NO DEVICE API IN ATLAS. No HomeKit bridge, no Matter commissioner,
 * no Thread border router, no local hub client — nothing in this repo can read
 * or command a physical accessory. `Atlas Smart Home.dc.html` is a full surface
 * design with no data source behind it, so this module is the data source, and
 * it says so out loud in three places: the `IS_MOCK` flag below, the
 * "Sample data" banner the page renders from it, and every empty state that the
 * same page can show on demand.
 *
 * This is the deliberate, labelled exception to the project rule "honest UI,
 * not fake data" (the rule T4 spent a week enforcing by deleting fabricated
 * rows from Atlas Core). It is honest *because* it is labelled. Remove the
 * banner and it becomes exactly the thing that was deleted.
 *
 * ── HOW A REAL ADAPTER REPLACES THIS ────────────────────────────────────────
 * `useSmartHome()` is the only thing `AtlasSmartHome.tsx` imports for live
 * data, and its return type `SmartHomeState` is what a real hook would return:
 * a snapshot, a loading flag, an error, and four commands. A real adapter lands
 * as `src/hooks/useSmartHome.ts` with the identical signature, and the swap is
 * one import line on the page:
 *
 *     -import { useSmartHome } from '@/lib/mocks/smartHome';
 *     +import { useSmartHome } from '@/hooks/useSmartHome';
 *
 * Everything else on the page is bound to the types in this file, not to the
 * literals. The literals live at the bottom, in `SAMPLE_SNAPSHOT`, and the page
 * imports them only to drive the "preview the empty state" control — which is
 * itself gated on `IS_MOCK` and disappears with the mock.
 *
 * Copy is the design's own, verbatim from `Atlas Smart Home.dc.html`. The one
 * place it was changed is internal consistency: the design's `rooms` (its
 * settings view) and `ROOMS3D` (its devices view) disagree about how many
 * rooms and accessories exist, so here the room summary and the hub's
 * accessory count are DERIVED from the device list and cannot drift apart.
 *
 * `atlas-models.js` in the handoff is a prototype canvas renderer for the
 * device illustrations. README §8 lists it under "do not port". Nothing here
 * describes geometry — a device carries a `kind`, and the surface picks a glyph.
 */

import { useCallback, useState } from 'react';

/** The one flag. Every consumer branches on this, not on a build variable. */
export const IS_MOCK = true;

/* ── Domain types — the shape a real adapter must return ───────────────────── */

export type WidgetCategory =
  | 'light' | 'climate' | 'security' | 'energy' | 'media' | 'water' | 'care' | 'net';

/** The seven card bodies the design draws. `kind` picks the renderer. */
export type WidgetKind = 'big' | 'rows' | 'toggle' | 'progress' | 'bars' | 'split' | 'text';

export interface WidgetRow {
  label: string;
  value: string;
}

export interface HomeWidget {
  id: string;
  name: string;
  category: WidgetCategory;
  kind: WidgetKind;
  /** Span on the 12-column grid. */
  cols: number;
  /** Span on the 126px row grid. */
  rows: number;
  /** Right-aligned header text. */
  kicker: string;
  value: string;
  caption: string;
  /** `big` — the small coloured figure beside the value. */
  delta?: string;
  /** `split` — the second half. */
  value2?: string;
  caption2?: string;
  /** `progress` — 0–100. */
  pct?: number;
  /** `toggle` — the switch position. */
  on?: boolean;
  /** `rows` — the list. Empty is a legitimate state and renders an empty state. */
  list?: WidgetRow[];
  /** `bars` — relative heights, 0–100. Empty renders an empty state. */
  bars?: number[];
}

/**
 * What a device IS, not what it looks like. The surface maps `kind` to a glyph
 * and `control` to an affordance; neither concept reaches this module.
 */
export type DeviceKind =
  | 'bulb' | 'pendant' | 'floorlamp' | 'strip'
  | 'speaker' | 'tv'
  | 'thermostat' | 'valve' | 'heater' | 'purifier'
  | 'blind' | 'curtain'
  | 'kettle' | 'washer' | 'fridge' | 'vacuum' | 'plug'
  | 'sensor' | 'smoke' | 'router'
  | 'lock' | 'doorbell' | 'camera' | 'garage'
  | 'ev' | 'solar' | 'sprinkler';

/**
 * `status` is the honest one: a device that reports and cannot be commanded.
 * The design draws it as a "No control · reports only" pill rather than a
 * disabled switch, which is the right call — a greyed switch reads as broken.
 */
export type DeviceControl = 'slider' | 'toggle' | 'stepper' | 'segmented' | 'colour' | 'status';

export interface SmartDevice {
  id: string;
  name: string;
  roomId: string;
  roomName: string;
  kind: DeviceKind;
  control: DeviceControl;
  /**
   * Units follow `control`: slider/colour 0–100, toggle 0|1,
   * stepper degrees Celsius, segmented 0–3, status 0|1 (or a percentage above 1).
   */
  value: number;
  /** The sentence under the name — the device's own words, not a computed label. */
  state: string;
  /** `colour` only — the selected swatch. */
  colour?: string;
  /** Relative time, already formatted by whoever owns the clock. */
  lastChanged?: string;
}

export type RoomTone = 'ok' | 'warn' | 'error';

export interface SmartRoom {
  id: string;
  name: string;
  /** Short human status for the room, e.g. "Side gate camera offline". */
  status: string;
  tone: RoomTone;
  devices: SmartDevice[];
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  /** Matter · Thread · Wi-Fi · AirPlay · Zigbee. */
  protocol: string;
  note: string;
  /** `ignore` is the design's own fifth row — a device it recommends skipping. */
  suggested: 'add' | 'ignore';
}

export interface Bridge {
  id: string;
  name: string;
  detail: string;
  state: 'connected' | 'not-linked';
}

export interface AutonomyRule {
  id: string;
  name: string;
  note: string;
  allowed: boolean;
}

export interface Scene {
  id: string;
  label: string;
}

export interface HomeHub {
  name: string;
  /** Derived from the device list — see the note at the top of this file. */
  accessories: number;
  lastSyncLabel: string;
}

export interface SmartHomeHeadline {
  lead: string;
  accent: string;
  subline: string;
  metaBig: string;
  metaSmall: string;
}

export interface SmartHomeSnapshot {
  /** False means no bridge at all — the day-one state a real adapter returns. */
  bridgeConnected: boolean;
  hub: HomeHub | null;
  headline: SmartHomeHeadline;
  scenes: Scene[];
  activeSceneId: string | null;
  widgets: HomeWidget[];
  rooms: SmartRoom[];
  /** Device ids, most recently operated first. */
  recentIds: string[];
  discovery: {
    /**
     * Whether a scan is actually running. FALSE in the sample too — Atlas has
     * no discovery stack, and a pulsing green "Scanning" would be a claim about
     * the radio, not about the sample.
     */
    live: boolean;
    scope: string;
    found: DiscoveredDevice[];
  };
  bridges: Bridge[];
  autonomy: AutonomyRule[];
}

/** What `useSmartHome()` returns — mock today, real adapter tomorrow. */
export interface SmartHomeState {
  snapshot: SmartHomeSnapshot;
  loading: boolean;
  error: string | null;
  setDeviceValue: (deviceId: string, value: number) => void;
  setDeviceColour: (deviceId: string, colour: string) => void;
  setWidgetOn: (widgetId: string, on: boolean) => void;
  runScene: (sceneId: string) => void;
  setAutonomy: (ruleId: string, allowed: boolean) => void;
}

/* ── Sample data ───────────────────────────────────────────────────────────── */

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

type DeviceSeed = [name: string, kind: DeviceKind, control: DeviceControl, value: number, state: string];
type RoomSeed = [name: string, status: string, tone: RoomTone, devices: DeviceSeed[]];

/**
 * The design's `ROOMS3D`, plus the Study it names in its settings view but
 * never lists, plus the side-gate camera its copy repeatedly calls offline.
 * Both additions exist so the room summary in Setup can be derived rather than
 * hand-written next to a contradicting device list.
 */
const ROOM_SEEDS: RoomSeed[] = [
  ['Living room', 'All responding', 'ok', [
    ['Arc floor lamp', 'floorlamp', 'slider', 62, 'Warm white'],
    ['Ceiling pendant', 'pendant', 'slider', 40, 'Dimmed for evening'],
    ['Shelf strip', 'strip', 'colour', 74, 'Amber'],
    ['Sonos Era 100', 'speaker', 'slider', 28, 'Ambient Works'],
    ['LG C4 65"', 'tv', 'toggle', 0, 'Standby · Apple TV'],
    ['Thermostat', 'thermostat', 'stepper', 21.5, 'Heating idle'],
    ['Blinds', 'blind', 'slider', 55, 'Half open'],
    ['Air purifier', 'purifier', 'segmented', 1, 'PM2.5 · 4 µg'],
  ]],
  ['Kitchen', 'All responding', 'ok', [
    ['Downlights', 'bulb', 'slider', 0, 'Off since 08:12'],
    ['Under-cabinet strip', 'strip', 'colour', 30, 'Neutral'],
    ['Fellow kettle', 'kettle', 'toggle', 0, 'Idle · 96°C preset'],
    ['Dishwasher', 'washer', 'status', 0, 'Delayed to 22:00'],
    ['Fridge', 'fridge', 'stepper', 3.4, 'Freezer −18.1°'],
    ['Coffee machine', 'plug', 'toggle', 1, 'Brews 06:40'],
    ['Leak sensor', 'sensor', 'status', 1, 'Dry · under sink'],
    ['Smoke alarm', 'smoke', 'status', 1, 'Tested 21 July'],
  ]],
  ['Bedroom', 'All responding', 'ok', [
    ['Bedside bulbs', 'bulb', 'slider', 12, 'Night light'],
    ['Curtains', 'curtain', 'slider', 0, 'Closed'],
    ['Radiator valve', 'valve', 'stepper', 19, 'Eco overnight'],
    ['Air sensor', 'sensor', 'status', 1, 'CO₂ 612 ppm'],
  ]],
  ['Study', 'Window open', 'warn', [
    ['Desk lamp', 'bulb', 'slider', 0, 'Off since 09:40'],
    ['Ceiling light', 'pendant', 'slider', 0, 'Off'],
    ['Window contact', 'sensor', 'status', 0, 'Open since 13:20'],
    ['CO₂ sensor', 'sensor', 'status', 1, '612 ppm · ventilation not needed'],
  ]],
  ['Utility', 'All responding', 'ok', [
    ['Washer', 'washer', 'status', 52, 'Cottons 40° · 38 min'],
    ['Robot vacuum', 'vacuum', 'toggle', 1, 'Level 1 · 46%'],
    ['Boiler', 'heater', 'stepper', 52, 'Hot water ready'],
    ['Router', 'router', 'status', 1, '612 Mb/s · 34 devices'],
  ]],
  ['Outdoors', 'Side gate camera offline', 'error', [
    ['Front door lock', 'lock', 'toggle', 1, 'Locked 18:40'],
    ['Doorbell', 'doorbell', 'toggle', 1, 'Chime on'],
    ['Path lights', 'bulb', 'slider', 80, 'Sunset to 23:00'],
    ['Front camera', 'camera', 'toggle', 1, 'Recording'],
    ['Side gate camera', 'camera', 'status', 0, 'Offline since 09:12'],
    ['Garage door', 'garage', 'toggle', 1, 'Closed'],
    ['EV charger', 'ev', 'slider', 64, '11 kW · off-peak'],
    ['Solar inverter', 'solar', 'status', 1, '3.4 kW generating'],
    ['Irrigation', 'sprinkler', 'status', 0, 'Paused for rain'],
  ]],
];

const SAMPLE_ROOMS: SmartRoom[] = ROOM_SEEDS.map(([name, status, tone, devices]) => {
  const roomId = slug(name);
  return {
    id: roomId,
    name,
    status,
    tone,
    devices: devices.map(([dName, kind, control, value, state]) => ({
      id: `${roomId}:${slug(dName)}`,
      name: dName,
      roomId,
      roomName: name,
      kind,
      control,
      value,
      state,
      colour: control === 'colour' ? '#ffb765' : undefined,
    })),
  };
});

const SAMPLE_DEVICE_COUNT = SAMPLE_ROOMS.reduce((n, r) => n + r.devices.length, 0);

/**
 * The design's fifteen home cards, in its own order, plus `Energy today` —
 * a widget from the same file's catalog, added because it is the only `bars`
 * card and the home layout would otherwise ship a renderer with no call site.
 */
const SAMPLE_WIDGETS: HomeWidget[] = [
  {
    id: 'thermostat', name: 'Thermostat', category: 'climate', kind: 'big', cols: 3, rows: 2,
    kicker: 'Living room', value: '21.5°', delta: 'auto', caption: 'Target 21° · heating off',
  },
  {
    id: 'front-door', name: 'Front door', category: 'security', kind: 'toggle', cols: 3, rows: 1,
    kicker: 'Yale · battery 82%', value: 'Locked', caption: 'Auto-locked 18:40', on: true,
  },
  {
    id: 'energy-now', name: 'Energy now', category: 'energy', kind: 'big', cols: 3, rows: 1,
    kicker: 'Live draw', value: '740 W', delta: '−18%', caption: 'Below your weekday average',
  },
  {
    id: 'cameras', name: 'Cameras', category: 'security', kind: 'rows', cols: 3, rows: 2,
    kicker: 'Live', value: '3 of 4', caption: 'One camera offline',
    list: [
      { label: 'Front path', value: 'clear' },
      { label: 'Back garden', value: 'clear' },
      { label: 'Garage', value: 'clear' },
      { label: 'Side gate', value: 'offline' },
    ],
  },
  {
    id: 'automations', name: 'Automations', category: 'net', kind: 'rows', cols: 3, rows: 2,
    kicker: 'Rules', value: '12 active', caption: '4 ran today',
    list: [
      { label: 'Sunset lights', value: 'ran 19:04' },
      { label: 'Away lock-up', value: 'armed 08:12' },
      { label: 'Off-peak laundry', value: 'queued' },
      { label: 'Rain delay', value: 'held' },
    ],
  },
  {
    id: 'lights', name: 'Lights', category: 'light', kind: 'progress', cols: 3, rows: 1,
    kicker: 'Whole house', value: '6 on', caption: 'of 21 · warm 2700K', pct: 29,
  },
  {
    id: 'solar', name: 'Solar', category: 'energy', kind: 'split', cols: 3, rows: 1,
    kicker: 'Roof array', value: '3.4 kW', caption: 'Generating', value2: '1.9 kW', caption2: 'Exported',
  },
  {
    id: 'energy-today', name: 'Energy today', category: 'energy', kind: 'bars', cols: 6, rows: 2,
    kicker: 'Consumption', value: '8.2 kWh', caption: 'By hour',
    bars: [20, 26, 34, 52, 66, 48, 30, 24, 22, 28, 40, 58],
  },
  {
    id: 'alarm', name: 'Alarm', category: 'security', kind: 'toggle', cols: 3, rows: 1,
    kicker: 'System', value: 'Armed · away', caption: 'Disarms when you arrive', on: true,
  },
  {
    id: 'washer', name: 'Washer', category: 'care', kind: 'progress', cols: 3, rows: 1,
    kicker: 'Running', value: '38 min', caption: 'Cottons 40° · ends 15:22', pct: 52,
  },
  {
    id: 'presence', name: 'Presence', category: 'net', kind: 'text', cols: 6, rows: 1,
    kicker: 'Who is in',
    value: 'You are home, Rosa left at 12:40. The house switched to Day mode on its own.',
    caption: 'Two residents tracked',
  },
  {
    id: 'wifi', name: 'Wi-Fi', category: 'net', kind: 'big', cols: 3, rows: 1,
    kicker: 'Mesh', value: '612 Mb/s', delta: 'stable', caption: '34 devices · 2 on guest',
  },
  {
    id: 'home-battery', name: 'Home battery', category: 'energy', kind: 'progress', cols: 3, rows: 1,
    kicker: 'Powerwall', value: '78%', caption: '11.2 kWh stored', pct: 78,
  },
  {
    id: 'water-use', name: 'Water use', category: 'water', kind: 'big', cols: 3, rows: 1,
    kicker: 'Household', value: '118 L', delta: 'today', caption: 'Shower 62 L · dishwasher 11 L',
  },
  {
    id: 'air-purifier', name: 'Air purifier', category: 'climate', kind: 'toggle', cols: 3, rows: 1,
    kicker: 'Living room', value: 'Quiet', caption: 'PM2.5 · 4 µg/m³', on: true,
  },
  {
    id: 'atlas-said', name: 'Atlas said', category: 'net', kind: 'text', cols: 6, rows: 1,
    kicker: 'Voice',
    value: 'I paused the sprinklers — rain is 40 minutes out — and moved the dishwasher to the 22:00 tariff.',
    caption: 'Spoken aloud · 14:28',
  },
];

const RECENT_SEEDS: Array<[deviceId: string, when: string]> = [
  ['living-room:arc-floor-lamp', '2 min ago'],
  ['outdoors:front-door-lock', '18 min ago'],
  ['living-room:thermostat', '40 min ago'],
  ['kitchen:coffee-machine', '1 h ago'],
  ['utility:robot-vacuum', '2 h ago'],
];

/** Applied to the sample rooms so `lastChanged` lives on the device, not beside it. */
for (const [deviceId, when] of RECENT_SEEDS) {
  for (const room of SAMPLE_ROOMS) {
    const d = room.devices.find((x) => x.id === deviceId);
    if (d) d.lastChanged = when;
  }
}

const AUTONOMY: AutonomyRule[] = [
  { id: 'lights', name: 'Adjust lights and blinds', note: 'Any time, without telling you.', allowed: true },
  { id: 'offpeak', name: 'Shift appliances to off-peak', note: 'Only where the cycle can finish by morning.', allowed: true },
  { id: 'unlock', name: 'Unlock doors', note: 'Never — Atlas can lock, but only you unlock.', allowed: false },
  { id: 'irrigation', name: 'Pause irrigation for weather', note: 'Uses the same forecast as the weather widget.', allowed: true },
  { id: 'guest', name: 'Grant guest access', note: 'Requires your approval each time.', allowed: false },
];

export const SAMPLE_SNAPSHOT: SmartHomeSnapshot = {
  bridgeConnected: true,
  hub: { name: 'Apple Home', accessories: SAMPLE_DEVICE_COUNT, lastSyncLabel: 'Last sync 40 seconds ago' },
  headline: {
    lead: 'Everything is ',
    accent: 'settled.',
    subline:
      'Twelve automations are active, one window is open in the study, and the dishwasher is waiting for the 22:00 tariff. Nothing needs you.',
    metaBig: String(SAMPLE_DEVICE_COUNT),
    metaSmall: 'devices linked',
  },
  scenes: [
    { id: 'evening', label: 'Evening' },
    { id: 'focus', label: 'Focus' },
    { id: 'dinner', label: 'Dinner' },
    { id: 'away', label: 'Away' },
    { id: 'night', label: 'Good night' },
  ],
  activeSceneId: 'evening',
  widgets: SAMPLE_WIDGETS,
  rooms: SAMPLE_ROOMS,
  recentIds: RECENT_SEEDS.map(([id]) => id),
  discovery: {
    live: false,
    scope: 'Matter · Thread · Wi-Fi',
    found: [
      { id: 'd1', name: 'Nanoleaf Essentials A19', protocol: 'Matter', note: 'Living room · signal strong', suggested: 'add' },
      { id: 'd2', name: 'Eve Door & Window', protocol: 'Thread', note: 'Study window · battery 100%', suggested: 'add' },
      { id: 'd3', name: 'Aqara FP2 presence', protocol: 'Wi-Fi', note: 'Hallway · needs 2.4GHz', suggested: 'add' },
      { id: 'd4', name: 'Sonos Era 100', protocol: 'AirPlay', note: 'Kitchen · already on network', suggested: 'add' },
      { id: 'd5', name: 'Unknown Zigbee bulb', protocol: 'Zigbee', note: 'No manufacturer response', suggested: 'ignore' },
    ],
  },
  bridges: [
    { id: 'apple', name: 'Apple Home', detail: `Two-way · ${SAMPLE_DEVICE_COUNT} accessories`, state: 'connected' },
    { id: 'matter', name: 'Matter fabric', detail: 'Atlas is a commissioner', state: 'connected' },
    { id: 'thread', name: 'Thread border router', detail: 'HomePod mini · 11 nodes', state: 'connected' },
    { id: 'google', name: 'Google Home', detail: 'Read-only mirror', state: 'not-linked' },
  ],
  autonomy: AUTONOMY,
};

/**
 * Day one. What a real adapter returns before anything is paired — and what
 * the page shows when the sample is switched off. Every panel on the surface
 * reaches its designed empty state from this one object, so none of them can
 * be an unreachable branch.
 */
export const EMPTY_SNAPSHOT: SmartHomeSnapshot = {
  bridgeConnected: false,
  hub: null,
  headline: {
    lead: 'No home is ',
    accent: 'connected.',
    subline:
      'Atlas has no bridge to your house yet — no Apple Home, no Matter fabric, no hub. Link one and rooms, devices and scenes appear here.',
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
  /** Preferences, not device data — they exist before a house does. */
  autonomy: AUTONOMY,
};

/* ── The hook ──────────────────────────────────────────────────────────────── */

const mapDevice = (
  snapshot: SmartHomeSnapshot,
  deviceId: string,
  patch: (d: SmartDevice) => SmartDevice,
): SmartHomeSnapshot => ({
  ...snapshot,
  rooms: snapshot.rooms.map((room) =>
    room.devices.some((d) => d.id === deviceId)
      ? { ...room, devices: room.devices.map((d) => (d.id === deviceId ? patch(d) : d)) }
      : room),
});

/**
 * The swap point. A real adapter exports this name with this signature from
 * `src/hooks/useSmartHome.ts`; nothing else on the page has to change.
 *
 * No fake latency, no fake failures: `loading` is false and `error` is null
 * because a local literal is neither loading nor failing. Inventing a spinner
 * would make the mock lie about a second thing.
 */
export function useSmartHome(): SmartHomeState {
  const [snapshot, setSnapshot] = useState<SmartHomeSnapshot>(SAMPLE_SNAPSHOT);

  const setDeviceValue = useCallback((deviceId: string, value: number) => {
    setSnapshot((s) => mapDevice(s, deviceId, (d) => ({ ...d, value })));
  }, []);

  const setDeviceColour = useCallback((deviceId: string, colour: string) => {
    setSnapshot((s) => mapDevice(s, deviceId, (d) => ({ ...d, colour })));
  }, []);

  const setWidgetOn = useCallback((widgetId: string, on: boolean) => {
    setSnapshot((s) => ({
      ...s,
      widgets: s.widgets.map((w) => (w.id === widgetId ? { ...w, on } : w)),
    }));
  }, []);

  const runScene = useCallback((sceneId: string) => {
    setSnapshot((s) => ({ ...s, activeSceneId: sceneId }));
  }, []);

  const setAutonomy = useCallback((ruleId: string, allowed: boolean) => {
    setSnapshot((s) => ({
      ...s,
      autonomy: s.autonomy.map((r) => (r.id === ruleId ? { ...r, allowed } : r)),
    }));
  }, []);

  return {
    snapshot,
    loading: false,
    error: null,
    setDeviceValue,
    setDeviceColour,
    setWidgetOn,
    runScene,
    setAutonomy,
  };
}
