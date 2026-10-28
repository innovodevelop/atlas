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
 */
import { useEffect, useMemo, useState } from 'react';
import { WidgetFace, type FacePreview, type FacePreviewCopy, type FaceProps, type FaceRow, type FaceTone } from './WidgetFace';
import { AtlasIcon } from '../AtlasIcon';
import { WIDGET_BY_ID, type WidgetSize } from '@/lib/betaHome';
import {
  briefingAttention, inboxAttention, mailOffline, tasksAttention, todayAttention, watchAttention, weatherAttention,
  type AttentionCopy,
} from '@/lib/betaWidgetCatalog';
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
import { cityTimes } from '@/lib/worldClock';
import { WATCHLIST, fmtPct } from '@/pages/atlas/atlasHelpers';
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
}

/** `previewCopy` here is the adapter's live part; the caller's copy fills what it leaves out. */
type Face = Omit<FaceProps, 'size' | 'delay' | 'onOpen' | 'preview'>;

function Card({ p, face, tone }: { p: WidgetProps; face: Face; tone?: FaceTone }) {
  const copy = p.preview
    ? {
        attention: face.previewCopy?.attention ?? p.previewCopy?.attention,
        empty: face.previewCopy?.empty ?? p.previewCopy?.empty,
        offline: face.previewCopy?.offline ?? p.previewCopy?.offline,
      }
    : undefined;
  return <WidgetFace {...face} tone={p.forceTone ?? tone ?? face.tone} size={p.size} delay={p.delay} onOpen={p.open} preview={p.preview} previewCopy={copy} />;
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
  const { weather, isFallback } = useWeather();
  const sunny = /sun|clear/i.test(weather.condition);
  const hourly = weather.hourly.slice(0, 4);
  const face: Face = {
    label: 'Weather',
    meta: weather.location,
    sample: isFallback ? 'Sample weather — no reading has arrived yet' : null,
    value: `${Math.round(weather.temp)}°`,
    delta: weather.high != null && weather.low != null ? `H ${Math.round(weather.high)}° L ${Math.round(weather.low)}°` : undefined,
    deltaTone: 'muted',
    sub: weather.condition,
    stats: hourly.map((h) => ({ t: h.time, s: `${Math.round(h.temp)}°` })),
    rows: (weather.daily ?? []).slice(0, 3).map<FaceRow>((d) => ({ key: d.day, lead: d.day, title: d.icon.replace(/-/g, ' '), value: `${Math.round(d.high)}° / ${Math.round(d.low)}°`, valueTone: 'ink' })),
    foot: [{ t: weather.sunrise, s: 'Sunrise' }, { t: weather.sunset, s: 'Sunset' }, { t: `${weather.humidity}%`, s: 'Humidity' }, { t: `${Math.round(weather.windSpeed)}`, s: 'Wind' }],
    bleed: sunny ? <span className="bw-glow" /> : null,
    previewCopy: p.preview ? { attention: attentionRow(weatherAttention(hourly)) } : undefined,
  };
  return <Card p={p} face={face} tone="sky" />;
}

export function TodayWidget(p: WidgetProps) {
  const { events } = useCalendarEvents();
  const now = useTick(30000);
  const todays = todaysEvents(events, now);
  const focus = focusEvent(todays, now);
  const then = thenEvents(todays, focus);
  const face: Face = {
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
  const { tasks, completedCount, toggleTask, addTask } = useTasks();
  const [draft, setDraft] = useState('');
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
  };
  return <Card p={p} face={face} />;
}

// --- Communication -----------------------------------------------------------------

const initials = (addr: string | null): string => {
  const name = (addr ?? '?').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return name.split(' ').slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
};

export function InboxWidget(p: WidgetProps) {
  const { messages, alerts, accounts, isConnected } = useMailIntelligence();
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
  };
  return <Card p={p} face={face} />;
}

export function BriefingWidget(p: WidgetProps) {
  const { news, isFallback } = useNews();
  const lead = news[0];
  const face: Face = {
    label: 'Briefing',
    meta: lead ? `${news.length} headlines` : 'Fetching…',
    sample: isFallback ? 'Sample headlines — the news feed has not answered yet' : null,
    children: lead ? (
      <span className="bw-lede"><span className="bw-lede-t">{lead.title}</span><span className="bw-lede-s">{lead.source} · {lead.time}</span></span>
    ) : <span className="bw-lede"><span className="bw-lede-s">No headlines yet.</span></span>,
    rows: news.slice(1, 4).map<FaceRow>((n) => ({ key: n.id, leadKind: 'dot', dotOn: n.trending, title: n.title, sub: n.source })),
    previewCopy: p.preview ? { attention: attentionRow(briefingAttention(news)) } : undefined,
  };
  return <Card p={p} face={face} tone="linen" />;
}

// --- Money -------------------------------------------------------------------------

export function WatchWidget(p: WidgetProps) {
  const { stocks, indices, isFallback } = useStocks(WATCHLIST);
  const portfolio = usePortfolio();
  const summary = portfolio.connected ? portfolio.summary : null;
  const first = stocks[0];
  const toneOf = (v: number): FaceRow['valueTone'] => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
  const face: Face = {
    label: 'Watchlist',
    meta: summary ? 'Portfolio' : indices[0] ? `${indices[0].label} ${fmtPct(indices[0].changePercent)}` : 'Markets',
    sample: isFallback ? 'Sample quotes — the market feed has not answered yet' : null,
    value: summary ? money(summary.total_value, summary.currency) : first ? first.price.toFixed(2) : '—',
    delta: summary ? fmtPct(summary.unrealized_pct) : first ? fmtPct(first.changePercent) : undefined,
    deltaTone: summary ? (summary.unrealized_pct >= 0 ? 'up' : 'down') : first ? (first.changePercent >= 0 ? 'up' : 'down') : 'muted',
    sub: summary ? `${summary.holdings_count} holdings` : first ? first.name : 'No tickers yet',
    spark: first?.sparkline?.length ? first.sparkline : undefined,
    sparkColour: first && first.changePercent < 0 ? 'var(--b-red)' : 'var(--b-green-deep)',
    rows: stocks.slice(0, p.size === 'XL' ? 4 : 3).map<FaceRow>((s) => ({
      key: s.symbol, lead: s.symbol, title: s.name, value: s.price.toFixed(2), valueTone: toneOf(s.changePercent), sub: fmtPct(s.changePercent),
    })),
    kv: indices.slice(0, 4).map((i) => ({ t: fmtPct(i.changePercent), s: i.label, c: i.changePercent >= 0 ? 'var(--b-green-deep)' : 'var(--b-red-deep)' })),
    previewCopy: p.preview ? { attention: attentionRow(watchAttention(stocks)) } : undefined,
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

export function ClockWidget(p: WidgetProps) {
  useTick(15000);
  const rows = cityTimes();
  const first = rows[0];
  const face: Face = {
    label: 'Elsewhere',
    meta: `${rows.length} cities`,
    value: first?.time ?? '—',
    sub: first ? `${first.city} · ${first.rel}` : undefined,
    rows: rows.map<FaceRow>((r) => ({ key: r.city, lead: r.time, title: r.city, value: r.rel, valueTone: 'muted' })),
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
  music: MusicWidget,
  activity: ActivityWidget,
  steps: StepsWidget,
  sleep: SleepWidget,
  home: HomeKitWidget,
};

export function HomeWidget({ id, ...p }: WidgetProps & { id: string }) {
  const W = BY_ID[id];
  return W ? <W {...p} /> : <UnwiredWidget {...p} id={id} />;
}
