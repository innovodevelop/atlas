/**
 * Atlas "saying" a line on the Entry screens — the design's `say()`: two
 * characters every 28 ms, a caret while it runs, and the whole line at once
 * when the user has asked for less motion.
 *
 * This is the typed half of what the Workshop's `useAtlasSpeech` did; the
 * spoken half is deliberately absent. The sign-in greeting read out loud was
 * the most-complained-about thing on the old Entry (a stranger's laptop
 * announcing "And your password?" in a quiet room), and the Beta entry makes
 * no sound.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { TYPE_MS, typedLength } from '@/lib/betaEntry';
import { motionAllowed } from '@/lib/viewTransitions';

export interface Typewriter {
  /** The characters on screen so far. */
  shown: string;
  /** The whole line being said, for the live region once it has landed. */
  target: string;
  /** True while characters are still arriving — drives the caret and the sphere. */
  typing: boolean;
  /** Say a line. Cancels anything currently being said. */
  say: (text: string) => void;
}

export function useTypewriter(): Typewriter {
  const [target, setTarget] = useState('');
  const [shown, setShown] = useState('');
  const [typing, setTyping] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const stop = useCallback(() => {
    window.clearInterval(timer.current);
    timer.current = undefined;
  }, []);

  const say = useCallback((text: string) => {
    stop();
    setTarget(text);
    if (!motionAllowed()) {
      setShown(text);
      setTyping(false);
      return;
    }
    setShown('');
    setTyping(true);
    let tick = 0;
    timer.current = window.setInterval(() => {
      tick += 1;
      const n = typedLength(text.length, tick);
      setShown(text.slice(0, n));
      if (n >= text.length) { stop(); setTyping(false); }
    }, TYPE_MS);
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { shown, target, typing, say };
}
