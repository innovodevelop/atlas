import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';

// Same reasoning as useVersions.ts's ADMIN_REFETCH_INTERVAL_MS: the brain
// writes atlas.db directly through bun:sqlite, bypassing the Rust db_*
// commands that are the only source of the `db:changed` Tauri event. There is
// therefore no realtime channel these admin surfaces can subscribe to —
// polling is the only way they learn the brain changed rows out from under
// them. Kept at the same interval as useVersions.ts and for the same reason:
// these are admin surfaces nobody stares at waiting for a live update.
export const ADMIN_REFETCH_INTERVAL_MS = 30_000;

const BRAIN_TIMEOUT_MS = 8_000;

/**
 * Auth + error shape shared by every /admin/* call: bearer account JWT (from
 * authClient) plus the sidecar token (from the Tauri-brokered brain
 * endpoint), exactly what `requireUser` on the brain side checks for. Mirrors
 * useVersions.ts's useSyncVersionPlan inline — pulled out here because three
 * new hook modules need the identical GET/POST shape and duplicating it three
 * times would just be three places to fix the same auth bug in later.
 */
async function adminRequest<T>(path: string, method: 'GET' | 'POST'): Promise<T> {
  const token = getToken();
  if (!token) {
    throw new Error('Not authenticated');
  }
  const brain = await getBrainEndpoint();
  if (!brain) {
    throw new Error('Atlas brain is not running. Restart the app or wait for it to boot.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRAIN_TIMEOUT_MS);
  try {
    const res = await fetch(`${brain.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'x-sidecar-token': brain.token,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export const ADMIN_QUERY_OPTIONS = { retry: 1, retryDelay: 2_000 } as const;

export function adminGet<T>(path: string): Promise<T> {
  return adminRequest<T>(path, 'GET');
}

export function adminPost<T>(path: string): Promise<T> {
  return adminRequest<T>(path, 'POST');
}
