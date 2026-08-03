/**
 * Atlas Health — the sample dataset.
 *
 * THERE IS NO HEALTH DATA SOURCE IN THIS APP. No HealthKit bridge, no wearable
 * pairing, no lab-import parser, nothing in SQLite. Every value below is copy
 * from `Atlas Health.dc.html`, reproduced so the surface can be designed and
 * reviewed against real-shaped content — and the surface says so on screen, on
 * the page band and again on every single card.
 *
 * This is the deliberate, labelled exception to the project's "honest UI, not
 * fake data" rule. It is honest *because* it is labelled. Remove
 * `<SampleNotice>` from `AtlasHealth.tsx` or the `SAMPLE` stamp from
 * `HealthWidget` and it becomes exactly the thing the T4 pass spent a week
 * deleting.
 *
 * ── HOW A REAL ADAPTER REPLACES THIS ────────────────────────────────────────
 *
 * `useAtlasHealthMock()` returns `UseAtlasHealth`, which is the shape a real
 * hook would return — nothing about it is mock-specific except that `isMock`
 * is `true` and `snapshot` is preloaded. A local adapter (say
 * `src/hooks/useAtlasHealthData.ts`, reading HealthKit through a Tauri command
 * into SQLite) implements the same interface and the swap is ONE line in
 * `AtlasHealth.tsx`:
 *
 *     -import { useAtlasHealthMock as useHealth } from '@/lib/mocks/health';
 *     +import { useAtlasHealthData as useHealth } from '@/hooks/useAtlasHealthData';
 *
 * with `isMock: false` making the sample chrome disappear on its own — the page
 * gates every sample treatment on `isMock`, never on a constant.
 *
 * The real adapter returns `snapshot: null` until it has read something, which
 * is why the page's first branch is a genuine empty state and not a spinner.
 *
 * NOTE the name clash: `useAtlasHealth` already exists in `src/hooks/` and is
 * about the *system's* health (knowledge count, error rate). Different subject
 * entirely. Nothing here touches it.
 */
import { useCallback, useMemo, useState } from 'react';

/** The one flag the UI reads to decide whether to wear the sample treatment. */
export const IS_MOCK = true;

/* ── Vocabulary ───────────────────────────────────────────────────────────── */

/** Card accent families. Design values live in `health.css` as `--hl-<cat>`. */
export type HealthCategory = 'heart' | 'move' | 'sleep' | 'body' | 'mind' | 'care';

/** The four readings the clay figure can be shaded by. */
export type ClayMode = 'recovery' | 'strain' | 'sleep' | 'composition';

/** Where a signal lands on the figure. `whole` shades every region. */
export type ClayRegion = 'head' | 'chest' | 'arms' | 'legs' | 'whole';

/** The seven card shapes the design draws. */
export type MetricKind = 'big' | 'bars' | 'rows' | 'progress' | 'split' | 'ring' | 'text';

/* ── Rows ─────────────────────────────────────────────────────────────────── */

export interface HealthSource {
  id: string;
  name: string;
  /** What it supplies. */
  meta: string;
  /** Freshness as the source itself reports it — "live", "4 min ago", "14 June". */
  state: string;
  enabled: boolean;
}

export interface HealthSignal {
  id: string;
  name: string;
  region: ClayRegion;
  /** What turning it off does to the figure. Design copy, verbatim. */
  note: string;
  /** Its supplier. A signal whose source is off is unavailable regardless of `enabled`. */
  sourceId: string;
  enabled: boolean;
}

export interface HealthDevice {
  id: string;
  name: string;
  meta: string;
  state: string;
  /** Drives the status dot: green when streaming, neutral when paused. */
  live: boolean;
}

export interface HealthPrivacyRule {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
}

export interface MetricRow {
  label: string;
  value: string;
}

