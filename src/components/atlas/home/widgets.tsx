/**
 * The Home widgets — one adapter per widget id in `WIDGETS` (src/lib/betaHome.ts),
 * each reading its real hook and handing the face what it has.
 *
 * Rules from the handoff README: the design's mock numbers never ship; a
 * widget with no source says so on its face and the Edit Home catalogue marks
 * it "Soon"; a widget showing a labelled sample carries the Sample stamp; no
 * control is decorative — the tick, the add line, the music buttons all act.
 *
 * `preview` (the widget catalog and sheet) forces a face state. The six core
 * widgets then read what that state should say from their own live data —
 * the overdue task, the meeting about to start, the last mail sync — and the
 * caller's `previewCopy` fills the rest. With `preview` undefined nothing
 * here runs and Home draws exactly what it drew before.
 *
 * `autoState` (Home only) lets a widget switch faces on its own: each live
 * adapter hands Card a `live` reading — its loading, offline and attention
 * detectors from betaWidgetCatalog.ts, the same ones the sheet previews — and
 * Card draws the face that reading calls for (`liveFaceState`). The catalog,
 * the sheet and Edit Home do not pass it, so they draw what they always drew.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { WidgetFace, type FacePreview, type FacePreviewCopy, type FaceProps, type FaceRow, type FaceTone } from './WidgetFace';
import { AtlasIcon } from '../AtlasIcon';
import { WIDGET_BY_ID, type WidgetSize } from '@/lib/betaHome';
import {
  briefingAttention, inboxAttention, inboxOffline, liveFaceState, mailOffline, networkOffline, tasksAttention, todayAttention,
  watchAttention, weatherAttention,
  type AttentionCopy, type LiveReading,
} from '@/lib/betaWidgetCatalog';
import { seenAt } from '@/lib/dataAge';
import { useWatchlist } from '@/hooks/useWatchlist';
import { feelsLine, upNextEvents, upNextWhen, withLine } from '@/lib/betaViews';
import { shortTitle } from '@/lib/stageFocus';
import { useCurrency } from '@/hooks/useCurrency';
import { currencyName, fmtMoney, monthMove, rateDateLabel } from '@/lib/betaCurrency';
import { startFocus, useFocus } from '@/lib/focusGate';
import { dayStats, fmtClock, fmtFocusMinutes, heldLabel, isRunning, leftMs, progress } from '@/lib/betaFocus';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useTasks } from '@/hooks/useTasks';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { useStocks } from '@/hooks/useStocks';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useNews } from '@/hooks/useNews';
import { engineHoldsUri, useMusicPlayer } from '@/hooks/useMusicPlayer';
import { musicQueue, useMusicQueue } from '@/hooks/useMusicQueue';
import { useRecentEpisodes } from '@/hooks/usePodcasts';
import { MusicLike } from '@/components/atlas/music/MusicLike';
import { THIS_MAC, episodeLeft, nextLine, resumeFrom, roomsFrom } from '@/lib/betaMusic';
import { ROOM_SCOPES, isEpisode, lacks } from '@/lib/musicSpotify';
import { useSmartHome } from '@/hooks/useSmartHome';
import { useHealth } from '@/hooks/useHealth';
import { systemZone } from '@/lib/betaClock';
import { useClockPrefs } from '@/lib/betaClockStore';
// The dial faces' rules live with the Clock's; the ringing dialog that also
// loads this file is lazy, so Home must not count on it having arrived.
import '@/styles/beta/clock.css';
import { citiesMeta, countdownFace, countdownTickMs, dialCount, dials, elsewhere } from '@/lib/betaClockWidgets';
import { fmtPct } from '@/pages/atlas/atlasHelpers';
import { useTransit } from '@/hooks/useTransit';
import { countdown, departureNote, type Departure } from '@/lib/transit';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { eventTime, focusEvent, focusIn, thenEvents, todaysEvents } from '@/lib/stageFocus';
// The Now playing extras and the Podcast face (bw-music-*) live with the widget screens' styles.
import '@/styles/beta/views.css';
import {
  SWATCHES, cameraEventLine, cameraSensors, colourName, lastMotion, lightsSummary, pickDoorCamera, pickLight, powerValue,
  type HistoryEvent, type LightWidget,
} from '@/lib/betaSmartHome';
import '@/styles/beta/smartHome.css';
import { useBank } from '@/hooks/useBank';
import { dayLabel, spendRows, totalSpent } from '@/lib/betaMoney';
import { paceSentence } from '@/lib/bankLedger';

export interface WidgetProps {
  size: WidgetSize;
  delay: number;
  /** Open the widget's full view or screen; absent when it has none. */
  open?: () => void;
  /** Home setting "Surface": Paper and Ink override each widget's own tone. */
  forceTone?: FaceTone;
  /** Force a face state; the catalog and sheet only. */
  preview?: FacePreview;
  /** The copy for that state the widget cannot read for itself (empty copy and its action, idle attention, offline). */
  previewCopy?: FacePreviewCopy;
  /** Home: switch into the loading, offline and attention faces when the widget's own reading calls for them. */
  autoState?: boolean;
}

/**
 * `previewCopy` here is the adapter's live part; the caller's copy fills what
 * it leaves out. `live` is the adapter's own reading, for `autoState`.
 */
type Face = Omit<FaceProps, 'size' | 'delay' | 'onOpen' | 'preview'> & { live?: LiveReading };

function Card({ p, face: withLive, tone }: { p: WidgetProps; face: Face; tone?: FaceTone }) {
  const { live, ...face } = withLive;
  const auto = !p.preview && p.autoState && live ? liveFaceState(live) : undefined;
  const copy = p.preview
    ? {
        attention: face.previewCopy?.attention ?? p.previewCopy?.attention,
        empty: face.previewCopy?.empty ?? p.previewCopy?.empty,
        offline: face.previewCopy?.offline ?? p.previewCopy?.offline,
      }
    : auto && live
      ? { attention: attentionRow(live.attention), offline: offlineRow(live.offline) }
      : undefined;
  return <WidgetFace {...face} tone={p.forceTone ?? tone ?? face.tone} size={p.size} delay={p.delay} onOpen={p.open} preview={p.preview ?? auto} previewCopy={copy} />;
}

const onOnline = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb); };
};
/** Whether this Mac has a network at all — the one offline signal no fetch has to fail for. */
function useOnline(): boolean {
  return useSyncExternalStore(onOnline, () => navigator.onLine, () => true);
}

/** A live attention reading as the face's row; a meeting link becomes Join. */
function attentionRow(a: AttentionCopy | null): FacePreviewCopy['attention'] {
  if (!a) return undefined;
  const link = a.join;
  return { text: a.text, tone: a.tone, icon: a.icon, action: link ? { label: 'Join', onClick: () => void openExternal(link) } : undefined };
}

/** A live offline line (it knows the real age); stale content dims. */
const offlineRow = (text: string | null): FacePreviewCopy['offline'] => (text ? { text, dim: true } : undefined);

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const money = (v: number, currency = 'USD') => {
  try { return v.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }); } catch { return v.toFixed(0); }
};

/** A ticking clock for the widgets that show the time. */
function useTick(ms: number, on = true): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setT(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
  return t;
}

// --- Day ---------------------------------------------------------------------------

