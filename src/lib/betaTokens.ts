/**
 * Beta design tokens — the TS mirror of the `--b-*` variables in
 * src/styles/beta.css. Values are from `Atlas Beta Guidelines.dc.html`
 * (design/current/design_handoff_atlas_beta), sections 01 Foundations, 02
 * Shape & space, 07 Sphere and 08 Motion.
 *
 * Use these where a value has to reach code (canvas paint, particle budgets,
 * timings); use the CSS variables for everything the stylesheet can do.
 */

/** Paper scale: each layer steps lighter; recessed areas step darker. */
export const PAPER = {
  page: '#f9f7f4',
  panel: '#f1eeea',
  card: '#fffdfa',
  recessed: '#e8e4de',
  hover: '#edebe7',
  emphasis: '#eef2fe',
  destructiveHover: '#f7e6e4',
} as const;

export const COLOUR = {
  blue: '#3461f2',
  blueDeep: '#2748bd',
  blueHover: '#e2e9fd',
  ink: '#1e1e24',
  ink2: '#6d6a67',
  neutral: '#8b8681',
  tertiary: '#b6b1aa',
  green: '#0fae76',
  greenDeep: '#0a7a53',
  greenFill: '#e3f4ec',
  red: '#d0453a',
  redDeep: '#a3352c',
  /** Text on ink: small text never below .62, body .78. */
  onInkSmall: 'rgba(249,247,244,.62)',
  onInkBody: 'rgba(249,247,244,.78)',
  onInk: '#f9f7f4',
} as const;

/** Radius gets smaller as you nest deeper. */
export const RADIUS = {
  band: 32,
  hero: 28,
  card: 24,
  panel: 22,
  inset: 16,
  row: 14,
  small: 12,
  pill: 9999,
} as const;

export const SPACE = { row: 6, surface: 12, column: 22, page: 26 } as const;

export const CONTROL = { action: 36, chip: 34, inRow: 28, input: 42, dock: 42, topBar: 64 } as const;

export const MOTION = {
  spring: 'cubic-bezier(.22,1,.36,1)',
  entranceMs: 600,
  staggerMs: 40,
  fillMs: 200,
  overlayMs: 320,
  /** Route transitions (atlas-transition.js): old / new / sphere group. */
  routeOutMs: 260,
  routeInMs: 380,
  routeInDelayMs: 60,
  orbMorphMs: 620,
  routeEase: 'cubic-bezier(.32,.72,.24,1)',
} as const;

/** Particle budgets from §07: 20k in a band, ~4k at mini size. */
export const SPHERE = {
  bandCount: 20000,
  heroCount: 14000,
  shortBandCount: 9000,
  miniCount: 4500,
  orbCount: 5200,
  panelCount: 9000,
  /** Inner 72% of the sphere is the hit area. */
  hitFraction: 0.72,
  /** The veil colours on paper (dust / strand) and on ink. */
  paper: { dust: [122, 148, 246] as const, strand: [52, 97, 242] as const, alpha: 0.62 },
  ink: { dust: [92, 122, 248] as const, strand: [176, 196, 255] as const, alpha: 0.55 },
} as const;

export const FONT = {
  display: "'Hanken Grotesk', 'Geist', system-ui, sans-serif",
  ui: "'Geist', system-ui, -apple-system, sans-serif",
  mono: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;
