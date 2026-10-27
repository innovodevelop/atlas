/**
 * The Beta Answer screen's reading of a question (`Atlas Answer Views
 * Beta.dc.html`): which shape the answer takes, and what the screen says while
 * Atlas is thinking. The brain answers in markdown; the shape decides which
 * real strip sits above the composed answer (the hourly sky for weather, the
 * link to Money for spending) — never invented figures.
 */
export type AnswerShape = 'weather' | 'money' | 'travel' | 'compare' | 'person' | 'explain';

export const SHAPE_NAME: Record<AnswerShape, string> = {
  weather: 'Weather', money: 'Money', travel: 'Travel', compare: 'Comparison', person: 'Person', explain: 'Explainer',
};

/** The design's `classify(q)`, kept word for word where it was sensible. */
export function classify(q: string): AnswerShape {
  const t = q.toLowerCase();
  if (/umbrella|\brain(y|ing|s)?\b|weather|jacket|forecast|sunny|\bsnow|temperature|degrees/.test(t)) return 'weather';
  if (/spend|spent|cost|money|budget|€|\$|kr\b|invoice|paid|bill/.test(t)) return 'money';
  if (/train|bus|metro|flight|depart|leave for|get to|commute|next .* to /.test(t)) return 'travel';
  if (/compare|versus| vs |which is better|which one|or the /.test(t)) return 'compare';
  if (/who is|who's|what do i know about|tell me about/.test(t) || /about [A-Z][a-z]+ [A-Z]/.test(q)) return 'person';
  return 'explain';
}

export const STEPS: Record<AnswerShape, [string, string]> = {
  weather: ['Checking the forecast…', 'Matching it to your calendar…'],
  money: ['Reading your transactions…', 'Grouping by category…'],
  travel: ['Looking up departures…', 'Checking delays…'],
  compare: ['Reading both sides…', 'Weighing what you said matters…'],
  person: ['Searching mail and calendar…', 'Reading what Atlas remembers…'],
  explain: ['Reading up…', 'Writing it in plain words…'],
};

/** The headline: the answer's first sentence, as the design's header shows it. */
export function headlineOf(text: string, max = 140): string {
  const flat = text.replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const m = flat.match(/^(.{12,}?[.!?])(\s|$)/);
  const first = m ? m[1] : flat;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** The question the screen was opened with: `?q=` first, then router state. */
export function questionFrom(search: string, state: unknown): string | null {
  const q = new URLSearchParams(search).get('q')?.trim();
  if (q) return q;
  const s = state as { q?: unknown } | null;
  return typeof s?.q === 'string' && s.q.trim() ? s.q.trim() : null;
}
