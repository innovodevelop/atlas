# Atlas Sphere 3D Visualization System

> **SUPERSEDED (2026-08-02).** Kept for history only — do not act on
> this document. Current state and open work: `docs/ROADMAP.md`.

Technical documentation for the Atlas Sphere, a dynamic 3D visualization that responds to AI state and audio input.

## Overview

The Atlas Sphere is a GPU-accelerated particle system that provides visual feedback for the AI assistant's state. It features:

- **6 distinct visual states** with smooth transitions
- **Audio reactivity** - responds to voice input levels
- **Pixel-stable rendering** - crisp at any resolution
- **Adaptive quality** - adjusts particle count based on device capability
- **Two visualization modes** - Classic particles and Nebula Flow

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       AtlasSphere.tsx                           │
│                    (Public API Component)                        │
├─────────────────────────────────────────────────────────────────┤
│  Props: state, audioLevel, context, overrides                   │
│  Handles: sizing, context presets, settings integration         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                        AtlasCore.tsx                            │
│                   (Main Rendering Component)                     │
├─────────────────────────────────────────────────────────────────┤
│  Three.js Canvas with React Three Fiber                         │
│  Manages: camera, lighting, post-processing, systems            │
└────────────┬────────────────┬────────────────┬──────────────────┘
             │                │                │
    ┌────────▼────────┐ ┌─────▼─────┐ ┌────────▼────────┐
    │ NebulaFlowSystem│ │GPUParticle│ │   TrailSystem   │
    │   (nebula mode) │ │  System   │ │  (particle fx)  │
    └─────────────────┘ └───────────┘ └─────────────────┘
             │                │                │
    ┌────────▼────────┐ ┌─────▼─────┐ ┌────────▼────────┐
    │NebulaFlowShaders│ │ Particle  │ │  TrailShaders   │
    │    (GLSL)       │ │  Shaders  │ │    (GLSL)       │
    └─────────────────┘ └───────────┘ └─────────────────┘
```

## Component Hierarchy

### `AtlasSphere` (src/components/atlas/AtlasSphere.tsx)

The public API component that wraps the visualization.

```typescript
interface AtlasSphereProps {
  state: AIState;                    // Current AI state
  audioLevel?: number;               // 0-1 audio input level
  context?: AtlasSphereContext;      // Size/behavior preset
  className?: string;
  onClick?: () => void;
  
  // Overrides
  intensityOverride?: number;
  colorOverride?: string;
  morphProgressOverride?: number;
  
  // Advanced
  enableBloom?: boolean;
  bloomIntensity?: number;
  particleCount?: number;
  cameraZ?: number;
}

type AtlasSphereContext = 
  | 'mini'       // Small inline display
  | 'dashboard'  // Dashboard card
  | 'core'       // Main interaction
  | 'teach'      // Teaching mode
  | 'demo'       // Demo/showcase
  | 'legacy';    // Backward compat
```

### `AtlasCore` (src/components/atlas/AtlasCore.tsx)

The main Three.js rendering component.

```typescript
interface AtlasCoreProps {
  state: WakeWordState;
  audioLevel: number;
  
  // Visualization
  visualizationMode?: 'classic' | 'nebulaFlow';
  particleCount?: number;
  morphProgress?: number;
  
  // Camera
  cameraZ?: number;
  
  // State customizations
  nebulaStateCustomizations?: Partial<Record<WakeWordState, Partial<NebulaStateConfig>>>;
  
  // Effects
  bloomEnabled?: boolean;
  bloomIntensity?: number;
  
  // Debug
  showStats?: boolean;
}
```

## State System

### The 6 States

| State | Description | Visual Characteristics |
|-------|-------------|----------------------|
| `dormant` | Inactive, sleeping | Minimal movement, dark colors, low intensity |
| `passive` | Listening for wake word | Gentle breathing, soft blue glow |
| `activated` | Just triggered | Bright pulse, expanding particles |
| `listening` | User speaking | Audio-reactive, cyan highlights |
| `thinking` | Processing | Swirling motion, violet hues |
| `speaking` | TTS active | Rhythmic pulsing, lavender glow |

### State Configuration

Each state has a configuration object:

```typescript
// src/components/atlas/utils/stateConfigs.ts
interface StateConfig {
  baseColor: THREE.Color;
  accentColor: THREE.Color;
  intensity: number;           // 0-1 overall brightness
  morphProgress: number;       // 0-1 sphere deformation
  particleSpeed: number;       // Particle animation speed
  particleSize: number;        // Base particle size
  pulseFrequency: number;      // Breathing/pulse rate
  noiseScale: number;          // Surface noise amount
}

