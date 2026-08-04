import type { CardSize, CardSkin } from '@/components/atlas-ui/primitives';

/**
 * The widget registry — the OFFICIAL widget system.
 *
 * `Atlas Widget Catalog.dc.html` is the authoritative definition of Atlas's
 * widget set: 51 widgets across ten categories. This file is that list. Ten of
 * them are built and read live data; the other 41 are designed and not built,
 * and say so on the card.
 *
 * THIS REVERSES AN EARLIER DECISION, deliberately (user, 2026-08-04). The first
 * cut listed only the ten shipped widgets, on the reasoning that "a catalog of
 * widgets that do not exist is a brochure". That protects against one failure
 * (fabrication) by causing another: a catalog that silently omits 80% of the
 * system it claims to catalogue, so nothing in the app records what Atlas's
 * widget set actually is. The official set belongs here.
 *
 * The fabrication risk is handled by the type, not by omission. `WidgetSpec` is
 * a discriminated union: a `built: false` entry has NO value fields at all — no
 * preview numbers, no sample rows, nothing to render as if it were data. It
 * carries a name, a category, the shape the design draws it as, and `needs` —
 * what is actually missing. The compiler makes it impossible to render a
 * designed widget through the live path. The design file's hand-written preview
 * values (`'24 min'`, `'TP1338'`, `'8/14'`) are deliberately NOT copied in.
 *
 * NAMES DO NOT ALL LINE UP. Four shipped cards correspond to a catalog entry
 * under a different name, and one has no catalog entry at all. Rather than
 * quietly renaming shipped cards or pretending the mismatch does not exist,
 * each carries `designName` (what the catalog calls it) or `appOnly` (it is not
 * in the catalog). See `Activity`.
 *
 * Still DESCRIPTIVE, not authoritative *at runtime*: the dashboard renders its
 * own hardcoded list and nothing reads this module except the catalog. Making
 * the dashboard render FROM this registry is the architecture change `Card.tsx`
 * flags, and it is still not this surface's job.
 */

export type CatalogCategory =
  | 'time' | 'weather' | 'travel' | 'money' | 'work'
  | 'comms' | 'health' | 'home' | 'media' | 'know';

/** Catalog order, not alphabetical — it is the reading order of the design. */
export const CATEGORY_LABEL: Record<CatalogCategory, string> = {
  time: 'Time',
  weather: 'Weather',
  travel: 'Travel',
  money: 'Money',
  work: 'Work',
  comms: 'Comms',
  health: 'Health',
  home: 'Home',
  media: 'Media',
  know: 'Knowledge',
};

/**
 * The seven faces the design draws.
 *
 * Only three of them (`big`, `rows`, `progress`) have a renderer here, because
 * only those three have a shipped widget behind them. The other four are
 * recorded so the catalog can state what a designed widget would look like
 * without building a renderer that has nothing to put in it.
 */
export type DesignShape = 'big' | 'rows' | 'bars' | 'progress' | 'split' | 'people' | 'text';

/** The subset `WidgetPreview` can actually draw with live data. */
export type CatalogShape = 'big' | 'rows' | 'progress';

export const SHAPE_LABEL: Record<DesignShape, string> = {
  big: 'Big figure',
  rows: 'Row list',
  bars: 'Bar series',
  progress: 'Progress',
  split: 'Split pair',
  people: 'People',
  text: 'Text',
};

/** Where a widget's numbers come from, which is what decides how it can fail. */
export type SourceKind =
  /** An edge/Tauri call that can time out — and, for three of them, silently fall back. */
  | 'remote'
  /** The local SQLite database, behind sign-in. */
  | 'local'
  /** The machine itself. Cannot go missing. */
  | 'system'
  /** No source at all. The dashboard card is drawn from demo values. */
  | 'none';

export interface CatalogCopy { title: string; body: string }