export interface HealthMetric {
  id: string;
  name: string;
  category: HealthCategory;
  kind: MetricKind;
  /** Header right-hand context — "Today", "Overnight", "Rings". */
  kicker: string;
  /** Supplier. Off ⇒ the card renders its "not measured" state. */
  sourceId: string;
  /** Clay signals this metric additionally needs. All must be active. */
  signalIds: string[];
  value?: string;
  delta?: string;
  caption?: string;
  value2?: string;
  caption2?: string;
  /** 0–1. Drives the progress bar and the ring's conic sweep. */
  pct?: number;
  /** 0–100 heights, oldest → newest. The last bar is the accented one. */
  bars?: number[];
  rows?: MetricRow[];
  /** `kind: 'text'` only. */
  text?: string;
  /** Grid footprint in the 12-column dense grid. */
  cols: 2 | 3 | 5 | 6;
  rows_: 1 | 2;
}

export interface ClayHotspot {
  id: string;
  label: string;
  value: string;
  category: HealthCategory;
  /** 0–1 of the card box. */
  x: number;
  y: number;
  /** Pulse period in seconds. Ignored under `prefers-reduced-motion`. */
  beat: number;
  /** Vanishes with its signal rather than reporting a number nothing measured. */
  signalIds: string[];
}

export interface ClayReading {
  mode: ClayMode;
  label: string;
  verdict: string;
  note: string;
  /** Provenance line — which device, how long ago. */
  source: string;
  /** Without these the mode cannot be read at all and the figure stays neutral clay. */
  requires: string[];
  hotspots: ClayHotspot[];
}

export interface HealthSnapshot {
  /** When the sample was authored. A real adapter puts its last read here. */
  capturedAt: string;
  sources: HealthSource[];
  signals: HealthSignal[];
  devices: HealthDevice[];
  privacy: HealthPrivacyRule[];
  metrics: HealthMetric[];
  clay: ClayReading[];
  /** The paired wearable, or null. Design gives it its own dark card. */
  primaryDevice: {
    name: string;
    blurb: string;
    syncedLabel: string;
    batteryLabel: string;
  } | null;
}

/* ── The sample snapshot ──────────────────────────────────────────────────── */

const SOURCES: HealthSource[] = [
  { id: 's1', name: 'Apple Health', meta: 'Primary store · 14 signal types', state: '4 min ago', enabled: true },
  { id: 's2', name: 'Apple Watch Series 10', meta: 'Heart, sleep, workouts, temperature', state: 'live', enabled: true },
  { id: 's3', name: 'Withings Body Scan', meta: 'Weight and composition · Sundays', state: '2 days ago', enabled: true },
  { id: 's4', name: 'Oura Ring', meta: 'Duplicate sleep source — paused', state: 'paused', enabled: false },
  { id: 's5', name: 'Lab results (PDF import)', meta: 'Parsed on device · 4 panels', state: '14 June', enabled: true },
];

const SIGNALS: HealthSignal[] = [
  { id: 'g1', name: 'Heart rate', region: 'chest', note: 'Drives the chest glow and its beat rate.', sourceId: 's2', enabled: true },
  { id: 'g2', name: 'HRV', region: 'chest', note: 'Sets how green or amber the torso reads.', sourceId: 's2', enabled: true },
  { id: 'g3', name: 'Sleep stages', region: 'head', note: 'Shades the head in the sleep view.', sourceId: 's2', enabled: true },
  { id: 'g4', name: 'Workouts', region: 'legs', note: 'Adds load colour to the legs for 48 hours.', sourceId: 's2', enabled: true },
  { id: 'g5', name: 'Body composition', region: 'whole', note: 'Adjusts the figure’s proportions monthly.', sourceId: 's3', enabled: true },
  { id: 'g6', name: 'Blood pressure', region: 'arms', note: 'Manual entries only — currently off.', sourceId: 's1', enabled: false },
  { id: 'g7', name: 'Hydration', region: 'chest', note: 'Softens the clay surface when you are low.', sourceId: 's1', enabled: true },
  { id: 'g8', name: 'Wrist temperature', region: 'whole', note: 'Warms the palette when above baseline.', sourceId: 's2', enabled: true },
];