export function WeatherWidget(p: WidgetProps) {
  const { weather, isFallback, isLoading, error } = useWeather();
  const online = useOnline();
  const sunny = /sun|clear/i.test(weather.condition);
  const hourly = weather.hourly.slice(0, 4);
  const feels = feelsLine(weather.temp, weather.feelsLike);
  const now = Date.now();
  const face: Face = {
    label: 'Weather',
    meta: weather.location,
    sample: isFallback ? 'Sample weather — no reading has arrived yet' : null,
    value: `${Math.round(weather.temp)}°`,
    delta: weather.high != null && weather.low != null ? `H ${Math.round(weather.high)}° L ${Math.round(weather.low)}°` : undefined,
    deltaTone: 'muted',
    sub: feels ? `${weather.condition} · ${feels}` : weather.condition,
    live: p.autoState ? {
      loading: isFallback && isLoading,
      offline: networkOffline('weather', { hasData: !isFallback, error, online, arrivedAt: isFallback ? null : seenAt(weather, now) }, now),
      attention: isFallback ? null : weatherAttention(hourly),
    } : undefined,
    stats: hourly.map((h) => ({ t: h.time, s: `${Math.round(h.temp)}°` })),
    rows: (weather.daily ?? []).slice(0, 3).map<FaceRow>((d) => ({ key: d.day, lead: d.day, title: d.icon.replace(/-/g, ' '), value: `${Math.round(d.high)}° / ${Math.round(d.low)}°`, valueTone: 'ink' })),
    foot: [{ t: weather.sunrise, s: 'Sunrise' }, { t: weather.sunset, s: 'Sunset' }, { t: `${weather.humidity}%`, s: 'Humidity' }, { t: `${Math.round(weather.windSpeed)}`, s: 'Wind' }],
    bleed: sunny ? <span className="bw-glow" /> : null,
    previewCopy: p.preview ? { attention: attentionRow(weatherAttention(hourly)) } : undefined,
  };
  return <Card p={p} face={face} tone="sky" />;
}

export function TodayWidget(p: WidgetProps) {
  const { events, isLoading } = useCalendarEvents();
  const now = useTick(30000);
  const todays = todaysEvents(events, now);
  const focus = focusEvent(todays, now);
  const then = thenEvents(todays, focus);
  const face: Face = {
    // The calendar lives on this Mac: it loads, it never goes offline.
    live: p.autoState ? { loading: isLoading && !events.length, offline: null, attention: todayAttention(focus, now) } : undefined,
    label: 'Today',
    meta: `${todays.length} ${todays.length === 1 ? 'event' : 'events'}`,
    value: focus ? eventTime(focus) : 'Free',
    delta: focus ? focusIn(focus, now) : undefined,
    deltaTone: 'blue',
    sub: focus ? focus.title : 'Nothing scheduled today',
    rows: then.map<FaceRow>((e) => ({ key: e.id, lead: eventTime(e), title: e.title, sub: e.location ?? undefined })),
    previewCopy: p.preview ? { attention: attentionRow(todayAttention(focus, now)) } : undefined,
  };
  return <Card p={p} face={face} />;
}

export function TasksWidget(p: WidgetProps) {
  const { tasks, completedCount, toggleTask, addTask, isLoading } = useTasks();
  const [draft, setDraft] = useState('');
  // Re-read the clock with the card's other minute-scale readers, so a task
  // falls overdue on Home without anything else having to change.
  const now = useTick(60000, !!p.autoState);
  const open = tasks.filter((t) => !t.completed);
  const pill = (priority: string): FaceRow['pill'] => {
    const k = priority.toLowerCase();
    if (k === 'high') return { text: 'High', tone: 'high' };
    if (k === 'medium' || k === 'med') return { text: 'Med', tone: 'med' };
    return undefined;
  };
  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    void addTask(title);
  };
  const face: Face = {
    label: 'Tasks',
    meta: tasks.length ? `${completedCount} of ${tasks.length} done` : 'Nothing yet',
    value: `${open.length}`,
    sub: open.length === 1 ? 'open task' : 'open tasks',
    segs: tasks.slice(0, 10).map((t) => t.completed),
    rows: open.slice(0, 3).map<FaceRow>((t) => ({
      key: t.id, leadKind: 'check', checked: false, title: t.title, pill: pill(t.priority),
      sub: t.due_date ? new Date(t.due_date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : undefined,
      onClick: () => void toggleTask(t.id),
    })),
    tail: (
      <input
        className="b-input bw-input"
        placeholder="Add a task, press Enter"
        aria-label="Add a task"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
    ),
    previewCopy: p.preview ? { attention: attentionRow(tasksAttention(tasks, Date.now())) } : undefined,
    live: p.autoState ? { loading: isLoading && !tasks.length, offline: null, attention: tasksAttention(tasks, now) } : undefined,
  };
  return <Card p={p} face={face} />;
}

// --- Communication -----------------------------------------------------------------

const initials = (addr: string | null): string => {
  const name = (addr ?? '?').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return name.split(' ').slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
};

export function InboxWidget(p: WidgetProps) {
  const { messages, alerts, accounts, isConnected, isLoading } = useMailIntelligence();
  const online = useOnline();
  const needs = alerts.filter((a) => !a.acknowledged);
  const top = useMemo(() => [...messages].sort((a, b) => b.importance - a.importance).slice(0, 3), [messages]);
  const face: Face = {
    label: 'Inbox',
    meta: isConnected ? `${messages.length} scanned` : 'No mailbox yet',
    value: isConnected ? `${needs.length}` : '—',
    sub: isConnected ? (needs.length === 1 ? 'needs you' : 'need you') : 'Connect a mailbox in Mail',
    rows: top.map<FaceRow>((m) => ({
      key: m.id, leadKind: 'chip', lead: initials(m.from_address), title: m.subject ?? '(no subject)', sub: m.snippet ?? undefined,
      pill: m.category === 'important' || m.category === 'bills' ? { text: m.category === 'bills' ? 'Bill' : 'Important', tone: 'high' } : undefined,
    })),
    note: needs[0] ? needs[0].title : undefined,
    previewCopy: p.preview ? { attention: attentionRow(inboxAttention(alerts)), offline: offlineRow(mailOffline(accounts, Date.now())) } : undefined,
    live: p.autoState ? {
      loading: isLoading && !messages.length && !accounts.length,
      offline: inboxOffline(accounts, online, Date.now()),
      attention: inboxAttention(alerts),
    } : undefined,
  };
  return <Card p={p} face={face} />;
}

export function BriefingWidget(p: WidgetProps) {
  const { news, isFallback, isLoading, error } = useNews();
  const online = useOnline();
  const lead = news[0];
  const now = Date.now();
  const face: Face = {
    label: 'Briefing',
    meta: lead ? `${news.length} headlines` : 'Fetching…',
    sample: isFallback ? 'Sample headlines — the news feed has not answered yet' : null,
    children: lead ? (
      <span className="bw-lede"><span className="bw-lede-t">{lead.title}</span><span className="bw-lede-s">{lead.source} · {lead.time}</span></span>
    ) : <span className="bw-lede"><span className="bw-lede-s">No headlines yet.</span></span>,
    rows: news.slice(1, 4).map<FaceRow>((n) => ({ key: n.id, leadKind: 'dot', dotOn: n.trending, title: n.title, sub: n.source })),
    previewCopy: p.preview ? { attention: attentionRow(briefingAttention(news)) } : undefined,
    // No attention on Home: NewsAPI has no trending signal, and the fetch
    // marks its first stories `trending` by position, so the rule would hold
    // on every refresh and the row would stop meaning anything.
    live: p.autoState ? {
      loading: isLoading && !news.length,
      offline: networkOffline('briefing', { hasData: !isFallback && news.length > 0, error, online, arrivedAt: !isFallback && news.length ? seenAt(news, now) : null }, now),
      attention: null,
    } : undefined,
  };
  return <Card p={p} face={face} tone="linen" />;
}

// --- Money -------------------------------------------------------------------------

