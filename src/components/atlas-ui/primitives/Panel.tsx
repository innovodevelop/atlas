import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * A surface one step down the paper scale from whatever contains it.
 *
 * Three unrelated things were called "panel": `.gpanel`/`.gpanel2` (the
 * expanded views and Settings, 57 uses), `.cpanel` (Atlas Core's titled panel,
 * with a local `Panel` component already wrapping it in AtlasCoreTabs), and
 * `.panel`/`.panel2` (the design originals, zero uses — deleted in this pass).
 * This is the one component for all of them.
 *
 * TONE is the paper scale as a prop (README §1.1): `panel` is the default step,
 * `recessed` is a nested well, `wash` is the blue-tinted emphasis FILL that
 * replaced every blue outline, `ink` is the dark card.
 *
 * THE `--acc` TRAP this fixes. `--acc` is a hex at `:root` but an HSL triplet
 * inside `.exp` / `.th-*`, so `hsl(var(--acc) / .12)` was only valid inside
 * those scopes — and where it *was* valid it painted the theme indigo, not
 * Atlas Blue. Settings renders `<div className="exp th-cal">`, so its five
 * "Atlas Blue" emphasis blocks were actually `hsl(243 80% 72%)`. `tone="wash"`
 * is the fix: one flat token, valid everywhere, the right colour.
 *
 * NOT for mail's panes. `.mail-pane`, `.mail-list-viewport` and
 * `.mail-side-group` carry `flex:1; min-height:0; overflow-y:auto` scroll
 * contracts (and, in the viewport's case, the virtualiser's positioning
 * context). Use `<Panel>` inside `.mail-pane-body`, never as it.
 */
export type PanelTone = 'panel' | 'recessed' | 'wash' | 'ink';
export type PanelPad = 'none' | 'sm' | 'md' | 'lg';

const TONE: Record<PanelTone, string> = {
  panel: '', recessed: 'panelRecessed', wash: 'panelWash', ink: 'panelDk',
};
const PAD: Record<PanelPad, string> = {
  none: 'panelPadNone', sm: 'panelPadSm', md: 'panelPadMd', lg: 'panelPadLg',
};

interface PanelProps extends Omit<ComponentPropsWithoutRef<'section'>, 'title'> {
  tone?: PanelTone;
  /** Explicit padding step. Settings hand-wrote `padding: 14` seven times. */
  pad?: PanelPad;
  /** Nested tier — smaller radius and padding (the old `.gpanel2`). */
  nested?: boolean;
  /** A heading row. Its presence switches the surface to Core's `.cpanel`. */
  title?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned control in the heading row. */
  action?: ReactNode;
  /** `flex: 1` inside a column — replaces the hand-written `gpanel f1 col`. */
  fill?: boolean;
  /** Lay the body out as a column with the standard gap. */
  column?: boolean;
  children?: ReactNode;
}

export const Panel = ({
  tone = 'panel', pad, nested, title, icon, action, fill, column,
  className, children, ...rest
}: PanelProps) => {
  const base = title ? 'cpanel' : nested ? 'gpanel2' : 'gpanel';
  const cls = [
    base, TONE[tone], pad ? PAD[pad] : '',
    fill ? 'f1' : '', column ? 'col gap16' : '', className,
  ].filter(Boolean).join(' ');

  return (
    <section className={cls} {...rest}>
      {title != null && (
        <h3 className="cph">
          {icon}
          <span className="f1">{title}</span>
          {action}
        </h3>
      )}
      {children}
    </section>
  );
};
