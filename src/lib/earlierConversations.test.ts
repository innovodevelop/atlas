import { describe, expect, test } from 'bun:test';
import { conversationRow, earlierThan, parseConversation, parseConversationList, sourceLabel } from './earlierConversations';

const NOW = new Date(2026, 9, 28, 14, 0, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

describe('parseConversationList', () => {
  test('keeps well-formed rows only', () => {
    const list = parseConversationList({
      conversations: [
        { id: 'voice_1', source: 'voice_chat', title: '  Paris   packing list ', turns: 3, startedAt: at(27, 9), lastAt: at(27, 9, 4) },
        { id: 'talk_1', source: 'talk:Answer', title: 'Umbrella?', turns: 0, startedAt: at(28, 8), lastAt: at(28, 8) },
        { id: '', source: 'x', title: 't', turns: 1, startedAt: at(28, 8), lastAt: at(28, 8) },
        { id: 'c', source: 'text_chat', title: 'Heat pumps', turns: 2, startedAt: 'nope', lastAt: at(28, 8) },
        'junk',
      ],
    });
    expect(list).toEqual([{ id: 'voice_1', source: 'voice_chat', title: 'Paris packing list', turns: 3, startedAt: at(27, 9), lastAt: at(27, 9, 4) }]);
    expect(parseConversationList(null)).toEqual([]);
    expect(parseConversationList({ error: 'x' })).toEqual([]);
  });
});

describe('parseConversation', () => {
  test('user and assistant turns with text', () => {
    const turns = parseConversation({
      turns: [
        { role: 'user', content: 'Do I need an umbrella?', at: at(28, 8) },
        { role: 'tool', content: '{}', at: at(28, 8) },
        { role: 'assistant', content: '', at: at(28, 8) },
        { role: 'assistant', content: 'Yes, from 15:00.', at: at(28, 8) },
      ],
    });
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(parseConversation(undefined)).toEqual([]);
  });
});

describe('labels', () => {
  test('sources', () => {
    expect(sourceLabel('voice_chat')).toBe('Voice');
    expect(sourceLabel('talk:Answer')).toBe('Talk');
    expect(sourceLabel('text_chat')).toBe('Chat');
    expect(sourceLabel('teaching')).toBe('Teach');
    expect(sourceLabel('mail_compose')).toBe('Mail compose');
    expect(sourceLabel('')).toBe('Atlas');
  });
  test('the row', () => {
    const c = { id: 'v', source: 'voice_chat', title: 'Paris', turns: 6, startedAt: at(27, 9), lastAt: at(27, 9, 4) };
    expect(conversationRow(c, NOW)).toEqual({ sub: 'Voice · 6 turns · 4 min', when: 'Yesterday' });
    const today = { ...c, turns: 1, startedAt: at(28, 8, 2), lastAt: at(28, 8, 2) };
    expect(conversationRow(today, NOW)).toEqual({ sub: 'Voice · 1 turn · 1 min', when: 'Today, 08:02' });
  });
  test('only conversations begun before the screen opened', () => {
    const a = { id: 'a', source: '', title: 'a', turns: 1, startedAt: at(28, 9), lastAt: at(28, 13) };
    const b = { ...a, id: 'b', startedAt: at(28, 13, 59) };
    expect(earlierThan([a, b], NOW.getTime() - 30 * 60000).map((c) => c.id)).toEqual(['a']);
  });
});
