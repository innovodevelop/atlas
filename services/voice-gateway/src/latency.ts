/**
 * Per-turn latency breakdown (feat-025).
 *
 * The session used to log one number, speech-end → first TTS byte, which says
 * a turn was slow but not where. TurnTimer records each stage boundary of a
 * turn and reports every stage as milliseconds since the turn started, so a
 * slow turn names its own bottleneck:
 *
 *   start         VAD speech-end (voice) or the text query arriving (typed)
 *   sttFinal      final transcript in hand (voice turns only)
 *   brainHeaders  the brain answered (memory recall + tool routing done)
 *   firstToken    first streamed text delta from the model
 *   firstSentence first chunk handed to TTS (the sentence chunker waited for it)
 *   firstAudio    first TTS byte back from ElevenLabs
 *
 * The gaps between consecutive marks are the stage costs. Each mark is taken
 * once per turn: later calls are ignored, so "first" stays first.
 */

export const STAGES = ["sttFinal", "brainHeaders", "firstToken", "firstSentence", "firstAudio"] as const;
export type Stage = (typeof STAGES)[number];

export type LatencyBreakdown = { [K in Stage]?: number } & { voice: boolean };

export class TurnTimer {
  private marks = new Map<Stage, number>();

  constructor(
    private readonly start: number,
    readonly voice: boolean,
    private readonly now: () => number = () => performance.now(),
  ) {}

  mark(stage: Stage): void {
    if (!this.marks.has(stage)) this.marks.set(stage, this.now());
  }

  has(stage: Stage): boolean {
    return this.marks.has(stage);
  }

  /** Milliseconds from the turn's start to each stage reached so far. */
  breakdown(): LatencyBreakdown {
    const out: LatencyBreakdown = { voice: this.voice };
    for (const s of STAGES) {
      const t = this.marks.get(s);
      if (t !== undefined) out[s] = Math.round(t - this.start);
    }
    return out;
  }

  /** One log line: cumulative times plus what each stage cost on its own. */
  describe(): string {
    const b = this.breakdown();
    let prev = 0;
    const parts: string[] = [];
    for (const s of STAGES) {
      const t = b[s];
      if (t === undefined) continue;
      parts.push(`${s} ${t}ms (+${t - prev})`);
      prev = t;
    }
    return `${b.voice ? "speech-end" : "text query"} → ${parts.join(" → ")}`;
  }
}
