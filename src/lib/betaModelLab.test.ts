import { describe, expect, test } from 'bun:test';
import { TIERS, tierById } from './mocks/modelLab';
import {
  NOTHING_INVOKED, UNUSED_COLOUR, compareRows, dayLabel, detailOf, factsOf, formatMs, formatTokens, gatewayLaneLabel, invokedOn, isBad, laneFacts,
  laneModels, laneName, laneStatus, latencyFact, latencyLines, namedOn, profileLabel, providerLabel, runningLaneOf, substitutedCount, switchPlan,
  tagOf, usageByModel, type ModelCallsSummary, type ModelUsage,
} from './betaModelLab';

const tier = (id: string) => {
  const t = tierById(id);
  if (!t) throw new Error(`no tier ${id}`);
  return t;
};

describe('lanes', () => {
  test('the Bedrock name carries the region from the host', () => {
    expect(laneName('bedrock')).toBe('Bedrock (eu-central-1)');
    expect(laneName('anthropic')).toBe('First-party');
  });
  test('first-party passes every tier through unchanged', () => {
    for (const t of TIERS) {
      expect(tagOf(t, 'anthropic')).toEqual({ label: 'Unchanged', tone: 'ok' });
      expect(isBad(t, 'anthropic')).toBe(false);
      expect(namedOn(t, 'anthropic')).toBe(t.id);
      expect(invokedOn(t, 'anthropic')).toBe(t.firstParty.model);
    }
    expect(substitutedCount('anthropic')).toBe(0);
  });
  test('Bedrock tags follow the transcription', () => {
    expect(tagOf(tier('claude-haiku-4-5'), 'bedrock').label).toBe('Entitled');
    expect(tagOf(tier('claude-sonnet-5'), 'bedrock').label).toBe('Substituted');
    expect(tagOf(tier('claude-fable-5'), 'bedrock')).toEqual({ label: 'Unmapped', tone: 'unmapped' });
    expect(invokedOn(tier('claude-fable-5'), 'bedrock')).toBe(NOTHING_INVOKED);
    // Sonnet 5, Opus 4.8, Opus 5 substituted; Fable 5 unmapped.
    expect(substitutedCount('bedrock')).toBe(TIERS.filter((t) => t.bedrock.substituted || t.bedrock.profile === null).length);
    expect(substitutedCount('bedrock')).toBe(4);
  });
});

describe('profileLabel', () => {
  test('reads ids the way a person says them', () => {
    expect(profileLabel('eu.anthropic.claude-opus-4-6-v1')).toBe('Opus 4.6');
    expect(profileLabel('eu.anthropic.claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(profileLabel('eu.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5');
    expect(profileLabel('claude-opus-5')).toBe('Opus 5');
  });
  test('never reads a date stamp as a minor version', () => {
    expect(profileLabel('claude-sonnet-4-20250514')).toBe('Sonnet 4');
  });
  test('falls back to the id, and names nothing as nothing', () => {
    expect(profileLabel('gpt-x')).toBe('gpt-x');
    expect(profileLabel(null)).toBe('nothing');
  });
});

describe('detailOf and factsOf', () => {
  test('a substitution is the headline', () => {
    const d = detailOf(tier('claude-opus-5'), 'bedrock');
    expect(d.kicker).toBe('Substituted on Bedrock');
    expect(d.headline).toBe('Asking for Opus 5 runs Opus 4.6.');
    expect(d.bad).toBe(true);
    expect(d.named).toBe('eu.anthropic.claude-opus-5');
  });
  test('first-party and unmapped read honestly', () => {
    expect(detailOf(tier('claude-sonnet-5'), 'anthropic').headline).toBe('Passed through unchanged. Sonnet 5 is Sonnet 5.');
    expect(detailOf(tier('claude-fable-5'), 'bedrock').headline).toBe('Fable 5 has no Bedrock profile Atlas will call.');
    expect(detailOf(tier('claude-haiku-4-5'), 'bedrock').bad).toBe(false);
  });
  test('the first-party note says what Bedrock would do, without pointing at a panel', () => {
    expect(detailOf(tier('claude-sonnet-5'), 'anthropic').note).toBe('Passed through unchanged. Bedrock would run Sonnet 4.6 instead.');
    expect(detailOf(tier('claude-haiku-4-5'), 'anthropic').note).toBe('Passed through unchanged. Bedrock runs the same model.');
    expect(detailOf(tier('claude-fable-5'), 'anthropic').note).toBe('Passed through unchanged. Bedrock has no profile Atlas will call for it.');
  });
  test('facts flag only a missing entitlement', () => {
    const facts = factsOf(tier('claude-sonnet-5'));
    expect(facts).toHaveLength(10);
    expect(facts.find((f) => f.k === 'Entitlement')).toMatchObject({ v: 'not entitled · substituted', warn: true });
    expect(facts.find((f) => f.k === 'First-party')?.v).toBe('claude-sonnet-5 · Passed through unchanged');
    expect(factsOf(tier('claude-haiku-4-5')).some((f) => f.warn)).toBe(false);
    expect(factsOf(tier('claude-sonnet-5')).find((f) => f.k === 'Band')?.v).toBe('balanced · default tier');
  });
});

describe('compareRows', () => {
  test('one cell per tier, warnings only where the name is not the model', () => {
    const rows = compareRows('bedrock');
    for (const r of rows) expect(r.cells).toHaveLength(TIERS.length);
    const ent = rows.find((r) => r.k === 'Entitlement');
    expect(ent?.cells.map((c) => c.v)).toEqual(TIERS.map((t) => (t.bedrock.requestedState === 'invocable' ? 'entitled' : t.bedrock.profile === null ? 'unmapped' : 'substituted')));
    expect(ent?.cells.filter((c) => c.warn)).toHaveLength(4);
  });
  test('Bedrock-only rows are n/a on first-party', () => {
    const rows = compareRows('anthropic');
    expect(rows.find((r) => r.k === 'Entitlement')?.cells.every((c) => c.v === 'n/a' && !c.warn)).toBe(true);
    expect(rows.find((r) => r.k === 'Geography')?.cells.every((c) => c.v === 'n/a')).toBe(true);
  });
});

describe('formats', () => {
  test('dates without a time zone', () => {
    expect(dayLabel('2026-07-28')).toBe('28 Jul 2026');
    expect(dayLabel('2026-07-30', false)).toBe('30 Jul');
    expect(dayLabel('soon')).toBe('soon');
  });
  test('tokens and milliseconds', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(25_000)).toBe('25k');
    expect(formatTokens(11_400_000)).toBe('11.4M');
    expect(formatMs(820)).toBe('820 ms');
    expect(formatMs(1840)).toBe('1.8 s');
  });
  test('provider names', () => {
    expect(providerLabel('lovable_ai')).toBe('Lovable AI');
    expect(providerLabel('some_new_thing')).toBe('Some New Thing');
  });
});