// Example: listening state
{
  baseColor: new THREE.Color(0.2, 0.8, 1.0),  // Cyan
  accentColor: new THREE.Color(0.4, 0.9, 1.0),
  intensity: 0.9,
  morphProgress: 0.4,
  particleSpeed: 1.5,
  particleSize: 1.2,
  pulseFrequency: 2.0,
  noiseScale: 0.3,
}
```

### Nebula State Configuration

For nebula flow mode, extended configuration:

```typescript
// src/components/atlas/utils/nebulaStateConfigs.ts
interface NebulaStateConfig {
  // Colors
  primaryColor: [number, number, number];   // RGB 0-1
  secondaryColor: [number, number, number];
  hotSpotColor: [number, number, number];
  
  // Animation
  flowSpeed: number;          // Curl noise flow rate
  breathingSpeed: number;     // Expansion/contraction
  breathingIntensity: number; // Breathing amplitude
  
  // Geometry
  coreRetraction: number;     // Core size (0=full, 1=point)
  particleDensity: number;    // Particles per unit
  
  // Effects
  glowIntensity: number;
  rimLightIntensity: number;
  audioReactivity: number;    // Response to audioLevel
}
```

### State Transitions

State changes use exponential decay smoothing:

```typescript
// In useUnifiedAnimation hook
const smoothingFactor = 0.08;  // ~12 frames to 90% completion

currentValue += (targetValue - currentValue) * smoothingFactor;
```

This creates natural, organic transitions between states.

## Shader System

### Nebula Flow Shaders

Location: `src/components/atlas/shaders/nebulaFlowShaders.ts`

#### Vertex Shader

```glsl
uniform float uTime;
uniform float uAudioLevel;
uniform float uMorphProgress;
uniform float uFlowSpeed;
uniform float uBreathingIntensity;
uniform float uCoreRetraction;

attribute float aRandom;
attribute float aSize;

varying vec3 vPosition;
varying float vAudioInfluence;
varying float vDistanceFromCenter;

// Curl noise for organic flow
vec3 curlNoise(vec3 p) {
  // ... implementation
}

void main() {
  vec3 pos = position;
  float dist = length(pos);
  
  // Apply breathing
  float breathing = sin(uTime * uBreathingSpeed) * uBreathingIntensity;
  pos *= 1.0 + breathing;
  
  // Apply curl noise flow
  vec3 flow = curlNoise(pos * 0.5 + uTime * uFlowSpeed);
  pos += flow * uMorphProgress * 0.3;
  
  // Audio reactivity
  pos *= 1.0 + uAudioLevel * 0.2 * aRandom;
  
  // Core retraction
  pos = mix(pos, normalize(pos) * 0.1, uCoreRetraction);
  
  vPosition = pos;
  vDistanceFromCenter = dist;
  vAudioInfluence = uAudioLevel * aRandom;
  
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = aSize * (1.0 + uAudioLevel * 0.5);
}
```

#### Fragment Shader

```glsl
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform vec3 uHotSpotColor;
uniform float uGlowIntensity;
uniform float uRimLightIntensity;

varying vec3 vPosition;
varying float vAudioInfluence;
varying float vDistanceFromCenter;

void main() {
  // Soft circular particle
  vec2 center = gl_PointCoord - 0.5;
  float dist = length(center);
  if (dist > 0.5) discard;
  
  float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
  
  // Color gradient based on position
  float colorMix = smoothstep(0.0, 1.0, vDistanceFromCenter);
  vec3 color = mix(uPrimaryColor, uSecondaryColor, colorMix);
  
  // Hot spots for audio reactivity
  color = mix(color, uHotSpotColor, vAudioInfluence * 0.5);
  
  // Rim glow
  float rim = pow(1.0 - abs(dot(normalize(vPosition), vec3(0, 0, 1))), 2.0);
  color += uSecondaryColor * rim * uRimLightIntensity;
  
  // Overall glow
  color *= 1.0 + uGlowIntensity * 0.5;
  
  gl_FragColor = vec4(color, alpha * 0.8);
}
```

### Particle Shaders

Location: `src/components/atlas/shaders/particleShaders.ts`

Used for the classic visualization mode with discrete particles.

### Pixel-Stable Shaders

Location: `src/components/atlas/shaders/pixelStableShaders.ts`

Ensures particles render at consistent pixel sizes regardless of resolution:

```glsl
uniform float uPixelRatio;
uniform vec2 uResolution;

// Calculate point size in actual pixels
float pointSizeInPixels = baseSize * uPixelRatio;

