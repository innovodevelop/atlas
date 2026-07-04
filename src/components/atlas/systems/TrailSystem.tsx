import { useRef, useMemo, memo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { trailVertexShader, trailFragmentShader } from '../shaders/trailShaders';

interface TrailSystemProps {
  particleCount: number;
  trailLength: number;
  trailOpacity: number;
  colorStart: THREE.Color;
  colorEnd: THREE.Color;
  enableGradient: boolean;
  geometryRef: React.MutableRefObject<THREE.BufferGeometry | null>;
}

/**
 * Optimized particle trails - single buffer, minimal React re-renders
 */
export const TrailSystem = memo(({
  particleCount,
  trailLength,
  trailOpacity,
  colorStart,
  colorEnd,
  enableGradient,
  geometryRef,
}: TrailSystemProps) => {
  const pointsRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  // Pre-allocate single geometry for all trails
  const geometry = useMemo(() => {
    const totalParticles = particleCount * trailLength;
    const positions = new Float32Array(totalParticles * 3);
    const indices = new Float32Array(totalParticles);
    const opacityArray = new Float32Array(totalParticles);
    const randomSizes = new Float32Array(totalParticles);

    // Initialize attributes with smooth exponential fade
    for (let trail = 0; trail < trailLength; trail++) {
      const trailProgress = trail / trailLength;
      const fadeOpacity = Math.pow(1 - trailProgress, 1.5);

      for (let i = 0; i < particleCount; i++) {
        const idx = trail * particleCount + i;
        indices[idx] = trailProgress;
        opacityArray[idx] = fadeOpacity;
        randomSizes[idx] = Math.random();
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('trailIndex', new THREE.BufferAttribute(indices, 1));
    geo.setAttribute('opacity', new THREE.BufferAttribute(opacityArray, 1));
    geo.setAttribute('randomSize', new THREE.BufferAttribute(randomSizes, 1));

    return geo;
  }, [particleCount, trailLength]);

  // Store geometry ref for parent to update positions, and dispose GPU
  // buffers when the geometry is swapped (particleCount/trailLength change)
  // or the component unmounts — imperative geometries aren't auto-disposed.
  useEffect(() => {
    geometryRef.current = geometry;
    return () => {
      geometryRef.current = null;
      geometry.dispose();
    };
  }, [geometry, geometryRef]);

  const uniforms = useMemo(() => {
    return {
      uColorStart: { value: colorStart.clone() },
      uColorEnd: { value: colorEnd.clone() },
      uBaseOpacity: { value: trailOpacity },
      uEnableGradient: { value: enableGradient ? 1.0 : 0.0 },
    };
    // Intentionally initialize once for performance; runtime updates happen in useFrame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update uniforms only (not geometry)
  useFrame(() => {
    if (!materialRef.current) return;

    const u = materialRef.current.uniforms;
    u.uColorStart.value.lerp(colorStart, 0.1);
    u.uColorEnd.value.lerp(colorEnd, 0.1);
    u.uBaseOpacity.value = trailOpacity;
    u.uEnableGradient.value = enableGradient ? 1.0 : 0.0;
  });

  return (
    <points key={`trails-${particleCount}-${trailLength}`} ref={pointsRef} geometry={geometry}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={trailVertexShader}
        fragmentShader={trailFragmentShader}
        uniforms={uniforms}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
});

TrailSystem.displayName = 'TrailSystem';

