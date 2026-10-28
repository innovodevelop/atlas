import { useMemo, useSyncExternalStore } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { createSharedPoll } from '@/lib/sharedStore';
import { locationKey, useWeatherLocation } from '@/lib/weatherLocation';

export interface WeatherData {
  location: string;
  temp: number;
  condition: string;
  humidity: number;
  windSpeed: number;
  icon: string;
  sunrise: string;
  sunset: string;
  hourly: Array<{
    time: string;
    temp: number;
    icon: string;
    /** Chance of precipitation in this 3-hour slice, 0–100. Absent from the sample and the "now" fallback. */
    pop?: number | null;
    /** Rain expected in this 3-hour slice, mm (OpenWeather `rain.3h`; 0 when none is forecast). */
    rain?: number | null;
    feelsLike?: number | null;
    /** Wind in this slice, in the reading's unit (mph). */
    wind?: number | null;
  }>;
  daily?: Array<{
    day: string;
    high: number;
    low: number;
    icon: string;
  }>;
  high?: number;
  low?: number;
  /** How warm it feels now. Only on a real reading. */
  feelsLike?: number | null;
  /** Wind direction in degrees (meteorological: where it blows from). */
  windDeg?: number | null;
  windGust?: number | null;
  /**
   * OpenWeather air quality: aqi 1–5 scale + PM2.5 µg/m³, and PM10, O₃ and
   * NO₂ in µg/m³ when the station reports them (null when it does not).
   */
  air?: { aqi: number; pm25: number; pm10?: number | null; o3?: number | null; no2?: number | null } | null;
}

const FALLBACK_WEATHER: WeatherData = {
  location: 'San Francisco',
  temp: 68,
  condition: 'Partly Cloudy',
  humidity: 65,
  windSpeed: 12,
  icon: 'partly-cloudy',
  sunrise: '6:42 AM',
  sunset: '5:24 PM',
  hourly: [
    { time: 'Now', temp: 68, icon: 'partly-cloudy' },
    { time: '12PM', temp: 71, icon: 'sunny' },
    { time: '3PM', temp: 72, icon: 'sunny' },
    { time: '6PM', temp: 69, icon: 'partly-cloudy' },
    { time: '9PM', temp: 64, icon: 'cloudy' },
  ],
  daily: [
    { day: 'Today', high: 72, low: 58, icon: 'partly-cloudy' },
    { day: 'Tue', high: 70, low: 57, icon: 'sunny' },
    { day: 'Wed', high: 68, low: 56, icon: 'cloudy' },
    { day: 'Thu', high: 66, low: 55, icon: 'rainy' },
    { day: 'Fri', high: 69, low: 56, icon: 'partly-cloudy' },
    { day: 'Sat', high: 71, low: 58, icon: 'sunny' },
    { day: 'Sun', high: 73, low: 59, icon: 'sunny' },
  ],
  high: 72,
  low: 58,
};

const REFRESH_MS = 30 * 60 * 1000;

/**
 * ONE fetch per city for the whole app.
 *
 * This hook used to be a per-mount edge-function call, and the plain dashboard
 * mounts it FIVE times (hero card, atmosphere canvas, expanded view, widget
 * catalog, band narration) — ten calls to a rate-limited external API to draw
 * one screen, then five 30-minute timers. It now reads a shared store; see
 * `src/lib/sharedStore.ts`.
 *
 * The return shape is unchanged on purpose: every caller destructures
 * `{ weather }` (some also `error`), and the point of this change is that none
 * of them had to notice it.
 *
 * Where: with no `city`, the place the user picked on the Weather screen
 * (src/lib/weatherLocation.ts), else the city this Mac's time zone names —
 * no longer a fixed "San Francisco". A picked place is asked for by its
 * coordinates, so two towns of the same name cannot be confused. `location`
 * is returned so a screen can say where the reading is for and how it chose.
 */
export const useWeather = (cityOverride?: string) => {
  const place = useWeatherLocation();
  const city = cityOverride ?? place.city;
  const lat = cityOverride ? null : place.lat;
  const lon = cityOverride ? null : place.lon;
  const key = locationKey({ city, lat, lon });

  const fallbackData = useMemo(() => ({
    ...FALLBACK_WEATHER,
    location: city,
  }), [city]);

  const poll = useMemo(
    () =>
      createSharedPoll<WeatherData>({
        key: `weather:${key}`,
        fetch: async () => {
          const { data, error } = await supabase.functions.invoke('get-weather', {
            body: lat != null && lon != null ? { city, lat, lon } : { city },
          });
          if (error) throw error;
          return data as WeatherData;
        },
        intervalMs: REFRESH_MS,
      }),
    // `key` names city, lat and lon together; the closure reads the same three.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const snap = useSyncExternalStore(poll.subscribe, poll.getSnapshot, poll.getSnapshot);

  return {
    // Never null — fall back to representative data until the fetch resolves,
    // and on a first fetch that never does.
    weather: snap.data ?? fallbackData,
    /**
     * True when `weather` above is the built-in sample rather than a reading.
     *
     * Additive, and it exists because `error` STOPPED ANSWERING THIS QUESTION.
     * Before the shared-store port, any error swapped the sample in, so
     * `error != null` meant "you are looking at canned data" and the widget
     * catalog said so on that basis. The store now keeps the last good reading
     * across a failed refresh — better behaviour — which made that inference
     * false and turned the catalog into a liar about real numbers. Callers that
     * need to distinguish "canned" from "stale" must read this, not `error`.
     */
    isFallback: snap.data == null,
    isLoading: snap.isLoading,
    error: snap.error,
    refetch: poll.refresh,
    /** Where the reading is for and how that place was chosen. */
    place: cityOverride ? null : place,
  };
};
