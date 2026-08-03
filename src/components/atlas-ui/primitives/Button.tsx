import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';

/**
 * The Atlas button.
 *
 * Before this there were seven unrelated button vocabularies — `.cta`, `.pbtn`,
 * `.xbtn`, `.chip`, `.bandlisten`, `.mail-empty-action` and
 * `.mail-pane-actions button` — plus seven hand-rolled inline-styled buttons in
 * Settings alone, three of which painted the wrong blue (see the `--acc` note
 * on `<Panel>`). This is the Design System's own set, and it enforces four
 * things the codebase repeatedly got wrong:
 *
 *  1. `border: none` is declared explicitly on `.abtn`, not merely omitted.
 *     WKWebView draws native control chrome otherwise (README §1.1).
 *  2. `size="icon"` without an `aria-label` is a TYPE ERROR. The app shipped
 *     unlabelled icon-only buttons in the expanded weather and calendar views.
 *  3. `type="button"` by default. Every mail button set it; no workshop button
 *     did, which is a live bug the moment one lands inside the rules `<form>`.
 *  4. `variant="danger"` is the only route to the destructive palette, so a
 *     destructive action cannot be styled as an ordinary one by accident.
 *
 * Deliberately NOT built on `src/components/ui/button.tsx`: that is shadcn
 * scaffolding used almost exclusively by the URL-only routes, and it carries a
 * `border` in its variants.
 *
 * Deliberately NOT covering: the dock (that is `<Dock>`'s internals) and the
 * login scene's `.achoice` / `.aenter` / `.bigin`, which are 24–38px
 * typographic controls with their own hover physics — forcing them through a
 * 40px pill would regress the login screen.
 */
export type ButtonVariant = 'primary' | 'ink' | 'ghost' | 'text' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'icon';

interface ButtonBase extends Omit<ComponentPropsWithoutRef<'button'>, 'children'> {
  variant?: ButtonVariant;
  /** Leading icon. Rendered before `children`; swapped for a spinner while `loading`. */
  icon?: ReactNode;
  /** Trailing slot — a keyboard hint, a count, a chevron. */
  trailing?: ReactNode;
  /** Disables the button and swaps the icon for a spinner. Width is preserved. */
  loading?: boolean;
}

type ButtonProps =
  | (ButtonBase & { size?: 'sm' | 'md'; children: ReactNode })
  /**
   * Icon-only buttons have no accessible name unless one is supplied, so the
   * type demands it. The glyph itself may arrive as `children` or as `icon` —
   * what is enforced is the label, not the shape.
   */
  | (ButtonBase & { size: 'icon'; 'aria-label': string; children?: ReactNode });

const SIZE: Record<ButtonSize, string> = { sm: 'abtn-sm', md: '', icon: 'abtn-icon' };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', icon, trailing, loading, className, children, disabled, ...rest },
  ref,
) {
  const cls = ['abtn', `abtn-${variant}`, SIZE[size], className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type="button" className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="abtn-spin" aria-hidden /> : icon}
      {children}
      {trailing}
    </button>
  );
});
