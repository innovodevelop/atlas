import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useTasks } from '@/hooks/useTasks';
import { useStocks } from '@/hooks/useStocks';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useNews } from '@/hooks/useNews';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { fmtEventTime, fmtPct } from '@/pages/atlas/atlasHelpers';

/**
 * The catalog's data layer.
 *
 * The catalog previews REAL widgets, so it reads REAL data — the same hooks the
 * dashboard cards read, in the same order. Nothing on this surface is a mock;
 * `surface.mock` is false and there is no module under `src/lib/mocks/`.
 *
 * The interesting part is `status`, which is the thing a widget catalog is
 * uniquely placed to tell you and the dashboard never does:
 *
 *   live        the numbers on screen came from the source
 *   fallback    the source failed and `useDataFetching` swapped in the module's
 *               built-in sample — the card still looks populated and is not
 *   empty       the source answered and had nothing
 *   nosource    there is no source connected to answer
 *   unmeasured  nothing measures this at all (Activity)
 *
 * `fallback` is not a hypothetical. `useWeather`, `useStocks` and `useNews` all
 * pass `fallbackData` to `useDataFetching`, which sets it on any error. So a
 * dead network draws "68°, San Francisco" on the dashboard with no indication
 * that it is canned. The catalog reads the same `error` flag and says so.
 */

export type CatalogStatus = 'live' | 'fallback' | 'empty' | 'nosource' | 'unmeasured';

export interface WidgetRow { label: string; value: string }

export interface WidgetData {
  status: CatalogStatus;
  /** Headline figure. */
  value?: string;
  /** The small qualifier beside the headline. */
  delta?: string;
  caption?: string;
  rows?: WidgetRow[];
  /** 0–100. */
  pct?: number;
  /** Shown when the status is not `live`, in place of nothing. */
  note?: string;
}

/** Mirrors the constant in AtlasCards.tsx, which does not export it. */
const WATCHLIST = ['AAPL', 'GOOGL', 'MSFT', 'NVDA'];

/** Mirrors the constant in AtlasExtraCards.tsx, which does not export it. */
const CITIES = [
  { city: 'San Francisco', tz: 'America/Los_Angeles' },
  { city: 'London', tz: 'Europe/London' },
  { city: 'Tokyo', tz: 'Asia/Tokyo' },
] as const;

function cityTimes(): WidgetRow[] {
  const now = new Date();
  return CITIES.map(({ city, tz }) => ({
    label: city,
    value: now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }),
  }));
}

