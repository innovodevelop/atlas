import { describe, expect, test } from 'bun:test';
import {
  addDays, addMonths, budgetBalance, budgetRing, buildLedger, buildSortPrompt, cancelPageFor, categorise, categoryLinePoints,
  categoryMonth, chipEvents, dailySpend, daysBetween, detectRecurring, eventSentence, goalView, merchantOf, monthSpend,
  paceSentence, parseSortAnswer, primaryCurrency, projectCashflow, projectionPoints, quickStep, subscriptionTotals,
  subscriptionsOf, unsortedMerchants, type BankTxRow, type CategoryId,
} from './bankLedger';

let n = 0;
const tx = (booked_on: string, amount: number, text: string, account_id = 'a'): BankTxRow => ({
  id: `t${n++}`, account_id, booked_on, amount, currency: 'DKK', text, balance_after: null, source: 'csv',
});
const acct = (id = 'a', is_excluded = false, balance: number | null = null) => ({
  id, name: id, institution: null, iban_last4: null, currency: 'DKK', source: 'csv' as const, link_id: null, balance, balance_at: null, is_excluded,
});

describe('merchants', () => {
  test('method words, references and dates come off', () => {
    expect(merchantOf('Dankort-nota NETTO 4421 24.10')).toEqual({ key: 'netto', label: 'Netto' });
    expect(merchantOf('VISA/DANKORT Føtex Fisketorvet 12345678')).toEqual({ key: 'føtex fisketorvet', label: 'Føtex Fisketorvet' });
    expect(merchantOf('MobilePay: Peter Hansen').key).toBe('peter hansen');
    expect(merchantOf('NETFLIX.COM 866-579-7172').key).toBe('netflix.com');
    expect(merchantOf('Google Pay Irma Nørrebro').key).toBe('irma nørrebro');
    expect(merchantOf('Google One 2TB').key).toBe('google one');
    expect(merchantOf('Spotify P1A2B3C4D5 Stockholm').key).toBe('spotify stockholm');
    expect(merchantOf('   ').label).toBe('Transaction');
  });
});

describe('categorising', () => {
  test('the built-in list, whole words only', () => {
    expect(categorise('Dankort-nota Netto 4421', -45, []).category).toBe('food');
    expect(categorise('Wolt Copenhagen', -189, []).category).toBe('fun');
    expect(categorise('Barber Shop', -250, [])).toEqual({ category: 'other', origin: null, unsorted: true });
    expect(categorise('Netflix.com', -129, []).category).toBe('subscriptions');
    expect(categorise('Overførsel til opsparing', -2000, []).category).toBe('transfer');
  });
  test('income words only match money in', () => {
    expect(categorise('Løn oktober', 25000, []).category).toBe('income');
    expect(categorise('SU', 6000, []).category).toBe('income');
    expect(categorise('Unknown payer', 300, [])).toEqual({ category: 'income', origin: null, unsorted: false });
  });
  test('user rules beat Atlas rules beat the built-in list; the longest pattern wins', () => {
    const rules = [
      { pattern: 'netto', category: 'shopping', origin: 'atlas' as const },
      { pattern: 'peter hansen', category: 'fun', origin: 'user' as const },
      { pattern: 'peter', category: 'home', origin: 'user' as const },
    ];
    expect(categorise('Netto 4421', -45, rules)).toEqual({ category: 'shopping', origin: 'atlas', unsorted: false });
    expect(categorise('MobilePay Peter Hansen', -150, rules).category).toBe('fun');
    expect(categorise('Netto', -45, [{ pattern: 'netto', category: 'nonsense', origin: 'user' }]).category).toBe('food');
  });
  test('the ledger carries merchant, category and the excluded flag, newest first', () => {
    const ledger = buildLedger([tx('2026-10-01', -45, 'Netto'), tx('2026-10-03', -10, 'Kiosk', 'savings')], [], [acct(), acct('savings', true)]);
    expect(ledger[0].booked_on).toBe('2026-10-03');
    expect(ledger[0].excluded).toBe(true);
    expect(ledger[1].category).toBe('food');
  });
});

describe('days', () => {
  test('month arithmetic clamps to the month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
  });
});

