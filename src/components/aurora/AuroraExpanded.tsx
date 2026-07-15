import { useEffect, useState } from 'react';
import {
  Minimize2, MapPin, RefreshCw, Droplets, Wind, Eye, Sunrise, Sunset,
  Calendar as CalIcon, Plus, TrendingUp, Gauge, Sun, Thermometer,
  Inbox, Star, Send, Archive, PenLine, TrendingDown, Mail,
} from 'lucide-react';
import { WeatherIcon } from './auroraIcons';
import { sparklinePoints, fmtPct, fmtEventTime } from '@/pages/aurora/auroraHelpers';
import { useWeather } from '@/hooks/useWeather';
import { useStocks } from '@/hooks/useStocks';
import { useNews } from '@/hooks/useNews';
import { useTasks } from '@/hooks/useTasks';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import type { WakeWordState, AIState } from '@/types';
import type { AuroraExpandedKey } from '@/pages/aurora/AuroraDashboard';

interface Props {
  which: AuroraExpandedKey;
  onClose: () => void;
  onOpenDrawer: () => void;
  sphereState: WakeWordState | AIState;
  audioLevel: number;
}

const CloseBtn = ({ onClose }: { onClose: () => void }) => (
  <button className="closeBtn" onClick={onClose}>
    <Minimize2 className="i16" /><span>Close</span><span className="kbd">Esc</span>
  </button>
);
const Head = ({ title, onClose }: { title: string; onClose: () => void }) => (
  <header className="ehead">
    <div className="fx ac gap16"><div className="accline" /><h1 className="etitle">{title}</h1></div>
    <CloseBtn onClose={onClose} />
  </header>
);

export const AuroraExpanded = ({ which, onClose }: Props) => {
  // Lock body scroll while an expanded view is open
  useEffect(() => {
    if (which) { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }
  }, [which]);

  if (!which) return null;
  return (
    <>
      {which === 'weather' && <WeatherView onClose={onClose} />}
      {which === 'calendar' && <CalendarView onClose={onClose} />}
      {which === 'tasks' && <TasksView onClose={onClose} />}
      {which === 'stocks' && <StocksView onClose={onClose} />}
      {which === 'email' && <EmailView onClose={onClose} />}
      {which === 'news' && <NewsView onClose={onClose} />}
    </>
  );
};

