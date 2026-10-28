import { describe, expect, test } from 'bun:test';
import { inboxOffline, liveFaceState, networkOffline, watchAttention } from './betaWidgetCatalog';
import { seenAt } from './dataAge';

// Row 1: Home's live widgets switch faces on their own, from the catalog's detectors.

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

describe('liveFaceState', () => {
  test('loading before offline before attention; otherwise the ordinary face', () => {
    const attention = { text: 'AAPL +4%', tone: 'blue' as const };
    expect(liveFaceState({ loading: true, offline: 'x', attention })).toBe('loading');
    expect(liveFaceState({ loading: false, offline: 'x', attention })).toBe('offline');
    expect(liveFaceState({ loading: false, offline: null, attention })).toBe('attention');
    expect(liveFaceState({ loading: false, offline: null, attention: null })).toBeUndefined();
  });
});

describe('networkOffline', () => {
  test('only a source with a real reading goes offline', () => {
    expect(networkOffline('weather', { hasData: false, error: 'HTTP 500', online: true, arrivedAt: null }, NOW)).toBeNull();
    expect(networkOffline('weather', { hasData: true, error: null, online: true, arrivedAt: NOW }, NOW)).toBeNull();
  });

  test('names the cause and the age of what is kept', () => {
    expect(networkOffline('watch', { hasData: true, error: 'HTTP 429', online: true, arrivedAt: NOW - 12 * 60000 }, NOW))
      .toBe('market feed unreachable · last quotes 12 min ago');
    expect(networkOffline('briefing', { hasData: true, error: null, online: false, arrivedAt: null }, NOW))
      .toBe('this Mac is offline · last headlines kept');
  });
});

describe('inboxOffline', () => {
  const synced = new Date(NOW - 2 * 3600000).toISOString();
  test('quiet with no mailbox, or with healthy ones online', () => {
    expect(inboxOffline([], false, NOW)).toBeNull();
    expect(inboxOffline([{ status: 'active', last_error: null, last_synced_at: synced }], true, NOW)).toBeNull();
  });
  test('a failing mailbox or no network says when it last synced', () => {
    expect(inboxOffline([{ status: 'error', last_error: 'auth', last_synced_at: synced }], true, NOW)).toBe('mail sync paused · last synced 2 h ago');
    expect(inboxOffline([{ status: 'active', last_error: null, last_synced_at: null }], false, NOW)).toBe('mail sync paused');
  });
});

describe('watchAttention with the user’s threshold', () => {
  const stocks = [{ symbol: 'AAPL', changePercent: 1.8 }, { symbol: 'NVDA', changePercent: -2.6 }];
  test('the default 3% holds nothing here; 2% flags the biggest mover', () => {
    expect(watchAttention(stocks)).toBeNull();
    expect(watchAttention(stocks, 2)?.text).toContain('NVDA');
    expect(watchAttention(stocks, 2)?.text).toContain('±2%');
  });
});

describe('seenAt', () => {
  test('remembers the first moment a reading was seen', () => {
    const r = {};
    expect(seenAt(r, 100)).toBe(100);
    expect(seenAt(r, 900)).toBe(100);
    expect(seenAt({}, 900)).toBe(900);
  });
});
