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
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  SWATCHES, cameraEventLine, cameraSensors, colourName, lastMotion, lightsSummary, pickDoorCamera, pickLight, powerValue,
  type HistoryEvent, type LightWidget,
} from '@/lib/betaSmartHome';
import '@/styles/beta/smartHome.css';

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
  lamp: LampWidget,
  lights: LightsWidget,
  bulb: BulbWidget,
  floorlamp: FloorLampWidget,
  frontdoor: FrontDoorWidget,
};

export function HomeWidget({ id, ...p }: WidgetProps & { id: string }) {
  const W = BY_ID[id];
  return W ? <W {...p} /> : <UnwiredWidget {...p} id={id} />;
}
