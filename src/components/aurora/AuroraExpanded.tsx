import { useEffect } from 'react';
import {
  Minimize2, MapPin, RefreshCw, Droplets, Wind, Eye, Sunrise, Sunset,
  Calendar as CalIcon, Plus, TrendingUp, Gauge, Sun, Thermometer,
  Inbox, Star, Send, Archive, PenLine, TrendingDown,
} from 'lucide-react';
import { WeatherIcon } from './auroraIcons';
import { sparklinePoints, fmtPct, fmtEventTime } from '@/pages/aurora/auroraHelpers';
import { useWeather } from '@/hooks/useWeather';
import { useStocks } from '@/hooks/useStocks';
import { useNews } from '@/hooks/useNews';
import { useTasks } from '@/hooks/useTasks';
import { useCalendarEvents } from '@/hooks/useCalendarEvents';
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

function StocksView({ onClose }: { onClose: () => void }) {
  const { stocks } = useStocks(['AAPL', 'GOOGL', 'MSFT', 'NVDA', 'AMZN', 'META']);
  const lead = stocks[0];
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

function EmailView({ onClose }: { onClose: () => void }) {
  const rows = [
    { i: 'SC', n: 'Sarah Chen', s: 'Q4 Budget Review', t: '10:32 AM', unread: true, p: 'Hi — I need your input on the Q4 budget before Friday\'s board meeting. Can you review the marketing line items?' },
    { i: 'MJ', n: 'Mike Johnson', s: 'Re: Project Timeline', t: '9:15 AM', unread: true, p: 'Thanks for the update. The timeline works on our end — we\'ll have the design handoff ready by Wednesday.' },
    { i: 'DT', n: 'Design Team', s: 'Brand Guidelines Released', t: 'Yesterday', unread: false, p: 'The updated brand guidelines are now live in Figma. Highlights include the new type scale and color tokens.' },
    { i: 'AR', n: 'Alex Rivera', s: 'Meeting Notes', t: 'Yesterday', unread: false, p: 'Key takeaways: ship the sphere perf fix, finalize onboarding copy, and confirm the data model.' },
  ];
  return (
    <div className="exp th-mail" data-screen-label="Aurora — Inbox">
      <div className="expwash" />
      <Head title="Inbox" onClose={onClose} />
      <div className="ebody">
        <div className="col gap16" style={{ width: '32%', minWidth: 320 }}>
          <div className="gpanel col">
            <button className="fx ac jc gap8 fw6" style={{ width: '100%', padding: 12, borderRadius: 12, background: 'hsl(var(--acc) / .16)', border: '1px solid hsl(var(--acc) / .3)', color: 'hsl(var(--acc))', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}><PenLine className="i16" />Compose</button>
            <div className="col gap8" style={{ marginTop: 18 }}>
              <div className="fx ac jb" style={{ padding: '10px 12px', borderRadius: 10, background: 'hsl(var(--acc) / .1)' }}><span className="fx ac gap10 t14 fw5" style={{ color: 'hsl(240 30% 90%)' }}><Inbox className="i16 iAcc" />Primary</span><span className="pillAcc">2</span></div>
              <div className="fx ac jb" style={{ padding: '10px 12px' }}><span className="fx ac gap10 t14" style={{ color: 'hsl(240 20% 70%)' }}><Star className="i16" style={{ color: 'hsl(240 20% 55%)' }} />Starred</span><span className="fs12" style={{ color: 'hsl(240 20% 55%)' }}>2</span></div>
              <div className="fx ac jb" style={{ padding: '10px 12px' }}><span className="fx ac gap10 t14" style={{ color: 'hsl(240 20% 70%)' }}><Send className="i16" style={{ color: 'hsl(240 20% 55%)' }} />Sent</span><span className="fs12" style={{ color: 'hsl(240 20% 55%)' }}>18</span></div>
              <div className="fx ac jb" style={{ padding: '10px 12px' }}><span className="fx ac gap10 t14" style={{ color: 'hsl(240 20% 70%)' }}><Archive className="i16" style={{ color: 'hsl(240 20% 55%)' }} />Archive</span><span className="fs12" style={{ color: 'hsl(240 20% 55%)' }}>204</span></div>
            </div>
          </div>
        </div>
        <div className="gpanel2 f1" style={{ padding: 8 }}>
          {rows.map((r, i) => (
            <div className={`mailrow ${i === rows.length - 1 ? 'last' : ''}`} key={i}>
              <div className="avB2 fx ac jc">{r.i}</div>
              <div className="f1" style={{ minWidth: 0 }}>
                <div className="fx ac jb gap8"><span className="fx ac gap8">{r.unread && <span className="dotB on" style={{ width: 6, height: 6 }} />}<span className="sndB" style={r.unread ? undefined : { color: 'hsl(240 20% 66%)' }}>{r.n}</span></span><span className="tmB">{r.t}</span></div>
                <p className="sbjB m0" style={{ marginTop: 2, ...(r.unread ? {} : { color: 'hsl(240 20% 58%)' }) }}>{r.s}</p>
                <p className="previewline">{r.p}</p>
              </div>
            </div>
          ))}
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
