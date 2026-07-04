import { useState, useEffect, useRef, useCallback } from 'react';
import { detectPerformanceTier, PerformanceTier } from '@/lib/performance';
import { isWindowActive } from '@/hooks/useWindowActivity';

export interface QualitySettings {
  particleCount: number;
  enableTrails: boolean;
  trailLength: number;
  enableBloom: boolean;
  bloomIntensity: number;
  enableCore: boolean;
  coreParticleCount: number;
  targetFPS: number;
  tier: PerformanceTier;
}

interface QualityPreset {
  particleCount: number;
  enableTrails: boolean;
  trailLength: number;
  enableBloom: boolean;
  bloomIntensity: number;
  enableCore: boolean;
  coreParticleCount: number;
}

const QUALITY_PRESETS: Record<PerformanceTier, QualityPreset> = {
  high: {
    particleCount: 8000,
    enableTrails: true,
    trailLength: 4,
    enableBloom: true,
    bloomIntensity: 0.8,
    enableCore: true,
    coreParticleCount: 500,
  },
  medium: {
    particleCount: 5000,
    enableTrails: true,
    trailLength: 2,
    enableBloom: true,
    bloomIntensity: 0.6,
    enableCore: true,
    coreParticleCount: 300,
  },
  low: {
    particleCount: 2500,
    enableTrails: false,
    trailLength: 0,
    enableBloom: false,
    bloomIntensity: 0,
    enableCore: true,
    coreParticleCount: 150,
  },
};

const FPS_SAMPLES = 30;
const REDUCE_QUALITY_THRESHOLD = 40;
const RESTORE_QUALITY_THRESHOLD = 55;
// Report FPS to consumers at most this often — updating state every rAF tick
// re-renders the whole sphere 60x/s (the original reason this hook sat unused).
const FPS_REPORT_INTERVAL_MS = 1000;
// Minimum time between quality transitions. Each transition rebuilds particle
// geometry (a visible hitch), so without a cooldown the level oscillates and
// the sphere "blinks".
const QUALITY_CHANGE_COOLDOWN_MS = 5000;

/**
 * Adaptive quality system that monitors FPS and automatically
 * adjusts quality settings to maintain smooth performance
 */
export function useAdaptiveQuality(
  enabled: boolean = true,
  initialTier?: PerformanceTier
): {
  quality: QualitySettings;
  currentFPS: number;
  tier: PerformanceTier;
  forceQuality: (tier: PerformanceTier) => void;
  resetToAuto: () => void;
} {
  const [tier, setTier] = useState<PerformanceTier>(
    initialTier ?? detectPerformanceTier()
  );
  const [quality, setQuality] = useState<QualitySettings>(() => ({
    ...QUALITY_PRESETS[tier],
    targetFPS: 60,
    tier,
  }));
  const [currentFPS, setCurrentFPS] = useState(60);
  
  const fpsSamplesRef = useRef<number[]>([]);
  const lastFrameTimeRef = useRef(performance.now());
  const isManualRef = useRef(false);
  const degradationLevelRef = useRef(0); // 0 = full quality, 3 = max degradation

  // Declared before the FPS-monitoring effect that lists it as a dependency
  // (a dep array evaluates at render time — referencing it later is a TDZ crash)
  const applyDegradation = useCallback((level: number) => {
    const basePreset = QUALITY_PRESETS[tier];

    // Progressive degradation
    const degradations: Partial<QualityPreset>[] = [
      {}, // Level 0: Full quality
      {
        trailLength: Math.max(0, basePreset.trailLength - 2),
        bloomIntensity: basePreset.bloomIntensity * 0.5,
      }, // Level 1: Reduce trails and bloom
      {
        enableTrails: false,
        trailLength: 0,
        enableBloom: false,
        coreParticleCount: Math.floor(basePreset.coreParticleCount * 0.5),
      }, // Level 2: Disable trails and bloom
      {
        enableTrails: false,
        trailLength: 0,
        enableBloom: false,
        enableCore: false,
        particleCount: Math.floor(basePreset.particleCount * 0.6),
      }, // Level 3: Maximum degradation
    ];

    const degradation = degradations[Math.min(level, 3)];

    setQuality(prev => ({
      ...prev,
      ...basePreset,
      ...degradation,
    }));
  }, [tier]);

  // FPS monitoring. Sampling runs every frame (cheap refs only); React state
  // updates are throttled to once a second, and quality transitions have a
  // cooldown + sample reset so the level settles instead of oscillating.
  useEffect(() => {
    if (!enabled) return;

    let animationId: number;
    let lastReportAt = performance.now();
    let lastQualityChangeAt = 0;

    const measureFPS = () => {
      const now = performance.now();
      const delta = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;

      // Ignore pathological deltas (window was hidden/blurred and rAF was
      // throttled) — they would read as "low FPS" and degrade quality for
      // nothing. Also drop stale samples so recovery is judged on fresh data.
      if (delta > 250 || !isWindowActive()) {
        fpsSamplesRef.current = [];
        animationId = requestAnimationFrame(measureFPS);
        return;
      }

      const fps = 1000 / delta;

      fpsSamplesRef.current.push(fps);
      if (fpsSamplesRef.current.length > FPS_SAMPLES) {
        fpsSamplesRef.current.shift();
      }

      const avgFPS = fpsSamplesRef.current.reduce((a, b) => a + b, 0) /
        fpsSamplesRef.current.length;

      // Throttled state update — and only when the rounded value changed
      if (now - lastReportAt >= FPS_REPORT_INTERVAL_MS) {
        lastReportAt = now;
        const rounded = Math.round(avgFPS);
        setCurrentFPS(prev => (prev === rounded ? prev : rounded));
      }

      // Auto-adjust quality: full sample window + cooldown between changes
      if (
        !isManualRef.current &&
        fpsSamplesRef.current.length >= FPS_SAMPLES &&
        now - lastQualityChangeAt >= QUALITY_CHANGE_COOLDOWN_MS
      ) {
        if (avgFPS < REDUCE_QUALITY_THRESHOLD && degradationLevelRef.current < 3) {
          degradationLevelRef.current++;
          lastQualityChangeAt = now;
          fpsSamplesRef.current = [];
          applyDegradation(degradationLevelRef.current);
        } else if (avgFPS > RESTORE_QUALITY_THRESHOLD && degradationLevelRef.current > 0) {
          degradationLevelRef.current--;
          lastQualityChangeAt = now;
          fpsSamplesRef.current = [];
          applyDegradation(degradationLevelRef.current);
        }
      }

      animationId = requestAnimationFrame(measureFPS);
    };

    animationId = requestAnimationFrame(measureFPS);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [enabled, applyDegradation]);

  const forceQuality = useCallback((newTier: PerformanceTier) => {
    isManualRef.current = true;
    degradationLevelRef.current = 0;
    setTier(newTier);
    setQuality({
      ...QUALITY_PRESETS[newTier],
      targetFPS: 60,
      tier: newTier,
    });
  }, []);

  const resetToAuto = useCallback(() => {
    isManualRef.current = false;
    degradationLevelRef.current = 0;
    const detectedTier = detectPerformanceTier();
    setTier(detectedTier);
    setQuality({
      ...QUALITY_PRESETS[detectedTier],
      targetFPS: 60,
      tier: detectedTier,
    });
  }, []);

  return {
    quality,
    currentFPS,
    tier,
    forceQuality,
    resetToAuto,
  };
}
