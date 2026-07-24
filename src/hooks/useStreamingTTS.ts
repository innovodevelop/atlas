import { useState, useCallback, useRef, useEffect } from "react";
import { getVoiceEndpoint } from "@/lib/voiceClient";

interface UseStreamingTTSOptions {
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onError?: (error: Error) => void;
}

interface QueueItem {
  audioPromise: Promise<Blob | null>;
  abort: AbortController;
}

interface SpeakOptions {
  voiceId?: string;
  modelId?: string;
}

/**
 * Streaming TTS with a sentence queue. `enqueue()` is the low-latency path:
 * each sentence's audio is fetched the moment it's enqueued (so sentence N+1
 * downloads while sentence N plays) and chunks play back-to-back. Atlas starts
 * speaking after the FIRST sentence of an LLM stream instead of after the
 * whole response. `speak()` remains for whole-text playback.
 */
export const useStreamingTTS = (options: UseStreamingTTSOptions = {}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const drainingRef = useRef(false);
  const playingRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stopPlayback = useCallback(() => {
    // Clear pending queue and abort in-flight fetches
    for (const item of queueRef.current) item.abort.abort();
    queueRef.current = [];
    drainingRef.current = false;
    playingRef.current = false;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    setIsPlaying(false);
    setAudioLevel(0);
  }, []);

  const fetchAudio = useCallback(async (
    text: string,
    speakOptions: SpeakOptions,
    signal: AbortSignal,
  ): Promise<Blob | null> => {
    try {
      // TTS streams from the local voice gateway sidecar.
      const voice = await getVoiceEndpoint();
      if (!voice) throw new Error("Voice is only available in the desktop app.");
      const response = await fetch(
        `${voice.baseUrl}/tts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-sidecar-token": voice.token,
          },
          body: JSON.stringify({ text, voiceId: speakOptions.voiceId, modelId: speakOptions.modelId }),
          signal,
        }
      );
      if (!response.ok) {
        throw new Error(`TTS failed: ${await response.text()}`);
      }
      return await response.blob();
    } catch (error) {
      if ((error as Error).name === "AbortError") return null;
      console.error("[TTS] Fetch error:", error);
      optionsRef.current.onError?.(error instanceof Error ? error : new Error("TTS failed"));
      return null;
    }
  }, []);

  const playBlob = useCallback((blob: Blob): Promise<void> => {
    return new Promise<void>((resolve) => {
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      if (!audioContextRef.current || audioContextRef.current.state === "closed") {
        audioContextRef.current = new AudioContext();
      }
      if (audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume().catch(() => {});
      }

      const finish = () => {
        URL.revokeObjectURL(audioUrl);
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        if (sourceRef.current) {
          sourceRef.current.disconnect();
          sourceRef.current = null;
        }
        resolve();
      };

      try {
        analyserRef.current = audioContextRef.current.createAnalyser();
        sourceRef.current = audioContextRef.current.createMediaElementSource(audio);
        sourceRef.current.connect(analyserRef.current);
        analyserRef.current.connect(audioContextRef.current.destination);
        analyserRef.current.fftSize = 256;

        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        let smoothedLevel = 0;
        const updateLevel = () => {
          if (!playingRef.current || !analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          smoothedLevel += (average / 255 - smoothedLevel) * 0.25;
          setAudioLevel(smoothedLevel);
          animationFrameRef.current = requestAnimationFrame(updateLevel);
        };
        audio.onplay = () => updateLevel();
      } catch {
        // Analyser is cosmetic — play without it rather than fail
      }

      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch(finish);
    });
  }, []);

  /** Play queued chunks in order until the queue is empty. */
  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    playingRef.current = true;
    setIsPlaying(true);
    optionsRef.current.onPlaybackStart?.();

    while (queueRef.current.length > 0 && playingRef.current) {
      const item = queueRef.current[0];
      const blob = await item.audioPromise;
      // Queue may have been stopped while we awaited
      if (!playingRef.current || queueRef.current[0] !== item) break;
      queueRef.current.shift();
      if (blob) {
        await playBlob(blob);
      }
    }

    if (playingRef.current) {
      playingRef.current = false;
      drainingRef.current = false;
      setIsPlaying(false);
      setAudioLevel(0);
      optionsRef.current.onPlaybackEnd?.();
    }
  }, [playBlob]);

  /**
   * Low-latency path: enqueue a sentence. Fetch starts immediately (prefetch);
   * playback is sequential. Call repeatedly as LLM sentences complete.
   */
  const enqueue = useCallback((text: string, speakOptions: SpeakOptions = {}) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const abort = new AbortController();
    queueRef.current.push({
      abort,
      audioPromise: fetchAudio(trimmed, speakOptions, abort.signal),
    });
    void drainQueue();
  }, [fetchAudio, drainQueue]);

  /** Whole-text playback (stops anything queued or playing first). */
  const speak = useCallback(async (text: string, voiceId?: string, modelId?: string): Promise<void> => {
    stopPlayback();
    enqueue(text, { voiceId, modelId });
  }, [stopPlayback, enqueue]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPlayback();
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, [stopPlayback]);

  return {
    isPlaying,
    audioLevel,
    speak,
    enqueue,
    stopPlayback,
  };
};
