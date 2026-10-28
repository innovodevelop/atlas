import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetProbeHistory, barsOf, batteryColour, batteryState, countToday, dayKey, deviceIcon, deviceLine, eventTime, getProbeHistory, latencyText, macLine,
  pushSample, recentEvents, recordProbe, ringOffset, serviceMeta, sphereStateFor, storageBars, subscribeProbeHistory, summarise, sumUsage,
  uptimeText, withRoundTrip, type ProbeService,
} from './betaSystemStatus';

const ok = (name: string, latency_ms: number | null = 12): ProbeService => ({ name, status: 'healthy', latency_ms, last_check: '2026-10-28T09:00:00Z' });
const down = (name: string, error = 'HTTP 000'): ProbeService => ({ name, status: 'down', latency_ms: null, last_check: '2026-10-28T09:00:00Z', error });
const NOW = new Date(2026, 9, 28, 9, 42, 0);

describe('headline and sphere', () => {
  test('working while checking, even with a failure on record', () => {
    const i = { checking: true, loading: false, error: null, services: [down('voice-gateway')], unresolvedErrors: 0 };
    expect(sphereStateFor(i)).toBe('working');
    expect(summarise(i).headline).toBe('Checking everything…');
  });
  test('success when every probe passes, and the sub mentions unresolved errors', () => {
    const i = { checking: false, loading: false, error: null, services: [ok('atlas-brain'), ok('voice-gateway')], unresolvedErrors: 2 };
    expect(sphereStateFor(i)).toBe('success');
    const s = summarise(i);
    expect(s.headline).toBe('Everything is working.');
    expect(s.sub).toContain('2 unresolved errors');
  });
  test('alert and the service named when one fails', () => {
    const i = { checking: false, loading: false, error: null, services: [ok('atlas-brain'), down('voice-gateway')], unresolvedErrors: 0 };
    expect(sphereStateFor(i)).toBe('alert');
    const s = summarise(i);
    expect(s.headline).toBe("Voice isn't answering. Everything else is fine.");
    expect(s.sub).toContain('answered HTTP 000');
  });
  test('counts when several fail', () => {
    const i = { checking: false, loading: false, error: null, services: [down('atlas-brain'), down('voice-gateway')], unresolvedErrors: 0 };
    expect(summarise(i).headline).toBe("2 services aren't answering.");
  });
  test('an unreachable brain is an alert with its message', () => {
    const i = { checking: false, loading: false, error: 'Atlas brain is not running', services: null, unresolvedErrors: 0 };
    expect(sphereStateFor(i)).toBe('alert');
    expect(summarise(i).sub.startsWith('Atlas brain is not running.')).toBe(true);
  });
  test('a long error body is clipped to one sentence-sized line', () => {
    const i = { checking: false, loading: false, error: 'x'.repeat(400), services: null, unresolvedErrors: 0 };
    const { sub } = summarise(i);
    expect(sub.length).toBeLessThan(220);
    expect(sub).toContain('x.');
  });
  test('first load is working, not success', () => {
    expect(sphereStateFor({ checking: false, loading: true, error: null, services: null, unresolvedErrors: 0 })).toBe('working');
  });
});

describe('services', () => {
  test('the brain takes the measured round trip less the probes it ran inside it; others keep theirs', () => {
    const out = withRoundTrip([ok('atlas-brain', 0), ok('voice-gateway', 38)], 412);
    expect(out[0].latency_ms).toBe(374);
    expect(out[1].latency_ms).toBe(38);
    expect(withRoundTrip([ok('atlas-brain', 0), down('voice-gateway')], 50)[0].latency_ms).toBe(50);
    expect(withRoundTrip([ok('atlas-brain', 0), ok('voice-gateway', 90)], 80)[0].latency_ms).toBe(1);
    expect(withRoundTrip([ok('atlas-brain', 0)], null)[0].latency_ms).toBe(0);
  });
  test('labels', () => {
    expect(serviceMeta('atlas-brain').label).toBe('Brain');
    expect(serviceMeta('voice-gateway').label).toBe('Voice');
    expect(serviceMeta('other').label).toBe('other');
  });
});

