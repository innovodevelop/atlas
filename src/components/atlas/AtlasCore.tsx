import { useRef, memo, forwardRef, MutableRefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
import { WakeWordState } from '@/types';
import { GPUParticleSystem, GPUCoreSystem, TrailSystem, RippleSystem, NebulaFlowSystem } from './systems';
import { STATE_CONFIGS } from './utils/stateConfigs';
import { useWindowActivity } from '@/hooks/useWindowActivity';

export interface AtlasCoreProps {
  state: WakeWordState;
  audioLevel?: number;
  audioLevelRef?: MutableRefObject<number>;
  morphProgress?: number;
  // Pixel-stable rendering props
  containerWidth?: number;
  containerHeight?: number;
  pixelRatio?: number;
  dynamicParticleCount?: number;
  // Particle mode: 'density' uses dynamic calculation, 'fixed' uses manual count
  nebulaParticleMode?: 'density' | 'fixed';
  // Trail settings
  enableTrails?: boolean;
  trailLength?: number;
  trailOpacity?: number;
  trailColorGradient?: boolean;
  trailStartColor?: string;
  trailEndColor?: string;
  // Particle settings
  particleCount?: number;
  particleSize?: number;
  density?: number;
  rotationSpeed?: number;
  // Effects
  enableBloom?: boolean;
  bloomIntensity?: number;
  morphSpeed?: number;
  // Ripple settings
  enableRipples?: boolean;
  rippleSpeed?: number;
  rippleCount?: number;
  // Turbulence settings
  enableTurbulence?: boolean;
  turbulenceFrequency?: number;
  turbulenceAmplitude?: number;
  turbulenceSpeed?: number;
  // Mouse interaction
  enableMouseInteraction?: boolean;
  mouseMode?: 'attract' | 'repulse';
  mouseStrength?: number;
  mouseInfluenceRadius?: number;
  // Core system
  enableCore?: boolean;
  coreParticleCount?: number;
  coreDensity?: number;
  coreParticleSize?: number;
  coreIntensity?: number;
  corePulseSpeed?: number;
  coreRotationOffset?: number;
  // Fluid dynamics
  fluidCohesion?: number;
  surfaceTension?: number;
  fluidFlow?: number;
  audioReactivitySpeed?: number;
  /**
   * Camera Z distance.
   */
  cameraZ?: number;
  // Visualization mode
  visualizationMode?: 'classic' | 'nebulaFlow';
  // Nebula Flow settings
  nebulaFlowStrength?: number;
  nebulaFlowSpeed?: number;
  nebulaBandCount?: number;
  nebulaRimIntensity?: number;
  nebulaHotSpotIntensity?: number;
  nebulaBreathingSpeed?: number;
  nebulaBreathingAmount?: number;
  nebulaRadiusNoise?: number;
  nebulaColorStart?: string;
  nebulaColorMid?: string;
  nebulaColorEnd?: string;
  // Enhanced Nebula settings
  nebulaParticleCount?: number;
  nebulaParticleSize?: number;
  nebulaDensity?: number;
  nebulaRotationSpeed?: number;
  nebulaStateReactive?: boolean;
  nebulaGlowIntensity?: number;
  nebulaDepthFade?: number;
  nebulaCoreGlow?: number;
  // Solid Surface settings
  nebulaSolidSurface?: boolean;
  nebulaSurfaceBlend?: number;
  nebulaUniformSize?: number;
  nebulaCoherence?: number;
  // State behavior settings
  nebulaThinkingRetraction?: number;
  nebulaAudioBreathingIntensity?: number;
  nebulaTransitionSpeed?: number;
  // Per-state customizations
  nebulaStateCustomizations?: Partial<Record<WakeWordState, Partial<{
    colorStart: string;
    colorMid: string;
    colorEnd: string;
    flowSpeed: number;
    flowStrength: number;
    rimIntensity: number;
    hotSpotIntensity: number;
    breathingSpeed: number;
    breathingAmount: number;
    radiusNoise: number;
    glowIntensity: number;
  }>>>;
}

// Bloom wrapper - lower quality for performance. frameBufferType must stay
// HalfFloat: integer buffers drop the alpha channel and the composer then
// paints an opaque square over transparent canvases (the "boxed sphere" bug).
const BloomEffect = memo(({ intensity }: { intensity: number }) => (
  <EffectComposer multisampling={0} frameBufferType={THREE.HalfFloatType}>
    <Bloom
      intensity={intensity}
      luminanceThreshold={0.2}
      luminanceSmoothing={0.9}
      radius={0.8}
      mipmapBlur
    />
  </EffectComposer>
));

BloomEffect.displayName = 'BloomEffect';

// CSS Fallback orb
const CSSFallbackOrb = memo(({ state, audioLevel }: { state: WakeWordState; audioLevel: number }) => {
  const config = STATE_CONFIGS[state];
  const colorHex = '#' + config.primary.getHexString();
  const coreHex = '#' + config.core.getHexString();
  
  return (
    <div className="w-full h-full flex items-center justify-center">
      <div 
        className="relative w-32 h-32 rounded-full animate-pulse"
        style={{
          background: `radial-gradient(circle at 30% 30%, ${coreHex}, ${colorHex} 50%, transparent 70%)`,
          boxShadow: `0 0 ${30 + audioLevel * 50}px ${colorHex}, inset 0 0 20px ${coreHex}`,
          transform: `scale(${1 + audioLevel * 0.2})`,
          transition: 'all 0.3s ease-out',
        }}
      >
        <div 
          className="absolute inset-2 rounded-full opacity-60"
          style={{
            background: `radial-gradient(circle at 40% 40%, white 0%, ${coreHex} 30%, transparent 60%)`,
          }}
        />
      </div>
    </div>
  );
});

CSSFallbackOrb.displayName = 'CSSFallbackOrb';

// ParticleSystem - orchestrates all systems
const ParticleSystem = memo(({
  state,
  audioLevelRef,
  morphProgress = 1,
  // Pixel-stable props
  pixelRatio = 1,
  containerWidth = 200,
  containerHeight = 200,
  dynamicParticleCount,
  // Trail settings
  enableTrails = false,
  trailLength = 4,
  trailOpacity = 0.4,
  trailColorGradient = true,
  trailStartColor = '#ff9500',
  trailEndColor = '#1a0a2e',
  particleCount = 1500,
  particleSize = 0.08,
  density = 1.0,
  rotationSpeed = 0.5,
  enableRipples = true,
  rippleSpeed = 1.5,
  rippleCount = 2,
  enableTurbulence = true,
  turbulenceAmplitude = 0.06,
  turbulenceFrequency = 0.5,
  turbulenceSpeed = 0.3,
  enableMouseInteraction = true,
  mouseMode = 'attract' as const,
  mouseStrength = 0.4,
  mouseInfluenceRadius = 2.0,
  enableCore = true,
  coreParticleCount = 120,
  coreDensity = 0.25,
  coreParticleSize = 0.04,
  coreIntensity = 1.0,
  corePulseSpeed = 1.5,
  coreRotationOffset = -0.5,
  fluidCohesion = 0,
  surfaceTension = 0.5,
  fluidFlow = 0.3,
  mousePosition,
  visualizationMode = 'classic',
  nebulaFlowStrength = 0.5,
  nebulaFlowSpeed = 0.5,
  nebulaBandCount = 8,
  nebulaRimIntensity = 1.2,
  nebulaHotSpotIntensity = 0.8,
  nebulaBreathingSpeed = 0.5,
  nebulaBreathingAmount = 0.05,
  nebulaRadiusNoise = 0.15,
  nebulaColorStart = '#1a0a3e',
  nebulaColorMid = '#8b5cf6',
  nebulaColorEnd = '#67e8f9',
  nebulaParticleCount = 8000,
  nebulaParticleMode = 'fixed',
  nebulaParticleSize = 0.05,
  nebulaDensity = 1.0,
  nebulaRotationSpeed = 0.2,
  nebulaStateReactive = true,
  nebulaGlowIntensity = 1.0,
  nebulaDepthFade = 0.3,
  nebulaCoreGlow = 1.0,
  nebulaSolidSurface = false,
  nebulaSurfaceBlend = 1.5,
  nebulaUniformSize = 1.8,
  nebulaCoherence = 0.9,
  nebulaThinkingRetraction = 0.25,
  nebulaAudioBreathingIntensity = 0.15,
  nebulaTransitionSpeed = 1.5,
  nebulaStateCustomizations = {},
}: Omit<AtlasCoreProps, 'audioLevel'> & {
  audioLevelRef: MutableRefObject<number>;
  mousePosition: MutableRefObject<{ x: number; y: number; active: boolean }>;
}) => {
  const trailGeometryRef = useRef<THREE.BufferGeometry | null>(null);
  const config = STATE_CONFIGS[state];
  
  // Particle count: use manual setting in 'fixed' mode, dynamic calculation in 'density' mode
  const effectiveParticleCount = nebulaParticleMode === 'density' && dynamicParticleCount 
    ? dynamicParticleCount 
    : nebulaParticleCount;

  // Nebula Flow mode
  if (visualizationMode === 'nebulaFlow') {
    return (
      <group>
        <NebulaFlowSystem
          state={state}
          audioLevelRef={audioLevelRef}
          morphProgress={morphProgress}
          particleCount={effectiveParticleCount}
          particleSize={nebulaParticleSize}
          density={nebulaDensity}
          rotationSpeed={nebulaRotationSpeed}
          flowStrength={nebulaFlowStrength}
          flowSpeed={nebulaFlowSpeed}
          bandCount={nebulaBandCount}
          rimIntensity={nebulaRimIntensity}
          hotSpotIntensity={nebulaHotSpotIntensity}
          breathingSpeed={nebulaBreathingSpeed}
          breathingAmount={nebulaBreathingAmount}
          radiusNoise={nebulaRadiusNoise}
          colorStart={nebulaColorStart}
          colorMid={nebulaColorMid}
          colorEnd={nebulaColorEnd}
          stateReactive={nebulaStateReactive}
          glowIntensity={nebulaGlowIntensity}
          depthFade={nebulaDepthFade}
          coreGlow={nebulaCoreGlow}
          solidSurface={nebulaSolidSurface}
          surfaceBlend={nebulaSurfaceBlend}
          uniformSize={nebulaUniformSize}
          coherence={nebulaCoherence}
          thinkingRetraction={nebulaThinkingRetraction}
          audioBreathingIntensity={nebulaAudioBreathingIntensity}
          transitionSpeed={nebulaTransitionSpeed}
          // Per-state customizations for blending
          stateCustomizations={nebulaStateCustomizations}
          // Pixel-stable rendering props
          pixelRatio={pixelRatio}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
        />
      </group>
    );
  }

  // Classic mode
  return (
    <group>
      <RippleSystem
        state={state}
        enabled={enableRipples}
        rippleSpeed={rippleSpeed}
        rippleCount={rippleCount}
      />
      
      {enableTrails && trailLength > 0 && (
        <TrailSystem
          particleCount={Math.min(particleCount, 1000)}
          trailLength={trailLength}
          trailOpacity={trailOpacity}
          colorStart={trailColorGradient ? new THREE.Color(trailStartColor) : config.secondary}
          colorEnd={trailColorGradient ? new THREE.Color(trailEndColor) : config.secondary}
          enableGradient={trailColorGradient}
          geometryRef={trailGeometryRef}
        />
      )}
      
      <GPUParticleSystem
        state={state}
        audioLevelRef={audioLevelRef}
        morphProgress={morphProgress}
        particleCount={particleCount}
        particleSize={particleSize}
        density={density}
        rotationSpeed={rotationSpeed}
        enableTurbulence={enableTurbulence}
        turbulenceAmplitude={turbulenceAmplitude}
        turbulenceFrequency={turbulenceFrequency}
        turbulenceSpeed={turbulenceSpeed}
        enableMouseInteraction={enableMouseInteraction}
        mouseMode={mouseMode}
        mouseStrength={mouseStrength}
        mouseInfluenceRadius={mouseInfluenceRadius}
        mousePosition={mousePosition}
        fluidCohesion={fluidCohesion}
        surfaceTension={surfaceTension}
        fluidFlow={fluidFlow}
      />

      {enableCore && (
        <GPUCoreSystem
          state={state}
          audioLevelRef={audioLevelRef}
          morphProgress={morphProgress}
          coreParticleCount={coreParticleCount}
          coreDensity={coreDensity}
          coreParticleSize={coreParticleSize}
          coreIntensity={coreIntensity}
          corePulseSpeed={corePulseSpeed}
          coreRotationOffset={coreRotationOffset}
        />
      )}
    </group>
  );
});

ParticleSystem.displayName = 'ParticleSystem';

/**
 * AtlasCore - Optimized Atlas sphere visualization
 * - Reduced default particle counts
 * - Simplified shaders
 * - Lower DPR for performance
 * - Trails disabled by default
 */
export const AtlasCore = memo(forwardRef<HTMLDivElement, AtlasCoreProps>(({ 
  state, 
  audioLevel = 0,
  audioLevelRef: externalAudioLevelRef,
  morphProgress = 1.0,
  // Pixel-stable rendering props
  containerWidth,
  containerHeight,
  pixelRatio = 1,
  dynamicParticleCount,
  // Trail settings
  enableTrails = false,
  trailLength = 4,
  trailOpacity = 0.4,
  trailColorGradient = true,
  trailStartColor = '#ff9500',
  trailEndColor = '#1a0a2e',
  particleCount = 1500,
  particleSize = 0.08,
  density = 1.0,
  rotationSpeed = 0.5,
  enableBloom = true,
  bloomIntensity = 0.6,
  morphSpeed = 1.5,
  enableRipples = true,
  rippleSpeed = 1.5,
  rippleCount = 2,
  enableTurbulence = true,
  turbulenceFrequency = 0.5,
  turbulenceAmplitude = 0.06,
  turbulenceSpeed = 0.3,
  enableMouseInteraction = true,
  mouseMode = 'attract',
  mouseStrength = 0.4,
  mouseInfluenceRadius = 2.0,
  enableCore = true,
  coreParticleCount = 120,
  coreDensity = 0.25,
  coreParticleSize = 0.04,
  coreIntensity = 1.0,
  corePulseSpeed = 1.5,
  coreRotationOffset = -0.5,
  fluidCohesion = 0,
  surfaceTension = 0.5,
  fluidFlow = 0.3,
  audioReactivitySpeed = 1.0,
  cameraZ = 4.5,
  visualizationMode = 'classic',
  nebulaFlowStrength = 0.5,
  nebulaFlowSpeed = 0.5,
  nebulaBandCount = 8,
  nebulaRimIntensity = 1.2,
  nebulaHotSpotIntensity = 0.8,
  nebulaBreathingSpeed = 0.5,
  nebulaBreathingAmount = 0.05,
  nebulaRadiusNoise = 0.15,
  nebulaColorStart = '#1a0a3e',
  nebulaColorMid = '#8b5cf6',
  nebulaColorEnd = '#67e8f9',
  nebulaParticleCount = 8000,
  nebulaParticleSize = 0.05,
  nebulaDensity = 1.0,
  nebulaRotationSpeed = 0.2,
  nebulaStateReactive = true,
  nebulaGlowIntensity = 1.0,
  nebulaDepthFade = 0.3,
  nebulaCoreGlow = 1.0,
  nebulaSolidSurface = false,
  nebulaSurfaceBlend = 1.5,
  nebulaUniformSize = 1.8,
  nebulaCoherence = 0.9,
  nebulaThinkingRetraction = 0.25,
  nebulaAudioBreathingIntensity = 0.15,
  nebulaTransitionSpeed = 1.5,
  nebulaStateCustomizations = {},
}, ref) => {
  const mousePositionRef = useRef({ x: 0, y: 0, active: false });
  const internalAudioLevelRef = useRef(audioLevel);
  const audioLevelRefToUse = externalAudioLevelRef || internalAudioLevelRef;
  
  if (!externalAudioLevelRef) {
    internalAudioLevelRef.current = audioLevel;
  }
  
  // Pause the whole render loop when the window is hidden/blurred — the
  // sphere is the single biggest idle CPU/GPU consumer.
  const windowActive = useWindowActivity();

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    mousePositionRef.current = { x, y, active: true };
  };
  
  const handlePointerLeave = () => {
    mousePositionRef.current.active = false;
  };

  return (
    <div 
      ref={ref} 
      className="w-full h-full"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <Canvas
        camera={{ position: [0, 0, cameraZ], fov: 45 }}
        gl={{ antialias: false, alpha: true, premultipliedAlpha: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false }}
        style={{ background: 'transparent' }}
        dpr={pixelRatio}
        frameloop={windowActive ? 'always' : 'never'}
        onCreated={({ gl }) => { gl.setClearColor(0x000000, 0); }}
        fallback={<CSSFallbackOrb state={state} audioLevel={audioLevelRefToUse.current} />}
      >
        <ParticleSystem 
          state={state} 
          audioLevelRef={audioLevelRefToUse}
          morphProgress={morphProgress}
          pixelRatio={pixelRatio}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
          dynamicParticleCount={dynamicParticleCount}
          enableTrails={enableTrails}
          trailLength={trailLength}
          trailOpacity={trailOpacity}
          trailColorGradient={trailColorGradient}
          trailStartColor={trailStartColor}
          trailEndColor={trailEndColor}
          particleCount={particleCount}
          particleSize={particleSize}
          density={density}
          rotationSpeed={rotationSpeed}
          morphSpeed={morphSpeed}
          enableRipples={enableRipples}
          rippleSpeed={rippleSpeed}
          rippleCount={rippleCount}
          enableTurbulence={enableTurbulence}
          turbulenceAmplitude={turbulenceAmplitude}
          turbulenceFrequency={turbulenceFrequency}
          turbulenceSpeed={turbulenceSpeed}
          enableMouseInteraction={enableMouseInteraction}
          mouseMode={mouseMode}
          mouseStrength={mouseStrength}
          mouseInfluenceRadius={mouseInfluenceRadius}
          enableCore={enableCore}
          coreParticleCount={coreParticleCount}
          coreDensity={coreDensity}
          coreParticleSize={coreParticleSize}
          coreIntensity={coreIntensity}
          corePulseSpeed={corePulseSpeed}
          coreRotationOffset={coreRotationOffset}
          fluidCohesion={fluidCohesion}
          surfaceTension={surfaceTension}
          fluidFlow={fluidFlow}
          mousePosition={mousePositionRef}
          visualizationMode={visualizationMode}
          nebulaFlowStrength={nebulaFlowStrength}
          nebulaFlowSpeed={nebulaFlowSpeed}
          nebulaBandCount={nebulaBandCount}
          nebulaRimIntensity={nebulaRimIntensity}
          nebulaHotSpotIntensity={nebulaHotSpotIntensity}
          nebulaBreathingSpeed={nebulaBreathingSpeed}
          nebulaBreathingAmount={nebulaBreathingAmount}
          nebulaRadiusNoise={nebulaRadiusNoise}
          nebulaColorStart={nebulaColorStart}
          nebulaColorMid={nebulaColorMid}
          nebulaColorEnd={nebulaColorEnd}
          nebulaParticleCount={nebulaParticleCount}
          nebulaParticleSize={nebulaParticleSize}
          nebulaDensity={nebulaDensity}
          nebulaRotationSpeed={nebulaRotationSpeed}
          nebulaStateReactive={nebulaStateReactive}
          nebulaGlowIntensity={nebulaGlowIntensity}
          nebulaDepthFade={nebulaDepthFade}
          nebulaCoreGlow={nebulaCoreGlow}
          nebulaSolidSurface={nebulaSolidSurface}
          nebulaSurfaceBlend={nebulaSurfaceBlend}
          nebulaUniformSize={nebulaUniformSize}
          nebulaCoherence={nebulaCoherence}
          nebulaThinkingRetraction={nebulaThinkingRetraction}
          nebulaAudioBreathingIntensity={nebulaAudioBreathingIntensity}
          nebulaTransitionSpeed={nebulaTransitionSpeed}
          nebulaStateCustomizations={nebulaStateCustomizations}
        />
        
        {enableBloom && <BloomEffect intensity={bloomIntensity} />}
      </Canvas>
    </div>
  );
}));

AtlasCore.displayName = 'AtlasCore';

export default AtlasCore;
