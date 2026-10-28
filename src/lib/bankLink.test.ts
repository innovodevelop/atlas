import { describe, expect, test } from 'bun:test';
import {
  balanceAfterImport, consentDaysLeft, filterInstitutions, importSummary, keyProblems, linkLine, linkStatus, storeRows, syncDue,
} from './bankLink';
import type { BankLinkRow } from './bankLedger';
import type { ParsedTx } from './bankCsv';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const link = (over: Partial<BankLinkRow> = {}): BankLinkRow => ({
  id: 'r', institution_id: 'DANSKEBANK_DABADKKK', institution_name: 'Danske Bank', status: 'LN',
  linked_at: '2026-10-01T10:00:00.000Z', expires_at: '2026-12-30T10:00:00.000Z', last_synced_at: '2026-10-28T06:00:00.000Z', last_error: null,
  ...over,
});

describe('link status', () => {
  test('codes read as words with a tone', () => {
    expect(linkStatus('LN')).toEqual({ label: 'Connected', tone: 'ok' });
    expect(linkStatus('EX').tone).toBe('dead');
    expect(linkStatus('CR').tone).toBe('waiting');
    expect(linkStatus('ZZ').label).toBe('GoCardless says ZZ');
  });
  test('consent days and the daily read', () => {
    expect(consentDaysLeft(link(), NOW)).toBe(63);
    expect(consentDaysLeft(link({ expires_at: null }), NOW)).toBeNull();
    expect(syncDue(link(), NOW)).toBe(false);
    expect(syncDue(link({ last_synced_at: '2026-10-27T11:00:00.000Z' }), NOW)).toBe(true);
    expect(syncDue(link({ last_synced_at: null }), NOW)).toBe(true);
    expect(syncDue(link({ status: 'EX', last_synced_at: null }), NOW)).toBe(false);
  });
  test('the line under a link', () => {
    expect(linkLine(link(), NOW, () => 'today')).toBe('Read today · consent for 63 more days');
    expect(linkLine(link({ expires_at: '2026-11-01T12:00:00.000Z', last_synced_at: null }), NOW, () => '')).toBe('Not read yet · consent ends in 4 days');
    expect(linkLine(link({ status: 'RJ' }), NOW, () => '')).toBe('The bank refused the consent');
  });
});

describe('keys and institutions', () => {
  test('the key form says what is missing', () => {
    expect(keyProblems('', '')).toEqual(['Paste the secret ID.', 'Paste the secret key.']);
    expect(keyProblems('abc def', 'k')).toEqual(['The secret ID has a space in it.']);
    expect(keyProblems(' id ', ' key ')).toEqual([]);
  });
  test('institutions filter by name or BIC', () => {
    const list = [{ name: 'Danske Bank', bic: 'DABADKKK' }, { name: 'Nordea', bic: 'NDEADKKK' }, { name: 'Lunar', bic: null }];
    expect(filterInstitutions(list, 'nordea').map((i) => i.name)).toEqual(['Nordea']);
    expect(filterInstitutions(list, 'dabadk').map((i) => i.name)).toEqual(['Danske Bank']);
    expect(filterInstitutions(list, '  ')).toHaveLength(3);
  });
});

describe('the import step', () => {
  const txs: ParsedTx[] = [
    { booked_on: '2026-10-01', amount: -45, text: 'Netto', balance_after: 955, currency: null },
    { booked_on: '2026-10-02', amount: -45, text: 'Netto', balance_after: 910, currency: 'EUR' },
  ];
  test('rows carry stable ids and the account currency where the file named none', () => {
    const rows = storeRows('acct', txs, 'DKK');
    expect(rows.map((r) => r.currency)).toEqual(['DKK', 'EUR']);
    expect(rows[0].id).toMatch(/^csv-/);
    expect(storeRows('acct', txs, 'DKK')[0].id).toBe(rows[0].id);
    expect(storeRows('other', txs, 'DKK')[0].id).not.toBe(rows[0].id);
  });
  test('an older export never rolls a balance back', () => {
    expect(balanceAfterImport({ balance: null, balance_at: null }, txs)).toEqual({ balance: 910, balance_at: '2026-10-02' });
    expect(balanceAfterImport({ balance: 1200, balance_at: '2026-10-20T00:00:00Z' }, txs)).toBeNull();
    expect(balanceAfterImport({ balance: null, balance_at: null }, [{ ...txs[0], balance_after: null }])).toBeNull();
  });
  test('the summary says what happened', () => {
    expect(importSummary({ inserted: 1, skipped: 0, rejected: 0 })).toBe('1 new transaction.');
    expect(importSummary({ inserted: 3, skipped: 12, rejected: 1 })).toBe('3 new transactions, 12 already here, 1 row without a date or amount left out.');
  });
});
