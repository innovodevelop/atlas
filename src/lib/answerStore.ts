/**
 * The last answer Atlas gave in the Talk panel, kept for the Answer screen.
 *
 * The panel's "Open the full answer →" hands the question, the text and the
 * citations here and navigates; the Beta Answer screen reads them so the
 * answer is not asked twice. One slot, this process only.
 */
import { useSyncExternalStore } from 'react';
import type { BrainCitation } from './brainSse';

export interface LastAnswer {
  question: string;
  text: string;
  citations: BrainCitation[];
  at: number;
}

let last: LastAnswer | null = null;
const listeners = new Set<() => void>();

export function setLastAnswer(a: Omit<LastAnswer, 'at'>): void {
  last = { ...a, at: Date.now() };
  listeners.forEach((l) => l());
}

export function getLastAnswer(): LastAnswer | null {
  return last;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useLastAnswer(): LastAnswer | null {
  return useSyncExternalStore(subscribe, getLastAnswer, getLastAnswer);
}

export function _resetAnswerStore(): void {
  last = null;
  listeners.clear();
}
