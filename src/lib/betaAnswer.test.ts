import { describe, expect, test } from 'bun:test';
import { classify, headlineOf, questionFrom } from './betaAnswer';

describe('classify', () => {
  test('routes the design\'s six asks', () => {
    expect(classify('Do I need an umbrella tomorrow?')).toBe('weather');
    expect(classify('How much did I spend on food this month?')).toBe('money');
    expect(classify('When’s the next train to Lund?')).toBe('travel');
    expect(classify('Compare the two flats we’re looking at')).toBe('compare');
    expect(classify('What do I know about Priya Raman?')).toBe('person');
    expect(classify('Explain the EU AI Act in two minutes')).toBe('explain');
  });
  test('falls back to the explainer', () => {
    expect(classify('How do heat pumps work?')).toBe('explain');
  });
});

describe('headlineOf', () => {
  test('takes the first sentence without markdown', () => {
    expect(headlineOf('**Yes, take one.** It rains from 15:00.\n\n- more')).toBe('Yes, take one.');
    expect(headlineOf('# Heading\nThe act sorts AI by risk, and most of it applies from August 2026. More text.')).toBe('Heading The act sorts AI by risk, and most of it applies from August 2026.');
  });
  test('clips a long first sentence', () => {
    const long = `${'word '.repeat(60)}end.`;
    expect(headlineOf(long).length).toBeLessThanOrEqual(140);
    expect(headlineOf(long).endsWith('…')).toBe(true);
    expect(headlineOf('')).toBe('');
  });
});

describe('questionFrom', () => {
  test('prefers the query string, then router state', () => {
    expect(questionFrom('?q=Do+I+need+an+umbrella%3F', null)).toBe('Do I need an umbrella?');
    expect(questionFrom('', { q: ' hi ' })).toBe('hi');
    expect(questionFrom('?x=1', { other: 1 })).toBeNull();
  });
});
