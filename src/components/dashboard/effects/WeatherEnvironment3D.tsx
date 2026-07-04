import { Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { CloudSystem } from './CloudSystem';
import { RainParticles } from './RainParticles';
import { SnowParticles } from './SnowParticles';
import { LightningFlash } from './LightningFlash';
import { AtmosphericFog } from './AtmosphericFog';
import { useWindowActivity } from '@/hooks/useWindowActivity';

interface WeatherEnvironment3DProps {
  condition: string;
  intensity?: number;
  className?: string;
}

interface WeatherConfig {
  showClouds: boolean;
  showRain: boolean;
  showSnow: boolean;
  showLightning: boolean;
  showFog: boolean;
  cloudCount: number;
  cloudCoverage: number;
  cloudDarkness: number;
  rainIntensity: number;
  snowIntensity: number;
  fogDensity: number;
  fogColor: string;
}

const getWeatherConfig = (condition: string): WeatherConfig => {
  const base: WeatherConfig = {
    showClouds: false,
    showRain: false,
    showSnow: false,
    showLightning: false,
    showFog: false,
    cloudCount: 6,
    cloudCoverage: 0.4,
    cloudDarkness: 0.2,
    rainIntensity: 0.5,
    snowIntensity: 0.5,
    fogDensity: 0.2,
    fogColor: '#8899aa'
  };

  const lowerCondition = condition.toLowerCase();

  if (lowerCondition.includes('thunder') || lowerCondition.includes('storm')) {
    return {
      ...base,
      showClouds: true,
      showRain: true,
      showLightning: true,
      showFog: true,
      cloudCount: 12,
      cloudCoverage: 0.9,
      cloudDarkness: 0.6,
      rainIntensity: 1,
      fogDensity: 0.35,
      fogColor: '#4a5568'
    };
  }

  if (lowerCondition.includes('rain') || lowerCondition.includes('drizzle') || lowerCondition.includes('shower')) {
    return {
      ...base,
      showClouds: true,
      showRain: true,
      showFog: true,
      cloudCount: 10,
      cloudCoverage: 0.7,
      cloudDarkness: 0.35,
      rainIntensity: lowerCondition.includes('light') ? 0.4 : 0.7,
      fogDensity: 0.2,
      fogColor: '#6b7280'
    };
  }

  if (lowerCondition.includes('snow') || lowerCondition.includes('blizzard') || lowerCondition.includes('sleet')) {
    return {
      ...base,
      showClouds: true,
      showSnow: true,
      showFog: true,
      cloudCount: 8,
      cloudCoverage: 0.65,
      cloudDarkness: 0.15,
      snowIntensity: lowerCondition.includes('heavy') ? 1 : 0.5,
      fogDensity: 0.25,
      fogColor: '#e2e8f0'
    };
  }

  if (lowerCondition.includes('fog') || lowerCondition.includes('mist') || lowerCondition.includes('haze')) {
    return {
      ...base,
      showFog: true,
      showClouds: true,
      cloudCount: 4,
      cloudCoverage: 0.5,
      cloudDarkness: 0.1,
      fogDensity: 0.5,
      fogColor: '#cbd5e1'
    };
  }

  if (lowerCondition.includes('overcast') || lowerCondition.includes('cloud')) {
    return {
      ...base,
      showClouds: true,
      showFog: true,
      cloudCount: 10,
      cloudCoverage: 0.75,
      cloudDarkness: 0.2,
      fogDensity: 0.1,
      fogColor: '#94a3b8'
    };
  }

  if (lowerCondition.includes('partly')) {
    return {
      ...base,
      showClouds: true,
      cloudCount: 5,
      cloudCoverage: 0.35,
      cloudDarkness: 0.1
    };
  }

  // Clear/sunny - minimal effects
  return base;
};

const WeatherScene = ({ condition, intensity = 1 }: { condition: string; intensity?: number }) => {
  const config = useMemo(() => getWeatherConfig(condition), [condition]);

  return (
    <>
      {/* Subtle ambient light */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 10, 5]} intensity={0.3} />
      
      {/* Atmospheric fog for depth */}
      {config.showFog && (
        <AtmosphericFog 
          density={config.fogDensity * intensity} 
          color={config.fogColor}
          layers={3}
        />
      )}
      
      {/* Cloud system */}
      {config.showClouds && (
        <CloudSystem
          count={config.cloudCount}
          coverage={config.cloudCoverage * intensity}
          darkness={config.cloudDarkness}
          speed={0.2}
        />
      )}
      
      {/* Rain particles */}
      {config.showRain && (
        <RainParticles
          count={Math.floor(600 * config.rainIntensity * intensity)}
          intensity={config.rainIntensity * intensity}
          speed={1}
          color="#a8c8e8"
        />
      )}
      
      {/* Snow particles */}
      {config.showSnow && (
        <SnowParticles
          count={Math.floor(400 * config.snowIntensity * intensity)}
          intensity={config.snowIntensity * intensity}
        />
      )}
      
      {/* Lightning for storms */}
      {config.showLightning && (
        <LightningFlash intensity={intensity} />
      )}
    </>
  );
};

export const WeatherEnvironment3D = ({ condition, intensity = 1, className = '' }: WeatherEnvironment3DProps) => {
  const config = useMemo(() => getWeatherConfig(condition), [condition]);
  const windowActive = useWindowActivity();

  // Don't render canvas if no weather effects
  const hasEffects = config.showClouds || config.showRain || config.showSnow || config.showFog;

  if (!hasEffects) {
    return null;
  }

  return (
    <div className={`absolute inset-0 pointer-events-none ${className}`}>
      <Canvas
        camera={{ position: [0, 0, 10], fov: 60 }}
        style={{ background: 'transparent' }}
        gl={{ alpha: true, antialias: true }}
        frameloop={windowActive ? 'always' : 'never'}
      >
        <Suspense fallback={null}>
          <WeatherScene condition={condition} intensity={intensity} />
        </Suspense>
      </Canvas>
    </div>
  );
};
