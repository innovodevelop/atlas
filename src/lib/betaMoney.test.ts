import { describe, expect, test } from 'bun:test';
import { EMPTY_BANK, dayLabel, flowAxis, initialsOf, money, moneyModel, pct, spendRows, totalSpent, type BankData } from './betaMoney';
import type { BankTxRow } from './bankLedger';

describe('formats', () => {
  test('money and percent', () => {
    expect(money(1234.5, 'USD')).toMatch(/1,?235|1\.235|1 235/);
    expect(money(12.345, 'EUR', 2)).toMatch(/12[.,]35/);
    expect(pct(1.84)).toBe('+1.8%');
    expect(pct(-0.26)).toBe('−0.3%');
  });
  test('initials keep Danish letters', () => {
    expect(initialsOf('Danske Bank · everyday')).toBe('DB');
    expect(initialsOf('Ørsted')).toBe('Ø');
    expect(initialsOf('')).toBe('?');
  });
  test('days and the axis', () => {
    expect(dayLabel('2026-10-28', '2026-10-28')).toBe('today');
    expect(dayLabel('2026-10-27', '2026-10-28')).toBe('yesterday');
    expect(dayLabel('2026-10-29', '2026-10-28')).toBe('tomorrow');
    const axis = flowAxis('2026-10-28');
    expect(axis).toHaveLength(5);
    expect(axis[0]).toBe('Today');
  });
});

let n = 0;
const tx = (booked_on: string, amount: number, text: string, account_id = 'a'): BankTxRow => ({
  id: `t${n++}`, account_id, booked_on, amount, currency: 'DKK', text, balance_after: null, source: 'csv',
});

describe('moneyModel', () => {
  test('an empty store reads as empty, not as zero money', () => {
    const m = moneyModel(EMPTY_BANK, '2026-10-28');
    expect(m.hasData).toBe(false);
    expect(m.ring.mode).toBe('empty');
    expect(m.projection.known).toBe(false);
    expect(m.newest).toBeNull();
    expect(m.currency).toBe('DKK');
  });

  test('a month of rows becomes the ring, the subscriptions, the projection and goals', () => {
    const txs: BankTxRow[] = [];
    for (const mo of ['2026-07', '2026-08', '2026-09', '2026-10']) {
      txs.push(tx(`${mo}-01`, -8000, 'Husleje'), tx(`${mo}-12`, -129, 'Netflix'), tx(`${mo}-25`, 24000, 'Løn'));
    }
    txs.push(tx('2026-10-03', -400, 'Netto'), tx('2026-10-09', -250, 'Unknown Shop'), tx('2026-10-09', -50, 'Savings move', 'b'));
    const data: BankData = {
      ...EMPTY_BANK,
      accounts: [
        { id: 'a', name: 'Everyday', institution: null, iban_last4: null, currency: 'DKK', source: 'csv', link_id: null, balance: 12000, balance_at: '2026-10-25', is_excluded: false },
        { id: 'b', name: 'Savings', institution: null, iban_last4: null, currency: 'DKK', source: 'csv', link_id: null, balance: 40000, balance_at: '2026-10-25', is_excluded: true },
      ],
      txs,
      budgets: [{ id: 'x', category: 'food', monthly_limit: 3000 }, { id: 'y', category: 'income', monthly_limit: 999 }],
      goals: [{ id: 'g', name: 'Buffer', target: 60000, due_on: null, account_id: 'b', currency: 'DKK' }],
    };
    const m = moneyModel(data, '2026-10-28');
    expect(m.hasData).toBe(true);
    expect(m.newest).toBe('2026-10-25');
    // Income is never a budget category; the savings account is out of the budget.
    expect([...m.limits.keys()]).toEqual(['food']);
    expect(m.spend.get('food')).toBe(400);
    expect(m.spend.get('other')).toBe(250);
    expect(m.spend.get('home')).toBe(8000);
    expect(totalSpent(m)).toBe(8000 + 129 + 400 + 250);
    expect(m.ring.mode).toBe('budget');
    expect(m.subs.map((s) => s.merchant)).toEqual(['Netflix']);
    expect(m.subTotals.monthly).toBe(129);
    expect(m.projection.known).toBe(true);
    expect(m.projection.start).toBe(12000);
    expect(m.goals[0]).toMatchObject({ saved: 40000, linked: true, pct: 67 });
    expect(m.unsorted.map((u) => u.merchant)).toEqual(['Unknown Shop']);
    expect(spendRows(m)[0]).toMatchObject({ id: 'home', spent: 8000, limit: null });
    expect(spendRows(m).find((r) => r.id === 'food')).toMatchObject({ spent: 400, limit: 3000 });
  });

  test('a cancelled subscription leaves the projection', () => {
    const txs = ['2026-08', '2026-09', '2026-10'].map((mo) => tx(`${mo}-12`, -129, 'Netflix'));
    const base: BankData = { ...EMPTY_BANK, txs };
    const before = moneyModel(base, '2026-10-28');
    expect(before.projection.events.some((e) => e.label === 'Netflix')).toBe(true);
    const key = before.subs[0].key;
    const after = moneyModel({ ...base, marks: [{ id: 'm', merchant: key, status: 'cancelled', task_id: null, created_at: '' }] }, '2026-10-28');
    expect(after.projection.events.some((e) => e.label === 'Netflix')).toBe(false);
    expect(after.subTotals).toEqual({ monthly: 0, count: 0, saved: 129 });
  });
});
