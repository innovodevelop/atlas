import { memo, useEffect, useRef } from 'react';
import {
  CloudSun, Calendar, Check, Activity, Mail, Newspaper,
  Droplets, Wind, Sun, Sunrise, Sunset,
} from 'lucide-react';
import { WeatherIcon } from './atlasIcons';
import { sparklinePoints, fmtPct, fmtEventTime, WATCHLIST } from '@/pages/atlas/atlasHelpers';
import { startWxCanvas, presetFor } from '@/lib/wxAtmosphere';
import { Card, Row, Empty } from './primitives';
import { useWindowActivity } from '@/hooks/useWindowActivity';
import { useWeather } from '@/hooks/useWeather';
import { useStocks } from '@/hooks/useStocks';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useNews } from '@/hooks/useNews';
import { useTasks } from '@/hooks/useTasks';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';

// Each card faithfully reproduces the Atlas design's card face, wired to the
// real data hooks. Card chrome comes from the <Card> primitive; list rows come
// from <Row>. Neither has a `last` modifier any more — the borderless rule
// deleted the divider, so the last row stopped being a special case and the
// `i === rows.length - 1 ? 'last' : ''` ternaries went with it.

/** Masked weather-atmosphere canvas behind the weather card's content
    (design .wxbg — the card content sits at z-index:2 via .wxcard rules). */
const WeatherCardCanvas = memo(({ condition }: { condition: string }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const conditionRef = useRef(condition);
  conditionRef.current = condition;
  const active = useWindowActivity();
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frozen = false;
    const handle = startWxCanvas(
      el,
      () => presetFor(conditionRef.current),
      () => {
        if (reduced) { if (frozen) return true; frozen = true; return false; }
        return !activeRef.current;
      },
    );
    return () => handle.stop();
  }, []);
  return <canvas ref={ref} className="wxbg" aria-hidden />;
});
WeatherCardCanvas.displayName = 'WeatherCardCanvas';

export const AtlasWeatherCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { weather } = useWeather();
  const hourly = weather.hourly.slice(0, 6);
  return (
    <Card size="l" delay={1} className="wxcard" onOpen={onOpen}
      bleed={<WeatherCardCanvas condition={weather.condition} />}>
      <Card.Header label="Weather" icon={<CloudSun className="i14" />} />
      <Card.Body>
        <p className="tempB tnum">{Math.round(weather.temp)}°</p>
        <p className="condB">
          {weather.condition} · {weather.location}
          {weather.high != null && weather.low != null && (
            <span className="tnum" style={{ marginLeft: 8, color: 'var(--ink3)' }}>H {weather.high}° · L {weather.low}°</span>
          )}
        </p>
        <div className="fx ac gap16 mt16 metaB">
          <span className="fx ac" style={{ gap: 6 }}><Droplets className="i12" />{weather.humidity}%</span>
          <span className="fx ac" style={{ gap: 6 }}><Wind className="i12" />{Math.round(weather.windSpeed)} mph</span>
          <span className="fx ac" style={{ gap: 6 }}><Sun className="i12" />UV 6</span>
        </div>
        <hr className="hrB" />
        <div className="fx">
          {hourly.map((h, i) => (
            <div className="hcolB" key={i}>
              <span className={`htB ${i === 0 ? 'iInd' : ''}`}>{h.time}</span>
              <WeatherIcon icon={h.icon} className={`i16 ${i === 0 ? 'iInd' : 'iMut'}`} />
              <span className="hvB tnum">{Math.round(h.temp)}°</span>
            </div>
          ))}
        </div>
        <hr className="hrB" />
        <div className="fx ac jb metaB">
          <span className="fx ac" style={{ gap: 6 }}><Sunrise className="i12" />{weather.sunrise}</span>
          <span className="fx ac" style={{ gap: 6 }}><Sunset className="i12" />{weather.sunset}</span>
        </div>
      </Card.Body>
    </Card>
  );
});
AtlasWeatherCard.displayName = 'AtlasWeatherCard';