export function WatchWidget(p: WidgetProps) {
  // The tickers the user keeps (Watchlist screen, or the brain's watchlist op),
  // asked for only once the table has been read, so a saved list does not
  // first fetch the starting four.
  const watch = useWatchlist();
  const { stocks, indices, isFallback, isLoading, error } = useStocks(watch.loaded ? watch.symbols : []);
  const online = useOnline();
  const portfolio = usePortfolio();
  const summary = portfolio.connected ? portfolio.summary : null;
  const first = stocks[0];
  const toneOf = (v: number): FaceRow['valueTone'] => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
  const now = Date.now();
  const hasQuotes = !isFallback && stocks.length > 0;
  const face: Face = {
    label: 'Watchlist',
    meta: summary ? 'Portfolio' : indices[0] ? `${indices[0].label} ${fmtPct(indices[0].changePercent)}` : 'Markets',
    sample: isFallback ? 'Sample quotes — the market feed has not answered yet' : null,
    value: summary ? money(summary.total_value, summary.currency) : first ? first.price.toFixed(2) : '—',
    delta: summary ? fmtPct(summary.unrealized_pct) : first ? fmtPct(first.changePercent) : undefined,
    deltaTone: summary ? (summary.unrealized_pct >= 0 ? 'up' : 'down') : first ? (first.changePercent >= 0 ? 'up' : 'down') : 'muted',
    sub: summary ? `${summary.holdings_count} holdings` : first ? first.name : watch.loaded && !watch.symbols.length ? 'No tickers yet · add them in Watchlist' : 'No tickers yet',
    spark: first?.sparkline?.length ? first.sparkline : undefined,
    sparkColour: first && first.changePercent < 0 ? 'var(--b-red)' : 'var(--b-green-deep)',
    rows: stocks.slice(0, p.size === 'XL' ? 4 : 3).map<FaceRow>((s) => ({
      key: s.symbol, lead: s.symbol, title: s.name, value: s.price.toFixed(2), valueTone: toneOf(s.changePercent), sub: fmtPct(s.changePercent),
    })),
    kv: indices.slice(0, 4).map((i) => ({ t: fmtPct(i.changePercent), s: i.label, c: i.changePercent >= 0 ? 'var(--b-green-deep)' : 'var(--b-red-deep)' })),
    previewCopy: p.preview ? { attention: attentionRow(watchAttention(stocks, watch.threshold)) } : undefined,
    live: p.autoState ? {
      loading: !watch.loaded || (watch.symbols.length > 0 && isLoading && !stocks.length),
      offline: networkOffline('watch', { hasData: hasQuotes, error, online, arrivedAt: hasQuotes ? seenAt(stocks, now) : null }, now),
      // Never on the sample: a canned +2.6% is not news.
      attention: hasQuotes ? watchAttention(stocks, watch.threshold) : null,
    } : undefined,
  };
  return <Card p={p} face={face} />;
}

// --- Money: the bank store (admin builds list these; see betaHome.ts) --------------

function moneyEmptySub(available: boolean): string {
  return available ? 'Import a CSV or connect a bank in Money' : 'Money keeps its data in the Mac app';
}

const monthName = (today: string) => new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { month: 'long' });

export function SpendWidget(p: WidgetProps) {
  const { model, available, today } = useBank();
  const cur = model.currency;
  const rows = spendRows(model).filter((r) => r.spent > 0);
  const face: Face = {
    label: 'Spend',
    meta: monthName(today),
    value: model.hasData ? money(totalSpent(model), cur) : '—',
    sub: model.hasData ? `spent in ${monthName(today)}` : moneyEmptySub(available),
    rows: rows.slice(0, 4).map<FaceRow>((r) => ({ key: r.id, leadKind: 'dot', dotOn: true, title: r.label, value: money(r.spent, cur), valueTone: 'ink' })),
    kv: p.size === 'M' ? rows.slice(0, 3).map((r) => ({ t: money(r.spent, cur), s: r.label })) : undefined,
  };
  return <Card p={p} face={face} />;
}

export function BudgetWidget(p: WidgetProps) {
  const { model, available } = useBank();
  const cur = model.currency;
  const ring = model.ring;
  const budgeted = ring.mode === 'budget';
  const limited = spendRows(model).filter((r) => r.limit);
  const face: Face = {
    label: 'Budget',
    meta: budgeted ? `${Math.round(ring.pace * 100)}% through the month` : undefined,
    value: budgeted ? money(ring.left, cur) : '—',
    delta: budgeted ? paceSentence(ring, (v) => money(v, cur)) : undefined,
    deltaTone: budgeted ? (ring.over ? 'down' : 'up') : 'muted',
    sub: budgeted ? `left of ${money(ring.budget, cur)}` : model.hasData ? 'Set monthly limits in Money' : moneyEmptySub(available),
    bar: budgeted ? { fraction: Math.min(1, ring.budget > 0 ? ring.spent / ring.budget : 0), colour: ring.over ? 'var(--b-red)' : 'var(--b-blue)' } : undefined,
    rows: limited.slice(0, 4).map<FaceRow>((r) => ({
      key: r.id, title: r.label, value: `${money(r.spent, cur)} / ${money(r.limit ?? 0, cur)}`, valueTone: r.limit && r.spent > r.limit ? 'down' : 'muted',
    })),
  };
  return <Card p={p} face={face} />;
}

export function SubscriptionsWidget(p: WidgetProps) {
  const { model, available, today } = useBank();
  const cur = model.currency;
  const active = model.subs.filter((s) => s.status === 'active').sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : 0));
  const face: Face = {
    label: 'Subscriptions',
    meta: active.length ? `${active.length} found` : undefined,
    value: active.length ? money(model.subTotals.monthly, cur) : '—',
    sub: active.length ? 'a month' : model.hasData ? 'None found yet: a payment must repeat first' : moneyEmptySub(available),
    rows: active.slice(0, 4).map<FaceRow>((s) => ({ key: s.key, title: s.merchant, sub: `next ${dayLabel(s.next, today)}`, value: money(s.amount, cur), valueTone: 'muted' })),
    note: model.subTotals.saved ? `Saving ${money(model.subTotals.saved, cur)} a month from cancellations` : undefined,
  };
  return <Card p={p} face={face} />;
}

// --- Air & time --------------------------------------------------------------------

const AQI_LABEL = ['', 'Good', 'Fair', 'Moderate', 'Poor', 'Very poor'];
const AQI_COLOUR = ['', 'var(--b-green)', 'var(--b-green)', '#d79a2b', 'var(--b-red)', 'var(--b-red-deep)'];

export function AirWidget(p: WidgetProps) {
  const { weather, isFallback } = useWeather();
  const air = weather.air ?? null;
  const face: Face = {
    label: 'Air quality',
    meta: weather.location,
    sample: isFallback ? 'Sample air — no reading has arrived yet' : null,
    value: air ? `${Math.round(air.pm25)}` : '—',
    delta: air ? AQI_LABEL[air.aqi] ?? undefined : undefined,
    deltaTone: air ? (air.aqi <= 2 ? 'up' : air.aqi === 3 ? 'muted' : 'down') : 'muted',
    sub: air ? 'PM2.5 µg/m³' : 'No air reading in this forecast',
    bar: air ? { fraction: Math.min(1, air.pm25 / 75), colour: AQI_COLOUR[air.aqi] } : undefined,
    kv: air ? [{ t: `${air.aqi}`, s: 'AQI 1–5' }, { t: `${weather.humidity}%`, s: 'Humidity' }, { t: `${Math.round(weather.windSpeed)}`, s: 'Wind' }] : undefined,
  };
  return <Card p={p} face={face} />;
}

// --- Time: all three read the Clock's own store (src/lib/betaClockStore.ts), so
// they show the cities, alarms, timer and countdown /clock shows. The store's
// prefs hook never ticks; each widget keeps its own, slower clock.

/** The zone the Clock reads alarms in: the one it last saved, else this Mac's. */
const clockZone = (zone: string | null): string => zone ?? systemZone();

