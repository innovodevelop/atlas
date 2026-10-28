/**
 * Money's two smaller panels: the monthly limits behind the budget ring
 * (row 33), and sorting — the merchant rules the user can correct, and "Ask
 * Atlas to sort these" for the merchants no rule names (row 33 too). Limits
 * and rules are stored on this Mac; sorting with Atlas sends only merchant
 * names and amounts, and says so before it does.
 */
import { useState } from 'react';
import { CATEGORIES, SPEND_CATEGORIES, categoryOf, type CategoryId } from '@/lib/bankLedger';
import { money } from '@/lib/betaMoney';
import { parseAmount } from '@/lib/bankCsv';
import type { Bank } from '@/hooks/useBank';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The categories a rule may name: every one but Income, which only the sign of an amount decides. */
const RULE_CATEGORIES = CATEGORIES.filter((c) => c.id !== 'income');

export function CategorySelect({ value, onChange, label }: { value: CategoryId; onChange: (c: CategoryId) => void; label: string }) {
  return (
    <select className="b-money-select b-money-select--small" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as CategoryId)}>
      {(value === 'income' ? CATEGORIES : RULE_CATEGORIES).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>
  );
}

export function MoneyLimits({ bank, onClose }: { bank: Bank; onClose: () => void }) {
  const { model } = bank;
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(SPEND_CATEGORIES.map((c) => [c.id, model.limits.get(c.id)?.toString() ?? ''])));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async (id: CategoryId) => {
    const raw = (draft[id] ?? '').trim();
    const n = raw === '' ? 0 : parseAmount(raw) ?? NaN;
    if (!Number.isFinite(n) || n < 0) { setError('A limit is an amount, like 3000.'); return; }
    setError(null);
    try {
      await bank.setLimit(id, Math.round(n));
      setSaved(id);
    } catch (e) { setError(errText(e)); }
  };

  return (
    <section className="b-money-panel" aria-label="Monthly limits">
      <div className="b-money-panel-head">
        <span className="b-money-h2">Monthly limits</span>
        <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={onClose}>Done</button>
      </div>
      <p className="b-money-note">Set what each category may take a month. The ring becomes your budget and the white tick shows where an even pace would be today. Leave a category empty to keep it out of the budget.</p>
      <div className="b-money-limits">
        {SPEND_CATEGORIES.map((c) => (
          <label key={c.id} className="b-money-limit">
            <i style={{ background: c.tint }} aria-hidden />
            <span className="b-money-limit-t"><b>{c.label}</b><span>{money(model.spend.get(c.id) ?? 0, model.currency)} so far this month</span></span>
            <input
              className="b-input b-num" inputMode="decimal" placeholder="No limit" aria-label={`${c.label} monthly limit`}
              value={draft[c.id] ?? ''}
              onChange={(e) => { setSaved(null); setDraft((d) => ({ ...d, [c.id]: e.target.value })); }}
              onBlur={() => void save(c.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(c.id); }}
            />
            <em>{saved === c.id ? 'Saved' : model.currency}</em>
          </label>
        ))}
      </div>
      {error ? <p className="b-money-err-p">{error}</p> : null}
    </section>
  );
}

export function MoneySorting({ bank, onClose, onDone }: { bank: Bank; onClose: () => void; onDone: (summary: string) => void }) {
  const { model, data } = bank;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = model.unsorted.slice(0, 40);
  const rules = [...data.rules].sort((a, b) => (a.origin === b.origin ? a.pattern.localeCompare(b.pattern) : a.origin === 'user' ? -1 : 1));

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      const n = await bank.askSort(items, model.currency);
      setConfirm(false);
      onDone(`Atlas sorted ${n} ${n === 1 ? 'merchant' : 'merchants'}. Change any of them below.`);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const run = (p: Promise<unknown>) => { p.catch((e) => setError(errText(e))); };

  return (
    <section className="b-money-panel" aria-label="Sorting">
      <div className="b-money-panel-head">
        <span className="b-money-h2">Sorting</span>
        <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={onClose}>Done</button>
      </div>
      <p className="b-money-note">Atlas sorts payments by the merchant’s name: your own rules first, then the ones Atlas suggested, then a built-in list of Danish shops. Change a payment’s category anywhere on this screen and the rule is written here.</p>

      {items.length ? (
        <div className="b-money-sortbox">
          <span className="b-money-sub-h">{items.length} {items.length === 1 ? 'merchant is' : 'merchants are'} unsorted</span>
          {items.slice(0, 8).map((i) => (
            <div key={i.key} className="b-money-rule">
              <span className="b-money-rule-t"><b>{i.merchant}</b><span>{money(i.total, model.currency)} over {i.count} {i.count === 1 ? 'payment' : 'payments'}</span></span>
              <CategorySelect label={`Category for ${i.merchant}`} value="other" onChange={(c) => run(bank.setRule(i.key, c))} />
            </div>
          ))}
          {confirm ? (
            <div className="b-money-confirm">
              <p className="b-money-note">This sends {items.length} merchant names with their totals and payment counts to Atlas, which asks its AI provider. No dates, accounts, balances or other transactions are sent. Atlas’s answers become rules you can change.</p>
              <div className="b-money-actions">
                <button type="button" className="b-btn b-btn--primary" disabled={busy} onClick={() => void ask()}>{busy ? 'Atlas is sorting…' : 'Send and sort'}</button>
                <button type="button" className="b-btn b-btn--ghost" disabled={busy} onClick={() => setConfirm(false)}>Not now</button>
              </div>
            </div>
          ) : (
            <div className="b-money-actions">
              <button type="button" className="b-btn b-btn--tinted" disabled={!bank.available} onClick={() => setConfirm(true)}>Ask Atlas to sort these</button>
            </div>
          )}
        </div>
      ) : <p className="b-money-note">Every payment has a category.</p>}

      {rules.length ? (
        <div className="b-money-sortbox">
          <span className="b-money-sub-h">Rules</span>
          {rules.map((r) => (
            <div key={r.id} className="b-money-rule">
              <span className="b-money-rule-t"><b>{r.pattern}</b><span>{r.origin === 'atlas' ? 'Suggested by Atlas' : 'Your rule'} · {categoryOf(r.category as CategoryId).label}</span></span>
              <CategorySelect label={`Category for ${r.pattern}`} value={r.category as CategoryId} onChange={(c) => run(bank.setRule(r.pattern, c))} />
              <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => run(bank.deleteRule(r.id))}>Remove</button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <p className="b-money-err-p">{error}</p> : null}
    </section>
  );
}