export const AtlasCalendarCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { events } = useCalendarEvents();
  const now = Date.now();
  const rows = events.slice(0, 4);
  // Mark the event closest to (but around) now as "Now"
  const nowIdx = rows.findIndex((e) => new Date(e.start_time).getTime() >= now);
  return (
    <Card size="l" delay={2} onOpen={onOpen}>
      <Card.Header label="Today" icon={<Calendar className="i14" />} />
      <Card.Body>
        {rows.length === 0 && <p className="condB">No events today</p>}
        {rows.map((e, i) => (
          <Row
            key={e.id ?? i}
            lead={
              <span className="fx ac gap12">
                <span className={`dotB ${i === nowIdx ? 'on' : ''}`} />
                <span className="tnum">{fmtEventTime(e.start_time)}</span>
              </span>
            }
            leadWidth={94}
            title={e.title}
            meta={e.location || undefined}
            trail={i === nowIdx ? <span className="nowB">Now</span> : undefined}
          />
        ))}
      </Card.Body>
    </Card>
  );
});
AtlasCalendarCard.displayName = 'AtlasCalendarCard';

export const AtlasTasksCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { tasks, completedCount, progress } = useTasks();
  const rows = tasks.slice(0, 5);
  const pct = Math.round(progress || 0);
  return (
    <Card size="l" delay={3} onOpen={onOpen}>
      <Card.Header label={`Tasks · ${completedCount} of ${tasks.length}`} icon={<Check className="i14" />} />
      <Card.Body>
        {tasks.length > 0 && (
          <div style={{ margin: '4px 0 14px' }}>
            <div style={{ height: 6, borderRadius: 999, background: 'var(--sk)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: 'var(--acc)', transition: 'width .3s var(--ease-spring)' }} />
            </div>
          </div>
        )}
        {rows.map((t, i) => (
          <Row
            key={t.id ?? i}
            lead={
              <span className={`ckB ${t.completed ? 'done fx ac jc' : ''}`}>
                {t.completed && <Check className="i12" style={{ color: '#fff' }} />}
              </span>
            }
            title={<span className={t.completed ? 'doneB' : undefined}>{t.title}</span>}
          />
        ))}
      </Card.Body>
    </Card>
  );
});
AtlasTasksCard.displayName = 'AtlasTasksCard';

/** Area chart for the watchlist hero (design .stkchart geometry). */
const areaPath = (series: number[]) => {
  if (series.length < 2) return { area: '', line: '' };
  const min = Math.min(...series), max = Math.max(...series), span = max - min || 1;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * 600;
    const y = 74 - ((v - min) / span) * 62; // 12..74 inside the 82-high viewBox
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return { area: `M${pts.join(' L')} L600,82 L0,82 Z`, line: pts.join(' ') };
};

