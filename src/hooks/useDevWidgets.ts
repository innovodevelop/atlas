import { useQuery } from '@tanstack/react-query';
import { adminGet, ADMIN_QUERY_OPTIONS } from './useAdminApi';
import type { DeploysReport, PullsReport } from '@/lib/betaDevWidgets';

/**
 * The admin Home's developer widgets (left-out features, row 18). The brain
 * reads GitHub through the Mac's gh login and keeps each answer for a minute
 * (services/atlas-brain/src/githubWidgets.ts); a widget re-asks every few
 * minutes, which is as fresh as a pull request list needs to be on Home.
 * Admin only: these load with the widgets, which a consumer build does not
 * contain.
 */
const REFETCH_MS = 3 * 60_000;

/** GET /admin/github/pulls — the open pull requests, and who is asked to review. */
export function useGithubPulls() {
  return useQuery({
    queryKey: ['admin', 'github', 'pulls'],
    queryFn: () => adminGet<PullsReport>('/admin/github/pulls'),
    staleTime: 60_000,
    refetchInterval: REFETCH_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
}

/** GET /admin/github/deploys — the releases and the latest workflow runs. */
export function useGithubDeploys() {
  return useQuery({
    queryKey: ['admin', 'github', 'deploys'],
    queryFn: () => adminGet<DeploysReport>('/admin/github/deploys'),
    staleTime: 60_000,
    refetchInterval: REFETCH_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
}