export function ClockWidget(p: WidgetProps) {
  const prefs = useClockPrefs();
  const counting = prefs.timer.running || prefs.countdown.running;
  const now = useTick(counting ? 1000 : 15000);
  const e = elsewhere(prefs, now, clockZone(prefs.zone));
  const first = e.cities[0];
  const stats = [
    ...(e.alarm ? [{ t: e.alarm.when, s: e.alarm.label, dot: 'var(--b-blue)' }] : []),
    ...(e.running ? [{ t: e.running.value, s: e.running.label, dot: e.running.over ? 'var(--b-red)' : 'var(--b-green)' }] : []),
  ];
  const face: Face = {
    label: 'Elsewhere',
    meta: citiesMeta(e.total),
    value: first?.time ?? '—',
    delta: first?.diff,
    deltaTone: 'muted',
    sub: first ? first.name : 'Add cities on the Clock screen',
    stats: stats.length ? stats : undefined,
    rows: e.cities.map<FaceRow>((r) => ({
      key: r.tz, lead: r.time, title: r.name, sub: r.badge === 'Today' ? undefined : r.badge, value: r.diff, valueTone: 'muted',
    })),
  };
  return <Card p={p} face={face} />;
}

/** The four hour ticks of `Atlas Widgets Beta.dc.html`'s dial, in its 100-unit box. */
const DIAL_TICKS: readonly [number, number][] = [[50, 14], [86, 50], [50, 86], [14, 50]];

export function DialsWidget(p: WidgetProps) {
  const prefs = useClockPrefs();
  const now = useTick(15000);
  const list = dials(clockZone(prefs.zone), prefs.cities, now, dialCount(p.size));
  const cols = p.size === 'S' ? 1 : 3;
  const px = p.size === 'L' ? 54 : cols === 3 ? 52 : 48;
  const grid = { '--b-ck-dial-cols': cols, '--b-ck-dial-size': `${px}px` } as CSSProperties;
  const face: Face = {
    label: 'Clock dials',
    meta: citiesMeta(prefs.cities.length),
    children: (
      <span className="b-ck-dials" style={grid}>
        {list.map((d) => (
          <span key={d.tz} className={`b-ck-dial${d.night ? ' night' : ''}`}>
            <svg viewBox="0 0 100 100" aria-hidden>
              <circle className="face" cx="50" cy="50" r="48" />
              {DIAL_TICKS.map(([x, y]) => <circle key={`${x}-${y}`} className="tick" cx={x} cy={y} r="2.2" />)}
              <line className="hand" x1="50" y1="50" x2="50" y2="28" strokeWidth="5.5" style={{ transform: `rotate(${d.hourDeg}deg)` }} />
              <line className="hand" x1="50" y1="50" x2="50" y2="18" strokeWidth="3.2" style={{ transform: `rotate(${d.minuteDeg}deg)` }} />
              <circle className="hub" cx="50" cy="50" r="3.4" />
            </svg>
            <span className="b-ck-dial-name"><b>{d.name}</b><span>{d.time} · {d.diff}</span></span>
          </span>
        ))}
      </span>
    ),
  };
  return <Card p={p} face={face} />;
}

export function CountdownWidget(p: WidgetProps) {
  const prefs = useClockPrefs();
  const c = prefs.countdown;
  const now = useTick(countdownTickMs(c));
  const f = countdownFace(c, now, clockZone(prefs.zone));
  const over = f.state === 'over';
  const face: Face = {
    label: 'Countdown',
    meta: f.state === 'running' || over ? 'Running' : f.state === 'paused' ? 'Paused' : undefined,
    value: f.value,
    delta: f.delta || undefined,
    deltaTone: over ? 'down' : 'blue',
    sub: f.sub,
    bar: f.fraction != null ? { fraction: f.fraction, colour: over ? 'var(--b-red)' : 'var(--b-blue)' } : undefined,
  };
  return <Card p={p} face={face} />;
}

// --- Media -------------------------------------------------------------------------

/** Clicks and keys on a widget's own controls are theirs, not the card's (which would open the full view). */
const own = {
  onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
};

/**
 * Now playing, driven by the music queue store: previous and next step
 * through Up next (the engine itself holds one record), play moves the record
 * here when another device has it, and at L the design's extras — shuffle,
 * repeat, Atlas's volume, the output room and what plays next.
 */
export function MusicWidget(p: WidgetProps) {
  const music = useMusicPlayer();
  const q = useMusicQueue();
  const np = music.nowPlaying;
  const track = np?.track ?? null;
  const playing = !!np?.isPlaying;
  const atlasOwns = !!track && music.audioReady && engineHoldsUri(track.uri);
  const showPause = playing && atlasOwns;
  const tick = useTick(1000, playing);
  const progress = track?.durationMs ? Math.min(1, music.readPosition() / track.durationMs) : 0;
  void tick;
  const canQueue = music.available && music.connected && music.premium;
  const roomsMissing = lacks(music.scopes, ROOM_SCOPES);
  const rooms = roomsFrom(roomsMissing ? [] : q.devices, { atlasOwnsAudio: atlasOwns, isPlaying: playing, macVolume: q.prefs.volume });
  const activeRoom = rooms.find((r) => r.active)?.id ?? THIS_MAC;
  const canVolume = canQueue && music.audioReady;
  const extras = p.size === 'L' && music.connected;
  const face: Face = {
    label: 'Now playing',
    meta: music.connected ? (atlasOwns || !track ? 'This Mac' : (np?.deviceName ?? 'Spotify')) : music.available ? 'Not connected' : 'Mac app only',
    children: (
      <span className="bw-music-wrap">
        <span className="bw-music">
          <span className="bw-art">{track?.artUrl ? <img src={track.artUrl} alt="" /> : <AtlasIcon name="music" size={22} weight={1.6} />}</span>
          <span className="bw-music-text">
            <span className="bw-music-t">{track?.title ?? (music.connected ? 'Nothing playing' : 'Connect Spotify')}</span>
            <span className="bw-music-s">{track?.artist ?? (music.connected ? 'Pick something in Music' : 'Through the Music screen')}</span>
          </span>
          {music.connected ? (
            <span className="bw-music-ctl" {...own}>
              <MusicLike track={track} className="bw-music-like" size={15} />
              <button type="button" className="flip" aria-label="Previous" disabled={!canQueue} onClick={() => musicQueue.prev()}><AtlasIcon name="skip" size={16} /></button>
              <button type="button" className="main" aria-label={showPause ? 'Pause' : 'Play'} disabled={!canQueue} title={canQueue ? undefined : 'Full-track playback needs Spotify Premium.'} onClick={() => void musicQueue.togglePlay()}><AtlasIcon name={showPause ? 'pause' : 'play'} size={16} /></button>
              <button type="button" aria-label="Next" disabled={!canQueue} onClick={() => musicQueue.next()}><AtlasIcon name="skip" size={16} /></button>
            </span>
          ) : null}
        </span>
        {extras ? (
          <span className="bw-music-x" {...own}>
            <button type="button" className={`bw-music-tog${q.prefs.shuffle ? ' on' : ''}`} aria-label="Shuffle" aria-pressed={q.prefs.shuffle} title="Shuffle Up next" onClick={() => musicQueue.setPrefs({ shuffle: !q.prefs.shuffle })}><AtlasIcon name="shuffle" size={15} /></button>
            <button type="button" className={`bw-music-tog${q.prefs.repeat ? ' on' : ''}`} aria-label="Repeat" aria-pressed={q.prefs.repeat} title="Repeat this track" onClick={() => musicQueue.setPrefs({ repeat: !q.prefs.repeat })}><AtlasIcon name="repeat" size={15} /></button>
            <span className="bw-music-vol" title={canVolume ? 'Atlas’s own output on this Mac' : 'Volume applies once Atlas is the one playing.'}>
              <AtlasIcon name="speaker" size={15} />
              <input type="range" min={0} max={1} step={0.01} value={q.prefs.volume} disabled={!canVolume} aria-label="Atlas output volume" onChange={(e) => musicQueue.setPrefs({ volume: Number(e.currentTarget.value) })} />
            </span>
            <select
              className="bw-music-out"
              aria-label="Output"
              value={activeRoom}
              disabled={!canQueue || roomsMissing || q.rooms.moving !== null}
              title={roomsMissing ? 'Reconnect Spotify in Music to turn on Rooms.' : 'Where the music plays. Other rooms are your Spotify Connect speakers.'}
              onFocus={() => { if (!roomsMissing) void musicQueue.refreshRooms(); }}
              onChange={(e) => void musicQueue.moveTo(e.currentTarget.value)}
            >
              {rooms.map((r) => <option key={r.id} value={r.id} disabled={r.restricted}>{r.name}</option>)}
            </select>
            {q.nextUp ? <span className="bw-music-next">Next · {nextLine(q.nextUp)}</span> : null}
          </span>
        ) : null}
      </span>
    ),
    bar: track ? { fraction: progress, colour: 'var(--b-on-ink)' } : undefined,
  };
  return <Card p={p} face={face} tone="ink" />;
}

