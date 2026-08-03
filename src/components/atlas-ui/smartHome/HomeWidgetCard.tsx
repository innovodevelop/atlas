/**
 * A house widget — the seven card bodies the design draws.
 *
 * The shell is the shared <Card> (`.cardB`), so this surface inherits the
 * dashboard's fill, radius, shadow, entry animation and hover physics rather
 * than re-declaring them. Only the bodies live here.
 *
 * SIZE. The design lays these out on a 12-column grid with 126px rows, which
 * is a different grid from the dashboard's `auto-fill minmax(340px,1fr)`, so
 * `<Card size="s">` (the one size that adds no span class) is used and the span
 * comes from `.sh-c*` / `.sh-r*` in smartHome.css. That keeps <Card>'s two span
 * modifiers from fighting a grid they were not written for.
 *
 * HEADERS keep the app's `.mlblB` treatment — 13px sentence case, not the
 * design file's 10.5px uppercase eyebrow. workshop.css already made that call
 * for every card in the app ("Design-parity: card kicker + meta text…"), and a
 * single surface reintroducing uppercase card labels would be the odd one out.
 * Panel section labels below the card layer DO keep the eyebrow, because the
 * app has no competing treatment for those.
 *
 * EMPTY. A `rows` card with no rows and a `bars` card with no bars are real
 * states — a house with no cameras, a day with no meter readings — so each
 * renderer falls to `<Empty size="inline">` rather than drawing an empty box.
 */
import { Card, Empty } from '@/components/atlas-ui/primitives';
import type { HomeWidget } from '@/lib/mocks/smartHome';
import { Switch } from './DeviceControls';

const SPAN_COL: Record<number, string> = { 3: 'sh-c3', 6: 'sh-c6', 12: 'sh-c12' };
const SPAN_ROW: Record<number, string> = { 1: 'sh-r1', 2: 'sh-r2' };

interface Props {
  widget: HomeWidget;
  onToggle: (on: boolean) => void;
}

export const HomeWidgetCard = ({ widget: w, onToggle }: Props) => {
  const tall = w.rows >= 2;
  const wide = w.cols >= 6;
  const cls = ['sh-w', SPAN_COL[w.cols] ?? 'sh-c3', SPAN_ROW[w.rows] ?? 'sh-r1'].join(' ');

  return (
    <Card size="s" skin="glass" className={cls} data-cat={w.category}>
      <Card.Header label={w.name} action={<span className="sh-kicker">{w.kicker}</span>} />
      <Card.Body>{body()}</Card.Body>
    </Card>
  );

  function body() {
    switch (w.kind) {
      // A list needs vertical room. At one row high the design falls back to
      // the headline figure rather than clipping three rows into 90px.
      case 'rows':
        if (!tall) return big();
        if (!w.list?.length) {
          return <Empty body={`Nothing to show under ${w.name.toLowerCase()} yet.`} />;
        }
        return (
          <div className="sh-list">
            {w.list.slice(0, 4).map((r) => (
              <div className="sh-list-row" key={r.label}>
                <span className="sh-list-label">{r.label}</span>
                <span className="sh-list-value tnum">{r.value}</span>
              </div>
            ))}
          </div>
        );

      case 'toggle':
        return (
          <div className="sh-togrow">
            <div className="sh-togtext">
              <p className="sh-mid">{w.value}</p>
              <p className="sh-cap">{w.caption}</p>
            </div>
            <Switch checked={!!w.on} label={w.name} onChange={onToggle} />
          </div>
        );

      case 'progress':
        return (
          <div className="sh-bottom">
            <div className="sh-progline">
              <span className="sh-big tnum">{w.value}</span>
              <span className="sh-cap" style={{ margin: 0 }}>{w.caption}</span>
            </div>
            <div className="sh-track">
              <span className="sh-fill" style={{ width: `${Math.max(0, Math.min(100, w.pct ?? 0))}%` }} />
            </div>
          </div>
        );

      case 'bars': {
        if (!w.bars?.length) return <Empty body="No readings for today yet." />;
        const bars = w.bars.slice(0, wide ? 12 : 7);
        return (
          <div className="sh-bottom">
            <div className="sh-bars">
              {bars.map((h, i) => (
                <span
                  key={i}
                  className={`sh-bar${i === bars.length - 1 ? ' sh-bar-last' : ''}`}
                  style={{ height: `${Math.max(2, Math.min(100, h))}%` }}
                />
              ))}
            </div>
            <div className="sh-barfoot">
              <span className="sh-barfoot-cap">{w.caption}</span>
              <span className="sh-barfoot-val tnum">{w.value}</span>
            </div>
          </div>
        );
      }

      case 'split':
        return (
          <div className="sh-split">
            <div style={{ minWidth: 0 }}>
              <p className="sh-split-val tnum">{w.value}</p>
              <p className="sh-split-cap">{w.caption}</p>
            </div>
            <div style={{ minWidth: 0 }}>
              <p className="sh-split-val sh-split-val2 tnum">{w.value2}</p>
              <p className="sh-split-cap">{w.caption2}</p>
            </div>
          </div>
        );

      // Prose only survives at 6 columns or two rows; anywhere smaller it is
      // three clipped words, so the design shows the figure instead.
      case 'text':
        if (!tall && !wide) return big();
        return (
          <>
            <p className="sh-text">{w.value}</p>
            <p className="sh-text-foot">{w.caption}</p>
          </>
        );

      case 'big':
      default:
        return big();
    }
  }

  function big() {
    return (
      <div className="sh-bottom">
        <div className="sh-bigrow">
          <span className="sh-big tnum">{w.value}</span>
          {w.delta && <span className="sh-delta">{w.delta}</span>}
        </div>
        <p className="sh-cap">{w.caption}</p>
      </div>
    );
  }
};
