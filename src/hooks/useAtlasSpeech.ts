import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { isVoiceOn } from '@/lib/voicePreference';

// Atlas "speaking" — the word-by-word reveal from the login screen, extracted so
// any screen can talk in the same cadence instead of re-implementing the timer.
//
// IT USED TO BE SILENT. `speak()` revealed words and produced no sound, so the
// consent and onboarding screens — the two places Atlas introduces itself —
// animated a talking sphere over nothing. The name was the giveaway: a hook
// called useAtlasSpeech whose speak() only typed. It now drives the same
// streaming TTS the sign-in screen uses, behind the same shared mute
// preference, so silencing Atlas once silences it for the whole pre-account
// sequence rather than per screen.
//
// The visual contract (see .awd / .acaret in workshop.css): each word is its own
// <span class="awd">, and a caret blinks while Atlas is still mid-sentence. The
// CSS deliberately sets `opacity:1` as the BASE with `forwards` on the keyframe
// rather than starting at 0 — WKWebView sometimes skips the entrance animation
// and would otherwise leave the whole headline permanently invisible. Do not
// "tidy" that into opacity:0.
//
// Reduced motion: workshop.css's global prefers-reduced-motion block already
// neuters the per-word fade, but the TIMER also has to go or the text would
// still trickle in silently. `speak()` therefore reveals everything at once when
// the user has asked for less motion.

const WORD_MS = 115;

export interface AtlasSpeech {
  /** Words revealed so far — render each in a <span className="awd">. */
  words: string[];
  /** True once the whole line has landed (use it to reveal the answer panel). */
  done: boolean;
  /** True while words are still appearing — drives the blinking caret. */
  speaking: boolean;
  /** Say a line. Cancels anything currently being said. */
  speak: (text: string) => void;
  /** Cancel immediately and clear (e.g. on unmount or "start over"). */
  reset: () => void;
  /**
   * Stop the AUDIO only, leaving the words on screen.
   *
   * This is what a mute button needs: `reset()` would also blank the sentence
   * the user is currently reading, so silencing Atlas would look like the
   * screen breaking.
   */
  hush: () => void;
}

export interface AtlasSpeechOptions {
  /**
   * Whether to say the line out loud as well as type it. Default true.
   *
   * Pass false only where audio would be wrong for the SCREEN — not to respect
   * the user's mute, which is handled centrally by `isVoiceOn()` and must not
   * be re-implemented per caller.
   */
  aloud?: boolean;
}

export function useAtlasSpeech(options: AtlasSpeechOptions = {}): AtlasSpeech {
  const [tokens, setTokens] = useState<string[]>([]);
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const { speak: playAudio, stopPlayback } = useStreamingTTS();
  const aloud = options.aloud !== false;
  // Read at call time, not at render time: the mute toggle writes localStorage
  // from a sibling component, and a value captured on first render would keep
  // talking after the user asked for quiet.
  const audioRef = useRef<(text: string) => void>(() => {});
  audioRef.current = (text: string) => {
    if (!aloud || !isVoiceOn()) return;
    // Outside Tauri there is no voice gateway and this resolves to a no-op, so
    // browser preview stays silent without a special case.
    void playAudio(text).catch(() => { /* no gateway — the typed line still stands */ });
  };

  const stop = useCallback(() => {
    window.clearInterval(timer.current);
    timer.current = undefined;
  }, []);

  const speak = useCallback((text: string) => {
    stop();
    const parts = text.split(' ');
    setTokens(parts);
    audioRef.current(text);

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      // No trickle: the whole line lands at once, still legible and skippable.
      setShown(parts.length);
      setDone(true);
      return;
    }

    setShown(0);
    setDone(false);
    let i = 0;
    timer.current = window.setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= parts.length) {
        stop();
        setDone(true);
      }
    }, WORD_MS);
  }, [stop]);

  const reset = useCallback(() => {
    stop();
    // Cancel the audio too: "start over" that keeps talking about the previous
    // step is worse than no voice at all.
    stopPlayback();
    setTokens([]);
    setShown(0);
    setDone(false);
  }, [stop, stopPlayback]);

  // Never leave an interval running behind a navigation.
  useEffect(() => stop, [stop]);

  return {
    words: tokens.slice(0, shown),
    done,
    speaking: tokens.length > 0 && !done,
    speak,
    reset,
    hush: stopPlayback,
  };
}
