/**
 * The Beta Money — `/money` while the beta_ui flag is on (Beta redesign
 * phase 4, `Atlas Money Beta.dc.html`; rows 31–37 of
 * docs/design-sync/2026-10-28-left-out-features.md).
 *
 * The design is drawn around a bank feed, and Atlas now has one that stays on
 * this Mac: the bank store (db_schema.sql "MONEY", src/hooks/useBank.ts),
 * filled from a netbank CSV export or, optionally, a read-only GoCardless
 * link. So the hero is the design's budget ring — this month's spend by
 * category against the user's own limits, with the even-pace tick — and its
 * category chips filter the ring, the line and the list together. The line is
 * the thirty-day projection from the recurring payments Atlas found; the
 * lists are the transactions, the subscriptions among those payments, and the
 * user's savings goals. The brokerage portfolio keeps its place as an account.
 *
 * Nothing here is sample data: with no rows the screen says so and offers the
 * two ways in. The design's held-payment approval (row 38) stays out — banks
 * give Atlas read access only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useBank } from '@/hooks/useBank';
import {
  RING_R as R, categoryLinePoints, categoryMonth, categoryOf, chipEvents, eventSentence, paceSentence, projectionPoints, quickStep,
  type CategoryId, type LedgerTx, type Subscription,
} from '@/lib/bankLedger';
import { dayLabel, flowAxis, initialsOf, money, pct, spendRows } from '@/lib/betaMoney';
import { parseAmount } from '@/lib/bankCsv';
import { MoneyImport } from '@/components/atlas/money/MoneyImport';
import { MoneyConnect } from '@/components/atlas/money/MoneyConnect';
import { CategorySelect, MoneyLimits, MoneySorting } from '@/components/atlas/money/MoneyPanels';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { setTalkAnchor } from '@/lib/talkBus';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/money.css';

type Panel = 'import' | 'connect' | 'limits' | 'sorting' | null;
interface Undo { text: string; run: () => Promise<void> }

const RING_C = 2 * Math.PI * R;
const CADENCE: Record<Subscription['cadence'], string> = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const BetaMoney = () => {
  const navigate = useBetaNavigate();
  const p = usePortfolio();
  const bank = useBank();
  const { model, data, today } = bank;
  const [cat, setCat] = useState<CategoryId | null>(null);
  const [grown, setGrown] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [ev, setEv] = useState(0);
  const [txLimit, setTxLimit] = useState(12);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goalForm, setGoalForm] = useState(false);
  // Deletes ask twice, inline: the key of the row waiting for its second press.
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // The goal whose "Other amount" field is open, and what is typed in it.
  const [amountFor, setAmountFor] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState('');
  const [sphereEl, setSphereEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => { const t = window.setTimeout(() => setGrown(true), 120); return () => window.clearTimeout(t); }, []);
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!isTyping(e.target) && e.key === 'Escape') navigate('/'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 10_000);
    return () => window.clearTimeout(t);
  }, [undo]);

  const cur = model.currency;
  const fmt = useCallback((v: number) => money(v, cur), [cur]);
  const ring = model.ring;
  const rows = useMemo(() => spendRows(model), [model]);
  const sel = cat ? rows.find((r) => r.id === cat) ?? { id: cat, label: categoryOf(cat).label, spent: 0, limit: null } : null;

  // The arcs grow in on entry, like the design's.
  const arcs = useMemo(() => ring.arcs.map((a) => (grown ? a : { ...a, dash: `0 ${RING_C.toFixed(1)}` })), [ring.arcs, grown]);

  const done = useCallback((text: string) => { setNotice(text); setPanel(null); }, []);
  const attempt = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e) { setError(errText(e)); }
  }, []);
  const withUndo = useCallback(async (text: string, fn: () => Promise<() => Promise<void>>) => {
    setError(null);
    try { const run = await fn(); setUndo({ text, run }); } catch (e) { setError(errText(e)); }
  }, []);

  // --- Hero copy -----------------------------------------------------------------
  const month = new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { month: 'long' });
  const heroLabel = !model.hasData ? 'No bank data yet' : sel ? `${sel.label} this month` : ring.mode === 'budget' ? 'Left to spend this month' : 'Spent this month';
  const heroValue = !model.hasData ? '—' : sel ? fmt(sel.spent) : ring.mode === 'budget' ? fmt(ring.left) : fmt(ring.spent);
  const paceLine = model.hasData ? paceSentence(ring, fmt) : null;
  const paceTone = ring.mode === 'budget' ? (ring.over ? 'down' : 'up') : '';
  const stale = model.newest && model.newest < today && (new Date(`${today}T12:00:00`).getTime() - new Date(`${model.newest}T12:00:00`).getTime()) / 86_400_000 > 3;
  const atlasLine = !model.hasData
    ? 'Import a CSV export from your netbank, or connect a bank read-only through GoCardless. Either way the transactions stay on this Mac, and Atlas builds the budget, the next thirty days and your subscriptions from them.'
    : sel
      ? `${sel.label} is ${fmt(sel.spent)} this month${sel.limit ? `, ${Math.round((sel.spent / sel.limit) * 100)}% of its ${fmt(sel.limit)} limit` : ''}.`
      : [
          model.subTotals.count ? `${model.subTotals.count} ${model.subTotals.count === 1 ? 'subscription costs' : 'subscriptions cost'} ${fmt(model.subTotals.monthly)} a month.` : null,
          model.unsorted.length ? `${model.unsorted.length} ${model.unsorted.length === 1 ? 'merchant is' : 'merchants are'} not sorted yet.` : null,
          stale ? `The newest transaction is from ${dayLabel(model.newest!, today)}; import a newer export to catch up.` : null,
        ].filter(Boolean).join(' ') || 'Every payment this month is sorted.';
  const sphereState = bank.loading || p.isSyncing ? 'working' : ring.over ? 'alert' : undefined;

  // --- The line ------------------------------------------------------------------
  const proj = model.projection;
  const projPts = useMemo(() => projectionPoints(proj), [proj]);
  const chips = useMemo(() => chipEvents(proj.events), [proj.events]);
  const evSel = chips[Math.min(ev, chips.length - 1)] ?? null;
  const catLine = useMemo(() => {
    if (!cat) return null;
    const m = categoryMonth(model.ledger, cat, today);
    return { ...m, pts: categoryLinePoints(m.cumulative, m.dim, model.limits.get(cat) ?? null) };
  }, [cat, model.ledger, model.limits, today]);
  const dayFmt = useCallback((d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }), []);

  // --- Lists ---------------------------------------------------------------------
  const acctName = useMemo(() => new Map(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const txs = useMemo(() => (cat ? model.ledger.filter((t) => t.category === cat) : model.ledger), [model.ledger, cat]);
  const subs = model.subs;

  const correct = (t: LedgerTx, c: CategoryId) => void attempt(() => bank.setRule(t.merchantKey, c));

  const addGoal = async (form: HTMLFormElement) => {
    const f = new FormData(form);
    const target = parseAmount(String(f.get('target') ?? '')) ?? NaN;
    await attempt(async () => {
      await bank.addGoal({ name: String(f.get('name') ?? ''), target, due_on: String(f.get('due') ?? '') || null, account_id: String(f.get('account') ?? '') || null, currency: cur });
      setGoalForm(false);
    });
  };

  const brokerage = p.connected && p.summary ? p.summary : null;

  return (
    <div className="b-money nosb" data-screen-label={`Beta — Money · ${sel ? sel.label : 'Overview'}`}>
      <div className="b-money-top">
        <section className="b-money-hero" data-beta-tone="ink" aria-label="This month">
          <div className="b-money-ring">
            <div className="b-money-ring-sphere" ref={setSphereEl}><VeilSphere size="mini" ink bg="#1e1e24" state={sphereState} /></div>
            <svg viewBox="0 0 300 300" className="b-money-ring-svg" role="img" aria-label={model.hasData ? `Spend by category${ring.mode === 'budget' ? `, ${Math.round(ring.pace * 100)}% through the month` : ''}` : 'No spending yet'}>
              <circle cx="150" cy="150" r={R} fill="none" stroke="rgba(249,247,244,.08)" strokeWidth="12" />
              {arcs.map((a) => (
                <circle key={a.id} cx="150" cy="150" r={R} fill="none" stroke={a.colour} strokeWidth="12" strokeDasharray={a.dash} strokeDashoffset={a.offset}
                  className={`b-money-arc${cat && cat !== a.id ? ' dim' : ''}`} />
              ))}
              {ring.mode === 'budget' ? <circle cx="150" cy="150" r={R} fill="none" stroke="#f9f7f4" strokeWidth="3" strokeDasharray={ring.paceDash} strokeDashoffset={ring.paceOffset} /> : null}
            </svg>
            <span className="b-money-ring-cap">
              {ring.mode === 'budget' ? 'Ring = budget · white tick = where you’d be on an even pace' : ring.mode === 'spend' ? 'Ring = this month’s spend by category' : 'Ring = your budget, once there are transactions'}
            </span>
          </div>
          <div className="b-money-hero-text">
            <button type="button" className="b-eyebrow b-eyebrow--onink b-money-back" title="Back to Home · Esc" onClick={() => navigate('/')}>Money · {month}</button>
            <div>
              <span className="b-money-label">{heroLabel}</span>
              <span className="b-money-big b-num">{heroValue}</span>
              {paceLine && !sel ? <span className={`b-money-pace ${paceTone}`}>{paceLine}</span> : null}
              {sel?.limit ? <span className={`b-money-pace ${sel.spent > sel.limit ? 'down' : 'up'}`}>{sel.spent > sel.limit ? `Over its limit by ${fmt(sel.spent - sel.limit)}` : `${fmt(sel.limit - sel.spent)} left of ${fmt(sel.limit)}`}</span> : null}
            </div>
            <p className="b-money-line">{atlasLine}</p>
            {model.hasData ? (
              <div className="b-money-cats" role="group" aria-label="Filter by category">
                {rows.map((r) => (
                  <button type="button" key={r.id} aria-pressed={cat === r.id} className={`b-money-cat${cat === r.id ? ' on' : ''}`} onClick={() => setCat(cat === r.id ? null : r.id)}>
                    <i style={{ background: categoryOf(r.id).ring }} />{r.label}<span className="b-num">{fmt(r.spent)}</span>
                  </button>
                ))}
                <button type="button" className="b-money-cat b-money-cat--quiet" onClick={() => setPanel('limits')}>{ring.mode === 'budget' ? 'Limits' : 'Set limits'}</button>
              </div>
            ) : (
              <div className="b-money-cats">
                <button type="button" className="b-btn b-btn--paper" onClick={() => setPanel('import')}>Import a CSV</button>
                <button type="button" className="b-btn b-btn--onink" onClick={() => setPanel('connect')}>Connect a bank</button>
              </div>
            )}
            {bank.error ? <p className="b-money-err">{bank.error}</p> : null}
          </div>
        </section>

        <section className="b-money-side" aria-label="Accounts">
          {data.accounts.map((a) => (
            <div key={a.id} className={`b-money-acct${a.is_excluded ? ' out' : ''}`}>
              <span className="b-money-acct-ico">{initialsOf(a.institution ?? a.name)}</span>
              <span className="b-money-acct-text">
                <b>{a.name}</b>
                <span>{[a.iban_last4 ? `•••• ${a.iban_last4}` : null, a.source === 'gocardless' ? 'Via GoCardless' : 'From CSV', a.is_excluded ? 'Not in the budget' : null].filter(Boolean).join(' · ')}</span>
                <span className="b-money-acct-tools">
                  <button type="button" className="b-money-link" onClick={() => void attempt(() => bank.updateAccount(a.id, { is_excluded: !a.is_excluded }))}>{a.is_excluded ? 'Count in budget' : 'Leave out of budget'}</button>
                  {a.source === 'csv' ? (
                    confirmDel === `acct:${a.id}`
                      ? <button type="button" className="b-money-link danger" onClick={() => { setConfirmDel(null); void attempt(() => bank.deleteAccount(a.id)); }}>Delete it and its transactions</button>
                      : <button type="button" className="b-money-link" onClick={() => setConfirmDel(`acct:${a.id}`)}>Delete</button>
                  ) : null}
                </span>
              </span>
              <span className="b-money-acct-v b-num">{a.balance !== null ? money(a.balance, a.currency) : '—'}</span>
            </div>
          ))}
          {brokerage ? (
            <div className="b-money-acct ink">
              <span className="b-money-acct-ico">IB</span>
              <span className="b-money-acct-text"><b>Brokerage</b><span>{pct(brokerage.unrealized_pct)} unrealised · {brokerage.holdings_count} holdings</span></span>
              <span className="b-money-acct-v b-num">{money(brokerage.total_value, brokerage.currency)}</span>
            </div>
          ) : p.available && p.hasCredentials && !p.connected ? (
            <div className="b-money-acct">
              <span className="b-money-acct-ico">IB</span>
              <span className="b-money-acct-text"><b>Brokerage</b><span>Not connected</span></span>
              <button type="button" className="b-btn b-btn--card b-btn--row" disabled={p.isConnecting} onClick={() => void p.connect()}>{p.isConnecting ? 'Connecting…' : 'Connect'}</button>
            </div>
          ) : null}
          {!data.accounts.length && !brokerage ? (
            <div className="b-money-acct"><span className="b-money-acct-text"><b>No accounts</b><span>{bank.available ? 'Import a CSV or connect a bank' : 'Money keeps its data in the Mac app'}</span></span></div>
          ) : null}
          <div className="b-money-held">
            <span className="b-money-held-t"><i />{data.links.some((l) => l.status === 'LN') ? 'A bank is connected, read-only' : 'Your money stays on this Mac'}</span>
            <span className="b-money-held-b">
              {data.links.some((l) => l.status === 'LN')
                ? 'Transactions pass through GoCardless on their way here and are stored only on this Mac. Atlas cannot move money.'
                : 'Import a netbank CSV, or connect a bank read-only through GoCardless. Atlas cannot move money either way.'}
            </span>
            <div className="b-money-held-actions">
              <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => setPanel(panel === 'import' ? null : 'import')}>Import a CSV</button>
              <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => setPanel(panel === 'connect' ? null : 'connect')}>{data.links.length ? 'Bank connection' : 'Connect a bank'}</button>
              {model.hasData ? <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => setPanel(panel === 'sorting' ? null : 'sorting')}>Sorting{model.unsorted.length ? ` · ${model.unsorted.length}` : ''}</button> : null}
            </div>
          </div>
        </section>
      </div>

      {notice ? <div className="b-money-notice" role="status"><span>{notice}</span><button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setNotice(null)}>OK</button></div> : null}
      {error ? <div className="b-money-notice err" role="alert"><span>{error}</span><button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setError(null)}>OK</button></div> : null}

      {panel === 'import' ? <MoneyImport bank={bank} onClose={() => setPanel(null)} onDone={done} /> : null}
      {panel === 'connect' ? <MoneyConnect bank={bank} onClose={() => setPanel(null)} onDone={setNotice} /> : null}
      {panel === 'limits' ? <MoneyLimits bank={bank} onClose={() => setPanel(null)} /> : null}
      {panel === 'sorting' ? <MoneySorting bank={bank} onClose={() => setPanel(null)} onDone={setNotice} /> : null}

      {model.hasData ? (
        catLine && sel ? (
          <section className="b-money-flow" aria-label={`${sel.label} this month`}>
            <div className="b-money-flow-head"><span className="b-money-h2">{sel.label}, day by day</span><span>{sel.limit ? 'Spend so far against an even pace to the limit' : 'Spend so far this month'}</span></div>
            <div className="b-money-chart">
              <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden>
                <polygon points={catLine.pts.area} fill="#eef2fe" />
                {catLine.pts.pace ? <polyline points={catLine.pts.pace} fill="none" stroke="#b6b1aa" strokeWidth="1.2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" /> : null}
                {catLine.pts.limitY !== null ? <line x1="0" x2="300" y1={catLine.pts.limitY} y2={catLine.pts.limitY} stroke="#d0453a" strokeWidth="1.2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" /> : null}
                <polyline points={catLine.pts.line} fill="none" stroke={categoryOf(sel.id).tint} strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="b-money-axis"><span>1 {month.slice(0, 3)}</span><span>{fmt(catLine.total)} so far</span><span>{catLine.dim} {month.slice(0, 3)}</span></div>
          </section>
        ) : (
          <section className="b-money-flow" aria-label="The next 30 days">
            <div className="b-money-flow-head">
              <span className="b-money-h2">The next 30 days</span>
              <span>{proj.known ? 'Atlas projects your balance from bills, salary and how you usually spend' : 'The change from today, from bills, salary and how you usually spend; balances appear once every account has one'}</span>
            </div>
            <div className="b-money-chart">
              <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden>
                <polygon points={projPts.area} fill="#eef2fe" />
                <polyline points={projPts.line} fill="none" stroke="#3461f2" strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                {projPts.zeroY !== null ? <line x1="0" x2="300" y1={projPts.zeroY} y2={projPts.zeroY} stroke="#d0453a" strokeWidth="1.2" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" /> : null}
              </svg>
              {chips.map((e, i) => (
                <button
                  type="button" key={e.id} title={e.label} aria-pressed={evSel?.id === e.id}
                  className={`b-money-chip${evSel?.id === e.id ? ' on' : ''}${e.amount > 0 ? ' in' : ''}`}
                  style={{ left: `${Math.max(10, Math.min(90, (e.day / 30) * 100)).toFixed(1)}%`, top: `${Math.max(12, Math.min(88, projPts.y(proj.points[e.day]) - 14))}%` }}
                  onClick={() => setEv(i)}
                >
                  {e.label} {e.amount > 0 ? '+' : ''}{fmt(e.amount)}
                </button>
              ))}
            </div>
            <div className="b-money-axis">{flowAxis(today).map((d, i) => <span key={i}>{d}</span>)}</div>
            <div className="b-money-event">
              {evSel ? eventSentence(evSel, proj, fmt, dayFmt) : 'No recurring payments or income were found in the transactions yet; the line is everyday spending only.'}
              {model.spendDays ? ` Everyday spending is about ${fmt(proj.perDay)} a day, from the last ${model.spendDays} days.` : ''}
            </div>
          </section>
        )
      ) : null}

      {undo ? (
        <div className="b-money-notice" role="status">
          <span>{undo.text}</span>
          <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => { const u = undo; setUndo(null); void attempt(u.run); }}>Undo</button>
        </div>
      ) : null}

      {model.hasData || data.goals.length || bank.available ? (
        <div className="b-money-tri">
          <section className="b-money-list" aria-label="Transactions">
            <div className="b-money-list-head">
              <span className="b-money-h2">{sel ? sel.label : 'Latest'}</span>
              {cat ? <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => setCat(null)}>Show all</button> : null}
            </div>
            {txs.slice(0, txLimit).map((t) => {
              const c = categoryOf(t.category);
              return (
                <div key={t.id} className="b-money-tx">
                  <span className="b-money-tx-ico" style={{ background: c.tint }}>{initialsOf(t.merchant).slice(0, 2)}</span>
                  <span className="b-money-tx-text">
                    <b>{t.merchant}</b>
                    <span>{[dayLabel(t.booked_on, today), acctName.get(t.account_id), t.excluded ? 'not in budget' : null].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="b-money-tx-v">
                    <span className={t.amount > 0 ? 'b-money-in' : ''}>{t.amount > 0 ? '+' : ''}{money(t.amount, t.currency ?? cur, 2)}</span>
                    <CategorySelect label={`Category for ${t.merchant}`} value={t.category} onChange={(c2) => correct(t, c2)} />
                  </span>
                </div>
              );
            })}
            {txs.length > txLimit ? <button type="button" className="b-btn b-btn--card b-money-more" onClick={() => setTxLimit((n) => n + 30)}>Show more</button> : null}
            {!txs.length ? <div className="b-money-empty">{cat ? 'Nothing in this category yet.' : 'No transactions yet.'}</div> : null}
          </section>

          <section className="b-money-list" aria-label="Subscriptions">
            <span className="b-money-list-head"><span className="b-money-h2">Subscriptions</span></span>
            {subs.map((s) => (
              <div key={s.key} className={`b-money-sub${s.status === 'cancelled' ? ' off' : ''}`}>
                <span className="b-money-sub-t">
                  <b>{s.merchant}</b>
                  <span>{s.status === 'cancelled' ? 'Marked cancelled · not counted' : `${CADENCE[s.cadence]} · next ${dayLabel(s.next, today)}${s.reminded ? ' · reminder added' : ''}`}</span>
                </span>
                <span className="b-num">{money(s.amount, cur, 2)}</span>
                <span className="b-money-sub-a">
                  {s.status === 'cancelled' ? (
                    <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void withUndo(`${s.merchant} counts again.`, () => bank.markSubscription(s, null))}>Undo</button>
                  ) : (
                    <>
                      {!s.reminded ? (
                        <button type="button" className="b-btn b-btn--warn b-btn--row" title={s.url ? 'Adds a task and opens the merchant’s account page' : 'Adds a task to cancel it'} onClick={() => void withUndo(`A task to cancel ${s.merchant} was added${s.url ? ' and its account page opened' : ''}.`, () => bank.remindCancel(s))}>Cancel</button>
                      ) : null}
                      <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void withUndo(`${s.merchant} is marked cancelled.`, () => bank.markSubscription(s, 'cancelled'))}>Mark cancelled</button>
                      <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => void withUndo(`${s.merchant} is no longer listed.`, () => bank.markSubscription(s, 'ignored'))}>Not one</button>
                    </>
                  )}
                </span>
              </div>
            ))}
            {!subs.length ? <div className="b-money-empty">No subscriptions found. They appear once a payment has repeated every month, quarter or year.</div> : null}
            <div className="b-money-sub-total">
              {subs.length ? `${fmt(model.subTotals.monthly)} a month across ${model.subTotals.count}` : ''}
              {model.subTotals.saved ? ` · saving ${fmt(model.subTotals.saved)} a month from cancellations` : ''}
              {subs.length ? '. Atlas cannot cancel at the merchant: Cancel adds a reminder task.' : ''}
            </div>
          </section>

          <section className="b-money-goals" aria-label="Savings goals">
            {model.goals.map((g, i) => {
              const step = quickStep(cur);
              return (
                <div key={g.id} className={`b-money-goal${i === 1 ? ' ink' : ''}`}>
                  <span className="b-money-goal-h">{g.name}<span>{g.due_on ? new Date(`${g.due_on}T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : 'No date'}</span></span>
                  <span className="b-money-goal-v b-num">{fmt(g.saved)}<span> of {fmt(g.target)}</span></span>
                  <span className="b-money-goal-bar"><span style={{ width: `${g.pct}%` }} /></span>
                  <span className="b-money-goal-s">
                    {g.done ? 'Reached.' : g.perMonth ? `${fmt(g.perMonth)} a month gets you there.` : `${fmt(g.left)} to go.`}
                    {g.linked ? ` Follows ${g.accountName}’s balance.` : ''}
                  </span>
                  <span className="b-money-goal-a">
                    {!g.linked ? (
                      <>
                        <button type="button" className="b-money-goal-btn" onClick={() => void withUndo(`${fmt(step)} added to ${g.name}.`, () => bank.addToGoal(g.id, step))}>+ {fmt(step)}</button>
                        {amountFor === g.id ? (
                          <form className="b-money-goal-amount" onSubmit={(e) => {
                            e.preventDefault();
                            const n = parseAmount(amountDraft) ?? NaN;
                            if (!Number.isFinite(n) || n === 0) { setError('Enter an amount, like 250; a negative one takes money out.'); return; }
                            setAmountFor(null);
                            setAmountDraft('');
                            void withUndo(`${fmt(n)} ${n > 0 ? 'added to' : 'taken from'} ${g.name}.`, () => bank.addToGoal(g.id, n));
                          }}>
                            <input className="b-input b-num" autoFocus inputMode="decimal" placeholder="250 or −250" aria-label={`Amount for ${g.name}`} value={amountDraft} onChange={(e) => setAmountDraft(e.target.value)} />
                            <button type="submit" className="b-money-goal-btn">Add</button>
                          </form>
                        ) : (
                          <button type="button" className="b-money-goal-btn" onClick={() => { setAmountFor(g.id); setAmountDraft(''); }}>Other amount</button>
                        )}
                      </>
                    ) : null}
                    {confirmDel === `goal:${g.id}`
                      ? <button type="button" className="b-money-goal-btn danger" onClick={() => { setConfirmDel(null); void attempt(() => bank.deleteGoal(g.id)); }}>Delete the goal</button>
                      : <button type="button" className="b-money-goal-btn" onClick={() => setConfirmDel(`goal:${g.id}`)}>Delete</button>}
                  </span>
                </div>
              );
            })}
            {goalForm ? (
              <form className="b-money-goal b-money-goal-form" onSubmit={(e) => { e.preventDefault(); void addGoal(e.currentTarget); }}>
                <span className="b-money-goal-h">New goal</span>
                <input className="b-input" name="name" placeholder="Lisbon trip" aria-label="Goal name" required maxLength={80} />
                <input className="b-input b-num" name="target" inputMode="decimal" placeholder={`Target, ${cur}`} aria-label="Target amount" required />
                <label className="b-money-field"><span>By (optional)</span><input className="b-input" name="due" type="date" min={today} /></label>
                {data.accounts.length ? (
                  <label className="b-money-field">
                    <span>Saved amount</span>
                    <select className="b-money-select" name="account" defaultValue="">
                      <option value="">What I add here</option>
                      {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}’s balance</option>)}
                    </select>
                  </label>
                ) : null}
                <span className="b-money-goal-a">
                  <button type="submit" className="b-btn b-btn--primary b-btn--row">Add goal</button>
                  <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={() => setGoalForm(false)}>Cancel</button>
                </span>
              </form>
            ) : (
              <button type="button" className="b-money-goal b-money-goal-add" disabled={!bank.available} onClick={() => setGoalForm(true)}>+ A savings goal</button>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
};

export default BetaMoney;
