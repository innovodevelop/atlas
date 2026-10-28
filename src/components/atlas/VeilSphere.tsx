/**
 * The Beta sphere — a React wrapper around `src/lib/quickSphere.ts` (the
 * handoff's `atlas-quickstart-sphere.js`, veil mode).
 *
 * Every screen shows one, and it always reflects Atlas's real state: leave
 * `state` out and the sphere follows the state bus (`atlasStateBus.ts`); pass
 * it to drive the sphere from a local value (a demo, a preview).
 *
 * Sizing: the canvas fills its parent box. Give large spheres an opaque `bg`
 * matching the panel they sit on (the handoff's performance rule); small ones
 * may use `bg="transparent"` with `tone` set to the fill behind them so the
 * dust colour lifts toward the right paper.
 *
 * Cost: `size` picks a row of the particle budget (src/lib/sphereBudget.ts),
 * and the count follows the box the sphere is actually drawn in, so the band
 * at phone width is not drawing its desktop count into a third of the area.
 * A `count` prop is the page's own tuning and is kept (capped at the band's).
 * When it animates at all is the engine's call (src/lib/spherePause.ts):
 * off-screen, an inactive window, the Settings pause switch and reduced motion
 * all stop it, for every sphere at once.
 */
import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { mount, type QuickSphereHandle, type QuickSphereState, type RGB } from '@/lib/quickSphere';
import { useAtlasState } from '@/lib/atlasStateBus';
import { SPHERE } from '@/lib/betaTokens';
import { particleBudget, type SphereSize } from '@/lib/sphereBudget';

export interface VeilSphereProps {
  /** Omit to follow the state bus. */
  state?: QuickSphereState;
  /** Particle count, tuned by the page for its own box; defaults by `size`. */
  count?: number;
  /** Picks the particle budget when `count` is omitted. */
  size?: SphereSize;
  /** Opaque hex fill, or 'transparent'. Default: the panel paper. */
  bg?: string;
  /** The fill behind a transparent sphere (RGB), for the dust lift. */
  tone?: RGB;
  /** Ink palette (light strands on a dark ground, additive blend). */
  ink?: boolean;
  scale?: number;
  alpha?: number;
  seed?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** Makes the sphere a button (keyboard included); give it a `label`. */
  onClick?: () => void;
  /** Accessible name; the canvas is otherwise decorative. */
  label?: string;
}

export function VeilSphere({
  state, count, size = 'mini', bg, tone, ink = false, scale, alpha, seed = 11,
  className, style, title, onClick, label,
}: VeilSphereProps) {
  const busState = useAtlasState();
  const effective = state ?? busState;
  const ref = useRef<HTMLCanvasElement | null>(null);
  const handle = useRef<QuickSphereHandle | null>(null);

  // The engine calls this with the canvas box on every resize; a new identity
  // only when the size or the page's count changes.
  const fit = useCallback((box: number) => particleBudget(size, { count, box }), [size, count]);
  const palette = ink ? SPHERE.ink : SPHERE.paper;
  const fill = bg ?? (ink ? '#1e1e24' : '#f1eeea');
  const a = alpha ?? palette.alpha;
  const sc = scale ?? 0.42;
  // Pages pass `tone` as an inline array; compare it by value so a parent's
  // re-render does not look like a colour change.
  const toneKey = tone ? tone.join(',') : '';

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    handle.current = mount(el, {
      mode: 'veil',
      bg: fill,
      tone,
      dust: palette.dust,
      strand: palette.strand,
      blend: ink ? 'lighter' : 'source-over',
      alpha: a,
      seed,
      fit,
      scale: sc,
      state: effective,
    });
    return () => { handle.current?.destroy(); handle.current = null; };
    // Palette, blend and seed are identity; everything that can change at
    // runtime goes through set() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ink, seed]);

  useEffect(() => { handle.current?.set({ state: effective }); }, [effective]);
  useEffect(() => { handle.current?.set({ fit }); }, [fit]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `tone` is compared by value through toneKey
  useEffect(() => { handle.current?.set({ bg: fill, tone, alpha: a, scale: sc }); }, [fill, toneKey, a, sc]);

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!onClick || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onClick();
  };
  const role = onClick ? 'button' : label ? 'img' : undefined;

  return (
    <canvas
      ref={ref}
      className={className}
      title={title}
      onClick={onClick}
      onKeyDown={onClick ? onKeyDown : undefined}
      tabIndex={onClick ? 0 : undefined}
      role={role}
      aria-label={label ?? (onClick ? title : undefined)}
      aria-hidden={role ? undefined : true}
      data-state={effective}
      style={{ width: '100%', height: '100%', display: 'block', cursor: onClick ? 'pointer' : undefined, ...style }}
    />
  );
}
