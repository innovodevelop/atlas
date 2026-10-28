/**
 * Where the weather is for (Beta row 4). Every `useWeather()` reads this
 * instead of the fixed "San Francisco" it used to default to: the place the
 * user picked on the Weather screen (found through OpenWeather's geocoding,
 * src-tauri/src/datafetch.rs `weather_geocode`, with the key already on this
 * Mac), and until they pick one, the city this Mac's time zone names
 * ("Europe/Copenhagen" → Copenhagen) — a place the user's own settings point
 * at, said to be that on the screen. Stored in local storage
 * 'atlas:weather_location'; it never leaves the Mac except as the place the
 * forecast is asked for.
 */
import { useSyncExternalStore } from 'react';

export interface WeatherPlace {
  name: string;
  /** ISO 3166 country code from the geocoder, e.g. "DK". */
  country: string;
  state?: string | null;
  lat: number;
  lon: number;
}

export interface WeatherLocation {
  /** What the forecast is asked for. */
  city: string;
  lat: number | null;
  lon: number | null;
  /** Where it came from: the user's pick, this Mac's time zone, or the old default. */
  source: 'picked' | 'timezone' | 'default';
  /** "Aarhus, DK" — for the screen. */
  label: string;
}

export const LOCATION_KEY = 'atlas:weather_location';
export const FALLBACK_CITY = 'San Francisco';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validPlace(v: unknown): WeatherPlace | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 100) : '';
  if (!name || !finite(o.lat) || !finite(o.lon)) return null;
  if (Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180) return null;
  return {
    name,
    country: typeof o.country === 'string' ? o.country.slice(0, 3) : '',
    state: typeof o.state === 'string' ? o.state.slice(0, 100) : null,
    lat: o.lat,
    lon: o.lon,
  };
}

export function parsePlace(raw: string | null): WeatherPlace | null {
  if (!raw) return null;
  try { return validPlace(JSON.parse(raw)); } catch { return null; }
}

/** "Aarhus, Central Denmark Region, DK" without the empty parts. */
export function placeLabel(p: Pick<WeatherPlace, 'name' | 'country' | 'state'>): string {
  return [p.name, p.state, p.country].filter((x) => !!x && String(x).trim()).join(', ');
}

/** The city an IANA zone names, or null when it names none ("Etc/UTC", "UTC"). */
export function cityOfZone(zone: string | null | undefined): string | null {
  if (!zone || !zone.includes('/') || /^(Etc|SystemV)\//.test(zone)) return null;
  const last = zone.split('/').pop() ?? '';
  const city = last.replace(/_/g, ' ').trim();
  return city && !/^(GMT|UTC|UCT)/i.test(city) ? city : null;
}

/** What `useWeather` asks for: the pick, else the time zone's city, else the old default. */
export function resolveLocation(place: WeatherPlace | null, zone: string | null | undefined): WeatherLocation {
  if (place) return { city: place.name, lat: place.lat, lon: place.lon, source: 'picked', label: placeLabel(place) };
  const tzCity = cityOfZone(zone);
  if (tzCity) return { city: tzCity, lat: null, lon: null, source: 'timezone', label: tzCity };
  return { city: FALLBACK_CITY, lat: null, lon: null, source: 'default', label: FALLBACK_CITY };
}

/** The shared poll's key: it must name everything the request carries. */
export function locationKey(l: Pick<WeatherLocation, 'city' | 'lat' | 'lon'>): string {
  return l.lat != null && l.lon != null ? `${l.city}@${l.lat.toFixed(4)},${l.lon.toFixed(4)}` : l.city;
}

// --- The store ----------------------------------------------------------------------

const systemZone = (): string | null => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null; } catch { return null; }
};

type Listener = () => void;
const listeners = new Set<Listener>();
let current: WeatherLocation = resolveLocation(
  (() => { try { return parsePlace(typeof window === 'undefined' ? null : window.localStorage.getItem(LOCATION_KEY)); } catch { return null; } })(),
  systemZone(),
);

/** Pick a place (from the search), or null to go back to this Mac's time zone. */
export function setWeatherPlace(place: WeatherPlace | null): void {
  const valid = place ? validPlace(place) : null;
  try {
    if (valid) window.localStorage.setItem(LOCATION_KEY, JSON.stringify(valid));
    else window.localStorage.removeItem(LOCATION_KEY);
  } catch { /* private window: this session keeps the pick */ }
  current = resolveLocation(valid, systemZone());
  listeners.forEach((l) => l());
}

const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getLocation = () => current;

export function useWeatherLocation(): WeatherLocation {
  return useSyncExternalStore(subscribe, getLocation, getLocation);
}