describe('budget ring', () => {
  const ledger = buildLedger([
    tx('2026-10-02', -1000, 'Husleje'), tx('2026-10-05', -300, 'Netto'), tx('2026-10-06', 50, 'Netto'),
    tx('2026-10-07', -200, 'Wolt'), tx('2026-09-30', -999, 'Netto'), tx('2026-10-08', 25000, 'Løn'),
    tx('2026-10-09', -5000, 'Overførsel opsparing'), tx('2026-10-10', -400, 'Kiosk', 'savings'),
  ], [], [acct(), acct('savings', true)]);
  test('spend is net of refunds, this month only, budget accounts only, spend kinds only', () => {
    const s = monthSpend(ledger, '2026-10');
    expect(s.get('home')).toBe(1000);
    expect(s.get('food')).toBe(250);
    expect(s.get('fun')).toBe(200);
    expect(s.has('income')).toBe(false);
    expect(s.has('transfer')).toBe(false);
    expect(s.get('other')).toBeUndefined();
    expect(monthSpend(ledger, '2026-10', 5).get('food')).toBe(300);
  });
  test('with limits the ring is the budget, with the pace tick', () => {
    const s = monthSpend(ledger, '2026-10');
    const r = budgetRing(s, new Map<CategoryId, number>([['home', 1000], ['food', 1000], ['fun', 500]]), '2026-10-10', true);
    expect(r.mode).toBe('budget');
    expect(r.budget).toBe(2500);
    expect(r.spent).toBe(1450);
    expect(r.left).toBe(1050);
    expect(r.pace).toBeCloseTo(10 / 31);
    expect(r.over).toBe(true);
    expect(r.arcs.map((a) => a.id)).toEqual(['home', 'food', 'fun']);
    expect(r.arcs[0].offset).toBe(0);
    expect(r.arcs[1].offset).toBeLessThan(0);
    expect(paceSentence(r, (v) => v.toFixed(0))).toBe(`Ahead of an even pace by ${(1450 - 2500 * (10 / 31)).toFixed(0)}`);
  });
  test('without limits the ring is the month spend and asks for limits', () => {
    const r = budgetRing(new Map([['food', 100]]), new Map(), '2026-10-10', true);
    expect(r.mode).toBe('spend');
    expect(paceSentence(r, String)).toBe('Set monthly limits to see your pace');
    expect(budgetRing(new Map(), new Map(), '2026-10-10', true).mode).toBe('empty');
  });
  test('over budget says so; nothing drawn before the entrance', () => {
    const r = budgetRing(new Map([['food', 1200]]), new Map<CategoryId, number>([['food', 1000]]), '2026-10-30', false);
    expect(paceSentence(r, (v) => v.toFixed(0))).toBe('Over budget by 200');
    expect(r.arcs[0].dash.startsWith('0.0 ')).toBe(true);
  });
  test('a category line runs day by day to today', () => {
    const m = categoryMonth(ledger, 'food', '2026-10-07');
    expect(m.cumulative).toHaveLength(7);
    expect(m.cumulative[4]).toBe(300);
    expect(m.total).toBe(250);
    const pts = categoryLinePoints(m.cumulative, m.dim, 1000);
    expect(pts.line.startsWith('0,100.0')).toBe(true);
    expect(pts.limitY).not.toBeNull();
    expect(categoryLinePoints([], 31, null).pace).toBe('');
  });
});

