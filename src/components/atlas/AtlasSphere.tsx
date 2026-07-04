import { memo, useRef } from 'react';
import { AtlasCore } from './AtlasCore';
import { useAdaptiveQuality } from './hooks/useAdaptiveQuality';
import { useAtlasSettingsReadOnly } from '@/hooks/useAtlasSettings';
import { useSphereRenderer } from '@/hooks/useSphereRenderer';
import { cn } from '@/lib/utils';
import type { WakeWordState, AIState } from '@/types';

/**
 * Context types for different usage scenarios.
 */
export type AtlasSphereContext = 'dashboard' | 'core' | 'teach' | 'demo' | 'legacy' | 'mini';

// Helper to convert AIState to WakeWordState
const aiStateToWakeWord = (state: AIState): WakeWordState => {
  const stateMap: Record<AIState, WakeWordState> = {
    'idle': 'passive',
    'listening': 'listening',
    'thinking': 'thinking',
    'speaking': 'speaking',
  };
  return stateMap[state] || 'passive';
};

export interface AtlasSphereProps {
  /** AI state - accepts both WakeWordState and AIState */
  state: WakeWordState | AIState;
  /** Audio level 0-1 */
  audioLevel: number;
  /** Context preset - determines camera distance and optimizations */
  context?: AtlasSphereContext;
  /** Override morph progress (0-1) */
  overrideMorphProgress?: number;
  /** Override state for demo purposes */
  overrideState?: WakeWordState;
  /** Custom camera Z (overrides computed value) */
  cameraZ?: number;
  /** Click handler */
  onClick?: () => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * AtlasSphere - Pixel-stable sphere component with ResizeObserver-based sizing.
 * 
 * This component renders the WebGL canvas at native resolution for the container,
 * ensuring consistent visual appearance across all sizes without CSS scaling artifacts.
 * 
 * Key features:
 * - Native canvas resolution (no CSS transform scaling)
 * - Dynamic particle count based on container area (particles per megapixel)
 * - Pixel-stable point sizes for consistent visuals
 * - Automatic camera Z adjustment based on container size
 * 
 * @example
 * // Dashboard usage (any size container)
 * <AtlasSphere state={state} audioLevel={level} context="dashboard" />
 * 
 * @example
 * // Demo with custom settings
 * <AtlasSphere state={state} audioLevel={level} context="demo" overrideState="listening" />
 */
const AtlasSphereComponent = ({
  state,
  audioLevel,
  context = 'demo',
  overrideMorphProgress,
  overrideState,
  cameraZ: customCameraZ,
  onClick,
  className,
}: AtlasSphereProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Use the pixel-stable renderer hook
  const renderState = useSphereRenderer(containerRef);
  
  // Read settings from localStorage (single source of truth)
  const settings = useAtlasSettingsReadOnly();

  // Normalize state to WakeWordState
  const normalizedState: WakeWordState = ['idle', 'listening', 'thinking', 'speaking'].includes(state)
    ? aiStateToWakeWord(state as AIState)
    : state as WakeWordState;

  // Apply overrides
  const effectiveState = overrideState ?? normalizedState;
  
  // For mini/dashboard contexts, force morph to 1.0 for formed sphere
  const forceMorph = context === 'mini' || context === 'dashboard';
  const effectiveMorphProgress = forceMorph 
    ? 1.0 
    : (overrideMorphProgress ?? settings.morphProgress);

  // Use computed camera Z or custom override
  const finalCameraZ = customCameraZ ?? renderState.cameraZ;

  // Adaptive quality: FPS-monitored degradation ladder (trails -> bloom ->
  // core -> particle count). The hook existed but was never wired in; the
  // sphere now self-throttles instead of dropping frames on weaker GPUs.
  const { quality } = useAdaptiveQuality(true);
  const degraded = quality.tier !== 'high' || !quality.enableBloom;
  const effectiveParticleCount = Math.min(renderState.particleCount, quality.particleCount * 3);
  const effectiveEnableBloom = settings.enableBloom && quality.enableBloom;
  const effectiveEnableTrails = settings.enableTrails && quality.enableTrails;
  const effectiveEnableCore = settings.enableCore && quality.enableCore;

  return (
    <div
      ref={containerRef}
      className={cn('relative w-full h-full flex items-center justify-center cursor-pointer', className)}
      onClick={onClick}
    >
      {renderState.isReady && (
        <AtlasCore
          state={effectiveState}
          audioLevel={audioLevel}
          cameraZ={finalCameraZ}
          morphProgress={effectiveMorphProgress}
          // Pass pixel-stable rendering props
          containerWidth={renderState.containerWidth}
          containerHeight={renderState.containerHeight}
          pixelRatio={renderState.pixelRatio}
          dynamicParticleCount={effectiveParticleCount}
          // Pass all settings
          enableTrails={effectiveEnableTrails}
          trailLength={settings.trailLength}
          trailOpacity={settings.trailOpacity}
          trailColorGradient={settings.trailColorGradient}
          trailStartColor={settings.trailStartColor}
          trailEndColor={settings.trailEndColor}
          particleCount={settings.particleCount}
          particleSize={settings.particleSize}
          density={settings.density}
          rotationSpeed={settings.rotationSpeed}
          enableBloom={effectiveEnableBloom}
          bloomIntensity={degraded ? Math.min(settings.bloomIntensity, quality.bloomIntensity) : settings.bloomIntensity}
          morphSpeed={settings.morphSpeed}
          enableRipples={settings.enableRipples}
          rippleSpeed={settings.rippleSpeed}
          rippleCount={settings.rippleCount}
          enableTurbulence={settings.enableTurbulence}
          turbulenceFrequency={settings.turbulenceFrequency}
          turbulenceAmplitude={settings.turbulenceAmplitude}
          turbulenceSpeed={settings.turbulenceSpeed}
          enableMouseInteraction={settings.enableMouseInteraction}
          mouseMode={settings.mouseMode}
          mouseStrength={settings.mouseStrength}
          mouseInfluenceRadius={settings.mouseInfluenceRadius}
          enableCore={effectiveEnableCore}
          coreParticleCount={Math.min(settings.coreParticleCount, quality.coreParticleCount)}
          coreDensity={settings.coreDensity}
          coreParticleSize={settings.coreParticleSize}
          coreIntensity={settings.coreIntensity}
          corePulseSpeed={settings.corePulseSpeed}
          coreRotationOffset={settings.coreRotationOffset}
          fluidCohesion={settings.fluidCohesion}
          surfaceTension={settings.surfaceTension}
          fluidFlow={settings.fluidFlow}
          audioReactivitySpeed={settings.audioReactivitySpeed}
          visualizationMode={settings.visualizationMode}
          nebulaFlowStrength={settings.nebulaFlowStrength}
          nebulaFlowSpeed={settings.nebulaFlowSpeed}
          nebulaBandCount={settings.nebulaBandCount}
          nebulaRimIntensity={settings.nebulaRimIntensity}
          nebulaHotSpotIntensity={settings.nebulaHotSpotIntensity}
          nebulaBreathingSpeed={settings.nebulaBreathingSpeed}
          nebulaBreathingAmount={settings.nebulaBreathingAmount}
          nebulaRadiusNoise={settings.nebulaRadiusNoise}
          nebulaColorStart={settings.nebulaColorStart}
          nebulaColorMid={settings.nebulaColorMid}
          nebulaColorEnd={settings.nebulaColorEnd}
          nebulaParticleCount={settings.nebulaParticleCount}
          nebulaParticleMode={settings.nebulaParticleMode}
          nebulaParticleSize={settings.nebulaParticleSize}
          nebulaDensity={settings.nebulaDensity}
          nebulaRotationSpeed={settings.nebulaRotationSpeed}
          nebulaStateReactive={settings.nebulaStateReactive}
          nebulaGlowIntensity={settings.nebulaGlowIntensity}
          nebulaDepthFade={settings.nebulaDepthFade}
          nebulaCoreGlow={settings.nebulaCoreGlow}
          nebulaSolidSurface={settings.nebulaSolidSurface}
          nebulaSurfaceBlend={settings.nebulaSurfaceBlend}
          nebulaUniformSize={settings.nebulaUniformSize}
          nebulaCoherence={settings.nebulaCoherence}
          nebulaThinkingRetraction={settings.nebulaThinkingRetraction}
          nebulaAudioBreathingIntensity={settings.nebulaAudioBreathingIntensity}
          nebulaTransitionSpeed={settings.nebulaTransitionSpeed}
          nebulaStateCustomizations={settings.stateCustomizations}
        />
      )}
    </div>
  );
};

export const AtlasSphere = memo(AtlasSphereComponent);
