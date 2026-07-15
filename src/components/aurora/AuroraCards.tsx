import { memo } from 'react';
import {
  CloudSun, Calendar, Check, Activity, Mail, Newspaper,
  Droplets, Wind, Sun, Sunrise, Sunset,
} from 'lucide-react';
import { WeatherIcon } from './auroraIcons';
import { sparklinePoints, fmtPct, fmtEventTime } from '@/pages/aurora/auroraHelpers';
import { useWeather } from '@/hooks/useWeather';
import { useStocks } from '@/hooks/useStocks';
import { useNews } from '@/hooks/useNews';
import { useTasks } from '@/hooks/useTasks';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';

// Each card faithfully reproduces the Aurora design's card face, wired to the
// real data hooks. Card chrome (cardB / chB / icboxB / cbB) comes from aurora.css.

export const AuroraWeatherCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { weather } = useWeather();
  const hourly = weather.hourly.slice(0, 6);
  return (
    <div className="cardB rs2 d1" onClick={onOpen}>
      <div className="chB"><p className="mlblB">Weather</p><div className="icboxB fx ac jc"><CloudSun className="i14" /></div></div>
      <div className="cbB">
        <p className="tempB tnum">{Math.round(weather.temp)}°</p>
        <p className="condB">{weather.condition} · {weather.location}</p>
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
      </div>
    </div>
  );
});
AuroraWeatherCard.displayName = 'AuroraWeatherCard';

export const AuroraCalendarCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { events } = useCalendarEvents();
  const now = Date.now();
  const rows = events.slice(0, 4);
  // Mark the event closest to (but around) now as "Now"
  const nowIdx = rows.findIndex((e) => new Date(e.start_time).getTime() >= now);
  return (
    <div className="cardB rs2 d2" onClick={onOpen}>
      <div className="chB"><p className="mlblB">Today</p><div className="icboxB fx ac jc"><Calendar className="i14" /></div></div>
      <div className="cbB">
        {rows.length === 0 && <p className="condB">No events today</p>}
        {rows.map((e, i) => (
          <div className={`rowB ${i === rows.length - 1 ? 'last' : ''}`} key={e.id ?? i}>
            <div className={`dotB ${i === nowIdx ? 'on' : ''}`} />
            <span className="evtimeB">{fmtEventTime(e.start_time)}</span>
            <div className="f1" style={{ minWidth: 0 }}>
              <p className="evtB">{e.title}</p>
              {e.location && <p className="evsB">{e.location}</p>}
            </div>
            {i === nowIdx && <span className="nowB">Now</span>}
          </div>
        ))}
      </div>
    </div>
  );
});
AuroraCalendarCard.displayName = 'AuroraCalendarCard';

export const AuroraTasksCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { tasks, completedCount, progress } = useTasks();
  const rows = tasks.slice(0, 5);
  const pct = Math.round(progress || 0);
  return (
    <div className="cardB rs2 d3" onClick={onOpen}>
      <div className="chB"><p className="mlblB">Tasks · {completedCount} of {tasks.length}</p><div className="icboxB fx ac jc"><Check className="i14" /></div></div>
      <div className="cbB">
        {tasks.length > 0 && (
          <div style={{ margin: '4px 0 14px' }}>
            <div style={{ height: 6, borderRadius: 999, background: 'var(--sk)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: 'var(--acc)', transition: 'width .3s var(--ease-spring)' }} />
            </div>
          </div>
        )}
        {rows.map((t, i) => (
          <div className={`rowB ${i === rows.length - 1 ? 'last' : ''}`} key={t.id ?? i}>
            <div className={`ckB ${t.completed ? 'done fx ac jc' : ''}`}>{t.completed && <Check className="i12 iInd" />}</div>
            <p className={`evtB f1 trunc ${t.completed ? 'doneB' : ''}`} style={{ minWidth: 0 }}>{t.title}</p>
          </div>
        ))}
      </div>
    </div>
  );
});
AuroraTasksCard.displayName = 'AuroraTasksCard';

