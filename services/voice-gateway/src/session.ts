/**
 * VoiceSession — one connected client's duplex loop.
 *
 * State machine:
 *   idle ── wake/activate ──▶ listening ── VAD speech-end ──▶ thinking
 *     ▲                                                          │
 *     └────────────── turn_end ◀── speaking ◀── first TTS chunk ─┘
 *
 * Barge-in: the VAD runs on EVERY inbound PCM frame, including while state is
 * "speaking". Speech-start during speaking → abort LLM + TTS, tell the client
 * to flush, and truncate the assistant turn in history to what was actually
 * audible (the client reports played position — see barge_in_report).
 */

import "./denoShim.ts";
import { runChat, type ChatMessage } from "../../../supabase/functions/_shared/orchestrator.ts";
import { createVad, type VadEngine, type VadAssets } from "./vad.ts";
import { RealtimeStt } from "./stt.ts";
import { TtsPipeline, EdgeFnTtsProvider } from "./tts.ts";
import { SentenceChunker, stripForSpeech, type SentenceChunk } from "./sentence.ts";
import type { ServerMsg, ClientMsg, AtlasState } from "./protocol.ts";

export interface SessionConfig {
  supabaseUrl: string;
  anonKey: string;
  userJwt: string;
  userId: string;
  /** User-scoped supabase client (RLS). Also passed as systemDb — see note. */
  supabase: any;
  /** VAD model + ORT wasm assets (paths in dev, embedded in the sidecar). */
  vadAssets: VadAssets;
  voiceId?: string;
  ttsModelId?: string;
  languageCode?: string;
  send: (msg: ServerMsg) => void;
  sendBinary: (bytes: Uint8Array) => void;
}

interface ChunkMeta extends SentenceChunk {
  chunkIndex: number;
}

export class VoiceSession {
  private state: AtlasState = "idle";
  private vad!: VadEngine;
  private stt: RealtimeStt | null = null;
  private tts: TtsPipeline;
  private history: ChatMessage[] = [];
  private conversationId = `voice_${Date.now()}`;

  // Current assistant turn bookkeeping (for truncation).
  private turnChunks: ChunkMeta[] = [];
  private turnFullText = "";
  private llmAbort: AbortController | null = null;
  private awaitingBargeReport = false;

  // Latency instrumentation (bench + CI acceptance).
  private tSpeechEnd = 0;
  private tFirstAudio = 0;
  onLatency: ((wakeToFirstAudioMs: number) => void) | null = null;

  private constructor(private cfg: SessionConfig) {
    this.tts = new TtsPipeline(new EdgeFnTtsProvider(cfg.supabaseUrl, cfg.anonKey, cfg.userJwt));
  }

  static async create(cfg: SessionConfig): Promise<VoiceSession> {
    const s = new VoiceSession(cfg);
    s.vad = await createVad(
      {
        onSpeechStart: () => s.onSpeechStart(),
        onSpeechEnd: () => void s.onSpeechEnd(),
      },
      cfg.vadAssets,
    );
    return s;
  }

  get vadEngine(): string {
    return this.vad.name;
  }

  // -------------------------------------------------------------------------
  // Inbound

  handleMessage(msg: ClientMsg): void {
    switch (msg.type) {
      case "wake":
      case "activate":
        void this.startListening();
        break;
      case "cancel":
        this.cancelTurn("cancel");
        break;
      case "barge_in_report":
        this.applyBargeReport(msg.chunkIndex, msg.msIntoChunk, msg.chunkDurationMs);
        break;
      case "text_query":
        void this.runTurn(msg.text);
        break;
      default:
        break;
    }
  }

  async handleAudio(bytes: Uint8Array): Promise<void> {
    const frame = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    // VAD chews EVERYTHING — during listening (endpointing) and during
    // speaking (barge-in detection). That's the whole point.
    await this.vad.process(frame);
    if (this.state === "listening" && this.stt) {
      this.stt.feed(bytes);
    }
  }

  // -------------------------------------------------------------------------
  // State transitions

  private setState(state: AtlasState): void {
    if (this.state === state) return;
    this.state = state;
    this.cfg.send({ type: "state", state });
  }

