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
  daily?: Array<{
    day: string;
    high: number;
    low: number;
    icon: string;
  }>;
  high?: number;
  low?: number;
  /** OpenWeather air quality: aqi 1–5 scale + PM2.5 µg/m³. */
  air?: { aqi: number; pm25: number } | null;
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
  daily: [
    { day: 'Today', high: 72, low: 58, icon: 'partly-cloudy' },
    { day: 'Tue', high: 70, low: 57, icon: 'sunny' },
    { day: 'Wed', high: 68, low: 56, icon: 'cloudy' },
    { day: 'Thu', high: 66, low: 55, icon: 'rainy' },
    { day: 'Fri', high: 69, low: 56, icon: 'partly-cloudy' },
    { day: 'Sat', high: 71, low: 58, icon: 'sunny' },
    { day: 'Sun', high: 73, low: 59, icon: 'sunny' },
  ],
  high: 72,
  low: 58,
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
