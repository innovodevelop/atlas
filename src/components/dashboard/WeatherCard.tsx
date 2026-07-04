import { memo } from 'react';
import { Cloud, Sun, Droplets, Wind, Sunrise, Sunset } from 'lucide-react';
import { DashboardCard } from './DashboardCard';
import { motion } from 'framer-motion';
import { useWeather } from '@/hooks/useWeather';
import { Skeleton } from '@/components/ui/skeleton';

interface WeatherCardProps { 
  isFocused?: boolean; 
  streamingData?: any[];
  onExpand?: () => void;
}

const WeatherIcon = ({ icon }: { icon: string }) => {
  if (icon === 'sunny' || icon === 'clear') {
    return <Sun className="w-5 h-5 text-amber-400" />;
  }
  if (icon === 'partly-cloudy') {
    return (
      <div className="relative">
        <Sun className="w-5 h-5 text-amber-400" />
        <Cloud className="w-3 h-3 text-slate-400 absolute -right-1 bottom-0" />
      </div>
    );
  }
  return <Cloud className="w-5 h-5 text-slate-400" />;
};

const LargeWeatherIcon = ({ icon }: { icon: string }) => {
  if (icon === 'sunny' || icon === 'clear') {
    return (
      <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 4, repeat: Infinity }}>
        <Sun className="w-16 h-16 text-amber-400" />
      </motion.div>
    );
  }
  if (icon === 'partly-cloudy') {
    return (
      <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 4, repeat: Infinity }} className="relative">
        <Sun className="w-16 h-16 text-amber-400" />
        <motion.div animate={{ x: [0, 10, 0] }} transition={{ duration: 8, repeat: Infinity }} className="absolute -right-2 top-2">
          <Cloud className="w-12 h-12 text-slate-400" />
        </motion.div>
      </motion.div>
    );
  }
  return (
    <motion.div animate={{ y: [0, -3, 0] }} transition={{ duration: 3, repeat: Infinity }}>
      <Cloud className="w-16 h-16 text-slate-400" />
    </motion.div>
  );
};

const WeatherCardSkeleton = () => (
  <DashboardCard glowColor="rgba(251, 191, 36, 0.15)">
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-12 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="w-16 h-16 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
      <div className="pt-3 border-t border-white/5">
        <Skeleton className="h-3 w-16 mb-3" />
        <div className="flex justify-between gap-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-12 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  </DashboardCard>
);

const WeatherCardComponent = ({ isFocused, onExpand }: WeatherCardProps) => {
  const { weather, isLoading } = useWeather();

  if (isLoading || !weather) {
    return <WeatherCardSkeleton />;
  }

  const hourlyForecast = weather.hourly || [];

  return (
    <DashboardCard glowColor="rgba(251, 191, 36, 0.15)" onClick={onExpand}>
      <div className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-slate-400 mb-1">{weather.location}</p>
            <div className="flex items-end gap-2">
              <span className="text-5xl font-light text-white">{Math.round(weather.temp)}°</span>
              <span className="text-lg text-slate-400 mb-2">F</span>
            </div>
            <p className="text-slate-300 mt-1">{weather.condition}</p>
          </div>
          <LargeWeatherIcon icon={weather.icon} />
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-white/5">
            <Droplets className="w-4 h-4 text-blue-400" />
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Humidity</p>
              <p className="text-sm font-medium text-white">{weather.humidity}%</p>
            </div>
          </div>
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-white/5">
            <Wind className="w-4 h-4 text-cyan-400" />
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Wind</p>
              <p className="text-sm font-medium text-white">{weather.windSpeed} mph</p>
            </div>
          </div>
        </div>
        
        <div className="pt-3 border-t border-white/5">
          <p className="text-xs text-slate-500 uppercase mb-3">Hourly</p>
          <div className="flex justify-between">
            {hourlyForecast.slice(0, 5).map((h, i) => (
              <motion.div 
                key={i} 
                initial={{ opacity: 0, y: 10 }} 
                animate={{ opacity: 1, y: 0 }} 
                transition={{ delay: i * 0.1 }} 
                className={`flex flex-col items-center gap-1.5 px-2 py-2 rounded-xl ${i === 0 ? 'bg-amber-500/10 border border-amber-500/20' : ''}`}
              >
                <span className={`text-xs ${i === 0 ? 'text-amber-400 font-medium' : 'text-slate-500'}`}>{h.time}</span>
                <WeatherIcon icon={h.icon} />
                <span className={`text-sm font-medium ${i === 0 ? 'text-white' : 'text-slate-300'}`}>{h.temp}°</span>
              </motion.div>
            ))}
          </div>
        </div>
        
        <div className="flex items-center justify-between pt-3 border-t border-white/5">
          <div className="flex items-center gap-2">
            <Sunrise className="w-4 h-4 text-amber-400" />
            <div>
              <p className="text-[10px] text-slate-500">Sunrise</p>
              <p className="text-sm text-white">{weather.sunrise}</p>
            </div>
          </div>
          <div className="flex-1 mx-4 h-1 rounded-full bg-gradient-to-r from-amber-500/30 via-amber-500 to-orange-500/30 relative">
            <motion.div 
              className="absolute w-2 h-2 bg-amber-400 rounded-full -top-0.5 shadow-lg" 
              style={{ left: '35%' }} 
              animate={{ boxShadow: ['0 0 10px rgba(251,191,36,0.5)', '0 0 20px rgba(251,191,36,0.8)', '0 0 10px rgba(251,191,36,0.5)'] }} 
              transition={{ duration: 2, repeat: Infinity }} 
            />
          </div>
          <div className="flex items-center gap-2">
            <Sunset className="w-4 h-4 text-orange-400" />
            <div>
              <p className="text-[10px] text-slate-500">Sunset</p>
              <p className="text-sm text-white">{weather.sunset}</p>
            </div>
          </div>
        </div>
      </div>
    </DashboardCard>
  );
};

export const WeatherCard = memo(WeatherCardComponent);