  private async startListening(): Promise<void> {
    if (this.state === "speaking" || this.state === "thinking") {
      // Manual activation mid-turn is a barge-in.
      this.bargeIn();
    }
    if (this.state === "listening") return;

    this.vad.reset();
    this.stt = new RealtimeStt(
      this.cfg.supabaseUrl,
      this.cfg.anonKey,
      this.cfg.userJwt,
      {
        onPartial: (text) => this.cfg.send({ type: "partial_transcript", text }),
        onFinal: () => { /* resolved in finish() */ },
        onError: (e) => console.error("[session] STT error:", e.message),
      },
      this.cfg.languageCode,
    );
    this.setState("listening");
    try {
      await this.stt.start();
    } catch (e) {
      console.error("[session] STT start failed:", (e as Error).message);
      this.cfg.send({ type: "error", message: "Speech recognition unavailable" });
      this.stt = null;
      this.setState("idle");
    }
  }

  private onSpeechStart(): void {
    if (this.state === "speaking" || this.state === "thinking") {
      this.bargeIn();
      // The user is talking — capture it as the next utterance.
      void this.startListening();
    }
  }

  private async onSpeechEnd(): Promise<void> {
    if (this.state !== "listening" || !this.stt) return;
    this.tSpeechEnd = performance.now();
    const text = await this.stt.finish();
    this.stt = null;
    if (!text) {
      this.setState("idle");
      return;
    }
    this.cfg.send({ type: "final_transcript", text });
    await this.runTurn(text);
  }

  // -------------------------------------------------------------------------
  // The turn: orchestrator stream → sentence chunks → pipelined TTS

