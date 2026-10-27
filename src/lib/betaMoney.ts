/**
 * The Beta Money screen's arithmetic — the ring's arcs, the thirty-day line,
 * the money formats — pure and tested here, rendered by BetaMoney.tsx.
 */
import type { AllocSlice, HistoryPoint } from '@/hooks/usePortfolio';

export const ARC_COLOURS = ['#8fa9ff', '#50dca0', '#ffb36b', '#b6a8ff', '#ff9a9a', 'rgba(249,247,244,.5)'];
export const RING_R = 138;
const C = 2 * Math.PI * RING_R;

export function money(v: number, currency = 'USD', digits = 0): string {
  try { return v.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits }); } catch { return `${v.toFixed(digits)} ${currency}`; }
}

export function pct(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
}

export interface RingArc { label: string; colour: string; dash: string; offset: number; share: number }

/** The ring's arcs: each slice's share of the whole, laid end to end; `grown` false draws them at zero for the entrance. */
export function arcsOf(slices: readonly AllocSlice[], grown: boolean): RingArc[] {
  const total = slices.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
  let acc = 0;
  return slices.slice(0, ARC_COLOURS.length).map((s, i) => {
    const share = Math.max(0, s.value) / total;
    const len = grown ? share * C : 0;
    const out = { label: s.label, colour: ARC_COLOURS[i], dash: `${len.toFixed(1)} ${C.toFixed(1)}`, offset: acc === 0 ? 0 : -acc, share };
    acc += len;
    return out;
  });
}

/** The thirty-day line: points on a 300×100 box, newest at the right. */
export function linePoints(history: readonly HistoryPoint[]): { line: string; area: string; min: number; max: number } {
  const pts = history.slice(-30);
  if (pts.length < 2) return { line: '', area: '', min: 0, max: 0 };
  const vals = pts.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const line = pts.map((p, i) => `${((i / (pts.length - 1)) * 300).toFixed(1)},${(100 - ((p.value - min) / span) * 84 - 8).toFixed(1)}`).join(' ');
  return { line, area: `0,100 ${line} 300,100`, min, max };
}

export function initialsOf(s: string): string {
  return s.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}
