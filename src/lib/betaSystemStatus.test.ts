import { afterEach, describe, expect, test } from 'bun:test';
import {
  MAX_SAMPLE_AGE_MS, PROBE_HISTORY_KEY, _resetProbeHistory, agoText, barsOf, batteryColour, batteryState, bytesText, countToday, deviceIcon, deviceLine,
  eventTime, getProbeHistory, homeAssistantService, latencyText, macLine, mailService, modelCallsTile, parseHistory, probeTime, pushSample, recentEvents,
  recordProbe, ringOffset, serviceDesc, serviceDown, serviceMeta, sphereStateFor, storageBars, subscribeProbeHistory, summarise, uptimeText,
  valueText, versionMessage, versionUptime, withRoundTrip, type MailAccountRow, type ProbeService, type StorageReport,
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
    expect(s.sub).toContain('Voice: HTTP 000.');
  });
  test('counts when several fail', () => {
    const i = { checking: false, loading: false, error: null, services: [down('atlas-brain'), down('voice-gateway')], unresolvedErrors: 0 };
    expect(summarise(i).headline).toBe('2 services need a look.');
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
  test('the AI provider is one bar per probe, however many polls repeat it from the brain’s cache', () => {
    const probedAt = Date.parse('2026-10-28T09:00:00Z');
    const ai = (latency_ms: number, last_check: string, cached: boolean): ProbeService =>
      ({ name: 'ai-provider', status: 'healthy', latency_ms, last_check, detail: 'Claude first-party · key accepted', cached });
    // The probe runs in the first poll and arrives a few ms after it finished…
    recordProbe([ok('atlas-brain', 5), ai(300, '2026-10-28T09:00:00Z', false)], probedAt + 20);
    // …and the next polls carry the same probe from the cache.
    recordProbe([ok('atlas-brain', 6), ai(300, '2026-10-28T09:00:00Z', true)], probedAt + 10_020);
    recordProbe([ok('atlas-brain', 7), ai(300, '2026-10-28T09:00:00Z', true)], probedAt + 20_020);
    expect(getProbeHistory()['ai-provider']).toEqual([{ at: probedAt, latency: 300, ok: true }]);
    expect(getProbeHistory()['atlas-brain'].length).toBe(3);
    // A minute later the brain probes again: a second bar.
    recordProbe([ok('atlas-brain', 8), ai(280, '2026-10-28T09:01:00Z', false)], probedAt + 60_030);
    expect(getProbeHistory()['ai-provider'].map((s) => s.latency)).toEqual([300, 280]);
  });
  test('a cached answer seen first is keyed on its probe time, and recorded once', () => {
    const cached: ProbeService = { name: 'ai-provider', status: 'healthy', latency_ms: 300, last_check: '2026-10-28T09:00:00Z', cached: true };
    recordProbe([cached], Date.parse('2026-10-28T09:00:30Z'));
    recordProbe([cached], Date.parse('2026-10-28T09:00:40Z'));
    expect(getProbeHistory()['ai-provider']).toEqual([{ at: Date.parse('2026-10-28T09:00:00Z'), latency: 300, ok: true }]);
    expect(probeTime({ ...cached, last_check: 'not a date' }, 42)).toBe(42);
    expect(probeTime(ok('atlas-brain'), 42)).toBe(42);
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
  test('the Model calls tile reads today from the brain’s ledger, and says why it has no number', () => {
    expect(modelCallsTile(false, null, null)).toEqual({ v: '—', d: 'Only in the Mac app' });
    expect(modelCallsTile(true, null, null).d).toBe('Reading…');
    expect(modelCallsTile(true, null, 'boom').d).toBe('The brain’s ledger is unreadable');
    expect(modelCallsTile(true, { today: { since: 'x', calls: 0, failed: 0 }, recording_since: null }, null)).toEqual({ v: '0', d: 'none yet · the brain records every call' });
    expect(modelCallsTile(true, { today: { since: 'x', calls: 1284, failed: 3 }, recording_since: 'y' }, null)).toEqual({ v: (1284).toLocaleString(), d: '3 failed · since midnight' });
    expect(modelCallsTile(true, { today: { since: 'x', calls: 2, failed: 0 }, recording_since: 'y' }, null).d).toBe('none failed · since midnight');
  });
});

describe('on this Mac', () => {
  const report = (over: Partial<StorageReport> = {}): StorageReport => ({
    database: { bytes: 600_000_000, wal_bytes: 4_000_000 },
    parts: { memory: 412_000_000, mail: 120_000_000, audit: 88_000_000, other: 1_000 },
    parts_error: null,
    models: { bytes: 1_900_000_000, source: 'build' },
    measured_at: '2026-10-28T09:00:00.000Z',
    ...over,
  });
  test('bytes read as Finder counts them', () => {
    expect(bytesText(0)).toBe('0 MB');
    expect(bytesText(300_000)).toBe('0.3 MB');
    expect(bytesText(412_400_000)).toBe('412 MB');
    expect(bytesText(1_900_000_000)).toBe('1.9 GB');
  });
  test('atlas.db, then the design’s rows, widths against the largest', () => {
    const bars = storageBars(report());
    expect(bars.map((b) => b.k)).toEqual(['atlas.db', 'Memory', 'Audit trail', 'Mail cache', 'Models on device']);
    expect(bars.map((b) => b.v)).toEqual(['600 MB', '412 MB', '88 MB', '120 MB', '1.9 GB']);
    expect(bars[4].w).toBe('100%');
    expect(bars[0].w).toBe('32%');
    // Model files, wherever they were counted; the sidecars only carry them.
    expect(bars[4].title).toContain('model files, as counted when this build was made');
    expect(storageBars(report({ models: { bytes: 1, source: 'checkout' } }))[4].title).toContain('model files of this checkout');
  });
  test('a figure that could not be measured is left out, not drawn as zero', () => {
    const bars = storageBars(report({ parts: null, parts_error: 'no such table: dbstat', models: null }));
    expect(bars.map((b) => b.k)).toEqual(['atlas.db']);
    expect(bars[0].w).toBe('100%');
    expect(storageBars(report({ parts: { memory: 1, mail: 0, audit: 0, other: 0 } }))[3].w).toBe('2%');
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
  test('installs and updates are events, newest first', () => {
    const events = recentEvents([], [], [], NOW, 8, [
      { version: '0.9.3', previous_version: '0.9.2', first_seen_at: new Date(2026, 9, 28, 6, 2).toISOString() },
      { version: '0.9.2', previous_version: null, first_seen_at: new Date(2026, 9, 1, 10, 0).toISOString() },
    ]);
    expect(events.map((e) => [e.kind, e.t, e.m])).toEqual([
      ['update', '06:02', 'Atlas 0.9.3 installed · was 0.9.2'],
      ['update', events[1].t, 'Atlas 0.9.2 · first launch on record'],
    ]);
    expect(versionMessage({ version: '1.0.0', previous_version: '1.1.0', first_seen_at: 'x' })).toBe('Atlas 1.0.0 installed · was 1.1.0');
  });
  test('respects the limit', () => {
    const calls = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, tool_name: 'x', status: 'completed', created_at: new Date(2026, 9, 28, 1, i).toISOString() }));
    expect(recentEvents([], calls, [], NOW).length).toBe(8);
  });
});

describe('uptime since the last update', () => {
  const history = (rows: Array<[string, string | null, Date]>) => ({ bundle_id: 'com.x', version: rows[0]?.[0] ?? '1.0.0', history: rows.map(([version, previous_version, at]) => ({ version, previous_version, first_seen_at: at.toISOString() })) });
  test('counts from when this version first ran', () => {
    const u = versionUptime(history([['0.9.3', '0.9.2', new Date(2026, 9, 14, 9, 42)]]), NOW);
    expect(u?.seconds).toBe(14 * 86_400);
    expect(uptimeText(u!.seconds)).toBe('14 days');
    expect(u?.d).toBe('since the update to 0.9.3');
    expect(versionUptime(history([['0.9.2', null, new Date(2026, 9, 28, 9, 0)]]), NOW)?.d).toBe('on 0.9.2 · since its first launch on record');
  });
  test('nothing recorded for the running version is no figure', () => {
    expect(versionUptime(null, NOW)).toBeNull();
    expect(versionUptime({ bundle_id: 'com.x', version: '1.0.0', history: [] }, NOW)).toBeNull();
    expect(versionUptime({ ...history([['0.9.2', null, NOW]]), version: '0.9.3' }, NOW)).toBeNull();
  });
});

describe('local services', () => {
  const acct = (over: Partial<MailAccountRow> = {}): MailAccountRow => ({ email_address: 'me@example.com', provider: 'gmail', status: 'active', last_error: null, last_synced_at: new Date(2026, 9, 28, 9, 41).toISOString(), ...over });
  test('mail reads the sync’s own record', () => {
    const okRow = mailService([acct(), acct({ email_address: 'b@example.com', last_synced_at: null })], NOW);
    expect(okRow).toMatchObject({ name: 'mail', status: 'healthy', value: 'OK', detail: '2 accounts · last fetch 1 min ago' });
    expect(valueText(okRow)).toBe('OK');
    const failing = mailService([acct(), acct({ email_address: 'b@example.com', status: 'error', last_error: 'token expired' })], NOW);
    expect(failing).toMatchObject({ status: 'degraded', value: '1 failing', error: 'token expired' });
    expect(failing.detail).toBe('1 of 2 accounts failing · b@example.com: token expired');
    expect(serviceDown(failing)).toBe(true);
    expect(summarise({ checking: false, loading: false, error: null, services: [ok('atlas-brain'), failing], unresolvedErrors: 0 }).headline).toBe('Mail needs a look. Everything else is fine.');
  });
  test('no mailbox is nothing to check, never an outage', () => {
    const none = mailService([], NOW);
    expect(none).toMatchObject({ idle: true, detail: 'No mailbox connected' });
    expect(serviceDown(none)).toBe(false);
    expect(valueText(none)).toBe('off');
    expect(mailService([acct({ status: 'disconnected' })], NOW).detail).toContain('disconnected');
  });
  test('Home Assistant: timed when it answers, named when it does not', () => {
    expect(homeAssistantService({ linked: false }, NOW)).toMatchObject({ idle: true, value: 'off' });
    const up = homeAssistantService({ linked: true, name: 'Home', devices: 24, ok: true, latency_ms: 12, error: null }, NOW);
    expect(up).toMatchObject({ status: 'healthy', latency_ms: 12, detail: '24 devices · Home · local network' });
    expect(valueText(up)).toBe('12 ms');
    const down = homeAssistantService({ linked: true, name: 'Home', devices: 1, ok: false, latency_ms: null, error: 'not reachable (Dns Failed)' }, NOW);
    expect(down.status).toBe('down');
    expect(serviceDesc(down)).toBe('1 device · Home · not reachable (Dns Failed)');
    expect(valueText(down)).toBe('down');
  });
  test('the AI provider row brings its own sentence; a cached probe is not taken out of the round trip', () => {
    const ai: ProbeService = { name: 'ai-provider', status: 'healthy', latency_ms: 300, last_check: 'x', detail: 'Claude first-party · key accepted', cached: true };
    expect(serviceMeta('ai-provider').label).toBe('Reasoning');
    expect(serviceDesc(ai)).toBe('Claude first-party · key accepted');
    expect(withRoundTrip([ok('atlas-brain', 0), ai], 400)[0].latency_ms).toBe(400);
    expect(withRoundTrip([ok('atlas-brain', 0), { ...ai, cached: false }], 400)[0].latency_ms).toBe(100);
  });
  test('a provider probe that timed out in this request does not land on the brain', () => {
    // providerProbe.ts's row for a probe that waited out its 5 s: down, with the wait as its latency.
    const timedOut: ProbeService = {
      name: 'ai-provider', status: 'down', latency_ms: 5003, last_check: '2026-10-28T09:00:05Z',
      error: 'The operation timed out.', detail: 'No answer within 5 s', cached: false,
    };
    const out = withRoundTrip([ok('atlas-brain', 0), ok('voice-gateway', 4), timedOut], 5019);
    expect(out[0].latency_ms).toBe(12);
    expect(valueText(out[0])).toBe('12 ms');
    expect(valueText(out[2])).toBe('down');
  });
  test('ago', () => {
    expect(agoText(null, NOW)).toBe('never');
    expect(agoText(new Date(2026, 9, 28, 9, 41, 50).toISOString(), NOW)).toBe('now');
    expect(agoText(new Date(2026, 9, 28, 6, 0).toISOString(), NOW)).toBe('3 h ago');
    expect(agoText(new Date(2026, 9, 26, 9, 0).toISOString(), NOW)).toBe('2 days ago');
  });
});

describe('probe history survives a reload', () => {
  afterEach(() => _resetProbeHistory());
  const memoryStore = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
  };
  test('what is recorded is saved, and a fresh store reads it back', () => {
    const store = memoryStore();
    _resetProbeHistory(store);
    const now = Date.now();
    recordProbe([ok('atlas-brain', 40)], now - 2000);
    recordProbe([ok('atlas-brain', 50)], now - 1000);
    expect(JSON.parse(store.m.get(PROBE_HISTORY_KEY)!)['atlas-brain'].length).toBe(2);
    _resetProbeHistory(store);
    expect(getProbeHistory()['atlas-brain'].map((s) => s.latency)).toEqual([40, 50]);
    // The saved newest bar still guards against an older answer slipping in.
    recordProbe([ok('atlas-brain', 99)], now - 1500);
    expect(getProbeHistory()['atlas-brain'].length).toBe(2);
  });
  test('services keep their own clocks, and an idle row records nothing', () => {
    _resetProbeHistory(memoryStore());
    recordProbe([ok('atlas-brain')], 5000);
    recordProbe([ok('home-assistant', 12)], 4000);
    recordProbe([mailService([], NOW)], 6000);
    expect(Object.keys(getProbeHistory()).sort()).toEqual(['atlas-brain', 'home-assistant']);
  });
  test('saved history is checked: malformed, stale and excess samples are dropped', () => {
    const now = 10 * MAX_SAMPLE_AGE_MS;
    expect(parseHistory('not json', now)).toEqual({});
    expect(parseHistory('[1,2]', now)).toEqual({});
    const raw = JSON.stringify({
      a: [{ at: now - MAX_SAMPLE_AGE_MS - 1, latency: 1, ok: true }, { at: now - 5, latency: 'x', ok: true }, { at: now - 1, latency: null, ok: false }],
      b: Array.from({ length: 20 }, (_, i) => ({ at: now - 100 + i, latency: i, ok: true })),
      c: 'nope',
    });
    const h = parseHistory(raw, now);
    expect(h.a).toEqual([{ at: now - 1, latency: null, ok: false }]);
    expect(h.b.length).toBe(12);
    expect(h.b[11].latency).toBe(19);
    expect(h.c).toBeUndefined();
  });
});
