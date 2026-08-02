import { useReducer, useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { WakeWordState } from '@/types';
import { NebulaStateConfig, NEBULA_STATE_CONFIGS } from '@/components/atlas/utils/nebulaStateConfigs';

const STORAGE_KEY = 'atlas-demo-settings';
const SETTINGS_VERSION = 12; // Bump: Workshop warm sphere palette (reset old indigo nebula colors)

// Keys that can be customized per-state (nebula visual properties)
export const NEBULA_CUSTOMIZABLE_KEYS = [
  'nebulaFlowStrength',
  'nebulaFlowSpeed',
  'nebulaRimIntensity',
  'nebulaHotSpotIntensity',
  'nebulaBreathingSpeed',
  'nebulaBreathingAmount',
  'nebulaRadiusNoise',
  'nebulaGlowIntensity',
  'nebulaColorStart',
  'nebulaColorMid',
  'nebulaColorEnd',
  'nebulaRotationSpeed',
] as const;

export type NebulaCustomizableKey = typeof NEBULA_CUSTOMIZABLE_KEYS[number];

// Mapping from settings keys to state config keys
const SETTING_TO_CONFIG_KEY: Record<NebulaCustomizableKey, keyof NebulaStateConfig> = {
  nebulaFlowStrength: 'flowStrength',
  nebulaFlowSpeed: 'flowSpeed',
  nebulaRimIntensity: 'rimIntensity',
  nebulaHotSpotIntensity: 'hotSpotIntensity',
  nebulaBreathingSpeed: 'breathingSpeed',
  nebulaBreathingAmount: 'breathingAmount',
  nebulaRadiusNoise: 'radiusNoise',
  nebulaGlowIntensity: 'glowIntensity',
  nebulaColorStart: 'colorStart',
  nebulaColorMid: 'colorMid',
  nebulaColorEnd: 'colorEnd',
  nebulaRotationSpeed: 'flowSpeed', // Map rotation to flow for now
};

// Per-state customization type
export type StateCustomizations = Partial<Record<WakeWordState, Partial<NebulaStateConfig>>>;

// Complete settings interface for Atlas visualization
export interface AtlasSettings {
  // Voice output
  voiceId: string;
  ttsModel: 'eleven_turbo_v2_5' | 'eleven_flash_v2_5' | 'eleven_multilingual_v2';
  // Pre-clean recorded audio via ElevenLabs Audio Isolation before STT.
  // Helps in noisy environments; adds ~0.5-1s latency + credits. Default off.
  voiceIsolation: boolean;

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

  // Visualization mode
  visualizationMode: 'classic' | 'nebulaFlow';
  
  // Particle mode: 'density' uses dynamic calculation, 'fixed' uses manual count
  nebulaParticleMode: 'density' | 'fixed';
  
  // Dashboard preview mode
  dashboardPreview: boolean;
  
  // Side-by-side comparison view
  comparisonView: boolean;
  
  // Core state
  state: WakeWordState;
  morphProgress: number;
  audioLevel: number;
  autoAudio: boolean;
  
  // Trail settings
  enableTrails: boolean;
  trailLength: number;
  trailOpacity: number;
  trailColorGradient: boolean;
  trailStartColor: string;
  trailEndColor: string;
  
  // Particle settings
  particleCount: number;
  particleSize: number;
  density: number;
  rotationSpeed: number;
  
  // Effects
  enableBloom: boolean;
  bloomIntensity: number;
  morphSpeed: number;
  
  // Ripple settings
  enableRipples: boolean;
  rippleSpeed: number;
  rippleCount: number;
  
  // Turbulence settings
  enableTurbulence: boolean;
  turbulenceFrequency: number;
  turbulenceAmplitude: number;
  turbulenceSpeed: number;
  
  // Mouse interaction
  enableMouseInteraction: boolean;
  mouseMode: 'attract' | 'repulse';
  mouseStrength: number;
  mouseInfluenceRadius: number;
  
  // Core system
  enableCore: boolean;
  coreParticleCount: number;
  coreDensity: number;
  coreParticleSize: number;
  coreIntensity: number;
  corePulseSpeed: number;
  coreRotationOffset: number;
  
  // Fluid dynamics
  fluidCohesion: number;
  surfaceTension: number;
  fluidFlow: number;
  
  // Audio reactivity
  audioReactivitySpeed: number;
  
  // Nebula Flow settings (current display values)
  nebulaFlowStrength: number;
  nebulaFlowSpeed: number;
  nebulaBandCount: number;
  nebulaRimIntensity: number;
  nebulaHotSpotIntensity: number;
  nebulaBreathingSpeed: number;
  nebulaBreathingAmount: number;
  nebulaRadiusNoise: number;
  nebulaColorStart: string;
  nebulaColorMid: string;
  nebulaColorEnd: string;
  
  // Enhanced Nebula settings
  nebulaParticleCount: number;
  nebulaParticleSize: number;
  nebulaDensity: number;
  nebulaRotationSpeed: number;
  nebulaStateReactive: boolean;
  nebulaGlowIntensity: number;
  nebulaDepthFade: number;
  nebulaCoreGlow: number;
  
  // Solid Surface settings
  nebulaSolidSurface: boolean;
  nebulaSurfaceBlend: number;
  nebulaUniformSize: number;
  nebulaCoherence: number;
  
  // State behavior settings
  nebulaThinkingRetraction: number;
  nebulaAudioBreathingIntensity: number;
  nebulaTransitionSpeed: number;
  
  // Per-state customizations - stores overrides for each state individually
  stateCustomizations: StateCustomizations;
}

// Default settings - optimized for performance
export const defaultAtlasSettings: AtlasSettings = {
  voiceId: 'EXAVITQu4vr4xnSDxMaL', // Sarah
  ttsModel: 'eleven_turbo_v2_5',
  voiceIsolation: false,
  // Mirrors DEFAULT_VOICE_SETTINGS in the gateway — these are the values that
  // shipped hard-coded, so an existing user hears no change on upgrade.
  // NOTE: adding keys does NOT require bumping SETTINGS_VERSION; loadSettings
  // merges defaults over the stored blob. Bumping it WIPES the user's settings.
  voiceStability: 0.5,
  voiceSimilarity: 0.75,
  voiceStyle: 0.3,
  voiceSpeed: 1.0,
  voiceSpeakerBoost: true,
  visualizationMode: 'nebulaFlow',
  nebulaParticleMode: 'fixed', // Use manual particle count by default
  dashboardPreview: false,
  comparisonView: false,
  state: 'dormant',
  morphProgress: 1.0,
  audioLevel: 0,
  autoAudio: false,
  enableTrails: false,
  trailLength: 3,
  trailOpacity: 0.4,
  trailColorGradient: true,
  trailStartColor: '#3d6bf3',
  trailEndColor: '#7a2e00',
  particleCount: 1250,
  particleSize: 0.085,
  density: 1.0,
  rotationSpeed: 0.5,
  enableBloom: true,
  bloomIntensity: 0.6,
  morphSpeed: 1.5,
  enableRipples: true,
  rippleSpeed: 1.5,
  rippleCount: 2,
  enableTurbulence: true,
  turbulenceFrequency: 0.5,
  turbulenceAmplitude: 0.06,
  turbulenceSpeed: 0.3,
  enableMouseInteraction: true,
  mouseMode: 'attract',
  mouseStrength: 0.4,
  mouseInfluenceRadius: 1.85,
  enableCore: true,
  coreParticleCount: 100,
  coreDensity: 0.25,
  coreParticleSize: 0.045,
  coreIntensity: 1.0,
  corePulseSpeed: 1.5,
  coreRotationOffset: -0.5,
  fluidCohesion: 0,
  surfaceTension: 0.5,
  fluidFlow: 0.3,
  audioReactivitySpeed: 1.0,
  // Nebula Flow defaults (will be overwritten by state config)
  nebulaFlowStrength: 0.5,
  nebulaFlowSpeed: 0.5,
  nebulaBandCount: 8,
  nebulaRimIntensity: 1.2,
  nebulaHotSpotIntensity: 0.8,
  nebulaBreathingSpeed: 0.5,
  nebulaBreathingAmount: 0.05,
  nebulaRadiusNoise: 0.15,
  nebulaColorStart: '#2d59f0',
  nebulaColorMid: '#5a7cf5',
  nebulaColorEnd: '#bcccfb',
  // Enhanced Nebula defaults
  nebulaParticleCount: 6700,
  nebulaParticleSize: 0.055,
  nebulaDensity: 1.0,
  nebulaRotationSpeed: 0.2,
  nebulaStateReactive: true,
  nebulaGlowIntensity: 1.0,
  nebulaDepthFade: 0.3,
  nebulaCoreGlow: 1.0,
  // Solid Surface defaults
  nebulaSolidSurface: false,
  nebulaSurfaceBlend: 1.5,
  nebulaUniformSize: 1.8,
  nebulaCoherence: 0.9,
  // State behavior defaults
  nebulaThinkingRetraction: 0.25,
  nebulaAudioBreathingIntensity: 0.15,
  nebulaTransitionSpeed: 1.5,
  // Per-state customizations (empty = use defaults)
  stateCustomizations: {},
};

// Helper to get merged config for a state (base + customizations)
export function getMergedStateConfig(state: WakeWordState, customizations: StateCustomizations): NebulaStateConfig {
  const baseConfig = NEBULA_STATE_CONFIGS[state];
  const stateOverrides = customizations[state] || {};
  return { ...baseConfig, ...stateOverrides };
}

// Helper to check if a state has any customizations
export function hasStateCustomizations(state: WakeWordState, customizations: StateCustomizations): boolean {
  const overrides = customizations[state];
  return overrides !== undefined && Object.keys(overrides).length > 0;
}

// Action types
type SettingsAction =
  | { type: 'SET_SETTING'; key: keyof AtlasSettings; value: AtlasSettings[keyof AtlasSettings] }
  | { type: 'SET_MULTIPLE'; settings: Partial<AtlasSettings> }
  | { type: 'SET_STATE_CUSTOMIZATION'; state: WakeWordState; key: keyof NebulaStateConfig; value: string | number | boolean }
  | { type: 'RESET_STATE_CUSTOMIZATIONS'; state: WakeWordState }
  | { type: 'RESET_ALL_CUSTOMIZATIONS' }
  | { type: 'RESET' }
  | { type: 'LOAD'; settings: AtlasSettings };

// Reducer
function settingsReducer(state: AtlasSettings, action: SettingsAction): AtlasSettings {
  switch (action.type) {
    case 'SET_SETTING':
      return { ...state, [action.key]: action.value };
    case 'SET_MULTIPLE':
      return { ...state, ...action.settings };
    case 'SET_STATE_CUSTOMIZATION': {
      const currentOverrides = state.stateCustomizations[action.state] || {};
      return {
        ...state,
        stateCustomizations: {
          ...state.stateCustomizations,
          [action.state]: {
            ...currentOverrides,
            [action.key]: action.value,
          },
        },
      };
    }
    case 'RESET_STATE_CUSTOMIZATIONS': {
      const newCustomizations = { ...state.stateCustomizations };
      delete newCustomizations[action.state];
      return { ...state, stateCustomizations: newCustomizations };
    }
    case 'RESET_ALL_CUSTOMIZATIONS':
      return { ...state, stateCustomizations: {} };
    case 'RESET':
      return { ...defaultAtlasSettings };
    case 'LOAD':
      return { ...action.settings };
    default:
      return state;
  }
}

// Load settings from localStorage
function loadSettings(): AtlasSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      
      // Force reset if version is old or missing (clears corrupted settings)
      if (!parsed._version || parsed._version < SETTINGS_VERSION) {
        localStorage.removeItem(STORAGE_KEY);
        return defaultAtlasSettings;
      }
      
      const merged: AtlasSettings = { ...defaultAtlasSettings, ...parsed };

      // Ensure morphProgress is never too low (minimum 0.3 for visible sphere)
      if (typeof merged.morphProgress !== 'number' || merged.morphProgress < 0.3) {
        merged.morphProgress = 1.0;
      }

      return merged;
    }
  } catch (e) {
    console.warn('Failed to load Atlas settings:', e);
  }
  return defaultAtlasSettings;
}

