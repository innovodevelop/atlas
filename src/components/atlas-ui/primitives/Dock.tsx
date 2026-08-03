import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * The bottom dock.
 *
 * It was duplicated JSX in two places — eight entries in `AtlasDashboard`, three
 * in `AtlasMail` — with no shared source, so the two had already drifted apart
 * (different item sets, an inline red style on one Mute button, and a Home item
 * that means "close the focused widget" on one screen and "navigate" on the
 * other). One data-driven component, one builder.
 *
 * CONTRACT (README §7). Icon-only at rest with a `title` tooltip; only the
 * CURRENT screen carries a visible label. That is a behaviour change, not a
 * restyle: the app expanded every label on hover and marked no item as current,
 * so the dock never told you where you were, and `aria-label` was set while
 * `title` never was — meaning the tooltip the contract describes did not exist
 * on a single dock button. Both now derive from one `label` field.
 *
 * The CTA is the documented exception: Mail's sync button reports its own
 * progress in the dock label ("Sync" -> "Syncing…"), and that is the only
 * feedback a sync has. `.dockcta .dockl` keeps it visible.
 */
export type DockItemKind = 'nav' | 'action' | 'toggle' | 'cta' | 'avatar';

export interface DockItem {
  /** Stable id; also the key `current` matches against. */
  id: string;
  /** Supplies the visible label when current AND both `title` and `aria-label`. */
  label: string;
  icon: ReactNode;
  kind?: DockItemKind;
  /** Router path, for `nav` items. `onClick` wins when both are given. */
  to?: string;
  onClick?: () => void;
  /** `toggle` only — reflected as `aria-pressed`. */
  pressed?: boolean;
  /** `toggle` only — icon and label while pressed. */
  pressedIcon?: ReactNode;
  pressedLabel?: string;
  /** `toggle` only — the destructive fill (mute). */
  tone?: 'default' | 'danger';
  /** `toggle` only — light the voice indicator (`--acc2`). Nothing else may. */
  voiceActive?: boolean;
  /** `cta` only. */
  busy?: boolean;
  busyLabel?: string;
  /** `avatar` only — the account popover, rendered inside `.acctwrap`. */
  popover?: ReactNode;
}

interface DockProps {
  items: DockItem[];
  /** Id of the current screen. That item, and only that item, shows its label. */
  current?: string;
}

export const Dock = ({ items, current }: DockProps) => {
  const navigate = useNavigate();

  if (import.meta.env.DEV) {
    const ctas = items.filter((i) => i.kind === 'cta').length;
    const avatars = items.filter((i) => i.kind === 'avatar');
    if (ctas > 1) console.error('[atlas] <Dock> takes at most one kind="cta" item');
    if (avatars.length > 1) console.error('[atlas] <Dock> takes at most one kind="avatar" item');
    if (avatars.length === 1 && items[items.length - 1].kind !== 'avatar') {
      console.error('[atlas] <Dock> expects the avatar item last');
    }
  }

  return (
    <div className="dock">
      {items.map((item) => {
        const kind = item.kind ?? 'nav';
        const on = item.id === current;
        const pressed = kind === 'toggle' && item.pressed;
        const label = pressed && item.pressedLabel ? item.pressedLabel : item.label;
        const icon = pressed && item.pressedIcon ? item.pressedIcon : item.icon;
        // `onClick` beats `to`: the dashboard's Home item closes a focused
        // widget instead of navigating.
        const run = item.onClick ?? (item.to ? () => navigate(item.to as string) : undefined);

        if (kind === 'avatar') {
          return (
            <div className="acctwrap" key={item.id}>
              <button
                className="dockav"
                onClick={run}
                title={label}
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={!!item.popover}
              >
                {icon}
              </button>
              {item.popover}
            </div>
          );
        }

        const cta = kind === 'cta';
        const showLabel = on || cta;
        const text = cta && item.busy && item.busyLabel ? item.busyLabel : label;

        return (
          <button
            key={item.id}
            className={[
              'dockb',
              cta ? 'dockcta' : '',
              on ? 'on' : '',
              pressed && item.tone === 'danger' ? 'danger' : '',
              item.voiceActive ? 'voiceon' : '',
            ].filter(Boolean).join(' ')}
            onClick={run}
            title={text}
            aria-label={text}
            aria-current={on && kind === 'nav' ? 'page' : undefined}
            aria-pressed={kind === 'toggle' ? !!item.pressed : undefined}
          >
            {icon}
            {showLabel && <span className="dockl">{text}</span>}
          </button>
        );
      })}
    </div>
  );
};