const WATCHLIST = ['AAPL', 'GOOGL', 'MSFT', 'NVDA'];
export const AuroraStocksCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { stocks } = useStocks(WATCHLIST);
  const rows = stocks.slice(0, 4);
  return (
    <div className="cardB sp2 rs2 d4" onClick={onOpen}>
      <div className="chB"><p className="mlblB">Watchlist · Market open</p><div className="icboxB fx ac jc"><Activity className="i14" /></div></div>
      <div className="cbB">
        {rows.map((s, i) => {
          const up = s.changePercent >= 0;
          const stroke = up ? 'hsl(165 65% 62%)' : 'hsl(350 75% 68%)';
          return (
            <div className={`rowB ${i === rows.length - 1 ? 'last' : ''}`} key={s.symbol}>
              <span className="symB">{s.symbol}</span>
              <span className="snB f1 trunc" style={{ minWidth: 0 }}>{s.name}</span>
              <svg width="72" height="22"><polyline points={sparklinePoints(s.sparkline)} fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
              <span className="prcB" style={{ width: 76, textAlign: 'right' }}>{s.price.toFixed(2)}</span>
              <span className={`chgB ${up ? 'upB' : 'dnB'}`}>{fmtPct(s.changePercent)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
AuroraStocksCard.displayName = 'AuroraStocksCard';

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

export const AuroraInboxCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { messages, alerts, isConnected, isLoading } = useMailIntelligence();
  const rows = messages.slice(0, 4);
  return (
    <div className="cardB rs2 d5" onClick={onOpen}>
      <div className="chB">
        <p className="mlblB">{isConnected ? `Mail · ${alerts.length} alert${alerts.length === 1 ? '' : 's'}` : 'Mail'}</p>
        <div className="icboxB fx ac jc"><Mail className="i14" /></div>
      </div>
      <div className="cbB">
        {!isConnected && !isLoading && (
          <div className="col ac jc" style={{ padding: '18px 0', textAlign: 'center' }}>
            <p className="condB" style={{ marginBottom: 6 }}>No mailbox connected</p>
            <p className="metaB">Open to connect Gmail — Atlas scans read-only and alerts you to bills and deadlines.</p>
          </div>
        )}
        {isConnected && rows.length === 0 && <p className="condB">Scanning your inbox…</p>}
        {rows.map((m, i) => {
          const hot = m.category === 'bills' || m.importance >= 0.7;
          return (
            <div className={`rowB ${i === rows.length - 1 ? 'last' : ''}`} key={m.id}>
              <div className="avB2 fx ac jc">{senderInitials(m.from_address)}</div>
              <div className="f1" style={{ minWidth: 0 }}>
                <div className="fx ac gap8">
                  {hot && <div className="dotB on" style={{ width: 6, height: 6 }} />}
                  <span className="sndB trunc" style={hot ? undefined : { color: 'hsl(240 20% 66%)' }}>{senderName(m.from_address)}</span>
                </div>
                <p className="sbjB trunc m0" style={{ marginTop: 3, ...(hot ? {} : { color: 'hsl(240 20% 52%)' }) }}>{m.subject}</p>
              </div>
              <span className="tmB">{mailTime(m.received_at)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
AuroraInboxCard.displayName = 'AuroraInboxCard';

export const AuroraBriefingCard = memo(({ onOpen }: { onOpen: () => void }) => {
  const { news } = useNews();
  const rows = news.slice(0, 3);
  return (
    <div className="cardB rs2 d6" onClick={onOpen}>
      <div className="chB"><p className="mlblB">Briefing</p><div className="icboxB fx ac jc"><Newspaper className="i14" /></div></div>
      <div className="cbB">
        {rows.map((n, i) => (
          <div className={`rowB ${i === rows.length - 1 ? 'last' : ''}`} style={{ display: 'block' }} key={n.id ?? i}>
            <span className="ntagB">{n.category}</span>
            <h4 className="ntB">{n.title}</h4>
            <span className="nmB">{n.source} · {n.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
AuroraBriefingCard.displayName = 'AuroraBriefingCard';