interface SpecBase {
  id: string;
  /** The name as it appears wherever this widget lives today. */
  name: string;
  category: CatalogCategory;
  /** How the official catalog draws it. */
  designShape: DesignShape;
}

/** A widget that exists in the app and reads a real source. */
export interface BuiltWidget extends SpecBase {
  built: true;
  /** The face `WidgetPreview` draws. May differ from `designShape` — Now playing does. */
  shape: CatalogShape;
  /** The size this widget is rendered at on the dashboard today. */
  ships: CardSize;
  /** The skin it ships with. Only Now playing is not glass. */
  shipsSkin: CardSkin;
  /** The hook (and the call behind it) the dashboard card reads. */
  binding: string;
  sourceKind: SourceKind;
  /** Copy for the designed empty state — source present, nothing in it. */
  empty: CatalogCopy;
  /** Copy for an absent source. `null` = this widget has no source to lose. */
  noSource: CatalogCopy | null;
  /** Set when the official catalog calls this widget something else. */
  designName?: string;
  /** Set when this widget is NOT in the official catalog at all. */
  appOnly?: boolean;
}

/**
 * A widget the official catalog defines and the app does not implement.
 *
 * Note what is absent: every value field. There is nowhere to put a number, so
 * no designed widget can render as though it had one.
 */
export interface DesignedWidget extends SpecBase {
  built: false;
  /** What is actually missing. Concrete — not "coming soon". */
  needs: string;
}

export type WidgetSpec = BuiltWidget | DesignedWidget;

/* ------------------------------------------------------------------ built */

