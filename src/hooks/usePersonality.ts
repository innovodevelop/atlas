import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { useToast } from '@/hooks/use-toast';

// Personality trait vector (Phase 4). Frontend mirror of the canonical shape in
// supabase/functions/_shared/personality.ts — five [0,1] dials the brain drifts
// slowly from observed conversation and the user can override here at any time.
// The user's slider always wins: /personality {action:"update"} persists the
// exact value and the brain's drift starts from it.

export interface Traits {
  warmth: number;
  playfulness: number;
  formality: number;
  verbosity: number;
  directness: number;
}

export const DEFAULT_TRAITS: Traits = {
  warmth: 0.5,
  playfulness: 0.5,
  formality: 0.5,
  verbosity: 0.5,
  directness: 0.5,
};

const clamp01 = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;

// Tolerate partial/stale server payloads (e.g. a traits_json written before a
// new trait existed): missing keys fall back to the default, values clamp.
function normalizeTraits(raw: unknown): Traits {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_TRAITS };
  (Object.keys(DEFAULT_TRAITS) as (keyof Traits)[]).forEach((k) => {
    if (k in src) out[k] = clamp01(src[k]);
  });
  return out;
}

// Same local-sidecar fetch pattern as useBrainSearch.
async function brainPost(path: string, body: unknown): Promise<{ data: any; error: Error | null }> {
  const brain = await getBrainEndpoint();
  if (!brain) return { data: null, error: new Error('Personality settings are only available in the desktop app.') };
  try {
    const res = await fetch(`${brain.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}`, 'x-sidecar-token': brain.token },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return res.ok ? { data, error: null } : { data: null, error: new Error(data.error || 'Request failed') };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

const SAVE_DEBOUNCE_MS = 600;

export const usePersonality = () => {
  const [traits, setTraits] = useState<Traits>(DEFAULT_TRAITS);
  const [lexicon, setLexicon] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  // Debounced persist: sliders fire continuously while dragging, so the local
  // state updates immediately and the brain write trails by SAVE_DEBOUNCE_MS.
  const saveTimer = useRef<number | null>(null);
  const pendingTraits = useRef<Traits | null>(null);
  const mounted = useRef(true);

  const persist = useCallback(async (next: Traits) => {
    if (mounted.current) setIsSaving(true);
    const { error } = await brainPost('/personality', { action: 'update', traits: next });
    if (!mounted.current) return;
    setIsSaving(false);
    if (error) {
      toast({ title: 'Could not save personality', description: error.message, variant: 'destructive' });
    }
  }, [toast]);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      const { data, error } = await brainPost('/personality', { action: 'get' });
      if (!mounted.current) return;
      if (error) {
        setLoadError(error.message);
      } else {
        setLoadError(null);
        setTraits(normalizeTraits(data?.traits));
        setLexicon((data?.lexicon ?? {}) as Record<string, string>);
      }
      setIsLoading(false);
    })();
    return () => {
      mounted.current = false;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      // Flush a pending edit so closing Settings mid-debounce doesn't drop it
      // (fire-and-forget: no state updates after unmount).
      if (pendingTraits.current) void persist(pendingTraits.current);
      pendingTraits.current = null;
    };
  }, [persist]);

  const setTrait = useCallback((key: keyof Traits, value: number) => {
    setTraits((prev) => {
      const next = { ...prev, [key]: clamp01(value) };
      pendingTraits.current = next;
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const toSave = pendingTraits.current;
        pendingTraits.current = null;
        if (toSave) void persist(toSave);
      }, SAVE_DEBOUNCE_MS);
      return next;
    });
  }, [persist]);

  const reset = useCallback(async () => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    pendingTraits.current = null;
    setIsSaving(true);
    const { data, error } = await brainPost('/personality', { action: 'reset' });
    if (!mounted.current) return;
    setIsSaving(false);
    if (error) {
      toast({ title: 'Reset failed', description: error.message, variant: 'destructive' });
      return;
    }
    setTraits(normalizeTraits(data?.traits ?? DEFAULT_TRAITS));
    if (data?.lexicon) setLexicon(data.lexicon as Record<string, string>);
    toast({ title: 'Personality reset', description: 'All traits are back to their defaults.' });
  }, [toast]);

  return { traits, lexicon, isLoading, loadError, isSaving, setTrait, reset };
};
