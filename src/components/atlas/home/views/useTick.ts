import { useEffect, useState } from 'react';

/** The current time, refreshed every `ms` while `on` — for the views that follow the clock. */
export function useTick(ms: number, on = true): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setT(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
  return t;
}