const BUILT: BuiltWidget[] = [
  {
    id: 'weather',
    name: 'Weather',
    category: 'weather',
    designShape: 'big',
    built: true,
    shape: 'big',
    ships: 'l',
    shipsSkin: 'glass',
    binding: 'useWeather · get-weather',
    sourceKind: 'remote',
    empty: {
      title: 'No reading yet.',
      body: 'The forecast fills in the moment the call returns.',
    },
    noSource: {
      title: 'No location.',
      body: 'Weather needs a city to ask about, and Atlas has none.',
    },
  },
  {
    id: 'calendar',
    name: 'Today',
    designName: 'Agenda',
    category: 'time',
    designShape: 'rows',
    built: true,
    shape: 'rows',
    ships: 'l',
    shipsSkin: 'glass',
    binding: 'useCalendarEvents · user_events',
    sourceKind: 'local',
    empty: {
      title: 'Nothing today.',
      body: 'The calendar is readable and simply has no events on it.',
    },
    noSource: {
      title: 'Not signed in.',
      body: 'Events live in your local database, behind sign-in.',
    },
  },
  {
    id: 'tasks',
    name: 'Tasks',
    category: 'work',
    designShape: 'progress',
    built: true,
    shape: 'progress',
    ships: 'l',
    shipsSkin: 'glass',
    binding: 'useTasks · user_tasks',
    sourceKind: 'local',
    empty: {
      title: 'No tasks.',
      body: 'Add one and the bar starts counting.',
    },
    noSource: {
      title: 'Not signed in.',
      body: 'Tasks live in your local database, behind sign-in.',
    },
  },
  {
    id: 'stocks',
    name: 'Watchlist',
    category: 'money',
    designShape: 'rows',
    built: true,
    shape: 'rows',
    ships: 'xl',
    shipsSkin: 'glass',
    binding: 'useStocks + usePortfolio · get-stocks',
    sourceKind: 'remote',
    empty: {
      title: 'Nothing watched.',
      body: 'No tickers came back, so there is nothing to price.',
    },
    noSource: {
      title: 'Market data unavailable.',
      body: 'get-stocks did not answer and no portfolio is linked.',
    },
  },
  {
    id: 'mail',
    name: 'Mail',
    designName: 'Inbox',
    category: 'comms',
    designShape: 'rows',
    built: true,
    shape: 'rows',
    ships: 'l',
    shipsSkin: 'glass',
    binding: 'useMailIntelligence · mail_accounts',
    sourceKind: 'remote',
    empty: {
      title: 'Inbox clear.',
      body: 'Connected, scanned, and nothing needs you.',
    },
    noSource: {
      title: 'No mailbox connected.',
      body: 'Connect Gmail in Settings — Atlas scans read-only.',
    },
  },
  {
    id: 'briefing',
    name: 'Briefing',
    category: 'know',
    designShape: 'rows',
    built: true,
    shape: 'rows',
    ships: 'l',
    shipsSkin: 'glass',
    binding: 'useNews · get-news',
    sourceKind: 'remote',
    empty: {
      title: 'No stories.',
      body: 'Nothing has come in on the topics you follow.',
    },
    noSource: {
      title: 'No feed.',
      body: 'get-news did not answer, so there is no briefing to give.',
    },
  },
  {
    id: 'air',
    name: 'Air quality',
    category: 'weather',
    designShape: 'progress',
    built: true,
    shape: 'progress',
    ships: 's',
    shipsSkin: 'glass',
    binding: 'useWeather · get-weather (air)',
    sourceKind: 'remote',
    empty: {
      title: 'No air reading.',
      body: 'OpenWeather returned no pollution data for this city.',
    },
    noSource: {
      title: 'No air reading.',
      body: 'Air quality rides along with the weather call, and that call has not answered.',
    },
  },
  {
    id: 'music',
    name: 'Now playing',
    category: 'media',
    // The catalog draws this as a big figure; the app ships it as a progress
    // card. Recorded rather than smoothed over — the difference is real.
    designShape: 'big',
    built: true,
    shape: 'progress',
    ships: 's',
    // `ink`, not `accent`. Music v2 (33ca831) rebuilt this card as
    // `MusicPlayerCompact`, which sets `skin="ink"`; this registry predates that
    // and still claimed `accent`. Nothing rendered the field, so the catalog
    // carried a false fact about a shipped widget for as long as nobody looked.
    // The footer prints it now — see WidgetPreview — so the next drift is
    // visible instead of silent. `accent` is consequently used by nothing.
    shipsSkin: 'ink',
    binding: 'useMusicPlayer · music_status',
    sourceKind: 'remote',
    empty: {
      title: 'Nothing playing.',
      body: 'Spotify is connected and the player is idle.',
    },
    noSource: {
      title: 'Spotify not connected.',
      body: 'Playback runs in the desktop app; connect it in Settings.',
    },
  },
  {
    id: 'activity',
    name: 'Activity',
    // NOT in the official catalog. The catalog's health set is Steps, Sleep,
    // Heart, Workout and Nutrition; Activity is none of them. It ships anyway,
    // on no data source, so it is listed as an app-only widget rather than
    // mapped onto a catalog entry it does not correspond to.
    appOnly: true,
    category: 'health',
    designShape: 'rows',
    built: true,
    shape: 'rows',
    ships: 'm',
    shipsSkin: 'glass',
    binding: '— none —',
    sourceKind: 'none',
    empty: {
      title: 'No activity.',
      body: 'Nothing has been recorded for today.',
    },
    noSource: {
      title: 'No health source.',
      body: 'Atlas reads no fitness data at all. The rings on the dashboard are demo values.',
    },
  },
  {
    id: 'worldclock',
    name: 'World clock',
    designName: 'Time zones',
    category: 'time',
    designShape: 'rows',
    built: true,
    shape: 'rows',
    ships: 's',
    shipsSkin: 'glass',
    binding: 'Intl.DateTimeFormat · system clock',
    sourceKind: 'system',
    empty: {
      title: 'No cities.',
      body: 'Pick the places you want to keep an eye on.',
    },
    // Deliberately null: there is nothing to disconnect. The catalog says so
    // rather than inventing a failure this widget cannot have.
    noSource: null,
  },
];

/* --------------------------------------------------------------- designed */

