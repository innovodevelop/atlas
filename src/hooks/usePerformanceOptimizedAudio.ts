import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { getSupportedAudioFormat, getRecorderOptions, type AudioFormat } from '@/lib/audioFormat';
import { useAtlasSettingsReadOnly } from '@/hooks/useAtlasSettings';

// Smoothing factor for audio level (lower = smoother, higher = more responsive)
const AUDIO_SMOOTHING = 0.25;
const AUDIO_ANALYSIS_INTERVAL = 16; // ~60fps

interface AudioState {
  isRecording: boolean;
  isPlaying: boolean;
  audioLevel: number;
}

export const usePerformanceOptimizedAudio = () => {
  const { voiceId, ttsModel, voiceIsolation } = useAtlasSettingsReadOnly();
  const [state, setState] = useState<AudioState>({
    isRecording: false,
    isPlaying: false,
    audioLevel: 0,
  });

  // Refs for managing resources without causing re-renders
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // Negotiated per-engine: webm/opus in Chrome, mp4/aac in WKWebView (Tauri)
  const audioFormatRef = useRef<AudioFormat>(getSupportedAudioFormat());
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const isPlayingRef = useRef(false);
  const smoothedLevelRef = useRef(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataArrayRef = useRef<any>(null);

  // Optimized audio level update using RAF
  const updateAudioLevel = useCallback(() => {
    if (!analyserRef.current || !dataArrayRef.current) return;

    const dataArray = dataArrayRef.current;
    analyserRef.current.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    const average = sum / dataArray.length;
    const targetLevel = average / 255;

    // Exponential smoothing
    smoothedLevelRef.current += (targetLevel - smoothedLevelRef.current) * AUDIO_SMOOTHING;

    // Batch state update
    setState((prev) => ({
      ...prev,
      audioLevel: smoothedLevelRef.current,
    }));

    animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
  }, []);

  const stopCurrentAudio = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.src = '';
      currentAudioRef.current = null;
    }
    if (playbackContextRef.current) {
      playbackContextRef.current.close().catch(() => {});
      playbackContextRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    isPlayingRef.current = false;
    smoothedLevelRef.current = 0;
    setState((prev) => ({ ...prev, isPlaying: false, audioLevel: 0 }));
  }, []);

  const startRecording = useCallback(async () => {
    stopCurrentAudio();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Set up audio analysis with optimized settings
      audioContextRef.current = new AudioContext();
      analyserRef.current = audioContextRef.current.createAnalyser();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      analyserRef.current.fftSize = 128; // Smaller FFT for performance
      analyserRef.current.smoothingTimeConstant = 0.5;

      // Pre-allocate data array
      dataArrayRef.current = new Uint8Array(analyserRef.current.frequencyBinCount);

      // Start level monitoring
      updateAudioLevel();

      mediaRecorderRef.current = new MediaRecorder(stream, getRecorderOptions(audioFormatRef.current));

      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.start(100);
      setState((prev) => ({ ...prev, isRecording: true }));

      return true;
    } catch (error) {
      console.error('Error starting recording:', error);
      toast.error('Failed to access microphone. Please check permissions.');
      return false;
    }
  }, [stopCurrentAudio, updateAudioLevel]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current) {
        resolve(null);
        return;
      }

      // Stop audio analysis
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      smoothedLevelRef.current = 0;
      setState((prev) => ({ ...prev, audioLevel: 0 }));

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: audioFormatRef.current.blobType });

        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64Audio = (reader.result as string).split(',')[1];

          try {
            const { data, error } = await supabase.functions.invoke('elevenlabs-stt', {
              body: {
                audio: base64Audio,
                mimeType: audioFormatRef.current.blobType,
                extension: audioFormatRef.current.extension,
                isolate: voiceIsolation,
              },
            });

            if (error) {
              console.error('STT error:', error);
              toast.error('Failed to transcribe audio');
              resolve(null);
              return;
            }

            resolve(data.text || null);
          } catch (err) {
            console.error('STT request error:', err);
            toast.error('Failed to transcribe audio');
            resolve(null);
          }
        };
        reader.readAsDataURL(audioBlob);
      };

      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
      setState((prev) => ({ ...prev, isRecording: false }));
    });
  }, []);

  const speakText = useCallback(
    async (text: string): Promise<void> => {
      if (isPlayingRef.current) {
        stopCurrentAudio();
      }

      try {
        isPlayingRef.current = true;
        setState((prev) => ({ ...prev, isPlaying: true }));

        const { data, error } = await supabase.functions.invoke('elevenlabs-tts', {
          body: { text, voiceId, modelId: ttsModel },
        });

        if (error) {
          console.error('TTS error:', error);
          toast.error('Failed to generate speech');
          stopCurrentAudio();
          return;
        }

        const audioData = atob(data.audioContent);
        const audioArray = new Uint8Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
          audioArray[i] = audioData.charCodeAt(i);
        }

        const audioBlob = new Blob([audioArray], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        currentAudioRef.current = audio;

        // Set up audio analysis with optimized settings
        playbackContextRef.current = new AudioContext();
        const analyser = playbackContextRef.current.createAnalyser();
        const source = playbackContextRef.current.createMediaElementSource(audio);
        source.connect(analyser);
        analyser.connect(playbackContextRef.current.destination);
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.5;

        const playbackDataArray = new Uint8Array(analyser.frequencyBinCount);

        const updatePlaybackLevel = () => {
          if (!isPlayingRef.current) return;

          analyser.getByteFrequencyData(playbackDataArray);
          const average = playbackDataArray.reduce((a, b) => a + b) / playbackDataArray.length;
          const targetLevel = average / 255;
          smoothedLevelRef.current += (targetLevel - smoothedLevelRef.current) * AUDIO_SMOOTHING;
          setState((prev) => ({ ...prev, audioLevel: smoothedLevelRef.current }));

          animationFrameRef.current = requestAnimationFrame(updatePlaybackLevel);
        };

        audio.onplay = () => {
          updatePlaybackLevel();
        };

        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          stopCurrentAudio();
        };

        audio.onerror = () => {
          stopCurrentAudio();
        };

        await audio.play();
      } catch (err) {
        console.error('TTS playback error:', err);
        toast.error('Failed to play audio');
        stopCurrentAudio();
      }
    },
    [stopCurrentAudio]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
      if (playbackContextRef.current) {
        playbackContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  return {
    isRecording: state.isRecording,
    isPlaying: state.isPlaying,
    audioLevel: state.audioLevel,
    startRecording,
    stopRecording,
    speakText,
    stopCurrentAudio,
  };
};
