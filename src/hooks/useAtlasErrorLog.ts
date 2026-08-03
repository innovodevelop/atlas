import { useCallback, useEffect, useState } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';

/**
 * The real `atlas_error_logs` stream.
 *
 * This is the data layer lifted out of `atlas-health/ErrorLogStream.tsx` during
 * the T4 absorb-then-delete pass. That component was only ever reachable at
 * `/atlas-core-legacy`, a route linked from nowhere — while the Core screen that
 * replaced it rendered four *invented* error rows, one of them naming `gemini`,
 * a provider Atlas no longer uses.
 *
 * So the legacy screen was the honest one and the modern screen was the
 * regression. Extracting the query into a hook is what lets the modern screen
 * show the same real rows without dragging 20 KB of shadcn Badge/Button markup
 * across with it.
 *
 * Deliberately NOT included from the original: the realtime subscription. The
 * legacy component opened a channel per mount and the Core overview is not a
 * monitoring console — it is a summary that refreshes when you arrive. A live
 * stream belongs on a dedicated surface, and adding one here would mean a
 * channel opening every time somebody clicks the Overview tab.
 */
export interface AtlasErrorLog {
  id: string;
  error_type: string;
  error_message: string;
  severity: string;
  resolved: boolean;
  created_at: string;
}

/** Maps the four stored severities onto the three the Core row renderer draws. */
export function errorSeverityGlyph(severity: string): 'e' | 'w' | 'i' {
  if (severity === 'error' || severity === 'critical') return 'e';
  if (severity === 'warning') return 'w';
  return 'i';
}

export const useAtlasErrorLog = (limit = 4) => {
  const [errors, setErrors] = useState<AtlasErrorLog[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('atlas_error_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    // A query failure and an empty table are different states and must render
    // differently — "no errors" is good news, "we could not read the log" is
    // not, and collapsing them would be exactly the kind of comfortable lie
    // this hook exists to remove.
    if (error) {
      setFailed(true);
      setErrors([]);
      return;
    }
    setFailed(false);
    setErrors((data ?? []) as AtlasErrorLog[]);
  }, [limit]);

  useEffect(() => { void load(); }, [load]);

  return { errors, failed, reload: load };
};
