/**
 * Realtime STT: ElevenLabs Scribe v2 Realtime over WebSocket.
 *
 * The gateway speaks the raw WS protocol (the @elevenlabs/react SDK wraps the
 * same endpoint in the browser). Auth: a single-use token minted directly from
 * ElevenLabs with the Keychain-injected API key — no Supabase hop.
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
const SCRIBE_TOKEN_URL = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
/** ElevenLabs single-use tokens live 15 minutes; a prefetched one older than
 *  this is thrown away rather than risked. */
const TOKEN_FRESH_MS = 10 * 60_000;
/** How long finish() waits for the final transcript after the commit. */
const FINAL_WAIT_MS = 1200;

/**
 * Mints scribe tokens ahead of need (feat-025). Minting used to happen on
 * wake, so every utterance paid an HTTPS round trip to ElevenLabs before the
 * STT socket could even start opening. Now a session prefetches one token,
 * each take() hands over the prefetched token and starts minting the next,
 * and only a cold or stale cache mints inline.
 */
export class ScribeTokenCache {
  private next: { token: Promise<string>; at: number } | null = null;

  constructor(
    private apiKey: string | undefined,
    private mint: (apiKey: string) => Promise<string> = mintScribeToken,
    private now: () => number = () => Date.now(),
  ) {}

  /** Start minting a token in the background, if none is waiting. */
  prefetch(): void {
    if (!this.apiKey || this.next) return;
    const token = this.mint(this.apiKey);
    // A failed prefetch is dropped; take() then mints inline and reports.
    token.catch(() => {
      if (this.next?.token === token) this.next = null;
    });
    this.next = { token, at: this.now() };
  }

  async take(): Promise<string> {
    if (!this.apiKey) throw new Error("ELEVENLABS_API_KEY not configured");
    const waiting = this.next;
    this.next = null;
    let token: string | null = null;
    if (waiting && this.now() - waiting.at < TOKEN_FRESH_MS) {
      token = await waiting.token.catch(() => null);
    }
    this.prefetch();
    return token ?? this.mint(this.apiKey);
  }
}

/** Mint a single-use scribe token directly from ElevenLabs. */
export async function mintScribeToken(apiKey: string): Promise<string> {
  const r = await fetch(SCRIBE_TOKEN_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
  });
  if (!r.ok) throw new Error(`scribe token failed: ${r.status}`);
  return (await r.json()).token;
}

export class RealtimeStt {
  private ws: WebSocket | null = null;
  private open = false;
  private finalText = "";
  private partialText = "";
  private pendingFrames: Uint8Array[] = [];
  /** Wakes finish() as soon as a final transcript lands. */
  private finalArrived: (() => void) | null = null;
  /** close() was called: a start() still waiting for its token must not open a socket nobody will close. */
  private closed = false;

  constructor(
    private events: SttEvents,
    private languageCode: string | undefined, // e.g. "da" — Danish-first product
    private tokens: ScribeTokenCache,
  ) {}

  /** Take a single-use token and open the WS. Resolves when ready for audio. */
  async start(): Promise<void> {
    const token = await this.tokens.take();
    if (this.closed) throw new Error("STT closed before it opened");

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
          if (this.finalText) this.finalArrived?.();
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
    // Resolves the moment a final transcript arrives (it used to poll every
    // 40 ms), or after FINAL_WAIT_MS with whatever partial there is.
    if (!this.finalText) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, FINAL_WAIT_MS);
        this.finalArrived = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      this.finalArrived = null;
    }
    this.close();
    return (this.finalText || this.partialText).trim();
  }

  close(): void {
    this.closed = true;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    this.open = false;
  }
}
