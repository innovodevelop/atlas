/**
 * Money's CSV import (row 31): pick a netbank export, check the columns Atlas
 * found — or map them when the header is one Atlas does not know — choose
 * the account, and store the rows on this Mac. A re-import of an overlapping
 * export adds only what is new (the dedupe ids are bankCsv.ts's, the INSERT OR
 * IGNORE is bank.rs's). The file never leaves the Mac.
 */
import { useMemo, useState } from 'react';
import {
  ROLES, ROLE_LABEL, decodeCsvBytes, mappingProblems, planCsv, rowsToTransactions, spanOf,
  type ColumnRole, type CsvPlan, type DecimalMark,
} from '@/lib/bankCsv';
import { importSummary } from '@/lib/bankLink';
import { money } from '@/lib/betaMoney';
import type { Bank } from '@/hooks/useBank';

const CURRENCIES = ['DKK', 'EUR', 'SEK', 'NOK', 'USD', 'GBP'];
const NEW = '__new__';

export function MoneyImport({ bank, onClose, onDone }: { bank: Bank; onClose: () => void; onDone: (summary: string) => void }) {
  const csvAccounts = bank.data.accounts.filter((a) => a.source === 'csv');
  const [fileName, setFileName] = useState<string | null>(null);
  const [plan, setPlan] = useState<CsvPlan | null>(null);
  const [mapping, setMapping] = useState<ColumnRole[]>([]);
  const [decimal, setDecimal] = useState<DecimalMark>(',');
  const [showMap, setShowMap] = useState(false);
  const [accountId, setAccountId] = useState<string>(csvAccounts[0]?.id ?? NEW);
  const [newName, setNewName] = useState('');
  const [newCurrency, setNewCurrency] = useState('DKK');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => (plan ? rowsToTransactions(plan.rows, mapping, decimal) : null), [plan, mapping, decimal]);
  const problems = plan ? mappingProblems(mapping) : [];
  const span = parsed ? spanOf(parsed.txs) : null;
  const currency = accountId === NEW ? newCurrency : csvAccounts.find((a) => a.id === accountId)?.currency ?? 'DKK';

  const pick = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setError('That file is larger than any netbank export; pick the CSV itself.'); return; }
    try {
      const text = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
      const p = planCsv(text);
      if (!p.rows.length) { setError('No rows were found in that file.'); return; }
      setFileName(file.name);
      setPlan(p);
      setMapping(p.mapping);
      setDecimal(p.decimal);
      setShowMap(!p.known);
      if (!newName) setNewName(file.name.replace(/\.(csv|txt)$/i, '').slice(0, 60));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async () => {
    if (!parsed || problems.length) return;
    setBusy(true);
    setError(null);
    try {
      const target = accountId === NEW ? await bank.createAccount({ name: newName || 'Bank account', currency: newCurrency }) : accountId;
      const r = await bank.importTransactions(target, parsed.txs);
      onDone(importSummary({ ...r, rejected: parsed.rejected }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="b-money-panel" aria-label="Import a CSV export">
      <div className="b-money-panel-head">
        <span className="b-money-h2">Import from your netbank</span>
        <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={onClose}>Close</button>
      </div>
      <p className="b-money-note">
        Export your transactions as CSV from your netbank and pick the file here. Atlas reads it on this Mac and keeps the rows here; the file is not sent anywhere. Importing the same months again adds only what is new.
      </p>

      <label className="b-money-file">
        <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        <span className="b-btn b-btn--primary">{fileName ? 'Pick another file' : 'Pick a CSV file'}</span>
        {fileName ? <span className="b-money-file-name">{fileName}</span> : null}
      </label>

      {plan && parsed ? (
        <>
          <p className="b-money-note">
            {plan.rows.length} {plan.rows.length === 1 ? 'row' : 'rows'}, separated by “{plan.delimiter === '\t' ? 'tab' : plan.delimiter}”, decimal {decimal === ',' ? 'comma' : 'point'}
            {span ? `, ${span.from} to ${span.to}` : ''}.{' '}
            {plan.known && !showMap ? <button type="button" className="b-money-link" onClick={() => setShowMap(true)}>Check the columns</button> : null}
          </p>

          {showMap ? (
            <div className="b-money-map" role="group" aria-label="Columns">
              {!plan.known ? <p className="b-money-note">Atlas does not know this file’s column names. It guessed from the data; say what each column holds.</p> : null}
              {plan.headers.map((h, i) => (
                <label key={i} className="b-money-map-col">
                  <span className="b-money-map-h">{h}</span>
                  <span className="b-money-map-s">{plan.rows.slice(0, 2).map((r) => r[i] ?? '').filter(Boolean).join(' · ') || '—'}</span>
                  <select className="b-money-select" value={mapping[i] ?? 'ignore'} onChange={(e) => setMapping((m) => m.map((r, j) => (j === i ? (e.target.value as ColumnRole) : r)))}>
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </label>
              ))}
              <label className="b-money-map-col">
                <span className="b-money-map-h">Decimal mark</span>
                <span className="b-money-map-s">1.234,56 or 1,234.56</span>
                <select className="b-money-select" value={decimal} onChange={(e) => setDecimal(e.target.value as DecimalMark)}>
                  <option value=",">Comma (1.234,56)</option>
                  <option value=".">Point (1,234.56)</option>
                </select>
              </label>
            </div>
          ) : null}

          {problems.length ? <p className="b-money-err-p">{problems.join(' ')}</p> : (
            <div className="b-money-preview" aria-label="First rows">
              {parsed.txs.slice(0, 4).map((t, i) => (
                <div key={i} className="b-money-preview-row">
                  <span className="b-num">{t.booked_on}</span>
                  <span className="b-money-preview-t">{t.text}</span>
                  <span className="b-num">{money(t.amount, t.currency ?? currency, 2)}</span>
                </div>
              ))}
              <p className="b-money-note">{parsed.txs.length} transactions read{parsed.rejected ? `, ${parsed.rejected} rows without a date or amount left out` : ''}.</p>
            </div>
          )}

          <div className="b-money-form">
            <label className="b-money-field">
              <span>Into account</span>
              <select className="b-money-select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {csvAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value={NEW}>A new account…</option>
              </select>
            </label>
            {accountId === NEW ? (
              <>
                <label className="b-money-field">
                  <span>Name</span>
                  <input className="b-input" value={newName} maxLength={60} placeholder="Danske Bank · everyday" onChange={(e) => setNewName(e.target.value)} />
                </label>
                <label className="b-money-field b-money-field--small">
                  <span>Currency</span>
                  <select className="b-money-select" value={newCurrency} onChange={(e) => setNewCurrency(e.target.value)}>
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </>
            ) : null}
          </div>
          <div className="b-money-actions">
            <button type="button" className="b-btn b-btn--primary" disabled={busy || !!problems.length || !parsed.txs.length || (accountId === NEW && !newName.trim())} onClick={() => void run()}>
              {busy ? 'Importing…' : `Import ${parsed.txs.length} transactions`}
            </button>
          </div>
        </>
      ) : null}
      {error ? <p className="b-money-err-p">{error}</p> : null}
    </section>
  );
}
