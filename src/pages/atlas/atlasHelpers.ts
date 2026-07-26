// Small shared helpers for the Atlas screens.

import { getActiveWakePhrases } from '@/lib/wakeWord';

/** Header status label — mirrors the Workshop design's Atlas state readout. */
export function atlasStateLabel(
  state: string,
  // Defaults to the wake lib's active set so the label only ever advertises
  // phrase(s) the detector can actually hear: stock "Hey Jarvis" today,
  // "Hey Atlas"/"Atlas" automatically once trained models land in
  // public/models/ (see src/lib/wakeWord.ts). getActiveWakePhrases is a pure
  // read — this module stays side-effect-free at import time.
  wakePhrases: string[] = getActiveWakePhrases(),
): string {
  switch (state) {
    case 'listening': return 'Listening…';
    case 'thinking': return 'Thinking…';
    case 'speaking': return 'Speaking…';
    default:
      return wakePhrases.length === 0
        ? 'Listening…'
        : `Listening for ${wakePhrases.map((p) => `"${p}"`).join(' or ')}`;
  }
}

export function timeOfDayGreeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Build an SVG polyline `points` string from a sparkline number series. */
export function sparklinePoints(
  values: number[],
  width = 72,
  height = 22,
  pad = 3,
): string {
  if (!values || values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  return values
    .map((v, i) => {
      const x = Math.round(i * step);
      const y = Math.round(pad + (height - pad * 2) * (1 - (v - min) / span));
      return `${x},${y}`;
    })
    .join(' ');
}

/** Format a change percent like the design: +1.24% / −0.58% (real minus sign). */
export function fmtPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '−';
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

/** Relative-ish time label for calendar rows. */
export function fmtEventTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
