import { describe, expect, test } from 'bun:test';
import { ECHO_TAIL_MS, ENTRY_VOICE_KEY, mayBeEcho, readEntryVoice, voicePillCopy, writeEntryVoice } from './entryVoice';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

describe('the Entry voice preference', () => {
  test('off by default, remembered once chosen', () => {
    const kv = memory();
    expect(readEntryVoice(kv)).toBe(false);
    writeEntryVoice(true, kv);
    expect(kv.m.get(ENTRY_VOICE_KEY)).toBe('on');
    expect(readEntryVoice(kv)).toBe(true);
    writeEntryVoice(false, kv);
    expect(readEntryVoice(kv)).toBe(false);
  });
  test('a blocked store reads as off and never throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readEntryVoice(broken)).toBe(false);
    expect(() => writeEntryVoice(true, broken)).not.toThrow();
    expect(readEntryVoice(null)).toBe(false);
  });
  test('is not the Workshop key', () => {
    expect(ENTRY_VOICE_KEY).not.toBe('atlas-auth-voice');
  });
});

describe('mayBeEcho', () => {
  test('while playing and for the tail after', () => {
    expect(mayBeEcho(true, 0, 10_000)).toBe(true);
    expect(mayBeEcho(false, 10_000, 10_000 + ECHO_TAIL_MS - 1)).toBe(true);
    expect(mayBeEcho(false, 10_000, 10_000 + ECHO_TAIL_MS)).toBe(false);
  });
});

describe('voicePillCopy', () => {
  test('says what leaves the Mac either way', () => {
    expect(voicePillCopy(true).label).toBe('Voice on');
    expect(voicePillCopy(false).label).toBe('Voice off');
    expect(voicePillCopy(true).title).toMatch(/leaves this Mac/);
    expect(voicePillCopy(false).title).toMatch(/never what you type/);
  });
});