/**
 * The 41 catalog widgets with no implementation.
 *
 * `needs` names the concrete blocker. Several repeat because several widgets
 * are blocked by the same absent integration — that repetition is the point:
 * it shows one connector would unlock a cluster.
 */
const DESIGNED: DesignedWidget[] = [
  // --- time
  { id: 'clock', name: 'Clock', category: 'time', designShape: 'big', built: false, needs: 'Nothing external — the system clock is already available. Not built simply because World clock covers the need.' },
  { id: 'upnext', name: 'Up next', category: 'time', designShape: 'big', built: false, needs: 'Reads the same local calendar as Today; needs only a single-event view of it.' },
  { id: 'countdown', name: 'Countdown', category: 'time', designShape: 'big', built: false, needs: 'A user-set target date. Nothing stores one.' },

  // --- weather
  // The data is ALREADY THERE. `datafetch.rs:127` groups the OpenWeather
  // response into a real 7-day series and returns it as `daily` (:153), and
  // `useWeather.ts:18` types it. An earlier draft of this file claimed
  // get-weather returns current conditions only — checked, and it was wrong.
  // What is missing is the `bars` renderer and a card, nothing upstream.
  { id: 'forecast', name: 'Forecast', category: 'weather', designShape: 'bars', built: false, needs: 'Nothing upstream — get-weather already returns a 7-day `daily` series and useWeather types it. Needs the bars renderer and a card.' },
  { id: 'precipitation', name: 'Precipitation', category: 'weather', designShape: 'big', built: false, needs: 'Minute-level radar. OpenWeather’s current plan does not include it.' },
  { id: 'daylight', name: 'Daylight', category: 'weather', designShape: 'split', built: false, needs: 'Sunrise/sunset. Present in the get-weather payload but not surfaced.' },

  // --- travel
  { id: 'flight', name: 'Flight', category: 'travel', designShape: 'big', built: false, needs: 'A flight-status source. Atlas has no airline or booking integration.' },
  { id: 'trip', name: 'Trip', category: 'travel', designShape: 'rows', built: false, needs: 'An itinerary source. No travel integration exists.' },
  { id: 'commute', name: 'Commute', category: 'travel', designShape: 'big', built: false, needs: 'Routing and live traffic, plus a home/work pair. None exist.' },
  { id: 'transit', name: 'Transit', category: 'travel', designShape: 'rows', built: false, needs: 'A departures feed and a location. No transit integration exists.' },
  { id: 'packing', name: 'Packing', category: 'travel', designShape: 'progress', built: false, needs: 'A packing list. Could ride on the local task store; nothing does.' },

  // --- money
  { id: 'currency', name: 'Currency', category: 'money', designShape: 'split', built: false, needs: 'FX rates. get-stocks covers equities only.' },
  { id: 'spend', name: 'Spend', category: 'money', designShape: 'bars', built: false, needs: 'Transaction data — blocked on Mastercard Open Finance production access.' },
  { id: 'budget', name: 'Budget', category: 'money', designShape: 'progress', built: false, needs: 'Transaction data plus a user-set budget. Same blocker as Spend.' },
  { id: 'portfolio', name: 'Portfolio', category: 'money', designShape: 'big', built: false, needs: 'Holdings. usePortfolio exists but no account is connected.' },
  { id: 'invoices', name: 'Invoices', category: 'money', designShape: 'rows', built: false, needs: 'An accounting or invoicing integration. None exists.' },
  { id: 'subscriptions', name: 'Subscriptions', category: 'money', designShape: 'big', built: false, needs: 'Recurring-charge detection over transactions. Same blocker as Spend.' },

  // --- work
  { id: 'focus', name: 'Focus', category: 'work', designShape: 'big', built: false, needs: 'Focus-time measurement. Atlas tracks no app or session usage.' },
  { id: 'meetingnotes', name: 'Meeting notes', category: 'work', designShape: 'rows', built: false, needs: 'Meeting capture. The voice gateway transcribes, but nothing records meetings.' },
  { id: 'documents', name: 'Documents', category: 'work', designShape: 'rows', built: false, needs: 'A file or drive integration. None exists.' },
  { id: 'pullrequests', name: 'Pull requests', category: 'work', designShape: 'rows', built: false, needs: 'A GitHub integration. None exists.' },
  { id: 'deploys', name: 'Deploys', category: 'work', designShape: 'big', built: false, needs: 'A CI/CD integration. None exists.' },
  { id: 'incidents', name: 'Incidents', category: 'work', designShape: 'big', built: false, needs: 'An incident or status-page integration. None exists.' },
  { id: 'supportqueue', name: 'Support queue', category: 'work', designShape: 'big', built: false, needs: 'A helpdesk integration. None exists.' },

  // --- comms
  { id: 'messages', name: 'Messages', category: 'comms', designShape: 'people', built: false, needs: 'A chat integration. Atlas reads mail only.' },
  // Not mail_alerts — that is 'bill' | 'deadline' | 'important' | 'document',
  // with no draft type (useMailIntelligence.ts:34). A draft is a THREAD STATE
  // ('drafting', mail.rs:502), not a counted collection, so there is no number
  // to put on a progress card without first defining one.
  { id: 'drafts', name: 'Atlas drafts', category: 'comms', designShape: 'progress', built: false, needs: 'A draft is a thread state (“drafting”), not a counted set — awaiting-approval has no count to show yet.' },
  { id: 'call', name: 'Call', category: 'comms', designShape: 'big', built: false, needs: 'Conferencing details on calendar events. The local calendar stores none.' },

  // --- health
  { id: 'steps', name: 'Steps', category: 'health', designShape: 'bars', built: false, needs: 'A health source. Atlas has no HealthKit bridge.' },
  { id: 'sleep', name: 'Sleep', category: 'health', designShape: 'big', built: false, needs: 'A health source. Atlas has no HealthKit bridge.' },
  { id: 'heart', name: 'Heart', category: 'health', designShape: 'big', built: false, needs: 'A health source. Atlas has no HealthKit bridge.' },
  { id: 'workout', name: 'Workout', category: 'health', designShape: 'progress', built: false, needs: 'A health source. Atlas has no HealthKit bridge.' },
  { id: 'nutrition', name: 'Nutrition', category: 'health', designShape: 'split', built: false, needs: 'A health source. Atlas has no HealthKit bridge.' },

  // --- home
  { id: 'climate', name: 'Climate', category: 'home', designShape: 'big', built: false, needs: 'A smart-home bridge. No Apple Home, no Matter fabric, no hub.' },
  { id: 'energy', name: 'Energy', category: 'home', designShape: 'bars', built: false, needs: 'A smart-home bridge or utility integration. Neither exists.' },
  { id: 'security', name: 'Security', category: 'home', designShape: 'big', built: false, needs: 'A smart-home bridge. No Apple Home, no Matter fabric, no hub.' },
  { id: 'groceries', name: 'Groceries', category: 'home', designShape: 'rows', built: false, needs: 'A shopping list. Could ride on the local task store; nothing does.' },
  { id: 'lights', name: 'Lights', category: 'home', designShape: 'progress', built: false, needs: 'A smart-home bridge. No Apple Home, no Matter fabric, no hub.' },

  // --- media
  { id: 'podcast', name: 'Podcast', category: 'media', designShape: 'progress', built: false, needs: 'A podcast source. The Spotify scope Atlas requests does not cover shows.' },
  { id: 'reading', name: 'Reading', category: 'media', designShape: 'rows', built: false, needs: 'A read-later store. None exists.' },

  // --- know
  { id: 'answer', name: 'Answer', category: 'know', designShape: 'text', built: false, needs: 'Chat answers exist; no dashboard card surfaces the latest one.' },
  { id: 'sources', name: 'Sources', category: 'know', designShape: 'rows', built: false, needs: 'Citations exist on chat answers; no dashboard card surfaces them.' },
  { id: 'atlassaid', name: 'Atlas said', category: 'know', designShape: 'text', built: false, needs: 'The spoken digest exists; no dashboard card surfaces it.' },
];