const DEVICES: HealthDevice[] = [
  { id: 'd1', name: 'iPhone 17 Pro', meta: 'Steps, daylight, noise', state: 'Live', live: true },
  { id: 'd2', name: 'Withings Body Scan', meta: 'Wi-Fi · every Sunday', state: 'Connected', live: true },
  { id: 'd3', name: 'Polar H10 chest strap', meta: 'Bluetooth · workouts only', state: 'Connected', live: true },
  { id: 'd4', name: 'Oura Ring Gen 4', meta: 'Conflicts with Watch sleep', state: 'Paused', live: false },
];

/**
 * Read-only in the UI, on purpose. A source switch has a visible, truthful
 * effect inside the sample — turn Apple Watch off and its cards go to "not
 * measured" in front of you. A privacy switch would have no effect at all,
 * because there is no health pipeline to constrain, so rendering a working
 * toggle here would be pure theatre. They render disabled with the reason.
 */
const PRIVACY: HealthPrivacyRule[] = [
  { id: 'v1', name: 'Keep raw samples on device', note: 'Only daily summaries would ever leave your phone.', enabled: true },
  { id: 'v2', name: 'Let Atlas mention health in answers', note: 'Off — health would stay inside this view.', enabled: false },
  { id: 'v3', name: 'Include health in the morning brief', note: 'One line, no numbers unless you ask.', enabled: true },
  { id: 'v4', name: 'Alert me to unusual readings', note: 'Resting heart, respiratory rate, temperature.', enabled: true },
];

const METRICS: HealthMetric[] = [
  {
    id: 'recovery', name: 'Recovery', category: 'heart', kind: 'ring', kicker: 'Readiness',
    sourceId: 's2', signalIds: ['g2'],
    value: '82%', caption: 'Ready for a hard session', pct: 0.82, cols: 3, rows_: 2,
  },
  {
    id: 'sleep', name: 'Sleep', category: 'sleep', kind: 'big', kicker: 'Last night',
    sourceId: 's2', signalIds: ['g3'],
    value: '7h 12m', delta: '+22m', caption: 'Deep 1h 40m · woke twice', cols: 2, rows_: 1,
  },
  {
    id: 'resting-heart', name: 'Resting heart', category: 'heart', kind: 'big', kicker: 'Today',
    sourceId: 's2', signalIds: ['g1'],
    value: '58', delta: 'bpm', caption: 'Five-day low · steady', cols: 2, rows_: 1,
  },
  {
    id: 'sleep-stages', name: 'Sleep stages', category: 'sleep', kind: 'rows', kicker: 'Last night',
    sourceId: 's2', signalIds: ['g3'],
    value: '7h 12m', caption: 'Four stages tracked', cols: 3, rows_: 2,
    rows: [
      { label: 'Deep', value: '1h 40m' },
      { label: 'Core', value: '4h 02m' },
      { label: 'REM', value: '1h 18m' },
      { label: 'Awake', value: '12m' },
    ],
  },
  {
    id: 'move-ring', name: 'Move ring', category: 'move', kind: 'ring', kicker: 'Rings',
    sourceId: 's1', signalIds: [],
    value: '420/500', caption: 'kcal active', pct: 0.84, cols: 2, rows_: 1,
  },
  {
    id: 'hrv', name: 'HRV', category: 'heart', kind: 'big', kicker: 'Overnight',
    sourceId: 's2', signalIds: ['g2'],
    value: '62 ms', delta: '+8', caption: 'Above your 60-day median', cols: 2, rows_: 1,
  },
  {
    id: 'steps', name: 'Steps', category: 'move', kind: 'bars', kicker: 'Daily',
    sourceId: 's1', signalIds: [],
    value: '8,240', caption: 'Last seven days', bars: [30, 48, 62, 40, 72, 55, 66], cols: 2, rows_: 1,
  },
  {
    id: 'hydration', name: 'Hydration', category: 'body', kind: 'progress', kicker: 'Today',
    sourceId: 's1', signalIds: ['g7'],
    value: '1.6 L', caption: 'of 2.4 L target', pct: 0.67, cols: 2, rows_: 1,
  },
  {
    id: 'workouts', name: 'Workouts', category: 'move', kind: 'rows', kicker: 'Logged',
    sourceId: 's2', signalIds: ['g4'],
    value: '3 this week', caption: '2h 45m total', cols: 3, rows_: 2,
    rows: [
      { label: 'Threshold run · 42 min', value: 'Mon' },
      { label: 'Strength · 55 min', value: 'Tue' },
      { label: 'Easy ride · 68 min', value: 'Thu' },
    ],
  },
  {
    id: 'medication', name: 'Medication', category: 'care', kind: 'rows', kicker: 'Schedule',
    sourceId: 's1', signalIds: [],
    value: '2 of 3', caption: 'One left today', cols: 3, rows_: 2,
    rows: [
      { label: 'Vitamin D · 08:00', value: 'taken' },
      { label: 'Iron · 13:00', value: 'taken' },
      { label: 'Magnesium · 22:00', value: 'due' },
    ],
  },
  {
    id: 'body-composition', name: 'Body composition', category: 'body', kind: 'split', kicker: 'Smart scale',
    sourceId: 's3', signalIds: ['g5'],
    value: '17.4%', caption: 'Body fat', value2: '34.1 kg', caption2: 'Lean mass', cols: 3, rows_: 1,
  },
  {
    id: 'mindful', name: 'Mindful minutes', category: 'mind', kind: 'progress', kicker: 'Practice',
    sourceId: 's1', signalIds: [],
    value: '12/20', caption: 'minutes today', pct: 0.6, cols: 3, rows_: 1,
  },
  {
    // Gated on HRV *and* sleep because that is what the sentence claims. Turn
    // either off and the card stops asserting it rather than keeping the line.
    id: 'atlas-said', name: 'Atlas said', category: 'mind', kind: 'text', kicker: 'Voice',
    sourceId: 's2', signalIds: ['g2', 'g3'],
    text: 'Your recovery is high and sleep debt is small — this is the best day this week for a hard session.',
    caption: 'Spoken aloud · 07:40', cols: 6, rows_: 1,
  },
];

