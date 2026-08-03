import type { CSSProperties } from 'react';
import type { MoneyCardData, MoneyPlacement } from '@/lib/mocks/banking';

/**
 * One tile on the banking grid.
 *
 * WHY NOT `<Card>`. The shared primitive is the right component for the
 * dashboard, whose grid is `repeat(auto-fill, minmax(340px, 1fr))` — its
 * `size` prop maps onto `.sp2` / `.rs2`, i.e. spans of ONE or TWO columns. The
 * banking design is a twelve-column grid on 126px rows where the real spans are
 * 2, 3 and 6. Passing `size="m"` here would span two of twelve and render a
 * sliver. Card's own docstring already flags that its size model cannot express
 * the catalog's grid; this is that limit reached. Everything else on the surface
 * — the connections panels, rows, empties and buttons — is the shared set.
 *
 * SIZE DRIVES CONTENT, which is the design's actual algorithm and not a
 * styling detail: a `rows` card with one grid row has no room for a list, so it
 * falls back to its headline figure; a `text` card in a narrow single-row slot
 * does the same. Row lists and bar series truncate to what the box holds. The
 * arithmetic below is ported from `Atlas Banking.dc.html`'s `card()`; the
 * resulting numbers are published as custom properties so `banking.css` owns
 * every actual declaration.
 *
 * THE STAMP IS NOT DECORATION. `sample` renders SAMPLE into the header, in the
 * slot the design reserves for the catalog's Glass/Ink tag. It is the last line
 * of defence for a user who scrolls past the page-level notice: no single money
 * card can be screenshotted, focused or read aloud without carrying the word.
 * Do not make it conditional on hover, and do not remove it while
 * `IS_MOCK` is true.
 */

interface MoneyCardProps {
  card: MoneyCardData;
  placement: Pick<MoneyPlacement, 'cols' | 'rows'>;
  skin?: 'glass' | 'ink';
  /** Stamps SAMPLE into the header. True for every card while the data is mock. */
  sample?: boolean;
  /** Catalog only — the Glass / Ink tag the design puts in the same slot. */
  tag?: string;
  /** Entry-animation stagger index. Capped at 12 to match `.bank-d1`…`.bank-d12`. */
  delay?: number;
}