const senderName = (from: string | null) =>
  (from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || 'Unknown';

const mailTime = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return Date.now() - d.getTime() < 24 * 60 * 60 * 1000
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export function useCatalogWidgets(): Record<string, WidgetData> {
  const { user } = useAuth();
  const { weather, error: weatherError } = useWeather();
  const { events } = useCalendarEvents();
  const { tasks, completedCount, progress } = useTasks();
  const { stocks, error: stocksError } = useStocks(WATCHLIST);
  const portfolio = usePortfolio();
  const { news, error: newsError } = useNews();
  const mail = useMailIntelligence();
  const music = useMusicPlayer();

  // The clock is the one widget whose value changes without a fetch. Same
  // 30s tick the shipped card uses.
  const [clock, setClock] = useState<WidgetRow[]>(cityTimes);
  useEffect(() => {
    const id = window.setInterval(() => setClock(cityTimes()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const portfolioLive = portfolio.available && portfolio.connected && portfolio.summary != null;

  return useMemo<Record<string, WidgetData>>(() => {
    // --- Weather -----------------------------------------------------------
    const weatherData: WidgetData = {
      status: weatherError ? 'fallback' : 'live',
      value: `${Math.round(weather.temp)}°`,
      delta: weather.condition,
      caption: weather.high != null && weather.low != null
        ? `${weather.location} · H ${weather.high}° L ${weather.low}°`
        : weather.location,
      note: weatherError ? 'Built-in sample — get-weather did not answer.' : undefined,
    };

    // --- Air quality -------------------------------------------------------
    // The shipped card converts PM2.5 to a US EPA AQI with a piecewise curve it
    // keeps to itself. The catalog shows the two numbers OpenWeather actually
    // returns instead of re-deriving a third one here.
    const air = weather.air;
    const airData: WidgetData = air == null
      // Not `fallback`: the built-in weather sample carries no `air` block at
      // all, so when the call fails this widget has nothing to draw — which is
      // `nosource`, not a canned value. Marking it fallback rendered a headline
      // with no number in it and a progress bar at zero.
      ? {
        status: weatherError ? 'nosource' : 'empty',
        note: weatherError ? 'get-weather did not answer.' : undefined,
      }
      : {
        status: weatherError ? 'fallback' : 'live',
        value: `${Math.round(air.pm25)}`,
        caption: `PM2.5 µg/m³ · band ${air.aqi} of 5`,
        pct: (air.aqi / 5) * 100,
        note: weatherError ? 'Built-in sample — get-weather did not answer.' : undefined,
      };

    // --- Today -------------------------------------------------------------
    const calendarData: WidgetData = !user
      ? { status: 'nosource' }
      : events.length === 0
        ? { status: 'empty' }
        : {
          status: 'live',
          value: `${events.length} ${events.length === 1 ? 'event' : 'events'}`,
          caption: `Next at ${fmtEventTime(events[0].start_time)}`,
          rows: events.slice(0, 3).map((e) => ({
            label: e.title,
            value: fmtEventTime(e.start_time),
          })),
        };

    // --- Tasks -------------------------------------------------------------
    const tasksData: WidgetData = !user
      ? { status: 'nosource' }
      : tasks.length === 0
        ? { status: 'empty' }
        : {
          status: 'live',
          value: `${completedCount}/${tasks.length}`,
          caption: 'complete',
          pct: progress,
        };

    // --- Watchlist ---------------------------------------------------------
    const heroPct = portfolioLive
      ? (portfolio.summary?.unrealized_pct ?? 0)
      : stocks.length > 0
        ? stocks.reduce((n, s) => n + s.changePercent, 0) / stocks.length
        : 0;
    const stocksData: WidgetData = stocks.length === 0 && !portfolioLive
      ? {
        status: stocksError ? 'nosource' : 'empty',
        note: stocksError ? 'get-stocks did not answer.' : undefined,
      }
      : {
        status: stocksError ? 'fallback' : 'live',
        value: portfolioLive
          ? `$${Math.round(portfolio.summary?.total_value ?? 0).toLocaleString('en-US')}`
          : fmtPct(heroPct),
        delta: portfolioLive ? fmtPct(heroPct) : undefined,
        caption: portfolioLive
          ? `${portfolio.summary?.holdings_count ?? 0} holdings live`
          : `${stocks.length} tickers watched`,
        rows: stocks.slice(0, 3).map((s) => ({
          label: s.symbol,
          value: fmtPct(s.changePercent),
        })),
        note: stocksError ? 'Built-in sample — get-stocks did not answer.' : undefined,
      };

    // --- Mail --------------------------------------------------------------
    const mailData: WidgetData = !mail.isConnected
      ? { status: 'nosource' }
      : mail.messages.length === 0
        ? { status: 'empty' }
        : {
          status: 'live',
          value: `${mail.alerts.length}`,
          caption: `${mail.alerts.length === 1 ? 'alert' : 'alerts'} · ${mail.messages.length} scanned`,
          rows: mail.messages.slice(0, 3).map((m) => ({
            label: senderName(m.from_address),
            value: mailTime(m.received_at),
          })),
        };

    // --- Briefing ----------------------------------------------------------
    const briefingData: WidgetData = news.length === 0
      ? {
        status: newsError ? 'nosource' : 'empty',
        note: newsError ? 'get-news did not answer.' : undefined,
      }
      : {
        status: newsError ? 'fallback' : 'live',
        value: `${news.length}`,
        caption: news.length === 1 ? 'story' : 'stories',
        rows: news.slice(0, 3).map((n) => ({ label: n.title, value: n.source })),
        note: newsError ? 'Built-in sample — get-news did not answer.' : undefined,
      };

    // --- Now playing -------------------------------------------------------
    const track = music.nowPlaying?.track ?? null;
    const musicData: WidgetData = !music.available
      ? { status: 'nosource', note: 'Playback is a desktop-app capability; this build has no Tauri backend.' }
      : !music.connected
        ? { status: 'nosource' }
        : !track
          ? { status: 'empty' }
          : {
            status: 'live',
            value: track.title,
            caption: track.artist,
            pct: track.durationMs
              ? Math.min(100, ((music.nowPlaying?.positionMs ?? 0) / track.durationMs) * 100)
              : 0,
          };

    // --- Activity ----------------------------------------------------------
    // Not `empty` and not `nosource`: nothing measures this. The dashboard card
    // draws 520/650 cal, 38/60 min and 9/12 hr from three literals in
    // AtlasExtraCards.tsx. The catalog is where that gets said out loud.
    const activityData: WidgetData = {
      status: 'unmeasured',
      note: 'The dashboard card renders hardcoded demo values.',
    };

    // --- World clock -------------------------------------------------------
    const clockData: WidgetData = {
      status: 'live',
      value: clock[0]?.value ?? '',
      caption: `${clock.length} cities`,
      rows: clock,
    };

    return {
      weather: weatherData,
      air: airData,
      calendar: calendarData,
      tasks: tasksData,
      stocks: stocksData,
      mail: mailData,
      briefing: briefingData,
      music: musicData,
      activity: activityData,
      worldclock: clockData,
    };
  }, [
    user, weather, weatherError, events, tasks, completedCount, progress,
    stocks, stocksError, portfolioLive, portfolio.summary, news, newsError,
    mail.isConnected, mail.messages, mail.alerts,
    music.available, music.connected, music.nowPlaying, clock,
  ]);
}