/** Catalog order: every widget, built and designed, grouped by category. */
export const WIDGETS: WidgetSpec[] = (() => {
  const order: CatalogCategory[] = ['time', 'weather', 'travel', 'money', 'work', 'comms', 'health', 'home', 'media', 'know'];
  const all = [...BUILT, ...DESIGNED];
  return order.flatMap((c) => [
    ...all.filter((w) => w.category === c && w.built),
    ...all.filter((w) => w.category === c && !w.built),
  ]);
})();

export const BUILT_COUNT = BUILT.length;
export const DESIGNED_COUNT = DESIGNED.length;

/**
 * Counted separately on purpose, because "how many widgets are there" has two
 * different right answers and conflating them is how a number becomes a lie.
 *
 * `OFFICIAL_COUNT` is the catalog's own set — what Atlas's widget system IS.
 * `APP_ONLY_COUNT` is widgets that ship here and are not in the catalog
 * (currently just Activity). The grid shows both, so its total is the sum and
 * is NOT the size of the official set.
 */
export const APP_ONLY_COUNT = BUILT.filter((w) => w.appOnly).length;
export const OFFICIAL_COUNT = WIDGETS.length - APP_ONLY_COUNT;

/** Narrowing helper — `spec.built` works, but this reads better at call sites. */
export const isBuilt = (w: WidgetSpec): w is BuiltWidget => w.built;