const CLAY: ClayReading[] = [
  {
    mode: 'recovery', label: 'Recovery', requires: ['g1', 'g2'],
    verdict: 'Recovered and ready',
    note: 'HRV is eight milliseconds above your median and resting heart is at a five-day low. The model is shading green everywhere it has evidence.',
    source: 'Apple Watch · 4 min ago',
    hotspots: [
      { id: 'r1', label: 'Resting heart', value: '58 bpm', category: 'heart', x: 0.24, y: 0.36, beat: 1.4, signalIds: ['g1'] },
      { id: 'r2', label: 'HRV', value: '62 ms', category: 'body', x: 0.74, y: 0.40, beat: 2.4, signalIds: ['g2'] },
      { id: 'r3', label: 'Readiness', value: '82%', category: 'body', x: 0.70, y: 0.66, beat: 2.8, signalIds: ['g1', 'g2'] },
      { id: 'r4', label: 'Sleep', value: '7h 12m', category: 'sleep', x: 0.26, y: 0.14, beat: 3.2, signalIds: ['g3'] },
    ],
  },
  {
    mode: 'strain', label: 'Strain', requires: ['g4'],
    verdict: 'Yesterday still counts',
    note: 'Legs carry most of the load from Tuesday’s strength session. Atlas suggests keeping today aerobic and easy.',
    source: 'Workouts · 3 sessions',
    hotspots: [
      { id: 't1', label: 'Load', value: 'moderate', category: 'move', x: 0.72, y: 0.62, beat: 2.0, signalIds: ['g4'] },
      { id: 't2', label: 'Legs', value: 'heavy', category: 'move', x: 0.30, y: 0.76, beat: 2.2, signalIds: ['g4'] },
      { id: 't3', label: 'Peak HR', value: '168 bpm', category: 'heart', x: 0.24, y: 0.36, beat: 1.2, signalIds: ['g1'] },
      { id: 't4', label: 'Sessions', value: '3 this week', category: 'care', x: 0.72, y: 0.24, beat: 3.0, signalIds: ['g4'] },
    ],
  },
  {
    mode: 'sleep', label: 'Sleep', requires: ['g3'],
    verdict: 'Seven hours, twelve minutes',
    note: 'Deep sleep landed early and REM was slightly short. Two wakes, both under four minutes, neither worth worrying about.',
    source: 'Watch + iPhone · last night',
    hotspots: [
      { id: 'p1', label: 'Deep', value: '1h 40m', category: 'sleep', x: 0.26, y: 0.16, beat: 3.0, signalIds: ['g3'] },
      { id: 'p2', label: 'REM', value: '1h 18m', category: 'sleep', x: 0.72, y: 0.30, beat: 3.4, signalIds: ['g3'] },
      { id: 'p3', label: 'Wakes', value: '2', category: 'care', x: 0.26, y: 0.52, beat: 2.6, signalIds: ['g3'] },
      { id: 'p4', label: 'Resp. rate', value: '14.2', category: 'mind', x: 0.72, y: 0.62, beat: 2.2, signalIds: ['g3'] },
    ],
  },
  {
    mode: 'composition', label: 'Body', requires: ['g5'],
    verdict: 'Steady composition',
    note: 'Weight is trending down 0.4 kg over thirty days while lean mass held — the shape of the model has barely moved.',
    source: 'Smart scale · Sunday',
    hotspots: [
      { id: 'c1', label: 'Weight', value: '74.2 kg', category: 'body', x: 0.24, y: 0.48, beat: 3.0, signalIds: ['g5'] },
      { id: 'c2', label: 'Body fat', value: '17.4%', category: 'body', x: 0.74, y: 0.44, beat: 3.2, signalIds: ['g5'] },
      { id: 'c3', label: 'Lean mass', value: '34.1 kg', category: 'body', x: 0.70, y: 0.70, beat: 2.8, signalIds: ['g5'] },
      { id: 'c4', label: 'Hydration', value: '67%', category: 'mind', x: 0.28, y: 0.24, beat: 2.4, signalIds: ['g7'] },
    ],
  },
];

