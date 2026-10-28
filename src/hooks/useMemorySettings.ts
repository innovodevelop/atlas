/**
 * Settings → Memory & Privacy → "Remember things I share".
 *
 * One row per user in `atlas_memory_settings` (db_schema.sql), through the
 * local CRUD shim. The brain reads the same row on every chat and voice turn
 * (services/atlas-brain/src/memorySettings.ts): off, Atlas stops saving facts
 * and conversation summaries on its own and stores only what the user
 * explicitly asks it to remember. No row means on.
 *
 * The shim's `upsert` is a plain insert, so a write looks the row up and
 * updates it, or inserts the first one.
 */
import { useCallback, useEffect, useState } from 'react';
import { isTauri, localClient } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';

const TABLE = 'atlas_memory_settings';

export interface RememberShared {
  /** False outside the desktop app: there is no local database to hold it. */
  available: boolean;
  /** Null until read. */
  on: boolean | null;
  saving: boolean;
  error: string | null;
  set: (on: boolean) => Promise<void>;
}

export function useRememberShared(): RememberShared {
  const available = isTauri();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available || !userId) return;
    let alive = true;
    void (async () => {
      const { data, error: e } = await localClient.from(TABLE).select('remember_shared').eq('user_id', userId).maybeSingle();
      if (!alive) return;
      if (e) { setError(e.message); return; }
      const row = data as { remember_shared?: number | boolean } | null;
      setOn(row?.remember_shared == null ? true : Number(row.remember_shared) !== 0);
    })();
    return () => { alive = false; };
  }, [available, userId]);

  const set = useCallback(async (next: boolean) => {
    if (!available || !userId) return;
    setSaving(true);
    setError(null);
    const value = next ? 1 : 0;
    try {
      const { data: row, error: readError } = await localClient.from(TABLE).select('id').eq('user_id', userId).maybeSingle();
      if (readError) throw new Error(readError.message);
      const { error: writeError } = row
        ? await localClient.from(TABLE).update({ remember_shared: value }).eq('user_id', userId)
        : await localClient.from(TABLE).insert({ user_id: userId, remember_shared: value });
      if (writeError) throw new Error(writeError.message);
      setOn(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [available, userId]);

  return { available, on, saving, error, set };
}
