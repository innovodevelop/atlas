/**
 * Weather — the WebGL sky (src/lib/weatherSky.ts) behind the reading, the sun
 * or moon at the top left, the forecast's hours to tap and preview, the week,
 * the air.
 *
 * Everything comes from `useWeather` (the Rust fetch): the sky follows the
 * current hour and the real condition, a tapped hour shows that slice's sky,
 * the arc is drawn from the real sunrise and sunset. The strip shows the
 * slices the forecast has (five, three hours apart), not the design's
 * twenty-four — no slice is made up. The moon's phase is the synodic month's
 * arithmetic. Until a reading arrives the sample is stamped as such.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWeather } from '@/hooks/useWeather';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import type { IconName } from '@/components/atlas/icons';
import { mountSky, type SkyHandle } from '@/lib/weatherSky';
import {
  airAdvice, aqiTone, aqiWord, bodyLook, clock24, dayBars, daylightLabel, hourOfLabel, iconWord, moonPhase,
  parseClockLabel, pm25Fraction, ringOffset, skyMix, skyWord, sunArc,
  feelsLine, pollutantRows, rainFraction, sliceRain, windFrom,
} from '@/lib/betaViews';
import { placeLabel, searchPlaces, setWeatherPlace, type WeatherPlace } from '@/lib/weatherLocation';
import { escapeBlurs } from './fieldKeys';
import { useTick } from './useTick';

const ICON_OF: Record<string, IconName> = { 'sunny': 'sun', 'partly-cloudy': 'partly cloudy', 'cloudy': 'cloud', 'rainy': 'rain', 'stormy': 'rain', 'snowy': 'cloud' };
const SUN_BG = 'radial-gradient(circle at 42% 38%, #fffbe8 0%, #ffe08a 28%, #ffc247 55%, #f39a1e 100%)';
const MOON_BG = 'radial-gradient(circle at 30% 28%, rgba(0,0,0,.10) 0 9%, transparent 10%), radial-gradient(circle at 62% 58%, rgba(0,0,0,.09) 0 13%, transparent 14%), radial-gradient(circle at 48% 76%, rgba(0,0,0,.07) 0 7%, transparent 8%), radial-gradient(circle at 70% 30%, rgba(0,0,0,.06) 0 6%, transparent 7%), radial-gradient(circle at 36% 34%, #fbfaf5 0%, #e4e0d6 55%, #bdb8ad 100%)';
const SUN_GLOW = '0 0 30px 10px rgba(255,196,90,.55), 0 0 90px 36px rgba(255,170,60,.22)';
const MOON_GLOW = '0 0 26px 6px rgba(240,236,226,.28), 0 0 70px 24px rgba(200,210,255,.12)';
/** The air ring's circumference (r 56, as the design). */
const AIR_C = 2 * Math.PI * 56;

