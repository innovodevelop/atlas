import { useCallback, useEffect, useRef, useState } from 'react';

// Atlas "speaking" — the word-by-word reveal from the login screen, extracted so
// any screen can talk in the same cadence instead of re-implementing the timer.
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
}

export function useAtlasSpeech(): AtlasSpeech {
  const [tokens, setTokens] = useState<string[]>([]);
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const stop = useCallback(() => {
    window.clearInterval(timer.current);
    timer.current = undefined;
  }, []);

  const speak = useCallback((text: string) => {
    stop();
    const parts = text.split(' ');
    setTokens(parts);

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
    setTokens([]);
    setShown(0);
    setDone(false);
  }, [stop]);

  // Never leave an interval running behind a navigation.
  useEffect(() => stop, [stop]);

  return {
    words: tokens.slice(0, shown),
    done,
    speaking: tokens.length > 0 && !done,
    speak,
    reset,
  };
}
