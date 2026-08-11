import { memo } from 'react';
import type { CardSize, CardSkin } from '@/components/atlas-ui/primitives';
import { Card, Empty, Row } from '@/components/atlas-ui/primitives';
import {
  SHAPE_LABEL, SIZE_LABEL, isBuilt, isTall,
  type BuiltWidget, type CatalogState, type DesignedWidget, type WidgetSpec,
} from './registry';
import type { CatalogStatus, WidgetData } from './useCatalogWidgets';

/**
 * One catalog cell: a real widget, at a chosen size, in a chosen skin, in a
 * chosen state.
 *
 * It is built from `<Card>`, `<Card.Header>`, `<Card.Body>`, `<Row>` and
 * `<Empty>` — the same primitives the dashboard cards use — so a preview is not
 * an impression of the app's card, it IS the app's card chrome with a
 * miniaturised face inside it. The size chips map straight onto `<Card size>`,
 * whose `.sp2` / `.rs2` spans are the dashboard's own; the catalog grid just
 * pins the row height so the four sizes can be compared side by side.
 *
 * There are no icons and no coloured tiles, per the design's own note, and no
 * action pills inside a preview: a button that does nothing would be a lie
 * about the widget it is describing.
 */

/** What the cell actually draws, after the state chip is applied to the truth. */
type Rendered = CatalogStatus | 'immutable';

const STATUS_LABEL: Record<Rendered, string> = {
  live: 'Live',
  fallback: 'Fallback',
  // Distinct from Fallback on purpose: these ARE the source's own numbers,
  // just from an earlier answer. Calling that "Fallback" told the operator the
  // card was canned when it was real — see useCatalogWidgets' header.
  stale: 'Stale',
  empty: 'Empty',
  nosource: 'No source',
  unmeasured: 'Not measured',
  immutable: 'System',
};

/** Three tones, not six colours: green rests, amber warns, neutral idles. */
const STATUS_TONE: Record<Rendered, 'ok' | 'warn' | 'idle'> = {
  live: 'ok',
  fallback: 'warn',
  // Amber, not green: real numbers, but the source is not answering and the
  // reading will keep ageing until it does.
  stale: 'warn',
  empty: 'idle',
  nosource: 'warn',
  unmeasured: 'warn',
  immutable: 'ok',
};

/** Placeholder silhouette for an empty tall cell — a drawing, never a value. */
const GHOST = [34, 58, 22, 72, 44];

function resolve(state: CatalogState, spec: BuiltWidget, data: WidgetData): Rendered {
  if (state === 'empty') return 'empty';
  if (state === 'nosource') return spec.noSource ? 'nosource' : 'immutable';
  return data.status;
}

interface WidgetPreviewProps {
  spec: WidgetSpec;
  data: WidgetData;
  size: CardSize;
  skin: CardSkin;
  state: CatalogState;
  /** Entry stagger, 1–10. */
  delay: number;
}

export const WidgetPreview = memo(({ spec, data, size, skin, state, delay }: WidgetPreviewProps) => {
  // The union splits here, and this is the whole safety argument for the
  // catalog listing widgets that do not exist: a `built: false` spec carries no
  // value fields at all, so it cannot reach `PopulatedFace` — not by accident,
  // not by a later edit. There is nothing to render as if it were data.
  if (!isBuilt(spec)) {
    return <DesignedPreview spec={spec} size={size} skin={skin} delay={delay} />;
  }

  const rendered = resolve(state, spec, data);
  const tall = isTall(size);

  // A `rows` widget at a one-row size has nowhere to put a list, so it falls
  // back to its headline figure — the same collapse the design specifies.
  const shape = spec.shape === 'rows' && !tall ? 'big' : spec.shape;

  // A status of live/fallback is not the same as having something to draw. Air
  // quality proves it: `useWeather`'s built-in sample carries no air block, so
  // a "populated" face rendered a headline with no number and a bar at zero.
  // No content means the blank face, whatever the status pill says.
  const hasContent = shape === 'rows'
    ? (data.rows?.length ?? 0) > 0
    : data.value != null && data.value !== '';
  const populated = (rendered === 'live' || rendered === 'fallback') && hasContent;

  return (
    <Card
      size={size}
      skin={skin}
      delay={delay}
      className={`wcat-cell wcat-${size}`}
      // `<Card>` only sets `role="button"` when it is openable, and these are
      // not — a bare `aria-label` on a roleless div is dropped by most AT, so
      // the cell declares a group to hang its name on.
      role="group"
      aria-label={`${spec.name}, ${SIZE_LABEL[size]}, ${STATUS_LABEL[rendered]}`}
    >
      <Card.Header
        label={spec.name}
        action={
          <span className={`wcat-status wcat-${STATUS_TONE[rendered]}`} title={spec.binding}>
            <span className="wcat-dot" aria-hidden />
            {STATUS_LABEL[rendered]}
          </span>
        }
      />
      <Card.Body className="wcat-body">
        {populated
          ? <PopulatedFace shape={shape} data={data} tall={tall} />
          : <BlankFace spec={spec} data={data} rendered={rendered} tall={tall} />}

        {tall && (
          <div className="wcat-foot">
            <span className="wcat-foota trunc">{spec.binding}</span>
            {/* Size AND skin. `shipsSkin` was recorded but never rendered, so
                it drifted unnoticed when Music v2 moved Now playing from accent
                to ink. A fact nothing displays is a fact nothing checks. */}
            <span className="wcat-footb">
              Ships at {SIZE_LABEL[spec.ships]} · {spec.shipsSkin}
            </span>
          </div>
        )}
      </Card.Body>
    </Card>
  );
});
WidgetPreview.displayName = 'WidgetPreview';