function WeatherView({ onClose }: { onClose: () => void }) {
  const { weather } = useWeather();
  const hours = weather.hourly.slice(0, 8);
  return (
    <div className="exp th-weather" data-screen-label="Aurora — Weather">
      <div className="skyB" /><div className="skyfadeB" />
      <Head title="Weather" onClose={onClose} />
      <div className="ebody">
        <div className="col gap16" style={{ width: '34%', minWidth: 340 }}>
          <div className="gpanel f1 col">
            <div className="fx ac jb mb16">
              <div className="fx ac gap8"><MapPin className="i16 iInd" /><span className="t14" style={{ color: 'hsl(240 30% 82%)' }}>{weather.location}</span></div>
              <button className="xbtn fx ac jc"><RefreshCw className="i14" /></button>
            </div>
            <div className="f1 col ac jc">
              <WeatherIcon icon={weather.icon} className="iInd" style={{ width: 104, height: 104 }} />
              <div className="tc" style={{ marginTop: 20 }}>
                <div className="bigtemp tnum">{Math.round(weather.temp)}°</div>
                <div className="econd">{weather.condition}</div>
                <div className="efeels">Feels like {Math.round(weather.temp) - 2}°</div>
              </div>
            </div>
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 22, paddingTop: 22, borderTop: '1px solid hsl(243 60% 70% / .1)' }}>
              <div className="estat"><Droplets className="i20 iInd" style={{ margin: '0 auto 5px' }} /><div className="esval tnum">{weather.humidity}%</div><div className="eslbl">Humidity</div></div>
              <div className="estat"><Wind className="i20 iInd" style={{ margin: '0 auto 5px' }} /><div className="esval tnum">{Math.round(weather.windSpeed)} mph</div><div className="eslbl">Wind</div></div>
              <div className="estat"><Eye className="i20 iInd" style={{ margin: '0 auto 5px' }} /><div className="esval tnum">10 km</div><div className="eslbl">Visibility</div></div>
            </div>
          </div>
          <div className="gpanel2 fx ac jb">
            <div className="fx ac gap12"><div className="icboxB fx ac jc"><Sunrise className="i16" /></div><div><div className="eslbl">Sunrise</div><div className="esval tnum">{weather.sunrise}</div></div></div>
            <div className="f1" style={{ margin: '0 16px' }}><div className="rangebar" style={{ width: '100%' }}><div className="rangefill" style={{ width: '52%' }} /></div></div>
            <div className="fx ac gap12"><div className="icboxB fx ac jc"><Sunset className="i16" /></div><div><div className="eslbl">Sunset</div><div className="esval tnum">{weather.sunset}</div></div></div>
          </div>
        </div>
        <div className="f1 col gap16">
          <div className="gpanel2">
            <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>Hourly Forecast</h3>
            <div className="fx gap12" style={{ overflowX: 'auto', paddingBottom: 6 }}>
              {hours.map((h, i) => (
                <div className={`h24 ${i === 0 ? 'on' : ''}`} key={i}>
                  <span className="fs12" style={{ color: 'hsl(240 20% 62%)' }}>{h.time}</span>
                  <WeatherIcon icon={h.icon} className={`i20 ${i === 0 ? 'iInd' : 'iMut'}`} />
                  <span className="t14 fw6 tnum" style={{ color: 'hsl(240 30% 90%)' }}>{Math.round(h.temp)}°</span>
                </div>
              ))}
            </div>
          </div>
          {weather.daily && weather.daily.length > 0 && (
            <div className="gpanel2">
              <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>7-day outlook</h3>
              {weather.daily.slice(0, 7).map((d, i) => (
                <div className={`drow ${i === 0 ? 'today' : ''}`} key={i}>
                  <div className="t14 fw6" style={{ width: 56 }}>{d.day}</div>
                  <div className="fx ac gap12 f1 jc"><WeatherIcon icon={d.icon} className={`i20 ${i === 0 ? 'iInd' : 'iMut'}`} /></div>
                  <div className="fx ac gap10 tnum"><span className="t14 fw6">{d.high}°</span><span className="t14" style={{ color: 'hsl(30 3% 55%)' }}>{d.low}°</span></div>
                </div>
              ))}
            </div>
          )}
          <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <div className="gpanel2"><div className="fx ac gap8 mb8"><div className="icboxB fx ac jc"><Gauge className="i14" /></div><span className="eslbl">Pressure</span></div><div className="fs16 fw6 tnum" style={{ color: 'hsl(240 30% 92%)' }}>1013 hPa</div></div>
            <div className="gpanel2"><div className="fx ac gap8 mb8"><div className="icboxB fx ac jc"><Sun className="i14" /></div><span className="eslbl">UV Index</span></div><div className="fs16 fw6" style={{ color: 'hsl(240 30% 92%)' }}>6 High</div></div>
            <div className="gpanel2"><div className="fx ac gap8 mb8"><div className="icboxB fx ac jc"><Thermometer className="i14" /></div><span className="eslbl">Dew Point</span></div><div className="fs16 fw6 tnum" style={{ color: 'hsl(240 30% 92%)' }}>55°</div></div>
            <div className="gpanel2"><div className="fx ac gap8 mb8"><div className="icboxB fx ac jc"><Wind className="i14" /></div><span className="eslbl">Air Quality</span></div><div className="fs16 fw6" style={{ color: 'hsl(240 30% 92%)' }}>Good</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CalendarView({ onClose }: { onClose: () => void }) {
  const { events } = useCalendarEvents();
  const now = Date.now();
  const nowIdx = events.findIndex((e) => new Date(e.start_time).getTime() >= now);
  const dateLabel = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <div className="exp th-cal" data-screen-label="Aurora — Calendar">
      <div className="expwash" />
      <Head title="Calendar" onClose={onClose} />
      <div className="ebody">
        <div className="col gap16" style={{ width: '34%', minWidth: 340 }}>
          <div className="gpanel f1 col">
            <div className="fx ac jb mb16"><div className="fx ac gap8"><CalIcon className="i16 iAcc" /><span className="t14" style={{ color: 'hsl(240 30% 82%)' }}>{dateLabel}</span></div><button className="xbtn fx ac jc"><Plus className="i14" /></button></div>
            <div className="f1 col ac jc"><div className="bigtemp tnum">{events.length}</div><div className="econd">events today</div>{events[nowIdx] && <div className="efeels">Next · {events[nowIdx].title}</div>}</div>
          </div>
        </div>
        <div className="f1 col gap16">
          <div className="gpanel2 f1">
            <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>Schedule</h3>
            {events.length === 0 && <p className="evsB">No events scheduled.</p>}
            {events.map((e, i) => (
              <div className={`rowB ${i === events.length - 1 ? 'last' : ''}`} key={e.id ?? i}>
                <span className="evtimeB">{fmtEventTime(e.start_time)}</span>
                <div className="f1" style={{ minWidth: 0 }}><p className="evtB">{e.title}</p>{e.location && <p className="evsB">{e.location}</p>}</div>
                {i === nowIdx && <span className="nowB">Now</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TasksView({ onClose }: { onClose: () => void }) {
  const { tasks, completedCount, progress } = useTasks();
  const active = tasks.filter((t) => !t.completed);
  const done = tasks.filter((t) => t.completed);
  const pct = Math.round(progress || 0);
  const pill = (p: string) => p === 'high' ? 'tkHigh' : p === 'low' ? 'tkLow' : 'tkMed';
  // Stat trio from real tasks (design: High / Due today / Overdue)
  const todayStr = new Date().toISOString().slice(0, 10);
  const highCount = active.filter((t) => t.priority === 'high').length;
  const dueTodayCount = active.filter((t) => t.due_date && t.due_date.slice(0, 10) === todayStr).length;
  const overdueCount = active.filter((t) => t.due_date && t.due_date.slice(0, 10) < todayStr).length;
  return (
    <div className="exp th-task" data-screen-label="Aurora — Tasks">
      <div className="expwash" />
      <Head title="Tasks" onClose={onClose} />
      <div className="ebody">
        <div className="col gap16" style={{ width: '34%', minWidth: 340 }}>
          <div className="gpanel f1 col ac jc">
            <svg width="152" height="152" viewBox="0 0 42 42">
              <circle cx="21" cy="21" r="15.9" fill="none" stroke="hsl(240 33% 20%)" strokeWidth="3" />
              <circle cx="21" cy="21" r="15.9" fill="none" className="strokeAcc" strokeWidth="3" strokeDasharray={`${pct} 100`} strokeLinecap="round" transform="rotate(-90 21 21)" />
            </svg>
            <div className="tc" style={{ marginTop: 14 }}><div className="bigtemp tnum" style={{ fontSize: 40 }}>{pct}%</div><div className="econd">{completedCount} of {tasks.length} complete</div></div>
          </div>
          <div className="gpanel2 grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <div className="estat"><div className="esval tnum">{highCount}</div><div className="eslbl">High</div></div>
            <div className="estat"><div className="esval tnum">{dueTodayCount}</div><div className="eslbl">Due today</div></div>
            <div className="estat"><div className="esval tnum" style={overdueCount ? { color: 'hsl(9 57% 48%)' } : undefined}>{overdueCount}</div><div className="eslbl">Overdue</div></div>
          </div>
        </div>
        <div className="f1 col gap16">
          <div className="gpanel2 f1">
            <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>Active</h3>
            {active.map((t, i) => (
              <div className={`rowB ${i === active.length - 1 ? 'last' : ''}`} key={t.id ?? i}>
                <div className="ckB" />
                <div className="f1" style={{ minWidth: 0 }}><p className="evtB">{t.title}</p>{t.due_date && <p className="evsB">Due {new Date(t.due_date).toLocaleDateString()}</p>}</div>
                <span className={`tkpill ${pill(t.priority)}`}>{t.priority === 'high' ? 'High' : t.priority === 'low' ? 'Low' : 'Med'}</span>
              </div>
            ))}
          </div>
          {done.length > 0 && (
            <div className="gpanel2">
              <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>Completed</h3>
              {done.map((t, i) => (
                <div className={`rowB ${i === done.length - 1 ? 'last' : ''}`} key={t.id ?? i}>
                  <div className="ckB done fx ac jc"><span /></div>
                  <div className="f1" style={{ minWidth: 0 }}><p className="evtB doneB">{t.title}</p></div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const fmtMktCap = (v?: number | null) => {
  if (v == null) return '—';
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  return `${v}`;
};

function StocksView({ onClose }: { onClose: () => void }) {
  const { stocks, indices } = useStocks(['AAPL', 'GOOGL', 'MSFT', 'NVDA', 'AMZN', 'META']);
  const lead = stocks[0];
  const gridCells = lead ? [
    { label: 'Open', value: lead.open != null ? lead.open.toFixed(2) : '—' },
    { label: 'High', value: lead.high != null ? lead.high.toFixed(2) : '—' },
    { label: 'Low', value: lead.low != null ? lead.low.toFixed(2) : '—' },
    { label: 'Prev close', value: lead.prevClose != null ? lead.prevClose.toFixed(2) : '—' },
    { label: 'Mkt cap', value: fmtMktCap(lead.marketCap) },
    { label: 'Day range', value: lead.high != null && lead.low != null ? (lead.high - lead.low).toFixed(2) : '—' },
  ] : [];
  return (
    <div className="exp th-stock" data-screen-label="Aurora — Watchlist">
      <div className="expwash" />
      <Head title="Watchlist" onClose={onClose} />
      <div className="ebody">
        <div className="col gap16" style={{ width: '38%', minWidth: 360 }}>
          {lead && (
            <div className="gpanel f1 col">
              <div className="fx ac jb mb16"><div><div className="fx ac gap8"><span className="symB" style={{ width: 'auto', fontSize: 15 }}>{lead.symbol}</span><span className="fx ac gap8 fs12 upB"><span className="dotB on" style={{ width: 6, height: 6, background: 'hsl(160 58% 56%)', boxShadow: '0 0 8px hsl(160 58% 56% / .7)' }} />Live</span></div><span className="snB">{lead.name}</span></div></div>
              <div className="fx" style={{ alignItems: 'flex-end', gap: 12 }}><div className="bigprice tnum">{lead.price.toFixed(2)}</div><div className={`fx ac gap4 fw6 ${lead.changePercent >= 0 ? 'upB' : 'dnB'}`} style={{ marginBottom: 8 }}>{lead.changePercent >= 0 ? <TrendingUp className="i16" /> : <TrendingDown className="i16" />}<span className="tnum">{lead.change >= 0 ? '+' : ''}{lead.change.toFixed(2)} ({fmtPct(lead.changePercent)})</span></div></div>
              <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: '100%', height: 120, marginTop: 16 }}><polyline points={sparklinePoints(lead.sparkline, 100, 40, 4)} className="strokeAcc" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
              <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--bd)' }}>
                {gridCells.map((c) => (
                  <div className="estat" key={c.label}><div className="esval tnum">{c.value}</div><div className="eslbl">{c.label}</div></div>
                ))}
              </div>
            </div>
          )}
          {indices.length > 0 && (
            <div className="gpanel2">
              <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>Indices</h3>
              {indices.map((ix, i) => {
                const up = ix.changePercent >= 0;
                return (
                  <div className={`rowB ${i === indices.length - 1 ? 'last' : ''}`} key={ix.label}>
                    <span className="snB f1">{ix.label}</span>
                    <span className="prcB tnum" style={{ width: 76, textAlign: 'right' }}>{ix.price.toLocaleString()}</span>
                    <span className={`chgB ${up ? 'upB' : 'dnB'}`}>{fmtPct(ix.changePercent)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="f1 col gap16">
          <div className="gpanel2 f1">
            <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>Watchlist</h3>
            {stocks.map((s, i) => {
              const up = s.changePercent >= 0;
              return (
                <div className={`rowB ${i === stocks.length - 1 ? 'last' : ''}`} key={s.symbol}>
                  <span className="symB">{s.symbol}</span>
                  <span className="snB f1 trunc" style={{ minWidth: 0 }}>{s.name}</span>
                  <svg width="72" height="22"><polyline points={sparklinePoints(s.sparkline)} fill="none" stroke={up ? 'hsl(160 58% 56%)' : 'hsl(350 75% 68%)'} strokeWidth="1.5" /></svg>
                  <span className="prcB" style={{ width: 76, textAlign: 'right' }}>{s.price.toFixed(2)}</span>
                  <span className={`chgB ${up ? 'upB' : 'dnB'}`}>{fmtPct(s.changePercent)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const MAIL_CATEGORIES = [
  { key: 'bills', label: 'Bills' },
  { key: 'important', label: 'Important' },
  { key: 'documents', label: 'Documents' },
  { key: 'personal', label: 'Personal' },
  { key: 'newsletters', label: 'Newsletters' },
  { key: 'other', label: 'Other' },
] as const;

function EmailView({ onClose }: { onClose: () => void }) {
  const {
    messages, alerts, accounts, isConnected, isConnecting,
    connect, disconnect, acknowledge, syncNow,
  } = useMailIntelligence();
  const [filter, setFilter] = useState<string>('all');

  const senderName = (from: string | null) => (from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || 'Unknown';
  const initials = (from: string | null) => {
    const parts = senderName(from).split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
  };
  const counts = messages.reduce<Record<string, number>>((acc, m) => {
    acc[m.category] = (acc[m.category] ?? 0) + 1;
    return acc;
  }, {});
  const rows = filter === 'all' ? messages : messages.filter((m) => m.category === filter);

  return (
    <div className="exp th-mail" data-screen-label="Aurora — Mail">
      <div className="expwash" />
      <Head title="Mail" onClose={onClose} />
      <div className="ebody">
        <div className="col gap16" style={{ width: '32%', minWidth: 320 }}>
          <div className="gpanel col">
            {!isConnected ? (
              <>
                <p className="t14 fw6 mb8" style={{ color: 'hsl(240 30% 88%)' }}>Connect your mailbox</p>
                <p className="fs12 mb12" style={{ color: 'hsl(240 20% 62%)', lineHeight: 1.5 }}>
                  One-time, read-only connection. Your browser's existing Google session means it's usually a single "Allow" click — Atlas then scans automatically, sorts everything here, and alerts you to bills, deadlines and documents. Your mailbox is never modified.
                </p>
                <button
                  className="fx ac jc gap8 fw6"
                  onClick={() => connect().catch(() => {})}
                  disabled={isConnecting}
                  style={{ width: '100%', padding: 12, borderRadius: 12, background: 'hsl(var(--acc) / .16)', border: '1px solid hsl(var(--acc) / .3)', color: 'hsl(var(--acc))', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, opacity: isConnecting ? 0.6 : 1 }}
                >
                  <Mail className="i16" />{isConnecting ? 'Waiting for Google…' : 'Connect Gmail'}
                </button>
              </>
            ) : (
              <>
                {accounts.map((a) => (
                  <div className="fx ac jb mb8" key={a.id}>
                    <div style={{ minWidth: 0 }}>
                      <p className="t14 fw6 trunc m0" style={{ color: 'hsl(240 30% 88%)' }}>{a.email_address}</p>
                      <p className="fs12 m0" style={{ color: a.status === 'active' ? 'hsl(160 58% 56%)' : 'hsl(350 75% 68%)' }}>
                        {a.status === 'active' ? `Synced ${a.last_synced_at ? fmtEventTime(a.last_synced_at) : 'pending'}` : a.status}
                      </p>
                    </div>
                    <button className="xbtn fx ac jc" title="Disconnect" onClick={() => disconnect(a.id)}><Archive className="i14" /></button>
                  </div>
                ))}
                <button className="xbtn fx ac jc gap8" style={{ width: '100%', marginTop: 6 }} onClick={syncNow} title="Scan now">
                  <Send className="i14" /><span className="fs12">Scan now</span>
                </button>
              </>
            )}
            <div className="col gap8" style={{ marginTop: 18 }}>
              <div
                className="fx ac jb" onClick={() => setFilter('all')}
                style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', background: filter === 'all' ? 'hsl(var(--acc) / .1)' : 'transparent' }}
              >
                <span className="fx ac gap10 t14 fw5" style={{ color: 'hsl(240 30% 90%)' }}><Inbox className="i16 iAcc" />All scanned</span>
                <span className="pillAcc">{messages.length}</span>
              </div>
              {MAIL_CATEGORIES.map((c) => (
                <div
                  key={c.key} className="fx ac jb" onClick={() => setFilter(c.key)}
                  style={{ padding: '10px 12px', borderRadius: 10, cursor: 'pointer', background: filter === c.key ? 'hsl(var(--acc) / .1)' : 'transparent' }}
                >
                  <span className="fx ac gap10 t14" style={{ color: 'hsl(240 20% 70%)' }}><Star className="i16" style={{ color: 'hsl(240 20% 55%)' }} />{c.label}</span>
                  <span className="fs12" style={{ color: 'hsl(240 20% 55%)' }}>{counts[c.key] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="f1 col gap16">
          {alerts.length > 0 && (
            <div className="gpanel2">
              <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>Needs your attention</h3>
              {alerts.map((a, i) => (
                <div className={`rowB ${i === alerts.length - 1 ? 'last' : ''}`} key={a.id}>
                  <span className="pillAcc" style={{ textTransform: 'capitalize' }}>{a.alert_type}</span>
                  <div className="f1" style={{ minWidth: 0 }}>
                    <p className="evtB trunc">{a.title}</p>
                    {a.body && <p className="evsB trunc">{a.body}</p>}
                  </div>
                  <button className="xbtn fx ac jc" title="Dismiss" onClick={() => acknowledge(a.id)}><PenLine className="i14" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="gpanel2 f1" style={{ padding: 8, overflowY: 'auto' }}>
            {rows.length === 0 && (
              <p className="evsB" style={{ padding: 16 }}>
                {isConnected ? 'Nothing scanned in this category yet.' : 'Connect a mailbox to start scanning.'}
              </p>
            )}
            {rows.map((m, i) => {
              const hot = m.category === 'bills' || m.importance >= 0.7;
              const extractedBits = [
                m.extracted?.amount ? `${m.extracted.amount} ${m.extracted.currency ?? ''}`.trim() : null,
                m.extracted?.due_date ? `due ${m.extracted.due_date}` : null,
              ].filter(Boolean).join(' · ');
              return (
                <div className={`mailrow ${i === rows.length - 1 ? 'last' : ''}`} key={m.id}>
                  <div className="avB2 fx ac jc">{initials(m.from_address)}</div>
                  <div className="f1" style={{ minWidth: 0 }}>
                    <div className="fx ac jb gap8">
                      <span className="fx ac gap8">
                        {hot && <span className="dotB on" style={{ width: 6, height: 6 }} />}
                        <span className="sndB" style={hot ? undefined : { color: 'hsl(240 20% 66%)' }}>{senderName(m.from_address)}</span>
                        <span className="pillAcc" style={{ textTransform: 'capitalize' }}>{m.category}</span>
                      </span>
                      <span className="tmB">{m.received_at ? new Date(m.received_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</span>
                    </div>
                    <p className="sbjB m0" style={{ marginTop: 2, ...(hot ? {} : { color: 'hsl(240 20% 58%)' }) }}>{m.subject}</p>
                    <p className="previewline">{extractedBits ? `${extractedBits} — ` : ''}{m.snippet}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewsView({ onClose }: { onClose: () => void }) {
  const { news } = useNews();
  const [lead, ...rest] = news;
  return (
    <div className="exp th-news" data-screen-label="Aurora — Briefing">
      <div className="expwash" />
      <Head title="Briefing" onClose={onClose} />
      <div className="ebody">
        {lead && (
          <div className="feat" style={{ width: '40%', minWidth: 360 }}>
            <div className="fx ac gap8"><span className="pillAcc">{lead.category}</span><span className="fx ac gap4 fs12 upB"><TrendingUp className="i12" />Trending</span></div>
            <h2 className="featTitle">{lead.title}</h2>
            <p className="featBody">Atlas surfaced this as your top story. Open the source for the full report and related coverage.</p>
            <div className="featImg" />
            <div className="fx ac gap8 fs12" style={{ marginTop: 16, color: 'hsl(240 20% 56%)' }}><span>{lead.source}</span><span>·</span><span>{lead.time}</span></div>
          </div>
        )}
        <div className="gpanel2 f1">
          <h3 className="t14 fw6 mb12" style={{ color: 'hsl(240 30% 82%)' }}>More stories</h3>
          {rest.map((n, i) => (
            <div className={`rowB ${i === rest.length - 1 ? 'last' : ''}`} key={n.id ?? i}>
              <div className="f1" style={{ minWidth: 0 }}>
                <div className="fx ac gap8 mb8"><span className="pillAcc">{n.category}</span></div>
                <h4 className="ntB" style={{ margin: 0 }}>{n.title}</h4>
                <span className="nmB">{n.source} · {n.time}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
