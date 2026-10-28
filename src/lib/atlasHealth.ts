/**
 * The Core screen's health score, lifted out of useAtlasHealth so the
 * arithmetic is testable without a database.
 *
 * Score = 100 − error rate (unresolved errors in the last 24 h, capped at
 * 100), minus 5 when more than 10 research topics are running at once.
 * Clamped to 0..100 and rounded.
 */
export const RESEARCH_LOAD_THRESHOLD = 10;
export const RESEARCH_LOAD_PENALTY = 5;

/** Errors per 100 operations (simplified): the raw count, capped at 100. */
export function computeErrorRate(recentErrors: number | null | undefined): number {
  return recentErrors ? Math.min(Math.max(0, recentErrors), 100) : 0;
}

export function computeHealthScore(
  errorRate: number,
  activeResearch: number | null | undefined,
): number {
  const researchPenalty = (activeResearch ?? 0) > RESEARCH_LOAD_THRESHOLD ? RESEARCH_LOAD_PENALTY : 0;
  return Math.round(Math.min(100, Math.max(0, 100 - errorRate - researchPenalty)));
}
