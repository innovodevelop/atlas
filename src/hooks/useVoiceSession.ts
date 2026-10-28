/**
 * useVoiceSession — the ONE voice hook (WS-B B4).
 *
 * Owns the duplex connection to the local voice gateway:
 *  - mic → AudioWorklet (16 kHz Int16 PCM frames) → WS binary
 *  - WS ← control JSON (state, transcripts, chunk metadata, barge_in)
 *  - WS ← binary MP3 per sentence chunk → flushable Web Audio playback queue
 *  - on barge_in: flush instantly and report the exact played position so the
 *    gateway can truncate the assistant turn to what was actually audible.
 *  - how it listens, from Settings → Voice (src/lib/voiceInput.ts): the wake
 *    word on or off, push to talk (hold the right ⌥ key), and the microphone
 *    gated off while the Mac's screen is locked.
 *
 * Replaces useVoice, useWakeWord(Core), useStreamingTTS, useDashboardVoice,
 * useRealtimeScribeStable. Exposes the existing AIState shape so AtlasSphere
 * and the dashboard chrome stay untouched.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "@/lib/authClient";
import { WakeWordDetector } from "@/lib/wakeWord";
import { createReconnectGovernor, type ReconnectGovernor } from "@/lib/reconnectGovernor";
import { PTT_HOLD_MS, onVoiceInputChange, pttStep, readVoiceInput, type PttEvent, type PttState } from "@/lib/voiceInput";
import { isTypingTarget } from "@/lib/betaScreenKeys";
import type { VoiceSettings } from "@/lib/voiceTuning";
import type { AIState } from "@/types";

const DEFAULT_GATEWAY_URL =
  (import.meta.env.VITE_VOICE_GATEWAY_URL as string | undefined) ?? "ws://127.0.0.1:4820/ws";

/**
 * In the packaged app the gateway is a Tauri-spawned sidecar guarded by a
 * per-launch token; fetch {port, token} from Rust. In the browser/dev the
 * default URL + no token is used (dev gateway runs without SIDECAR_TOKEN).
 */
async function gatewayTarget(): Promise<{ url: string; sessionToken?: string }> {
  if (!("__TAURI_INTERNALS__" in window)) return { url: DEFAULT_GATEWAY_URL };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{ port: number; token: string; running: boolean }>("voice_gateway_info");
    return { url: `ws://127.0.0.1:${info.port}/ws`, sessionToken: info.token };
  } catch {
    return { url: DEFAULT_GATEWAY_URL };
  }
}

interface ServerMsg {
  type: string;
  [k: string]: unknown;
}

interface ChunkPlayback {
  chunkIndex: number;
  buffers: Uint8Array[];
  complete: boolean;
}

export interface UseVoiceSessionResult {
  /** Sphere/chrome contract — unchanged from the legacy hooks. */
  effectiveAtlasState: AIState;
  audioLevel: number;
  /** Gateway reachable + session authed. */
  connected: boolean;
  /** Live partial transcript while listening. */
  partialTranscript: string;
  /** Microphone gated off — the track is disabled, so nothing is captured. */
  muted: boolean;
  /** Toggle the microphone. */
  toggleMute: () => void;
  /** Mic button / wake action. */
  handleManualActivate: () => void;
  /** Stop everything (Esc). */
  cancel: () => void;
  /** Dev/text path through the same session. */
  sendText: (text: string) => void;
}

