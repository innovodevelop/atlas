/**
 * Particle budgets for the Beta spheres — the one table every `VeilSphere`
 * size reads.
 *
 * What a particle costs. Each frame the engine (src/lib/quickSphere.ts) moves
 * half of the particles through seven travelling waves and the veil's curtain
 * field, then projects every particle and blends a 1–2 px dot into an
 * ImageData buffer, then copies that buffer to the canvas. So the work grows
 * in a straight line with the particle count, plus a fixed cost per canvas
 * pixel for the clear and the copy. Nothing here is a measured frame time:
 * this module cannot measure one, and the numbers are not presented as if it
 * had. They are the design's counts and two rules that follow from the cost
 * model above.
 *
 * `count` is the handoff's count for that size (src/lib/betaTokens.ts SPHERE,
 * from the Beta plan: band 20 k, mini 4–5 k), tuned at `box`, the CSS size the
 * sphere's container has on a desktop window (from src/styles/beta.css and the
 * screen stylesheets).
 *
 * Rule 1 — density, not count, is the look. A dot is drawn at a fixed size in
 * device pixels, so a sphere drawn in a smaller box with the same count is not
 * the same sphere smaller: it is denser and muddier, and it costs the same.
 * When the box is smaller than the one the count was tuned for (the band at
 * phone width is 120 px instead of 264), the count follows the box's area, in
 * quarter steps so a window being dragged re-seeds the sphere at most three
 * times, and never below `floor`, under which the veil's curtains break up
 * into loose dots.
 *
 * Rule 2 — the shell's heaviest moment stays inside FRAME_BUDGET. That moment
 * is a band sphere, the Talk panel's sphere and the orb all animating at once
 * (Voice, with Talk open). The reference engine was built around one 24 k
 * sphere on its own page (`atlas-quickstart-sphere.js`, its default count),
 * so the shell allows one and a half of those. The engine warns in
 * development when a screen goes over.
 *
 * A page that passes its own `count` has tuned it for its own box; that count
 * is kept, only capped at SPHERE_MAX so no single sphere outgrows the band.
 */
import { SPHERE } from './betaTokens';

export type SphereSize = 'band' | 'hero' | 'short' | 'panel' | 'orb' | 'mini';

export interface SphereBudget {
  /** Particles at `box` (the handoff's count). */
  count: number;
  /** The container's CSS size (shorter side, px) the count was tuned at. */
  box: number;
  /** Never fewer, however small the box. */
  floor: number;
  /** Where the size is used, so the box can be re-read when a screen changes. */
  where: string;
}

export const SPHERE_BUDGET: Readonly<Record<SphereSize, SphereBudget>> = {
  band: { count: SPHERE.bandCount, box: 264, floor: 6000, where: 'Home and Voice stage band (300 px tall, 18 px padding)' },
  hero: { count: SPHERE.heroCount, box: 240, floor: 4500, where: 'full-view heroes (Agent View 240 px, Answer)' },
  short: { count: SPHERE.shortBandCount, box: 166, floor: 3000, where: 'short band on Mail, Catalog and the screen heroes (190 px, 12 px padding)' },
  panel: { count: SPHERE.panelCount, box: 170, floor: 3000, where: 'Talk panel stage 160 px, Model Lab 170, System Status 180' },
  orb: { count: SPHERE.orbCount, box: 128, floor: 2500, where: 'the bottom-left Talk to Atlas orb' },
  mini: { count: SPHERE.miniCount, box: 110, floor: 1500, where: 'widget faces, rings and stack spheres (110 px)' },
};

/** No single sphere draws more than the band does. */
export const SPHERE_MAX = SPHERE.bandCount;

/** Particles the shell may animate in one frame across every sphere on screen. */
export const FRAME_BUDGET = 36000;

/** A page's own count, kept but bounded. */
export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return SPHERE.miniCount;
  return Math.max(1, Math.min(SPHERE_MAX, Math.round(count)));
}

/**
 * The table's count for a box. An unknown box (0, not laid out yet) gets the
 * full count: the engine re-reads the box on its first resize anyway.
 */
export function fitToBox(budget: SphereBudget, box: number | undefined): number {
  if (!box || !Number.isFinite(box) || box <= 0 || box >= budget.box) return budget.count;
  const area = (box / budget.box) ** 2;
  const step = Math.ceil(area * 4) / 4;
  return Math.max(budget.floor, Math.round((budget.count * step) / 100) * 100);
}

/** What a sphere of `size` draws in a `box` px container, or with its own `count`. */
export function particleBudget(size: SphereSize, opts: { count?: number; box?: number } = {}): number {
  if (opts.count != null) return clampCount(opts.count);
  return fitToBox(SPHERE_BUDGET[size], opts.box);
}