const SNAPSHOT: HealthSnapshot = {
  capturedAt: '2026-08-02T07:40:00+02:00',
  sources: SOURCES,
  signals: SIGNALS,
  devices: DEVICES,
  privacy: PRIVACY,
  metrics: METRICS,
  clay: CLAY,
  primaryDevice: {
    name: 'Apple Watch Series 10',
    blurb: 'Paired since March. Streams heart, workouts, sleep stages and wrist temperature. Atlas holds a rolling 90 days on device and summarises the rest.',
    syncedLabel: 'Synced 4 minutes ago',
    batteryLabel: 'Battery 68% · 1,204 samples today',
  },
};

/**
 * Clay palettes per mode, per region — RGB triples straight from the design.
 * These are *illustration* colours (README §1.1 keeps drawings out of the
 * borderless rule), not UI tokens, which is why they are numbers here and not
 * custom properties.
 */
export const CLAY_ZONES: Record<ClayMode, Record<Exclude<ClayRegion, 'whole'>, [number, number, number]>> = {
  recovery: { chest: [52, 175, 124], head: [70, 170, 130], legs: [92, 168, 120], arms: [80, 170, 128] },
  strain: { chest: [214, 96, 72], head: [206, 120, 96], legs: [214, 110, 64], arms: [210, 116, 86] },
  sleep: { chest: [110, 90, 220], head: [120, 100, 235], legs: [116, 102, 214], arms: [114, 98, 220] },
  composition: { chest: [60, 140, 110], head: [76, 142, 116], legs: [62, 146, 116], arms: [70, 144, 118] },
};

/* ── The hook a real adapter has to match ─────────────────────────────────── */

