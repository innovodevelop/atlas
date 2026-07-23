/**
 * Full-viewport living atmosphere — the design's default `atmo` background
 * mode: the weather-reactive canvas (wxAtmo) rendered behind the dashboard,
 * radially masked so it fades into the content (see `.bgcv` CSS).
 * Weather-condition-aware via useWeather; pauses on window blur; honours
 * prefers-reduced-motion by rendering a single static frame.
 */
import { memo, useEffect, useRef } from "react";
import { startWxCanvas, presetFor } from "@/lib/wxAtmosphere";
import { useWindowActivity } from "@/hooks/useWindowActivity";
import { useWeather } from "@/hooks/useWeather";

export const AtmosphereCanvas = memo(function AtmosphereCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { weather } = useWeather();
  const conditionRef = useRef(weather.condition);
  conditionRef.current = weather.condition;
  const active = useWindowActivity();
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frozen = false;
    const handle = startWxCanvas(
      el,
      () => presetFor(conditionRef.current),
      () => {
        if (reduced) {
          // One frame, then hold.
          if (frozen) return true;
          frozen = true;
          return false;
        }
        return !activeRef.current;
      },
    );
    return () => handle.stop();
  }, []);

  return <canvas ref={canvasRef} className="bgcv" aria-hidden />;
});
