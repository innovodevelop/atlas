import { describe, expect, test } from 'bun:test';
import { parseBrainLine } from './brainSse';

describe('brain SSE lines', () => {
  test('text deltas, citations and the end marker', () => {
    expect(parseBrainLine('data: {"choices":[{"delta":{"content":"Hel"}}]}')).toEqual({ kind: 'text', delta: 'Hel' });
    expect(parseBrainLine('data: {"citations":["https://a.example","https://b.example"]}')).toEqual({
      kind: 'citations', citations: [{ url: 'https://a.example' }, { url: 'https://b.example' }],
    });
    expect(parseBrainLine('data: {"citations":[{"url":"https://c.example","title":"C"}]}')).toEqual({
      kind: 'citations', citations: [{ url: 'https://c.example', title: 'C' }],
    });
    expect(parseBrainLine('data: [DONE]')).toEqual({ kind: 'done' });
  });

  test('comments, blanks, CRLF and half a JSON object are skipped, not thrown', () => {
    expect(parseBrainLine(': beat')).toBeNull();
    expect(parseBrainLine('')).toBeNull();
    expect(parseBrainLine('event: ping')).toBeNull();
    expect(parseBrainLine('data: {"choices":[{"delta":{"content":"ok"}}]}\r')).toEqual({ kind: 'text', delta: 'ok' });
    expect(parseBrainLine('data: {"choices":[{"delta":{"con')).toBeNull();
    expect(parseBrainLine('data: {"choices":[{"delta":{}}]}')).toBeNull();
  });
});
