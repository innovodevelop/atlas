import {
  Sun, Cloud, CloudSun, CloudRain, CloudSnow, CloudLightning, CloudFog,
} from 'lucide-react';
import type { LucideProps } from 'lucide-react';

// Map the app's weather icon keys (and OpenWeather-ish conditions) to lucide icons.
export function WeatherIcon({ icon, condition, ...props }: { icon?: string; condition?: string } & LucideProps) {
  const key = (icon || condition || '').toLowerCase();
  if (key.includes('thunder') || key.includes('lightning') || key.includes('storm')) return <CloudLightning {...props} />;
  if (key.includes('snow')) return <CloudSnow {...props} />;
  if (key.includes('rain') || key.includes('drizzle') || key.includes('shower')) return <CloudRain {...props} />;
  if (key.includes('fog') || key.includes('mist') || key.includes('haze')) return <CloudFog {...props} />;
  if (key.includes('partly') || key.includes('few') || key.includes('scattered')) return <CloudSun {...props} />;
  if (key.includes('cloud') || key.includes('overcast')) return <Cloud {...props} />;
  return <Sun {...props} />;
}
