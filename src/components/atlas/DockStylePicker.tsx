/**
 * Settings → Beta UI → Dock: the dock explorations as a choice in the app.
 *
 * One native radio per style, so the group, arrow keys and the checked state
 * are the browser's and a screen reader hears "Lens, radio button, 2 of 7".
 * Picking one applies at once — the dock at the bottom of this very screen
 * changes — and is kept in `atlas:beta_dock` (src/lib/betaDock.ts). Each card
 * carries a small drawing of its dock and the design board's own sentence,
 * so the choice can be made without opening the design file.
 *
 * The drawings are shapes, not spheres: seven live particle spheres in a
 * settings card would cost more than the whole rest of the screen.
 */
import { useId } from 'react';
import { DEFAULT_DOCK_STYLE, DOCK_STYLE_META, setDockStyle, useDockStyle, type DockStyle } from '@/lib/betaDock';
import '@/styles/beta/dock.css';

function Dots({ n, size }: { n: number; size?: 'sm' | 'lg' }) {
  return <>{Array.from({ length: n }, (_, i) => <i key={i} className={`b-dkpv-dot${size ? ` b-dkpv-${size}` : ''}`} />)}</>;
}

/** The style's dock in miniature, on a window of panel paper. Decorative: the card's text names it. */
function Preview({ style }: { style: DockStyle }) {
  switch (style) {
    case 'lens':
      return (
        <span className="b-dkpv-bar">
          <i className="b-dkpv-dot b-dkpv-sm" /><i className="b-dkpv-dot" /><i className="b-dkpv-dot b-dkpv-lg" />
          <b className="b-dkpv-on" />
          <i className="b-dkpv-dot" /><i className="b-dkpv-dot b-dkpv-sm" /><u className="b-dkpv-av" />
        </span>
      );
    case 'hub':
      return (
        <>
          <em className="b-dkpv-tag" />
          <span className="b-dkpv-bar">
            <i className="b-dkpv-dot" /><i className="b-dkpv-dot b-dkpv-inkdot" /><i className="b-dkpv-dot" />
            <b className="b-dkpv-sphere" />
            <Dots n={2} /><u className="b-dkpv-av" />
          </span>
        </>
      );
    case 'rail':
      return (
        <>
          <span className="b-dkpv-rail">
            <i className="b-dkpv-row" /><i className="b-dkpv-row" /><b className="b-dkpv-row b-dkpv-row--on" />
            <i className="b-dkpv-row" /><i className="b-dkpv-row" /><i className="b-dkpv-row" />
          </span>
          <span className="b-dkpv-lines"><span /><span /><span /></span>
        </>
      );
    case 'capsule':
      return (
        <>
          <span className="b-dkpv-fan"><i /><i className="b-dkpv-inkdot" /><i /><i /><i /><i /></span>
          <span className="b-dkpv-cap"><b className="b-dkpv-sphere" /><span /></span>
        </>
      );
    case 'lane':
      return (
        <>
          <span className="b-dkpv-stripe" />
          <span className="b-dkpv-bar">
            <i className="b-dkpv-dot" /><b className="b-dkpv-blob" /><Dots n={4} /><u className="b-dkpv-av" />
          </span>
        </>
      );
    case 'status':
      return (
        <>
          <em className="b-dkpv-card" />
          <span className="b-dkpv-bar">
            <span className="b-dkpv-tile b-dkpv-badge"><i /><s /></span>
            <span className="b-dkpv-tile"><i /><s /></span>
            <span className="b-dkpv-tile"><i /><s /></span>
            <span className="b-dkpv-tile b-dkpv-tile--on b-dkpv-badge"><i /><s /></span>
            <span className="b-dkpv-tile"><i /><s /></span>
            <span className="b-dkpv-tile"><i /><s /></span>
            <u className="b-dkpv-av" />
          </span>
        </>
      );
    case 'guide':
    default:
      return (
        <span className="b-dkpv-bar">
          <Dots n={3} /><b className="b-dkpv-on" /><Dots n={2} /><u className="b-dkpv-av" />
        </span>
      );
  }
}

export function DockStylePicker() {
  const chosen = useDockStyle();
  const name = useId();
  return (
    <fieldset className="b-dkpick">
      <legend className="b-dkpick-legend">Dock style</legend>
      <div className="b-dkpick-grid">
        {DOCK_STYLE_META.map((m) => {
          const on = m.id === chosen;
          const descId = `${name}-${m.id}`;
          return (
            <label key={m.id} className={`b-dkpick-opt${on ? ' on' : ''}`}>
              <input
                type="radio"
                className="b-dkpick-input"
                name={name}
                value={m.id}
                checked={on}
                // The name alone; the board's sentence is the description, not part of the name.
                aria-label={m.id === DEFAULT_DOCK_STYLE ? `${m.name} (default)` : m.name}
                aria-describedby={descId}
                onChange={() => setDockStyle(m.id)}
              />
              <span className="b-dkpv" aria-hidden="true"><Preview style={m.id} /></span>
              <span className="b-dkpick-head">
                <span className="b-dkpick-name">{m.name}</span>
                <span className="b-dkpick-board" aria-hidden="true">{m.board}</span>
                {on ? <span className="b-dkpick-tag" aria-hidden="true">In use</span>
                  : m.id === DEFAULT_DOCK_STYLE ? <span className="b-dkpick-tag" aria-hidden="true">Default</span> : null}
              </span>
              <span className="b-dkpick-desc" id={descId}>{m.description}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