describe('recurring, subscriptions and the projection', () => {
  const rows: BankTxRow[] = [];
  for (const m of ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
    rows.push(tx(`${m}-01`, -8500, 'Husleje'));
    rows.push(tx(`${m}-14`, -129, 'NETFLIX.COM 866-579-7172'));
    rows.push(tx(`${m}-28`, 25000, 'Løn'));
  }
  rows.push(tx('2025-11-02', -599, 'Adobe Lightroom'), tx('2026-11-01', 0, 'zero'));
  rows.push(tx('2026-10-03', -300, 'Netto'), tx('2026-10-10', -240, 'Netto'), tx('2026-10-15', -410, 'Netto'));
  rows.push(tx('2026-07-05', -99, 'Viaplay'), tx('2026-08-05', -99, 'Viaplay'), tx('2026-09-05', -99, 'Viaplay'));
  const today = '2026-10-29';
  const ledger = buildLedger(rows, [], [acct()]);
  const rec = detectRecurring(ledger, today);
  const by = new Map(rec.map((r) => [r.merchantKey, r]));

  test('steady payments are found with their next date; groceries and stopped ones are not', () => {
    expect(by.get('husleje')?.cadence).toBe('monthly');
    expect(by.get('husleje')?.next).toBe('2026-11-01');
    expect(by.get('netflix.com')?.amount).toBe(-129);
    expect(by.get('netflix.com')?.next).toBe('2026-11-14');
    expect(by.get('løn')?.cadence).toBe('monthly');
    expect(by.has('netto')).toBe(false);
    expect(by.has('adobe lightroom')).toBe(false);
    // Viaplay stopped after September: 54 days without a charge.
    expect(by.has('viaplay')).toBe(false);
  });
  test('two identical monthly charges count; two different ones do not', () => {
    const two = buildLedger([tx('2026-09-03', -59, 'Spotify'), tx('2026-10-03', -59, 'Spotify'), tx('2026-09-04', -100, 'Gym'), tx('2026-10-04', -160, 'Gym')], [], [acct()]);
    const keys = detectRecurring(two, '2026-10-20').map((r) => r.merchantKey);
    expect(keys).toEqual(['spotify']);
  });
  test('a late charge is due today, not skipped', () => {
    const late = buildLedger([tx('2026-08-10', -59, 'Spotify'), tx('2026-09-10', -59, 'Spotify')], [], [acct()]);
    expect(detectRecurring(late, '2026-10-13')[0].next).toBe('2026-10-13');
  });
  test('subscriptions leave out rent and income, count marks, and know cancel pages', () => {
    const subs = subscriptionsOf(rec, []);
    expect(subs.map((s) => s.merchantKey)).toEqual(['netflix.com']);
    expect(subs[0].url).toBe('https://www.netflix.com/cancelplan');
    expect(subs[0].monthly).toBe(129);
    const marked = subscriptionsOf(rec, [{ id: 'm', merchant: subs[0].key, status: 'cancelled', task_id: 'task', created_at: '' }]);
    expect(marked[0].status).toBe('cancelled');
    expect(subscriptionTotals(marked)).toEqual({ monthly: 0, count: 0, saved: 129 });
    expect(subscriptionsOf(rec, [{ id: 'm', merchant: subs[0].key, status: 'ignored', task_id: null, created_at: '' }])).toEqual([]);
    expect(cancelPageFor('youtube premium')).toBe('https://www.youtube.com/paid_memberships');
    expect(cancelPageFor('irma')).toBeNull();
  });
  test('everyday spending leaves recurring payments out', () => {
    const d = dailySpend(ledger, rec, today, 60);
    // The window starts on 30 Aug; the ledger inside it starts on 1 Sep, 58 days ago.
    expect(d.days).toBe(58);
    expect(d.perDay).toBeCloseTo((300 + 240 + 410 + 99) / 58, 5);
  });
  test('the projection walks thirty days and puts each payment on its day', () => {
    const p = projectCashflow({ start: 10000, recurring: rec, perDay: 100, today });
    expect(p.points).toHaveLength(31);
    expect(p.known).toBe(true);
    const rent = p.events.find((e) => e.label === 'Husleje');
    expect(rent?.day).toBe(3);
    expect(rent?.balanceAfter).toBe(10000 - 100 * 3 - 8500);
    expect(p.events.map((e) => e.label)).toEqual(['Husleje', 'Netflix.com', 'Løn']);
    expect(p.events[2].day).toBe(30);
    const skipped = projectCashflow({ start: 10000, recurring: rec, perDay: 0, today, skip: new Set([by.get('netflix.com')!.key]) });
    expect(skipped.events.some((e) => e.label === 'Netflix.com')).toBe(false);
    expect(chipEvents(p.events, 2).map((e) => e.label)).toEqual(['Husleje', 'Løn']);
  });
  test('a projection that dips below zero draws the zero line', () => {
    const p = projectCashflow({ start: 1000, recurring: rec, perDay: 200, today });
    const pts = projectionPoints(p);
    expect(p.min).toBeLessThan(0);
    expect(pts.zeroY).not.toBeNull();
    expect(projectionPoints(projectCashflow({ start: null, recurring: [], perDay: 10, today })).zeroY).toBeNull();
  });
  test('the event sentence says only what the projection holds', () => {
    const p = projectCashflow({ start: 10000, recurring: rec, perDay: 0, today });
    const fmt = (v: number) => `${Math.round(v)} kr.`;
    const day = (d: string) => d;
    const rent = p.events.find((e) => e.label === 'Husleje')!;
    expect(eventSentence(rent, p, fmt, day)).toBe('Husleje, 8500 kr., leaves around 2026-11-01. About 1500 kr. is left after it, 27 days before Løn arrives.');
    const salary = p.events.find((e) => e.label === 'Løn')!;
    expect(eventSentence(salary, p, fmt, day)).toBe('Løn of 25000 kr. is due around 2026-11-28, as it does every month.');
    const unknown = projectCashflow({ start: null, recurring: rec, perDay: 0, today });
    expect(eventSentence(unknown.events[0], unknown, fmt, day)).toBe('Husleje, 8500 kr., leaves around 2026-11-01.');
  });
});

