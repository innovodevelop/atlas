import type { CardSize, CardSkin } from '@/components/atlas-ui/primitives';

/**
 * The widget registry — the catalog's subject matter.
 *
 * `Card.tsx` says it plainly: "there is no registry — the ten cards are a
 * hardcoded list". This is that list, described rather than duplicated. Every
 * entry below names a widget that EXISTS today in `AtlasCards.tsx` or
 * `AtlasExtraCards.tsx`; nothing here is invented. The design reference
 * (`Atlas Widget Catalog.dc.html`) ships fifty widgets across ten categories —
 * flights, invoices, packing lists, sleep, security, podcasts. Forty of them
 * have no component, no hook and no data source in this app, so they are not
 * in this file. A catalog of widgets that do not exist is a brochure.
 *
 * This registry is DESCRIPTIVE, not authoritative: the dashboard still renders
 * its hardcoded list, and nothing reads this module except the catalog. Making
 * the dashboard render FROM a registry is the architecture change `Card.tsx`
 * flags, and it is not this surface's job.
 */

export type CatalogCategory =
  | 'weather' | 'time' | 'work' | 'money' | 'comms' | 'media' | 'health' | 'know';

export const CATEGORY_LABEL: Record<CatalogCategory, string> = {
  weather: 'Weather',
  time: 'Time',
  work: 'Work',
  money: 'Money',
  comms: 'Comms',
  media: 'Media',
  health: 'Health',
  know: 'Knowledge',
};

/**
 * The three faces the shipped widgets actually draw.
 *
 * The design names seven (big / rows / bars / progress / split / people /
 * text). Four of them have no widget behind them here, so they are not
 * implemented — building a `people` renderer with nothing to put in it is the
 * same fabrication in a different costume.
 */
export type CatalogShape = 'big' | 'rows' | 'progress';

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

export interface WidgetSpec {
  id: string;
  name: string;
  category: CatalogCategory;
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
}

export const WIDGETS: WidgetSpec[] = [
  {
    id: 'weather',
    name: 'Weather',
    category: 'weather',
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
    category: 'time',
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
    category: 'comms',
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
    shape: 'progress',
    ships: 's',
    shipsSkin: 'accent',
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
    category: 'health',
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
    category: 'time',
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
 */
export type CatalogState = 'live' | 'empty' | 'nosource';

export const STATES: Array<{ id: CatalogState; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'empty', label: 'Empty' },
  { id: 'nosource', label: 'No source' },
];