export interface UseAtlasHealth {
  /** `null` is the day-one state of any real adapter: connected to nothing. */
  snapshot: HealthSnapshot | null;
  loading: boolean;
  error: string | null;
  /** Drives every sample-data treatment on screen. A real adapter sets it false. */
  isMock: boolean;
  setSourceEnabled: (id: string, on: boolean) => void;
  setSignalEnabled: (id: string, on: boolean) => void;
  /**
   * Part of the contract a real adapter owes; the mock cannot refresh anything,
   * which is exactly why no control on the surface calls it. The Sync button in
   * the Sources view renders disabled with that reason written out.
   */
  refresh: () => Promise<void>;
}

/**
 * Sample-backed implementation.
 *
 * It does not pretend to fetch: `loading` is false on the first render, there is
 * no timer, and no promise resolves late. The only behaviour is the source and
 * signal switches, and those do real work — they decide what the rest of the
 * surface can honestly show.
 */
export const useAtlasHealthMock = (): UseAtlasHealth => {
  const [sources, setSources] = useState<HealthSource[]>(SOURCES);
  const [signals, setSignals] = useState<HealthSignal[]>(SIGNALS);

  const setSourceEnabled = useCallback((id: string, on: boolean) => {
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: on } : s)));
  }, []);

  const setSignalEnabled = useCallback((id: string, on: boolean) => {
    setSignals((prev) => prev.map((g) => (g.id === id ? { ...g, enabled: on } : g)));
  }, []);

  const refresh = useCallback(async () => {}, []);

  const snapshot = useMemo<HealthSnapshot>(
    () => ({ ...SNAPSHOT, sources, signals }),
    [sources, signals],
  );

  return { snapshot, loading: false, error: null, isMock: IS_MOCK, setSourceEnabled, setSignalEnabled, refresh };
};

/* ── Derivations shared by the page and its components ────────────────────── */

/** A signal counts only when it AND its supplier are on. */
export const isSignalActive = (snapshot: HealthSnapshot, id: string): boolean => {
  const signal = snapshot.signals.find((g) => g.id === id);
  if (!signal || !signal.enabled) return false;
  const source = snapshot.sources.find((s) => s.id === signal.sourceId);
  return !!source && source.enabled;
};

/**
 * Whether a card has anything behind it, and if not, what to switch back on.
 *
 * DELIBERATELY NOT a discriminated union. `tsconfig.json` sets
 * `strictNullChecks: false`, and under that setting TypeScript does not narrow
 * a union by a boolean-literal discriminant at all — `block.available ? … : …`
 * leaves `block` as the full union, so the tidy
 * `{ available: true } | { available: false; label: string }` shape fails to
 * compile at every call site. Optional fields with a documented invariant are
 * the version that survives this compiler configuration.
 */
export interface MetricBlock {
  available: boolean;
  /** Set whenever `available` is false. */
  reason?: 'source' | 'signal';
  /** The name of the switch to flip. Set whenever `available` is false. */
  label?: string;
}

export const metricAvailability = (snapshot: HealthSnapshot, metric: HealthMetric): MetricBlock => {
  const source = snapshot.sources.find((s) => s.id === metric.sourceId);
  if (!source || !source.enabled) {
    return { available: false, reason: 'source', label: source ? source.name : 'Its source' };
  }
  const missing = metric.signalIds.filter((id) => !isSignalActive(snapshot, id));
  if (missing.length > 0) {
    const names = missing.map((id) => snapshot.signals.find((g) => g.id === id)?.name ?? id);
    return { available: false, reason: 'signal', label: names.join(' and ') };
  }
  return { available: true };
};

/** Which regions of the figure have evidence behind them right now. */
export const activeRegions = (snapshot: HealthSnapshot): Set<Exclude<ClayRegion, 'whole'>> => {
  const out = new Set<Exclude<ClayRegion, 'whole'>>();
  for (const signal of snapshot.signals) {
    if (!isSignalActive(snapshot, signal.id)) continue;
    if (signal.region === 'whole') {
      out.add('head'); out.add('chest'); out.add('arms'); out.add('legs');
    } else {
      out.add(signal.region);
    }
  }
  return out;
};

/** True when the mode's own required signals are all live. */
export const isClayReadable = (snapshot: HealthSnapshot, reading: ClayReading): boolean =>
  reading.requires.every((id) => isSignalActive(snapshot, id));
