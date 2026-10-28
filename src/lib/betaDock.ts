/**
 * The Beta dock's styles — the handoff's Dock Explorations, chosen in the app.
 *
 * The final dock is the user's call (handoff README, phase 8: "the final dock
 * once Marcus picks one from Atlas Dock Explorations"), and a static design
 * file is a poor place to make it: a dock is something you live with across
 * screens, not something you look at once. So every exploration that is a
 * real dock layout is a style of the one Beta dock, and Settings → Beta UI
 * picks between them. The guideline dock (§09) stays the default until the
 * choice is made; phase 8 then keeps the winner and deletes the rest.
 *
 * The choice lives in `localStorage["atlas:beta_dock"]` and applies at once:
 * unlike the beta_ui flag, nothing is chosen from it at boot, so it is a
 * store the dock subscribes to rather than a reload.
 *
 * Also here, because the tests need them without a DOM: the destination table
 * (Home · Core · Teach · Mail · Architecture · Voice, in the guideline order),
 * keyboard stepping, the sphere hub's split, the colour lane's colours and the
 * status lines several explorations show under or beside an item.
 */
import { useSyncExternalStore } from 'react';
import type { IconName } from '@/components/atlas/icons';
import { STATE_LABEL, type AtlasBusState } from '@/lib/atlasStateBus';

/* ── Styles ──────────────────────────────────────────────────────────────── */

export const DOCK_STYLE_KEY = 'atlas:beta_dock';

/** `guide` is the guideline dock (§09); the rest are boards 3a–3f of the explorations. */
export const DOCK_STYLES = ['guide', 'lens', 'hub', 'rail', 'capsule', 'lane', 'status'] as const;
export type DockStyle = (typeof DOCK_STYLES)[number];
export const DEFAULT_DOCK_STYLE: DockStyle = 'guide';

export interface DockStyleMeta {
  readonly id: DockStyle;
  /** Where it comes from: the guidelines' §09 or the exploration board. */
  readonly board: string;
  readonly name: string;
  /** The design's own one-line description, so the picker says what the board said. */
  readonly description: string;
}

export const DOCK_STYLE_META: readonly DockStyleMeta[] = [
  { id: 'guide', board: '§09', name: 'Guideline', description: 'The dock the guidelines ship: icons at rest, and the current screen as an ink pill with its name.' },
  { id: 'lens', board: '3a', name: 'Lens', description: 'Icon-only at rest. The current screen grows into a labelled pill, and neighbours magnify as you pass.' },
  { id: 'hub', board: '3b', name: 'Sphere hub', description: 'The live sphere sits in the middle as Voice. The current screen fills ink and raises its name like a tag.' },
  { id: 'rail', board: '3c', name: 'Breadcrumb rail', description: 'A slim side rail. The current item shows where you are inside it, not just which app.' },
  { id: 'capsule', board: '3d', name: 'Capsule', description: 'One capsule: the sphere, the screen you’re on and its status. Press ⌘J or tap to fan out every screen.' },
  { id: 'lane', board: '3e', name: 'Colour lane', description: 'A blob slides to the current item, and each screen has its own colour, echoed along the top edge.' },
  { id: 'status', board: '3f', name: 'Status dock', description: 'Every item shows its live state underneath. The current one lifts a status card above the dock.' },
];

export function isDockStyle(v: unknown): v is DockStyle {
  return typeof v === 'string' && (DOCK_STYLES as readonly string[]).includes(v);
}

/** Anything unknown — a typo, a style a later build removed — is the default, never a blank dock. */
export function parseDockStyle(raw: unknown): DockStyle {
  return isDockStyle(raw) ? raw : DEFAULT_DOCK_STYLE;
}

/** The slice of `Storage` the store uses; injected by the tests. */
export interface DockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DockStyleStore {
  get(): DockStyle;
  /** Persist and apply. Storage failing (a private window) still applies it for this session. */
  set(style: DockStyle): void;
  /** Re-read storage — another window of the app changed it. */
  reload(): void;
  subscribe(fn: () => void): () => void;
}

