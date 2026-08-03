/**
 * Atlas Widget Sheet — the spec registry.
 *
 * The sheet is a *specification* surface: one widget at a time, in detail —
 * what it answers, what sizes it honours, what it is bound to, what it looks
 * like in each lifecycle state, and how it behaves. Everything here is design
 * intent plus verified facts about this repo. Two kinds of content live in this
 * file and they are deliberately kept apart:
 *
 *  - THE BINDING (`source`, `shippedSize`, `behaviour`, every `ship` flag) is
 *    read from the code. `hook`, `transport`, `keychainAccount` and the
 *    `notes` were checked against `src/hooks/*`, `src/integrations/local/
 *    localClient.ts` and `src-tauri/src/datafetch.rs` on 2026-08-03. If one of
 *    those files moves, this file is wrong and should be corrected, not
 *    softened.
 *
 *  - THE PREVIEW COPY (`preview`) is sample content, and the sheet says so on
 *    screen. A spec sheet's job is to show a state, which needs *something* in
 *    the card; that is not the same fabrication as a dashboard inventing rows
 *    it does not have. The sheet never claims a preview is live, and the live
 *    part of the page — whether a provider key is actually present — comes from
 *    the `brain_ai_status` Tauri command, not from here.
 *
 * The widget list is the real dashboard card set (`AtlasDashboard.tsx` renders
 * exactly these ten). The design file's "§02 Proposed new widgets" — Commute,
 * Flight watch, Focus, Health, Home, Memory digest — is NOT in here: none of
 * them exists in the app, and a per-widget spec sheet whose source of truth is
 * the real card set cannot document six cards that have no data, no component
 * and no place in the grid.
 */

/* ------------------------------------------------------------------ states */

export type WidgetStateId = 'loading' | 'default' | 'attention' | 'empty' | 'offline' | 'nosource';

/**
 * Canonical order. Each widget's `states` array is authored in this order, and
 * the sheet renders it as authored — the order is a reading order (what you see
 * first, then what happens, then what goes wrong), not a sort key.
 */
export const STATE_LABEL: Record<WidgetStateId, string> = {
  loading: 'Loading',
  default: 'Default',
  attention: 'Attention',
  empty: 'Empty',
  offline: 'Offline',
  nosource: 'No source',
};

/**
 * What the SHIPPED card does in this state today.
 *
 * The design names five states; this sheet names six, because "the provider key
 * is not set" is a real condition several cards can be in and it is not the
 * same thing as being offline. `ship` is how the sheet stays honest about the
 * gap between the two.
 */
export type ShipState = 'built' | 'partial' | 'absent' | 'n/a';

export const SHIP_LABEL: Record<ShipState, string> = {
  built: 'Built',
  partial: 'Partial',
  absent: 'Not built',
  'n/a': 'Not applicable',
};

/* ----------------------------------------------------------------- preview */

export interface PreviewAlert {
  tone: 'info' | 'error';
  text: string;
}

export interface PreviewRow {
  /** Fixed left slot: a time, a ticker, initials, a checkbox. */
  lead?: string;
  /** `dot` draws the accent dot, `check`/`done` the task box, `avatar` initials. */
  leadKind?: 'dot' | 'check' | 'done' | 'avatar' | 'text';
  title: string;
  meta?: string;
  trail?: string;
  trailTone?: 'muted' | 'pill' | 'action';
  /** A signed change, coloured by `deltaTone`. Kept separate from `trail` so a
   *  price and its movement are two values, not one concatenated string. */
  delta?: string;
  deltaTone?: 'up' | 'down';
  tone?: 'default' | 'muted' | 'alert' | 'done';
}

export type PreviewBlock =
  | { kind: 'skeleton'; bars: Array<{ w: string; h?: number; top?: number }> }
  | { kind: 'metric'; value: string; aside?: string; caption?: string; chips?: string[] }
  | { kind: 'rows'; rows: PreviewRow[] }
  | { kind: 'progress'; pct: number; label: string }
  | { kind: 'stack'; items: Array<{ kicker?: string; breaking?: boolean; headline: string; source?: string }> }
  | { kind: 'note'; text: string }
  | { kind: 'empty'; title: string; body: string; action?: string };

export interface PreviewSpec {
  /** Card header label. Omitted on the loading state, which shimmers its own. */
  label?: string;
  /** Header icon well filled with the accent — the design's `.ibx.on`. */
  hot?: boolean;
  alert?: PreviewAlert;
  blocks: PreviewBlock[];
  /** Dim the body — the offline "last good reading" treatment. */
  dim?: boolean;
  /** Small tertiary line under everything: cache age, queue depth. */
  foot?: string;
}

export interface WidgetState {
  id: WidgetStateId;
  /** What puts the widget into this state. */
  trigger: string;
  /** `null` = the widget does not define this state, and `why` says why. */
  preview: PreviewSpec | null;
  why?: string;
  ship: ShipState;
  /** What the shipped card actually does. Verified, not assumed. */
  shipNote: string;
}

/* ------------------------------------------------------------------ source */

/** The `brain_ai_status` keys that gate a widget (`src-tauri/src/lib.rs`). */
export type StatusKey = 'openweather' | 'finnhub' | 'news' | 'elevenlabs' | 'anthropic';

export interface SourceSpec {
  /**
   * `external` needs a provider key; `local` reads the on-device SQLite core;
   * `device` is the machine itself (clock, audio); `none` has no source at all.
   */
  kind: 'external' | 'local' | 'device' | 'none';
  hook: string;
  transport: string;
  provider?: string;
  /** Present only when a Keychain key gates the data. */
  statusKey?: StatusKey;
  keychainAccount?: string;
  refresh: string;
  /** Verified caveats. These are the reason this sheet exists. */
  notes: string[];
}

/* ------------------------------------------------------------------- sizes */

export type SizeId = 's' | 'm' | 'l' | 'xl' | 'hero';

