import { useCallback, useEffect, useState } from 'react';
import { getBrainEndpoint } from '@/lib/brainClient';
import { getToken } from '@/lib/authClient';

/**
 * Read-only view of what Atlas has stored about you.
 *
 * This backs the Core "Memory" tab — the roadmap item recorded as *"specified,
 * never built"* (the design plan called for eight Core tabs; the screen shipped
 * with seven). The capability existed only inside `MemoryDashboardPanel`, which
 * was reachable at `/atlas-core-legacy`, a route linked from nowhere.
 *
 * **Read-only on purpose.** Forgetting a single memory and erasing everything
 * already live in Settings → Memory & Privacy (`MemoryPrivacyPanel`), together
 * with the typed-confirmation flow and the account-deletion path. Duplicating
 * destructive controls onto a second surface would mean two places to keep
 * correct and two places to audit, for a GDPR-relevant action. Core answers
 * "what does Atlas know"; Settings owns "make it forget".
 *
 * The brain sidecar is a local process, so outside the desktop app there is no
 * endpoint at all. That is reported as its own state rather than as an empty
 * list — "Atlas knows nothing about you" and "this only works in the desktop
 * app" are very different messages to show someone.
 */
export interface StoredMemory {
  id: string;
  key: string;
  value: string;
  category: string;
  importance?: number;
  created_at?: string;
}

export type MemoryAvailability = 'loading' | 'ready' | 'unavailable' | 'error';

export const useAtlasMemory = () => {
  const [memories, setMemories] = useState<StoredMemory[]>([]);
  const [state, setState] = useState<MemoryAvailability>('loading');
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const brain = await getBrainEndpoint();
    if (!brain) {
      setState('unavailable');
      setMessage('Memory is stored on your Mac, so it is only readable in the desktop app.');
      return;
    }
    try {
      const res = await fetch(`${brain.baseUrl}/memory/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken() ?? ''}`,
          'x-sidecar-token': brain.token,
        },
        body: '{}',
      });
      if (!res.ok) {
        setState('error');
        setMessage(`The brain sidecar returned ${res.status}.`);
        return;
      }
      const json = await res.json();
      setMemories((json?.memories ?? []) as StoredMemory[]);
      setState('ready');
      setMessage(null);
    } catch (e) {
      setState('error');
      setMessage(e instanceof Error ? e.message : 'Could not reach the brain sidecar.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Grouped by the ~24 memory categories the orchestrator writes. */
  const byCategory = memories.reduce<Record<string, StoredMemory[]>>((acc, m) => {
    (acc[m.category] ??= []).push(m);
    return acc;
  }, {});

  return { memories, byCategory, state, message, reload: load };
};
