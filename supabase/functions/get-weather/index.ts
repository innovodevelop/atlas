import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";

const OPENWEATHER_API_KEY = Deno.env.get('OPENWEATHER_API_KEY');

serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { city = 'San Francisco', lat, lon } = await req.json();
    
    // If no API key, return mock data
    if (!OPENWEATHER_API_KEY) {
      console.log('No OPENWEATHER_API_KEY configured, returning mock data');
      return jsonResponse({
        location: city,
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
      });
    }

    // Build URL based on coordinates or city
    let url = `https://api.openweathermap.org/data/2.5/weather?appid=${OPENWEATHER_API_KEY}&units=imperial`;
    if (lat && lon) {
      url += `&lat=${lat}&lon=${lon}`;
    } else {
      url += `&q=${encodeURIComponent(city)}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Weather API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Map OpenWeather icon to our icons
    const mapIcon = (icon: string) => {
      if (icon.includes('01')) return 'sunny';
      if (icon.includes('02') || icon.includes('03')) return 'partly-cloudy';
      if (icon.includes('04')) return 'cloudy';
      if (icon.includes('09') || icon.includes('10')) return 'rainy';
      if (icon.includes('11')) return 'stormy';
      if (icon.includes('13')) return 'snowy';
      return 'cloudy';
    };

    const formatTime = (timestamp: number) => {
      const date = new Date(timestamp * 1000);
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    };

    // Get forecast for hourly + derive a daily outlook from the free 5-day/
    // 3-hour endpoint (no paid One Call API needed).
    let hourlyData = [
      { time: 'Now', temp: Math.round(data.main.temp), icon: mapIcon(data.weather[0].icon) },
    ];
    let dailyData: Array<{ day: string; high: number; low: number; icon: string }> = [];
    let todayHigh = Math.round(data.main.temp_max ?? data.main.temp);
    let todayLow = Math.round(data.main.temp_min ?? data.main.temp);

    try {
      const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?appid=${OPENWEATHER_API_KEY}&units=imperial&lat=${data.coord.lat}&lon=${data.coord.lon}`;
      const forecastRes = await fetch(forecastUrl);
      if (forecastRes.ok) {
        const forecastData = await forecastRes.json();
        const list: any[] = forecastData.list || [];

        hourlyData = list.slice(0, 5).map((item: any, idx: number) => ({
          time: idx === 0 ? 'Now' : new Date(item.dt * 1000).toLocaleTimeString('en-US', { hour: 'numeric' }),
          temp: Math.round(item.main.temp),
          icon: mapIcon(item.weather[0].icon),
        }));

        // Aggregate 3-hour slices into per-day high/low + a midday icon.
        const byDay = new Map<string, { high: number; low: number; icon: string; iconHour: number }>();
        for (const item of list) {
          const d = new Date(item.dt * 1000);
          const key = d.toISOString().slice(0, 10);
          const hour = d.getUTCHours();
          const cur = byDay.get(key);
          if (!cur) {
            byDay.set(key, { high: item.main.temp_max, low: item.main.temp_min, icon: mapIcon(item.weather[0].icon), iconHour: hour });
          } else {
            cur.high = Math.max(cur.high, item.main.temp_max);
            cur.low = Math.min(cur.low, item.main.temp_min);
            // Prefer the slice closest to local midday for the representative icon
            if (Math.abs(hour - 12) < Math.abs(cur.iconHour - 12)) { cur.icon = mapIcon(item.weather[0].icon); cur.iconHour = hour; }
          }
        }
        const days = [...byDay.entries()];
        const todayKey = new Date().toISOString().slice(0, 10);
        const today = byDay.get(todayKey);
        if (today) { todayHigh = Math.round(today.high); todayLow = Math.round(today.low); }
        dailyData = days.slice(0, 7).map(([key, v], idx) => ({
          day: idx === 0 ? 'Today' : new Date(key + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' }),
          high: Math.round(v.high),
          low: Math.round(v.low),
          icon: v.icon,
        }));
      }
    } catch (e) {
      console.log('Could not fetch forecast:', e);
    }

    const result = {
      location: data.name,
      temp: Math.round(data.main.temp),
      condition: data.weather[0].main,
      humidity: data.main.humidity,
      windSpeed: Math.round(data.wind.speed),
      icon: mapIcon(data.weather[0].icon),
      sunrise: formatTime(data.sys.sunrise),
      sunset: formatTime(data.sys.sunset),
      hourly: hourlyData,
      daily: dailyData,
      high: todayHigh,
      low: todayLow,
    };

    return jsonResponse(result);

  } catch (error: unknown) {
    console.error('Weather function error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(message);
  }
});
