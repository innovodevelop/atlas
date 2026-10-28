import { describe, expect, test } from 'bun:test';
import { TIERS, tierById } from './mocks/modelLab';
import {
  NOTHING_INVOKED, compareRows, dayLabel, detailOf, factsOf, formatMs, formatTokens, invokedOn, isBad, laneFacts, laneName,
  laneStatus, latencyOf, namedOn, profileLabel, providerLabel, substitutedCount, tagOf, usageByProvider,
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

describe('usageByProvider', () => {
  test('nothing recorded is an empty list, not a zero line', () => {
    expect(usageByProvider([])).toEqual({ lines: [], days: 0, calls: 0, tokens: 0, cost: 0 });
  });
  test('sums per provider across days, largest first', () => {
    const s = usageByProvider([
      { date: '2026-10-01', provider: 'anthropic', total_calls: 10, estimated_cost: 1.5, tokens_used: 3000 },
      { date: '2026-10-02', provider: 'anthropic', total_calls: 5, estimated_cost: 0.5, tokens_used: 1000 },
      { date: '2026-10-02', provider: 'perplexity', total_calls: 2, estimated_cost: 0.2, tokens_used: 1000 },
    ]);
    expect(s.days).toBe(2);
    expect(s.tokens).toBe(5000);
    expect(s.lines.map((l) => l.provider)).toEqual(['anthropic', 'perplexity']);
    expect(s.lines[0]).toMatchObject({ calls: 15, tokens: 4000, share: 0.8, value: '4.0k tok · $2.00' });
  });
  test('falls back to calls when no tokens were recorded, and tolerates nulls', () => {
    const s = usageByProvider([
      { date: 'd', provider: 'openai', total_calls: 3, estimated_cost: null, tokens_used: null },
      { date: 'd', provider: 'jina', total_calls: 1, estimated_cost: 0, tokens_used: 0 },
    ]);
    expect(s.lines[0]).toMatchObject({ provider: 'openai', share: 0.75, value: '3 calls · $0.00' });
    expect(s.lines[1].value).toBe('1 call · $0.00');
  });
});

describe('readings', () => {
  test('latency is stated only where a row can exist', () => {
    expect(latencyOf('bedrock', [])).toMatch(/^not recordable/);
    expect(latencyOf('anthropic', [])).toBe('not recorded');
    expect(latencyOf('anthropic', [{ provider: 'anthropic', total_calls: 43, successful_calls: 41, avg_response_time_ms: 820 }])).toBe('820 ms avg · 41/43 ok');
    expect(latencyOf('anthropic', [{ provider: 'anthropic', total_calls: 0, successful_calls: 0, avg_response_time_ms: null }])).toBe('not recorded');
  });
  test('the status pill never says "no key" when it cannot see', () => {
    const base = { available: true, loading: false, keyPresent: true, selected: false, brainRunning: true };
    expect(laneStatus({ ...base, available: false }).text).toBe('Desktop app only');
    expect(laneStatus({ ...base, loading: true }).tone).toBe('syncing');
    expect(laneStatus({ ...base, selected: true })).toEqual({ text: 'Live · key present', tone: 'ready' });
    expect(laneStatus({ ...base, selected: true, brainRunning: false }).tone).toBe('failed');
    expect(laneStatus({ ...base, selected: true, keyPresent: false }).text).toBe('Selected · no key');
    expect(laneStatus({ ...base, keyPresent: null }).text).toBe('Key unknown');
    expect(laneStatus({ ...base, keyPresent: false }).text).toBe('No key');
  });
  test('lane facts come from the gateway transcription', () => {
    const f = laneFacts('bedrock', 'x');
    expect(f.map((r) => r.k)).toEqual(['Host', 'Auth', 'Streaming', 'Switch', 'Latency']);
    expect(f[0].v).toBe('bedrock-runtime.eu-central-1.amazonaws.com');
    expect(laneFacts('anthropic', 'x')[3]).toEqual({ k: 'Max tokens', v: '4096 blocking · 16000 streaming' });
  });
});
