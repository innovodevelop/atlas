import { describe, expect, test } from 'bun:test';
import { FIXTURE_VITALS, batteryTone, deviceKinds } from './systemVitals';

describe('system vitals helpers', () => {
  test('one glyph per device kind, AirPods counted as headphones even without a type', () => {
    const kinds = deviceKinds({
      on: true,
      connected: [
        { name: 'AirPods Pro', kind: null, battery_percent: 80 },
        { name: 'Magic Keyboard', kind: 'Keyboard', battery_percent: 62 },
        { name: 'Other Keyboard', kind: 'Keyboard', battery_percent: null },
        { name: 'Magic Trackpad', kind: 'Trackpad', battery_percent: null },
        { name: 'Thing', kind: 'Gamepad', battery_percent: null },
      ],
    });
    expect([...kinds].sort()).toEqual(['headphones', 'keyboard', 'other', 'trackpad']);
    expect(deviceKinds(null).size).toBe(0);
    expect(deviceKinds({ on: false, connected: [] }).size).toBe(0);
  });

  test('battery tone', () => {
    expect(batteryTone(null)).toBe('none');
    expect(batteryTone({ percent: 12, charging: false, on_power: false, remaining: null })).toBe('low');
    expect(batteryTone({ percent: 12, charging: false, on_power: true, remaining: null })).toBe('normal');
    expect(batteryTone({ percent: 12, charging: true, on_power: true, remaining: null })).toBe('charging');
    expect(batteryTone(FIXTURE_VITALS.battery)).toBe('normal');
  });
});
