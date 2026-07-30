/**
 * The four supplementary dashboard cards from "Atlas Dashboard (Current)":
 * Air quality (real, OpenWeather air-pollution via get-weather), Now playing
 * (demo until a Spotify integration exists), Activity rings (demo until a
 * Health source exists), World clock (real, Intl timezones). Markup mirrors
 * the design file; CSS for all classes already ships in workshop.css.
 */
import { memo, useEffect, useState } from 'react';
import { Leaf, Flame, Globe, Play, Pause } from 'lucide-react';
import { useWeather } from '@/hooks/useWeather';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { useAudioReactivity } from '@/hooks/useAudioReactivity';
import { MusicSphere } from './MusicSphere';

// ---------------------------------------------------------------------------
// Air quality — real data. OpenWeather reports aqi 1–5; we display a US-style
// number derived from PM2.5 alongside the band label.

const AQI_BANDS = [
  { max: 12, label: 'Good', color: 'var(--grn)', pos: 18 },
  { max: 35.4, label: 'Moderate', color: '#d9b23a', pos: 45 },
  { max: 55.4, label: 'Sensitive', color: '#d98a3a', pos: 65 },
  { max: 150.4, label: 'Unhealthy', color: 'var(--red)', pos: 82 },
  { max: Infinity, label: 'Hazardous', color: 'var(--red)', pos: 95 },
] as const;

