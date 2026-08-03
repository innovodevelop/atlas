import type { CSSProperties } from 'react';
import { Card, Empty, StatTile } from '@/components/atlas-ui/primitives';
import type { HealthMetric, MetricBlock } from '@/lib/mocks/health';

/**
 * One health card.
 *
 * Seven shapes from `Atlas Health.dc.html` — big / bars / rows / progress /
 * split / ring / text — on the shared `<Card>`, so the surface inherits the
 * app's glass skin, radius and rise animation rather than re-declaring them.
 *
 * BORDERLESS NOTES:
 *  - the design's `split` puts a 1px rule between its two halves; §1.1 deletes
 *    it and the gap carries the separation instead.
 *  - the bar chart, the progress track and the conic ring survive. They are
 *    drawings, not element borders — the same exemption the mail status rails
 *    took.
 *
 * EVERY CARD HAS A DARK STATE. `block` is computed from the live source and
 * signal switches, so a card whose supplier the user turned off says "Not
 * measured" and names what to turn back on. It is not removed from the grid:
 * a vanishing card is indistinguishable from a card that never existed, and
 * the point of the switch is to see the consequence.
 */
interface HealthWidgetProps {
  metric: HealthMetric;
  block: MetricBlock;
  /** Draws the per-card `Sample` stamp. Gated on the hook, never on a constant. */
  isMock: boolean;
  /** Entry stagger, 1–10. */
  delay?: number;
}

const pctLabel = (pct: number) => `${Math.round(pct * 100)}%`;

export const HealthWidget = ({ metric, block, isMock, delay }: HealthWidgetProps) => {
  const cls = [
    'hl-card',
    `hl-cat-${metric.category}`,
    `hl-c${metric.cols}`,
    `hl-r${metric.rows_}`,
    `hl-kind-${metric.kind}`,
  ].join(' ');

  return (
    <Card size="s" className={cls} delay={delay}>
      <Card.Header
        label={metric.name}
        action={
          <span className="hl-headmeta">
            {isMock && <span className="hl-stamp">Sample</span>}
            <span className="hl-kicker">{metric.kicker}</span>
          </span>
        }
      />
      <Card.Body className="hl-body">
        {block.available ? <MetricFace metric={metric} /> : <Blocked block={block} />}
      </Card.Body>
    </Card>
  );
};

/** The "you turned its source off" state. Names the switch, not the failure. */
const Blocked = ({ block }: { block: MetricBlock }) => (
  <Empty
    size="inline"
    status="stale"
    className="hl-blocked"
    title="Not measured."
    body={`${block.label ?? 'Its source'} is off — turn it back on in Sources and this fills in.`}
  />
);

const MetricFace = ({ metric }: { metric: HealthMetric }) => {
  switch (metric.kind) {
    case 'bars':
      return <Bars metric={metric} />;
    case 'rows':
      return <Rows metric={metric} />;
    case 'progress':
      return <Progress metric={metric} />;
    case 'split':
      return <Split metric={metric} />;
    case 'ring':
      return <Ring metric={metric} />;
    case 'text':
      return <Text metric={metric} />;
    case 'big':
    default:
      return <Big metric={metric} />;
  }
};

const Big = ({ metric }: { metric: HealthMetric }) => (
  <div className="hl-face hl-face-bottom">
    <p className="hl-bigrow">
      <span className="hl-bigval tnum">{metric.value}</span>
      {metric.delta && <span className="hl-delta">{metric.delta}</span>}
    </p>
    {metric.caption && <p className="hl-cap">{metric.caption}</p>}
  </div>
);

const Bars = ({ metric }: { metric: HealthMetric }) => {
  const bars = metric.bars ?? [];
  return (
    <div className="hl-face hl-face-bottom">
      {/* Illustration, not data-table: the numbers are read out in the footer. */}
      <div className="hl-bars" aria-hidden>
        {bars.map((h, i) => (
          <span
            key={i}
            className={`hl-bar${i === bars.length - 1 ? ' hl-bar-on' : ''}`}
            style={{ height: `${Math.max(4, Math.min(100, h))}%` }}
          />
        ))}
      </div>
      <p className="hl-barsfoot">
        <span className="hl-cap">{metric.caption}</span>
        <span className="hl-footval tnum">{metric.value}</span>
      </p>
    </div>
  );
};

const Rows = ({ metric }: { metric: HealthMetric }) => {
  const rows = metric.rows ?? [];
  if (rows.length === 0) {
    return <Empty size="inline" status="stale" title="Nothing logged yet." />;
  }
  return (
    <div className="hl-face">
      <div className="hl-rowlist">
        {rows.map((r) => (
          <div key={r.label} className="hl-row">
            <span className="hl-rowlabel trunc">{r.label}</span>
            <span className="hl-rowval tnum">{r.value}</span>
          </div>
        ))}
      </div>
      {(metric.value || metric.caption) && (
        <p className="hl-rowsum">
          <span className="hl-footval tnum">{metric.value}</span>
          {metric.caption && <span className="hl-cap">{metric.caption}</span>}
        </p>
      )}
    </div>
  );
};

const Progress = ({ metric }: { metric: HealthMetric }) => {
  const pct = metric.pct ?? 0;
  return (
    <div className="hl-face hl-face-bottom">
      <p className="hl-midrow">
        <span className="hl-midval tnum">{metric.value}</span>
        {metric.caption && <span className="hl-cap">{metric.caption}</span>}
      </p>
      <div
        className="hl-track"
        role="progressbar"
        aria-valuenow={Math.round(pct * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={metric.name}
      >
        <span className="hl-fill" style={{ width: pctLabel(pct) }} />
      </div>
    </div>
  );
};

/**
 * Two figures side by side. The design's 1px separator is gone (§1.1) — the
 * gap does the work — and each half is the shared `<StatTile layout="micro">`
 * rather than a bespoke pair of `<p>`s.
 */
const Split = ({ metric }: { metric: HealthMetric }) => (
  <div className="hl-face hl-face-bottom">
    <div className="hl-split">
      <StatTile layout="micro" value={metric.value} label={metric.caption} />
      <StatTile layout="micro" className="hl-split-b" value={metric.value2} label={metric.caption2} />
    </div>
  </div>
);

const Ring = ({ metric }: { metric: HealthMetric }) => {
  const pct = metric.pct ?? 0;
  return (
    <div className="hl-face hl-face-bottom">
      <div className="hl-ringrow">
        {/* conic-gradient, so the ring is painted rather than stroked. */}
        <span
          className="hl-ring"
          style={{ '--hl-sweep': pctLabel(pct) } as CSSProperties}
          role="img"
          aria-label={`${metric.name}: ${pctLabel(pct)}`}
        >
          <span className="hl-ringhole" />
        </span>
        <div className="hl-ringtext">
          <p className="hl-midval tnum">{metric.value}</p>
          {metric.caption && <p className="hl-cap">{metric.caption}</p>}
        </div>
      </div>
    </div>
  );
};

const Text = ({ metric }: { metric: HealthMetric }) => (
  <div className="hl-face">
    <p className="hl-quote">{metric.text}</p>
    {metric.caption && <p className="hl-cap hl-cap-foot">{metric.caption}</p>}
  </div>
);
