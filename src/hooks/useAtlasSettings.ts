/**
 * Atlas settings — voice output, and nothing else any more.
 *
 * WHAT WAS REMOVED AND WHY. This hook used to carry 77 keys. Seventy of them
 * described the three.js particle sphere: nebula flow fields, GLSL colour
 * stops, trails, bloom, ripples, turbulence, mouse attract/repulse, a core
 * system, fluid dynamics, and a per-state customisation map. Every one of them
 * was read by exactly two things — `src/components/atlas/` (the WebGL renderer)
 * and `/atlas-demo` (its 1133-line tuning lab). Both are deleted, so every one
 * of those keys became a value nothing could ever read.
 *
 * The seven that survive are the voice dials, which are genuinely wired:
 * `voiceId` and `ttsModel` reach the gateway through
 * AtlasDashboard -> useVoiceSession -> voice-gateway/src/session.ts, and the
 * four performance dials go the same way via `toVoiceSettings`.
 *
 * SETTINGS_VERSION IS DELIBERATELY NOT BUMPED. `loadSettings` treats a version
 * RISE as "wipe everything", so bumping it here would erase the voice the user
 * chose, in the name of removing keys they never set. Removing keys needs no
 * bump: the loader picks the keys it knows and ignores the rest, so the stale
 * seventy are dropped from storage the next time anything is saved, silently
 * and without touching what the user picked.
 *
 * ALSO GONE, because their only caller was `/atlas-demo`: `setMultiple`,
 * `reset`, `exportSettings`, `importSettings`, `setStateCustomization`,
 * `resetStateCustomizations`, `resetCurrentState`, `resetAllCustomizations`,
 * `getMergedStateConfig`, `hasStateCustomizations` and
 * `NEBULA_CUSTOMIZABLE_KEYS`. And `useAtlasSettingsReadOnly`, whose only
 * consumer was the WebGL sphere component.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'atlas-demo-settings';
// Historical name, kept on purpose: renaming it would orphan the voice every
// existing user has already chosen.

const SETTINGS_VERSION = 12; // Do not bump to add or remove keys — see the header.

/** Complete settings interface. */
export interface AtlasSettings {
  // Voice output
  voiceId: string;
  ttsModel: 'eleven_turbo_v2_5' | 'eleven_flash_v2_5' | 'eleven_multilingual_v2';

  // How the chosen voice PERFORMS. These are threaded to the voice gateway and
  // clamped there (services/voice-gateway/src/voiceSettings.ts owns the ranges).
  //
  // Note there is deliberately no "pitch" or "depth" here: ElevenLabs exposes
  // no such parameter. Timbre/deepness is a property of `voiceId` — switching
  // to a deeper voice is the only way to get a deeper Atlas.
  /** 0–1. Low = more variation and emotion, high = flatter and predictable. */
  voiceStability: number;
  /** 0–1. How closely to adhere to the original voice recording. */
  voiceSimilarity: number;
  /** 0–1. Expressiveness. Above 0 costs latency. */
  voiceStyle: number;
  /** 0.7–1.2. 1.0 is the voice's natural rate. */
  voiceSpeed: number;
  /** Slight clarity/presence boost; costs a little latency. */
  voiceSpeakerBoost: boolean;
}

export const defaultAtlasSettings: AtlasSettings = {
  voiceId: 'EXAVITQu4vr4xnSDxMaL', // Sarah
  ttsModel: 'eleven_turbo_v2_5',
  // Mirrors DEFAULT_VOICE_SETTINGS in the gateway — these are the values that
  // shipped hard-coded, so an existing user hears no change on upgrade.
  //
  // NOTE: adding keys does NOT require bumping SETTINGS_VERSION; the loader
  // merges defaults over the stored blob. Bumping it WIPES the user's settings.
  voiceStability: 0.5,
  voiceSimilarity: 0.75,
  voiceStyle: 0.3,
  voiceSpeed: 1.0,
  voiceSpeakerBoost: true,
};

/**
 * The keys this app knows about. Anything else in storage is dropped on load —
 * that is what retires the seventy sphere keys without a version bump.
 */
const KEYS = Object.keys(defaultAtlasSettings) as (keyof AtlasSettings)[];

/** Order-stable identity for change detection; see the sync effect below. */
function fingerprint(s: AtlasSettings): string {
  return JSON.stringify(KEYS.map((k) => s[k]));
}

function loadSettings(): AtlasSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AtlasSettings> & { _version?: number };

      // Force reset if version is old or missing (clears corrupted settings).
      if (!parsed._version || parsed._version < SETTINGS_VERSION) {
        localStorage.removeItem(STORAGE_KEY);
        return defaultAtlasSettings;
      }

      const merged = { ...defaultAtlasSettings };
      for (const k of KEYS) {
        const v = parsed[k];
        // Type-guard rather than trust: a blob written by an older build could
        // hold anything under these names, and a string where a number belongs
        // would reach the gateway.
        if (v !== undefined && typeof v === typeof defaultAtlasSettings[k]) {
          (merged as Record<string, unknown>)[k] = v;
        }
      }
      return merged;
    }
  } catch (e) {
    console.warn('Failed to load Atlas settings:', e);
  }
  return defaultAtlasSettings;
}

function saveSettings(settings: AtlasSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...settings,
      _version: SETTINGS_VERSION,
    }));
    // Same-tab listeners. `storage` only fires in OTHER documents, so without
    // this the Settings panel and the dashboard would disagree until remount.
    window.dispatchEvent(new CustomEvent('atlas-settings-changed'));
  } catch (e) {
    console.error('Failed to save Atlas settings:', e);
  }
}

export interface UseAtlasSettingsReturn {
  settings: AtlasSettings;
  setSetting: <K extends keyof AtlasSettings>(key: K, value: AtlasSettings[K]) => void;
}

export function useAtlasSettings(): UseAtlasSettingsReturn {
  const [settings, setSettings] = useState<AtlasSettings>(loadSettings);

  // The value this instance last wrote OR last read. Both the save effect and
  // the sync listener check against it, which is what stops the pair looping:
  // an instance that saves also broadcasts, hears its own broadcast, reads back
  // an identical fingerprint and stops there.
  const seen = useRef<string>('');
  if (seen.current === '') seen.current = fingerprint(settings);

  useEffect(() => {
    const fp = fingerprint(settings);
    if (fp === seen.current) return;
    seen.current = fp;
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const sync = () => {
      const next = loadSettings();
      const fp = fingerprint(next);
      if (fp === seen.current) return;
      seen.current = fp;
      setSettings(next);
    };
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) sync(); };
    window.addEventListener('atlas-settings-changed', sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('atlas-settings-changed', sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setSetting = useCallback(<K extends keyof AtlasSettings>(key: K, value: AtlasSettings[K]) => {
    setSettings((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  return { settings, setSetting };
}
