/**
 * Streaming TTS behind a thin provider interface — the ONE up-front
 * abstraction the brief authorizes, because Danish latency/naturalness may
 * force a provider change (benchmark during WS-B, not after).
 *
 * Bytes are forwarded to the sink AS THEY ARRIVE. Never `await res.blob()`.
 */

import { toElevenLabsVoiceSettings, type VoiceSettings } from "./voiceSettings.ts";

export interface TtsRequest {
  text: string;
  voiceId?: string;
  modelId?: string;
  /** How the voice performs — pace, expressiveness, consistency. Omit for the
   *  defaults, which are what shipped before any of this was tunable. */
  voiceSettings?: VoiceSettings;
  signal: AbortSignal;
}

export interface TtsProvider {
  readonly name: string;
  /** Stream audio bytes for one sentence chunk into `sink` as they arrive. */
  synthesize(req: TtsRequest, sink: (bytes: Uint8Array) => void): Promise<void>;
}

/**
 * Direct ElevenLabs streaming TTS. The API key is injected into the sidecar
 * from the Keychain (never reaches the webview).
 */
export class DirectTtsProvider implements TtsProvider {
  readonly name = "elevenlabs-direct";
  private static ALLOWED = ["eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_multilingual_v2"];

  constructor(private apiKey: string) {}

  async synthesize(req: TtsRequest, sink: (bytes: Uint8Array) => void): Promise<void> {
    const voiceId = req.voiceId || "EXAVITQu4vr4xnSDxMaL";
    const model = DirectTtsProvider.ALLOWED.includes(req.modelId ?? "") ? req.modelId : "eleven_turbo_v2_5";
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        model_id: model,
        output_format: "mp3_44100_128",
        // Clamped in voiceSettings.ts; an absent/garbage value yields the
        // defaults rather than a failed turn.
        voice_settings: toElevenLabsVoiceSettings(req.voiceSettings),
      }),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`TTS failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) sink(value);
    }
  }
}

/**
 * Pipelined synthesis queue: chunk N+1 synthesizes while chunk N's bytes are
 * still being delivered/played. `abort()` cancels everything in flight —
 * that's the barge-in path.
 */
export class TtsPipeline {
  private queue: Array<{
    chunkIndex: number;
    run: () => Promise<void>;
  }> = [];
  private running = false;
  private controller = new AbortController();

  constructor(private provider: TtsProvider) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  enqueue(
    chunkIndex: number,
    text: string,
    opts: { voiceId?: string; modelId?: string; voiceSettings?: VoiceSettings },
    onStart: () => void,
    sink: (bytes: Uint8Array) => void,
    onEnd: () => void,
  ): void {
    const signal = this.controller.signal;
    this.queue.push({
      chunkIndex,
      run: async () => {
        if (signal.aborted) return;
        onStart();
        try {
          await this.provider.synthesize({ text, ...opts, signal }, sink);
        } finally {
          if (!signal.aborted) onEnd();
        }
      },
    });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.controller.signal.aborted) {
        const item = this.queue.shift()!;
        try {
          await item.run();
        } catch (e) {
          if (!this.controller.signal.aborted) {
            console.error(`[tts] chunk ${item.chunkIndex} failed:`, e);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Barge-in / cancel: abort in-flight fetches and drop the queue. */
  abort(): void {
    this.controller.abort();
    this.queue = [];
    this.controller = new AbortController();
  }

  get idle(): boolean {
    return !this.running && this.queue.length === 0;
  }
}