// Adjust for perspective
float perspectiveScale = uResolution.y / (2.0 * tan(fov / 2.0) * distance);
gl_PointSize = pointSizeInPixels * perspectiveScale;
```

## Rendering Systems

### NebulaFlowSystem

The primary particle system for nebula mode.

```typescript
// src/components/atlas/systems/NebulaFlowSystem.tsx
interface NebulaFlowSystemProps {
  state: WakeWordState;
  audioLevel: number;
  stateConfig: NebulaStateConfig;
  particleCount: number;
  time: number;
}
```

Features:
- 10,000+ GPU-accelerated particles
- Curl noise flow field animation
- Per-particle randomization
- Audio-reactive sizing and color

### GPUParticleSystem

Classic discrete particle system.

```typescript
// src/components/atlas/systems/GPUParticleSystem.tsx
interface GPUParticleSystemProps {
  state: WakeWordState;
  audioLevel: number;
  particleCount: number;
  sphereRadius: number;
}
```

### GPUCoreSystem

Central glowing core effect.

### TrailSystem

Particle trail effects for motion emphasis.

### RippleSystem

Ripple effects on state changes.

## Adaptive Quality

The system automatically adjusts quality based on device capability:

```typescript
// src/components/atlas/hooks/useAdaptiveQuality.ts
interface QualitySettings {
  particleCount: number;
  bloomEnabled: boolean;
  bloomSamples: number;
  shadowsEnabled: boolean;
  postProcessing: boolean;
}

function useAdaptiveQuality(): QualitySettings {
  // Check device capability
  const gpu = navigator.gpu;  // WebGPU support
  const memory = navigator.deviceMemory;  // RAM
  const cores = navigator.hardwareConcurrency;  // CPU cores
  
  // Mobile detection
  const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
  
  if (isMobile || memory < 4) {
    return { particleCount: 3000, bloomEnabled: false, ... };
  }
  
  if (memory >= 8 && cores >= 4) {
    return { particleCount: 15000, bloomEnabled: true, ... };
  }
  
  return { particleCount: 8000, bloomEnabled: true, ... };
}
```

### Particle Count by Context

```typescript
const contextParticleCounts = {
  mini: 2000,
  dashboard: 5000,
  core: 10000,
  teach: 10000,
  demo: 15000,
  legacy: 8000,
};
```

## Configuration Reference

### AtlasSphereConfig

Global configuration in `src/components/atlas/config/sphereConfig.ts`:

```typescript
interface AtlasSphereConfig {
  // Geometry
  sphereRadius: number;           // Default: 1.0
  sphereSegments: number;         // Default: 64
  
  // Particles
  baseParticleCount: number;      // Default: 10000
  minParticleCount: number;       // Default: 2000
  maxParticleCount: number;       // Default: 20000
  particleSizeBase: number;       // Default: 0.02
  particleSizeVariance: number;   // Default: 0.5
  
  // Animation
  transitionDuration: number;     // Default: 0.5 (seconds)
  smoothingFactor: number;        // Default: 0.08
  
  // Camera
  defaultCameraZ: number;         // Default: 4.0
  minCameraZ: number;             // Default: 2.0
  maxCameraZ: number;             // Default: 8.0
  
  // Effects
  bloomIntensity: number;         // Default: 1.5
  bloomThreshold: number;         // Default: 0.4
  bloomRadius: number;            // Default: 0.8
  
  // Performance
  targetFPS: number;              // Default: 60
  qualityScaleStep: number;       // Default: 0.1
}
```

### Context Size Presets

```typescript
const contextPresets = {
  mini: {
    containerSize: 80,
    cameraZ: 5.0,
    particleScale: 0.3,
    bloomEnabled: false,
  },
  dashboard: {
    containerSize: 200,
    cameraZ: 4.5,
    particleScale: 0.6,
    bloomEnabled: true,
  },
  core: {
    containerSize: 400,
    cameraZ: 4.0,
    particleScale: 1.0,
    bloomEnabled: true,
  },
  fullscreen: {
    containerSize: 'viewport',
    cameraZ: 3.5,
    particleScale: 1.5,
    bloomEnabled: true,
  },
};
```

## Customization Guide

### Per-State Color Overrides

```typescript
<AtlasCore
  state={state}
  audioLevel={audioLevel}
  nebulaStateCustomizations={{
    listening: {
      primaryColor: [0.0, 1.0, 0.5],    // Custom green
      hotSpotColor: [1.0, 1.0, 0.0],    // Yellow hot spots
      audioReactivity: 1.5,              // More reactive
    },
    speaking: {
      primaryColor: [1.0, 0.5, 0.0],    // Orange
      breathingSpeed: 3.0,               // Faster breathing
    },
  }}
/>
```

### Audio Reactivity Tuning

```typescript
// In your component
const [audioLevel, setAudioLevel] = useState(0);