/**
 * Podcast: the episode playing now, or the one Atlas last kept a place in,
 * with how much is left and a play button that resumes it. Opens the
 * Podcast view (saved shows and episodes).
 */
export function PodcastWidget(p: WidgetProps) {
  const music = useMusicPlayer();
  const recent = useRecentEpisodes(1);
  const np = music.nowPlaying;
  const nowEp = np?.track && isEpisode(np.track) ? np.track : null;
  const last = recent[0] ?? null;
  const track = nowEp ?? last?.track ?? null;
  const isNow = !!nowEp;
  const playing = isNow && !!np?.isPlaying;
  useTick(1000, playing);
  const durationMs = track?.durationMs ?? 0;
  const pos = isNow ? music.readPosition() : last?.positionMs ?? 0;
  const start = !isNow && last ? resumeFrom({ local: { positionMs: last.positionMs }, spotify: null, durationMs: last.durationMs }) : 0;
  const canQueue = music.available && music.connected && music.premium;
  const showPause = playing && music.audioReady && !!track && engineHoldsUri(track.uri);
  const onPlay = () => {
    if (!track) return;
    if (isNow) void musicQueue.togglePlay();
    else void musicQueue.playTrack(track, undefined, start);
  };
  const face: Face = {
    label: 'Podcast',
    meta: music.connected ? 'Spotify' : music.available ? 'Not connected' : 'Mac app only',
    children: (
      <span className="bw-music">
        <span className="bw-art">{track?.artUrl ? <img src={track.artUrl} alt="" /> : <AtlasIcon name="voice" size={22} weight={1.6} />}</span>
        <span className="bw-music-text">
          <span className="bw-music-t">{track?.title ?? (music.connected ? 'No episode started' : 'Connect Spotify')}</span>
          <span className="bw-music-s">{track ? `${track.artist} · ${episodeLeft(durationMs, pos)}` : music.connected ? 'Open to pick from your shows' : 'Through the Music screen'}</span>
        </span>
        {track ? (
          <span className="bw-music-ctl" {...own}>
            <button type="button" className="main" aria-label={showPause ? 'Pause' : start > 0 ? 'Resume' : 'Play'} disabled={!canQueue} title={canQueue ? undefined : 'Episodes play through Atlas with Spotify Premium.'} onClick={onPlay}>
              <AtlasIcon name={showPause ? 'pause' : 'play'} size={16} />
            </button>
          </span>
        ) : null}
      </span>
    ),
    bar: track && durationMs > 0 ? { fraction: Math.min(1, Math.max(0, pos / durationMs)), colour: 'var(--b-on-ink)' } : undefined,
  };
  return <Card p={p} face={face} tone="ink" />;
}

// --- Body --------------------------------------------------------------------------

const RING_GOALS = { active_energy_kcal: 500, exercise_minutes: 30, stand_minutes: 12 } as const;
const RING_LABEL = { active_energy_kcal: 'Move', exercise_minutes: 'Exercise', stand_minutes: 'Stand' } as const;
const RING_COLOUR = { active_energy_kcal: 'var(--b-red)', exercise_minutes: 'var(--b-green)', stand_minutes: 'var(--b-blue)' } as const;
const SAMPLE_RINGS = [
  { label: 'Move', value: '320 kcal', fraction: 0.64, colour: 'var(--b-red)' },
  { label: 'Exercise', value: '18 min', fraction: 0.6, colour: 'var(--b-green)' },
  { label: 'Stand', value: '7 h', fraction: 0.58, colour: 'var(--b-blue)' },
];

function useHealthCards() {
  const h = useHealth();
  const cards = h.snapshot?.metrics ?? [];
  const byId = (id: string) => cards.find((m) => m.id === id);
  const emptySub = h.supported ? 'Import a Health export on the Health screen' : 'Health data lives in the Mac app';
  return { h, byId, emptySub, hasData: !!h.snapshot?.hasData };
}

export function ActivityWidget(p: WidgetProps) {
  const { byId, hasData, emptySub } = useHealthCards();
  const real = (Object.keys(RING_GOALS) as (keyof typeof RING_GOALS)[]).flatMap((id) => {
    const card = byId(id);
    const v = num(card?.value);
    return card && v != null ? [{ label: RING_LABEL[id], value: card.value ?? '', fraction: Math.min(1, v / RING_GOALS[id]), colour: RING_COLOUR[id] }] : [];
  });
  const sample = real.length === 0;
  const rings = sample ? SAMPLE_RINGS : real;
  const face: Face = {
    label: 'Activity',
    meta: sample ? 'Today' : byId('active_energy_kcal')?.kicker ?? 'Today',
    sample: sample ? (hasData ? 'Sample rings — this export has no activity totals' : `Sample rings — ${emptySub.toLowerCase()}`) : null,
    rings,
    value: p.size === 'S' ? rings[0].value : undefined,
    sub: p.size === 'S' ? rings[0].label : undefined,
  };
  return <Card p={p} face={face} />;
}

export function StepsWidget(p: WidgetProps) {
  const { byId, emptySub } = useHealthCards();
  const card = byId('steps');
  const dist = byId('distance_walking_running_km');
  const face: Face = {
    label: 'Steps',
    meta: card?.kicker ?? 'No data',
    value: card?.value ?? '—',
    delta: dist?.value,
    deltaTone: 'muted',
    sub: card ? card.caption ?? 'steps' : emptySub,
    bar: card && num(card.value) != null ? { fraction: Math.min(1, (num(card.value) ?? 0) / 10000), colour: 'var(--b-green)' } : undefined,
    kv: card ? [{ t: `${Math.round(Math.min(100, ((num(card.value) ?? 0) / 10000) * 100))}%`, s: 'of 10,000' }, ...(dist ? [{ t: dist.value ?? '', s: 'Distance' }] : [])] : undefined,
  };
  return <Card p={p} face={face} />;
}

export function SleepWidget(p: WidgetProps) {
  const { byId, emptySub } = useHealthCards();
  const asleep = byId('sleep_asleep_minutes');
  const stages = [
    { id: 'sleep_deep_minutes', s: 'Deep', c: 'var(--b-blue-deep)' },
    { id: 'sleep_rem_minutes', s: 'REM', c: 'var(--b-blue)' },
    { id: 'sleep_core_minutes', s: 'Core', c: 'var(--b-neutral)' },
    { id: 'sleep_awake_minutes', s: 'Awake', c: 'var(--b-tertiary)' },
  ].flatMap((st) => { const c = byId(st.id); return c?.value ? [{ t: c.value, s: st.s, c: st.c }] : []; });
  const face: Face = {
    label: 'Sleep',
    meta: asleep?.kicker ?? 'No data',
    value: asleep?.value ?? '—',
    sub: asleep ? asleep.caption ?? 'asleep' : emptySub,
    kv: stages.length ? stages : undefined,
  };
  return <Card p={p} face={face} tone="slate" />;
}

// --- Home --------------------------------------------------------------------------

