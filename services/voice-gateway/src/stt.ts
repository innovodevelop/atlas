/**
 * Realtime STT: ElevenLabs Scribe v2 Realtime over WebSocket.
 *
 * The gateway speaks the raw WS protocol (the @elevenlabs/react SDK wraps the
 * same endpoint in the browser). Auth: a single-use token minted by the
 * `elevenlabs-scribe-token` edge function with the user's JWT — the API key
 * never reaches this process.
 *
 * Post-wake PCM frames are forwarded as base64 audio messages; partial and
 * final transcripts stream back. Endpointing is the VAD's job, not the STT's
 * — on VAD speech-end the session is committed and the final transcript
 * resolves the turn.
 */

export interface SttEvents {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
}

const SCRIBE_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export class RealtimeStt {
  private ws: WebSocket | null = null;
  private open = false;
  private finalText = "";
  private partialText = "";
  private pendingFrames: Uint8Array[] = [];

  constructor(
    private supabaseUrl: string,
    private anonKey: string,
    private userJwt: string,
    private events: SttEvents,
    private languageCode?: string, // e.g. "da" — Danish-first product
    private apiKey?: string, // ElevenLabs key (direct mint); falls back to edge fn
  ) {}

  /** Mint a single-use scribe token — directly from ElevenLabs when the key is
   *  injected (Phase 5), else via the edge function (transitional). */
  private async mintToken(): Promise<string> {
    if (this.apiKey) {
      const r = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
        method: "POST",
        headers: { "xi-api-key": this.apiKey },
      });
      if (!r.ok) throw new Error(`scribe token failed: ${r.status}`);
      return (await r.json()).token;
    }
    const tokenRes = await fetch(`${this.supabaseUrl}/functions/v1/elevenlabs-scribe-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.anonKey,
        Authorization: `Bearer ${this.userJwt}`,
      },
      body: JSON.stringify({}),
    });
    if (!tokenRes.ok) throw new Error(`scribe token failed: ${tokenRes.status}`);
    return (await tokenRes.json()).token;
  }

  /** Mint a single-use token and open the WS. Resolves when ready for audio. */
  async start(): Promise<void> {
    const token = await this.mintToken();

    const params = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      token,
      audio_format: "pcm_16000",
    });
    if (this.languageCode) params.set("language_code", this.languageCode);

    const ws = new WebSocket(`${SCRIBE_WS_URL}?${params}`);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("scribe WS open timeout")), 8000);
      ws.onopen = () => {
        clearTimeout(to);
        this.open = true;
        // Flush any frames that arrived while connecting.
        for (const f of this.pendingFrames) this.sendFrame(f);
        this.pendingFrames = [];
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(to);
        reject(new Error("scribe WS error"));
      };
    });

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        // Scribe v2 realtime message shapes: partial_transcript / final_transcript
        // (variants observed: {type, text} and {message_type, text}).
        const type = msg.type ?? msg.message_type ?? "";
        const text: string = msg.text ?? msg.transcript ?? "";
        if (/partial/i.test(type)) {
          this.partialText = text;
          this.events.onPartial(text);
        } else if (/final|committed/i.test(type)) {
          this.finalText = this.finalText ? `${this.finalText} ${text}`.trim() : text;
          this.events.onFinal(this.finalText);
        }
      } catch {
        /* non-JSON frames ignored */
      }
    };
    ws.onerror = () => this.events.onError(new Error("scribe WS error"));
    ws.onclose = () => {
      this.open = false;
    };
  }

  /** Forward one PCM frame (Int16 LE bytes). Buffers until the WS is open. */
  feed(frame: Uint8Array): void {
    if (!this.open) {
      this.pendingFrames.push(frame);
      return;
    }
    this.sendFrame(frame);
  }

  private sendFrame(frame: Uint8Array): void {
    // Scribe realtime takes base64 audio chunks in JSON messages.
    this.ws?.send(JSON.stringify({
      type: "audio",
      audio_chunk: Buffer.from(frame).toString("base64"),
    }));
  }

  /**
   * VAD said the utterance ended: commit, wait briefly for the final
   * transcript, and return the best text we have.
   */
  async finish(): Promise<string> {
    try {
      this.ws?.send(JSON.stringify({ type: "commit" }));
    } catch { /* closing anyway */ }

    // Give the final transcript up to 1.2 s to land, else fall back to the
    // last partial (latency budget beats completeness here).
    const started = Date.now();
    while (Date.now() - started < 1200) {
      if (this.finalText) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    this.close();
    return (this.finalText || this.partialText).trim();
  }

  close(): void {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    this.open = false;
  }
}
