import { useEffect, useState } from 'react';

/**
 * `prefers-reduced-motion: reduce`, live.
 *
 * `workshop.css` neutralises CSS animation app-wide under that query, but the
 * omnibox sphere is a canvas render loop — CSS cannot reach it. This hook is
 * how the Browser surface swaps the sphere for a static mode glyph instead of
 * running particles at someone who asked for stillness.
 *
 * Local to this surface on purpose: a shared hook belongs in `src/hooks/`, and
 * that directory is owned by other tracks this week.
 */
export const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
};