export function WeatherView() {
  const { weather, isFallback, isLoading, place } = useWeather();
  const now = useTick(60000);
  const [pick, setPick] = useState<number | null>(null);
  const heroRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sky = useRef<SkyHandle | null>(null);
  const landed = useRef(false);

  const nowDate = new Date(now);
  const nowHour = nowDate.getHours();
  const nowMin = nowHour * 60 + nowDate.getMinutes();
  const sunrise = parseClockLabel(weather.sunrise);
  const sunset = parseClockLabel(weather.sunset);
  const slices = useMemo(
    () => weather.hourly.map((h, i) => ({ ...h, hour: hourOfLabel(h.time, nowHour), key: `${h.time}-${i}` })),
    [weather.hourly, nowHour],
  );
  const picked = pick != null ? slices[pick] ?? null : null;
  const shownHour = picked ? picked.hour : nowHour;
  const shownIcon = picked ? picked.icon : weather.icon;
  const shownTemp = picked ? picked.temp : weather.temp;
  const mix = useMemo(
    () => skyMix(shownIcon, picked ? '' : weather.condition, weather.windSpeed, shownHour, sunrise, sunset),
    [shownIcon, picked, weather.condition, weather.windSpeed, shownHour, sunrise, sunset],
  );
  const look = bodyLook(mix);
  const arc = sunArc(nowMin, sunrise, sunset);
  const moon = moonPhase(now);
  const light = daylightLabel(sunrise, sunset);

  // The light source sits where the sun/moon body is drawn: measure it against the hero.
  const placeLight = useCallback(() => {
    const hero = heroRef.current, body = bodyRef.current, handle = sky.current;
    if (!hero || !body || !handle) return;
    const cr = hero.getBoundingClientRect(), br = body.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    handle.pos((br.left + br.width / 2 - cr.left) / cr.width, 1 - (br.top + br.height / 2 - cr.top) / cr.height);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    sky.current = mountSky(canvas);
    landed.current = false;
    placeLight();
    // The body sits at a fixed inset from the hero's corner, so the light
    // moves only when the hero changes size — its width with the window, its
    // height with the reading's wrap.
    const ro = typeof ResizeObserver === 'function' && heroRef.current ? new ResizeObserver(placeLight) : null;
    if (ro && heroRef.current) ro.observe(heroRef.current);
    return () => {
      ro?.disconnect();
      sky.current?.destroy();
      sky.current = null;
    };
  }, [placeLight]);

  // First reading lands; every later change eases.
  useEffect(() => {
    const handle = sky.current;
    if (!handle) return;
    if (landed.current) handle.set(mix); else { handle.jump(mix); landed.current = true; }
  }, [mix]);
  // The body is the sun or the moon of the hour on show: a previewed night
  // hour gets the moon even while the real sun is up, and the other way round.
  const bodyDay = picked ? mix.night < 1 : arc.day;
  useEffect(() => { placeLight(); }, [bodyDay, placeLight]);

  const line = picked ? skyWord(mix) : weather.condition;
  // What the reading (or the picked slice) says beyond the headline: how warm
  // it feels and the wind. Only fields the forecast carried; the sample has none.
  const feels = feelsLine(shownTemp, picked ? picked.feelsLike : weather.feelsLike);
  const windNow = picked
    ? (picked.wind != null ? `Wind ${Math.round(picked.wind)} mph` : null)
    : isFallback ? null : `Wind ${Math.round(weather.windSpeed)} mph${windFrom(weather.windDeg) ? ` from ${windFrom(weather.windDeg)}` : ''}${weather.windGust != null && weather.windGust > weather.windSpeed ? `, gusts ${Math.round(weather.windGust)}` : ''}`;
  const rainNow = picked ? sliceRain(picked.pop, picked.rain) : null;
  const extra = [feels, windNow, rainNow ? `Rain ${rainNow}` : null].filter(Boolean).join(' · ');
  const when = picked ? `${String(picked.hour).padStart(2, '0')}:00` : 'now';
  const bars = dayBars(weather.daily ?? []);
  const air = weather.air ?? null;
  const tone = air ? aqiTone(air.aqi) : 'good';
  const bodyTitle = bodyDay
    ? `Sun · sets ${sunset != null ? clock24(sunset) : weather.sunset}`
    : `Moon · ${moon.name.toLowerCase()}`;
  const arcTitle = arc.day
    ? `Sun · sets ${sunset != null ? clock24(sunset) : weather.sunset}`
    : `Moon · ${moon.name.toLowerCase()}`;

  return (
    <>
      <section ref={heroRef} className="b-wv-sky" aria-label="Weather now">
        <canvas ref={canvasRef} className="b-wv-sky-canvas" aria-hidden />
        <span className="b-wv-sky-shade" aria-hidden />
        <div
          ref={bodyRef}
          className="b-wv-body"
          title={bodyTitle}
          style={{
            width: bodyDay ? 76 : 64, height: bodyDay ? 76 : 64,
            background: bodyDay ? SUN_BG : MOON_BG, boxShadow: bodyDay ? SUN_GLOW : MOON_GLOW,
            opacity: look.opacity, filter: `blur(${look.blurPx.toFixed(1)}px)`,
          }}
        />
        <div className="b-wv-sky-head">
          <div className="b-wv-sky-read">
            <span className="b-wv-eyebrow b-wv-eyebrow--onink">
              Weather · {weather.location} · {when}
              {isFallback ? <span className="b-wv-stamp" title={isLoading ? 'Sample weather — the reading is on its way' : 'Sample weather — no reading has arrived'}>Sample</span> : null}
            </span>
            <span className="b-wv-temp">{Math.round(shownTemp)}°</span>
            <span className="b-wv-line">
              {line}
              {weather.high != null && weather.low != null ? <> · <span className="b-wv-nowrap">H {Math.round(weather.high)}° L {Math.round(weather.low)}°</span></> : null}
            </span>
            {extra ? <span className="b-wv-line b-wv-line--small">{extra}</span> : null}
          </div>
          <div className="b-wv-arc" aria-label={arc.day ? 'The sun today' : 'The moon tonight'}>
            <svg viewBox="0 0 420 210" aria-hidden><path d="M20 200 A190 190 0 0 1 400 200" fill="none" stroke="rgba(249,247,244,.18)" strokeWidth="2" strokeDasharray="3 7" /></svg>
            <span className="b-wv-arc-dot" title={arcTitle} style={{ left: `${arc.x}%`, top: `${arc.y}%`, background: arc.day ? SUN_BG : MOON_BG, boxShadow: arc.day ? SUN_GLOW : MOON_GLOW }} />
            <span className="b-wv-arc-l b-num">{arc.day ? `${sunrise != null ? clock24(sunrise) : weather.sunrise} sunrise` : `${sunset != null ? clock24(sunset) : weather.sunset} sunset`}</span>
            <span className="b-wv-arc-r b-num">{arc.day ? `${sunset != null ? clock24(sunset) : weather.sunset} sunset` : `${sunrise != null ? clock24(sunrise) : weather.sunrise} sunrise`}</span>
            <span className="b-wv-arc-m">{arc.day ? (light ?? 'Daylight') : `${moon.name} · ${moon.illumination}%`}</span>
          </div>
        </div>
        <div className="b-wv-hours nosb" role="group" aria-label="Forecast hours — tap one to preview its sky">
          {slices.map((h, i) => {
            const on = pick === i;
            const label = h.time === 'Now' ? 'now' : h.time.toLowerCase();
            const rain = sliceRain(h.pop, h.rain);
            return (
              <button key={h.key} type="button" className={`b-wv-hour${on ? ' on' : ''}`} aria-pressed={on} title={`Show the sky at ${label}${rain ? ` · rain ${rain}` : ''}`} onClick={() => setPick(on ? null : i)}>
                <span className="b-wv-hour-t">{Math.round(h.temp)}°</span>
                <AtlasIcon name={ICON_OF[h.icon] ?? 'cloud'} size={14} weight={1.7} />
                {h.pop != null || h.rain != null ? (
                  <span className="b-wv-hour-rain" aria-hidden><span style={{ height: `${Math.round(rainFraction(h.rain) * 100)}%` }} /></span>
                ) : null}
                {h.pop != null && h.pop > 0 ? <span className="b-wv-hour-pop b-num">{Math.round(h.pop)}%</span> : null}
                <span className={`b-wv-hour-l b-num${h.time === 'Now' ? ' now' : ''}`}>{label}</span>
              </button>
            );
          })}
          <span className="b-wv-hours-cap">{picked ? 'Tap the hour again to return to now' : 'Tap an hour to see its sky'}</span>
        </div>
      </section>

      <div className="b-wv-two">
        <section className="b-wv-days" aria-label="Next days">
          <span className="b-wv-h2">{bars.length ? `Next ${bars.length} days` : 'The week'}</span>
          {bars.map((d) => (
            <div key={d.day} className="b-wv-dayrow">
              <span className="b-wv-dayrow-d">{d.day}</span>
              <span className="b-wv-dayrow-c">{iconWord(d.icon)}</span>
              <span className="b-wv-dayrow-lo b-num">{d.lo}°</span>
              <span className="b-wv-dayrow-bar"><span className={d.warm ? 'warm' : ''} style={{ left: `${d.left}%`, width: `${d.width}%` }} /></span>
              <span className="b-wv-dayrow-hi b-num">{d.hi}°</span>
            </div>
          ))}
          {!bars.length ? <div className="b-wv-empty">No forecast for the week yet.</div> : null}
        </section>

        <section className="b-wv-air" aria-label="Air quality">
          <span className="b-wv-h2">Air quality</span>
          {air ? (
            <>
              <div className="b-wv-air-body">
                <div className={`b-wv-air-ring b-wv-air-ring--${tone}`}>
                  <svg viewBox="0 0 130 130" aria-hidden>
                    <circle cx="65" cy="65" r="56" fill="none" stroke="var(--b-panel)" strokeWidth="12" />
                    <circle cx="65" cy="65" r="56" fill="none" strokeWidth="12" strokeLinecap="round" strokeDasharray={AIR_C.toFixed(1)} strokeDashoffset={ringOffset(AIR_C, pm25Fraction(air.pm25))} />
                  </svg>
                  <span className="b-wv-air-mid"><span className="b-wv-air-n">{Math.round(air.pm25)}</span><span className="b-wv-air-w">{aqiWord(air.aqi)}</span></span>
                </div>
                <div className="b-wv-air-rows">
                  {pollutantRows(air).map((r) => (
                    <div key={r.kind} className={`b-wv-air-row b-wv-air-row--b${r.band}`}><span>{r.label}</span><span className="b-wv-air-bar"><span style={{ width: `${Math.round(r.fraction * 100)}%` }} /></span><span className="b-num">{r.value.toFixed(1)}</span></div>
                  ))}
                  <div className="b-wv-air-row"><span>Index</span><span className="b-wv-air-bar"><span style={{ width: `${Math.round(Math.max(0, Math.min(5, air.aqi)) / 5 * 100)}%` }} /></span><span className="b-num">{air.aqi} / 5</span></div>
                  <span className="b-wv-air-note">µg/m³ · OpenWeather's 1–5 index</span>
                </div>
              </div>
              <div className="b-wv-tip"><strong>Atlas:</strong> {airAdvice(air.aqi, air.pm25)}</div>
            </>
          ) : (
            <div className="b-wv-empty">No air reading in this forecast{isFallback ? ' — it arrives with the live reading' : ''}.</div>
          )}
        </section>
      </div>
      {place ? <WeatherPlacePicker label={place.label} source={place.source} /> : null}
    </>
  );
}