describe('formats', () => {
  test('uptime', () => {
    expect(uptimeText(null)).toBe('—');
    expect(uptimeText(48)).toBe('48 s');
    expect(uptimeText(5 * 60)).toBe('5 m');
    expect(uptimeText(3 * 3600 + 12 * 60)).toBe('3 h 12 m');
    expect(uptimeText(86_400)).toBe('1 day');
    expect(uptimeText(14 * 86_400 + 100)).toBe('14 days');
  });
  test('latency', () => {
    expect(latencyText(412, true)).toBe('412 ms');
    expect(latencyText(1840, true)).toBe('1.8 s');
    expect(latencyText(null, true)).toBe('—');
    expect(latencyText(5, false)).toBe('down');
  });
});

describe('battery rings', () => {
  test('offset runs from full circumference at 0% to 0 at 100%', () => {
    expect(ringOffset(0)).toBe('144.5');
    expect(ringOffset(100)).toBe('0.0');
    expect(ringOffset(50)).toBe('72.3');
    expect(ringOffset(null)).toBe('144.5');
    expect(ringOffset(140)).toBe('0.0');
  });
  test('colour bands', () => {
    expect(batteryColour(74)).toBe('#0fae76');
    expect(batteryColour(61)).toBe('#3461f2');
    expect(batteryColour(42)).toBe('#e07a1f');
    expect(batteryColour(18)).toBe('#d0453a');
    expect(batteryColour(18, true)).toBe('#0fae76');
    expect(batteryColour(null)).toBe('#b6b1aa');
  });
  test('device glyphs and lines', () => {
    expect(deviceIcon('Headphones', 'AirPods Pro')).toBe('airpods');
    expect(deviceIcon(null, 'Beats Fit')).toBe('airpods');
    expect(deviceIcon('Keyboard', 'Magic Keyboard')).toBe('keyboard');
    expect(deviceIcon('Mouse', 'Magic Mouse')).toBe('trackpad');
    expect(deviceIcon(null, 'iPhone 16')).toBe('iphone');
    expect(deviceIcon('Gamepad', 'Controller')).toBe('bluetooth');
    expect(deviceLine('Headphones', 80)).toBe('80% · Headphones');
    expect(deviceLine(null, null)).toBe('Bluetooth · no battery reading');
    expect(macLine(null)).toBe('This Mac · no battery · mains power');
    expect(batteryState({ percent: 68, charging: false, on_power: true, remaining: null })).toBe('on power');
    expect(batteryState({ percent: 68, charging: false, on_power: false, remaining: null })).toBe('on battery');
    expect(macLine({ percent: 74, charging: true, on_power: true, remaining: null })).toBe('This Mac · 74% · charging');
    expect(macLine({ percent: 68, charging: false, on_power: false, remaining: '3:12 remaining' })).toBe('This Mac · 68% · 3:12 remaining');
  });
});

describe('sparklines', () => {
  test('pushSample keeps the newest twelve', () => {
    let list = [] as ReturnType<typeof pushSample>;
    for (let i = 0; i < 15; i++) list = pushSample(list, { at: i, latency: i, ok: true });
    expect(list.length).toBe(12);
    expect(list[0].at).toBe(3);
    expect(list[11].at).toBe(14);
  });
  test('barsOf pads empty slots on the left and scales to the peak', () => {
    const bars = barsOf([{ at: 1, latency: 50, ok: true }, { at: 2, latency: 100, ok: true }, { at: 3, latency: null, ok: false }]);
    expect(bars.length).toBe(12);
    expect(bars[0].h).toBeNull();
    expect(bars[9].h).toBe('50%');
    expect(bars[10].h).toBe('100%');
    expect(bars[11]).toEqual({ h: '95%', c: '#e07a1f' });
  });
  test('a tiny latency still shows a sliver', () => {
    expect(barsOf([{ at: 1, latency: 1, ok: true }, { at: 2, latency: 1000, ok: true }])[10].h).toBe('14%');
  });
});

