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
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
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
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { useSmartHome } from '@/hooks/useSmartHome';
import { useHealth } from '@/hooks/useHealth';
import { systemZone } from '@/lib/betaClock';
import { useClockPrefs } from '@/lib/betaClockStore';
// The dial faces' rules live with the Clock's; the ringing dialog that also
// loads this file is lazy, so Home must not count on it having arrived.
import '@/styles/beta/clock.css';
import { citiesMeta, countdownFace, countdownTickMs, dialCount, dials, elsewhere } from '@/lib/betaClockWidgets';
import { fmtPct } from '@/pages/atlas/atlasHelpers';
import { eventTime, focusEvent, focusIn, thenEvents, todaysEvents } from '@/lib/stageFocus';

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

export function MusicWidget(p: WidgetProps) {
  const music = useMusicPlayer();
  const np = music.nowPlaying;
  const playing = !!np?.isPlaying;
  const tick = useTick(1000, playing);
  const progress = np?.track?.durationMs ? Math.min(1, music.readPosition() / np.track.durationMs) : 0;
  void tick;
  const face: Face = {
    label: 'Now playing',
    meta: music.connected ? (np?.deviceName ?? 'Spotify') : music.available ? 'Not connected' : 'Mac app only',
    children: (
      <span className="bw-music">
        <span className="bw-art">{np?.track?.artUrl ? <img src={np.track.artUrl} alt="" /> : <AtlasIcon name="music" size={22} weight={1.6} />}</span>
        <span className="bw-music-text">
          <span className="bw-music-t">{np?.track?.title ?? (music.connected ? 'Nothing playing' : 'Connect Spotify')}</span>
          <span className="bw-music-s">{np?.track?.artist ?? (music.connected ? 'Pick something in Music' : 'Through the Music screen')}</span>
        </span>
        {music.connected ? (
          <span className="bw-music-ctl" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="flip" aria-label="Previous" onClick={() => void music.prev()}><AtlasIcon name="skip" size={16} /></button>
            <button type="button" className="main" aria-label={playing ? 'Pause' : 'Play'} onClick={() => void (playing ? music.pause() : music.play())}><AtlasIcon name={playing ? 'pause' : 'play'} size={16} /></button>
            <button type="button" aria-label="Next" onClick={() => void music.next()}><AtlasIcon name="skip" size={16} /></button>
          </span>
        ) : null}
      </span>
    ),
    bar: np?.track ? { fraction: progress, colour: 'var(--b-on-ink)' } : undefined,
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
  const thermostats = devices.filter((d) => d.kind === 'thermostat' && d.control === 'stepper');
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

const BY_ID: Record<string, (p: WidgetProps) => JSX.Element> = {
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
  activity: ActivityWidget,
  steps: StepsWidget,
  sleep: SleepWidget,
  home: HomeKitWidget,
  upnext: UpNextWidget,
  fx: CurrencyWidget,
  focus: FocusWidget,
};

export function HomeWidget({ id, ...p }: WidgetProps & { id: string }) {
  const W = BY_ID[id];
  return W ? <W {...p} /> : <UnwiredWidget {...p} id={id} />;
}