export interface SizeSpec {
  id: SizeId;
  label: string;
  /** Span in the dashboard grid (`.gridB`, auto-fill minmax(340px, 1fr)). */
  app: string | null;
  /** The Workshop classes `<Card size>` emits. */
  cls: string;
  /** The Widget Catalog's nominal span on its own 12-column, 126px-row grid. */
  catalog: string;
  note?: string;
}

/**
 * The size ladder, from `<Card>`'s own `SPAN` map.
 *
 * `hero` is listed and marked unavailable rather than quietly aliased onto
 * `xl` — the same call `Card.tsx` already made, for the same reason: there is
 * no widget registry carrying per-widget span metadata, the ten cards are a
 * hardcoded list, and rendering a `hero` at `xl` would hide that.
 */
export const SIZES: readonly SizeSpec[] = [
  { id: 's', label: 'Small', app: '1 col × 1 row', cls: '(no span class)', catalog: '2 × 1' },
  { id: 'm', label: 'Medium', app: '2 cols × 1 row', cls: '.sp2', catalog: '3 × 1' },
  { id: 'l', label: 'Large', app: '1 col × 2 rows', cls: '.rs2', catalog: '3 × 2' },
  { id: 'xl', label: 'Extra large', app: '2 cols × 2 rows', cls: '.sp2 .rs2', catalog: '6 × 2' },
  {
    id: 'hero', label: 'Hero', app: null, cls: '—', catalog: '6 × 3',
    note: 'Not expressible in this app. The dashboard grid has two span modifiers and no widget registry to carry a third; `CardSize` stops at `xl`.',
  },
];

/* ------------------------------------------------------------------ widget */

export interface WidgetSpec {
  id: string;
  name: string;
  /** A lucide export name, resolved to a component by the page. */
  icon: string;
  category: string;
  /** The one question the widget answers. */
  answers: string;
  purpose: string;
  /** The size the dashboard actually renders it at. */
  shippedSize: SizeId;
  /** Entry-animation index on the dashboard — its place in the grid order. */
  order: number;
  /** Does clicking it open a focused view? */
  opens: string | null;
  source: SourceSpec;
  behaviour: Array<{ label: string; value: string }>;
  states: WidgetState[];
}

/* Shorthands that keep the table below readable. */
const skel = (bars: Array<{ w: string; h?: number; top?: number }>): PreviewSpec => ({
  blocks: [{ kind: 'skeleton', bars }],
});