/**
 * The sizes `<Card>` implements — and only those.
 *
 * The design specifies five (S 2x1 · M 3x1 · L 3x2 · XL 6x2 · Hero 6x3) on a
 * twelve-column grid. The app's grid is `repeat(auto-fill, minmax(340px, 1fr))`
 * with two span modifiers, so four sizes are expressible and Hero is not.
 * `Card.tsx` refused to alias Hero onto XL; this list refuses to list it as if
 * it worked. The note under the controls says so on screen.
 */
export const SIZES: Array<{ id: CardSize; label: string; dim: string }> = [
  { id: 's', label: 'S', dim: '1×1' },
  { id: 'm', label: 'M', dim: '2×1' },
  { id: 'l', label: 'L', dim: '1×2' },
  { id: 'xl', label: 'XL', dim: '2×2' },
];

export const SIZE_LABEL: Record<CardSize, string> = { s: 'S', m: 'M', l: 'L', xl: 'XL' };

/** Two-row sizes have the height for list rows and a footer; one-row sizes do not. */
export const isTall = (size: CardSize): boolean => size === 'l' || size === 'xl';

export type CatalogSkin = 'both' | 'glass' | 'ink';

export const SKINS: Array<{ id: CatalogSkin; label: string }> = [
  { id: 'both', label: 'Both' },
  { id: 'glass', label: 'Glass' },
  { id: 'ink', label: 'Ink' },
];

/**
 * `live` is not a mode, it is the truth: whatever the widget's source is doing
 * right now. `empty` and `nosource` force a state so the drawing can be
 * reviewed without breaking anything to see it.
 *
 * None of them apply to a designed widget — there is no source to be live,
 * empty or absent — so those cards ignore this entirely.
 */
export type CatalogState = 'live' | 'empty' | 'nosource';

export const STATES: Array<{ id: CatalogState; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'empty', label: 'Empty' },
  { id: 'nosource', label: 'No source' },
];

/** Which half of the catalog to show. */
export type CatalogBuild = 'all' | 'built' | 'designed';

export const BUILDS: Array<{ id: CatalogBuild; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'built', label: 'Built' },
  { id: 'designed', label: 'Designed' },
];
