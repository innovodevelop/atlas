/**
 * Atlas's voice on the Beta Entry screens (left-out row 30): the design's
 * "Voice on / Voice off" pill, speaking each line through the existing TTS
 * path (useStreamingTTS → the local voice gateway → ElevenLabs).
 *
 * Off by default and remembered (src/lib/entryVoice.ts). The caller decides
 * WHICH lines may be spoken — the sign-in screen never speaks on its password
 * step (betaEntry.ts `lineSpeakable`) — and calls `say` only for those;
 * `silence` stops a line mid-word when the step changes under it. Outside the
 * desktop app the gateway is absent and `say` is silent: the typed line is
 * always the one that counts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { mayBeEcho, readEntryVoice, writeEntryVoice } from '@/lib/entryVoice';

export interface EntryVoice {
  on: boolean;
  /** Audio is coming out right now (drives the sphere's `speaking`). */
  playing: boolean;
  /** Flip the pill. Turning it on speaks `line` when the caller passes one. */
  toggle: (line?: string | null) => void;
  /** Speak a line, if the pill is on. */
  say: (line: string) => void;
  /** Stop whatever is being said, now. */
  silence: () => void;
  /** A transcript arriving now may be Atlas's own voice through the microphone. */
  mayBeEcho: () => boolean;
}

export function useEntryVoice(): EntryVoice {
  const [on, setOn] = useState(readEntryVoice);
  const { speak, stopPlayback, isPlaying } = useStreamingTTS();
  const onRef = useRef(on);
  onRef.current = on;
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;
  const quietSince = useRef(0);
  useEffect(() => { if (!isPlaying) quietSince.current = Date.now(); }, [isPlaying]);

  const say = useCallback((line: string) => {
    if (!onRef.current || !line.trim()) return;
    void speak(line).catch(() => { /* no gateway: the typed line still stands */ });
  }, [speak]);

  const toggle = useCallback((line?: string | null) => {
    const next = !onRef.current;
    onRef.current = next;
    setOn(next);
    writeEntryVoice(next);
    // Silence takes effect now, not at the end of the sentence: whoever
    // reaches for the pill wants the room quiet immediately.
    if (!next) stopPlayback();
    else if (line) say(line);
  }, [stopPlayback, say]);

  const echo = useCallback(() => mayBeEcho(playingRef.current, quietSince.current), []);

  return { on, playing: isPlaying, toggle, say, silence: stopPlayback, mayBeEcho: echo };
}