export function HomeKitWidget(p: WidgetProps) {
  const { snapshot, usable } = useSmartHome();
  const devices = snapshot?.rooms.flatMap((r) => r.devices) ?? [];
  // A water heater's tank is not the inside temperature (Smart Home row 47).
  const thermostats = devices.filter((d) => d.kind === 'thermostat' && d.control === 'stepper' && d.domain !== 'water_heater');
  const avg = thermostats.length ? thermostats.reduce((a, d) => a + d.value, 0) / thermostats.length : null;
  const lock = devices.find((d) => d.kind === 'lock');
  const face: Face = {
    label: 'Home',
    meta: snapshot?.hub?.name ?? (usable ? 'No hub' : 'Mac app only'),
    value: snapshot ? (avg != null ? `${avg.toFixed(1)}°` : `${snapshot.counts.devices}`) : '—',
    delta: snapshot && avg != null ? `${snapshot.counts.devices} devices` : undefined,
    deltaTone: 'muted',
    sub: snapshot ? (lock ? `${lock.name}: ${lock.state}` : `${snapshot.counts.rooms} rooms`) : usable ? 'Connect a home hub on the Smart Home screen' : 'Smart home runs in the Mac app',
    rows: (snapshot?.rooms ?? []).slice(0, 3).map<FaceRow>((r) => ({
      key: r.id, leadKind: 'dot', dotOn: r.tone === 'ok', title: r.name, sub: r.status, value: `${r.devices.length}`, valueTone: 'muted',
    })),
    chips: snapshot && snapshot.counts.unavailable > 0 ? [{ t: `${snapshot.counts.unavailable} unreachable`, tone: 'muted' }] : undefined,
  };
  return <Card p={p} face={face} />;
}

// --- Up next, Currency, Focus (left-out features, F6) -------------------------------

/** The next events from now on, not only today's: "1:1 Maya · in 18 min", then what follows. */
export function UpNextWidget(p: WidgetProps) {
  const { events, isLoading } = useCalendarEvents();
  const now = useTick(30000);
  const [next, ...after] = upNextEvents(events, now);
  const face: Face = {
    label: 'Up next',
    meta: 'Next event',
    value: next ? shortTitle(next.title, p.size === 'S' ? 12 : 18) : 'Free',
    delta: next ? upNextWhen(next, now) : undefined,
    deltaTone: 'blue',
    sub: next ? withLine(next) ?? eventTime(next) : 'Nothing coming up',
    rows: after.map<FaceRow>((e) => ({ key: e.id, lead: eventTime(e), title: e.title, value: upNextWhen(e, now), valueTone: 'muted' })),
    previewCopy: p.preview ? { attention: attentionRow(todayAttention(next ?? null, now)) } : undefined,
    // The Today widget's rule: ten minutes out or on now, with Join when the event carries a link.
    live: p.autoState ? { loading: isLoading && !events.length, offline: null, attention: todayAttention(next ?? null, now) } : undefined,
  };
  return <Card p={p} face={face} />;
}

/** "€1 Euro | $1.09 US dollar" — the ECB reference rate for the pair the user picked. */
export function CurrencyWidget(p: WidgetProps) {
  const { prefs, reading, isLoading, error } = useCurrency();
  const online = useOnline();
  const rate = reading && reading.base === prefs.base && reading.quote === prefs.quote ? reading : null;
  const move = rate ? monthMove(rate) : null;
  const stale = !!rate && (!!error || !online);
  const face: Face = {
    label: 'Currency',
    meta: rate ? rateDateLabel(rate.date) : 'ECB rates',
    children: (
      <span className="bw-split">
        <span><b>{fmtMoney(prefs.amount, prefs.base)}</b><i>{currencyName(prefs.base)}</i></span>
        <span className="bw-split-rule" aria-hidden />
        <span><b>{rate ? fmtMoney(prefs.amount * rate.rate, prefs.quote) : '—'}</b><i>{rate ? currencyName(prefs.quote) : error && !isLoading ? error : currencyName(prefs.quote)}</i></span>
      </span>
    ),
    spark: rate && rate.series.length > 1 ? rate.series.map((s) => s.rate) : undefined,
    sparkColour: move != null && move < 0 ? 'var(--b-red)' : 'var(--b-green-deep)',
    kv: rate ? [
      { t: rate.rate.toFixed(4), s: `1 ${prefs.base} in ${prefs.quote}` },
      ...(move != null ? [{ t: `${move >= 0 ? '+' : '−'}${Math.abs(move).toFixed(1)}%`, s: 'last 30 days', c: move >= 0 ? 'var(--b-green-deep)' : 'var(--b-red-deep)' }] : []),
    ] : undefined,
    live: p.autoState ? {
      loading: isLoading && !rate,
      offline: stale && rate ? `${online ? 'rate service unreachable' : 'this Mac is offline'} · ${rateDateLabel(rate.date).toLowerCase()} kept` : null,
      attention: null,
    } : undefined,
  };
  return <Card p={p} face={face} />;
}

// --- Smart Home: lamps, lights, the door camera ------------------------------------

/** Clicks and keys inside a widget's own controls must not also open the widget. */
const keep = {
  onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
};

/** The design's three lamp drawings; `glass` is the light's colour, or unlit paper. */
function LampArt({ which, glass, lit }: { which: LightWidget; glass: string; lit: boolean }) {
  const cone = lit ? 0.55 : 0;
  if (which === 'bulb') {
    return (
      <svg height="72" viewBox="0 0 64 84" fill="none" aria-hidden>
        <path d="M32 6C20 6 12 15 12 26c0 8 5 12 8 17 2 3 3 5 3 8h18c0-3 1-5 3-8 3-5 8-9 8-17C52 15 44 6 32 6z" fill={glass} />
        <path d="M27 47c0-5-3-8-3-12m13 12c0-5 3-8 3-12" stroke="#b6b1aa" strokeWidth="1.6" strokeLinecap="round" />
        <rect x="24" y="55" width="16" height="3.5" rx="1.75" fill="#b6b1aa" />
        <rect x="25" y="60" width="14" height="3.5" rx="1.75" fill="#c9c3ba" />
        <path d="M27 66h10l-3 5h-4z" fill="#b6b1aa" />
      </svg>
    );
  }
  if (which === 'floorlamp') {
    return (
      <svg height="80" viewBox="0 0 64 96" fill="none" aria-hidden>
        <path d="M22 28 L42 28 L48 88 L16 88 Z" fill={glass} opacity={cone} />
        <rect x="18" y="8" width="28" height="20" rx="5" fill="#55524b" />
        <rect x="21" y="24" width="22" height="4" rx="2" fill={glass} />
        <rect x="31" y="28" width="2.4" height="58" fill="#8b8681" />
        <rect x="20" y="86" width="24" height="4" rx="2" fill="#b6b1aa" />
      </svg>
    );
  }
  return (
    <svg height="72" viewBox="0 0 84 84" fill="none" aria-hidden>
      <path d="M40 40 L52 40 L64 76 L28 76 Z" fill={glass} opacity={cone} />
      <ellipse cx="24" cy="76" rx="14" ry="3.5" fill="#c9c3ba" />
      <path d="M24 74 36 48 45 31" stroke="#8b8681" strokeWidth="3" strokeLinecap="round" />
      <path d="M34 26h24l-6 15H40z" fill="#55524b" />
      <circle cx="46" cy="43" r="4.5" fill={glass} />
    </svg>
  );
}

const UNLIT = '#e8e4de';
const LIGHT_LABEL: Record<LightWidget, string> = { lamp: 'Lamp', bulb: 'Bulb', floorlamp: 'Floor lamp' };

/**
 * Lamp, Bulb and Floor lamp: one real light from Home Assistant, the design's
 * drawing of it, a tap on the drawing to switch it, and — for a colour light —
 * the swatches, which go through `setDeviceColour` like the Smart Home stage's.
 */
