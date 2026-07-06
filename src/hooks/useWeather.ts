import { useMemo } from 'react';
import { useEdgeFunction } from './useEdgeFunction';

export interface WeatherData {
  location: string;
  temp: number;
  condition: string;
  humidity: number;
  windSpeed: number;
  icon: string;
  sunrise: string;
  sunset: string;
  hourly: Array<{
    time: string;
    temp: number;
    icon: string;
  }>;
}

const FALLBACK_WEATHER: WeatherData = {
  location: 'San Francisco',
  temp: 68,
  condition: 'Partly Cloudy',
  humidity: 65,
  windSpeed: 12,
  icon: 'partly-cloudy',
  sunrise: '6:42 AM',
  sunset: '5:24 PM',
  hourly: [
    { time: 'Now', temp: 68, icon: 'partly-cloudy' },
    { time: '12PM', temp: 71, icon: 'sunny' },
    { time: '3PM', temp: 72, icon: 'sunny' },
    { time: '6PM', temp: 69, icon: 'partly-cloudy' },
    { time: '9PM', temp: 64, icon: 'cloudy' },
  ],
};

export const useWeather = (city: string = 'San Francisco') => {
  const fallbackData = useMemo(() => ({
    ...FALLBACK_WEATHER,
    location: city,
  }), [city]);

  const { data, isLoading, error, refetch } = useEdgeFunction<WeatherData>(
    'get-weather',
    { city },
    {
      fallbackData,
      refreshInterval: 30 * 60 * 1000, // 30 minutes
    }
  );

  return {
    // Never null — fall back to representative data until the edge fn resolves
    weather: data ?? fallbackData,
    isLoading,
    error,
    refetch,
  };
};