  private async runTurn(userText: string): Promise<void> {
    this.setState("thinking");
    this.history.push({ role: "user", content: userText });
    this.turnChunks = [];
    this.turnFullText = "";
    this.tFirstAudio = 0;
    this.llmAbort = new AbortController();
    const llmSignal = this.llmAbort.signal;

    let result;
    try {
      result = await runChat(
        {
          supabase: this.cfg.supabase,
          // Local gateway holds no service-role key. The user client can READ
          // the system tables (SELECT is granted TO authenticated); system
          // WRITES (provider status, learning sessions) silently no-op under
          // RLS — acceptable local-first degradation, see ADR 001.
          systemDb: this.cfg.supabase,
          userId: this.cfg.userId,
          userToken: this.cfg.userJwt,
          supabaseUrl: this.cfg.supabaseUrl,
          perplexityKey: null, // web_search runs via edge deploys, not locally
          sessionId: this.conversationId,
        },
        {
          messages: this.history,
          source: "voice_chat",
          enableTools: true,
          conversationId: this.conversationId,
        },
      );
    } catch (e) {
      this.cfg.send({ type: "error", message: (e as Error).message });
      this.setState("idle");
      return;
    }

    if (llmSignal.aborted) return; // barged in while thinking

    if (result.kind === "error") {
      this.cfg.send({ type: "error", message: result.message });
      this.setState("idle");
      return;
    }
    if (result.kind === "json") {
      // Teaching-mode style single response — speak it whole.
      const text = stripForSpeech(String((result.body as any)?.response ?? ""));
      if (text) this.speakChunks([{ text, charStart: 0, charEnd: text.length }]);
      return;
    }

    // Parse the SSE stream → deltas → sentence chunks → TTS.
    const chunker = new SentenceChunker();
    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";

    try {
      for (;;) {
        if (llmSignal.aborted) {
          await reader.cancel().catch(() => {});
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = sseBuf.indexOf("\n")) >= 0) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 1);
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            const delta: string | undefined = json.choices?.[0]?.delta?.content;
            if (delta) {
              this.turnFullText += delta;
              this.speakChunks(chunker.push(delta));
            }
          } catch { /* citations event or partial JSON — skip */ }
        }
      }
      this.speakChunks(chunker.flush());
      void this.finishTurnWhenSpoken();
    } catch (e) {
      if (!llmSignal.aborted) {
        console.error("[session] stream error:", e);
        this.cfg.send({ type: "error", message: "Response stream failed" });
        this.setState("idle");
      }
    }
  }

  private speakChunks(chunks: SentenceChunk[]): void {
    for (const chunk of chunks) {
      const speakText = stripForSpeech(chunk.text);
      if (!speakText) continue;
      const chunkIndex = this.turnChunks.length;
      const meta: ChunkMeta = { ...chunk, chunkIndex };
      this.turnChunks.push(meta);

      this.tts.enqueue(
        chunkIndex,
        speakText,
        { voiceId: this.cfg.voiceId, modelId: this.cfg.ttsModelId },
        () => {
          if (this.tFirstAudio === 0) {
            this.tFirstAudio = performance.now();
            if (this.tSpeechEnd > 0) {
              const ms = Math.round(this.tFirstAudio - this.tSpeechEnd);
              console.log(`[latency] speech-end → first TTS byte: ${ms}ms`);
              this.onLatency?.(ms);
            }
            this.setState("speaking");
          }
          this.cfg.send({
            type: "tts_chunk_start",
            chunkIndex,
            text: chunk.text,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
          });
        },
        (bytes) => this.cfg.sendBinary(bytes),
        () => this.cfg.send({ type: "tts_chunk_end", chunkIndex }),
      );
    }
  }

  private async finishTurnWhenSpoken(): Promise<void> {
    // Wait for the TTS pipeline to drain, then close the turn un-truncated.
    while (!this.tts.idle) {
      if (this.awaitingBargeReport) return; // barge path owns the turn now
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.awaitingBargeReport) return;
    if (this.turnFullText) {
      this.history.push({ role: "assistant", content: this.turnFullText });
      this.cfg.send({ type: "turn_end", spokenText: this.turnFullText, interrupted: false });
    }
    this.setState("idle");
  }

  // -------------------------------------------------------------------------
  // Barge-in + truncation (the highest-value detail)

  private bargeIn(): void {
    this.llmAbort?.abort();
    this.tts.abort();
    this.awaitingBargeReport = true;
    this.cfg.send({ type: "barge_in" });
    // If no report lands (client hiccup), close the turn conservatively.
    setTimeout(() => {
      if (this.awaitingBargeReport) this.applyBargeReport(-1, 0, 0);
    }, 1500);
  }

  private applyBargeReport(chunkIndex: number, msIntoChunk: number, chunkDurationMs: number): void {
    if (!this.awaitingBargeReport) return;
    this.awaitingBargeReport = false;

    let spokenChars = 0;
    if (chunkIndex >= 0 && chunkIndex < this.turnChunks.length) {
      const chunk = this.turnChunks[chunkIndex];
      const fraction = chunkDurationMs > 0 ? Math.min(1, msIntoChunk / chunkDurationMs) : 0;
      spokenChars = chunk.charStart + Math.round(fraction * (chunk.charEnd - chunk.charStart));
    } else if (chunkIndex === -1 && this.turnChunks.length > 0) {
      // No report — assume everything enqueued before the abort was audible.
      spokenChars = this.turnChunks[this.turnChunks.length - 1].charEnd;
    }

    // Snap back to a word boundary (±1 word acceptance criterion).
    let spoken = this.turnFullText.slice(0, spokenChars);
    const lastSpace = spoken.lastIndexOf(" ");
    if (lastSpace > 0 && spokenChars < this.turnFullText.length) {
      spoken = spoken.slice(0, lastSpace);
    }
    spoken = spoken.trimEnd();

    // Store ONLY what was audible — if the full text entered history, Atlas
    // would believe it said things the user never heard.
    if (spoken) {
      this.history.push({ role: "assistant", content: `${spoken}— [interrupted]` });
    }
    this.cfg.send({ type: "turn_end", spokenText: spoken, interrupted: true });
    this.setState("idle");
  }

  private cancelTurn(_reason: string): void {
    this.llmAbort?.abort();
    this.tts.abort();
    this.stt?.close();
    this.stt = null;
    this.awaitingBargeReport = false;
    this.setState("idle");
  }

  destroy(): void {
    this.cancelTurn("disconnect");
  }
}
