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
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import { mount, type QuickSphereHandle, type QuickSphereState, type RGB } from '@/lib/quickSphere';
import { useAtlasState } from '@/lib/atlasStateBus';
import { SPHERE } from '@/lib/betaTokens';

export interface VeilSphereProps {
  /** Omit to follow the state bus. */
  state?: QuickSphereState;
  /** Particle count; defaults by `size`. */
  count?: number;
  /** Picks the particle budget when `count` is omitted. */
  size?: 'band' | 'hero' | 'short' | 'mini' | 'orb' | 'panel';
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
  onClick?: () => void;
  /** Accessible name; the canvas is otherwise decorative. */
  label?: string;
}

const COUNT_BY_SIZE: Record<NonNullable<VeilSphereProps['size']>, number> = {
  band: SPHERE.bandCount,
  hero: SPHERE.heroCount,
  short: SPHERE.shortBandCount,
  mini: SPHERE.miniCount,
  orb: SPHERE.orbCount,
  panel: SPHERE.panelCount,
};

export function VeilSphere({
  state, count, size = 'mini', bg, tone, ink = false, scale, alpha, seed = 11,
  className, style, title, onClick, label,
}: VeilSphereProps) {
  const busState = useAtlasState();
  const effective = state ?? busState;
  const ref = useRef<HTMLCanvasElement | null>(null);
  const handle = useRef<QuickSphereHandle | null>(null);

  const n = count ?? COUNT_BY_SIZE[size];
  const palette = ink ? SPHERE.ink : SPHERE.paper;
  const fill = bg ?? (ink ? '#1e1e24' : '#f1eeea');
  const a = alpha ?? palette.alpha;
  const sc = scale ?? 0.42;

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
      count: n,
      scale: sc,
      state: effective,
    });
    return () => { handle.current?.destroy(); handle.current = null; };
    // Palette, blend and seed are identity; everything that can change at
    // runtime goes through set() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ink, seed]);

  useEffect(() => { handle.current?.set({ state: effective }); }, [effective]);
  useEffect(() => { handle.current?.set({ count: n }); }, [n]);
  useEffect(() => { handle.current?.set({ bg: fill, tone, alpha: a, scale: sc }); }, [fill, tone, a, sc]);

  return (
    <canvas
      ref={ref}
      className={className}
      title={title}
      onClick={onClick}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={effective}
      style={{ width: '100%', height: '100%', display: 'block', cursor: onClick ? 'pointer' : undefined, ...style }}
    />
  );
}