/** US EPA AQI from PM2.5 concentration (piecewise linear, simplified). */
function usAqiFromPm25(pm25: number): number {
  const bp: Array<[number, number, number, number]> = [
    [0, 12, 0, 50], [12.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
    [55.5, 150.4, 151, 200], [150.5, 250.4, 201, 300], [250.5, 500.4, 301, 500],
  ];
  for (const [cl, ch, il, ih] of bp) {
    if (pm25 <= ch) return Math.round(il + ((ih - il) / (ch - cl)) * (pm25 - cl));
  }
  return 500;
}

export const AtlasAirQualityCard = memo(() => {
  const { weather } = useWeather();
  const pm25 = weather.air?.pm25 ?? 8;
  const band = AQI_BANDS.find((b) => pm25 <= b.max) ?? AQI_BANDS[0];
  const aqi = usAqiFromPm25(pm25);
  const city = weather.location.split(' ')[0];
  return (
    <div className="cardB d1" style={{ cursor: 'default' }}>
      <div className="chB"><p className="mlblB">Air quality</p><div className="icboxB fx ac jc"><Leaf className="i14" /></div></div>
      <div className="cbB fx col" style={{ justifyContent: 'center' }}>
        <div className="fx ac gap12">
          <p className="tempB tnum" style={{ fontSize: 42, margin: 0 }}>{aqi}</p>
          <div>
            <p className="condB" style={{ margin: 0, color: band.color, fontWeight: 600 }}>{band.label}</p>
            <p className="metaB" style={{ marginTop: 2 }}>AQI · PM2.5 {pm25 < 12 ? 'low' : `${Math.round(pm25)} µg`} · {city}</p>
          </div>
        </div>
        <div className="aqbar"><span style={{ left: `${band.pos}%`, borderColor: band.color }} /></div>
      </div>
    </div>
  );
});
AtlasAirQualityCard.displayName = 'AtlasAirQualityCard';

// ---------------------------------------------------------------------------
// Now playing — the Atlas Sphere music player's compact tile (design Change 4).
// Flat-orange card: a mini reactive sphere, live equalizer, animated progress
// and play/pause. The whole tile opens the full-screen player; the play button
// stops propagation so it doesn't also open it.

const EqBars = ({ playing }: { playing: boolean }) => (
  <span className={`npeq${playing ? ' on' : ''}`} aria-hidden="true">
    <span /><span /><span /><span /><span />
  </span>
);

export const AtlasNowPlayingCard = memo(({ onOpen }: { onOpen?: () => void }) => {
  const m = useMusicPlayer();
  const isPlaying = m.nowPlaying?.isPlaying ?? false;
  const reactivity = useAudioReactivity(m.levelRef, isPlaying);
  const track = m.nowPlaying?.track ?? null;
  const title = track?.title ?? (m.connected ? 'Nothing playing' : 'Atlas Music');
  const artist = track?.artist ?? (m.connected ? '' : 'Tap to open the player');
  const ratio = track?.durationMs ? Math.min(1, (m.nowPlaying?.positionMs ?? 0) / track.durationMs) : 0;
  return (
    <div className="cardB npcard d2" onClick={onOpen} style={{ cursor: 'pointer' }}>
      {/* Field animation as the widget background — ~80% of the tile, 60%
          opacity so the track info stays legible on top. */}
      <div className="npfield"><MusicSphere form="field" reactivity={reactivity} className="npsphere" /></div>
      <div className="npcontent">
        <div className="f1" style={{ minWidth: 0 }}>
          <p className="nplbl">Now playing</p>
          <p className="nptitle trunc">{title}</p>
          <p className="npsub trunc">{artist}</p>
        </div>
        <EqBars playing={isPlaying} />
        <button
          className="npplay"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          onClick={(e) => { e.stopPropagation(); if (isPlaying) m.pause(); else m.play(); }}
        >
          {isPlaying ? <Pause className="i16" /> : <Play className="i16" />}
        </button>
      </div>
      <div className="npprog"><span style={{ width: `${ratio * 100}%` }} /></div>
    </div>
  );
});
AtlasNowPlayingCard.displayName = 'AtlasNowPlayingCard';

// ---------------------------------------------------------------------------
// Activity rings — demo content until a Health data source exists.

const RINGS = [
  { r: 42, dash: 264, off: 58, color: 'var(--acc)', track: 'rgba(52,97,242,.16)' },
  { r: 30, dash: 188.5, off: 72, color: '#2f7d4f', track: 'rgba(47,125,79,.16)' },
  { r: 18, dash: 113, off: 62, color: '#3461f2', track: 'rgba(52,97,242,.16)' },
] as const;

export const AtlasActivityCard = memo(() => (
  <div className="cardB sp2 d3" style={{ cursor: 'default' }}>
    <div className="chB"><p className="mlblB">Activity</p><div className="icboxB fx ac jc"><Flame className="i14" /></div></div>
    <div className="cbB fx ac gap20">
      <svg className="rings" viewBox="0 0 100 100">
        {RINGS.map((ring) => (
          <g key={ring.r}>
            <circle cx="50" cy="50" r={ring.r} fill="none" stroke={ring.track} strokeWidth="9" />
            <circle cx="50" cy="50" r={ring.r} fill="none" stroke={ring.color} strokeWidth="9" strokeLinecap="round" strokeDasharray={ring.dash} strokeDashoffset={ring.off} transform="rotate(-90 50 50)" />
          </g>
        ))}
      </svg>
      <div className="f1">
        <div className="actrow"><span className="actk">Move</span><span className="actv">520 / 650 cal</span></div>
        <div className="actrow"><span className="actk">Exercise</span><span className="actv">38 / 60 min</span></div>
        <div className="actrow"><span className="actk">Stand</span><span className="actv">9 / 12 hr</span></div>
        <p className="metaB" style={{ marginTop: 8 }}>On track — one short walk to close your rings.</p>
      </div>
    </div>
  </div>
));
AtlasActivityCard.displayName = 'AtlasActivityCard';

// ---------------------------------------------------------------------------
// World clock — real times, minute tick.

const CITIES = [
  { city: 'San Francisco', tz: 'America/Los_Angeles' },
  { city: 'London', tz: 'Europe/London' },
  { city: 'Tokyo', tz: 'Asia/Tokyo' },
] as const;

function cityTimes() {
  const now = new Date();
  const localDay = now.toLocaleDateString('en-CA');
  return CITIES.map(({ city, tz }) => {
    const time = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const day = now.toLocaleDateString('en-CA', { timeZone: tz });
    const rel = day === localDay ? 'Today' : day > localDay ? 'Tomorrow' : 'Yesterday';
    return { city, time, rel };
  });
}

export const AtlasWorldClockCard = memo(() => {
  const [rows, setRows] = useState(cityTimes);
  useEffect(() => {
    const id = window.setInterval(() => setRows(cityTimes()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="cardB d4" style={{ cursor: 'default' }}>
      <div className="chB"><p className="mlblB">World clock</p><div className="icboxB fx ac jc"><Globe className="i14" /></div></div>
      <div className="cbB">
        {rows.map((r, i) => (
          <div className={`wclk ${i === rows.length - 1 ? 'last' : ''}`} key={r.city}>
            <div><p className="wcity m0">{r.city}</p><p className="wsub m0">{r.rel}</p></div>
            <span className="wtime">{r.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
AtlasWorldClockCard.displayName = 'AtlasWorldClockCard';
