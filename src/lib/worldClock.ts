// World-clock rows shared by the dashboard card (AtlasExtraCards) and the
// widget catalog preview (widgetCatalog/useCatalogWidgets) — both used to
// carry their own copy of CITIES/cityTimes with an independent 30s
// setInterval, so a window that was merely open (not even visible) still
// paid two live timer ticks. Extracted here, 2026-08-11 audit (plausible:
// world-clock duplication), so there is one definition to keep correct and
// one place to gate against a hidden window.

export const CITIES = [
  { city: 'San Francisco', tz: 'America/Los_Angeles' },
  { city: 'London', tz: 'Europe/London' },
  { city: 'Tokyo', tz: 'Asia/Tokyo' },
] as const;

export interface CityTimeRow {
  city: string;
  time: string;
  rel: string;
}

export function cityTimes(): CityTimeRow[] {
  const now = new Date();
  const localDay = now.toLocaleDateString('en-CA');
  return CITIES.map(({ city, tz }) => {
    const time = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const day = now.toLocaleDateString('en-CA', { timeZone: tz });
    const rel = day === localDay ? 'Today' : day > localDay ? 'Tomorrow' : 'Yesterday';
    return { city, time, rel };
  });
}