export const WIDGETS: readonly WidgetSpec[] = [
  /* -------------------------------------------------------------- weather */
  {
    id: 'weather',
    name: 'Weather',
    icon: 'CloudSun',
    category: 'Weather',
    answers: 'What is it doing outside, and will that change before I go out?',
    purpose:
      'Full-bleed scene card: the current reading, today’s high and low, an hourly strip and the sun times. The atmosphere canvas behind it is painted from the condition string.',
    shippedSize: 'l',
    order: 1,
    opens: 'The focused weather view (`AtlasExpanded which="weather"`).',
    source: {
      kind: 'external',
      hook: 'useWeather(city)',
      transport: "localClient.functions.invoke('get-weather') → Tauri `fetch_weather`",
      provider: 'OpenWeather (current + forecast + air pollution)',
      statusKey: 'openweather',
      keychainAccount: 'atlas-core / openweather_api_key',
      refresh: 'Every 30 minutes',
      notes: [
        'When the key is absent, `fetch_weather` returns `mock_weather(city)` — a full, plausible reading. The card cannot tell that apart from real data, and neither can the user.',
        '`useWeather` also holds a module-level FALLBACK_WEATHER and returns it while the fetch is in flight, so the card never renders an empty or loading state.',
        'The “UV 6” chip on the shipped card is a hardcoded literal. OpenWeather’s UV index is not requested and not in `WeatherData`.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Click or Enter/Space — the card is a `role="button"` via `<Card onOpen>`.' },
      { label: 'Refresh', value: 'Interval only. There is no manual refresh control on the card.' },
      { label: 'Attention rule', value: 'Precipitation or a severe alert inside 6 hours. Not implemented — the hook exposes no alert field.' },
      { label: 'Motion', value: 'The atmosphere canvas pauses when the window is inactive (`useWindowActivity`).' },
    ],
    states: [
      {
        id: 'loading',
        trigger: 'First paint, before the local command answers.',
        preview: skel([{ w: '80px' }, { w: '56%', h: 26, top: 14 }, { w: '40%' }, { w: '88%', top: 16 }, { w: '72%' }]),
        ship: 'absent',
        shipNote: 'The hook substitutes FALLBACK_WEATHER immediately, so this state never reaches the screen.',
      },
      {
        id: 'default',
        trigger: 'A reading resolved and nothing needs saying.',
        preview: {
          label: 'Weather',
          blocks: [
            { kind: 'metric', value: '68°', aside: 'H 70° · L 58°', caption: 'Partly cloudy · San Francisco', chips: ['62% humidity', '8 mph wind', 'Sunset 17:24'] },
          ],
        },
        ship: 'built',
        shipNote: 'Matches, minus the fabricated UV chip.',
      },
      {
        id: 'attention',
        trigger: 'Rain or a severe alert arrives within six hours.',
        preview: {
          label: 'Weather',
          hot: true,
          alert: { tone: 'info', text: 'Rain starts ~15:10 — before your 15:30 walk-up' },
          blocks: [
            { kind: 'metric', value: '64°', aside: '88% rain', caption: 'Clouds building · San Francisco' },
          ],
        },
        ship: 'absent',
        shipNote: 'No alert channel exists. `WeatherData` carries no warnings and no precipitation timeline, so nothing can raise this state.',
      },
      {
        id: 'empty',
        trigger: 'No location set — no calendar city and no fixed home base.',
        preview: {
          blocks: [{ kind: 'empty', title: 'No location set', body: 'Atlas can follow your calendar’s city or a fixed home base.', action: 'Set location' }],
        },
        ship: 'absent',
        shipNote: '`useWeather()` defaults to the string "San Francisco", so "no location" is unreachable — the card shows a city the user never chose.',
      },
      {
        id: 'offline',
        trigger: 'The station is unreachable and a cached reading exists.',
        preview: {
          label: 'Weather',
          alert: { tone: 'error', text: 'Station unreachable — retrying' },
          dim: true,
          blocks: [{ kind: 'metric', value: '68°', aside: 'cached 12 min ago', caption: 'Showing last good reading' }],
        },
        ship: 'absent',
        shipNote: '`useWeather` returns `error`; the card destructures only `weather` and drops it. Nothing on screen changes when the fetch fails.',
      },
      {
        id: 'nosource',
        trigger: 'No OpenWeather key in the Keychain.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Weather needs a key', body: 'Add an OpenWeather API key in Settings and Atlas will read your actual conditions.', action: 'Open Settings' }],
        },
        ship: 'absent',
        shipNote: 'The worst of the six. `fetch_weather` silently returns sample data, so a keyless install shows a confident 68° that is not a measurement of anything.',
      },
    ],
  },

  /* ------------------------------------------------------------- calendar */
  {
    id: 'calendar',
    name: 'Today',
    icon: 'Calendar',
    category: 'Time',
    answers: 'What is on today, and what is next?',
    purpose:
      'The day’s agenda as a short list — time, title, location — with the next upcoming event marked "Now".',
    shippedSize: 'l',
    order: 2,
    opens: 'The focused calendar view.',
    source: {
      kind: 'local',
      hook: 'useCalendarEvents()',
      transport: "localClient.from('user_events') → local SQLite core",
      refresh: 'On mount and on `db:changed`',
      notes: [
        'Local-only. There is no calendar connector — events exist because something in Atlas wrote them, not because a calendar was synced.',
        'The hook returns `[]` when there is no signed-in user, which reads identically to a genuinely empty day.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Click or Enter/Space.' },
      { label: 'Row cap', value: 'Four events. There is no "+3 more" affordance.' },
      { label: '“Now” marker', value: 'First event whose `start_time` is at or after now — a position, not a countdown.' },
      { label: 'Attention rule', value: 'Event starting within 10 minutes, with a join action. Not implemented.' },
    ],
    states: [
      {
        id: 'loading',
        trigger: 'The first query has not returned.',
        preview: skel([{ w: '64px' }, { w: '90%', top: 12 }, { w: '82%' }, { w: '86%' }, { w: '60%' }]),
        ship: 'absent',
        shipNote: '`isLoading` is available on the hook and unused by the card; an empty list renders instead.',
      },
      {
        id: 'default',
        trigger: 'Events exist for today.',
        preview: {
          label: 'Today · 4 events',
          blocks: [
            { kind: 'rows', rows: [
              { lead: '09:30', leadKind: 'dot', title: 'Design sync' },
              { lead: '11:00', leadKind: 'dot', title: 'Atlas roadmap review' },
              { lead: '14:00', leadKind: 'dot', title: '1:1 with Maya', trail: 'Now', trailTone: 'pill' },
            ] },
          ],
        },
        ship: 'built',
        shipNote: 'Matches. The header count is real.',
      },
      {
        id: 'attention',
        trigger: 'An event starts within ten minutes.',
        preview: {
          label: 'Today',
          hot: true,
          alert: { tone: 'info', text: '1:1 with Maya in 5 min' },
          blocks: [{ kind: 'rows', rows: [{ lead: '14:00', leadKind: 'dot', title: '1:1 with Maya', trail: 'Join', trailTone: 'action' }] }],
          foot: 'Then: Eng standup · 16:30',
        },
        ship: 'absent',
        shipNote: 'No ticking clock and no conferencing link on `CalendarEvent`, so neither the countdown nor the Join action has anything behind it.',
      },
      {
        id: 'empty',
        trigger: 'Nothing scheduled today.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Nothing scheduled', body: 'Clear day. Atlas will guard it — say the word to block focus time.', action: 'Block focus time' }],
        },
        ship: 'partial',
        shipNote: 'The card renders a plain "No events today" line, not the designed `<Empty>` block, and offers no action.',
      },
      {
        id: 'offline',
        trigger: 'The last sync failed; cached events are shown.',
        preview: {
          label: 'Today',
          alert: { tone: 'error', text: 'Calendar sync failed' },
          dim: true,
          blocks: [{ kind: 'rows', rows: [{ lead: '14:00', leadKind: 'dot', title: '1:1 with Maya' }] }],
          foot: 'cached 4 min ago',
        },
        ship: 'n/a',
        shipNote: 'There is nothing to be offline from — the events are already on this machine. The state applies only once a calendar connector exists.',
      },
      {
        id: 'nosource',
        trigger: 'No calendar connected.',
        preview: {
          blocks: [{ kind: 'empty', title: 'No calendar connected', body: 'Atlas reads the events it has been given. Connect a calendar and today fills itself in.', action: 'Connect calendar' }],
        },
        ship: 'absent',
        shipNote: 'This is the honest state for the app as it stands, and it is the one the card does not draw: an empty `user_events` table renders as "No events today", which says the day is clear when in fact nothing is connected.',
      },
    ],
  },

  /* ---------------------------------------------------------------- tasks */
  {
    id: 'tasks',
    name: 'Tasks',
    icon: 'Check',
    category: 'Work',
    answers: 'What have I said I would do, and how much of it is left?',
    purpose: 'A checklist with a completion bar. Atlas files tasks here from chat.',
    shippedSize: 'l',
    order: 3,
    opens: 'The focused tasks view.',
    source: {
      kind: 'local',
      hook: 'useTasks()',
      transport: "localClient.from('user_tasks') → local SQLite core",
      refresh: 'On mount and after every optimistic write',
      notes: [
        'Fully local and fully real — this is one of the two widgets with no provider dependency and no fabrication anywhere in its path.',
        '`priority` and `due_date` exist on the row and are not rendered on the card.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Click or Enter/Space.' },
      { label: 'Row cap', value: 'Five tasks, newest first.' },
      { label: 'Progress', value: 'Real: `completedCount / tasks.length` from the hook.' },
      { label: 'Attention rule', value: 'An overdue task rises to the top in red. `due_date` exists; nothing compares it to now.' },
    ],
    states: [
      {
        id: 'loading',
        trigger: 'The first query has not returned.',
        preview: skel([{ w: '72px' }, { w: '100%', h: 5, top: 12 }, { w: '88%', top: 12 }, { w: '76%' }, { w: '82%' }]),
        ship: 'absent',
        shipNote: '`isLoading` is exposed and unused; the card renders as if the list were empty.',
      },
      {
        id: 'default',
        trigger: 'Open tasks exist.',
        preview: {
          label: 'Tasks · 1 of 5',
          blocks: [
            { kind: 'progress', pct: 20, label: '20%' },
            { kind: 'rows', rows: [
              { leadKind: 'check', title: 'Send Q4 budget notes to Sarah', trail: 'High', trailTone: 'pill' },
              { leadKind: 'done', title: 'Book Paris hotel', tone: 'done', trail: 'Done', trailTone: 'pill' },
            ] },
          ],
        },
        ship: 'partial',
        shipNote: 'Rows and the bar match. The priority pill is not rendered, though `priority` is on every row.',
      },
      {
        id: 'attention',
        trigger: 'At least one task is past its due date.',
        preview: {
          label: 'Tasks',
          hot: true,
          alert: { tone: 'error', text: '1 task overdue' },
          blocks: [{ kind: 'rows', rows: [
            { leadKind: 'check', title: 'Renew passport — due yesterday', tone: 'alert' },
            { leadKind: 'check', title: 'Send Q4 budget notes', trail: 'High', trailTone: 'pill' },
          ] }],
        },
        ship: 'absent',
        shipNote: 'The data is there — `due_date` is on the row — and the comparison is simply not written. This is the cheapest of the six to build.',
      },
      {
        id: 'empty',
        trigger: 'No open tasks.',
        preview: {
          blocks: [{ kind: 'empty', title: 'All clear', body: 'Nothing on your plate. Atlas files new tasks from chat automatically.' }],
        },
        ship: 'absent',
        shipNote: 'The card renders the header and then nothing at all — a blank card body, which reads as broken rather than clear.',
      },
      {
        id: 'offline',
        trigger: 'Edits made while a write is failing.',
        preview: {
          label: 'Tasks',
          alert: { tone: 'error', text: 'Changes queued locally' },
          dim: true,
          blocks: [{ kind: 'rows', rows: [{ leadKind: 'check', title: 'Send Q4 budget notes to Sarah', trail: 'High', trailTone: 'pill' }] }],
          foot: '2 edits will sync when back online',
        },
        ship: 'n/a',
        shipNote: 'The store is on this machine. `useCrudOperations` rolls a failed write back locally; there is no queue and no remote to be out of sync with.',
      },
      {
        id: 'nosource',
        trigger: 'No signed-in user.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Sign in to see your tasks', body: 'Tasks are stored per account on this Mac.' }],
        },
        ship: 'absent',
        shipNote: '`useTasks` returns `[]` with no user, which is indistinguishable from an empty list. The dashboard is behind an auth gate, so this is a narrow window — but it is the only case where "empty" is a lie.',
      },
    ],
  },

  /* ------------------------------------------------------------ watchlist */
  {
    id: 'watchlist',
    name: 'Watchlist',
    icon: 'Activity',
    category: 'Money',
    answers: 'What are my holdings doing right now?',
    purpose:
      'Live tickers with an area chart across the top. When a brokerage is linked, the same card carries the portfolio summary.',
    shippedSize: 'xl',
    order: 4,
    opens: 'The focused markets view.',
    source: {
      kind: 'external',
      hook: "useStocks(['AAPL','GOOGL','MSFT','NVDA']) + usePortfolio()",
      transport: "localClient.functions.invoke('get-stocks') → Tauri `fetch_stocks`; portfolio via `portfolio_*` commands",
      provider: 'Finnhub (quotes + profiles); SnapTrade for the linked portfolio',
      statusKey: 'finnhub',
      keychainAccount: 'atlas-core / finnhub_api_key',
      refresh: 'Every 5 minutes',
      notes: [
        'The watchlist symbols are a hardcoded four-element array in `AtlasCards.tsx`, not a user preference. Nothing in the app can add or remove a ticker.',
        'Without the Finnhub key, `fetch_stocks` returns `mock_stock(symbol)` per symbol plus mock indices — prices, changes and sparklines that look exactly like a live feed.',
        '`usePortfolio` is honest by contrast: it reports `available` (desktop only), `hasCredentials` and `connected` separately, so the card can say which of the three is missing.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Click or Enter/Space.' },
      { label: 'Row cap', value: 'Four symbols — the whole hardcoded list.' },
      { label: 'Market hours', value: 'The design shows an "Open" pulse. Nothing in the app knows whether the market is open.' },
      { label: 'Attention rule', value: 'A holding crosses ±3%. No threshold is stored anywhere.' },
    ],
    states: [
      {
        id: 'loading',
        trigger: 'The first quote request is in flight.',
        preview: skel([{ w: '90px' }, { w: '92%', top: 12 }, { w: '88%' }, { w: '90%' }]),
        ship: 'absent',
        shipNote: 'MOCK_STOCKS is served as fallback data on the first render, so the card is never visibly loading.',
      },
      {
        id: 'default',
        trigger: 'Quotes resolved.',
        preview: {
          label: 'Watchlist · Open',
          blocks: [{ kind: 'rows', rows: [
            { lead: 'AAPL', leadKind: 'text', title: 'Apple Inc.', trail: '247.31', delta: '+1.3%', deltaTone: 'up' },
            { lead: 'NVDA', leadKind: 'text', title: 'NVIDIA', trail: '1,204', delta: '+2.3%', deltaTone: 'up' },
            { lead: 'TSLA', leadKind: 'text', title: 'Tesla', trail: '312.44', delta: '−0.8%', deltaTone: 'down' },
          ] }],
        },
        ship: 'built',
        shipNote: 'Matches, plus an area chart the design sheet does not show at this size.',
      },
      {
        id: 'attention',
        trigger: 'A holding moves past the alert threshold.',
        preview: {
          label: 'Watchlist',
          hot: true,
          alert: { tone: 'info', text: 'NVDA +5.2% — crossed your alert threshold' },
          blocks: [{ kind: 'rows', rows: [{ lead: 'NVDA', leadKind: 'text', title: 'NVIDIA', trail: '1,238', delta: '+5.2%', deltaTone: 'up' }] }],
          foot: 'Atlas summarised 3 sources',
        },
        ship: 'absent',
        shipNote: 'No threshold, no alert store, and no link between the news and stocks paths.',
      },
      {
        id: 'empty',
        trigger: 'No tickers chosen.',
        preview: {
          blocks: [{ kind: 'empty', title: 'No tickers yet', body: 'Tell Atlas what you hold or watch and it will track moves and news.', action: 'Add tickers' }],
        },
        ship: 'absent',
        shipNote: 'Unreachable: the symbol list is a constant, so the card can never have zero tickers.',
      },
      {
        id: 'offline',
        trigger: 'The quote feed is unreachable.',
        preview: {
          label: 'Watchlist',
          alert: { tone: 'error', text: 'Feed disconnected' },
          dim: true,
          blocks: [{ kind: 'rows', rows: [{ lead: 'AAPL', leadKind: 'text', title: 'Apple Inc.', trail: '247.31', delta: '+1.3%', deltaTone: 'up' }] }],
          foot: 'last tick 38s ago · reconnecting',
        },
        ship: 'absent',
        shipNote: '`error` is exposed by the hook and ignored by the card. A stale price is shown with no indication of its age.',
      },
      {
        id: 'nosource',
        trigger: 'No Finnhub key in the Keychain.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Markets need a key', body: 'Add a Finnhub API key in Settings to see real quotes. Until then Atlas has no prices.', action: 'Open Settings' }],
        },
        ship: 'absent',
        shipNote: 'Four named companies with plausible prices and sparklines are rendered from `mock_stock`. Of the six widgets that can hit this state, this is the one where believing the sample data could cost money.',
      },
    ],
  },

  /* ---------------------------------------------------------------- inbox */
  {
    id: 'inbox',
    name: 'Inbox',
    icon: 'Mail',
    category: 'Comms',
    answers: 'Is there anything in my mail that needs me?',
    purpose:
      'Priority mail only — the messages Atlas judged important, with a bill/deadline alert count in the header.',
    shippedSize: 'l',
    order: 5,
    opens: 'The focused mail glance; the full three-pane surface is `/mail`.',
    source: {
      kind: 'local',
      hook: 'useMailIntelligence()',
      transport: "localClient.from('mail_accounts' | 'mail_messages' | 'mail_alerts') + a realtime channel on mail_alerts",
      provider: 'Gmail, read-only, through the mail connector',
      refresh: 'On mount, then pushed via the local realtime channel',
      notes: [
        'Connecting a personal mailbox is not built: `mail-oauth-start` and `mail-disconnect` are in `UNBUILT_MAIL_FNS` and return a legible error rather than pretending.',
        '`encrypted_refresh_token` is projected out in JS (`pickAccount`) before any row reaches React state — the local shim ignores `select()` column lists.',
        'This is the only one of the ten cards that ships a designed `<Empty>` state.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Click or Enter/Space — a glance, not the mail surface.' },
      { label: 'Row cap', value: 'Four messages.' },
      { label: 'Priority', value: 'Real: `category === "bills"` or `importance >= 0.7` marks a row hot.' },
      { label: 'Attention rule', value: 'An urgent message with a drafted reply. Drafts exist on `/mail`; the card does not read them.' },
    ],
    states: [
      {
        id: 'loading',
        trigger: 'The account and message queries are in flight.',
        preview: skel([{ w: '76px' }, { w: '90%', top: 12 }, { w: '84%' }]),
        ship: 'partial',
        shipNote: '`isLoading` gates the empty state so it cannot flash, but no skeleton is drawn — the body is simply blank.',
      },
      {
        id: 'default',
        trigger: 'A mailbox is connected and messages exist.',
        preview: {
          label: 'Inbox · 2 unread',
          blocks: [{ kind: 'rows', rows: [
            { lead: 'SC', leadKind: 'avatar', title: 'Sarah Chen', meta: 'Q4 budget — needs your input', trail: '09:12', trailTone: 'muted' },
            { lead: 'MJ', leadKind: 'avatar', title: 'Mike Johnson', meta: 'Design review notes', trail: 'Yesterday', trailTone: 'muted' },
          ] }],
        },
        ship: 'built',
        shipNote: 'Matches, with a real timestamp in the trail slot.',
      },
      {
        id: 'attention',
        trigger: 'Atlas judged a message urgent and has a reply drafted.',
        preview: {
          label: 'Inbox',
          hot: true,
          alert: { tone: 'info', text: 'Urgent: Sarah needs the budget before Friday’s board' },
          blocks: [{ kind: 'rows', rows: [{ lead: 'SC', leadKind: 'avatar', title: 'Sarah Chen', meta: 'Draft reply is ready to review', trail: 'Review', trailTone: 'action' }] }],
        },
        ship: 'absent',
        shipNote: 'Alerts exist (`mail_alerts`) and the card counts them in the header, but never surfaces one as a strip. The draft link would have to cross into `/mail`.',
      },
      {
        id: 'empty',
        trigger: 'Connected, nothing needs you.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Inbox zero', body: 'Nothing needs you. Atlas is triaging quietly in the background.' }],
        },
        ship: 'partial',
        shipNote: 'Connected-and-empty renders "Scanning your inbox…", which is a different claim from "nothing needs you". Only the not-connected case gets a real `<Empty>`.',
      },
      {
        id: 'offline',
        trigger: 'Mail sync is paused or failing.',
        preview: {
          label: 'Inbox',
          alert: { tone: 'error', text: 'Mail sync paused' },
          dim: true,
          blocks: [{ kind: 'rows', rows: [{ lead: 'SC', leadKind: 'avatar', title: 'Sarah Chen', meta: 'Q4 budget — needs your input' }] }],
          foot: 'cached 2 min ago',
        },
        ship: 'absent',
        shipNote: 'The hook tracks `isConnected` for the account, not for the sync. `last_synced_at` is fetched and never shown.',
      },
      {
        id: 'nosource',
        trigger: 'No mailbox connected.',
        preview: {
          blocks: [{ kind: 'empty', title: 'No mailbox connected', body: 'Open to connect Gmail — Atlas scans read-only and alerts you to bills and deadlines.' }],
        },
        ship: 'built',
        shipNote: 'The one card that already does this properly, with the exact copy shown here. It is the model for the other five.',
      },
    ],
  },

  /* ------------------------------------------------------------- briefing */
  {
    id: 'briefing',
    name: 'Briefing',
    icon: 'Newspaper',
    category: 'Knowledge',
    answers: 'What happened that I should know about?',
    purpose: 'Three headlines as stacked editorial blocks — kicker, headline, source and age.',
    shippedSize: 'l',
    order: 6,
    opens: 'The focused news view.',
    source: {
      kind: 'external',
      hook: 'useNews(category)',
      transport: "localClient.functions.invoke('get-news') → Tauri `fetch_news`",
      provider: 'NewsAPI top-headlines (country=us, pageSize=5)',
      statusKey: 'news',
      keychainAccount: 'atlas-core / news_api_key',
      refresh: 'Every 15 minutes',
      notes: [
        '`fetch_news` falls back to `mock_news()` twice: once when the key is absent and again when the HTTP call fails. Neither path tells the caller which happened.',
        'The category is fixed to "general" unless a caller passes one; the dashboard passes none.',
        '"Followed topics" from the design have no store — there is no topic list anywhere in the app.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Click or Enter/Space.' },
      { label: 'Row cap', value: 'Three headlines.' },
      { label: 'Link out', value: 'The card does not open the article. `url` is on the row and unused.' },
      { label: 'Attention rule', value: 'Breaking story on a followed topic. Requires a topic store that does not exist.' },
    ],
    states: [
      {
        id: 'loading',
        trigger: 'The first fetch is in flight.',
        preview: skel([{ w: '64px' }, { w: '40%', h: 8, top: 12 }, { w: '94%' }, { w: '52%', h: 8, top: 14 }, { w: '88%' }]),
        ship: 'absent',
        shipNote: 'FALLBACK_NEWS is the initial value, so three plausible headlines are on screen before any request completes.',
      },
      {
        id: 'default',
        trigger: 'Headlines resolved.',
        preview: {
          label: 'Briefing',
          blocks: [{ kind: 'stack', items: [
            { kicker: 'Technology', headline: 'New language models show human-level reasoning', source: 'TechCrunch · 2h' },
            { kicker: 'Finance', headline: 'Global markets rally on economic data', source: 'Bloomberg · 4h' },
          ] }],
        },
        ship: 'built',
        shipNote: 'Matches.',
      },
      {
        id: 'attention',
        trigger: 'A breaking story on a topic you follow.',
        preview: {
          label: 'Briefing',
          hot: true,
          blocks: [{ kind: 'stack', items: [
            { breaking: true, headline: 'EU AI Act enforcement dates confirmed — affects your compliance task', source: 'Reuters · 6 min · followed topic' },
          ] }],
          foot: 'Atlas linked this to 2 items in your memory',
        },
        ship: 'absent',
        shipNote: 'Requires followed topics and a link from a headline into memory. Neither exists on this path.',
      },
      {
        id: 'empty',
        trigger: 'No topics followed.',
        preview: {
          blocks: [{ kind: 'empty', title: 'No topics followed', body: 'Pick a few topics and Atlas builds a twice-daily brief.', action: 'Choose topics' }],
        },
        ship: 'absent',
        shipNote: 'When `news` is empty the card renders its header over a blank body. There is no empty state and no topic picker to point at.',
      },
      {
        id: 'offline',
        trigger: 'Feeds unreachable.',
        preview: {
          label: 'Briefing',
          alert: { tone: 'error', text: 'Feeds unreachable' },
          dim: true,
          blocks: [{ kind: 'stack', items: [{ kicker: 'Technology', headline: 'New language models show human-level reasoning' }] }],
          foot: 'cached 41 min ago',
        },
        ship: 'absent',
        shipNote: 'Worse than absent: the Rust side swallows the failure and answers with mock headlines, so the UI is never told the feed went down.',
      },
      {
        id: 'nosource',
        trigger: 'No NewsAPI key in the Keychain.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Briefing needs a key', body: 'Add a NewsAPI key in Settings and Atlas will brief you from real headlines.', action: 'Open Settings' }],
        },
        ship: 'absent',
        shipNote: 'Three fixed headlines from `mock_news()` — including one dated "2h ago" that never changes — are presented as today’s brief.',
      },
    ],
  },

  /* ---------------------------------------------------------- air quality */
  {
    id: 'air',
    name: 'Air quality',
    icon: 'Leaf',
    category: 'Weather',
    answers: 'Is the air outside worth avoiding?',
    purpose: 'A single AQI number on a banded scale, derived from OpenWeather’s PM2.5 reading.',
    shippedSize: 'm',
    order: 7,
    opens: null,
    source: {
      kind: 'external',
      hook: 'useWeather().weather.air',
      transport: "Same call as Weather — 'get-weather' → `fetch_weather`, air-pollution block",
      provider: 'OpenWeather air pollution',
      statusKey: 'openweather',
      keychainAccount: 'atlas-core / openweather_api_key',
      refresh: 'Every 30 minutes, with Weather',
      notes: [
        '`air` is explicitly `null` in the mock payload, so with no key this card genuinely has nothing — it is the only external widget whose keyless path is honest by accident.',
        'It shares a fetch with Weather; it can never be stale independently of it.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Not openable — no `onOpen`, so the card is `.cardStatic` and not focusable.' },
      { label: 'Scale', value: 'Real: PM2.5 mapped to US-style AQI bands.' },
      { label: 'Attention rule', value: 'Unhealthy band. Not implemented.' },
    ],
    states: [
      {
        id: 'loading',
        trigger: 'The shared weather call is in flight.',
        preview: skel([{ w: '84px' }, { w: '46%', h: 24, top: 14 }, { w: '70%' }]),
        ship: 'absent',
        shipNote: 'Shares the weather fallback, so it is never visibly loading.',
      },
      {
        id: 'default',
        trigger: 'An air reading came back.',
        preview: {
          label: 'Air quality',
          blocks: [{ kind: 'metric', value: '32', caption: 'Good · PM2.5 7.4 µg/m³' }],
        },
        ship: 'built',
        shipNote: 'Matches, with the banded scale bar the design sheet does not show.',
      },
      {
        id: 'attention',
        trigger: 'The reading enters an unhealthy band.',
        preview: {
          label: 'Air quality',
          hot: true,
          alert: { tone: 'info', text: 'Unhealthy for sensitive groups — keep the windows shut' },
          blocks: [{ kind: 'metric', value: '128', caption: 'PM2.5 46 µg/m³' }],
        },
        ship: 'absent',
        shipNote: 'The band is computed and coloured; no advice line is raised from it.',
      },
      {
        id: 'empty',
        trigger: 'The location has no air-pollution coverage.',
        preview: {
          blocks: [{ kind: 'empty', title: 'No air reading here', body: 'OpenWeather has no pollution coverage for this location.' }],
        },
        ship: 'partial',
        shipNote: 'The card handles `air == null`, but with the same message it uses for a missing key — it cannot distinguish "no coverage" from "no key".',
      },
      {
        id: 'offline',
        trigger: 'The shared weather call failed.',
        preview: {
          label: 'Air quality',
          alert: { tone: 'error', text: 'Station unreachable' },
          dim: true,
          blocks: [{ kind: 'metric', value: '32', caption: 'cached with the last weather reading' }],
        },
        ship: 'absent',
        shipNote: 'Inherits Weather’s dropped `error`.',
      },
      {
        id: 'nosource',
        trigger: 'No OpenWeather key.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Air quality needs a key', body: 'Add an OpenWeather API key in Settings — the same key the Weather card uses.', action: 'Open Settings' }],
        },
        ship: 'partial',
        shipNote: 'The card correctly shows nothing, because the mock sets `air: null`. It just does not say why, so "no key" looks like "no coverage".',
      },
    ],
  },

  /* ---------------------------------------------------------- now playing */
  {
    id: 'music',
    name: 'Now playing',
    icon: 'Disc',
    category: 'Media',
    answers: 'What is playing, and can I steer it from here?',
    purpose:
      'The transport, the track, and the particle field reacting to the audio Atlas is playing in-process.',
    shippedSize: 'm',
    order: 8,
    opens: 'The full-screen player.',
    source: {
      kind: 'device',
      hook: 'useMusicPlayer() + useAudioReactivity(levelRef)',
      transport: 'Tauri `music_*` commands (librespot in-process) + a `music:level` event stream',
      provider: 'Spotify, via librespot — Premium account required',
      refresh: 'Live; levels arrive as native events',
      notes: [
        'Desktop-only by construction: `useMusicPlayer` sets `available` from an `__TAURI_INTERNALS__` probe, so in a browser the card knows it cannot work and says so.',
        'Reactivity comes from the native `music:level` event, not from Web Audio — there is no analyser node in the webview to fail.',
        'The Spotify credentials are not part of `brain_ai_status`, so this sheet cannot report whether they are configured. It says "unknown" rather than guessing.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Click or Enter/Space — opens the full-screen player.' },
      { label: 'Transport', value: 'Real: play/pause/skip go straight to the Tauri commands.' },
      { label: 'Formation', value: 'Playing → field, paused → sphere, tweened over ~1.5s.' },
      { label: 'Attention rule', value: 'None. Music never demands attention — it is the one widget that must not interrupt.' },
    ],
    states: [
      {
        id: 'loading',
        trigger: 'Connecting to the audio session.',
        preview: skel([{ w: '70px' }, { w: '58%', h: 18, top: 14 }, { w: '40%' }]),
        ship: 'partial',
        shipNote: 'There is a connecting state, but it is not the shimmer the design specifies.',
      },
      {
        id: 'default',
        trigger: 'A track is playing or paused.',
        preview: {
          label: 'Now playing',
          blocks: [
            { kind: 'metric', value: 'Tidligt Op', caption: 'Gilli · 2016' },
            { kind: 'progress', pct: 42, label: '1:48 / 4:12' },
          ],
        },
        ship: 'built',
        shipNote: 'Matches.',
      },
      {
        id: 'attention',
        trigger: '—',
        preview: null,
        why: 'Deliberately undefined. A media widget that raises an alert competes with the thing it is playing.',
        ship: 'n/a',
        shipNote: 'Correctly absent.',
      },
      {
        id: 'empty',
        trigger: 'Connected, nothing queued.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Nothing playing', body: 'Ask Atlas for something, or pick up where you left off.', action: 'Resume' }],
        },
        ship: 'partial',
        shipNote: 'The card goes quiet and shows the sphere at rest, without the designed copy or action.',
      },
      {
        id: 'offline',
        trigger: 'The audio session dropped.',
        preview: {
          label: 'Now playing',
          alert: { tone: 'error', text: 'Playback session lost — reconnecting' },
          dim: true,
          blocks: [{ kind: 'metric', value: 'Tidligt Op', caption: 'Gilli · 2016' }],
        },
        ship: 'absent',
        shipNote: 'A dropped session leaves the last track on screen with the transport still drawn as if it worked.',
      },
      {
        id: 'nosource',
        trigger: 'Running in a browser, or no Spotify account linked.',
        preview: {
          blocks: [{ kind: 'empty', title: 'Music lives in the desktop app', body: 'Atlas plays audio in-process on your Mac. Link a Spotify Premium account there.' }],
        },
        ship: 'built',
        shipNote: 'The `available` probe makes the browser case explicit — the second of the two cards that gets this right.',
      },
    ],
  },

  /* ------------------------------------------------------------- activity */
  {
    id: 'activity',
    name: 'Activity',
    icon: 'Flame',
    category: 'Health',
    answers: 'Nothing, today.',
    purpose:
      'Three concentric rings — move, exercise, stand. Designed against a health source that this app does not have.',
    shippedSize: 'm',
    order: 9,
    opens: null,
    source: {
      kind: 'none',
      hook: '— none —',
      transport: '— none —',
      refresh: 'Never',
      notes: [
        'Every number on this card is a literal in `AtlasExtraCards.tsx`: 520/650 cal, 38/60 min, 9/12 hr, and the ring dash offsets that draw them. They do not move and they are not about the person looking at them.',
        'There is no HealthKit bridge, no health table in the SQLite core and no import path. The card cannot be made real by setting a key.',
        'It is on this sheet because it is on the dashboard. Documenting it as "no source" is the point — this is the widget the sheet exists to catch.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Not openable — `.cardStatic`, no focus, no action.' },
      { label: 'Update', value: 'Never. Nothing re-renders it.' },
      { label: 'Recommended', value: 'Either bind it to a real source or take it off the grid. A card that cannot change is decoration wearing a widget’s clothes.' },
    ],
    states: [
      { id: 'loading', trigger: '—', preview: null, why: 'Nothing loads.', ship: 'n/a', shipNote: 'No fetch exists.' },
      {
        id: 'default',
        trigger: 'Always — this is the only state the card can be in.',
        preview: {
          label: 'Activity',
          blocks: [
            { kind: 'rows', rows: [
              { title: 'Move', trail: '520 / 650 cal', trailTone: 'muted' },
              { title: 'Exercise', trail: '38 / 60 min', trailTone: 'muted' },
              { title: 'Stand', trail: '9 / 12 hr', trailTone: 'muted' },
            ] },
            { kind: 'note', text: 'Fixed literals. Identical on every machine, every day.' },
          ],
        },
        ship: 'built',
        shipNote: 'Built, and built on nothing.',
      },
      { id: 'attention', trigger: '—', preview: null, why: 'No source, so nothing can raise an alert.', ship: 'n/a', shipNote: '—' },
      { id: 'empty', trigger: '—', preview: null, why: 'The card cannot empty: its content is not data.', ship: 'n/a', shipNote: '—' },
      { id: 'offline', trigger: '—', preview: null, why: 'Nothing to disconnect from.', ship: 'n/a', shipNote: '—' },
      {
        id: 'nosource',
        trigger: 'Always — today, permanently.',
        preview: {
          blocks: [{ kind: 'empty', title: 'No health source', body: 'Atlas has no access to activity data on this Mac. Nothing is being measured.' }],
        },
        ship: 'absent',
        shipNote: 'This is the state the card is actually in, and the one it does not draw. It shows filled rings instead.',
      },
    ],
  },

  /* ---------------------------------------------------------- world clock */
  {
    id: 'clock',
    name: 'World clock',
    icon: 'Globe',
    category: 'Time',
    answers: 'What time is it for the people I work with?',
    purpose: 'Three cities with their local time and whether they are on today’s date.',
    shippedSize: 'm',
    order: 10,
    opens: null,
    source: {
      kind: 'device',
      hook: '— local state, 30s interval —',
      transport: 'Intl.DateTimeFormat against the machine clock',
      refresh: 'Every 30 seconds',
      notes: [
        'Entirely real and entirely local. No key, no network, no failure mode beyond the machine’s own clock.',
        'The three cities are a constant in `AtlasExtraCards.tsx`. There is no way to change them, which is the only thing about this card that is not honest.',
      ],
    },
    behaviour: [
      { label: 'Open', value: 'Not openable.' },
      { label: 'Tick', value: 'Real: `setInterval` at 30s, recomputed from `Date.now()`.' },
      { label: 'Day marker', value: 'Real: compares each zone’s date to the local date — Today / Tomorrow / Yesterday.' },
      { label: 'Attention rule', value: 'None, and none wanted.' },
    ],
    states: [
      { id: 'loading', trigger: '—', preview: null, why: 'The first render already has the time.', ship: 'n/a', shipNote: 'Correctly absent.' },
      {
        id: 'default',
        trigger: 'Always.',
        preview: {
          label: 'World clock',
          blocks: [{ kind: 'rows', rows: [
            { lead: '05:32', leadKind: 'text', title: 'San Francisco', trail: 'Today', trailTone: 'muted' },
            { lead: '13:32', leadKind: 'text', title: 'London', trail: 'Today', trailTone: 'muted' },
            { lead: '21:32', leadKind: 'text', title: 'Tokyo', trail: 'Today', trailTone: 'muted' },
          ] }],
        },
        ship: 'built',
        shipNote: 'Matches exactly.',
      },
      { id: 'attention', trigger: '—', preview: null, why: 'A clock has nothing urgent to say.', ship: 'n/a', shipNote: '—' },
      {
        id: 'empty',
        trigger: 'No cities configured.',
        preview: {
          blocks: [{ kind: 'empty', title: 'No cities yet', body: 'Tell Atlas where your people are and it will keep their hours in view.', action: 'Add a city' }],
        },
        ship: 'absent',
        shipNote: 'Unreachable while the city list is a constant. It becomes real the moment the list is editable.',
      },
      { id: 'offline', trigger: '—', preview: null, why: 'No network is involved.', ship: 'n/a', shipNote: 'Correctly absent.' },
      { id: 'nosource', trigger: '—', preview: null, why: 'The machine clock is always present.', ship: 'n/a', shipNote: 'Correctly absent.' },
    ],
  },
];

/* ----------------------------------------------------------------- lookups */

export const widgetById = (id: string): WidgetSpec | undefined =>
  WIDGETS.find((w) => w.id === id);

/** How many of the six states this widget actually defines. */
export const definedStateCount = (w: WidgetSpec): number =>
  w.states.filter((s) => s.preview !== null).length;

/** How many of the states it defines are built in the app today. */
export const builtStateCount = (w: WidgetSpec): number =>
  w.states.filter((s) => s.preview !== null && s.ship === 'built').length;