const usage = (over: Partial<ModelUsage>): ModelUsage => ({
  model: 'claude-sonnet-5', provider: 'anthropic', calls: 1, failed: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: null, unpriced_calls: 0, ...over,
});

const summaryOf = (over: Partial<ModelCallsSummary>): ModelCallsSummary => ({
  days: 30, since: '2026-09-28T00:00:00.000Z', prices_as_of: '2026-10-06', running_lane: 'anthropic', recording_since: '2026-10-01T00:00:00.000Z',
  today: { since: '2026-10-28T00:00:00.000Z', calls: 0, failed: 0 },
  total: { calls: 0, failed: 0, tokens: 0, cost_usd: null, unpriced_calls: 0 },
  models: [], lanes: [], ...over,
});

describe('usageByModel', () => {
  test('nothing recorded is an empty list with no cost, not a zero line', () => {
    expect(usageByModel(null)).toEqual({ lines: [], calls: 0, tokens: 0, cost: null, unpricedCalls: 0 });
  });
  test('one line per model as a person says it; first-party and Bedrock of one model share it', () => {
    const s = usageByModel(summaryOf({
      models: [
        usage({ model: 'claude-haiku-4-5', calls: 10, input_tokens: 9_000_000, output_tokens: 2_400_000, cost_usd: 4.1 }),
        usage({ model: 'eu.anthropic.claude-sonnet-4-6', provider: 'bedrock', calls: 4, input_tokens: 5_000_000, output_tokens: 700_000, cost_usd: 24.3 }),
        usage({ model: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', provider: 'bedrock', calls: 2, input_tokens: 0, output_tokens: 0, cost_usd: null, unpriced_calls: 2 }),
      ],
      total: { calls: 16, failed: 0, tokens: 17_100_000, cost_usd: 28.4, unpriced_calls: 2 },
    }));
    expect(s.lines.map((l) => l.label)).toEqual(['Haiku 4.5', 'Sonnet 4.6']);
    expect(s.lines[0]).toMatchObject({ calls: 12, tokens: 11_400_000, value: '11.4M tok · $4.10' });
    expect(s.lines[1].value).toBe('5.7M tok · $24.30');
    expect(s.cost).toBeCloseTo(28.4, 10);
    expect(s.unpricedCalls).toBe(2);
    expect(s.lines[0].share + s.lines[1].share).toBeCloseTo(1, 10);
  });
  test('an unpriced model says so instead of $0.00, and tiers never called are listed last', () => {
    const s = usageByModel(summaryOf({ models: [usage({ model: 'gemini-2.5-flash', calls: 3 })] }), ['claude-fable-5', 'claude-sonnet-5']);
    expect(s.lines[0]).toMatchObject({ label: 'gemini-2.5-flash', value: '3 calls · no price', share: 1 });
    expect(s.lines.slice(1).map((l) => [l.label, l.value, l.colour])).toEqual([
      ['Fable 5', 'not called', UNUSED_COLOUR],
      ['Sonnet 5', 'not called', UNUSED_COLOUR],
    ]);
    expect(s.cost).toBeNull();
  });
  test('the lane tiers come from the transcription; an unmapped Bedrock tier invokes nothing', () => {
    expect(laneModels('anthropic').length).toBe(TIERS.length);
    expect(laneModels('bedrock').length).toBe(TIERS.filter((t) => t.bedrock.profile !== null).length);
  });
});

describe('latency', () => {
  const lanes = [
    { lane: 'bedrock', provider: 'bedrock', calls: 40, ok: 38, p50_ms: 900, p95_ms: 1800, last_at: null },
    { lane: 'bridge', provider: 'anthropic', calls: 3, ok: 3, p50_ms: 400, p95_ms: 600, last_at: null },
  ];
  test('p95 per lane against the slowest', () => {
    const l = latencyLines(summaryOf({ lanes }));
    expect(l.map((x) => x.label)).toEqual(['Bedrock', 'Bridge to first-party']);
    expect(l[0]).toMatchObject({ p95: '1.8 s', share: 1, detail: '40 calls · 2 failed · median 900 ms' });
    expect(l[1].share).toBeCloseTo(1 / 3, 5);
    expect(gatewayLaneLabel('something_new')).toBe('Something New');
  });
  test('the lane card states its own lane only, and says when nothing was called', () => {
    expect(latencyFact(null, 'bedrock')).toBe('not read yet');
    expect(latencyFact(summaryOf({ lanes }), 'bedrock')).toBe('1.8 s p95 · 40 calls');
    expect(latencyFact(summaryOf({ lanes }), 'anthropic')).toBe('no calls in the last 30 days');
    expect(latencyFact(summaryOf({ lanes: [{ ...lanes[0], ok: 0, p95_ms: null, p50_ms: null }] }), 'bedrock')).toBe('40 calls, none answered');
  });
  test('the running lane is the brain’s own answer', () => {
    expect(runningLaneOf(summaryOf({ running_lane: 'bedrock' }))).toBe('bedrock');
    expect(runningLaneOf(summaryOf({ running_lane: 'gemini' }))).toBeNull();
    expect(runningLaneOf(null)).toBeNull();
  });
});

describe('readings', () => {
  test('the status pill never says "no key" when it cannot see', () => {
    const base = { available: true, loading: false, keyPresent: true, selected: false, brainRunning: true };
    expect(laneStatus({ ...base, available: false }).text).toBe('Desktop app only');
    expect(laneStatus({ ...base, loading: true }).tone).toBe('syncing');
    expect(laneStatus({ ...base, selected: true })).toEqual({ text: 'Live · key present', tone: 'ready' });
    expect(laneStatus({ ...base, selected: true, running: true, p95Ms: 1840 })).toEqual({ text: 'Live · 1.8 s p95', tone: 'ready' });
    expect(laneStatus({ ...base, selected: true, brainRunning: false }).tone).toBe('failed');
    expect(laneStatus({ ...base, selected: true, keyPresent: false }).text).toBe('Selected · no key');
    expect(laneStatus({ ...base, keyPresent: null }).text).toBe('Key unknown');
    expect(laneStatus({ ...base, keyPresent: false }).text).toBe('No key');
  });
  test('between a switch and the restart, both lanes say so', () => {
    const base = { available: true, loading: false, keyPresent: true, brainRunning: true };
    expect(laneStatus({ ...base, selected: true, running: false })).toEqual({ text: 'Selected · from next start', tone: 'syncing' });
    expect(laneStatus({ ...base, selected: false, running: true })).toEqual({ text: 'Running until restart', tone: 'syncing' });
  });
  test('a switch says what leaves the Mac, and is refused without a key', () => {
    const toBedrock = switchPlan('bedrock', true);
    expect(toBedrock.allowed).toBe(true);
    expect(toBedrock.effect).toContain('bedrock-runtime.eu-central-1.amazonaws.com');
    expect(toBedrock.effect).toContain('From the next start');
    expect(switchPlan('anthropic', null).allowed).toBe(true);
    const noKey = switchPlan('bedrock', false);
    expect(noKey.allowed).toBe(false);
    expect(noKey.reason).toContain('AWS access key pair');
    expect(switchPlan('anthropic', false).reason).toContain('Anthropic API key');
  });
  test('lane facts come from the gateway transcription', () => {
    const f = laneFacts('bedrock', 'x');
    expect(f.map((r) => r.k)).toEqual(['Host', 'Auth', 'Streaming', 'Switch', 'Latency']);
    expect(f[0].v).toBe('bedrock-runtime.eu-central-1.amazonaws.com');
    expect(laneFacts('anthropic', 'x')[3]).toEqual({ k: 'Max tokens', v: '4096 blocking · 16000 streaming' });
  });
});
