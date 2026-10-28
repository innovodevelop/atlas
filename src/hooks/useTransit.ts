/**
 * Rejseplanen for the webview: whether an access ID is stored, the stop the
 * user chose, and the two reads (stops by name, departures from a stop).
 *
 * The access ID itself never passes through here except once, on its way into
 * the Keychain (`transit_set_key`); the Rust commands in src-tauri/src/
 * transit.rs make every request and return Rejseplanen's JSON, which
 * src/lib/transit.ts reads. One small store is shared by every caller, so the
 * Answer screen and Home's Transit widget agree on the key and the stop
 * without each asking the Keychain.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import {
  parseDepartures, parseStops, readSavedStop, transitApiError, transitErrorCopy, writeSavedStop,
  type Departure, type TransitStop,
} from '@/lib/transit';

export type TransitStatus = 'loading' | 'unavailable' | 'needs-key' | 'ready';

interface TransitState { status: TransitStatus; stop: TransitStop | null }

let state: TransitState = { status: 'loading', stop: readSavedStop() };
let checked = false;
const listeners = new Set<() => void>();
const emit = (next: Partial<TransitState>) => { state = { ...state, ...next }; listeners.forEach((l) => l()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const snapshot = () => state;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args);
}

const message = (e: unknown) => transitErrorCopy(e instanceof Error ? e.message : typeof e === 'string' ? e : '');

async function refreshStatus(): Promise<void> {
  if (!isTauri()) { emit({ status: 'unavailable' }); return; }
  try {
    const r = await invoke<{ configured?: boolean }>('transit_status');
    emit({ status: r?.configured ? 'ready' : 'needs-key' });
  } catch {
    // An older build without the commands: say so rather than ask for a key it cannot use.
    emit({ status: 'unavailable' });
  }
}

export interface UseTransit extends TransitState {
  /** Store the access ID in the Keychain. Resolves to an error line, or null. */
  saveKey: (key: string) => Promise<string | null>;
  /** Remove the access ID from the Keychain. */
  removeKey: () => Promise<string | null>;
  chooseStop: (stop: TransitStop | null) => void;
  /** Stops matching a name. Throws a line the screen can show. */
  findStops: (query: string) => Promise<TransitStop[]>;
  /** Departures from a stop, soonest first. Throws a line the screen can show. */
  departures: (stop: Pick<TransitStop, 'id' | 'extId'>, direction?: Pick<TransitStop, 'id' | 'extId'> | null) => Promise<Departure[]>;
}

export function useTransit(): UseTransit {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (checked) return;
    checked = true;
    void refreshStatus();
  }, []);

  const saveKey = useCallback(async (key: string) => {
    try {
      await invoke('transit_set_key', { key });
      await refreshStatus();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : typeof e === 'string' ? e : 'The Keychain did not take it.';
    }
  }, []);

  const removeKey = useCallback(async () => {
    try {
      await invoke('transit_set_key', { key: '' });
      await refreshStatus();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : typeof e === 'string' ? e : 'The Keychain did not let go of it.';
    }
  }, []);

  const chooseStop = useCallback((stop: TransitStop | null) => {
    writeSavedStop(stop);
    emit({ stop });
  }, []);

  const findStops = useCallback(async (query: string) => {
    try {
      const json = await invoke<unknown>('transit_find_stops', { query });
      const apiError = transitApiError(json);
      if (apiError) throw new Error(apiError);
      return parseStops(json);
    } catch (e) {
      throw new Error(message(e));
    }
  }, []);

  const departures = useCallback(async (stop: Pick<TransitStop, 'id' | 'extId'>, direction?: Pick<TransitStop, 'id' | 'extId'> | null) => {
    try {
      // The short stop number where Rejseplanen gave one: it is what
      // departureBoard documents, and it survives a renamed stop.
      const json = await invoke<unknown>('transit_departures', {
        stopId: stop.extId ?? stop.id,
        direction: direction ? direction.extId ?? direction.id : null,
      });
      const apiError = transitApiError(json);
      if (apiError) throw new Error(apiError);
      return parseDepartures(json, new Date());
    } catch (e) {
      throw new Error(message(e));
    }
  }, []);

  return { ...s, saveKey, removeKey, chooseStop, findStops, departures };
}