function LightCard({ p, which }: { p: WidgetProps; which: LightWidget }) {
  const { snapshot, usable, setDeviceValue, setDeviceColour } = useSmartHome();
  const devices = snapshot.rooms.flatMap((r) => r.devices);
  const d = pickLight(devices, which);
  // The level the light last ran at, so a tap brings it back there.
  const lastOn = useRef<Record<string, number>>({});
  if (d && d.value > 0 && d.control !== 'toggle' && !d.pending) lastOn.current[d.id] = d.value;
  const hasBridge = snapshot.bridgeState !== 'none';
  const inert = !usable || (hasBridge && snapshot.bridgeState !== 'connected') || !d || !d.available;
  const on = !!d && d.available && d.value > 0;
  const glass = on ? d?.colour ?? '#ffd9a0' : UNLIT;
  const status = !d
    ? !usable ? 'Mac app only' : !hasBridge ? 'Link Home Assistant in Smart Home' : which === 'floorlamp' ? 'No light is named a floor lamp' : 'Your bridge reports no light'
    : !d.available ? 'Not responding'
      : d.pending || d.note ? d.state
        : on ? (d.control === 'toggle' ? 'On' : `${colourName(d.colour) ?? 'On'} · ${Math.round(d.value)}%`) : 'Off · tap the lamp';
  const face: Face = {
    label: LIGHT_LABEL[which],
    meta: d ? [d.name, d.roomName].filter(Boolean).join(' · ') : snapshot.hub?.name ?? (usable ? 'No hub' : 'Mac app only'),
    children: (
      <span className="bw-sh-lamp">
        <span className="bw-sh-lamp-glow" style={{ background: `radial-gradient(closest-side, ${glass}, transparent 70%)`, opacity: on ? 0.9 : 0 }} />
        <button
          type="button" className="bw-sh-lamp-btn" onKeyDown={keep.onKeyDown} disabled={inert}
          aria-label={d ? `${d.name}: ${on ? 'turn off' : 'turn on'}` : LIGHT_LABEL[which]} aria-pressed={on}
          onClick={(e) => { e.stopPropagation(); if (d) setDeviceValue(d.id, powerValue(d, lastOn.current[d.id])); }}
        >
          <LampArt which={which} glass={glass} lit={on} />
        </button>
        <span className="bw-sh-lamp-status">{status}</span>
        {d && d.control === 'colour' ? (
          <span className="bw-sh-swatches" {...keep}>
            {SWATCHES.map((w) => (
              <button
                type="button" key={w.c} aria-label={w.l} title={w.l} aria-pressed={d.colour?.toLowerCase() === w.c} disabled={inert}
                style={{ background: w.c }} onClick={(e) => { e.stopPropagation(); setDeviceColour(d.id, w.c); }}
              />
            ))}
          </span>
        ) : null}
      </span>
    ),
  };
  return <Card p={p} face={face} />;
}

