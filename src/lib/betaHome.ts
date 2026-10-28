/**
 * The Beta Home's model — what the page remembers and how it lays widgets
 * out. Pure, so the packing and the editor are tested without a DOM.
 *
 * From `Atlas Dashboard Beta.dc.html` (design/current/design_handoff_atlas_beta):
 * the Stage layout packs widgets into a six-column grid under the band, each
 * widget at the span its size gives it (S 2×1, M 3×1, L 3×2, XL 6×2), in the
 * user's order, until the row budget is spent. Edit Home reorders, resizes,
 * adds and removes against a capacity meter, and Cancel restores the snapshot
 * taken when the editor opened.
 *
 * Persistence: the widget order, sizes and visibility live in the existing
 * `dashboard_layout` table (one row per widget, `size` in the table's own
 * lowercase letters); the layout choice and the Home settings live in local
 * storage under `atlas:beta_home` — they are this Mac's preferences, not data.
 */

export type WidgetSize = 'S' | 'M' | 'L' | 'XL';
export type TableSize = 's' | 'm' | 'l' | 'xl';
export type HomeLayout = 'stage' | 'grid' | 'centred';

/** Column × row spans in the six-column grid (§04 Widget grid). */
export const SPANS: Record<WidgetSize, readonly [number, number]> = {
  S: [2, 1],
  M: [3, 1],
  L: [3, 2],
  XL: [6, 2],
};
export const GRID_COLUMNS = 6;

export const toTableSize = (s: WidgetSize): TableSize => s.toLowerCase() as TableSize;
export const fromTableSize = (s: string | null | undefined): WidgetSize => {
  const u = (s ?? 'l').toUpperCase();
  return u === 'S' || u === 'M' || u === 'L' || u === 'XL' ? u : 'L';
};

export type WidgetGroup = 'Day' | 'Communication' | 'Money' | 'Body' | 'Home' | 'Media' | 'Air & time';
/** Whether the widget shows real data today, a labelled sample, or is not wired yet. */
export type WidgetSource = 'live' | 'sample' | 'unwired';

export interface WidgetDef {
  id: string;
  label: string;
  /** One line under the label in the editor and the catalog. */
  meta: string;
  group: WidgetGroup;
  sizes: readonly WidgetSize[];
  defaultSize: WidgetSize;
  source: WidgetSource;
  /** The screen the widget opens; a path for a route, or a full-view key. */
  opens: { route: string } | { view: HomeViewKey } | null;
}

/** The full views Home can open under its band (components/atlas/home/views/FullView.tsx). */
export type HomeViewKey = 'weather' | 'calendar' | 'tasks' | 'stocks' | 'email' | 'news' | 'music' | 'focus' | 'fx' | 'podcast';

/**
 * Every widget Home can show, in the handoff's catalog order. `source` is
 * honest per widget: Energy has no source in the app yet and is listed so
 * the editor can say so, not so a fake card can be added. Focus, Up next and
 * Currency came with the Beta's left-out features (package F6), Podcast with
 * package F4.
 */