// ---------------------------------------------------------------------------

/**
 * A widget the official catalog defines and Atlas does not implement.
 *
 * It is the app's real card chrome — same `<Card>`, same header, same skin — so
 * it sits honestly beside the built ones at the same size. What it never has is
 * a face: no figure, no rows, no bar. The design file ships hand-written values
 * for all 51 widgets (`'24 min'`, `'TP1338'`, `'8/14'`); copying those in would
 * put 41 fabricated widgets on screen in the same app that spent T4 deleting
 * fabricated rows out of Atlas Core.
 *
 * So the card shows what is TRUE about an unbuilt widget: the shape the design
 * draws it as, and the concrete reason it does not exist yet.
 */
function DesignedPreview({
  spec, size, skin, delay,
}: { spec: DesignedWidget; size: CardSize; skin: CardSkin; delay: number }) {
  const tall = isTall(size);

  return (
    <Card
      size={size}
      skin={skin}
      delay={delay}
      className={`wcat-cell wcat-${size} wcat-designed`}
      role="group"
      aria-label={`${spec.name}, ${SIZE_LABEL[size]}, designed, not built`}
    >
      <Card.Header
        label={spec.name}
        action={
          <span className="wcat-status wcat-idle" title="Defined by the catalog; not implemented">
            <span className="wcat-dot" aria-hidden />
            Designed
          </span>
        }
      />
      <Card.Body className="wcat-body">
        <div className="wcat-fill">
          <Empty
            size="inline"
            status="stale"
            title="Not built yet."
            body={tall ? spec.needs : undefined}
          />
        </div>

        {tall && (
          <div className="wcat-foot">
            <span className="wcat-foota trunc">{SHAPE_LABEL[spec.designShape]}</span>
            <span className="wcat-footb">No source</span>
          </div>
        )}
      </Card.Body>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function PopulatedFace({
  shape, data, tall,
}: { shape: 'big' | 'rows' | 'progress'; data: WidgetData; tall: boolean }) {
  if (shape === 'rows') {
    return (
      <div className="wcat-rows">
        {(data.rows ?? []).slice(0, 3).map((r, i) => (
          <Row
            key={`${r.label}-${i}`}
            density="compact"
            title={r.label}
            trail={<span className="wcat-rowval tnum">{r.value}</span>}
          />
        ))}
        {data.note && <p className="wcat-note">{data.note}</p>}
      </div>
    );
  }

  if (shape === 'progress') {
    return (
      <div className="wcat-fill">
        <div className="wcat-midline">
          <span className="wcat-mid tnum trunc">{data.value}</span>
          {data.caption && <span className="wcat-cap trunc">{data.caption}</span>}
        </div>
        {/* An illustration, not an element border: the track is a drawing of a
            quantity. Same geometry as the shipped Tasks card's bar. */}
        <div className="wcat-track">
          <span style={{ width: `${Math.max(0, Math.min(100, data.pct ?? 0))}%` }} />
        </div>
        {tall && data.note && <p className="wcat-note">{data.note}</p>}
      </div>
    );
  }

  return (
    <div className="wcat-fill">
      <div className="wcat-bigline">
        <span className="wcat-val tnum">{data.value}</span>
        {data.delta && <span className="wcat-delta trunc">{data.delta}</span>}
      </div>
      {data.caption && <p className="wcat-cap trunc">{data.caption}</p>}
      {tall && data.note && <p className="wcat-note">{data.note}</p>}
    </div>
  );
}

/**
 * Empty, missing, or unmeasured — three different things, three different
 * sentences, one `<Empty>`.
 *
 * The pulsing dot carries the difference between "healthy and idle" and "this
 * is not going to fill in on its own": `resting` for an empty-but-connected
 * source, `stale` for one that is absent or unmeasured.
 */
function BlankFace({
  spec, data, rendered, tall,
}: { spec: BuiltWidget; data: WidgetData; rendered: Rendered; tall: boolean }) {
  // `live` reaches here only when the source answered with nothing, which is
  // the plain empty state. `fallback` reaches here when the substituted sample
  // has no field for this widget — that is an absent source, not an empty one.
  const copy =
    rendered === 'immutable'
      ? {
        title: 'Nothing to disconnect.',
        body: 'This widget reads the system clock — it has no source that can go missing.',
      }
      : rendered === 'unmeasured'
        ? {
          title: 'No health source.',
          body: 'Nothing in Atlas measures activity, so this widget has no number to show.',
        }
        : rendered === 'empty' || rendered === 'live'
          ? spec.empty
          : spec.noSource ?? spec.empty;

  return (
    <div className="wcat-fill">
      {tall && (
        <div className="wcat-ghost" aria-hidden>
          {GHOST.map((h, i) => <span key={i} style={{ height: `${h}%` }} />)}
        </div>
      )}
      <Empty
        size="inline"
        status={rendered === 'empty' ? 'resting' : 'stale'}
        title={copy.title}
        body={tall ? copy.body : undefined}
      />
      {tall && data.note && <p className="wcat-note">{data.note}</p>}
    </div>
  );
}
