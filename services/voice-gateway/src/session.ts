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
import { createVad, type VadEngine, type VadAssets } from "./vad.ts";
import { RealtimeStt } from "./stt.ts";
import { TtsPipeline, DirectTtsProvider } from "./tts.ts";

// ElevenLabs key injected into the sidecar from the Keychain. Voice runs
// directly against ElevenLabs for TTS + scribe tokens — no Supabase hop.
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;

// Voice delegates "thinking" to the brain sidecar (one brain, not two): the
// brain runs the orchestrator with memory + tools against the local atlas.db
// and streams the reply back over 127.0.0.1, guarded by the shared sidecar
// token. Phase 2's Claude swap in the brain then covers voice for free.
const SIDECAR_TOKEN = process.env.SIDECAR_TOKEN;
const BRAIN_URL = `http://127.0.0.1:${process.env.ATLAS_BRAIN_PORT ?? "4830"}/chat-with-memory`;

import { SentenceChunker, stripForSpeech, type SentenceChunk } from "./sentence.ts";
import type { ServerMsg, ClientMsg, AtlasState } from "./protocol.ts";

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export interface SessionConfig {
  /** Cloudflare account JWT — forwarded to the brain, which re-checks it. */
  userJwt: string;
  userId: string;
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
    // Direct ElevenLabs TTS (key from the Keychain). No Supabase fallback.
    this.tts = new TtsPipeline(new DirectTtsProvider(ELEVEN_KEY ?? ""));
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
      {
        onPartial: (text) => this.cfg.send({ type: "partial_transcript", text }),
        onFinal: () => { /* resolved in finish() */ },
        onError: (e) => console.error("[session] STT error:", e.message),
      },
      this.cfg.languageCode,
      ELEVEN_KEY,
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

    // Delegate the turn to the brain sidecar: it runs the orchestrator (memory
    // recall + tools) against the local atlas.db and streams the reply back.
    // Aborting llmSignal (barge-in) cancels the fetch, killing the stream.
    let res: Response;
    try {
      res = await fetch(BRAIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.userJwt}`,
          ...(SIDECAR_TOKEN ? { "x-sidecar-token": SIDECAR_TOKEN } : {}),
        },
        body: JSON.stringify({
          messages: this.history,
          source: "voice_chat",
          enableTools: true,
          conversationId: this.conversationId,
        }),
        signal: llmSignal,
      });
    } catch (e) {
      if (llmSignal.aborted) return; // barged in while thinking
      this.cfg.send({ type: "error", message: (e as Error).message });
      this.setState("idle");
      return;
    }

    if (llmSignal.aborted) return; // barged in while thinking

    if (!res.ok || !res.body) {
      let message = `brain error ${res.status}`;
      try { message = (await res.json())?.error ?? message; } catch { /* non-json body */ }
      this.cfg.send({ type: "error", message });
      this.setState("idle");
      return;
    }

    // Memory-less / teaching path returns a single JSON body — speak it whole.
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      const body = await res.json().catch(() => ({}));
      const text = stripForSpeech(String((body as { response?: unknown })?.response ?? ""));
      if (text) {
        this.turnFullText = text;
        this.speakChunks([{ text, charStart: 0, charEnd: text.length }]);
        void this.finishTurnWhenSpoken();
      } else {
        this.setState("idle");
      }
      return;
    }

    // Parse the SSE stream → deltas → sentence chunks → TTS.
    const chunker = new SentenceChunker();
    const reader = res.body.getReader();
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
