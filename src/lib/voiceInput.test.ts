/* eslint-disable @typescript-eslint/no-explicit-any -- the storage tests stand
   up a minimal `window` double on globalThis. */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_VOICE_INPUT, PTT_CODE, VOICE_INPUT_EVENT, VOICE_INPUT_KEY, onVoiceInputChange, parseVoiceInput, pttStep, readVoiceInput, setVoiceInput,
  type PttEvent, type PttState,
} from './voiceInput';

describe('the stored switches', () => {
  test('defaults, partial and malformed values', () => {
    expect(parseVoiceInput(null)).toEqual(DEFAULT_VOICE_INPUT);
    expect(DEFAULT_VOICE_INPUT).toEqual({ wakeWord: true, pushToTalk: false, muteWhenLocked: true });
    expect(parseVoiceInput('{"pushToTalk":true}')).toEqual({ wakeWord: true, pushToTalk: true, muteWhenLocked: true });
    expect(parseVoiceInput('{"wakeWord":"no","muteWhenLocked":false}')).toEqual({ wakeWord: true, pushToTalk: false, muteWhenLocked: false });
    expect(parseVoiceInput('not json')).toEqual(DEFAULT_VOICE_INPUT);
    expect(parseVoiceInput('null')).toEqual(DEFAULT_VOICE_INPUT);
  });

  describe('reading, writing and listening', () => {
    afterEach(() => { delete (globalThis as any).window; delete (globalThis as any).CustomEvent; });

    function fakeWindow() {
      const store = new Map<string, string>();
      const listeners = new Map<string, Set<(e: any) => void>>();
      (globalThis as any).CustomEvent = class extends Event {
        detail: unknown;
        constructor(type: string, init: { detail?: unknown } = {}) { super(type); this.detail = init.detail; }
      };
      (globalThis as any).window = {
        localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
        addEventListener: (t: string, fn: (e: any) => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn); },
        removeEventListener: (t: string, fn: (e: any) => void) => { listeners.get(t)?.delete(fn); },
        dispatchEvent: (e: Event) => { listeners.get(e.type)?.forEach((fn) => fn(e)); return true; },
      };
      return { store, listeners };
    }

    test('a write persists, merges, and reaches this window’s listeners', () => {
      const { store, listeners } = fakeWindow();
      const seen: boolean[] = [];
      const off = onVoiceInputChange((p) => seen.push(p.pushToTalk));
      setVoiceInput({ pushToTalk: true });
      expect(JSON.parse(store.get(VOICE_INPUT_KEY)!)).toEqual({ wakeWord: true, pushToTalk: true, muteWhenLocked: true });
      setVoiceInput({ wakeWord: false });
      expect(readVoiceInput()).toEqual({ wakeWord: false, pushToTalk: true, muteWhenLocked: true });
      expect(seen).toEqual([true, true]);
      off();
      expect(listeners.get(VOICE_INPUT_EVENT)!.size).toBe(0);
      expect(listeners.get('storage')!.size).toBe(0);
    });

    test('without a window it reads the defaults and writes nothing', () => {
      expect(readVoiceInput()).toEqual(DEFAULT_VOICE_INPUT);
      expect(setVoiceInput({ pushToTalk: true }).pushToTalk).toBe(true);
    });
  });
});

describe('push to talk', () => {
  function run(events: PttEvent[], from: PttState = 'idle') {
    let state = from;
    const actions: string[] = [];
    for (const e of events) {
      const step = pttStep(state, e);
      state = step.state;
      if (step.action) actions.push(step.action);
    }
    return { state, actions };
  }
  const down = (code = PTT_CODE, typing = false, repeat = false): PttEvent => ({ type: 'down', code, typing, repeat });
  const up = (code = PTT_CODE): PttEvent => ({ type: 'up', code });

  test('hold, speak, release: one turn, sent on release', () => {
    expect(run([down(), { type: 'held' }, down(PTT_CODE, false, true), up()])).toEqual({ state: 'idle', actions: ['arm', 'start', 'end'] });
  });

  test('a tap is not a hold', () => {
    expect(run([down(), up()])).toEqual({ state: 'idle', actions: ['arm', 'disarm'] });
  });

  test('⌥ Space and ⌥-typed characters are shortcuts, not holds', () => {
    expect(run([down(), down('Space'), { type: 'held' }, up()])).toEqual({ state: 'idle', actions: ['arm', 'disarm'] });
  });

  test('never while typing in a field, and only the right Option key', () => {
    expect(run([down(PTT_CODE, true), { type: 'held' }])).toEqual({ state: 'idle', actions: [] });
    expect(run([down('AltLeft'), { type: 'held' }])).toEqual({ state: 'idle', actions: [] });
  });

  test('other keys while talking do not end the turn; losing the window does', () => {
    expect(run([down(), { type: 'held' }, down('KeyA'), up('KeyA')])).toEqual({ state: 'talking', actions: ['arm', 'start'] });
    expect(run([{ type: 'blur' }], 'talking')).toEqual({ state: 'idle', actions: ['end'] });
    expect(run([{ type: 'blur' }], 'armed')).toEqual({ state: 'idle', actions: ['disarm'] });
    expect(run([{ type: 'blur' }])).toEqual({ state: 'idle', actions: [] });
  });
});