describe('probe history store', () => {
  afterEach(() => _resetProbeHistory());
  test('records per service, notifies, and caps at twelve', () => {
    let ticks = 0;
    const off = subscribeProbeHistory(() => { ticks++; });
    for (let i = 0; i < 14; i++) recordProbe([ok('atlas-brain', i), down('voice-gateway')], 1000 + i);
    const h = getProbeHistory();
    expect(ticks).toBe(14);
    expect(h['atlas-brain'].length).toBe(12);
    expect(h['atlas-brain'][11]).toEqual({ at: 1013, latency: 13, ok: true });
    expect(h['voice-gateway'][0].ok).toBe(false);
    off();
    recordProbe([ok('atlas-brain')]);
    expect(ticks).toBe(14);
  });
  test('the same poll handed in twice is one bar, and an older poll is ignored', () => {
    let ticks = 0;
    subscribeProbeHistory(() => { ticks++; });
    recordProbe([ok('atlas-brain', 10)], 5000);
    recordProbe([ok('atlas-brain', 10)], 5000);
    recordProbe([ok('atlas-brain', 99)], 4000);
    expect(getProbeHistory()['atlas-brain'].length).toBe(1);
    expect(ticks).toBe(1);
    recordProbe([ok('atlas-brain', 20)], 6000);
    expect(getProbeHistory()['atlas-brain'].map((s) => s.latency)).toEqual([10, 20]);
  });
  test('each record is a new snapshot', () => {
    const a = getProbeHistory();
    recordProbe([ok('atlas-brain')]);
    expect(getProbeHistory()).not.toBe(a);
  });
});

describe('counters', () => {
  test('countToday keeps only the local day and drops bad dates', () => {
    const rows = [
      { created_at: new Date(2026, 9, 28, 0, 0, 1).toISOString() },
      { created_at: new Date(2026, 9, 27, 23, 59, 59).toISOString() },
      { created_at: 'nonsense' },
    ];
    expect(countToday(rows, NOW).length).toBe(1);
  });
  test('dayKey is local and zero-padded', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
  test('sumUsage adds across providers and is null without rows', () => {
    expect(sumUsage([])).toBeNull();
    expect(sumUsage([{ provider: 'anthropic', total_calls: 10, failed_calls: 1 }, { provider: 'bedrock', total_calls: 5, failed_calls: 0 }])).toEqual({ total: 15, failed: 1, providers: 2 });
  });
});

describe('storage bars', () => {
  test('fullest first, empty tables dropped, widths against the largest', () => {
    const bars = storageBars([{ name: 'ai_memory', rows: 50 }, { name: 'chat_turns', rows: 200 }, { name: 'runs', rows: 0 }]);
    expect(bars.map((b) => b.k)).toEqual(['chat turns', 'ai memory']);
    expect(bars[0].w).toBe('100%');
    expect(bars[1].w).toBe('25%');
    expect(bars[0].v).toBe('200 rows');
  });
  test('a sliver for the smallest', () => {
    expect(storageBars([{ name: 'a', rows: 10000 }, { name: 'b', rows: 1 }])[1].w).toBe('2%');
  });
});

describe('recently', () => {
  test('eventTime', () => {
    expect(eventTime(new Date(2026, 9, 28, 9, 5).toISOString(), NOW)).toBe('09:05');
    expect(eventTime(new Date(2026, 9, 27, 22, 0).toISOString(), NOW)).toBe('Yesterday');
    expect(eventTime('bad', NOW)).toBe('—');
  });
  test('merges newest first, colours by outcome, and only unresolved errors carry an id', () => {
    const events = recentEvents(
      [
        { id: 'e1', error_message: 'boom', severity: 'error', resolved: false, created_at: new Date(2026, 9, 28, 9, 0).toISOString() },
        { id: 'e2', error_message: 'old', severity: 'warning', resolved: true, created_at: new Date(2026, 9, 27, 9, 0).toISOString() },
      ],
      [{ id: 't1', tool_name: 'mail.archive', status: 'completed', created_at: new Date(2026, 9, 28, 9, 30).toISOString() }],
      [{ id: 'r1', status: 'verified', diagnosis: 'fixed it', created_at: new Date(2026, 9, 28, 9, 15).toISOString() }],
      NOW,
    );
    expect(events.map((e) => e.kind)).toEqual(['action', 'repair', 'error', 'error']);
    expect(events[0].m).toBe('mail.archive · completed');
    expect(events[1].c).toBe('#0fae76');
    expect(events[2].errorId).toBe('e1');
    expect(events[3].errorId).toBeUndefined();
    expect(events[3].c).toBe('#8b8681');
  });
  test('respects the limit', () => {
    const calls = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, tool_name: 'x', status: 'completed', created_at: new Date(2026, 9, 28, 1, i).toISOString() }));
    expect(recentEvents([], calls, [], NOW).length).toBe(8);
  });
});
