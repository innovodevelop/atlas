import { useEffect, useMemo, useState } from 'react';
import { useWeather } from '@/hooks/useWeather';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useTasks } from '@/hooks/useTasks';
import { useStocks } from '@/hooks/useStocks';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { useNews } from '@/hooks/useNews';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { fmtPct, fmtEventTime } from './auroraHelpers';
import type { AuroraExpandedKey } from './AuroraDashboard';

// The greeting band narrates the focused widget (design Change 2). The title's
// last word is the accent; the subline and meta are data-driven from the real
// per-widget hooks (the README copy is the voice/format to match, not literals).

export interface BandContent {
  lead: string;
  accent: string;
  subline: string;
  metaBig: string;
  metaSmall: string;
}

const WATCH = ['AAPL', 'GOOGL', 'MSFT', 'NVDA', 'AMZN', 'META'];
const senderName = (from: string | null | undefined) =>
  (from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || 'Someone';

/**
 * @param focusedKey  the focused widget (null = home / dashboard)
 * @param home        home-state content (greeting + weather), owned by the page
 * @returns the content to render + a `swapping` flag driving the exit/enter swap
 */
export function useBandNarration(focusedKey: AuroraExpandedKey, home: BandContent) {
  const { weather } = useWeather();
  const { events } = useCalendarEvents();
  const { tasks, completedCount, progress } = useTasks();
  const { stocks } = useStocks(WATCH);
  const { messages, isConnected: mailConnected } = useMailIntelligence();
  const { news } = useNews();
  const { nowPlaying } = useMusicPlayer();

  const byKey = useMemo<Record<string, BandContent>>(() => {
    // Weather
    const t = Math.round(weather.temp);
    const hi = weather.high != null ? Math.round(weather.high) : null;
    const lo = weather.low != null ? Math.round(weather.low) : null;

    // Calendar
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayEvents = events.filter((e) => e.start_time?.slice(0, 10) === todayStr);
    const now = Date.now();
    const nextEvent = events.find((e) => new Date(e.start_time).getTime() >= now);

    // Tasks
    const pct = Math.round(progress || 0);
    const dueToday = tasks.filter((t2) => !t2.completed && t2.due_date?.slice(0, 10) === todayStr).length;
    const overdue = tasks.filter((t2) => !t2.completed && t2.due_date && t2.due_date.slice(0, 10) < todayStr).length;

    // Stocks — top mover by |%|
    const mover = [...stocks].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))[0];

    // Mail — important/unread
    const important = messages.filter((m) => m.importance >= 0.7);
    const topMail = important[0] ?? messages[0];

    return {
      weather: {
        lead: "Here's your ", accent: 'weather.',
        subline: `${weather.condition} — currently ${t}° in ${weather.location}.`,
        metaBig: `${t}°`,
        metaSmall: hi != null && lo != null ? `H ${hi}° · L ${lo}°` : weather.location,
      },
      calendar: {
        lead: "Here's your ", accent: 'day.',
        subline: todayEvents.length
          ? `${todayEvents.length} ${todayEvents.length === 1 ? 'event' : 'events'} today${nextEvent ? ` — ${nextEvent.title} at ${fmtEventTime(nextEvent.start_time)}` : ''}.`
          : 'Nothing on your calendar today.',
        metaBig: `${todayEvents.length}`,
        metaSmall: todayEvents.length === 1 ? 'event today' : 'events today',
      },
      tasks: {
        lead: "Let's clear your ", accent: 'tasks.',
        subline: tasks.length
          ? `${completedCount} of ${tasks.length} done${dueToday ? `, ${dueToday} due today` : ''}, ${overdue ? `${overdue} overdue` : 'nothing overdue'}.`
          : 'No tasks yet — enjoy the clear runway.',
        metaBig: `${pct}%`,
        metaSmall: `${completedCount} of ${tasks.length} complete`,
      },
      stocks: {
        lead: "Here's your ", accent: 'watchlist.',
        subline: mover
          ? `${mover.symbol} ${mover.changePercent >= 0 ? 'leads' : 'lags'} at ${fmtPct(mover.changePercent)} today.`
          : 'Markets are quiet right now.',
        metaBig: mover ? fmtPct(mover.changePercent) : '—',
        metaSmall: `${stocks.length} watched`,
      },
      email: {
        lead: "Here's your ", accent: 'inbox.',
        subline: !mailConnected
          ? 'Connect a mailbox and Atlas will scan it for you.'
          : important.length
            ? `${important.length} need${important.length === 1 ? 's' : ''} attention — ${senderName(topMail?.from_address)}: ${topMail?.subject ?? ''}`.trim()
            : `${messages.length} scanned, nothing urgent.`,
        metaBig: `${important.length}`,
        metaSmall: 'need attention',
      },
      news: {
        lead: 'Your morning ', accent: 'briefing.',
        subline: news.length
          ? `${news.length} ${news.length === 1 ? 'story' : 'stories'} Atlas picked for you this morning.`
          : 'No stories yet this morning.',
        metaBig: `${news.length}`,
        metaSmall: 'top stories',
      },
      music: {
        lead: 'Now ', accent: 'playing.',
        subline: nowPlaying?.track
          ? `${nowPlaying.track.title} — ${nowPlaying.track.artist}`
          : 'Nothing playing right now.',
        metaBig: nowPlaying?.track ? '♪' : '—',
        metaSmall: nowPlaying?.track ? nowPlaying.track.title : 'paused',
      },
    };
  }, [weather, events, tasks, completedCount, progress, stocks, messages, mailConnected, news, nowPlaying]);

  // Directional swap: when the focused widget changes, animate the current text
  // out, switch which widget is shown while hidden, then animate the new text
  // in. We render live content for `shownKey` (so data stays fresh) and only
  // key the swap on `focusedKey` — putting the content object in the deps would
  // let live-data re-renders keep resetting the timer, lagging the swap.
  const [shownKey, setShownKey] = useState<AuroraExpandedKey>(focusedKey);
  const [swapping, setSwapping] = useState(false);

  useEffect(() => {
    if (focusedKey === shownKey) return;
    setSwapping(true);
    const t = window.setTimeout(() => {
      setShownKey(focusedKey);
      requestAnimationFrame(() => setSwapping(false));
    }, 190);
    return () => window.clearTimeout(t);
  }, [focusedKey, shownKey]);

  const content: BandContent = shownKey ? byKey[shownKey] ?? home : home;
  return { content, swapping };
}