export function createDockStyleStore(storage: () => DockStorage | null): DockStyleStore {
  const read = (): DockStyle => {
    try { return parseDockStyle(storage()?.getItem(DOCK_STYLE_KEY) ?? null); } catch { return DEFAULT_DOCK_STYLE; }
  };
  let current = read();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    get: () => current,
    set(style) {
      try { storage()?.setItem(DOCK_STYLE_KEY, style); } catch { /* private window: this session only */ }
      if (style === current) return;
      current = style;
      emit();
    },
    reload() {
      const next = read();
      if (next === current) return;
      current = next;
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

const store = createDockStyleStore(() => {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
});

export const getDockStyle = (): DockStyle => store.get();
export const setDockStyle = (style: DockStyle): void => store.set(style);
export const reloadDockStyle = (): void => store.reload();

/** The chosen style; re-renders the moment Settings changes it. */
export function useDockStyle(): DockStyle {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/* ── Destinations ────────────────────────────────────────────────────────── */

export type DockDestinationId = 'home' | 'core' | 'teach' | 'mail' | 'architecture' | 'voice';

export interface DockDestination {
  readonly id: DockDestinationId;
  readonly label: string;
  /** The short name where a style has no room for the full one ("Layers"). */
  readonly short: string;
  readonly icon: IconName;
  readonly to: string;
  /** Colour lane: the design's colour for the screen, echoed along the top edge. */
  readonly accent: string;
  /**
   * Colour lane: the blob behind the white label. The accent where white on it
   * reads at 4.5:1; deepened in the same hue where it does not (green, orange,
   * teal), because the label on the blob is 12.5 px text.
   */
  readonly fill: string;
}

/**
 * The guideline order. Every `to` is a registered surface (the test checks),
 * and every style filters this list through the dock's edition rule before it
 * draws, so Architecture never appears in a consumer build whichever style
 * is chosen.
 */
export const DOCK_DESTINATIONS: readonly DockDestination[] = [
  { id: 'home', label: 'Home', short: 'Home', icon: 'home', to: '/', accent: '#3461f2', fill: '#3461f2' },
  { id: 'core', label: 'Core', short: 'Core', icon: 'core', to: '/atlas-core', accent: '#7854ff', fill: '#7854ff' },
  { id: 'teach', label: 'Teach', short: 'Teach', icon: 'teach', to: '/atlas-teach', accent: '#0fae76', fill: '#0a7a53' },
  { id: 'mail', label: 'Mail', short: 'Mail', icon: 'mail', to: '/mail', accent: '#e07a1f', fill: '#a85510' },
  { id: 'architecture', label: 'Architecture', short: 'Layers', icon: 'architecture', to: '/atlas-architecture', accent: '#1e1e24', fill: '#1e1e24' },
  { id: 'voice', label: 'Voice', short: 'Voice', icon: 'voice', to: '/home', accent: '#1696be', fill: '#0f7ea3' },
];

/** Which destination a path is, if any; `/dashboard` is Home's alias. */
export function currentDockId(pathname: string): DockDestinationId | undefined {
  if (pathname === '/dashboard') return 'home';
  return DOCK_DESTINATIONS.find((d) => d.to === pathname)?.id;
}

/**
 * The sphere hub's layout: Voice becomes the sphere in the middle and the
 * rest split around it, the larger half on the left (the board's 3 | 2, and
 * 2 | 2 in a consumer build without Architecture).
 */
export function hubSides<T extends { id: string }>(items: readonly T[]): { left: T[]; hub: T | undefined; right: T[] } {
  const hub = items.find((i) => i.id === 'voice');
  const rest = items.filter((i) => i.id !== 'voice');
  const cut = Math.ceil(rest.length / 2);
  return { left: rest.slice(0, cut), hub, right: rest.slice(cut) };
}

/**
 * The small spheres two styles carry (the hub's Voice button, the capsule's
 * state): the board's own budget, a half of the bottom-left orb's, since the
 * shell already draws that one.
 */
export const DOCK_SPHERE = { count: 2500, scale: 0.42 } as const;

/* ── Keyboard ────────────────────────────────────────────────────────────── */

/**
 * Arrow keys walk the dock, wrapping at the ends; Home and End jump. Both
 * axes work in every style, because the rail is vertical on a desk and a
 * bottom bar at phone width. Every item stays a Tab stop too: arrows are an
 * addition, not a roving tabindex that would change what Tab does.
 */
export function stepIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return index < 0 ? 0 : (index + 1) % count;
    case 'ArrowLeft': case 'ArrowUp': return index < 0 ? count - 1 : (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/* ── Status lines ────────────────────────────────────────────────────────── */

/**
 * What a screen says about itself in the dock: the capsule's status, the
 * status dock's line and badge, the rail's breadcrumb. Every field is
 * optional and nothing is invented: a screen that has not reported shows its
 * name instead.
 */
export interface DockNote {
  /** A sentence: "3 need you · 14 handled". */
  line?: string;
  /** Under the icon in the status dock: "3 new". */
  mini?: string;
  /** The red badge; 0 or absent draws none. */
  count?: number;
  /** Where you are inside the screen, after its name: "Needs you (3)". */
  crumb?: string;
}

export type DockNotes = Readonly<Partial<Record<DockDestinationId, DockNote>>>;

let published: DockNotes = {};
const noteListeners = new Set<() => void>();

/**
 * A screen reports its state to the dock; `null` withdraws it (unmount, sign
 * out). The screens do not publish yet — each one is a single call from the
 * hook that already knows the number — so until they do, only Voice has a
 * line, and it comes from the state bus.
 */
export function publishDockNote(id: DockDestinationId, note: DockNote | null): void {
  const prev = published[id];
  if (!note && !prev) return;
  if (note && prev && note.line === prev.line && note.mini === prev.mini && note.count === prev.count && note.crumb === prev.crumb) return;
  const next: Partial<Record<DockDestinationId, DockNote>> = { ...published };
  if (note) next[id] = { ...note }; else delete next[id];
  published = next;
  noteListeners.forEach((l) => l());
}

function subscribeNotes(fn: () => void): () => void {
  noteListeners.add(fn);
  return () => { noteListeners.delete(fn); };
}

/** Every report the screens have published; a new object per change. */
export const getDockNotes = (): DockNotes => published;

export function useDockNotes(): DockNotes {
  return useSyncExternalStore(subscribeNotes, getDockNotes, getDockNotes);
}

/** Test seam. */
export function _resetDockNotes(): void {
  published = {};
  noteListeners.clear();
}

/** Voice's line, from the state bus — the one status the dock knows without a screen reporting it. */
export function voiceNote(state: AtlasBusState): DockNote {
  const label = STATE_LABEL[state];
  return { line: label, mini: label.toLowerCase() };
}

/** A screen's own report wins over anything derived. */
export function mergeNotes(published: DockNotes, derived: DockNotes): DockNotes {
  const out: Partial<Record<DockDestinationId, DockNote>> = { ...derived };
  for (const [id, note] of Object.entries(published) as [DockDestinationId, DockNote][]) out[id] = note;
  return out;
}

/** The rail's second line under the current item: "Mail › Needs you (3)", else the status, else nothing. */
export function crumbLine(dest: Pick<DockDestination, 'label'>, note: DockNote | undefined): string | null {
  if (note?.crumb) return `${dest.label} › ${note.crumb}`;
  return note?.line ?? null;
}

/** Under the icon in the status dock: the screen's state, or its short name until it reports one. */
export function statusMini(dest: Pick<DockDestination, 'short'>, note: DockNote | undefined): string {
  return note?.mini ?? dest.short;
}

/** The badge number, or null when there is nothing to draw. */
export function badgeCount(note: DockNote | undefined): number | null {
  const n = note?.count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Badges stop at 99; the accessible name keeps the real number. */
export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/**
 * The accessible name of an item: its label, then whatever the style shows
 * of its state, so the name always contains the visible text (WCAG 2.5.3)
 * and a screen reader hears the status a sighted user sees.
 */
export function itemName(dest: Pick<DockDestination, 'label'>, note: DockNote | undefined): string {
  const parts = [dest.label];
  const state = note?.line ?? note?.mini;
  if (state) parts.push(state);
  const n = badgeCount(note);
  if (n !== null && !(state ?? '').includes(String(n))) parts.push(`${n} need you`);
  return parts.join(', ');
}

/* ── Colour ──────────────────────────────────────────────────────────────── */

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` colour. */
export function luminanceOf(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