export const AtlasStocksCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { stocks, indices } = useStocks(WATCHLIST);
  const { available, connected, summary, history } = usePortfolio();
  const rows = stocks.slice(0, 4);

  // Hero value: real SnapTrade portfolio when linked; otherwise an aggregate
  // watchlist view so the card still leads with a number.
  const usePortfolioHero = available && connected && summary != null;
  const heroValue = usePortfolioHero
    ? summary.total_value
    : rows.reduce((n, s) => n + s.price, 0);
  const heroChangePct = usePortfolioHero
    ? (summary.unrealized_pct ?? 0)
    : rows.length > 0
      ? rows.reduce((n, s) => n + s.changePercent, 0) / rows.length
      : 0;
  const heroUp = heroChangePct >= 0;
  const heroSeries = usePortfolioHero && history.length > 1
    ? history.map((h) => h.value)
    : rows[0]?.sparkline ?? [];
  const { area, line } = areaPath(heroSeries);
  const chartColor = heroUp ? '#2f7d4f' : '#c14a35';

  return (
    <Card size="xl" delay={4} onOpen={onOpen}>
      <Card.Header label="Watchlist · Market open" icon={<Activity className="i14" />} />
      <Card.Body>
        <div className="stkhero">
          <div>
            <p className="stkval tnum m0">
              ${heroValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </p>
            <p className="stksub m0">
              <span className={heroUp ? 'upB' : 'dnB'} style={{ fontWeight: 600 }}>{fmtPct(heroChangePct)}</span>
              {' '}{usePortfolioHero ? `overall · ${summary.holdings_count} holding${summary.holdings_count === 1 ? '' : 's'} live` : `today · ${rows.length} tickers watched`}
            </p>
          </div>
          {indices.length > 0 && (
            <div className="idxchips">
              {indices.map((ix) => (
                <span className={`idxchip ${ix.changePercent >= 0 ? 'upB' : 'dnB'}`} key={ix.label}>
                  {ix.label} {fmtPct(ix.changePercent)}
                </span>
              ))}
            </div>
          )}
        </div>
        {line && (
          <svg className="stkchart" viewBox="0 0 600 82" preserveAspectRatio="none">
            <defs>
              <linearGradient id="stkgrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={chartColor} stopOpacity="0.26" />
                <stop offset="1" stopColor={chartColor} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#stkgrad)" />
            <polyline points={line} fill="none" stroke={chartColor} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        {rows.map((s) => {
          const up = s.changePercent >= 0;
          // An illustration stroke, not an element border — these survive the
          // borderless pass by definition (README §1.1).
          const stroke = up ? 'var(--grn)' : 'var(--red)';
          return (
            <Row
              key={s.symbol}
              lead={<span className="symB">{s.symbol}</span>}
              leadWidth={64}
              title={s.name}
              tone="muted"
              trail={
                <>
                  <svg width="72" height="22"><polyline points={sparklinePoints(s.sparkline)} fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
                  <span className="prcB" style={{ width: 76, textAlign: 'right' }}>{s.price.toFixed(2)}</span>
                  <span className={`chgB ${up ? 'upB' : 'dnB'}`}>{fmtPct(s.changePercent)}</span>
                </>
              }
            />
          );
        })}
      </Card.Body>
    </Card>
  );
});
AtlasStocksCard.displayName = 'AtlasStocksCard';

const senderName = (from: string | null) => (from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || 'Unknown';
const senderInitials = (from: string | null) => {
  const parts = senderName(from).split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
};
const mailTime = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Date.now() - d.getTime() < 24 * 60 * 60 * 1000
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export const AtlasInboxCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { messages, alerts, isConnected, isLoading } = useMailIntelligence();
  const rows = messages.slice(0, 4);
  return (
    <Card size="l" delay={5} onOpen={onOpen}>
      <Card.Header
        label={isConnected ? `Mail · ${alerts.length} alert${alerts.length === 1 ? '' : 's'}` : 'Mail'}
        icon={<Mail className="i14" />}
      />
      <Card.Body>
        {!isConnected && !isLoading && (
          <Empty
            size="block"
            icon={<Mail className="i20" />}
            title="No mailbox connected"
            body="Open to connect Gmail — Atlas scans read-only and alerts you to bills and deadlines."
          />
        )}
        {isConnected && rows.length === 0 && <p className="condB">Scanning your inbox…</p>}
        {rows.map((m) => {
          const hot = m.category === 'bills' || m.importance >= 0.7;
          return (
            <Row
              key={m.id}
              lead={<span className="avB2 fx ac jc">{senderInitials(m.from_address)}</span>}
              tone={hot ? 'default' : 'muted'}
              title={
                <span className="fx ac gap8">
                  {hot && <span className="dotB on" style={{ width: 6, height: 6 }} />}
                  <span className="trunc">{senderName(m.from_address)}</span>
                </span>
              }
              meta={m.subject}
              trail={<span className="tmB">{mailTime(m.received_at)}</span>}
            />
          );
        })}
      </Card.Body>
    </Card>
  );
});
AtlasInboxCard.displayName = 'AtlasInboxCard';

export const AtlasBriefingCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { news } = useNews();
  const rows = news.slice(0, 3);
  return (
    <Card size="l" delay={6} onOpen={onOpen}>
      <Card.Header label="Briefing" icon={<Newspaper className="i14" />} />
      <Card.Body>
        {/* Not a <Row>: a briefing item is a stacked editorial block, not a
            lead/title/trail line, and forcing it through the row slots would
            flatten the kicker/headline/source hierarchy. */}
        {rows.map((n, i) => (
          <div className="row0" style={{ display: 'block' }} key={n.id ?? i}>
            <span className="ntagB">{n.category}</span>
            <h4 className="ntB">{n.title}</h4>
            <span className="nmB">{n.source} · {n.time}</span>
          </div>
        ))}
      </Card.Body>
    </Card>
  );
});
AtlasBriefingCard.displayName = 'AtlasBriefingCard';
