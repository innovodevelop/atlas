import { describe, expect, test } from 'bun:test';
import { DEFAULT_CURRENCY, clampAmount, fmtMoney, isCurrency, monthMove, parseCurrencyPrefs, rateDateLabel } from './betaCurrency';

describe('Currency', () => {
  test('only ECB currencies are currencies', () => {
    expect(isCurrency('DKK')).toBe(true);
    expect(isCurrency('dkk')).toBe(false);
    expect(isCurrency('BTC')).toBe(false);
  });

  test('the saved choice parses, and a corrupt one is the default', () => {
    expect(parseCurrencyPrefs(JSON.stringify({ base: 'DKK', quote: 'SEK', amount: 250 }))).toEqual({ base: 'DKK', quote: 'SEK', amount: 250 });
    expect(parseCurrencyPrefs(JSON.stringify({ base: 'XYZ', amount: -4 }))).toEqual({ ...DEFAULT_CURRENCY, amount: 1 });
    expect(parseCurrencyPrefs('nope')).toEqual(DEFAULT_CURRENCY);
    expect(parseCurrencyPrefs(null)).toEqual(DEFAULT_CURRENCY);
  });

  test('amounts are positive, to the cent, and bounded', () => {
    expect(clampAmount(12.345)).toBe(12.35);
    expect(clampAmount(0)).toBe(1);
    expect(clampAmount(Number.NaN)).toBe(1);
    expect(clampAmount(1e12)).toBe(1e9);
  });

  test('the month’s move is measured from the line’s first rate', () => {
    expect(monthMove({ rate: 1.1, series: [{ date: '2026-09-28', rate: 1 }, { date: '2026-10-27', rate: 1.1 }] })).toBeCloseTo(10);
    expect(monthMove({ rate: 1.1, series: [] })).toBeNull();
  });

  test('money and the rate’s day are written for the reader', () => {
    expect(fmtMoney(1, 'EUR', 'en-US')).toBe('€1');
    expect(fmtMoney(1.0912, 'USD', 'en-US')).toBe('$1.09');
    expect(fmtMoney(1234.5, 'USD', 'en-US')).toBe('$1,235');
    expect(rateDateLabel('2026-10-27', 'en-US')).toBe('Rate for Tue, Oct 27');
    expect(rateDateLabel('')).toBe('Rate today');
  });
});
