import { useEffect, useState } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import type { StatusKey } from '@/lib/mocks/widgetSheet';

/**
 * Which provider keys are actually present on this machine.
 *
 * The Widget Sheet documents a state — "the data source is absent" — that
 * several cards can genuinely be in, because the widget behind them needs an
 * API key that may not be set. Rendering that state from a mock would have made
 * the one honest thing on the page fictional, so it is read live from
 * `brain_ai_status` (src-tauri/src/lib.rs), which reports presence per provider
 * and never returns a key value.
 *
 * Three outcomes, and they are three different answers:
 *
 *  - `ready`    the command answered; `keys` says which providers are configured
 *  - `unknown`  we are in a browser, not the desktop app. The Keychain is not
 *               reachable from here, so the sheet says it does not know rather
 *               than defaulting every key to "missing" and slandering a
 *               perfectly configured install.
 *  - `error`    the command exists and failed. Also not "missing".
 *
 * Read-only. This hook invokes one command and stores three booleans; it cannot
 * set, clear or read a key.
 */
export type SourceStatusPhase = 'loading' | 'ready' | 'unknown' | 'error';

export type KeyPresence = Partial<Record<StatusKey, boolean>>;

export interface SourceStatus {
  phase: SourceStatusPhase;
  keys: KeyPresence;
  /** Why we cannot answer, when `phase` is `unknown` or `error`. */
  reason: string | null;
}

const BROWSER: SourceStatus = {
  phase: 'unknown',
  keys: {},
  reason: 'Keys live in the macOS Keychain, which only the desktop app can read.',
};

export function useSourceStatus(): SourceStatus {
  const [status, setStatus] = useState<SourceStatus>(() =>
    isTauri() ? { phase: 'loading', keys: {}, reason: null } : BROWSER,
  );

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;

    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const raw = await invoke<Record<string, unknown>>('brain_ai_status');
        if (!live) return;
        // Only the keys this surface documents, and only as booleans — the
        // command also returns `ai_provider`, which is a string and none of
        // this page's business.
        const pick = (k: StatusKey) => (typeof raw?.[k] === 'boolean' ? (raw[k] as boolean) : undefined);
        setStatus({
          phase: 'ready',
          keys: {
            openweather: pick('openweather'),
            finnhub: pick('finnhub'),
            news: pick('news'),
            elevenlabs: pick('elevenlabs'),
            anthropic: pick('anthropic'),
          },
          reason: null,
        });
      } catch (e) {
        if (!live) return;
        setStatus({
          phase: 'error',
          keys: {},
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return () => { live = false; };
  }, []);

  return status;
}