/**
 * Where the weather is for (row 4): the place in use and how it was chosen,
 * a search through OpenWeather's geocoding (only the typed text leaves the
 * Mac, with the key already on it), and a way back to this Mac's time zone.
 * The pick is stored on this Mac and every weather reading in Atlas follows it.
 */
function WeatherPlacePicker({ label, source }: { label: string; source: 'picked' | 'timezone' | 'default' }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<WeatherPlace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const how = source === 'picked' ? 'you picked it' : source === 'timezone' ? 'from this Mac’s time zone' : 'the default; pick your place';
  const search = async () => {
    setBusy(true);
    setErr(null);
    try {
      const places = await searchPlaces(q);
      setFound(places);
      if (!places.length) setErr('No place by that name. Try the town and its country, such as “Aarhus, DK”.');
    } catch (e) {
      setFound(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = (p: WeatherPlace) => { setWeatherPlace(p); setFound(null); setQ(''); };
  return (
    <section className="b-wv-place" aria-label="Weather location">
      <span className="b-wv-h2">Location</span>
      <span className="b-wv-sub">{label} · {how}</span>
      <div className="b-wv-add">
        <input
          className="b-wv-add-in"
          placeholder="Search for a town or city"
          aria-label="Search for a place"
          value={q}
          maxLength={100}
          onChange={(e) => { setQ(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); else escapeBlurs(e); }}
        />
        <button type="button" className="b-wv-add-btn" disabled={busy || q.trim().length < 2} onClick={() => void search()}>{busy ? 'Searching…' : 'Search'}</button>
      </div>
      {found?.length ? (
        <div className="b-wv-place-list">
          {found.map((p) => (
            <button key={`${p.lat},${p.lon}`} type="button" className="b-wv-slot" onClick={() => pick(p)}>
              <span className="b-wv-slot-l">{placeLabel(p)}</span>
              <span className="b-wv-slot-act">Use</span>
            </button>
          ))}
        </div>
      ) : null}
      {err ? <p className="b-wv-err">{err}</p> : null}
      {source === 'picked' ? (
        <button type="button" className="b-wv-why-ask" onClick={() => setWeatherPlace(null)}>Use this Mac’s time zone instead</button>
      ) : null}
      <span className="b-wv-free-note">The search sends what you type to OpenWeather with the key on this Mac. The place you pick stays on this Mac; the forecast is asked for by its coordinates.</span>
    </section>
  );
}
