import type { ReactNode } from 'react';

/**
 * One capability, as a tile you switch by pressing the whole surface.
 *
 * The design's rule for this control (`Atlas Onboarding.dc.html`, and the
 * filled-tile direction it inherits from the Permission Lab) is that *the tile
 * surface itself carries the grant* — one accent, no borders, no toggle switch
 * bolted on the side. That is kept. What is NOT kept is the design's literal
 * `#e8862e` / `#2a4fd0` fills: `--wash` (#eef2fe) with `--acc-text` type is the
 * app's own documented "emphasis is a blue-tinted FILL, never an outline" token
 * pair (README §1.1 / §7), it clears AA at every text role without the design's
 * per-fill contrast corrections, and it means a restyle stays a token change.
 *
 * `role="switch"` + `aria-checked`, not a button: this is a two-state control,
 * and a screen reader has to be able to say which state it is in without
 * relying on the tag text being read.
 *
 * FOUR STATES, because the app really has four. `off` and `on` are the user's
 * choice; `asking` is a macOS prompt genuinely in flight; `denied` is macOS
 * having refused. `denied` deliberately does not look like `off` with a
 * different label — a capability the user asked for and the system refused is a
 * different fact from one they declined, and it is the only one with an action
 * (System Settings) that Atlas cannot take for them.
 */
export type CapabilityTileState = 'off' | 'on' | 'asking' | 'denied';

interface CapabilityTileProps {
  name: string;
  /** What it unlocks when on; what genuinely stops working when off. */
  why: ReactNode;
  /** Right-aligned state word. Uppercased in CSS, never in the string. */
  tag: string;
  state: CapabilityTileState;
  icon?: ReactNode;
  disabled?: boolean;
  onToggle: () => void;
}

export function CapabilityTile({
  name, why, tag, state, icon, disabled, onToggle,
}: CapabilityTileProps) {
  const on = state === 'on' || state === 'asking';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${name}. ${typeof why === 'string' ? why : ''}`}
      className={`onb-tile onb-tile-${state}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="onb-tile-head">
        <span className="onb-tile-dot" aria-hidden />
        {icon && <span className="onb-tile-ico" aria-hidden>{icon}</span>}
        <span className="onb-tile-name">{name}</span>
        <span className="onb-tile-tag">{tag}</span>
      </span>
      <span className="onb-tile-why">{why}</span>
    </button>
  );
}

export default CapabilityTile;
