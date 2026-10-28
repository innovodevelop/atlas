/**
 * The bank store on this Mac, for the Beta Money screen and the Money widgets
 * on Home (rows 17 and 31–37 of docs/design-sync/2026-10-28-left-out-features.md).
 *
 * Reads every bank_* table of db_schema.sql for the signed-in user through the
 * local CRUD shim and turns them into the screen's model (src/lib/betaMoney.ts).
 * Writes go back the same way, except the two that cannot: transactions are
 * stored through `bank_store_transactions` (INSERT OR IGNORE, so re-imports
 * dedupe), and everything GoCardless goes through the bank_gc_* commands in
 * src-tauri/src/bank.rs, which keep the user's keys in the Keychain. No key
 * ever passes through this file except on its one way in, `setKeys`.
 *
 * Outside the desktop app there is no store: the hook reads as empty and every
 * write says it needs the Mac app.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localClient, isTauri } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import { askAtlas } from '@/lib/askAtlas';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import { EMPTY_BANK, moneyModel, type BankData, type MoneyModel } from '@/lib/betaMoney';
import { addDays, buildSortPrompt, dayOf, parseSortAnswer, type CategoryId, type SortItem, type Subscription, type SubscriptionMarkStatus } from '@/lib/bankLedger';
import { balanceAfterImport, storeRows } from '@/lib/bankLink';
import type { ParsedTx } from '@/lib/bankCsv';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

const TABLES = {
  accounts: 'bank_accounts',
  txs: 'bank_transactions',
  rules: 'bank_rules',
  budgets: 'bank_budgets',
  goals: 'bank_goals',
  moves: 'bank_goal_moves',
  marks: 'bank_subscription_marks',
  links: 'bank_links',
} as const satisfies Record<keyof BankData, string>;

const NEED_MAC = 'Money keeps its data in the Atlas desktop app.';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function loadBank(userId: string): Promise<BankData> {
  const entries = await Promise.all(
    (Object.keys(TABLES) as (keyof BankData)[]).map(async (k) => {
      const { data, error } = await localClient.from(TABLES[k]).select('*').eq('user_id', userId);
      if (error) throw new Error(error.message);
      return [k, data ?? []] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as BankData;
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

export interface GcStatus { has_keys: boolean; redirect: string }
export interface Institution { id: string; name: string; bic: string | null; logo: string | null; history_days: number }
export interface StoreResult { inserted: number; skipped: number }
export interface SyncResult { accounts: number; inserted: number; skipped: number }

export const bankQueryKey = (userId: string | null) => ['bank', userId] as const;

/** The store for one user and today's model of it. */
export function useBank() {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const qc = useQueryClient();
  const available = isTauri();
  const [today, setToday] = useState(() => dayOf(new Date()));

  // The day turns while the app is open; the month, the pace and the
  // projection turn with it.
  useEffect(() => {
    const id = window.setInterval(() => setToday(dayOf(new Date())), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const q = useQuery({
    queryKey: bankQueryKey(uid),
    queryFn: () => loadBank(uid!),
    enabled: !!uid && available,
    staleTime: 30_000,
  });
  const gc = useQuery({
    queryKey: ['bank-gc'],
    queryFn: () => invoke<GcStatus>('bank_gc_status'),
    enabled: available,
    staleTime: 60_000,
  });

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['bank'] }), [qc]);

  // Rust's daily read and every write here emit db:changed for the table.
  useEffect(() => {
    if (!available) return;
    const channel = localClient.channel('bank');
    for (const table of Object.values(TABLES)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => { void refresh(); });
    }
    channel.subscribe();
    return () => { localClient.removeChannel(channel); };
  }, [available, refresh]);

  const data = q.data ?? EMPTY_BANK;
  const model: MoneyModel = useMemo(() => moneyModel(data, today), [data, today]);

  const need = useCallback(() => {
    if (!available) throw new Error(NEED_MAC);
    if (!uid) throw new Error('Sign in to use Money.');
    return uid;
  }, [available, uid]);

  // --- Accounts and the CSV import --------------------------------------------------

  const createAccount = useCallback(async (a: { name: string; institution?: string | null; currency: string }) => {
    const userId = need();
    const id = crypto.randomUUID();
    await must(localClient.from('bank_accounts').insert({
      id, user_id: userId, name: a.name.trim().slice(0, 120) || 'Account', institution: a.institution?.trim() || null,
      currency: /^[A-Z]{3}$/.test(a.currency) ? a.currency : 'DKK', source: 'csv',
    }));
    await refresh();
    return id;
  }, [need, refresh]);

  const importTransactions = useCallback(async (accountId: string, txs: readonly ParsedTx[]): Promise<StoreResult> => {
    const userId = need();
    const account = data.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error('Pick an account to import into.');
    const result = await invoke<StoreResult>('bank_store_transactions', { userId, accountId, rows: storeRows(accountId, txs, account.currency) });
    const bal = balanceAfterImport(account, txs);
    if (bal) await must(localClient.from('bank_accounts').update(bal).eq('id', accountId).eq('user_id', userId));
    await refresh();
    return result;
  }, [need, data.accounts, refresh]);

  const updateAccount = useCallback(async (id: string, patch: { name?: string; is_excluded?: boolean }) => {
    const userId = need();
    await must(localClient.from('bank_accounts').update(patch).eq('id', id).eq('user_id', userId));
    await refresh();
  }, [need, refresh]);

  /** Delete an account and, by the schema's cascade, every transaction on it. */
  const deleteAccount = useCallback(async (id: string) => {
    const userId = need();
    await must(localClient.from('bank_accounts').delete().eq('id', id).eq('user_id', userId));
    await refresh();
  }, [need, refresh]);

  // --- Rules and limits -------------------------------------------------------------

  const setRule = useCallback(async (pattern: string, category: CategoryId, origin: 'user' | 'atlas' = 'user') => {
    const userId = need();
    const p = pattern.trim().toLowerCase().slice(0, 80);
    if (!p) return;
    const existing = data.rules.find((r) => r.pattern === p);
    if (existing) {
      // Atlas never overrides a rule the user set.
      if (existing.origin === 'user' && origin === 'atlas') return;
      await must(localClient.from('bank_rules').update({ category, origin }).eq('id', existing.id).eq('user_id', userId));
    } else {
      await must(localClient.from('bank_rules').insert({ id: crypto.randomUUID(), user_id: userId, pattern: p, category, origin }));
    }
    await refresh();
  }, [need, data.rules, refresh]);

  const deleteRule = useCallback(async (id: string) => {
    const userId = need();
    await must(localClient.from('bank_rules').delete().eq('id', id).eq('user_id', userId));
    await refresh();
  }, [need, refresh]);

  /** A monthly limit for one category; zero or less removes it. */
  const setLimit = useCallback(async (category: CategoryId, limit: number) => {
    const userId = need();
    const existing = data.budgets.find((b) => b.category === category);
    if (!(limit > 0)) {
      if (existing) await must(localClient.from('bank_budgets').delete().eq('id', existing.id).eq('user_id', userId));
    } else if (existing) {
      await must(localClient.from('bank_budgets').update({ monthly_limit: limit }).eq('id', existing.id).eq('user_id', userId));
    } else {
      await must(localClient.from('bank_budgets').insert({ id: crypto.randomUUID(), user_id: userId, category, monthly_limit: limit }));
    }
    await refresh();
  }, [need, data.budgets, refresh]);

  /**
   * "Ask Atlas to sort these": merchant names and amounts — nothing else —
   * go to Atlas, and its answer comes back as rules marked as Atlas's.
   */
  const askSort = useCallback(async (items: readonly SortItem[], currency: string): Promise<number> => {
    need();
    if (!items.length) return 0;
    const { text } = await askAtlas(buildSortPrompt(items, currency), { screen: 'money' });
    const sorted = parseSortAnswer(text, items);
    if (!sorted.length) throw new Error('Atlas answered, but not in a form Money can read. Nothing was changed.');
    const userId = need();
    const userRules = new Set(data.rules.filter((r) => r.origin === 'user').map((r) => r.pattern));
    for (const s of sorted) {
      if (userRules.has(s.key)) continue;
      const existing = data.rules.find((r) => r.pattern === s.key);
      if (existing) await must(localClient.from('bank_rules').update({ category: s.category, origin: 'atlas' }).eq('id', existing.id).eq('user_id', userId));
      else await must(localClient.from('bank_rules').insert({ id: crypto.randomUUID(), user_id: userId, pattern: s.key, category: s.category, origin: 'atlas' }));
    }
    await refresh();
    return sorted.length;
  }, [need, data.rules, refresh]);

  // --- Subscriptions ----------------------------------------------------------------

  const writeMark = useCallback(async (merchant: string, status: SubscriptionMarkStatus | null, taskId: string | null) => {
    const userId = need();
    const existing = data.marks.find((m) => m.merchant === merchant);
    if (!status) {
      if (existing) await must(localClient.from('bank_subscription_marks').delete().eq('id', existing.id).eq('user_id', userId));
    } else if (existing) {
      await must(localClient.from('bank_subscription_marks').update({ status, task_id: taskId }).eq('id', existing.id).eq('user_id', userId));
    } else {
      await must(localClient.from('bank_subscription_marks').insert({ id: crypto.randomUUID(), user_id: userId, merchant, status, task_id: taskId }));
    }
  }, [need, data.marks]);

  /**
   * "Cancel": Atlas cannot end a subscription at the merchant. It adds a task
   * to do it before the next charge and opens the merchant's own account page
   * when it knows one. Returns the undo.
   */
  const remindCancel = useCallback(async (s: Subscription): Promise<() => Promise<void>> => {
    const userId = need();
    const before = data.marks.find((m) => m.merchant === s.key) ?? null;
    const taskId = crypto.randomUUID();
    const due = addDays(s.next, -2) > today ? addDays(s.next, -2) : addDays(today, 1);
    await must(localClient.from('user_tasks').insert({
      id: taskId, user_id: userId, title: `Cancel ${s.merchant} before it renews`, priority: 'medium', completed: false,
      due_date: new Date(`${due}T09:00:00`).toISOString(),
    }));
    await writeMark(s.key, before?.status === 'cancelled' ? 'cancelled' : 'reminded', taskId);
    await refresh();
    if (s.url) void openExternal(s.url);
    return async () => {
      await must(localClient.from('user_tasks').delete().eq('id', taskId).eq('user_id', userId));
      await writeMark(s.key, before?.status ?? null, before?.task_id ?? null);
      await refresh();
    };
  }, [need, data.marks, today, writeMark, refresh]);

  /** Set a subscription's mark ("cancelled", "ignored", or back to none). Returns the undo. */
  const markSubscription = useCallback(async (s: Subscription, status: 'cancelled' | 'ignored' | null): Promise<() => Promise<void>> => {
    const before = data.marks.find((m) => m.merchant === s.key) ?? null;
    const next = status ?? (before?.task_id ? 'reminded' : null);
    await writeMark(s.key, next, before?.task_id ?? null);
    await refresh();
    return async () => {
      await writeMark(s.key, before?.status ?? null, before?.task_id ?? null);
      await refresh();
    };
  }, [data.marks, writeMark, refresh]);

  // --- Goals ------------------------------------------------------------------------

  const addGoal = useCallback(async (g: { name: string; target: number; due_on: string | null; account_id: string | null; currency: string }) => {
    const userId = need();
    if (!g.name.trim() || !(g.target > 0)) throw new Error('A goal needs a name and an amount.');
    await must(localClient.from('bank_goals').insert({
      id: crypto.randomUUID(), user_id: userId, name: g.name.trim().slice(0, 80), target: g.target, due_on: g.due_on || null,
      account_id: g.account_id || null, currency: g.currency,
    }));
    await refresh();
  }, [need, refresh]);

  const deleteGoal = useCallback(async (id: string) => {
    const userId = need();
    await must(localClient.from('bank_goals').delete().eq('id', id).eq('user_id', userId));
    await refresh();
  }, [need, refresh]);

  /** A manual contribution (negative: a withdrawal). Returns the undo. */
  const addToGoal = useCallback(async (goalId: string, amount: number): Promise<() => Promise<void>> => {
    const userId = need();
    if (!Number.isFinite(amount) || amount === 0) throw new Error('Enter an amount.');
    const id = crypto.randomUUID();
    await must(localClient.from('bank_goal_moves').insert({ id, user_id: userId, goal_id: goalId, amount, made_on: today }));
    await refresh();
    return async () => {
      await must(localClient.from('bank_goal_moves').delete().eq('id', id).eq('user_id', userId));
      await refresh();
    };
  }, [need, today, refresh]);

  // --- GoCardless -------------------------------------------------------------------

  const refreshGc = useCallback(() => qc.invalidateQueries({ queryKey: ['bank-gc'] }), [qc]);

  const setKeys = useCallback(async (secretId: string, secretKey: string) => {
    if (!available) throw new Error(NEED_MAC);
    await invoke('bank_gc_set_keys', { secretId, secretKey });
    await refreshGc();
  }, [available, refreshGc]);

  const clearKeys = useCallback(async () => {
    if (!available) throw new Error(NEED_MAC);
    await invoke('bank_gc_clear_keys');
    await refreshGc();
  }, [available, refreshGc]);

  const institutions = useCallback(async (country: string) => {
    if (!available) throw new Error(NEED_MAC);
    return invoke<Institution[]>('bank_gc_institutions', { country });
  }, [available]);

  /** Start a link and open the bank's consent page in the browser. */
  const connectBank = useCallback(async (inst: Institution) => {
    const userId = need();
    const started = await invoke<{ id: string; link: string }>('bank_gc_link_start', {
      userId, institutionId: inst.id, institutionName: inst.name, historyDays: inst.history_days,
    });
    await refresh();
    await openExternal(started.link);
    return started.id;
  }, [need, refresh]);

  const refreshLink = useCallback(async (linkId: string) => {
    const userId = need();
    const status = await invoke<string>('bank_gc_link_refresh', { userId, linkId });
    await refresh();
    return status;
  }, [need, refresh]);

  const syncLink = useCallback(async (linkId: string) => {
    const userId = need();
    try {
      return await invoke<SyncResult>('bank_gc_sync', { userId, linkId });
    } finally {
      await refresh();
    }
  }, [need, refresh]);

  const unlink = useCallback(async (linkId: string, forget: boolean) => {
    const userId = need();
    await invoke('bank_gc_unlink', { userId, linkId, forget });
    await refresh();
  }, [need, refresh]);

  return {
    available, signedIn: !!uid, loading: q.isLoading && !!uid && available, error: q.error ? errText(q.error) : null,
    data, model, today, gc: gc.data ?? null,
    createAccount, importTransactions, updateAccount, deleteAccount,
    setRule, deleteRule, setLimit, askSort,
    remindCancel, markSubscription,
    addGoal, deleteGoal, addToGoal,
    setKeys, clearKeys, institutions, connectBank, refreshLink, syncLink, unlink,
  };
}

export type Bank = ReturnType<typeof useBank>;
