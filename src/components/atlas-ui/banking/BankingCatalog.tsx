import { useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { Empty } from '@/components/atlas-ui/primitives';
import { MoneyCard } from './MoneyCard';
import { CATALOG_SIZES, type BankingAccounts } from '@/lib/mocks/banking';

/**
 * The widget catalog.
 *
 * Every money widget drawn at ONE chosen size, in one or both skins, on the same
 * twelve-column grid the money view uses. It is a specimen sheet: the point is
 * to see how each of the seven body shapes degrades as the box shrinks — which
 * lists collapse to a headline figure at S, which bar series lose their tail,
 * where the 58px display size stops fitting.
 *
 * The design offers Glass, Ink and Both. `Both` renders each widget twice, which
 * is 80-odd tiles; that is the design's own default and it is what makes the two
 * skins comparable at a glance, so it stays the default here.
 *
 * SIZE AND SKIN ARE LOCAL STATE, not URL or persisted settings. Nothing here is
 * a user preference — it is a viewing control for a reference page.
 *
 * The catalog is built from the same card definitions as the money grid, so with
 * no connection it has nothing to draw. It says that rather than rendering an
 * empty twelve-column grid.
 */

interface BankingCatalogProps {
  accounts: BankingAccounts | null;
  sample: boolean;
}

type SkinChoice = 'both' | 'glass' | 'ink';

const SKINS: Array<{ id: SkinChoice; label: string }> = [
  { id: 'both', label: 'Both' },
  { id: 'glass', label: 'Glass' },
  { id: 'ink', label: 'Ink' },
];

export const BankingCatalog = ({ accounts, sample }: BankingCatalogProps) => {
  const [sizeId, setSizeId] = useState('l');
  const [skin, setSkin] = useState<SkinChoice>('both');

  const size = CATALOG_SIZES.find((s) => s.id === sizeId) ?? CATALOG_SIZES[2];
  const skins: Array<'glass' | 'ink'> = skin === 'both' ? ['glass', 'ink'] : [skin];

  if (!accounts || accounts.cards.length === 0) {
    return (
      <Empty
        size="section"
        icon={<LayoutGrid className="i20" />}
        title="Nothing to draw"
        body="The widget set is generated from your accounts — one specimen per figure Atlas can read. With no bank connected there are no figures, so there are no widgets."
        status="stale"
      />
    );
  }

  return (
    <>
      <div className="bank-catalog-bar">
        <div className="bank-chiprow" role="group" aria-label="Widget size">
          {CATALOG_SIZES.map((s) => (
            <button
              key={s.id}
              className={`bank-chip${s.id === sizeId ? ' on' : ''}`}
              onClick={() => setSizeId(s.id)}
              aria-pressed={s.id === sizeId}
              title={`${s.label} — ${s.dim}`}
            >
              {s.label}
              <span className="bank-chip-meta tnum">{s.dim}</span>
            </button>
          ))}
        </div>
        <div className="bank-chiprow" role="group" aria-label="Card skin">
          {SKINS.map((s) => (
            <button
              key={s.id}
              className={`bank-chip${s.id === skin ? ' on' : ''}`}
              onClick={() => setSkin(s.id)}
              aria-pressed={s.id === skin}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="bank-catalog-count tnum">
          {accounts.cards.length * skins.length} widgets · {size.dim}
        </p>
      </div>

      <div className="bank-grid">
        {accounts.cards.map((card) =>
          skins.map((sk) => (
            <MoneyCard
              key={`${card.id}-${sk}`}
              card={card}
              placement={{ cols: size.cols, rows: size.rows }}
              skin={sk}
              sample={sample}
              tag={skin === 'both' ? (sk === 'ink' ? 'Ink' : 'Glass') : undefined}
            />
          )),
        )}
      </div>
    </>
  );
};
