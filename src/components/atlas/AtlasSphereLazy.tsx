import { Suspense, lazy } from 'react';
import { cn } from '@/lib/utils';
import type { AtlasSphereProps } from './AtlasSphere';

// Code-split boundary for the sphere: AtlasSphere pulls the entire three.js
// stack (~1MB), which otherwise loads before the dashboard's first paint.
// Screens render instantly with a CSS glow stand-in; the real sphere fades in
// as soon as the three chunk arrives.
const AtlasSphereInner = lazy(() =>
  import('./AtlasSphere').then((m) => ({ default: m.AtlasSphere }))
);

const SphereGlowPlaceholder = ({ className }: { className?: string }) => (
  <div className={cn('relative w-full h-full flex items-center justify-center', className)}>
    <div
      className="animate-pulse"
      style={{
        width: '70%',
        height: '70%',
        borderRadius: '50%',
        background:
          'radial-gradient(closest-side, hsl(243 75% 58% / .55), hsl(280 70% 60% / .25) 60%, transparent 100%)',
        filter: 'blur(6px)',
      }}
    />
  </div>
);

export const AtlasSphereLazy = (props: AtlasSphereProps) => (
  <Suspense fallback={<SphereGlowPlaceholder className={props.className} />}>
    <AtlasSphereInner {...props} />
  </Suspense>
);
