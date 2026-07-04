import { useState, useCallback, useEffect, useRef } from 'react';
import { useVoice } from '@/hooks/useVoice';
import { useWakeWord } from '@/hooks/useWakeWord';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { useAtlasSettingsReadOnly } from '@/hooks/useAtlasSettings';
import type { WakeWordState, AIState } from '@/types';

interface UseDashboardVoiceOptions {
  sendMessage: (message: string) => Promise<string | null>;
  stopAudio?: () => void;
  aiState: AIState;
  isLoading: boolean;
  setAiState: (state: AIState) => void;
}

interface UseDashboardVoiceReturn {
  // State
  voiceEnabled: boolean;
  isVoiceProcessing: boolean;
  isRecording: boolean;
  isPlaying: boolean;
  audioLevel: number;
  wakeWordState: WakeWordState;
  effectiveAtlasState: WakeWordState;
  effectiveAiState: AIState;
  lastUserMessage: string;
  lastAiResponse: string;
  isWakeWordSupported: boolean;
  
  // Handlers
  handleEnableVoice: () => Promise<void>;
  handleVoicePress: () => void;
  handleVoiceRelease: () => Promise<void>;
  handleManualActivate: () => Promise<void>;
  stopCurrentAudio: () => void;
  /** Wire to useUnifiedChat's onSpeakSentence for low-latency streamed speech */
  speakSentence: (sentence: string) => void;
}

