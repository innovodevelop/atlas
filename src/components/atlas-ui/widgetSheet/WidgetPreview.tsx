import type { ReactNode } from 'react';
import {
  Activity, Calendar, Check, CloudSun, Disc, Flame, Globe, Leaf, Mail, Newspaper,
  Inbox, WifiOff, AlertTriangle, Sparkles,
} from 'lucide-react';
import { Card, Empty, Row } from '@/components/atlas-ui/primitives';
import type { PreviewBlock, PreviewSpec } from '@/lib/mocks/widgetSheet';

/**
 * One widget drawn in one state.
 *
 * The tile is a real `<Card>` from the primitives — the same `.cardB` surface,
 * radius, elevation and hover the dashboard uses — so what the sheet shows is
 * the actual card face, not a redrawing of it. Only the *content* is spec copy.
 *
 * Two deliberate departures from the design file, both forced by rules that
 * outrank it (README §1.1 and §7):
 *
 *  - The attention state is drawn as a blue-tinted FILL (`--wash`), not the
 *    design's orange hairline. Borders are gone system-wide, and `--acc2`
 *    (#ff6a00) is reserved for the voice indicator — an "attention" widget is
 *    exactly the sort of thing that would quietly steal it.
 *  - The alert strip uses the wash fill for information and the red tint for
 *    failure, which is the borderless translation of the design's two alert
 *    tones.
 *
 * The controls inside a preview — "Set location", "Join", "Review" — are
 * rendered as static labels, never as buttons. A spec sheet showing a button
 * that does nothing when clicked would be a worse lie than the fabricated rows
 * this whole redesign spent a week deleting.
 */

/** The lucide exports the widget set names. Resolved here so the spec module stays React-free. */
const ICONS: Record<string, typeof Activity> = {
  Activity, Calendar, Check, CloudSun, Disc, Flame, Globe, Leaf, Mail, Newspaper,
};

export const widgetIcon = (name: string, className = 'i14'): ReactNode => {
  const Ico = ICONS[name] ?? Sparkles;
  return <Ico className={className} />;
};

/* ------------------------------------------------------------------ blocks */

function Block({ block }: { block: PreviewBlock }) {
  switch (block.kind) {
    case 'skeleton':
      return (
        <div className="wsh-skel" aria-hidden>
          {block.bars.map((b, i) => (
            <span
              key={i}
              className="wsh-skb"
              style={{ width: b.w, height: b.h ?? 10, marginTop: b.top ?? 0 }}
            />
          ))}
        </div>
      );

    case 'metric':
      return (
        <div className="wsh-metric">
          <div className="wsh-metric-line">
            <p className="wsh-metric-v tnum disp">{block.value}</p>
            {block.aside && <span className="wsh-metric-aside tnum">{block.aside}</span>}
          </div>
          {block.caption && <p className="wsh-metric-cap">{block.caption}</p>}
          {block.chips && (
            <div className="wsh-chips">
              {block.chips.map((c) => <span key={c} className="wsh-chip tnum">{c}</span>)}
            </div>
          )}
        </div>
      );

    case 'rows':
      return (
        <div className="wsh-rows">
          {block.rows.map((r, i) => (
            <Row
              key={i}
              density="compact"
              tone={r.tone === 'muted' ? 'muted' : 'default'}
              className={r.tone === 'alert' ? 'wsh-row-alert' : r.tone === 'done' ? 'wsh-row-done' : undefined}
              lead={r.lead != null || r.leadKind ? <LeadSlot row={r} /> : undefined}
              leadWidth={r.leadKind === 'avatar' ? 28 : r.leadKind === 'check' || r.leadKind === 'done' ? 18 : r.lead ? 58 : undefined}
              title={r.title}
              meta={r.meta}
              trail={
                r.trail || r.delta ? (
                  <>
                    {r.trail && (
                      <span className={`wsh-trail tnum${r.trailTone ? ` wsh-trail-${r.trailTone}` : ''}`}>
                        {r.trail}
                      </span>
                    )}
                    {r.delta && (
                      <span className={`wsh-delta tnum wsh-delta-${r.deltaTone ?? 'up'}`}>{r.delta}</span>
                    )}
                  </>
                ) : undefined
              }
            />
          ))}
        </div>
      );

    case 'progress':
      return (
        <div className="wsh-prog">
          {/* An illustration stroke, not an element border — progress tracks stay. */}
          <span className="wsh-prog-track">
            <span className="wsh-prog-fill" style={{ width: `${block.pct}%` }} />
          </span>
          <span className="wsh-prog-lbl tnum">{block.label}</span>
        </div>
      );

    case 'stack':
      return (
        <div className="wsh-stack">
          {block.items.map((it, i) => (
            <article key={i} className="wsh-story">
              {it.breaking
                ? <span className="wsh-kicker wsh-kicker-brk">Breaking</span>
                : it.kicker && <span className="wsh-kicker">{it.kicker}</span>}
              <h5 className={`wsh-head${it.breaking ? ' wsh-head-brk' : ''}`}>{it.headline}</h5>
              {it.source && <span className="wsh-src">{it.source}</span>}
            </article>
          ))}
        </div>
      );

    case 'note':
      return <p className="wsh-note">{block.text}</p>;

    case 'empty':
      return (
        <div className="wsh-empty">
          <Empty
            size="block"
            icon={<Inbox className="i20" />}
            title={block.title}
            body={block.body}
          />
          {/* A label, not a control — see the file header. */}
          {block.action && <span className="wsh-ghost">{block.action}</span>}
        </div>
      );

    default:
      return null;
  }
}

function LeadSlot({ row }: { row: { lead?: string; leadKind?: string } }) {
  switch (row.leadKind) {
    case 'dot':
      return <span className="wsh-lead"><span className="wsh-dot" />{row.lead && <span className="tnum">{row.lead}</span>}</span>;
    case 'check':
      return <span className="wsh-box" />;
    case 'done':
      return <span className="wsh-box wsh-box-done"><Check className="i12" /></span>;
    case 'avatar':
      return <span className="wsh-av">{row.lead}</span>;
    default:
      return <span className="tnum">{row.lead}</span>;
  }
}

/* -------------------------------------------------------------------- card */

interface WidgetPreviewProps {
  spec: PreviewSpec;
  /** The widget's own lucide icon name, used when the spec declares a header. */
  icon: string;
}

export function WidgetPreview({ spec, icon }: WidgetPreviewProps) {
  return (
    <Card
      size="s"
      className={`wsh-card${spec.hot ? ' wsh-hot' : ''}${spec.dim ? ' wsh-dim' : ''}`}
    >
      {spec.label && <Card.Header label={spec.label} icon={widgetIcon(icon)} />}
      <Card.Body>
        {spec.alert && (
          <p className={`wsh-alert wsh-alert-${spec.alert.tone}`}>
            {spec.alert.tone === 'error'
              ? <WifiOff className="i12" aria-hidden />
              : <AlertTriangle className="i12" aria-hidden />}
            <span>{spec.alert.text}</span>
          </p>
        )}
        <div className={spec.dim ? 'wsh-dimmed' : undefined}>
          {spec.blocks.map((b, i) => <Block key={i} block={b} />)}
        </div>
        {spec.foot && <p className="wsh-foot">{spec.foot}</p>}
      </Card.Body>
    </Card>
  );
}
