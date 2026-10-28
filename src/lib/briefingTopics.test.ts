import { describe, expect, test } from 'bun:test';
import { MAX_TOPICS, checkTopic, newsIntervalMs, normalizeTopic, parseTopics, toggleTopic, topicLabel } from './briefingTopics';

describe('Briefing topics', () => {
  test('a topic is a category or a short plain keyword', () => {
    expect(normalizeTopic(' Technology ')).toBe('technology');
    expect(normalizeTopic('climate  change')).toBe('climate change');
    expect(normalizeTopic('AI & policy')).toBe('AI & policy');
    expect(normalizeTopic('x')).toBeNull();
    expect(normalizeTopic('a=b&apiKey=1')).toBeNull();
    expect(normalizeTopic('a'.repeat(41))).toBeNull();
  });

  test('the stored list is cleaned, deduplicated and capped', () => {
    expect(parseTopics(JSON.stringify(['Science', 'science', 'climate', '??', 'sports', 'health', 'business'])))
      .toEqual(['science', 'climate', 'sports', 'health']);
    expect(parseTopics('{')).toEqual([]);
    expect(parseTopics(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  test('adding says why it cannot', () => {
    expect(checkTopic('climate', [])).toEqual({ ok: true, topic: 'climate' });
    expect(checkTopic('Climate', ['climate'])).toMatchObject({ ok: false });
    expect(checkTopic('!', [])).toMatchObject({ ok: false });
    expect(checkTopic('more', ['a1', 'b1', 'c1', 'd1'])).toMatchObject({ ok: false });
  });

  test('a chip switches its category on and off, never past the cap', () => {
    expect(toggleTopic(['science'], 'science')).toEqual([]);
    expect(toggleTopic([], 'health')).toEqual(['health']);
    const full = ['a1', 'b1', 'c1', 'd1'];
    expect(toggleTopic(full, 'health')).toEqual(full);
    expect(full).toHaveLength(MAX_TOPICS);
  });

  test('labels and the poll interval', () => {
    expect(topicLabel('technology')).toBe('Technology');
    expect(topicLabel('climate')).toBe('climate');
    expect(newsIntervalMs([], 900)).toBe(900);
    expect(newsIntervalMs(['a1', 'b1', 'c1'], 900)).toBe(2700);
  });
});