export function useDashboardVoice({
  sendMessage,
  stopAudio,
  aiState,
  isLoading,
  setAiState,
}: UseDashboardVoiceOptions): UseDashboardVoiceReturn {
  // Local state
  const [isVoiceProcessing, setIsVoiceProcessing] = useState(false);
  const [lastUserMessage, setLastUserMessage] = useState('');
  const [lastAiResponse, setLastAiResponse] = useState('');
  const [isWakeWordTriggered, setIsWakeWordTriggered] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    return localStorage.getItem('atlas-voice-enabled') === 'true';
  });

  // Ref for auto-stop timer
  const autoStopTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Voice hook
  const {
    isRecording,
    isPlaying: isVoicePlaying,
    audioLevel: voiceAudioLevel,
    startRecording,
    stopRecording,
    speakText,
    stopCurrentAudio: stopVoiceAudio,
  } = useVoice();

  // Streaming TTS: plays LLM sentences as they complete (low latency).
  // Only active for voice-initiated queries — typed chat stays silent.
  const streamingTTS = useStreamingTTS();
  const { voiceId, ttsModel } = useAtlasSettingsReadOnly();
  const voiceSessionRef = useRef(false);
  const streamedSentencesRef = useRef(0);

  const speakSentence = useCallback((sentence: string) => {
    if (!voiceSessionRef.current) return;
    streamedSentencesRef.current++;
    streamingTTS.enqueue(sentence, { voiceId, modelId: ttsModel });
  }, [streamingTTS, voiceId, ttsModel]);

  const stopCurrentAudio = useCallback(() => {
    stopVoiceAudio();
    streamingTTS.stopPlayback();
    voiceSessionRef.current = false;
  }, [stopVoiceAudio, streamingTTS]);

  const isPlaying = isVoicePlaying || streamingTTS.isPlaying;
  const audioLevel = Math.max(voiceAudioLevel, streamingTTS.audioLevel);

  // Mirror playing state into a ref so async handlers can await playback end
  const isPlayingRef = useRef(false);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const waitForPlaybackEnd = useCallback(async (timeoutMs = 60_000) => {
    const start = Date.now();
    // Give the queue a beat to start before checking
    await new Promise(r => setTimeout(r, 300));
    while (isPlayingRef.current && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 200));
    }
  }, []);

  // Wake word hook
  const {
    state: wakeWordState,
    setState: setWakeWordState,
    isSupported: isWakeWordSupported,
    startPassiveListening,
    pauseListening,
    resumeListening,
  } = useWakeWord({
    keyword: 'atlas',
    onWakeWordDetected: () => {
      console.log('[useDashboardVoice] Wake word detected! Starting recording...');
      stopCurrentAudio();
      if (stopAudio) stopAudio();
      setIsWakeWordTriggered(true);
      startRecording();
    },
    onTimeout: () => {
      console.log('[useDashboardVoice] Wake word timeout');
    },
  });

  // Determine effective Atlas state
  const effectiveAtlasState: WakeWordState = isRecording 
    ? 'listening' 
    : isVoiceProcessing || isLoading
      ? 'thinking'
      : isPlaying 
        ? 'speaking' 
        : wakeWordState;

  // Determine effective AI state
  const effectiveAiState: AIState = isRecording 
    ? 'listening' 
    : isVoiceProcessing || isLoading
      ? 'thinking'
      : isPlaying 
        ? 'speaking' 
        : aiState;

  // Enable voice handler
  const handleEnableVoice = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      
      setVoiceEnabled(true);
      localStorage.setItem('atlas-voice-enabled', 'true');
      startPassiveListening();
    } catch (error) {
      console.warn('[useDashboardVoice] Microphone permission denied:', error);
    }
  }, [startPassiveListening]);

  // Voice press handler
  const handleVoicePress = useCallback(() => {
    console.log('[useDashboardVoice] Voice press - pausing wake word, starting recording');
    pauseListening();
    stopCurrentAudio();
    if (stopAudio) stopAudio();
    startRecording();
    setAiState('listening');
  }, [startRecording, setAiState, stopCurrentAudio, stopAudio, pauseListening]);

  // Voice release handler
  const handleVoiceRelease = useCallback(async () => {
    if (!isRecording) return;
    
    console.log('[useDashboardVoice] Voice release - processing recording');
    
    // Clear auto-stop timer and wake word trigger
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    setIsWakeWordTriggered(false);
    
    setIsVoiceProcessing(true);
    setWakeWordState('thinking');
    
    try {
      const transcribedText = await stopRecording();
      console.log('[useDashboardVoice] Transcribed text:', transcribedText);
      
      if (transcribedText && transcribedText.trim()) {
        setLastUserMessage(transcribedText);

        // Sentence-streamed speech: sentences play while the LLM streams
        voiceSessionRef.current = true;
        streamedSentencesRef.current = 0;

        console.log('[useDashboardVoice] Sending message to chat...');
        const response = await sendMessage(transcribedText);
        console.log('[useDashboardVoice] Got response:', response?.substring(0, 100));

        if (response && response.trim()) {
          setLastAiResponse(response);
          setWakeWordState('speaking');
          if (streamedSentencesRef.current > 0) {
            // Already speaking via the sentence queue — wait for it to drain
            await waitForPlaybackEnd();
          } else {
            // Sentence path wasn't wired (or produced nothing): legacy whole-
            // response playback
            console.log('[useDashboardVoice] Speaking response (fallback)...');
            await speakText(response);
          }
          console.log('[useDashboardVoice] TTS complete');
        } else {
          console.warn('[useDashboardVoice] No response to speak');
        }
      } else {
        console.log('[useDashboardVoice] No transcribed text');
      }
    } catch (error) {
      console.error('[useDashboardVoice] Voice processing error:', error);
    } finally {
      voiceSessionRef.current = false;
      setIsVoiceProcessing(false);
      console.log('[useDashboardVoice] Resuming wake word listening');
      resumeListening();
    }
  }, [isRecording, stopRecording, sendMessage, setWakeWordState, speakText, resumeListening, waitForPlaybackEnd]);

  // Manual activate handler
  const handleManualActivate = useCallback(async () => {
    // Toggle recording - if already recording, stop and process
    if (isRecording) {
      await handleVoiceRelease();
      return;
    }
    
    stopCurrentAudio();
    if (stopAudio) stopAudio();
    setIsWakeWordTriggered(true);
    startRecording();
    setWakeWordState('listening');
  }, [isRecording, handleVoiceRelease, stopCurrentAudio, stopAudio, startRecording, setWakeWordState]);

  // Auto-stop recording after silence when triggered by wake word
  useEffect(() => {
    if (!isRecording || !isWakeWordTriggered) return;

    let silenceStart: number | null = null;
    const SILENCE_THRESHOLD = 0.05;
    const SILENCE_DURATION = 2000;
    const MAX_RECORDING_TIME = 30000;
    
    autoStopTimerRef.current = setTimeout(() => {
      handleVoiceRelease();
    }, MAX_RECORDING_TIME);

    const checkInterval = setInterval(() => {
      if (audioLevel < SILENCE_THRESHOLD) {
        if (silenceStart === null) {
          silenceStart = Date.now();
        } else if (Date.now() - silenceStart > SILENCE_DURATION) {
          handleVoiceRelease();
        }
      } else {
        silenceStart = null;
      }
    }, 100);

    return () => {
      clearInterval(checkInterval);
      if (autoStopTimerRef.current) {
        clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
    };
  }, [isRecording, isWakeWordTriggered, audioLevel, handleVoiceRelease]);

  return {
    // State
    voiceEnabled,
    isVoiceProcessing,
    isRecording,
    isPlaying,
    audioLevel,
    wakeWordState,
    effectiveAtlasState,
    effectiveAiState,
    lastUserMessage,
    lastAiResponse,
    isWakeWordSupported,
    
    // Handlers
    handleEnableVoice,
    handleVoicePress,
    handleVoiceRelease,
    handleManualActivate,
    stopCurrentAudio,
    speakSentence,
  };
}