export function useVoiceSession(options?: {
  voiceId?: string;
  ttsModelId?: string;
  /** How the voice performs. Forwarded verbatim; the gateway clamps it. */
  voiceSettings?: VoiceSettings;
  onTurnEnd?: (spokenText: string, interrupted: boolean) => void;
  onFinalTranscript?: (text: string) => void;
}): UseVoiceSessionResult {
  const [state, setState] = useState<AIState>("idle");
  const [connected, setConnected] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [partialTranscript, setPartialTranscript] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  // Owns the onclose→reconnect timer. Created in the mount effect (NOT
  // lazily on the ref: cancel is permanent, and an effect re-run on the same
  // component instance — StrictMode's dev double-mount — must get a fresh
  // governor or reconnects would be refused forever). Cancelled in the
  // unmount cleanup BEFORE the socket is closed — closing fires onclose, and
  // an unguarded onclose used to arm a reconnect during teardown, spawning a
  // hello-authenticated zombie session 3s after every navigation away (audit
  // finding C1). See reconnectGovernor.ts for the full incident.
  const reconnectRef = useRef<ReconnectGovernor | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  // Mute is a real capture gate, not a UI flag: it disables the MediaStream
  // track, so neither the gateway nor the local wake detector receives a
  // single frame. A "muted" indicator that still captured audio would be the
  // worst kind of lie for a microphone.
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  // Settings → Voice → "Mute when the Mac is locked": the same capture gate
  // as the mute button, held by the lock check below rather than the user,
  // so unlocking restores exactly what the user had chosen.
  const [lockMuted, setLockMuted] = useState(false);
  const lockMutedRef = useRef(false);
  // How Atlas listens (src/lib/voiceInput.ts): wake word, push to talk, lock mute.
  const [inputPrefs, setInputPrefs] = useState(readVoiceInput);
  const inputPrefsRef = useRef(inputPrefs);
  inputPrefsRef.current = inputPrefs;
  // True while the microphone stream is open (after the first activation).
  const [capturing, setCapturing] = useState(false);

  // Wake word (B2): openWakeWord runs locally on every frame while IDLE;
  // frames stream to the gateway only during an active turn. Pre-wake audio
  // never leaves the process.
  const wakeRef = useRef<WakeWordDetector | null>(null);
  const inTurnRef = useRef(false);

  // Playback bookkeeping
  const chunkQueueRef = useRef<ChunkPlayback[]>([]);
  const currentChunkRef = useRef<ChunkPlayback | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playingRef = useRef(false);
  const chunkStartedAtRef = useRef(0);
  const currentChunkDurationRef = useRef(0);
  const currentChunkIndexRef = useRef(-1);
  const outputLevelTimerRef = useRef<number | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // ---------------------------------------------------------------------
  // Playback queue: each chunk = one small MP3, decoded and played in order.

  const stopPlayback = useCallback(() => {
    playingRef.current = false;
    chunkQueueRef.current = [];
    currentChunkRef.current = null;
    try { currentSourceRef.current?.stop(); } catch { /* not started */ }
    currentSourceRef.current = null;
    if (outputLevelTimerRef.current) {
      cancelAnimationFrame(outputLevelTimerRef.current);
      outputLevelTimerRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  const playNextChunk = useCallback(async () => {
    if (playingRef.current) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const next = chunkQueueRef.current.find((c) => c.complete);
    if (!next) return;
    chunkQueueRef.current = chunkQueueRef.current.filter((c) => c !== next);

    playingRef.current = true;
    currentChunkRef.current = next;
    currentChunkIndexRef.current = next.chunkIndex;

    try {
      const total = next.buffers.reduce((n, b) => n + b.length, 0);
      const joined = new Uint8Array(total);
      let off = 0;
      for (const b of next.buffers) { joined.set(b, off); off += b.length; }

      const audioBuffer = await ctx.decodeAudioData(joined.buffer.slice(0) as ArrayBuffer);
      currentChunkDurationRef.current = audioBuffer.duration * 1000;
      chunkStartedAtRef.current = ctx.currentTime;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      currentSourceRef.current = source;

      // Coarse output level for the sphere while speaking.
      const animate = () => {
        if (!playingRef.current) return;
        const t = (ctx.currentTime - chunkStartedAtRef.current) * 6;
        setAudioLevel(0.35 + 0.3 * Math.abs(Math.sin(t)));
        outputLevelTimerRef.current = requestAnimationFrame(animate);
      };
      animate();

      source.onended = () => {
        playingRef.current = false;
        currentSourceRef.current = null;
        void playNextChunk();
      };
      source.start();
    } catch (e) {
      console.error("[voice] chunk decode/play failed:", e);
      playingRef.current = false;
      void playNextChunk();
    }
  }, []);

  // ---------------------------------------------------------------------
  // Gateway connection

  const connect = useCallback(async () => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;

    const token = getToken();
    if (!token) return; // not logged in — voice stays dormant

    const target = await gatewayTarget();
    const ws = new WebSocket(target.url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "hello",
        jwt: token,
        sessionToken: target.sessionToken,
        sampleRate: 16000,
        voiceId: optionsRef.current?.voiceId,
        ttsModelId: optionsRef.current?.ttsModelId,
        voiceSettings: optionsRef.current?.voiceSettings,
      }));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        // Binary: TTS bytes for the currently announced chunk.
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        const open = chunkQueueRef.current[chunkQueueRef.current.length - 1];
        if (open && !open.complete) open.buffers.push(bytes);
        return;
      }
      const msg = JSON.parse(ev.data) as ServerMsg;
      switch (msg.type) {
        case "ready":
          setConnected(true);
          break;
        case "state": {
          const s = msg.state as AIState;
          setState(s);
          if (s !== "listening") setPartialTranscript("");
          // Frame routing: gateway during a turn, local wake detector when idle.
          inTurnRef.current = s !== "idle";
          if (s === "idle") wakeRef.current?.reset();
          break;
        }
        case "partial_transcript":
          setPartialTranscript(String(msg.text ?? ""));
          break;
        case "final_transcript":
          optionsRef.current?.onFinalTranscript?.(String(msg.text ?? ""));
          break;
        case "tts_chunk_start":
          chunkQueueRef.current.push({
            chunkIndex: Number(msg.chunkIndex),
            buffers: [],
            complete: false,
          });
          break;
        case "tts_chunk_end": {
          const chunk = chunkQueueRef.current.find(
            (c) => c.chunkIndex === Number(msg.chunkIndex),
          );
          if (chunk) chunk.complete = true;
          void playNextChunk();
          break;
        }
        case "barge_in": {
          // Flush NOW, then report exactly how much was audible.
          const ctx = audioCtxRef.current;
          const msInto = ctx && playingRef.current
            ? (ctx.currentTime - chunkStartedAtRef.current) * 1000
            : currentChunkDurationRef.current; // finished chunk = fully heard
          const report = {
            type: "barge_in_report",
            chunkIndex: currentChunkIndexRef.current,
            msIntoChunk: Math.round(msInto),
            chunkDurationMs: Math.round(currentChunkDurationRef.current),
          };
          stopPlayback();
          wsRef.current?.send(JSON.stringify(report));
          break;
        }
        case "turn_end":
          stopPlayback();
          optionsRef.current?.onTurnEnd?.(String(msg.spokenText ?? ""), Boolean(msg.interrupted));
          break;
        case "error":
          console.error("[voice] gateway error:", msg.message);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setState("idle");
      wsRef.current = null;
      // Gateway restarting (sidecar respawn) — retry quietly. Through the
      // governor, never a bare setTimeout: this handler also fires when the
      // UNMOUNT cleanup closes the socket, and that path must not schedule.
      reconnectRef.current?.arm(() => void connect(), 3000);
    };
    ws.onerror = () => { /* onclose handles retry */ };
  }, [playNextChunk, stopPlayback]);

  // ---------------------------------------------------------------------
  // Mic capture: AudioWorklet → 20 ms Int16 frames → WS binary. Runs for the
  // whole session (VAD server-side needs audio during playback for barge-in).

  // Arm the wake detector, once capture exists and the wake word is wanted
  // (Settings → Voice → "Listen for Hey Atlas"). With it off the model is not
  // even loaded, and idle frames go nowhere.
  const armWake = useCallback(async () => {
    if (wakeRef.current || !inputPrefsRef.current.wakeWord) return;
    try {
      const detector = await WakeWordDetector.create(() => {
        if (inTurnRef.current) return;
        inTurnRef.current = true; // route frames to the gateway immediately
        wsRef.current?.send(JSON.stringify({ type: "wake" }));
      });
      // Switched off, or capture closed, while the model loaded.
      if (!inputPrefsRef.current.wakeWord || !workletNodeRef.current || wakeRef.current) { detector.destroy(); return; }
      wakeRef.current = detector;
      console.log("[voice] wake word armed (openWakeWord)");
    } catch (e) {
      console.warn("[voice] wake word unavailable:", (e as Error).message);
    }
  }, []);

  const startCapture = useCallback(async () => {
    if (workletNodeRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micStreamRef.current = stream;
    // A stream opened while muted (e.g. reconnect, or a locked screen) must start disabled.
    if (mutedRef.current || lockMutedRef.current) stream.getAudioTracks().forEach((tr) => { tr.enabled = false; });

    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") await ctx.resume();

    await ctx.audioWorklet.addModule("/worklets/pcm-capture.js");
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-capture");
    node.port.onmessage = (ev) => {
      const { pcm, rms } = ev.data as { pcm: ArrayBuffer; rms: number };
      // Belt and braces: the track is already disabled, but dropping frames
      // here means a race on toggle cannot leak one through.
      if (mutedRef.current || lockMutedRef.current) return;
      if (inTurnRef.current) {
        // Active turn: frames go to the gateway (STT + server VAD barge-in).
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(pcm);
      } else {
        // Idle: frames feed ONLY the local wake detector.
        //
        // MUST be caught. This runs once per audio frame, and ORT's WASM backend
        // rejects with a bare Emscripten integer (not an Error) when inference
        // fails. A plain `void` here meant every failing frame raised an
        // unhandled rejection — which the index.html reporter treated as a fatal
        // start-up crash and painted over a perfectly working app.
        //
        // Wake word is optional, exactly like its init path above: on failure we
        // retire the detector and carry on. Push-to-talk and typing are unaffected.
        wakeRef.current?.push(new Int16Array(pcm)).catch((e) => {
          const d = wakeRef.current;
          wakeRef.current = null; // stop 50 rejections/second from one broken session
          d?.destroy();
          console.warn("[voice] wake word inference failed — detector retired:", e);
        });
      }
      // Drive the level from the mic while listening (playback drives it
      // while speaking).
      if (!playingRef.current) setAudioLevel(Math.min(1, rms * 4));
    };
    source.connect(node);
    // Worklet is a sink — no need to connect to destination.
    workletNodeRef.current = node;
    setCapturing(true);

    // Arm the wake detector once capture exists (first user activation
    // granted the mic — from here "Hey Atlas" works hands-free).
    await armWake();
  }, [armWake]);

  const stopCapture = useCallback(() => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    wakeRef.current?.destroy();
    wakeRef.current = null;
    setCapturing(false);
  }, []);

  // ---------------------------------------------------------------------
  // Public API

  /** Toggle the microphone. Disables the track itself, so capture truly stops. */
  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      mutedRef.current = next;
      micStreamRef.current?.getAudioTracks().forEach((tr) => { tr.enabled = !(next || lockMutedRef.current); });
      return next;
    });
  }, []);

  /** `hold`: push to talk — the gateway keeps listening until `end_speech`. */
  const activate = useCallback((hold: boolean) => {
    void (async () => {
      await connect();
      inTurnRef.current = true; // route frames gateway-ward before the state round-trip
      await startCapture();
      wsRef.current?.send(JSON.stringify(hold ? { type: "activate", hold: true } : { type: "activate" }));
    })();
  }, [connect, startCapture]);

  const handleManualActivate = useCallback(() => activate(false), [activate]);

  // ---------------------------------------------------------------------
  // How Atlas listens (Settings → Voice → Voice input; src/lib/voiceInput.ts)

  useEffect(() => onVoiceInputChange(setInputPrefs), []);

  // "Listen for Hey Atlas" switched while the microphone is open: load or
  // drop the detector now rather than at the next activation.
  useEffect(() => {
    if (!capturing) return;
    if (inputPrefs.wakeWord) { void armWake(); return; }
    wakeRef.current?.destroy();
    wakeRef.current = null;
  }, [capturing, inputPrefs.wakeWord, armWake]);

  // Push to talk: hold the right ⌥ key to speak, release to send. The key
  // rules are pttStep's; this only feeds it events and carries out its steps.
  useEffect(() => {
    if (!inputPrefs.pushToTalk) return;
    let state: PttState = "idle";
    let timer: number | undefined;
    const feed = (e: PttEvent) => {
      const step = pttStep(state, e);
      state = step.state;
      if (step.action === "arm") timer = window.setTimeout(() => feed({ type: "held" }), PTT_HOLD_MS);
      if (step.action === "disarm" || step.action === "start") window.clearTimeout(timer);
      if (step.action === "start") activate(true);
      if (step.action === "end") wsRef.current?.send(JSON.stringify({ type: "end_speech" }));
    };
    const onDown = (e: KeyboardEvent) => feed({ type: "down", code: e.code, typing: isTypingTarget(e.target), repeat: e.repeat });
    const onUp = (e: KeyboardEvent) => feed({ type: "up", code: e.code });
    const onBlur = () => feed({ type: "blur" });
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      // Switched off mid-hold: close the turn rather than leave it listening.
      feed({ type: "blur" });
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [inputPrefs.pushToTalk, activate]);

  // Mute when the Mac is locked. Asked of Rust (`screen_locked`, an ioreg
  // read) every five seconds, and only while the microphone is open and the
  // window is not focused — a focused window means someone is at an unlocked
  // screen, and with the mic closed there is nothing to mute. Runs while the
  // window is inactive on purpose: that is exactly when a screen locks.
  useEffect(() => {
    const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    const setGate = (locked: boolean) => {
      if (lockMutedRef.current === locked) return;
      lockMutedRef.current = locked;
      setLockMuted(locked);
      micStreamRef.current?.getAudioTracks().forEach((tr) => { tr.enabled = !(locked || mutedRef.current); });
      // Atlas stops listening the moment the screen locks: a turn that was
      // listening is cancelled, not left waiting for audio that cannot come.
      if (locked && inTurnRef.current) wsRef.current?.send(JSON.stringify({ type: "cancel" }));
    };
    if (!native || !capturing || !inputPrefs.muteWhenLocked) { setGate(false); return; }
    let alive = true;
    const check = async () => {
      if (document.hasFocus()) { setGate(false); return; }
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const locked = await invoke<boolean>("screen_locked");
        if (alive) setGate(locked);
      } catch {
        /* an older build without the command: never mute on a guess */
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 5000);
    return () => { alive = false; window.clearInterval(id); };
  }, [capturing, inputPrefs.muteWhenLocked]);

  const cancel = useCallback(() => {
    stopPlayback();
    wsRef.current?.send(JSON.stringify({ type: "cancel" }));
  }, [stopPlayback]);

  const sendText = useCallback((text: string) => {
    void (async () => {
      await connect();
      wsRef.current?.send(JSON.stringify({ type: "text_query", text }));
    })();
  }, [connect]);

  // Connect lazily on mount (no mic permission until first activation).
  useEffect(() => {
    reconnectRef.current = createReconnectGovernor();
    void connect();
    return () => {
      // Cancel BEFORE closing: close() fires onclose, and onclose arms the
      // reconnect. Cancelled-first means that arm is a refused no-op instead
      // of a zombie session with nobody left to close it.
      reconnectRef.current?.cancel();
      stopCapture();
      stopPlayback();
      wsRef.current?.close();
      wsRef.current = null;
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    // The capture gate as it is: the user's mute, or a locked screen's.
    muted: muted || lockMuted,
    toggleMute,
    effectiveAtlasState: state,
    audioLevel,
    connected,
    partialTranscript,
    handleManualActivate,
    cancel,
    sendText,
  };
}
