/**
 * The Beta Health screen's arithmetic (`Atlas Health Beta.dc.html`): the
 * readiness rings from the day's real figures, the bars and sparklines from
 * the store's series, the sleep stages, the local day log. Pure, tested here.
 *
 * The design's readiness is a single number from sleep, recovery and
 * activity. Here each ring is a plain ratio against a goal the screen states
 * (8 h asleep, 500 kcal, heart rate against the week's average), and the
 * number is their mean — never a score Atlas cannot explain.
 */
import type { SeriesRow } from '@/hooks/useHealthSeries';

export const GOALS = { sleepMinutes: 480, activeKcal: 500, steps: 10000 } as const;

export const METRIC = {
  steps: 'steps',
  asleep: 'sleep_asleep_minutes',
  deep: 'sleep_deep_minutes',
  core: 'sleep_core_minutes',
  rem: 'sleep_rem_minutes',
  awake: 'sleep_awake_minutes',
  heart: 'heart_rate_bpm',
  hrv: 'heart_rate_variability_ms',
  energy: 'active_energy_kcal',
  exercise: 'exercise_minutes',
  stand: 'stand_minutes',
  distance: 'distance_walking_running_km',
} as const;

/** "7h 12m" → 432, "48m" → 48. */
export function parseMinutes(s: string | undefined | null): number | null {
  if (!s) return null;
  const h = s.match(/(\d+)\s*h/), m = s.match(/(\d+)\s*m/);
  if (!h && !m) return null;
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

/** "8,213" → 8213, "64 ms" → 64. */
export function numberOf(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export type RingKey = 'sleep' | 'recovery' | 'activity';

export interface Ring {
  key: RingKey;
  label: string;
  r: number;
  colour: string;
  /** 0–1, or null when the figure is missing. */
  fraction: number | null;
  value: string;
  why: string;
}

export interface RingInputs {
  asleep?: string | null;
  deep?: string | null;
  energy?: string | null;
  exercise?: string | null;
  /** Heart-rate series, newest first. */
  heart?: readonly SeriesRow[];
}

export function ringsFrom(i: RingInputs): Ring[] {
  const asleep = parseMinutes(i.asleep);
  const kcal = numberOf(i.energy);
  const sleep: Ring = {
    key: 'sleep', label: 'Sleep', r: 128, colour: '#8fa9ff',
    fraction: asleep == null ? null : Math.min(1, asleep / GOALS.sleepMinutes),
    value: i.asleep ?? '—',
    why: asleep == null ? 'no sleep in the export' : i.deep ? `deep ${i.deep}` : asleep >= GOALS.sleepMinutes ? 'a full night' : `${Math.round(GOALS.sleepMinutes - asleep)} min short of 8 h`,
  };
  const hr = i.heart ?? [];
  const today = hr[0]?.raw ?? null;
  const rest = hr.slice(1).map((r) => r.raw);
  const avg = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : null;
  const recovery: Ring = {
    key: 'recovery', label: 'Recovery', r: 104, colour: '#50dca0',
    fraction: today == null || avg == null || today <= 0 ? null : Math.max(0, Math.min(1, avg / today)),
    value: today == null ? '—' : `${Math.round(today)} bpm`,
    why: today == null ? 'no heart rate yet' : avg == null ? 'needs a second day' : today <= avg ? 'at or under your week' : `${Math.round(today - avg)} bpm over your week`,
  };
  const activity: Ring = {
    key: 'activity', label: 'Activity', r: 80, colour: '#ffb36b',
    fraction: kcal == null ? null : Math.min(1, kcal / GOALS.activeKcal),
    value: kcal == null ? '—' : `${Math.round(kcal)} / ${GOALS.activeKcal} kcal`,
    why: kcal == null ? 'no activity in the export' : kcal >= GOALS.activeKcal ? 'goal met' : i.exercise ? `${i.exercise} exercise` : `${Math.round(GOALS.activeKcal - kcal)} kcal to go`,
  };
  return [sleep, recovery, activity];
}

export function readiness(rings: readonly Ring[]): number | null {
  const have = rings.filter((r) => r.fraction != null);
  if (!have.length) return null;
  return Math.round((have.reduce((a, r) => a + (r.fraction as number), 0) / have.length) * 100);
}

export function readinessWord(n: number | null): string {
  if (n == null) return 'No readings yet';
  if (n >= 75) return 'Good to go';
  if (n >= 50) return 'Take it steady';
  return 'Rest day';
}

export function headlineFor(ring: RingKey | null, rings: readonly Ring[], n: number | null): { title: string; sub: string } {
  const by = Object.fromEntries(rings.map((r) => [r.key, r])) as Record<RingKey, Ring>;
  if (ring === 'sleep') return { title: by.sleep.fraction == null ? 'No sleep recorded.' : by.sleep.fraction >= 0.9 ? 'Sleep carried today.' : 'A short night.', sub: `${by.sleep.value} asleep, ${by.sleep.why}.` };
  if (ring === 'recovery') return { title: by.recovery.fraction == null ? 'No heart rate yet.' : by.recovery.fraction >= 0.95 ? 'Your body bounced back.' : 'Still catching up.', sub: `Heart rate ${by.recovery.value}, ${by.recovery.why}.` };
  if (ring === 'activity') return { title: by.activity.fraction == null ? 'No activity recorded.' : by.activity.fraction >= 1 ? 'A full day of movement.' : 'Room to move.', sub: `${by.activity.value}, ${by.activity.why}.` };
  if (n == null) return { title: 'Nothing to read yet.', sub: 'Import a Health export on this Mac and the rings fill from your own figures.' };
  if (n >= 75) return { title: 'A good day for the long run.', sub: 'Sleep, recovery and movement are all in a good place.' };
  if (n >= 50) return { title: 'An even day.', sub: 'One of the three is behind; pick the ring to see which.' };
  return { title: 'Go easy today.', sub: 'The figures say rest more than they say push.' };
}

export interface Bar { day: string; raw: number; label: string; pct: number; over: boolean }

/** Oldest → newest; heights against the goal with headroom so an over-goal day still fits. */
export function barsFrom(rows: readonly SeriesRow[], goal: number): Bar[] {
  const asc = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  const top = Math.max(goal * 1.2, ...asc.map((r) => r.raw), 1);
  return asc.map((r) => ({ day: r.day, raw: r.raw, label: r.value, pct: Math.max(3, Math.round((r.raw / top) * 100)), over: r.raw >= goal }));
}

export function goalLinePct(goal: number, bars: readonly Bar[]): number {
  const top = Math.max(goal * 1.2, ...bars.map((b) => b.raw), 1);
  return Math.round((goal / top) * 100);
}

/** Points on a 100×30 box, oldest → newest. */
export function sparkOf(rows: readonly SeriesRow[]): string {
  const asc = [...rows].sort((a, b) => a.day.localeCompare(b.day)).map((r) => r.raw);
  if (asc.length < 2) return '';
  const min = Math.min(...asc), max = Math.max(...asc), span = max - min || 1;
  return asc.map((v, i) => `${((i / (asc.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 26).toFixed(1)}`).join(' ');
}

/** "+8 ms on the week" — today against the mean of the earlier days. */
export function trendOf(rows: readonly SeriesRow[]): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (rows.length < 2) return { text: rows.length ? 'one day so far' : 'no readings', dir: 'flat' };
  const today = rows[0].raw;
  const rest = rows.slice(1).map((r) => r.raw);
  const avg = rest.reduce((a, b) => a + b, 0) / rest.length;
  const d = today - avg;
  const unit = rows[0].unit ? ` ${rows[0].unit}` : '';
  if (Math.abs(d) < Math.max(0.5, Math.abs(avg) * 0.02)) return { text: 'steady', dir: 'flat' };
  const n = Math.abs(d) >= 10 ? Math.round(Math.abs(d)).toLocaleString() : Math.abs(d).toFixed(1);
  return { text: `${d > 0 ? '+' : '−'}${n}${unit} on the week`, dir: d > 0 ? 'up' : 'down' };
}

export interface Stage { key: 'deep' | 'core' | 'rem' | 'awake'; label: string; colour: string; minutes: number; value: string }

export function stagesFrom(cards: { deep?: string | null; core?: string | null; rem?: string | null; awake?: string | null }): Stage[] {
  const defs: [Stage['key'], string, string, string | null | undefined][] = [
    ['deep', 'Deep', '#3461f2', cards.deep], ['core', 'Core', '#b6c6ff', cards.core], ['rem', 'REM', '#8fa9ff', cards.rem], ['awake', 'Awake', '#e07a1f', cards.awake],
  ];
  return defs.flatMap(([key, label, colour, v]) => { const m = parseMinutes(v); return m == null ? [] : [{ key, label, colour, minutes: m, value: v as string }]; });
}

export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { weekday: 'short' });
}

/** The day's own log — water and mood — kept on this Mac only. */
export interface DayLog { water: number; mood: string | null }
export const MOODS = ['Low', 'Meh', 'Okay', 'Good', 'Great'] as const;
export const GLASSES = 8;
export const logKey = (today: string) => `atlas:health_log:${today}`;

export function parseLog(raw: string | null): DayLog {
  try {
    const v = raw ? JSON.parse(raw) as Partial<DayLog> : null;
    const water = typeof v?.water === 'number' ? Math.max(0, Math.min(GLASSES, Math.round(v.water))) : 0;
    const mood = typeof v?.mood === 'string' && (MOODS as readonly string[]).includes(v.mood) ? v.mood : null;
    return { water, mood };
  } catch { return { water: 0, mood: null }; }
}