describe('goals and balances', () => {
  test('saved from contributions, or from a linked account', () => {
    const g = { id: 'g', name: 'Lisbon', target: 15000, due_on: '2027-03-01', account_id: null, currency: 'DKK' };
    const v = goalView(g, [{ id: '1', goal_id: 'g', amount: 5000, made_on: '2026-10-01' }, { id: '2', goal_id: 'x', amount: 9, made_on: '' }], [], '2026-10-28');
    expect(v.saved).toBe(5000);
    expect(v.pct).toBe(33);
    expect(v.left).toBe(10000);
    expect(v.perMonth).toBe(2000);
    const linked = goalView({ ...g, account_id: 's' }, [], [{ id: 's', name: 'Savings', balance: 16000 }], '2026-10-28');
    expect(linked.linked).toBe(true);
    expect(linked.done).toBe(true);
    expect(linked.perMonth).toBeNull();
    expect(quickStep('DKK')).toBe(500);
    expect(quickStep('EUR')).toBe(100);
  });
  test('the budget balance needs every budget account to know its balance', () => {
    expect(budgetBalance([acct('a', false, 100), acct('b', true, null)])).toBe(100);
    expect(budgetBalance([acct('a', false, 100), acct('b', false, null)])).toBeNull();
    expect(primaryCurrency([{ currency: 'EUR', is_excluded: false }, { currency: 'DKK', is_excluded: false }, { currency: 'DKK', is_excluded: false }])).toBe('DKK');
  });
});

describe('asking Atlas to sort', () => {
  const ledger = buildLedger([tx('2026-10-01', -250, 'Barber Shop'), tx('2026-10-02', -250, 'Barber Shop'), tx('2026-10-03', -80, 'Kiosk Syd'), tx('2026-10-04', -45, 'Netto')], [], [acct()]);
  const items = unsortedMerchants(ledger);
  test('only unsorted merchants, biggest first', () => {
    expect(items.map((i) => [i.merchant, i.total, i.count])).toEqual([['Barber Shop', 500, 2], ['Kiosk Syd', 80, 1]]);
  });
  test('the prompt carries names and amounts and nothing else', () => {
    const p = buildSortPrompt(items, 'DKK');
    expect(p).toContain('- Barber Shop: 500.00 DKK over 2 payments');
    expect(p).not.toContain('2026-10');
  });
  test('JSON replies and line replies are read; strangers are dropped', () => {
    expect(parseSortAnswer('Sure! {"Barber Shop": "shopping", "Kiosk Syd": "food", "Unknown": "food"}', items)).toEqual([
      { key: 'barber shop', merchant: 'Barber Shop', category: 'shopping' },
      { key: 'kiosk syd', merchant: 'Kiosk Syd', category: 'food' },
    ]);
    expect(parseSortAnswer('- Barber Shop: fun\n- Kiosk Syd => income', items)).toEqual([{ key: 'barber shop', merchant: 'Barber Shop', category: 'fun' }]);
    expect(parseSortAnswer('no idea', items)).toEqual([]);
  });
});
