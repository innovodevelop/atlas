/**
 * The Beta Money — `/money` while the beta_ui flag is on (Beta redesign
 * phase 4, `Atlas Money Beta.dc.html`).
 *
 * The design is drawn around a bank feed: budget ring, held payment, cash
 * flow, subscriptions, goals. Atlas has no bank feed (`IS_MOCK` in
 * src/lib/mocks/banking.ts — the open-banking registration is sandbox
 * only), and one real money source: the brokerage portfolio (`usePortfolio`,
 * SnapTrade). So the hero is the portfolio — its value, its month, its
 * allocation as the ring's arcs, each slice a filter — the accounts are the
 * brokerage accounts, the chart is the portfolio's last thirty days, and the
 * list is the holdings. Banking keeps its place below as the specimen it is,
 * stamped, with the policy that says what Atlas may do once a bank connects.
 * Nothing on this screen pretends to be a budget.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePortfolio, type PortfolioHolding } from '@/hooks/usePortfolio';
import { RING_R as R, arcsOf, initialsOf as INITIALS, linePoints, money, pct } from '@/lib/betaMoney';
import { useBankingData, IS_MOCK } from '@/lib/mocks/banking';
import { BankingNotice, type BankingPreview } from '@/components/atlas-ui/banking/BankingNotice';
import { BankingCatalog } from '@/components/atlas-ui/banking/BankingCatalog';
import { BankingConnections } from '@/components/atlas-ui/banking/BankingConnections';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { setTalkAnchor } from '@/lib/talkBus';
import { isTyping } from './atlasHelpers';
import '@/styles/surfaces/banking.css';

const BetaMoney = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const p = usePortfolio();
  const banking = useBankingData();
  const [slice, setSlice] = useState<string | null>(null);
  const [grown, setGrown] = useState(false);
  const [bankView, setBankView] = useState<'catalog' | 'connections'>('catalog');
  const [preview, setPreview] = useState<BankingPreview>('sample');
  const [sphereEl, setSphereEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => { const t = window.setTimeout(() => setGrown(true), 120); return () => window.clearTimeout(t); }, []);
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!isTyping(e.target) && e.key === 'Escape') navigate('/'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const currency = p.summary?.currency ?? 'USD';
  const arcs = useMemo(() => arcsOf(p.allocation ?? [], grown), [p.allocation, grown]);
  const chart = useMemo(() => linePoints(p.history ?? []), [p.history]);
  const holdings = useMemo(() => {
    const all = (p.holdings ?? []) as PortfolioHolding[];
    const filtered = slice ? all.filter((h) => h.asset_type === slice || h.account === slice || h.symbol === slice) : all;
    return [...filtered].sort((a, b) => b.market_value - a.market_value);
  }, [p.holdings, slice]);
  const accounts = useMemo(() => {
    const by = new Map<string, { value: number; n: number }>();
    for (const h of (p.holdings ?? []) as PortfolioHolding[]) {
      const cur = by.get(h.account) ?? { value: 0, n: 0 };
      cur.value += h.market_value; cur.n += 1;
      by.set(h.account, cur);
    }
    return [...by.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value);
  }, [p.holdings]);

  const connected = p.connected && !!p.summary;
  const up = (p.summary?.unrealized_pct ?? 0) >= 0;
  const month = new Date().toLocaleDateString(undefined, { month: 'long' });
  const sel = slice ? arcs.find((a) => a.label === slice) : null;
  const atlasLine = connected
    ? sel
      ? `${sel.label} is ${Math.round(sel.share * 100)}% of the portfolio.`
      : `${p.summary!.holdings_count} holdings across ${p.summary!.accounts_count} ${p.summary!.accounts_count === 1 ? 'account' : 'accounts'}, ${money(p.summary!.cash, currency)} in cash.`
    : p.available
      ? p.hasCredentials ? 'Connect your brokerage and this becomes your portfolio: value, allocation, the last thirty days, every holding.' : 'Brokerage sync needs SnapTrade credentials in Settings before it can connect.'
      : 'The portfolio syncs in the Mac app.';

  const connect = useCallback(() => { void p.connect(); }, [p]);

  return (
    <div className="b-money nosb" data-screen-label="Beta — Money">
      <div className="b-money-top">
        <section className="b-money-hero" data-beta-tone="ink" aria-label="Portfolio">
          <div className="b-money-ring">
            <div className="b-money-ring-sphere" ref={setSphereEl}><VeilSphere size="mini" ink bg="#1e1e24" state={p.isSyncing ? 'working' : undefined} /></div>
            <svg viewBox="0 0 300 300" className="b-money-ring-svg" aria-hidden>
              <circle cx="150" cy="150" r={R} fill="none" stroke="rgba(249,247,244,.08)" strokeWidth="12" />
              {arcs.map((a) => <circle key={a.label} cx="150" cy="150" r={R} fill="none" stroke={a.colour} strokeWidth="12" strokeDasharray={a.dash} strokeDashoffset={a.offset} style={{ transition: 'stroke-dasharray 1s var(--b-spring)' }} />)}
            </svg>
            <span className="b-money-ring-cap">{connected ? 'Ring = allocation' : 'Ring = allocation, once connected'}</span>
          </div>
          <div className="b-money-hero-text">
            <button type="button" className="b-eyebrow b-eyebrow--onink b-money-back" title="Back to Home · Esc" onClick={() => navigate('/')}>Money · {month}</button>
            <div>
              <span className="b-money-label">{connected ? 'Portfolio value' : 'No portfolio yet'}</span>
              <span className="b-money-big b-num">{connected ? money(p.summary!.total_value, currency) : '—'}</span>
              {connected ? <span className={`b-money-pace ${up ? 'up' : 'down'}`}>{pct(p.summary!.unrealized_pct)} · {money(p.summary!.unrealized_pnl, currency)} unrealised</span> : null}
            </div>
            <p className="b-money-line">{atlasLine}</p>
            {connected ? (
              <div className="b-money-cats">
                {arcs.map((a) => (
                  <button type="button" key={a.label} className={`b-money-cat${slice === a.label ? ' on' : ''}`} onClick={() => setSlice(slice === a.label ? null : a.label)}>
                    <i style={{ background: a.colour }} />{a.label}<span className="b-num">{Math.round(a.share * 100)}%</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="b-money-cats">
                {p.available && p.hasCredentials ? <button type="button" className="b-btn b-btn--paper" disabled={p.isConnecting} onClick={connect}>{p.isConnecting ? 'Connecting…' : 'Connect brokerage'}</button> : null}
                <button type="button" className="b-btn b-btn--onink" onClick={() => plainNavigate('/settings')}>Settings</button>
              </div>
            )}
            {p.error ? <p className="b-money-err">{p.error}</p> : null}
          </div>
        </section>

        <section className="b-money-side" aria-label="Accounts">
          {accounts.map((a, i) => (
            <div key={a.name} className={`b-money-acct${i === 0 ? ' ink' : ''}`}>
              <span className="b-money-acct-ico">{INITIALS(a.name)}</span>
              <span className="b-money-acct-text"><b>{a.name}</b><span>{a.n} {a.n === 1 ? 'holding' : 'holdings'}</span></span>
              <span className="b-money-acct-v b-num">{money(a.value, currency)}</span>
            </div>
          ))}
          {!accounts.length ? (
            <div className="b-money-acct"><span className="b-money-acct-ico"><AtlasIcon name="banking" size={18} /></span><span className="b-money-acct-text"><b>No accounts</b><span>{connected ? 'Nothing synced yet' : 'Brokerage accounts appear here'}</span></span></div>
          ) : null}
          <div className="b-money-held">
            <span className="b-money-held-t"><i />{banking.policy?.canConnect ? 'Banks can connect' : 'Banks: not yet'}</span>
            <span className="b-money-held-b">{banking.policy?.reason ?? 'Open-banking access is being registered. Until then, balances and spending are the specimen below.'}</span>
            <div className="b-money-held-actions">
              <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => setBankView('connections')}>What Atlas may do</button>
              {connected ? <button type="button" className="b-btn b-btn--card b-btn--row" disabled={p.isSyncing} onClick={() => void p.sync()}>{p.isSyncing ? 'Syncing…' : 'Sync portfolio'}</button> : null}
            </div>
          </div>
        </section>
      </div>

      {connected && chart.line ? (
        <section className="b-money-flow" aria-label="Last thirty days">
          <div className="b-money-flow-head"><span className="b-card-title b-money-h2">The last 30 days</span><span>Portfolio value, from the daily sync</span></div>
          <div className="b-money-chart">
            <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden>
              <polygon points={chart.area} fill="#eef2fe" />
              <polyline points={chart.line} fill="none" stroke="#3461f2" strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="b-money-axis"><span>{money(chart.min, currency)} low</span><span>{money(chart.max, currency)} high</span></div>
        </section>
      ) : null}

      <div className="b-money-tri">
        <section className="b-money-list" aria-label="Holdings">
          <div className="b-money-list-head"><span className="b-money-h2">{slice ? `${slice} holdings` : 'Holdings'}</span>{slice ? <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => setSlice(null)}>Show all</button> : null}</div>
          {holdings.slice(0, 12).map((h) => (
            <div key={`${h.account}-${h.symbol}`} className="b-money-tx">
              <span className="b-money-tx-ico" style={{ background: h.pnl >= 0 ? 'var(--b-green)' : 'var(--b-red)' }}>{h.symbol.slice(0, 3)}</span>
              <span className="b-money-tx-text"><b>{h.description || h.symbol}</b><span>{h.quantity} × {money(h.price, currency, 2)} · {h.account}</span></span>
              <span className="b-money-tx-v"><span className="b-num">{money(h.market_value, currency)}</span><em className={h.pnl >= 0 ? 'up' : 'down'}>{h.pnl >= 0 ? '+' : '−'}{money(Math.abs(h.pnl), currency)}</em></span>
            </div>
          ))}
          {!holdings.length ? <div className="b-money-empty">{connected ? 'No holdings in this slice.' : 'Holdings appear here once a brokerage is connected.'}</div> : null}
        </section>

        <section className="b-money-list b-money-bank" aria-label="Banking">
          <div className="b-money-list-head">
            <span className="b-money-h2">Banking</span>
            <div className="b-seg b-seg--small" role="tablist">
              <button type="button" role="tab" aria-selected={bankView === 'catalog'} className={bankView === 'catalog' ? 'on' : ''} onClick={() => setBankView('catalog')}>Widget set</button>
              <button type="button" role="tab" aria-selected={bankView === 'connections'} className={bankView === 'connections' ? 'on' : ''} onClick={() => setBankView('connections')}>Connections</button>
            </div>
          </div>
          {IS_MOCK ? <BankingNotice policy={banking.policy} preview={preview} onPreviewChange={setPreview} /> : null}
          {banking.loading ? <div className="b-money-empty">Reading…</div> : bankView === 'catalog'
            ? <BankingCatalog accounts={preview === 'empty' ? null : banking.accounts} sample={IS_MOCK && preview === 'sample'} />
            : <BankingConnections policy={banking.policy} accounts={preview === 'empty' ? null : banking.accounts} sample={IS_MOCK && preview === 'sample'} />}
        </section>
      </div>
    </div>
  );
};

export default BetaMoney;
