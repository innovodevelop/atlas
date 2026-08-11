import { useState, useCallback, useEffect, useRef } from "react";
import { useScribe, CommitStrategy } from "@elevenlabs/react";
import { localClient as supabase } from '@/integrations/local/localClient';
import { getVoiceEndpoint } from "@/lib/voiceClient";

interface UseRealtimeScribeOptions {
  onPartialTranscript?: (text: string) => void;
  onFinalTranscript?: (text: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
  onConnectionChange?: (connected: boolean) => void;
  languageCodes?: string[]; // e.g. ['en', 'da'] for English and Danish
  maxRetries?: number;
}

// NOTE: This hook is intentionally in a new module to force a clean Fast Refresh boundary.
// If hooks were added/removed during HMR, React can get into an invalid hook queue state.
export const useRealtimeScribeStable = (options: UseRealtimeScribeOptions = {}) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const connectingRef = useRef(false);
  const lastConnectAttemptRef = useRef(0);
  const maxRetries = options.maxRetries ?? 3;
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track if user is speaking
  const [isSpeaking, setIsSpeaking] = useState(false);
  const speechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use ElevenLabs official useScribe hook with VAD for automatic speech-end detection
  // Language codes: 'en' for English, 'da' for Danish
  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: "vad" as CommitStrategy,
    languageCode: optionsRef.current.languageCodes?.[0] || "en", // Primary language
    onPartialTranscript: (data) => {
      console.log("[Scribe] Partial:", data.text);
      optionsRef.current.onPartialTranscript?.(data.text || "");

      if (!isSpeaking && data.text) {
        setIsSpeaking(true);
        optionsRef.current.onSpeechStart?.();
      }

      if (speechTimeoutRef.current) {
        clearTimeout(speechTimeoutRef.current);
      }
    },
    onCommittedTranscript: (data) => {
      console.log("[Scribe] Final:", data.text);
      optionsRef.current.onFinalTranscript?.(data.text || "");
      setIsSpeaking(false);
      optionsRef.current.onSpeechEnd?.();
    },
  });

  // Store scribe in ref to avoid dependency issues
  const scribeRef = useRef(scribe);
  scribeRef.current = scribe;

  // Track previous connection state for change detection
  const prevConnectedRef = useRef(scribe.isConnected);

  // Detect connection state changes (including unexpected disconnects)
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    const isNowConnected = scribe.isConnected;
    
    if (wasConnected !== isNowConnected) {
      console.log("[Scribe] Connection state changed:", wasConnected, "→", isNowConnected);
      optionsRef.current.onConnectionChange?.(isNowConnected);
      
      // If we unexpectedly disconnected after having been connected
      if (wasConnected && !isNowConnected && hasConnected && !connectingRef.current) {
        console.log("[Scribe] Unexpected disconnect detected");
        setConnectionError("Connection lost unexpectedly");
        optionsRef.current.onError?.(new Error("Connection lost unexpectedly"));
      }
    }
    
    prevConnectedRef.current = isNowConnected;
  }, [scribe.isConnected, hasConnected]);

  const CONNECT_COOLDOWN_MS = 3000;

  // Check microphone permission explicitly
  const checkMicrophonePermission = useCallback(async (): Promise<boolean> => {
    try {
      // Check if mediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Microphone access is not supported in this browser");
      }

      // Try to get permission status if available
      if (navigator.permissions) {
        try {
          const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          if (permissionStatus.state === 'denied') {
            throw new Error("Microphone permission denied. Please enable it in browser settings.");
          }
        } catch (e) {
          // permissions.query for microphone not supported in all browsers, continue
          console.log("[Scribe] Permission query not supported, will try getUserMedia directly");
        }
      }

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop the stream immediately, we just needed to check permission
      stream.getTracks().forEach(track => track.stop());
      console.log("[Scribe] Microphone permission granted");
      return true;
    } catch (error) {
      console.error("[Scribe] Microphone permission error:", error);
      const message = error instanceof Error ? error.message : "Microphone access denied";
      throw new Error(message);
    }
  }, []);

  const connect = useCallback(async (isRetry = false) => {
    const now = Date.now();

    // Only apply cooldown if not a retry
    if (!isRetry && now - lastConnectAttemptRef.current < CONNECT_COOLDOWN_MS) {
      console.log("[Scribe] Connect called too soon, throttling...");
      return false;
    }

    if (connectingRef.current || scribeRef.current.isConnected) {
      console.log("[Scribe] Already connecting or connected, skipping...");
      return scribeRef.current.isConnected;
    }

    lastConnectAttemptRef.current = now;
    connectingRef.current = true;
    setIsConnecting(true);
    setConnectionError(null);

    try {
      // Check microphone permission first
      console.log("[Scribe] Checking microphone permission...");
      await checkMicrophonePermission();

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Please sign in to enable voice.");
      }

      console.log("[Scribe] Getting token...");
      // Single-use scribe tokens are minted by the local voice gateway sidecar.
      const voice = await getVoiceEndpoint();
      if (!voice) {
        throw new Error("Voice is only available in the desktop app.");
      }
      const res = await fetch(`${voice.baseUrl}/scribe-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sidecar-token": voice.token },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const details = data?.error || "";
        console.error("[Scribe] Token request error:", res.status, details);
        throw new Error(details || `Token request failed (${res.status})`);
      }

      if (!data?.token) {
        throw new Error("No token received from token service");
      }

      console.log("[Scribe] Token received, connecting to WebSocket...");

      await scribeRef.current.connect({
        token: data.token,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Wait a moment and verify connection
      await new Promise(r => setTimeout(r, 500));
      
      if (!scribeRef.current.isConnected) {
        throw new Error("WebSocket connection failed to establish");
      }

      console.log("[Scribe] Connected successfully");
      setHasConnected(true);
      setRetryCount(0);
      setConnectionError(null);
      return true;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Connection failed";
      console.error("[Scribe] Connection error:", errorMessage);
      setConnectionError(errorMessage);
      optionsRef.current.onError?.(e instanceof Error ? e : new Error(errorMessage));
      return false;
    } finally {
      setIsConnecting(false);
      connectingRef.current = false;
    }
  }, [checkMicrophonePermission]);

  // Retry connection with exponential backoff
  const retryConnect = useCallback(async () => {
    if (retryCount >= maxRetries) {
      console.log("[Scribe] Max retries reached");
      setConnectionError(`Connection failed after ${maxRetries} attempts`);
      return false;
    }

    const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
    console.log(`[Scribe] Retry ${retryCount + 1}/${maxRetries} in ${delay}ms...`);
    
    setRetryCount(prev => prev + 1);
    
    await new Promise(r => setTimeout(r, delay));
    
    return connect(true);
  }, [retryCount, maxRetries, connect]);

  // Connect with auto-retry
  const connectWithRetry = useCallback(async () => {
    setRetryCount(0);
    const success = await connect();
    
    if (!success && retryCount < maxRetries) {
      return retryConnect();
    }
    
    return success;
  }, [connect, retryConnect, retryCount, maxRetries]);

  const disconnect = useCallback(() => {
    console.log("[Scribe] Disconnecting...");
    
    // Clear any pending retry
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    
    scribeRef.current.disconnect();
    setHasConnected(false);
    setRetryCount(0);
    setConnectionError(null);
  }, []);

  const isListening = scribe.isConnected && isSpeaking;

  /* eslint-disable react-hooks/exhaustive-deps --
     Unmount-only cleanup. The rule wants the ref copied to a local at effect
     SETUP time, which is precisely wrong here: these refs hold timeout ids that
     are reassigned throughout the session, so a value captured at mount would be
     stale (usually null) and we would leak the live timers. Reading .current at
     cleanup time is the intended behaviour. */
  useEffect(() => {
    return () => {
      if (speechTimeoutRef.current) {
        clearTimeout(speechTimeoutRef.current);
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      // Never leave a microphone open behind a navigation. useScribe does NOT
      // auto-disconnect on unmount — useLoginVoice already learned this and
      // fixed it for the same library — and until this line existed, leaving
      // /atlas-teach with voice connected kept the ElevenLabs realtime socket
      // AND live mic capture streaming to a third party indefinitely (audit
      // finding C2).
      try {
        scribeRef.current.disconnect();
      } catch {
        /* not connected */
      }
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  return {
    isConnected: scribe.isConnected,
    isConnecting,
    isListening,
    isSpeaking,
    partialTranscript: scribe.partialTranscript || "",
    finalTranscript:
      scribe.committedTranscripts?.[scribe.committedTranscripts.length - 1]?.text || "",
    connect: connectWithRetry,
    disconnect,
    hasConnected,
    connectionError,
    retryCount,
    maxRetries,
    retryConnect,
  };
};
