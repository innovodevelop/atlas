/**
 * Wire protocol between the app (WKWebView client) and the voice gateway.
 *
 * One WebSocket, two kinds of frames:
 *  - JSON text frames: control messages (this file).
 *  - Binary frames: audio. Client→server is raw Int16 PCM 16 kHz mono
 *    (~20 ms frames). Server→client is TTS audio bytes (MP3), bracketed by
 *    tts_chunk_start / tts_chunk_end so each byte run maps to one sentence
 *    chunk — that mapping is what makes truncated-turn context possible.
 */

export type AtlasState = "idle" | "listening" | "thinking" | "speaking";

// ---------------------------------------------------------------------------
// Client → Server

export interface HelloMsg {
  type: "hello";
  /** Supabase user JWT — validated before the session starts. */
  jwt: string;
  /** Tauri-spawn handshake token (SIDECAR_TOKEN); absent in dev. */
  sessionToken?: string;
  sampleRate: 16000;
  /** Voice/model settings mirrored from useAtlasSettings. */
  voiceId?: string;
  ttsModelId?: string;
}

/** Wake word fired client-side — start a listening turn. */
export interface WakeMsg {
  type: "wake";
}

/** Manual activation (mic button) — same as wake. */
export interface ActivateMsg {
  type: "activate";
}

/**
 * Client's answer to a server barge_in: exactly how much audio was audible.
 * chunkIndex + msIntoChunk come from the client's playback clock (it decodes
 * each chunk and knows real durations — the server only knows bytes).
 */
export interface BargeInReportMsg {
  type: "barge_in_report";
  chunkIndex: number;
  msIntoChunk: number;
  chunkDurationMs: number;
}

/** Cancel the current turn entirely (Esc / UI stop). */
export interface CancelMsg {
  type: "cancel";
}

/** Dev/text path: run a turn from typed text (skips STT). */
export interface TextQueryMsg {
  type: "text_query";
  text: string;
}

export type ClientMsg =
  | HelloMsg
  | WakeMsg
  | ActivateMsg
  | BargeInReportMsg
  | CancelMsg
  | TextQueryMsg;

// ---------------------------------------------------------------------------
// Server → Client

export interface ReadyMsg {
  type: "ready";
  sessionId: string;
}

export interface StateMsg {
  type: "state";
  state: AtlasState;
}

export interface PartialTranscriptMsg {
  type: "partial_transcript";
  text: string;
}

export interface FinalTranscriptMsg {
  type: "final_transcript";
  text: string;
}

/** Announces the next binary run: one TTS sentence chunk. */
export interface TtsChunkStartMsg {
  type: "tts_chunk_start";
  chunkIndex: number;
  text: string;
  /** Char offsets into the full assistant turn text. */
  charStart: number;
  charEnd: number;
}

export interface TtsChunkEndMsg {
  type: "tts_chunk_end";
  chunkIndex: number;
}

/** User spoke during playback — client must flush audio NOW and report. */
export interface BargeInMsg {
  type: "barge_in";
}

export interface TurnEndMsg {
  type: "turn_end";
  /** What the assistant actually said out loud (possibly truncated). */
  spokenText: string;
  /** True when the turn was cut short by a barge-in. */
  interrupted: boolean;
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

export type ServerMsg =
  | ReadyMsg
  | StateMsg
  | PartialTranscriptMsg
  | FinalTranscriptMsg
  | TtsChunkStartMsg
  | TtsChunkEndMsg
  | BargeInMsg
  | TurnEndMsg
  | ErrorMsg;
