import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { getSupportedAudioFormat, getRecorderOptions, type AudioFormat } from "@/lib/audioFormat";
import { useAtlasSettingsReadOnly } from "@/hooks/useAtlasSettings";

export const useVoice = () => {
  const { voiceId, ttsModel, voiceIsolation } = useAtlasSettingsReadOnly();
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  // Negotiated per-engine: webm/opus in Chrome, mp4/aac in WKWebView (Tauri)
  const audioFormatRef = useRef<AudioFormat>(getSupportedAudioFormat());
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  
  // Single audio instance to prevent layering
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const isPlayingRef = useRef(false);

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
    setIsPlaying(false);
    setAudioLevel(0);
  }, []);

  const startRecording = useCallback(async () => {
    // Stop any playing audio first
    stopCurrentAudio();
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });

      // Set up audio analysis
      audioContextRef.current = new AudioContext();
      analyserRef.current = audioContextRef.current.createAnalyser();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      analyserRef.current.fftSize = 256;

      // Analyze audio levels with smoothing
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      let smoothedLevel = 0;
      
      const updateLevel = () => {
        if (analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          const targetLevel = average / 255;
          // Exponential smoothing for natural feel
          smoothedLevel += (targetLevel - smoothedLevel) * 0.3;
          setAudioLevel(smoothedLevel);
        }
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      mediaRecorderRef.current = new MediaRecorder(stream, getRecorderOptions(audioFormatRef.current));

      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.start(100);
      setIsRecording(true);

      return true;
    } catch (error) {
      console.error("Error starting recording:", error);
      toast.error("Failed to access microphone. Please check permissions.");
      return false;
    }
  }, [stopCurrentAudio]);

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
      setAudioLevel(0);

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: audioFormatRef.current.blobType });
        
        // Convert blob to base64
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64Audio = (reader.result as string).split(",")[1];
          
          try {
            // Get current user for storing transcript
            const { data: { user } } = await supabase.auth.getUser();
            
            const { data, error } = await supabase.functions.invoke("elevenlabs-stt", {
              body: {
                audio: base64Audio,
                mimeType: audioFormatRef.current.blobType,
                extension: audioFormatRef.current.extension,
                userId: user?.id || null,
                storeTranscript: true, // Enable automatic transcript storage
                isolate: voiceIsolation,
              },
            });

            if (error) {
              console.error("STT error:", error);
              toast.error("Failed to transcribe audio");
              resolve(null);
              return;
            }

            console.log("Transcription stored:", data.stored);
            resolve(data.text || null);
          } catch (err) {
            console.error("STT request error:", err);
            toast.error("Failed to transcribe audio");
            resolve(null);
          }
        };
        reader.readAsDataURL(audioBlob);
      };

      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
    });
  }, [voiceIsolation]);

  const speakText = useCallback(async (text: string): Promise<void> => {
    // Prevent duplicate audio - stop any existing playback
    if (isPlayingRef.current) {
      stopCurrentAudio();
    }
    
    try {
      isPlayingRef.current = true;
      setIsPlaying(true);

      const { data, error } = await supabase.functions.invoke("elevenlabs-tts", {
        body: { text, voiceId, modelId: ttsModel },
      });

      if (error) {
        console.error("TTS error:", error);
        toast.error("Failed to generate speech");
        stopCurrentAudio();
        return;
      }

      // Convert base64 to audio
      const audioData = atob(data.audioContent);
      const audioArray = new Uint8Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        audioArray[i] = audioData.charCodeAt(i);
      }

      const audioBlob = new Blob([audioArray], { type: "audio/mpeg" });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      currentAudioRef.current = audio;

      // Set up audio analysis for playback
      playbackContextRef.current = new AudioContext();
      const analyser = playbackContextRef.current.createAnalyser();
      const source = playbackContextRef.current.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(playbackContextRef.current.destination);
      analyser.fftSize = 256;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let smoothedLevel = 0;
      
      const updateLevel = () => {
        if (!isPlayingRef.current) return;
        
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        const targetLevel = average / 255;
        // Smoother interpolation
        smoothedLevel += (targetLevel - smoothedLevel) * 0.25;
        setAudioLevel(smoothedLevel);
        
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };

      audio.onplay = () => {
        updateLevel();
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
      console.error("TTS playback error:", err);
      toast.error("Failed to play audio");
      stopCurrentAudio();
    }
  }, [stopCurrentAudio, voiceId, ttsModel]);

  return {
    isRecording,
    isPlaying,
    audioLevel,
    startRecording,
    stopRecording,
    speakText,
    stopCurrentAudio,
  };
};