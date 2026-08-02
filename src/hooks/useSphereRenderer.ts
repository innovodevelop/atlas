import { useState, useEffect, useRef, useCallback, RefObject } from 'react';
import { 
  defaultSphereConfig, 
  computeParticleCount, 
  computeEffectiveDpr, 
  computeCameraZ,
  type AtlasSphereConfig 
} from '@/components/atlas/config/sphereConfig';

export interface SphereRenderState {
  // Container dimensions (CSS pixels)
  containerWidth: number;
  containerHeight: number;
  
  // Effective rendering dimensions (with DPR)
  renderWidth: number;
  renderHeight: number;
  
  // Computed values
  pixelRatio: number;
  particleCount: number;
  cameraZ: number;
  
  // Status
  isReady: boolean;
}

export interface UseSphereRendererOptions {
  config?: Partial<AtlasSphereConfig>;
  onResize?: (state: SphereRenderState) => void;
}

const DEFAULT_STATE: SphereRenderState = {
  containerWidth: 200,
  containerHeight: 200,
  renderWidth: 200,
  renderHeight: 200,
  pixelRatio: 1,
  particleCount: 2000,
  cameraZ: 5.0,
  isReady: false,
};

export function useSphereRenderer(
  containerRef: RefObject<HTMLElement | null>,
  options: UseSphereRendererOptions = {}
): SphereRenderState {
  const [state, setState] = useState<SphereRenderState>(DEFAULT_STATE);
  const { onResize } = options;
  const configRef = useRef<AtlasSphereConfig>({ ...defaultSphereConfig, ...options.config });
  
  // Update config when options change
  useEffect(() => {
    configRef.current = { ...defaultSphereConfig, ...options.config };
  }, [options.config]);

  const calculateState = useCallback((width: number, height: number): SphereRenderState => {
    const config = configRef.current;
    const pixelRatio = computeEffectiveDpr(config);
    const containerSize = Math.min(width, height);
    
    return {
      containerWidth: width,
      containerHeight: height,
      renderWidth: Math.round(width * pixelRatio),
      renderHeight: Math.round(height * pixelRatio),
      pixelRatio,
      particleCount: computeParticleCount(width, height, config),
      cameraZ: computeCameraZ(containerSize),
      isReady: true,
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleResize = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      
      const newState = calculateState(width, height);
      setState(newState);
      onResize?.(newState);
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(el);
    
    // Initial calculation
    handleResize();

    return () => observer.disconnect();
  }, [containerRef, calculateState, onResize]);

  return state;
}

// Hook for components that just need dimensions without full renderer state
export function useContainerSize(containerRef: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleResize = () => {
      const rect = el.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      });
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(el);
    handleResize();

    return () => observer.disconnect();
  }, [containerRef]);

  return size;
}
