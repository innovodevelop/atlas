/**
 * Atlas Banking — the money surface (`Atlas Banking.dc.html`).
 *
 * A twelve-column grid on 126px rows carrying money cards, a widget catalog cut
 * from the same definitions, and a connections view.
 *
 * ── EVERY FIGURE ON THIS SCREEN IS FICTION ────────────────────────────────
 *
 * There is no bank data source in Atlas. `src/hooks/usePortfolio.ts` covers
 * brokerage holdings over a local Tauri bridge and returns nothing without a
 * link; the bank side has no adapter at all, and the Mastercard Open Finance
 * registration is sandbox-only, so a shipped build cannot connect an account
 * even in principle. `src/lib/mocks/banking.ts` supplies the numbers.
 *
 * Money that looks real but is not is the worst thing this bundle could ship,
 * so the label is structural rather than a footnote. Three layers, and all three
 * are load-bearing:
 *
 *   1. `<BankingNotice>` — a standing, non-dismissible amber notice above the
 *      grid in every view, naming the provider and the sandbox state.
 *   2. `<MoneyCard sample>` — the word SAMPLE stamped into the header of every
 *      single tile, so one card in isolation still carries it.
 *   3. The preview switch — flips the whole surface to `accounts: null`, the
 *      state a real adapter returns on day one, so the empty states are a thing
 *      you can look at rather than dead code.
 *
 * Delete any of the three and this becomes the fabricated-data problem T4 spent
 * a week removing from Atlas Core — worse, because these numbers have currency
 * symbols on them.
 *
 * ── WHAT IS NOT MOCK ──────────────────────────────────────────────────────
 *
 * `policy` — the provider, the environment, and the five lines of "What Atlas
 * may do". Those are true statements about the product and stay true with or
 * without a connection, which is why the snapshot keeps them separate from
 * `accounts`.
 *
 * ── CHROME ────────────────────────────────────────────────────────────────
 *
 * `.page` root with the band header (`.bandB` / `.greetB` / `.gsubB`), the same
 * as the dashboard. Back-navigation is the clickable headline plus Esc — there
 * is no back link in the header, per the app's own pattern. No dock is rendered
 * here; the wiring pass owns that.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Landmark, WalletCards } from 'lucide-react';
import { Empty } from '@/components/atlas-ui/primitives';
import { MoneyCard } from '@/components/atlas-ui/banking/MoneyCard';
import { BankingNotice, type BankingPreview } from '@/components/atlas-ui/banking/BankingNotice';
import { BankingCatalog } from '@/components/atlas-ui/banking/BankingCatalog';
import { BankingConnections } from '@/components/atlas-ui/banking/BankingConnections';
// THE SEAM. A real adapter replaces this one line — see the header of
// `src/lib/mocks/banking.ts` for the swap and why nothing else has to change.
import {
  useBankingData, IS_MOCK, MONEY_SCOPES,
  type MoneyScope, type MoneyPlacement, type MoneyCardData,
} from '@/lib/mocks/banking';
import '@/styles/surfaces/banking.css';

type BankingView = 'money' | 'catalog' | 'connections';

const VIEWS: Array<{ id: BankingView; label: string }> = [
  { id: 'money', label: 'Money' },
  { id: 'catalog', label: 'Widget set' },
  { id: 'connections', label: 'Connections' },
];

const AtlasBanking = () => {
  const navigate = useNavigate();
  const { loading, error, policy, accounts } = useBankingData();

  const [view, setView] = useState<BankingView>('money');
  const [scope, setScope] = useState<MoneyScope>('all');
  const [preview, setPreview] = useState<BankingPreview>('sample');

  // The preview switch is the ONLY thing that suppresses the dataset, and it
  // does so by producing exactly what a live adapter yields before a first
  // connection: null. Nothing downstream needs a second code path.
  const live = preview === 'empty' ? null : accounts;

  const back = useCallback(() => navigate('/'), [navigate]);

  // Esc returns to the dashboard — the app's pattern (AtlasDashboard's own Esc
  // handler, `.greetB.returnable`). Ignored while focus sits in a field so a
  // future search box does not eject the user mid-keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  /**
   * The placed money grid, filtered by entity.
   *
   * `all` is not a card property — it is the absence of a filter. Cards that
   * belong to both entities (FX, card controls, the spoken summary) appear under
   * either, which is the design's behaviour and not a duplication bug.
   */
  const placed = useMemo<Array<{ placement: MoneyPlacement; card: MoneyCardData }>>(() => {
    if (!live) return [];
    const byId = new Map(live.cards.map((c) => [c.id, c]));
    const out: Array<{ placement: MoneyPlacement; card: MoneyCardData }> = [];
    for (const placement of live.layout) {
      const card = byId.get(placement.id);
      if (!card) continue;
      // A placement whose card was dropped by the adapter is skipped, not
      // rendered as a hole — the dense flow closes the gap on its own.
      if (scope !== 'all' && !card.entities.includes(scope)) continue;
      out.push({ placement, card });
    }
    return out;
  }, [live, scope]);

  const hero = live?.hero[scope] ?? null;
  const sample = IS_MOCK && preview === 'sample';

  const subline =
    view === 'money'
      ? 'Balances, cards, spending and both entities on one grid.'
      : view === 'catalog'
        ? 'Every money widget at one size, in both skins — the specimen sheet.'
        : 'Which banks Atlas can read, and exactly what it may do with them.';

  return (
    <div className="page bank-page" data-screen-label="Atlas — Banking">
      {/* Three static wash layers from the design. Static because a transform
          on a 64px-blurred full-bleed layer re-rasters the blur every frame
          (README §5 records that costing the music surface ~15fps). */}
      <div className="bank-wash" aria-hidden>
        <span className="bank-wash-a" />
        <span className="bank-wash-b" />
        <span className="bank-wash-c" />
      </div>

      <section className="bandB bank-band">
        <div className="bank-band-main">
          <h2
            className="greetB returnable bank-headline"
            onClick={back}
            title="Back to dashboard"
          >
            Money<span className="accw">.</span>
          </h2>
          <p className="gsubB">{subline}</p>
          <p className="bank-band-hint">Click the title or press Esc to return</p>
        </div>

        <div className="bandmetaB bank-views" role="tablist" aria-label="Banking view">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              className={`bank-view${view === v.id ? ' on' : ''}`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </section>

      <main className="bank-main">
        {IS_MOCK && (
          <BankingNotice policy={policy} preview={preview} onPreviewChange={setPreview} />
        )}

        {/* `loading` and `error` never fire against the mock. They are rendered
            because a real adapter has both, and a surface that only handles the
            happy path is a surface that has to be reopened to wire one. */}
        {error && (
          <Empty
            size="block"
            icon={<Landmark className="i20" />}
            title="Could not read your accounts"
            body={error}
            status="error"
          />
        )}

        {loading && !error && <Empty body="Reading accounts…" />}

        {!loading && !error && view === 'money' && (
          live ? (
            <>
              <div className="bank-grid">
                {/* Hero: the net position for the selected entity, plus the
                    entity filter. It is a grid cell, not a header, so the
                    twelve-column rhythm starts at the top of the page. */}
                <article className="bank-card bank-card-glass bank-hero" data-cols={6} data-rows={2}>
                  <div className="bank-hero-head">
                    <p className="bank-eyebrow">{hero?.label}</p>
                    {sample && <span className="bank-stamp">Sample</span>}
                  </div>
                  <p className="bank-hero-value tnum">{hero?.value}</p>
                  <p className="bank-hero-line">{hero?.line}</p>
                  <div className="bank-scopes" role="group" aria-label="Entity">
                    {MONEY_SCOPES.map((s) => (
                      <button
                        key={s.id}
                        className={`bank-chip bank-cat-${s.category}${scope === s.id ? ' on' : ''}`}
                        onClick={() => setScope(s.id)}
                        aria-pressed={scope === s.id}
                      >
                        <span className="bank-chip-dot" aria-hidden />
                        {s.label}
                      </button>
                    ))}
                  </div>
                </article>

                {placed.map(({ card, placement }, i) => (
                  <MoneyCard
                    key={card.id}
                    card={card}
                    placement={placement}
                    sample={sample}
                    delay={i + 1}
                  />
                ))}
              </div>

              {/* A filter that matches nothing is a different state from having
                  no accounts, and says so. */}
              {placed.length === 0 && (
                <Empty
                  size="block"
                  icon={<WalletCards className="i20" />}
                  title="Nothing under this entity"
                  body="No card on the default grid belongs to the entity you picked. Switch back to Everything to see the full set."
                  action={{ label: 'Show everything', onClick: () => setScope('all'), variant: 'ghost' }}
                  status="stale"
                />
              )}
            </>
          ) : (
            <Empty
              size="section"
              icon={<Landmark className="i20" />}
              title="No accounts connected"
              body="Balances, spending, cards and entities all come from an open-banking connection. Atlas has none — its Mastercard Open Finance registration is sandbox-only, so this build cannot make one."
              action={{ label: 'What that means', onClick: () => setView('connections') }}
              status="stale"
            />
          )
        )}

        {!loading && !error && view === 'catalog' && (
          <BankingCatalog accounts={live} sample={sample} />
        )}

        {!loading && !error && view === 'connections' && (
          <BankingConnections policy={policy} accounts={live} sample={sample} />
        )}
      </main>
    </div>
  );
};

/**
 * Surface descriptor for the wiring pass.
 *
 * `entry: 'menu'` is a deliberate call, not an oversight. The design's own nav
 * treats Money as a peer of Dashboard and Health, but a permanent dock icon is a
 * product claim, and this surface cannot show a real number in any build that
 * exists today. It belongs one level in — reachable, not advertised — until a
 * bank adapter lands. Flip the word to `'dock'` at that point; nothing else in
 * this file depends on it.
 */
export const surface = {
  path: '/money',
  label: 'Money',
  icon: 'Landmark',
  entry: 'menu',
  mock: true,
  // Admin for the same reason `entry` is `'menu'`: there is no bank adapter, so
  // there is no consumer product here yet. Both flip together when one lands.
  edition: 'admin',
} as const;

export default AtlasBanking;
