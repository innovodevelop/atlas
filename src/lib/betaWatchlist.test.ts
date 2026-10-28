import { describe, expect, test } from 'bun:test';
import {
  MAX_TICKERS, STARTING_TICKERS, THRESHOLD_DEFAULT, checkAdd, clampThreshold, moveSymbol, normalizeSymbol, orderedSymbols,
  parseWatchPrefs, shownSymbols, stepThreshold, thresholdLabel,
} from './betaWatchlist';

describe('Watchlist', () => {
  test('a ticker is what the brain’s op accepts', () => {
    expect(normalizeSymbol(' brk.b ')).toBe('BRK.B');
    expect(normalizeSymbol('Apple Inc')).toBeNull();
    expect(normalizeSymbol('')).toBeNull();
    expect(normalizeSymbol('A'.repeat(13))).toBeNull();
  });

  test('the threshold steps by half a percent inside its bounds', () => {
    expect(clampThreshold(2.3)).toBe(2.5);
    expect(clampThreshold(0)).toBe(0.5);
    expect(clampThreshold(99)).toBe(20);
    expect(clampThreshold(Number.NaN)).toBe(THRESHOLD_DEFAULT);
    expect(stepThreshold(3, -1)).toBe(2.5);
    expect(stepThreshold(20, 1)).toBe(20);
    expect(thresholdLabel(3)).toBe('±3%');
    expect(thresholdLabel(2.5)).toBe('±2.5%');
  });

  test('preferences parse, dedupe and fall back', () => {
    expect(parseWatchPrefs(JSON.stringify({ order: ['aapl', 'AAPL', 'bad ticker', 'msft'], threshold: 4.2, edited: true })))
      .toEqual({ order: ['AAPL', 'MSFT'], threshold: 4, edited: true });
    expect(parseWatchPrefs('{')).toEqual({ order: [], threshold: THRESHOLD_DEFAULT, edited: false });
  });

  test('the user’s order leads; tickers the brain added follow, oldest first', () => {
    const rows = [
      { symbol: 'NVDA', created_at: '2026-10-02' }, { symbol: 'ASML', created_at: '2026-10-03' },
      { symbol: 'AAPL', created_at: '2026-10-01' }, { symbol: 'TSLA', created_at: '2026-10-01T00:00:01' },
    ];
    expect(orderedSymbols(rows, ['NVDA', 'GONE'])).toEqual(['NVDA', 'AAPL', 'TSLA', 'ASML']);
  });

  test('an untouched empty table shows the starting four; an edited one stays empty', () => {
    expect(shownSymbols([], { order: [], threshold: 3, edited: false })).toEqual({ symbols: [...STARTING_TICKERS], starting: true });
    expect(shownSymbols([], { order: [], threshold: 3, edited: true })).toEqual({ symbols: [], starting: false });
    expect(shownSymbols([{ symbol: 'ASML' }], { order: [], threshold: 3, edited: false })).toEqual({ symbols: ['ASML'], starting: false });
  });

  test('moving stops at the ends', () => {
    expect(moveSymbol(['A', 'B', 'C'], 'B', -1)).toEqual(['B', 'A', 'C']);
    expect(moveSymbol(['A', 'B', 'C'], 'C', 1)).toEqual(['A', 'B', 'C']);
    expect(moveSymbol(['A'], 'Z', 1)).toEqual(['A']);
  });

  test('adding says why it cannot', () => {
    expect(checkAdd('asml', ['AAPL'])).toEqual({ ok: true, symbol: 'ASML' });
    expect(checkAdd('AAPL', ['AAPL'])).toMatchObject({ ok: false });
    expect(checkAdd('Apple Inc', [])).toMatchObject({ ok: false });
    expect(checkAdd('ZZZ', Array.from({ length: MAX_TICKERS }, (_, i) => `T${i}`))).toMatchObject({ ok: false });
  });
});
