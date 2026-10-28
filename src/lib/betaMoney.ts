/**
 * The Beta Money screen's model — formats, and everything the screen and the
 * Money widgets on Home draw from the bank store, computed once from the
 * store's rows and today's date. Pure and tested here; the arithmetic itself
 * lives in bankLedger.ts, this file only puts it together the way the screen
 * reads it (`Atlas Money Beta.dc.html`).
 */
import {
  CATEGORIES, budgetBalance, budgetRing, buildLedger, categoryOf, dailySpend, detectRecurring, goalView, monthOf, monthSpend,
  primaryCurrency, projectCashflow, subscriptionTotals, subscriptionsOf, sumOf, unsortedMerchants,
  type BankAccountRow, type BankBudgetRow, type BankGoalMoveRow, type BankGoalRow, type BankLinkRow, type BankRuleRow,
  type BankSubMarkRow, type BankTxRow, type BudgetRing, type CategoryId, type GoalView, type LedgerTx, type Projection,
  type Recurring, type SortItem, type Subscription,
} from './bankLedger';

export function money(v: number, currency = 'USD', digits = 0): string {
  try { return v.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: digits, minimumFractionDigits: digits }); } catch { return `${v.toFixed(digits)} ${currency}`; }
}

export function pct(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
}

export function initialsOf(s: string): string {
  return s.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

/** Every row the bank store holds for one user, as useBank reads it. */
export interface BankData {
  accounts: BankAccountRow[];
  txs: BankTxRow[];
  rules: BankRuleRow[];
  budgets: BankBudgetRow[];
  goals: BankGoalRow[];
  moves: BankGoalMoveRow[];
  marks: BankSubMarkRow[];
  links: BankLinkRow[];
}

export const EMPTY_BANK: BankData = { accounts: [], txs: [], rules: [], budgets: [], goals: [], moves: [], marks: [], links: [] };

export interface MoneyModel {
  today: string;
  currency: string;
  hasData: boolean;
  ledger: LedgerTx[];
  /** The newest booked day in the store; the screen says when the data stops. */
  newest: string | null;
  spend: Map<CategoryId, number>;
  limits: Map<CategoryId, number>;
  ring: BudgetRing;
  recurring: Recurring[];
  subs: Subscription[];
  subTotals: { monthly: number; count: number; saved: number };
  projection: Projection;
  /** Days of everyday spending the projection's daily figure is read from. */
  spendDays: number;
  goals: GoalView[];
  unsorted: SortItem[];
}

/** The screen's whole reading of the store for `today` (YYYY-MM-DD). */
export function moneyModel(data: BankData, today: string, grown = true): MoneyModel {
  const ledger = buildLedger(data.txs, data.rules, data.accounts);
  const currency = primaryCurrency(data.accounts);
  const month = monthOf(today);
  const spend = monthSpend(ledger, month);
  const limits = new Map<CategoryId, number>();
  for (const b of data.budgets) {
    const c = CATEGORIES.find((x) => x.id === b.category);
    if (c && c.kind === 'spend' && b.monthly_limit > 0) limits.set(c.id, b.monthly_limit);
  }
  const ring = budgetRing(spend, limits, today, grown);
  const recurring = detectRecurring(ledger, today);
  const subs = subscriptionsOf(recurring, data.marks);
  const cancelled = new Set(subs.filter((s) => s.status === 'cancelled').map((s) => s.key));
  const daily = dailySpend(ledger, recurring, today);
  const projection = projectCashflow({ start: budgetBalance(data.accounts), recurring, perDay: daily.perDay, today, skip: cancelled });
  const goals = data.goals.map((g) => goalView(g, data.moves, data.accounts, today));
  return {
    today, currency, hasData: ledger.length > 0, ledger, newest: ledger[0]?.booked_on ?? null,
    spend, limits, ring, recurring, subs, subTotals: subscriptionTotals(subs), projection, spendDays: daily.days, goals,
    unsorted: unsortedMerchants(ledger),
  };
}

/** This month's spend by category, biggest first, for the chips and the Spend widget. */
export function spendRows(m: Pick<MoneyModel, 'spend' | 'limits'>): { id: CategoryId; label: string; spent: number; limit: number | null }[] {
  const ids = new Set<CategoryId>([...m.spend.keys(), ...m.limits.keys()]);
  return [...ids]
    .map((id) => ({ id, label: categoryOf(id).label, spent: m.spend.get(id) ?? 0, limit: m.limits.get(id) ?? null }))
    .sort((a, b) => b.spent - a.spent || (b.limit ?? 0) - (a.limit ?? 0));
}

export const totalSpent = (m: Pick<MoneyModel, 'spend'>) => sumOf(m.spend);

/** A day as the screen writes it: "today", "yesterday", or "Mon 3 Nov". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'today';
  const d = new Date(`${day}T12:00:00`);
  const t = new Date(`${today}T12:00:00`);
  const diff = Math.round((t.getTime() - d.getTime()) / 86_400_000);
  if (diff === 1) return 'yesterday';
  if (diff === -1) return 'tomorrow';
  return d.toLocaleDateString(undefined, { weekday: diff > 0 && diff < 7 ? 'short' : undefined, day: 'numeric', month: 'short' });
}

/** The axis under the thirty-day line: today, then four dates spread across it. */
export function flowAxis(today: string, days = 30): string[] {
  const out = ['Today'];
  for (const f of [0.25, 0.5, 0.75, 1]) {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + Math.round(days * f));
    out.push(d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  }
  return out;
}