/** The running session's clock and what it held; between sessions, today's focus. */
export function FocusWidget(p: WidgetProps) {
  const focus = useFocus();
  const running = isRunning(focus.session);
  const now = useTick(1000, !!focus.session && running);
  const s = focus.session;
  const today = dayStats(focus.log, now);
  const face: Face = s ? {
    label: 'Focus',
    meta: running ? 'Holding notifications' : 'Paused',
    value: fmtClock(leftMs(s, now)),
    delta: running ? 'left' : 'paused',
    deltaTone: running ? 'blue' : 'muted',
    sub: [heldLabel(s.held.length), s.task].filter(Boolean).join(' · '),
    bar: { fraction: progress(s, now), colour: 'var(--b-blue)' },
    rows: s.held.slice(-3).reverse().map<FaceRow>((h) => ({ key: `${h.at}-${h.title}`, leadKind: 'dot', title: h.title, sub: h.source })),
  } : {
    label: 'Focus',
    meta: 'Today',
    value: fmtFocusMinutes(today.minutes),
    delta: today.sessions ? `${today.sessions} ${today.sessions === 1 ? 'session' : 'sessions'}` : undefined,
    deltaTone: 'muted',
    sub: today.longest ? `Longest run ${today.longest} minutes` : `Start ${focus.prefs.lengthMin} minutes and Atlas holds its notifications`,
    rows: today.entries.slice(-3).reverse().map<FaceRow>((e) => ({
      key: String(e.startedAt), lead: new Date(e.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      title: e.task ?? 'Focus', value: `${e.minutes} min`, valueTone: 'muted',
    })),
    kv: today.sessions ? [{ t: `${today.sessions}`, s: 'Sessions' }, { t: `${today.longest}m`, s: 'Longest' }, { t: `${today.held}`, s: 'Held' }] : undefined,
    tail: (
      <button type="button" className="b-btn b-btn--primary bw-focus-go" onClick={() => startFocus(null)}>
        Start {focus.prefs.lengthMin} min
      </button>
    ),
  };
  return <Card p={p} face={face} tone={s ? 'ink' : 'sky'} />;
}

export const LampWidget = (p: WidgetProps) => <LightCard p={p} which="lamp" />;
export const BulbWidget = (p: WidgetProps) => <LightCard p={p} which="bulb" />;
export const FloorLampWidget = (p: WidgetProps) => <LightCard p={p} which="floorlamp" />;

/** Lights: how many are on and where, each one switchable, and All off. */
export function LightsWidget(p: WidgetProps) {
  const { snapshot, usable, setDeviceValue } = useSmartHome();
  const devices = snapshot.rooms.flatMap((r) => r.devices);
  const sum = lightsSummary(devices);
  const hasBridge = snapshot.bridgeState !== 'none';
  const inert = !usable || (hasBridge && snapshot.bridgeState !== 'connected');
  const face: Face = {
    label: 'Lights',
    meta: sum.total ? `${sum.on.length} of ${sum.total} on` : snapshot.hub?.name ?? (usable ? 'No hub' : 'Mac app only'),
    value: sum.total ? (sum.on.length ? (sum.brightness != null ? `${sum.brightness}%` : 'On') : 'Off') : '—',
    sub: !usable ? 'Smart home runs in the Mac app'
      : !hasBridge ? 'Link Home Assistant in Smart Home'
        : !sum.total ? 'Your bridge reports no lights'
          : sum.on.length ? `${sum.on.length} on in ${sum.rooms} ${sum.rooms === 1 ? 'room' : 'rooms'}` : 'Every light is off',
    bar: sum.brightness != null ? { fraction: sum.brightness / 100, colour: '#ffd9a0' } : undefined,
    // A row is a light that is on; tapping it switches that light off.
    rows: sum.on.slice(0, 4).map<FaceRow>((d) => ({
      key: d.id, leadKind: 'dot', dotOn: true, title: d.name, sub: d.roomName,
      value: d.control === 'toggle' ? 'On' : `${Math.round(d.value)}%`, valueTone: 'muted',
      onClick: inert ? undefined : () => setDeviceValue(d.id, 0),
    })),
    tail: sum.on.length && !inert ? (
      <button type="button" className="b-btn b-btn--card b-btn--row" onKeyDown={keep.onKeyDown} onClick={(e) => { e.stopPropagation(); for (const d of sum.on) setDeviceValue(d.id, 0); }}>
        All off
      </button>
    ) : undefined,
  };
  return <Card p={p} face={face} />;
}

/**
 * Front door: the door camera, the last motion its own sensors saw, and a
 * still frame on request. The frame is fetched from the hub when asked and
 * lives only as long as this card; nothing is polled or kept.
 */
export function FrontDoorWidget(p: WidgetProps) {
  const { snapshot, usable, loadHistory, cameraStill } = useSmartHome();
  const devices = useMemo(() => snapshot.rooms.flatMap((r) => r.devices), [snapshot.rooms]);
  const cam = pickDoorCamera(devices);
  const sensors = useMemo(() => (cam ? cameraSensors(cam, devices) : []), [cam, devices]);
  const sensorKey = sensors.map((s) => `${s.id}:${s.value}`).join('|');
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const now = useTick(30000, !!cam);
  const hasBridge = snapshot.bridgeState !== 'none';
  useEffect(() => {
    if (!usable || !hasBridge || !sensorKey) return;
    let on = true;
    loadHistory({ since: new Date(Date.now() - 7 * 86_400_000).toISOString(), limit: 200 })
      .then((h) => { if (on) setEvents(h.events); })
      .catch(() => { /* the card still says what the sensors say now */ });
    return () => { on = false; };
  }, [usable, hasBridge, sensorKey, loadHistory]);
  const line = cam ? cameraEventLine(lastMotion(sensors, events), now) : null;
  const inert = !usable || !cam || (hasBridge && snapshot.bridgeState !== 'connected');
  const face: Face = {
    label: 'Front door',
    meta: cam ? cam.name : snapshot.hub?.name ?? (usable ? 'No hub' : 'Mac app only'),
    value: cam ? (cam.available ? 'Camera' : 'Offline') : '—',
    sub: !usable ? 'Smart home runs in the Mac app'
      : !hasBridge ? 'Link Home Assistant in Smart Home'
        : !cam ? 'Your bridge reports no camera'
          : line ?? (sensors.length ? 'No motion seen this week' : 'No motion sensor on this camera'),
    bleed: shot ? <img className="bw-sh-cam" src={shot} alt={cam ? `${cam.name}, still frame` : ''} /> : null,
    tail: cam ? (
      <span className="bw-sh-cam-row" {...keep}>
        <button
          type="button" className="b-btn b-btn--onink b-btn--row" disabled={inert || busy}
          onClick={(e) => {
            e.stopPropagation();
            setBusy(true);
            setErr(null);
            cameraStill(cam.id)
              .then((r) => setShot(r.dataUrl))
              .catch((x) => setErr(x instanceof Error ? x.message : String(x)))
              .finally(() => setBusy(false));
          }}
        >{busy ? 'Fetching…' : shot ? 'New still' : 'Show a still'}</button>
        {err ? <span className="bw-sh-cam-err">{err}</span> : null}
      </span>
    ) : undefined,
  };
  return <Card p={p} face={face} tone="ink" />;
}

// --- Transit (left-out row 20) -----------------------------------------------------

/** Every two minutes while Home is visible: a day of it stays well inside the access ID's monthly allowance. */
const TRANSIT_REFRESH_MS = 120_000;

/**
 * Rejseplanen departures from the user's stop. Dormant until an access ID is
 * in the Keychain and a stop is chosen, and the face says which is missing;
 * opening it goes to the Answer screen's board, where both are set up.
 */
export function TransitWidget(p: WidgetProps) {
  const transit = useTransit();
  const navigate = useBetaNavigate();
  const { status, stop, departures } = transit;
  const [deps, setDeps] = useState<Departure[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = status === 'ready' && !!stop && !p.preview;
  // The countdowns are the only thing that moves, so a dormant card does not tick.
  const now = useTick(30000, live);

  useEffect(() => {
    if (!live || !stop) return;
    let alive = true;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      departures(stop)
        .then((list) => { if (alive) { setDeps(list); setError(null); } })
        .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Rejseplanen did not answer.'); });
    };
    load();
    const id = window.setInterval(load, TRANSIT_REFRESH_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [live, stop, departures]);

  const upcoming = (deps ?? []).filter((d) => d.at >= now - 60_000);
  const next = upcoming.find((d) => !d.cancelled) ?? null;
  const open = p.open ? () => navigate('/answer', { state: { departures: true } }) : undefined;
  const face: Face = status !== 'ready' || !stop
    ? {
        label: 'Transit',
        meta: status === 'unavailable' ? 'Mac app only' : status === 'needs-key' ? 'Not connected' : 'Rejseplanen',
        value: '—',
        sub: status === 'unavailable'
          ? 'Departures come through the Atlas app on your Mac'
          : status === 'needs-key'
            ? 'Add a Rejseplanen access ID. Open this card to set it up.'
            : status === 'ready' ? 'Choose your stop. Open this card to pick one.' : 'Checking Rejseplanen…',
      }
    : {
        label: 'Transit',
        meta: stop.name,
        value: next ? next.expected : '—',
        delta: next ? countdown(next, new Date(now)) : undefined,
        deltaTone: next && next.delayMin > 0 ? 'down' : 'blue',
        // A preview never asks Rejseplanen, so it must not say it is asking.
        sub: error ?? (next ? `${next.line}${next.direction ? ` → ${next.direction}` : ''}` : deps ? 'Nothing leaves in the next two hours' : p.preview ? 'Live departures from Rejseplanen' : 'Asking Rejseplanen…'),
        rows: upcoming.filter((d) => d !== next).slice(0, 3).map<FaceRow>((d) => ({
          key: d.key, lead: d.expected, title: d.line, sub: d.direction || undefined, value: departureNote(d), valueTone: d.cancelled || d.delayMin > 0 ? 'down' : 'muted', strike: d.cancelled,
        })),
      };
  return <Card p={{ ...p, open }} face={face} />;
}

// --- Not wired yet -----------------------------------------------------------------

export function UnwiredWidget(p: WidgetProps & { id: string }) {
  const def = WIDGET_BY_ID.get(p.id);
  const face: Face = {
    label: def?.label ?? p.id,
    meta: 'Not wired',
    value: '—',
    sub: def?.meta ?? 'No source yet',
  };
  return <Card p={p} face={face} tone="linen" />;
}

// --- Developer widgets (admin edition; left-out features, F13) ---------------------

/**
 * Pull requests and Deploys read GitHub through the brain and exist only in
 * the admin edition. The literal comparison folds when Vite builds, so a
 * consumer build has neither the import nor its chunk (editionSplit.test.ts
 * checks for their strings), the same way betaHome.ts drops their definitions.
 */
const DevWidget = import.meta.env.VITE_ATLAS_EDITION === 'consumer' ? null : lazy(() => import('./devWidgets'));

const DEV_BY_ID: Record<string, (p: WidgetProps) => JSX.Element> = DevWidget
  ? Object.fromEntries(['pullrequests', 'deploys'].map((id) => [id, (p: WidgetProps) => (
    <Suspense fallback={<WidgetFace label={WIDGET_BY_ID.get(id)?.label ?? id} size={p.size} delay={p.delay} tone={p.forceTone} preview="loading" />}>
      <DevWidget id={id} {...p} />
    </Suspense>
  )]))
  : {};

const BY_ID: Record<string, (p: WidgetProps) => JSX.Element> = {
  ...DEV_BY_ID,
  weather: WeatherWidget,
  today: TodayWidget,
  tasks: TasksWidget,
  inbox: InboxWidget,
  watch: WatchWidget,
  briefing: BriefingWidget,
  air: AirWidget,
  clock: ClockWidget,
  dials: DialsWidget,
  countdown: CountdownWidget,
  music: MusicWidget,
  podcast: PodcastWidget,
  activity: ActivityWidget,
  steps: StepsWidget,
  sleep: SleepWidget,
  home: HomeKitWidget,
  upnext: UpNextWidget,
  fx: CurrencyWidget,
  focus: FocusWidget,
  lamp: LampWidget,
  lights: LightsWidget,
  bulb: BulbWidget,
  floorlamp: FloorLampWidget,
  frontdoor: FrontDoorWidget,
  transit: TransitWidget,
  // The Money faces exist only where /money does, like their WIDGETS entries
  // (betaHome.ts moneyWidgets). The direct comparison is what Vite folds, so a
  // consumer bundle drops these faces and, with them, useBank and its bank_*
  // commands — not listing a widget is not the same as not shipping it.
  ...(import.meta.env.VITE_ATLAS_EDITION === 'consumer' ? {} : {
    spend: SpendWidget,
    budget: BudgetWidget,
    subscriptions: SubscriptionsWidget,
  }),
};

export function HomeWidget({ id, ...p }: WidgetProps & { id: string }) {
  const W = BY_ID[id];
  return W ? <W {...p} /> : <UnwiredWidget {...p} id={id} />;
}
