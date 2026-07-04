import { useEffect, useState } from 'react';

// Is the app actually being looked at? Drives the biggest perf win in the Mac
// app: the 3D sphere, card atmospheres and data polling all pause when the
// window is hidden or unfocused, dropping idle CPU/GPU to near zero.
//
// Browser: document.visibilitychange. Tauri: additionally the native window
// focus events (a fully visible but unfocused desktop window still animates
// at reduced priority — we treat "blurred for a while" as inactive).

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Module-level so every consumer shares one set of listeners
let listeners: Array<(active: boolean) => void> = [];
let currentActive = typeof document === 'undefined' ? true : !document.hidden;
let started = false;
let blurTimer: ReturnType<typeof setTimeout> | null = null;

// Grace period before "blurred" counts as inactive — quick cmd-tabs shouldn't
// freeze animations mid-frame.
const BLUR_GRACE_MS = 5_000;

function emit(active: boolean) {
  if (active === currentActive) return;
  currentActive = active;
  for (const listener of listeners) listener(active);
}

function handleFocusChange(focused: boolean) {
  if (blurTimer) {
    clearTimeout(blurTimer);
    blurTimer = null;
  }
  if (focused) {
    emit(true);
  } else {
    blurTimer = setTimeout(() => emit(false), BLUR_GRACE_MS);
  }
}

function start() {
  if (started || typeof document === 'undefined') return;
  started = true;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      emit(false);
    } else {
      emit(true);
    }
  });

  if (isTauri) {
    // Dynamic import so the browser build never touches the Tauri API
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          handleFocusChange(focused);
        });
      })
      .catch(() => {
        // Not fatal — visibilitychange still covers the hidden case
      });
  } else {
    window.addEventListener('focus', () => handleFocusChange(true));
    window.addEventListener('blur', () => handleFocusChange(false));
  }
}

/** Reactive: re-renders the consumer when window activity changes. */
export function useWindowActivity(): boolean {
  const [active, setActive] = useState(currentActive);

  useEffect(() => {
    start();
    listeners.push(setActive);
    setActive(currentActive);
    return () => {
      listeners = listeners.filter((l) => l !== setActive);
    };
  }, []);

  return active;
}

/** Non-reactive read for callbacks (e.g. refetchInterval functions). */
export function isWindowActive(): boolean {
  start();
  return currentActive;
}
