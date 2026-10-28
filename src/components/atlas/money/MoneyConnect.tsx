/**
 * Money's bank connection (row 32): GoCardless Bank Account Data, read-only.
 *
 * Dormant until the user brings their own GoCardless keys: the panel says what
 * is needed, where to get it, and what will leave the Mac once a bank is
 * connected. The keys go straight to the Keychain through bank_gc_set_keys;
 * this component holds them only while they are typed and clears them after.
 * Then: pick a Danish bank, give consent in the browser, come back, and Atlas
 * reads the accounts on demand and once a day.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { filterInstitutions, keyProblems, linkLine, linkStatus } from '@/lib/bankLink';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import type { Bank, Institution } from '@/hooks/useBank';

const GOCARDLESS_SIGNUP = 'https://bankaccountdata.gocardless.com/';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `today ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function MoneyConnect({ bank, onClose, onDone }: { bank: Bank; onClose: () => void; onDone: (summary: string) => void }) {
  const [secretId, setSecretId] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [banks, setBanks] = useState<Institution[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forget, setForget] = useState<string | null>(null);

  const hasKeys = !!bank.gc?.has_keys;
  const links = bank.data.links;
  const shown = useMemo(() => filterInstitutions(banks ?? [], query).slice(0, 40), [banks, query]);

  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(null); }
  }, []);

  // Back from the bank's consent page: re-read every link still waiting, and
  // read the bank once it says it is linked.
  const { available, refreshLink, syncLink } = bank;
  useEffect(() => {
    const waiting = links.filter((l) => linkStatus(l.status).tone === 'waiting');
    if (!waiting.length || !available) return;
    const onFocus = () => {
      for (const l of waiting) {
        void refreshLink(l.id).then((st) => {
          if (st === 'LN') return syncLink(l.id).then((r) => onDone(`${l.institution_name ?? 'The bank'} is connected: ${r.inserted} transactions read.`));
          return undefined;
        }).catch((e) => setError(errText(e)));
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [links, available, refreshLink, syncLink, onDone]);

  const saveKeys = () => act('keys', async () => {
    await bank.setKeys(secretId, secretKey);
    setSecretId('');
    setSecretKey('');
  });

  const problems = keyProblems(secretId, secretKey);

  return (
    <section className="b-money-panel" aria-label="Connect a bank">
      <div className="b-money-panel-head">
        <span className="b-money-h2">Connect a bank</span>
        <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={onClose}>Close</button>
      </div>
      <p className="b-money-note">
        Optional, and read-only. Atlas reads balances and transactions through GoCardless Bank Account Data, a licensed PSD2 account-information service, after you give consent at your own bank. With a bank connected, your transactions pass through GoCardless on their way here; they are stored only on this Mac. Nothing can be paid or moved: Atlas asks for no such access, and banks give none. Without a connection, import a CSV instead.
      </p>

      {!bank.available ? <p className="b-money-note">Bank connections run in the Atlas desktop app.</p> : !hasKeys ? (
        <div className="b-money-keys">
          <p className="b-money-note">
            Needs your own GoCardless Bank Account Data keys (free for personal use). Create them under User secrets at GoCardless, then paste them here. They are kept in the macOS Keychain and sent only to GoCardless.
          </p>
          <div className="b-money-form">
            <label className="b-money-field">
              <span>Secret ID</span>
              <input className="b-input" type="password" autoComplete="off" spellCheck={false} value={secretId} onChange={(e) => setSecretId(e.target.value)} />
            </label>
            <label className="b-money-field">
              <span>Secret key</span>
              <input className="b-input" type="password" autoComplete="off" spellCheck={false} value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
            </label>
          </div>
          <div className="b-money-actions">
            <button type="button" className="b-btn b-btn--primary" disabled={!!busy || problems.length > 0} onClick={() => void saveKeys()}>{busy === 'keys' ? 'Checking with GoCardless…' : 'Save to Keychain'}</button>
            <button type="button" className="b-btn b-btn--card" onClick={() => void openExternal(GOCARDLESS_SIGNUP)}>Get keys at GoCardless</button>
          </div>
        </div>
      ) : (
        <>
          {links.length ? (
            <div className="b-money-links">
              {links.map((l) => {
                const st = linkStatus(l.status);
                return (
                  <div key={l.id} className="b-money-linkrow">
                    <span className={`b-money-dot ${st.tone}`} aria-hidden />
                    <span className="b-money-linkrow-t">
                      <b>{l.institution_name ?? l.institution_id}</b>
                      <span>{linkLine(l, Date.now(), when)}</span>
                      {l.last_error ? <span className="b-money-err-s">{l.last_error}</span> : null}
                    </span>
                    <span className="b-money-linkrow-a">
                      {st.tone === 'waiting' ? <button type="button" className="b-btn b-btn--card b-btn--row" disabled={!!busy} onClick={() => void act(`check-${l.id}`, () => bank.refreshLink(l.id))}>{busy === `check-${l.id}` ? 'Checking…' : 'Check'}</button> : null}
                      {st.tone === 'ok' ? (
                        <button type="button" className="b-btn b-btn--card b-btn--row" disabled={!!busy} onClick={() => void act(`sync-${l.id}`, async () => {
                          const r = await bank.syncLink(l.id);
                          onDone(`${l.institution_name ?? 'The bank'}: ${r.inserted} new transactions.`);
                        })}>{busy === `sync-${l.id}` ? 'Reading…' : 'Read now'}</button>
                      ) : null}
                      {forget === l.id ? (
                        <>
                          <button type="button" className="b-btn b-btn--danger b-btn--row" disabled={!!busy} onClick={() => void act(`unlink-${l.id}`, async () => { await bank.unlink(l.id, false); setForget(null); })}>Keep its transactions</button>
                          <button type="button" className="b-btn b-btn--danger-fill b-btn--row" disabled={!!busy} onClick={() => void act(`unlink-${l.id}`, async () => { await bank.unlink(l.id, true); setForget(null); })}>Delete them too</button>
                          <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setForget(null)}>Back</button>
                        </>
                      ) : (
                        <button type="button" className="b-btn b-btn--ghost b-btn--row" disabled={!!busy} onClick={() => setForget(l.id)}>Disconnect</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {banks ? (
            <div className="b-money-banks">
              <input className="b-input" placeholder="Search Danish banks" aria-label="Search banks" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="b-money-banklist">
                {shown.map((i) => (
                  <button key={i.id} type="button" className="b-money-bankrow" disabled={!!busy} onClick={() => void act(`link-${i.id}`, () => bank.connectBank(i))}>
                    {i.logo ? <img src={i.logo} alt="" loading="lazy" /> : <span className="b-money-bankrow-i" aria-hidden />}
                    <span>{i.name}</span>
                    <em>{busy === `link-${i.id}` ? 'Opening…' : `${i.history_days} days of history`}</em>
                  </button>
                ))}
                {!shown.length ? <p className="b-money-note">No bank by that name.</p> : null}
              </div>
              <p className="b-money-note">Your browser opens your bank’s consent page. When you are done there, come back to Atlas; the link is checked as soon as this window is in front again.</p>
            </div>
          ) : (
            <div className="b-money-actions">
              <button type="button" className="b-btn b-btn--primary" disabled={!!busy} onClick={() => void act('banks', async () => setBanks(await bank.institutions('dk')))}>{busy === 'banks' ? 'Asking GoCardless…' : links.length ? 'Connect another bank' : 'Choose your bank'}</button>
              <button type="button" className="b-btn b-btn--ghost" disabled={!!busy} onClick={() => void act('clear', () => bank.clearKeys())}>Remove the keys</button>
            </div>
          )}
        </>
      )}
      {error ? <p className="b-money-err-p">{error}</p> : null}
    </section>
  );
}