export const WIDGETS: readonly WidgetDef[] = [
  { id: 'weather', label: 'Weather', meta: 'Now, the next hours, sunrise and sunset', group: 'Day', sizes: ['S', 'M', 'L'], defaultSize: 'L', source: 'live', opens: { view: 'weather' } },
  { id: 'today', label: 'Today', meta: 'Your calendar, next event first', group: 'Day', sizes: ['S', 'M', 'L'], defaultSize: 'L', source: 'live', opens: { view: 'calendar' } },
  { id: 'tasks', label: 'Tasks', meta: 'Open tasks, tick them here', group: 'Day', sizes: ['S', 'M', 'L'], defaultSize: 'L', source: 'live', opens: { view: 'tasks' } },
  { id: 'inbox', label: 'Inbox', meta: 'What needs you, what Atlas handled', group: 'Communication', sizes: ['S', 'M', 'L'], defaultSize: 'L', source: 'live', opens: { route: '/mail' } },
  { id: 'watch', label: 'Watchlist', meta: 'Your tickers and portfolio', group: 'Money', sizes: ['S', 'M', 'L', 'XL'], defaultSize: 'M', source: 'live', opens: { view: 'stocks' } },
  { id: 'briefing', label: 'Briefing', meta: 'The headlines worth your morning', group: 'Communication', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { view: 'news' } },
  { id: 'air', label: 'Air quality', meta: 'PM2.5 where you are', group: 'Air & time', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { view: 'weather' } },
  { id: 'clock', label: 'Elsewhere', meta: 'Your Clock cities, next alarm and timer', group: 'Air & time', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/clock' } },
  { id: 'dials', label: 'Clock dials', meta: 'Home and your Clock cities as faces', group: 'Air & time', sizes: ['S', 'M', 'L'], defaultSize: 'M', source: 'live', opens: { route: '/clock' } },
  { id: 'countdown', label: 'Countdown', meta: 'The countdown you run in Clock', group: 'Air & time', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/clock' } },
  { id: 'music', label: 'Now playing', meta: 'Spotify through Atlas', group: 'Media', sizes: ['S', 'M', 'L'], defaultSize: 'M', source: 'live', opens: { view: 'music' } },
  { id: 'activity', label: 'Activity', meta: 'Move, exercise, stand', group: 'Body', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'sample', opens: { route: '/health' } },
  { id: 'steps', label: 'Steps', meta: 'Today and the last seven days', group: 'Body', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/health' } },
  { id: 'sleep', label: 'Sleep', meta: 'Last night, by stage', group: 'Body', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/health' } },
  { id: 'home', label: 'Home', meta: 'Rooms, temperatures, the front door', group: 'Home', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/smart-home' } },
  // Smart Home (F3): one light, the lights, and the door camera, through Home Assistant.
  { id: 'lamp', label: 'Lamp', meta: 'A colour light, on or off, with its swatches', group: 'Home', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/smart-home' } },
  { id: 'lights', label: 'Lights', meta: 'Which lights are on, and all off', group: 'Home', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/smart-home' } },
  { id: 'bulb', label: 'Bulb', meta: 'One light and its brightness', group: 'Home', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/smart-home' } },
  { id: 'floorlamp', label: 'Floor lamp', meta: 'The light named a floor lamp', group: 'Home', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { route: '/smart-home' } },
  { id: 'frontdoor', label: 'Front door', meta: 'The door camera and its last motion', group: 'Home', sizes: ['S', 'M', 'L'], defaultSize: 'L', source: 'live', opens: { route: '/smart-home' } },
  { id: 'energy', label: 'Energy', meta: 'No energy meter is connected yet', group: 'Home', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'unwired', opens: { route: '/smart-home' } },
  { id: 'podcast', label: 'Podcast', meta: 'Your Spotify shows, where you stopped', group: 'Media', sizes: ['S', 'M', 'L'], defaultSize: 'M', source: 'live', opens: { view: 'podcast' } },
  { id: 'focus', label: 'Focus', meta: 'A timer that holds Atlas’s notifications', group: 'Day', sizes: ['S', 'M', 'L'], defaultSize: 'M', source: 'live', opens: { view: 'focus' } },
  { id: 'upnext', label: 'Up next', meta: 'Your next events, with how long until each', group: 'Day', sizes: ['S', 'M', 'L'], defaultSize: 'M', source: 'live', opens: { view: 'calendar' } },
  { id: 'fx', label: 'Currency', meta: 'ECB reference rates for the pair you pick', group: 'Money', sizes: ['S', 'M', 'L'], defaultSize: 'S', source: 'live', opens: { view: 'fx' } },
];

export const WIDGET_BY_ID: ReadonlyMap<string, WidgetDef> = new Map(WIDGETS.map((w) => [w.id, w]));

/** The handoff's starting Home: what a fresh account sees. */
export const DEFAULT_HOME: readonly { id: string; size: WidgetSize }[] = [
  { id: 'inbox', size: 'L' },
  { id: 'weather', size: 'L' },
  { id: 'today', size: 'L' },
  { id: 'tasks', size: 'L' },
  { id: 'watch', size: 'M' },
  { id: 'music', size: 'M' },
  { id: 'air', size: 'S' },
  { id: 'steps', size: 'S' },
  { id: 'activity', size: 'S' },
  { id: 'briefing', size: 'S' },
  { id: 'clock', size: 'S' },
  { id: 'home', size: 'S' },
];

export interface HomeSlot {
  id: string;
  size: WidgetSize;
}

export interface PackedSlot extends HomeSlot {
  cols: number;
  rows: number;
  /** Entrance stagger, ms. */
  delay: number;
}

/**
 * Stage packing: widgets in order, each at its span, until the row budget is
 * spent. A widget taller than the budget is clipped to it; one that does not
 * fit is skipped and the next tried, so a small card can still slip into the
 * last gap (the handoff's `stageCards`). Returns what fits and what was left.
 */
export function packStage(slots: readonly HomeSlot[], rows: number, cols = GRID_COLUMNS): { placed: PackedSlot[]; dropped: HomeSlot[] } {
  const budget = Math.max(0, rows) * cols;
  let cells = 0;
  const placed: PackedSlot[] = [];
  const dropped: HomeSlot[] = [];
  slots.forEach((s, i) => {
    const [c, r0] = SPANS[s.size];
    const r = Math.min(r0, Math.max(1, rows));
    const n = c * r;
    if (cells + n > budget) { dropped.push(s); return; }
    cells += n;
    placed.push({ ...s, cols: c, rows: r, delay: i * 55 });
  });
  return { placed, dropped };
}

/** How many grid rows the Stage has under the band: 121 px per row, 12 px gaps. */
export function stageRowCount(viewportHeight: number, bandHeight: number, topBar = 64, dock = 94): number {
  const free = viewportHeight - topBar - bandHeight - dock - 18 - 12;
  return Math.max(1, Math.floor((free + 12) / (121 + 12)));
}

/** Cells used by a set of slots, for the editor's capacity meter. */
export function cellsUsed(slots: readonly HomeSlot[]): number {
  return slots.reduce((n, s) => n + SPANS[s.size][0] * SPANS[s.size][1], 0);
}

// --- Edit Home -----------------------------------------------------------------

export interface HomeSettings {
  density: 'Airy' | 'Regular' | 'Dense';
  labels: 'Always' | 'On hover';
  greeting: 'On open' | 'Never';
  surface: 'Paper' | 'Ink' | 'Mixed';
  atlasSize: 'Compact' | 'Balanced' | 'Generous';
}

export const DEFAULT_SETTINGS: HomeSettings = { density: 'Regular', labels: 'Always', greeting: 'On open', surface: 'Mixed', atlasSize: 'Balanced' };

export const SETTING_VALUES: { [K in keyof HomeSettings]: readonly HomeSettings[K][] } = {
  density: ['Airy', 'Regular', 'Dense'],
  labels: ['Always', 'On hover'],
  greeting: ['On open', 'Never'],
  surface: ['Paper', 'Ink', 'Mixed'],
  atlasSize: ['Compact', 'Balanced', 'Generous'],
};

export const SETTING_COPY: { [K in keyof HomeSettings]: { t: string; d: string } } = {
  atlasSize: { t: 'Atlas size', d: 'How much room the sphere takes' },
  density: { t: 'Widget density', d: 'Spacing between the widgets' },
  labels: { t: 'Widget labels', d: 'Show the small caps name on each widget' },
  greeting: { t: 'Spoken greeting', d: 'Atlas reads the morning line aloud' },
  surface: { t: 'Surface', d: 'Paper, ink, or a mix of both' },
};

export function cycleSetting<K extends keyof HomeSettings>(settings: HomeSettings, key: K): HomeSettings {
  const vals = SETTING_VALUES[key] as readonly HomeSettings[K][];
  const i = vals.indexOf(settings[key]);
  return { ...settings, [key]: vals[(i + 1) % vals.length] };
}

export interface EditorState {
  slots: HomeSlot[];
  layout: HomeLayout;
  settings: HomeSettings;
  /** What Cancel restores. */
  snapshot: { slots: HomeSlot[]; layout: HomeLayout; settings: HomeSettings };
}

export type EditorAction =
  | { type: 'move'; id: string; before: string | null }
  | { type: 'size'; id: string; size: WidgetSize }
  | { type: 'add'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'layout'; layout: HomeLayout }
  | { type: 'setting'; key: keyof HomeSettings }
  | { type: 'reset' }
  | { type: 'cancel' };

export function openEditor(slots: readonly HomeSlot[], layout: HomeLayout, settings: HomeSettings): EditorState {
  const copy = slots.map((s) => ({ ...s }));
  return { slots: copy, layout, settings, snapshot: { slots: copy.map((s) => ({ ...s })), layout, settings } };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'move': {
      const from = state.slots.findIndex((s) => s.id === action.id);
      if (from < 0) return state;
      const moving = state.slots[from];
      const rest = state.slots.filter((s) => s.id !== action.id);
      const at = action.before ? rest.findIndex((s) => s.id === action.before) : rest.length;
      if (at < 0) return state;
      rest.splice(at, 0, moving);
      return { ...state, slots: rest };
    }
    case 'size': {
      const def = WIDGET_BY_ID.get(action.id);
      if (!def || !def.sizes.includes(action.size)) return state;
      return { ...state, slots: state.slots.map((s) => (s.id === action.id ? { ...s, size: action.size } : s)) };
    }
    case 'add': {
      const def = WIDGET_BY_ID.get(action.id);
      if (!def || def.source === 'unwired' || state.slots.some((s) => s.id === action.id)) return state;
      return { ...state, slots: [...state.slots, { id: action.id, size: def.defaultSize }] };
    }
    case 'remove':
      return { ...state, slots: state.slots.filter((s) => s.id !== action.id) };
    case 'layout':
      return { ...state, layout: action.layout };
    case 'setting':
      return { ...state, settings: cycleSetting(state.settings, action.key) };
    case 'reset':
      return { ...state, slots: DEFAULT_HOME.map((s) => ({ ...s })), layout: 'stage', settings: { ...DEFAULT_SETTINGS } };
    case 'cancel':
      return { ...state, slots: state.snapshot.slots.map((s) => ({ ...s })), layout: state.snapshot.layout, settings: state.snapshot.settings };
  }
}

/** The capacity meter's reading for a draft at the current row count. */
export function capacity(slots: readonly HomeSlot[], rows: number): { used: number; total: number; over: boolean; label: string; tone: 'ok' | 'near' | 'over' } {
  const total = rows * GRID_COLUMNS;
  const used = cellsUsed(slots);
  const over = used > total;
  const tone = over ? 'over' : used >= total - 1 ? 'near' : 'ok';
  return { used, total, over, tone, label: over ? `${used - total} cells over` : `${used} of ${total} cells` };
}

/** Which draft slots will not fit at this row count (same packing as the page). */
export function overflowIds(slots: readonly HomeSlot[], rows: number): Set<string> {
  return new Set(packStage(slots, rows).dropped.map((s) => s.id));
}

// --- Local preferences ------------------------------------------------------------

export interface HomePrefs {
  layout: HomeLayout;
  settings: HomeSettings;
}
export const PREFS_KEY = 'atlas:beta_home';

export function parsePrefs(raw: string | null): HomePrefs {
  const out: HomePrefs = { layout: 'stage', settings: { ...DEFAULT_SETTINGS } };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Partial<HomePrefs>;
    if (v.layout === 'stage' || v.layout === 'grid' || v.layout === 'centred') out.layout = v.layout;
    if (v.settings && typeof v.settings === 'object') {
      const given = v.settings as unknown as Record<string, unknown>;
      const target = out.settings as unknown as Record<string, string>;
      for (const k of Object.keys(SETTING_VALUES) as (keyof HomeSettings)[]) {
        const val = given[k];
        if ((SETTING_VALUES[k] as readonly string[]).includes(String(val))) target[k] = String(val);
      }
    }
  } catch { /* a corrupt preference is a default, not a crash */ }
  return out;
}
