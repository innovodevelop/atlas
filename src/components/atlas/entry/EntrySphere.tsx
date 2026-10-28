/**
 * The Entry sphere — the veil engine on the blue aside, with the palette the
 * design mounts it with (`Atlas Entry Beta.dc.html`: paper strands and a pale
 * blue dust on Atlas Blue, 16 000 particles).
 *
 * `VeilSphere` carries the two shared palettes (paper, ink) and this screen
 * needs a third, so it mounts the same engine directly rather than widening
 * the shared component for one caller. The contract is the same: leave
 * `state` out and the sphere follows the state bus; pass it to drive the
 * sphere from the conversation (speaking while a line types, listening while
 * the microphone is open, thinking while the account server answers).
 */
import { useEffect, useRef } from 'react';
import { mount, type QuickSphereHandle, type QuickSphereState } from '@/lib/quickSphere';
import { useAtlasState } from '@/lib/atlasStateBus';

const ENTRY_SPHERE = {
  bg: '#3461f2',
  dust: [214, 224, 255] as const,
  strand: [255, 253, 250] as const,
  alpha: 0.7,
  count: 16000,
  scale: 0.42,
  seed: 11,
} as const;

export function EntrySphere({ state, label }: { state?: QuickSphereState; label?: string }) {
  const bus = useAtlasState();
  const effective = state ?? bus;
  const ref = useRef<HTMLCanvasElement | null>(null);
  const handle = useRef<QuickSphereHandle | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    handle.current = mount(el, {
      mode: 'veil',
      bg: ENTRY_SPHERE.bg,
      dust: ENTRY_SPHERE.dust,
      strand: ENTRY_SPHERE.strand,
      blend: 'source-over',
      alpha: ENTRY_SPHERE.alpha,
      seed: ENTRY_SPHERE.seed,
      count: ENTRY_SPHERE.count,
      scale: ENTRY_SPHERE.scale,
      state: effective,
    });
    return () => { handle.current?.destroy(); handle.current = null; };
    // The palette is identity; the state goes through set() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { handle.current?.set({ state: effective }); }, [effective]);

  return (
    <canvas
      ref={ref}
      className="b-en-sphere-canvas"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={effective}
    />
  );
}
