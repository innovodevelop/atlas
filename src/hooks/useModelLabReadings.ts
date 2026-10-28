/**
 * The Model Lab's measured readings: the last thirty days of
 * `atlas_usage_history` and the `atlas_provider_status` rows, read once.
 *
 * Why not the existing hooks. `useUsageHistory` folds its rows into five named
 * provider buckets that predate the Bedrock lane, so a Bedrock row would land
 * in the total and in no bucket; the lab needs the rows as they are, one line
 * per provider the table actually holds. `useAtlasProviderStatus` polls three
 * tables every 10–30 s and opens a realtime channel for settings and learning
 * logs the lab never shows; one read of one table is all this screen needs,
 * and a key or a row cannot change while you look at it without a relaunch or
 * a writer that does not exist yet.
 *
 * Outside the desktop app the local client answers every select with an empty
 * list, which would render as "nothing recorded". That is a different fact
 * from "cannot see", so the queries are off and `available` says why.
 */
import { useQuery } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import { isTauri, localClient } from '@/integrations/local/localClient';
import type { ProviderHealthRow, UsageRow } from '@/lib/betaModelLab';

export interface ModelLabReadings {
  available: boolean;
  usage: UsageRow[];
  usageLoading: boolean;
  usageError: string | null;
  health: ProviderHealthRow[];
  reload: () => void;
}

export function useModelLabReadings(days = 30): ModelLabReadings {
  const available = isTauri();

  const usage = useQuery({
    queryKey: ['beta-model-lab', 'usage', days],
    enabled: available,
    staleTime: 60_000,
    queryFn: async () => {
      const since = format(subDays(new Date(), days), 'yyyy-MM-dd');
      const { data, error } = await localClient
        .from('atlas_usage_history')
        .select('*')
        .gte('date', since)
        .order('date', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as UsageRow[];
    },
  });

  const health = useQuery({
    queryKey: ['beta-model-lab', 'provider-status'],
    enabled: available,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await localClient
        .from('atlas_provider_status')
        .select('*');
      if (error) throw new Error(error.message);
      return (data ?? []) as ProviderHealthRow[];
    },
  });

  return {
    available,
    usage: usage.data ?? [],
    usageLoading: available && usage.isLoading,
    usageError: usage.error ? (usage.error instanceof Error ? usage.error.message : String(usage.error)) : null,
    health: health.data ?? [],
    reload: () => { void usage.refetch(); void health.refetch(); },
  };
}
