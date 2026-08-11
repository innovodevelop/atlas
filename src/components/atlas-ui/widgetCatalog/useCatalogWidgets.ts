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
import { isWindowActive } from '@/hooks/useWindowActivity';
import { cityTimes as worldCityTimes } from '@/lib/worldClock';
import { fmtEventTime, fmtPct, WATCHLIST } from '@/pages/atlas/atlasHelpers';

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
 *   fallback    the source failed and the card is drawing the module's built-in
 *               sample — populated, and not real
 *   stale       the source failed, but an earlier answer is still on screen
 *   empty       the source answered and had nothing
 *   nosource    there is no source connected to answer
 *   unmeasured  nothing measures this at all (Activity)
 *
 * `fallback` is not a hypothetical: `useWeather` returns `snap.data ??
 * fallbackData`, so a first fetch that never lands draws "68°, San Francisco"
 * with nothing on the card admitting it is canned. The catalog says so.
 *
 * `stale` EXISTS BECAUSE THIS COMMENT WAS ONCE WRONG. Before the shared-store
 * port (audit R2), every one of these hooks swapped its built-in sample in on
 * ANY error, so `error != null` really did mean "you are looking at canned
 * data" and the catalog said exactly that. The store now keeps the last good
 * reading across a failed refresh — strictly better behaviour — which silently
 * turned this file into a liar: it labelled genuine, merely-stale numbers as a
 * built-in sample. The distinction is therefore drawn from what is ACTUALLY on
 * screen (did any real data ever arrive?) rather than from the error flag
 * alone, because the error flag no longer answers that question.
 */

export type CatalogStatus = 'live' | 'fallback' | 'stale' | 'empty' | 'nosource' | 'unmeasured';

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

// WATCHLIST and the world-clock cities/times are shared constants now (see
// atlasHelpers.ts and src/lib/worldClock.ts) — this catalog used to keep its
// own copies of both, silently drifting from the dashboard cards it exists
// to preview. `catalogCityTimes` only reshapes worldClock's row shape into
// this file's generic `{label, value}` WidgetRow.
function catalogCityTimes(): WidgetRow[] {
  return worldCityTimes().map(({ city, time }) => ({ label: city, value: time }));
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
  const { weather, error: weatherError, isFallback: weatherFallback } = useWeather();
  const { events } = useCalendarEvents();
  const { tasks, completedCount, progress } = useTasks();
  const { stocks, error: stocksError, isFallback: stocksFallback } = useStocks(WATCHLIST);
  const portfolio = usePortfolio();
  const { news, error: newsError, isFallback: newsFallback } = useNews();
  const mail = useMailIntelligence();
  const music = useMusicPlayer();

  // The clock is the one widget whose value changes without a fetch. Same
  // 30s tick the shipped card uses, gated the same way (isWindowActive — a
  // hidden catalog preview shouldn't keep ticking either).
  const [clock, setClock] = useState<WidgetRow[]>(catalogCityTimes);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (isWindowActive()) setClock(catalogCityTimes());
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const portfolioLive = portfolio.available && portfolio.connected && portfolio.summary != null;

  return useMemo<Record<string, WidgetData>>(() => {
    // --- Weather -----------------------------------------------------------
    const weatherData: WidgetData = {
      status: weatherFallback ? 'fallback' : weatherError ? 'stale' : 'live',
      value: `${Math.round(weather.temp)}°`,
      delta: weather.condition,
      caption: weather.high != null && weather.low != null
        ? `${weather.location} · H ${weather.high}° L ${weather.low}°`
        : weather.location,
      note: weatherFallback ? 'Built-in sample — get-weather did not answer.'
        : weatherError ? 'Last good reading — get-weather did not answer on the latest refresh.'
          : undefined,
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
        status: weatherFallback ? 'fallback' : weatherError ? 'stale' : 'live',
        value: `${Math.round(air.pm25)}`,
        caption: `PM2.5 µg/m³ · band ${air.aqi} of 5`,
        pct: (air.aqi / 5) * 100,
        note: weatherFallback ? 'Built-in sample — get-weather did not answer.'
        : weatherError ? 'Last good reading — get-weather did not answer on the latest refresh.'
          : undefined,
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
        status: stocksFallback ? 'fallback' : stocksError ? 'stale' : 'live',
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
        note: stocksFallback ? 'Built-in sample — get-stocks did not answer.'
        : stocksError ? 'Last good reading — get-stocks did not answer on the latest refresh.'
          : undefined,
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
        status: newsFallback ? 'fallback' : newsError ? 'stale' : 'live',
        value: `${news.length}`,
        caption: news.length === 1 ? 'story' : 'stories',
        rows: news.slice(0, 3).map((n) => ({ label: n.title, value: n.source })),
        note: newsFallback ? 'Built-in sample — get-news did not answer.'
        : newsError ? 'Last good reading — get-news did not answer on the latest refresh.'
          : undefined,
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