// Save settings to localStorage with version and notify listeners
function saveSettings(settings: AtlasSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...settings,
      _version: SETTINGS_VERSION
    }));
    // Dispatch custom event for same-tab listeners
    window.dispatchEvent(new CustomEvent('atlas-settings-changed'));
  } catch (e) {
    console.error('Failed to save Atlas settings:', e);
  }
}

export interface UseAtlasSettingsReturn {
  settings: AtlasSettings;
  setSetting: <K extends keyof AtlasSettings>(key: K, value: AtlasSettings[K]) => void;
  setMultiple: (settings: Partial<AtlasSettings>) => void;
  setStateCustomization: (stateName: WakeWordState, key: keyof NebulaStateConfig, value: string | number | boolean) => void;
  resetStateCustomizations: (stateName: WakeWordState) => void;
  reset: () => void;
  resetCurrentState: () => void;
  resetAllCustomizations: () => void;
  exportSettings: () => void;
  importSettings: () => void;
}

export function useAtlasSettings(): UseAtlasSettingsReturn {
  const [settings, dispatch] = useReducer(settingsReducer, defaultAtlasSettings, loadSettings);
  const prevStateRef = useRef(settings.state);

  // Auto-save to localStorage when settings change
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // When state changes, update UI sliders to show that state's config (merged with customizations)
  useEffect(() => {
    if (prevStateRef.current !== settings.state) {
      prevStateRef.current = settings.state;
      
      // Get merged config for the new state
      const mergedConfig = getMergedStateConfig(settings.state, settings.stateCustomizations);
      
      // Update display values without triggering customizations
      dispatch({
        type: 'SET_MULTIPLE',
        settings: {
          nebulaFlowStrength: mergedConfig.flowStrength,
          nebulaFlowSpeed: mergedConfig.flowSpeed,
          nebulaRimIntensity: mergedConfig.rimIntensity,
          nebulaHotSpotIntensity: mergedConfig.hotSpotIntensity,
          nebulaBreathingSpeed: mergedConfig.breathingSpeed,
          nebulaBreathingAmount: mergedConfig.breathingAmount,
          nebulaRadiusNoise: mergedConfig.radiusNoise,
          nebulaGlowIntensity: mergedConfig.glowIntensity,
          nebulaColorStart: mergedConfig.colorStart,
          nebulaColorMid: mergedConfig.colorMid,
          nebulaColorEnd: mergedConfig.colorEnd,
        },
      });
    }
  }, [settings.state, settings.stateCustomizations]);

  const setSetting = useCallback(<K extends keyof AtlasSettings>(key: K, value: AtlasSettings[K]) => {
    // For nebula customizable properties, save to per-state customization
    const keyStr = key as string;
    if ((NEBULA_CUSTOMIZABLE_KEYS as readonly string[]).includes(keyStr)) {
      const configKey = SETTING_TO_CONFIG_KEY[keyStr as NebulaCustomizableKey];
      if (configKey) {
        // Get current state from latest settings (we need to use a ref or pass it)
        // For now, dispatch both - the SET_SETTING updates UI, and we'll handle customization separately
        dispatch({ type: 'SET_SETTING', key, value });
        return;
      }
    }
    dispatch({ type: 'SET_SETTING', key, value });
  }, []);

  // Enhanced setSetting that also stores per-state customization
  const setSettingWithCustomization = useCallback(<K extends keyof AtlasSettings>(key: K, value: AtlasSettings[K], currentState: WakeWordState) => {
    const keyStr = key as string;
    if ((NEBULA_CUSTOMIZABLE_KEYS as readonly string[]).includes(keyStr)) {
      const configKey = SETTING_TO_CONFIG_KEY[keyStr as NebulaCustomizableKey];
      if (configKey) {
        dispatch({ type: 'SET_STATE_CUSTOMIZATION', state: currentState, key: configKey, value: value as string | number | boolean });
      }
    }
    dispatch({ type: 'SET_SETTING', key, value });
  }, []);

  const setMultiple = useCallback((newSettings: Partial<AtlasSettings>) => {
    dispatch({ type: 'SET_MULTIPLE', settings: newSettings });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const resetCurrentState = useCallback(() => {
    dispatch({ type: 'RESET_STATE_CUSTOMIZATIONS', state: settings.state });
    // Also update display to show default values
    const baseConfig = NEBULA_STATE_CONFIGS[settings.state];
    dispatch({
      type: 'SET_MULTIPLE',
      settings: {
        nebulaFlowStrength: baseConfig.flowStrength,
        nebulaFlowSpeed: baseConfig.flowSpeed,
        nebulaRimIntensity: baseConfig.rimIntensity,
        nebulaHotSpotIntensity: baseConfig.hotSpotIntensity,
        nebulaBreathingSpeed: baseConfig.breathingSpeed,
        nebulaBreathingAmount: baseConfig.breathingAmount,
        nebulaRadiusNoise: baseConfig.radiusNoise,
        nebulaGlowIntensity: baseConfig.glowIntensity,
        nebulaColorStart: baseConfig.colorStart,
        nebulaColorMid: baseConfig.colorMid,
        nebulaColorEnd: baseConfig.colorEnd,
      },
    });
  }, [settings.state]);

  const resetAllCustomizations = useCallback(() => {
    dispatch({ type: 'RESET_ALL_CUSTOMIZATIONS' });
    // Update display to show current state's default values
    const baseConfig = NEBULA_STATE_CONFIGS[settings.state];
    dispatch({
      type: 'SET_MULTIPLE',
      settings: {
        nebulaFlowStrength: baseConfig.flowStrength,
        nebulaFlowSpeed: baseConfig.flowSpeed,
        nebulaRimIntensity: baseConfig.rimIntensity,
        nebulaHotSpotIntensity: baseConfig.hotSpotIntensity,
        nebulaBreathingSpeed: baseConfig.breathingSpeed,
        nebulaBreathingAmount: baseConfig.breathingAmount,
        nebulaRadiusNoise: baseConfig.radiusNoise,
        nebulaGlowIntensity: baseConfig.glowIntensity,
        nebulaColorStart: baseConfig.colorStart,
        nebulaColorMid: baseConfig.colorMid,
        nebulaColorEnd: baseConfig.colorEnd,
      },
    });
  }, [settings.state]);

  // Set customization for a specific state (not necessarily the current state)
  const setStateCustomization = useCallback((
    stateName: WakeWordState,
    key: keyof NebulaStateConfig,
    value: string | number | boolean
  ) => {
    dispatch({ type: 'SET_STATE_CUSTOMIZATION', state: stateName, key, value });
  }, []);

  // Reset customizations for a specific state
  const resetStateCustomizations = useCallback((stateName: WakeWordState) => {
    dispatch({ type: 'RESET_STATE_CUSTOMIZATIONS', state: stateName });
  }, []);

  const exportSettings = useCallback(() => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atlas-settings-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [settings]);

  const importSettings = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const imported = JSON.parse(ev.target?.result as string);
          dispatch({ type: 'LOAD', settings: { ...defaultAtlasSettings, ...imported } });
        } catch {
          console.error('Invalid settings file');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  // Wrap setSetting to include state customization
  const setSettingWrapped = useCallback(<K extends keyof AtlasSettings>(key: K, value: AtlasSettings[K]) => {
    setSettingWithCustomization(key, value, settings.state);
  }, [setSettingWithCustomization, settings.state]);

  return useMemo(() => ({
    settings,
    setSetting: setSettingWrapped,
    setMultiple,
    setStateCustomization,
    resetStateCustomizations,
    reset,
    resetCurrentState,
    resetAllCustomizations,
    exportSettings,
    importSettings,
  }), [settings, setSettingWrapped, setMultiple, setStateCustomization, resetStateCustomizations, reset, resetCurrentState, resetAllCustomizations, exportSettings, importSettings]);
}

// Read-only hook for components that just need to display the sphere
// Includes real-time sync via localStorage events
export function useAtlasSettingsReadOnly(): AtlasSettings {
  const [settings, setSettings] = useState<AtlasSettings>(() => loadSettings());

  // Listen for localStorage changes from other components/tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setSettings(loadSettings());
      }
    };

    // Also listen for custom events dispatched within the same tab
    const handleCustomStorageChange = () => {
      setSettings(loadSettings());
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('atlas-settings-changed', handleCustomStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('atlas-settings-changed', handleCustomStorageChange);
    };
  }, []);

  return settings;
}
