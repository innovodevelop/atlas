import { describe, expect, test } from 'bun:test';
import { DEFAULT_ON, resolveBetaUi } from './betaFlag';

describe('beta_ui flag', () => {
  test('is off by default until phase 8 flips it', () => {
    expect(DEFAULT_ON).toBe(false);
    expect(resolveBetaUi(null, null, null)).toBe(false);
  });

  test('URL beats storage beats env beats the default', () => {
    expect(resolveBetaUi(true, false, false)).toBe(true);
    expect(resolveBetaUi(false, true, true)).toBe(false);
    expect(resolveBetaUi(null, true, false)).toBe(true);
    expect(resolveBetaUi(null, null, true)).toBe(true);
    expect(resolveBetaUi(null, null, null, true)).toBe(true);
  });
});