export const MoneyCard = ({ card, placement, skin = 'glass', sample, tag, delay }: MoneyCardProps) => {
  const { cols, rows } = placement;
  const tall = rows >= 2;
  const huge = rows >= 3;
  const wide = cols >= 6;

  // A one-row card cannot hold a list; three rows hold five entries.
  const rowCap = huge ? 5 : tall ? 3 : 0;
  const canRows = card.kind === 'rows' && rowCap > 0;
  // Fallbacks, in the design's own precedence: a list that will not fit and a
  // paragraph that will not fit both collapse to the headline figure.
  const asBig =
    card.kind === 'big' ||
    (card.kind === 'rows' && !canRows) ||
    (card.kind === 'text' && !tall && cols < 4);

  // Type and metric scale, published as custom properties so banking.css owns
  // every declaration. Written through the repo's existing pattern for custom
  // properties in an inline style (see AtlasExtraCards' `--aq-band`).
  const style: CSSProperties = {
    ['--bk-pad' as string]: `${huge ? 22 : tall ? 18 : 15}px`,
    ['--bk-big' as string]: `${huge ? 58 : tall ? (wide ? 48 : 36) : cols >= 3 ? 28 : 23}px`,
    ['--bk-mid' as string]: `${huge ? 32 : tall ? 23 : 17}px`,
    ['--bk-text' as string]: `${huge ? 21 : tall ? 15.5 : 13}px`,
    ['--bk-bar-h' as string]: `${huge ? 132 : tall ? 68 : 34}px`,
    ['--bk-bar-gap' as string]: `${wide ? 5 : 3}px`,
  };

  const items = (card.items ?? []).slice(0, rowCap);
  const bars = (card.bars ?? []).slice(0, wide ? 12 : 7);

  const cls = [
    'bank-card',
    `bank-card-${skin}`,
    `bank-cat-${card.category}`,
    delay ? `bank-d${Math.min(12, Math.max(1, delay))}` : '',
  ].filter(Boolean).join(' ');

  return (
    <article
      className={cls}
      data-cols={cols}
      data-rows={rows}
      style={style}
      aria-label={sample ? `${card.name} — sample data` : card.name}
    >
      <header className="bank-card-head">
        <p className="bank-card-name trunc">{card.name}</p>
        <span className="bank-card-kicker trunc">{card.kicker}</span>
        {sample && (
          <span className="bank-stamp" title="Sample data — not from a bank">Sample</span>
        )}
        {tag && <span className="bank-card-tag">{tag}</span>}
      </header>

      {asBig && (
        <div className="bank-big">
          <div className="bank-big-line">
            <span className="bank-big-value tnum">{card.value}</span>
            {card.delta && <span className="bank-delta">{card.delta}</span>}
          </div>
          {card.caption && <p className="bank-caption trunc">{card.caption}</p>}
        </div>
      )}

      {canRows && (
        <div className="bank-rows">
          {items.map((r) => (
            <div className="bank-row" key={r.label}>
              <span className="bank-row-label trunc">{r.label}</span>
              <span className="bank-row-value tnum">{r.value}</span>
            </div>
          ))}
        </div>
      )}

      {card.kind === 'bars' && (
        <>
          {/* A chart is a drawing, not a bordered element — README §1.1 keeps
              illustration marks. The final bar carries the category accent so
              "now" is legible without a legend. */}
          <div className="bank-bars" role="img" aria-label={`${card.caption ?? card.name}: ${card.value ?? ''}`}>
            {bars.map((h, i) => (
              <span
                key={i}
                className={`bank-bar${i === bars.length - 1 ? ' bank-bar-last' : ''}`}
                style={{ height: `${Math.round(h)}%` }}
              />
            ))}
          </div>
          <div className="bank-bars-foot">
            <span className="bank-caption trunc">{card.caption}</span>
            <span className="bank-bars-value tnum">{card.value}</span>
          </div>
        </>
      )}

      {card.kind === 'progress' && (
        <div className="bank-progress">
          <div className="bank-progress-line">
            <span className="bank-mid tnum">{card.value}</span>
            <span className="bank-caption trunc">{card.caption}</span>
          </div>
          <div
            className="bank-track"
            role="progressbar"
            aria-valuenow={card.pct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={card.name}
          >
            <span className="bank-fill" style={{ width: `${card.pct ?? 0}%` }} />
          </div>
        </div>
      )}

      {card.kind === 'split' && (
        <div className="bank-split">
          <div className="bank-split-half">
            <p className="bank-mid tnum">{card.value}</p>
            <p className="bank-caption trunc">{card.caption}</p>
          </div>
          {/* No divider element between the halves: the design's middle 1px
              column is a grid gap now (README §1.1 — separation is fill and
              space). Nothing is rendered here on purpose. */}
          <div className="bank-split-half">
            <p className="bank-mid bank-mid-accent tnum">{card.value2}</p>
            <p className="bank-caption trunc">{card.caption2}</p>
          </div>
        </div>
      )}

      {card.kind === 'card' && (
        <div className="bank-plastic-row">
          {/* The card graphic is an illustration; its chip and digits are drawn
              shapes, so they are exempt from the borderless rule the same way a
              sparkline's stroke is. */}
          <span className="bank-plastic" aria-hidden>
            <span className="bank-plastic-chip" />
            <span className="bank-plastic-digits">{card.value2}</span>
          </span>
          <div className="bank-plastic-meta">
            <p className="bank-mid bank-mid-tight tnum">{card.value}</p>
            <p className="bank-caption trunc">{card.caption}</p>
          </div>
        </div>
      )}

      {card.kind === 'text' && !asBig && (
        <>
          <p className="bank-text">{card.value}</p>
          <p className="bank-caption bank-caption-foot trunc">{card.caption}</p>
        </>
      )}
    </article>
  );
};
