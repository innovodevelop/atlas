/**
 * Block renderers for the answer view.
 *
 * Two presentations of the SAME parsed answer — `composed` puts every block on
 * the design's 12-column card grid, `reading` runs them down one measure. The
 * dial that switches them is a presentation control, not a data control: no
 * block appears in one view and not the other.
 *
 * Inline markdown is rendered as React nodes, never as HTML. The answer text is
 * model output and, on the web_search path, contains text the model read off a
 * third-party page — `dangerouslySetInnerHTML` on that would be a script
 * injection with extra steps.
 */
import { Fragment, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { blockLabel, type AnswerBlock, type AnswerSource, type PlannedCard } from './parseAnswer';
import { openExternal } from './openExternal';

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"']+)/g;

/** `**bold**`, `` `code` ``, `[text](url)` and bare URLs. Nothing else. */
export function InlineText({ text }: { text: string }): ReactNode {
  const parts = text.split(INLINE).filter((p) => p !== undefined && p !== '');
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="av-strong">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
          return <code key={i} className="av-inline-code">{part.slice(1, -1)}</code>;
        }
        const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
        if (link) {
          return (
            <button key={i} type="button" className="av-link" onClick={() => void openExternal(link[2])}>
              {link[1]}
            </button>
          );
        }
        if (/^https?:\/\//.test(part)) {
          return (
            <button key={i} type="button" className="av-link" onClick={() => void openExternal(part)}>
              {part.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </button>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function BlockBody({ block }: { block: AnswerBlock }) {
  switch (block.kind) {
    case 'heading':
      return <p className="av-block-heading disp">{block.text}</p>;

    case 'paragraph':
      return <p className="av-prose"><InlineText text={block.text} /></p>;

    case 'quote':
      return <p className="av-said"><InlineText text={block.text} /></p>;

    case 'bullets':
      return (
        <ul className="av-list">
          {block.items.map((item, i) => (
            <li key={i} className="av-list-item">
              <span className="av-list-mark" aria-hidden>{block.ordered ? `${i + 1}` : ''}</span>
              <span className="av-list-text"><InlineText text={item} /></span>
            </li>
          ))}
        </ul>
      );

    case 'pairs':
      return (
        <dl className="av-pairs">
          {block.items.map((p, i) => (
            <div className="av-pair" key={i}>
              <dt className="av-pair-label"><InlineText text={p.label} /></dt>
              <dd className="av-pair-value tnum"><InlineText text={p.value} /></dd>
            </div>
          ))}
        </dl>
      );

    case 'code':
      return (
        <div className="av-code-wrap">
          <pre className="av-code"><code>{block.code}</code></pre>
        </div>
      );

    case 'table':
      return (
        <div className="av-table-wrap">
          <table className="av-table">
            <thead>
              <tr>{block.head.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={/^[\d\s.,%+\-€$£]+$/.test(cell) ? 'tnum' : undefined}>
                      <InlineText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    default:
      return null;
  }
}

/** The composed grid — the design's 12-column answer layout. */
export function AnswerGrid({ cards, ink }: { cards: PlannedCard[]; ink: boolean }) {
  return (
    <div className="av-grid">
      {cards.map((card, i) => (
        <article
          key={i}
          className={[
            'av-card',
            `av-card--${card.block.kind}`,
            card.cols >= 8 ? 'av-card--wide' : '',
            ink ? 'av-card--ink' : '',
          ].filter(Boolean).join(' ')}
          style={{
            gridColumn: `span ${card.cols}`,
            gridRow: `span ${card.rows}`,
            animationDelay: `${Math.min(i, 9) * 55}ms`,
          }}
        >
          <header className="av-card-head">
            <p className="av-card-label">{blockLabel(card.block)}</p>
            <span className="av-card-tag tnum">{card.cols}×{card.rows}</span>
          </header>
          <div className="av-card-body"><BlockBody block={card.block} /></div>
        </article>
      ))}
    </div>
  );
}

/** The reading column — one measure, no cards. */
export function AnswerReading({ blocks, ink }: { blocks: AnswerBlock[]; ink: boolean }) {
  return (
    <div className={`av-reading${ink ? ' av-reading--ink' : ''}`}>
      {blocks.map((block, i) => (
        <div key={i} className={`av-reading-block av-reading-block--${block.kind}`}>
          <BlockBody block={block} />
        </div>
      ))}
    </div>
  );
}

/** One source row. `via` is shown because the two paths mean different things. */
export function SourceRow({ source }: { source: AnswerSource }) {
  return (
    <button type="button" className="av-source" onClick={() => void openExternal(source.url)}>
      <span className="av-source-domain">{source.domain}</span>
      <span className="av-source-title trunc">{source.title ?? source.url}</span>
      <span className="av-source-via">{source.via === 'citation' ? 'tool result' : 'in answer'}</span>
      <ExternalLink className="i14 av-source-ico" aria-hidden />
    </button>
  );
}