// From audio analyzer
const analyzeAudio = (audioData: Uint8Array) => {
  const average = audioData.reduce((a, b) => a + b) / audioData.length;
  const normalized = average / 255;
  
  // Apply curve for more dramatic effect
  const curved = Math.pow(normalized, 0.7);
  
  setAudioLevel(curved);
};
```

### Bloom Configuration

```typescript
<AtlasCore
  state={state}
  audioLevel={audioLevel}
  bloomEnabled={true}
  bloomIntensity={2.0}        // Higher = more glow
  bloomThreshold={0.3}        // Lower = more bloom
  bloomRadius={1.0}           // Spread of bloom
/>
```

## Performance Optimization

### Tips for Best Performance

1. **Use appropriate context**
   ```typescript
   // For small displays
   <AtlasSphere context="mini" />
   
   // For main interaction
   <AtlasSphere context="core" />
   ```

2. **Disable bloom on mobile**
   ```typescript
   const isMobile = useIsMobile();
   <AtlasSphere enableBloom={!isMobile} />
   ```

3. **Reduce particle count for lists**
   ```typescript
   // When rendering multiple spheres
   {items.map(item => (
     <AtlasSphere 
       key={item.id}
       particleCount={2000}  // Lower for multiple instances
     />
   ))}
   ```

4. **Use memoization**
   ```typescript
   const sphereConfig = useMemo(() => ({
     particleCount: 10000,
     bloomIntensity: 1.5,
   }), []);
   ```

### Debugging Performance

Enable stats display:

```typescript
<AtlasCore
  state={state}
  audioLevel={audioLevel}
  showStats={true}  // Shows FPS counter
/>
```

## Examples

### Basic Usage

```tsx
import { AtlasSphere } from '@/components/atlas';

function MyComponent() {
  const [state, setState] = useState<AIState>('passive');
  const [audioLevel, setAudioLevel] = useState(0);
  
  return (
    <AtlasSphere
      state={state}
      audioLevel={audioLevel}
      context="dashboard"
    />
  );
}
```

### With Voice Integration

```tsx
import { AtlasSphere } from '@/components/atlas';
import { useRealtimeScribe } from '@/hooks/useRealtimeScribeStable';

function VoiceInterface() {
  const [aiState, setAiState] = useState<AIState>('passive');
  
  const { audioLevel } = useRealtimeScribe({
    onTranscript: (text) => {
      // Process transcript
    },
  });
  
  return (
    <AtlasSphere
      state={aiState}
      audioLevel={audioLevel}
      context="core"
      enableBloom={true}
    />
  );
}
```

### Custom Themed Sphere

```tsx
<AtlasSphere
  state={state}
  audioLevel={audioLevel}
  context="core"
  nebulaStateCustomizations={{
    passive: {
      primaryColor: [0.2, 0.4, 0.8],    // Blue theme
      secondaryColor: [0.4, 0.6, 1.0],
    },
    listening: {
      primaryColor: [0.8, 0.2, 0.4],    // Red theme
      audioReactivity: 2.0,
    },
  }}
/>
```

## Troubleshooting

### Sphere Not Rendering

1. Check that the container has dimensions:
   ```tsx
   <div style={{ width: 400, height: 400 }}>
     <AtlasSphere ... />
   </div>
   ```

2. Verify WebGL is available:
   ```typescript
   const canvas = document.createElement('canvas');
   const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
   console.log('WebGL available:', !!gl);
   ```

### Poor Performance

1. Check particle count isn't too high
2. Disable bloom for testing
3. Use `showStats={true}` to monitor FPS
4. Reduce context to `mini` or `dashboard`

### Colors Look Wrong

1. Ensure colors are in 0-1 range, not 0-255
2. Check that HSL colors are converted properly
3. Verify bloom isn't washing out colors

## File Reference

| File | Purpose |
|------|---------|
| `AtlasSphere.tsx` | Public API component |
| `AtlasCore.tsx` | Main Three.js renderer |
| `systems/NebulaFlowSystem.tsx` | Nebula particle system |
| `systems/GPUParticleSystem.tsx` | Classic particle system |
| `systems/GPUCoreSystem.tsx` | Central core effect |
| `shaders/nebulaFlowShaders.ts` | Nebula GLSL shaders |
| `shaders/particleShaders.ts` | Classic GLSL shaders |
| `shaders/pixelStableShaders.ts` | Resolution-independent rendering |
| `utils/stateConfigs.ts` | State configuration objects |
| `utils/nebulaStateConfigs.ts` | Nebula state configs |
| `hooks/useUnifiedAnimation.ts` | State transition animation |
| `hooks/useAdaptiveQuality.ts` | Quality auto-adjustment |
| `config/sphereConfig.ts` | Global configuration |
