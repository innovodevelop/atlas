/**
 * Sentence/clause chunker for streaming TTS (ported from the client's
 * splitCompletedSentences in useUnifiedChat, extended with the plan's
 * clause rule: commas split once the pending buffer passes ~60 chars).
 *
 * Feed LLM deltas in; completed chunks come out with char offsets into the
 * full turn text — those offsets are what barge-in truncation maps back to.
 */

export interface SentenceChunk {
  text: string;
  charStart: number;
  charEnd: number;
}

const HARD_BOUNDARY = /[.!?;]["')\]]?\s/;
const CLAUSE_MIN_CHARS = 60;

export class SentenceChunker {
  private buffer = "";
  /** Char offset of buffer[0] within the full turn text. */
  private bufferStart = 0;
  private fullLength = 0;

  /** Push an LLM delta; returns any chunks completed by it. */
  push(delta: string): SentenceChunk[] {
    this.buffer += delta;
    this.fullLength += delta.length;
    return this.drain(false);
  }

  /** Flush whatever remains (end of stream). */
  flush(): SentenceChunk[] {
    return this.drain(true);
  }

  get totalChars(): number {
    return this.fullLength;
  }

  private drain(force: boolean): SentenceChunk[] {
    const out: SentenceChunk[] = [];

    for (;;) {
      const hard = HARD_BOUNDARY.exec(this.buffer);
      let cut = -1;

      if (hard) {
        cut = hard.index + hard[0].length;
      } else if (this.buffer.length >= CLAUSE_MIN_CHARS) {
        // Clause rule: a comma is a good-enough TTS boundary on long clauses.
        const comma = this.buffer.indexOf(", ");
        if (comma >= CLAUSE_MIN_CHARS / 2) cut = comma + 2;
      }

      if (cut === -1) break;

      const text = this.buffer.slice(0, cut);
      if (text.trim().length > 0) {
        out.push({
          text: text.trimEnd(),
          charStart: this.bufferStart,
          charEnd: this.bufferStart + cut,
        });
      }
      this.bufferStart += cut;
      this.buffer = this.buffer.slice(cut);
    }

    if (force && this.buffer.trim().length > 0) {
      out.push({
        text: this.buffer.trim(),
        charStart: this.bufferStart,
        charEnd: this.bufferStart + this.buffer.length,
      });
      this.bufferStart += this.buffer.length;
      this.buffer = "";
    }

    return out;
  }
}

/** Strip markdown the TTS shouldn't read aloud (mirrors client stripForSpeech). */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/#+\s/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
