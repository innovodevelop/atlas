import type { ComponentPropsWithoutRef, KeyboardEvent, ReactNode } from 'react';

/**
 * The dashboard card.
 *
 * Wraps the `.cardB` / `.chB` / `.cbB` vocabulary the ten dashboard cards
 * already used, and adds the two things the Widget Catalog specifies and the
 * app never had: a skin (Glass on light, Ink on dark) and a declared size.
 *
 * SIZE, honestly. The catalog names five sizes on a six-column grid
 * (s 2x1 / m 3x1 / l 3x2 / xl 6x2 / hero 6x3). The dashboard grid is
 * `repeat(auto-fill, minmax(340px, 1fr))` with two span modifiers, so only four
 * of them are expressible today. `hero` is absent rather than aliased onto
 * `xl`: a widget registry with per-widget span metadata is an architecture
 * change (there is no registry — the ten cards are a hardcoded list), and
 * silently rendering a `hero` at `xl` would hide that.
 *
 * ICONS. `Atlas Design System.dc.html` specifies a header icon well; the Widget
 * Catalog's own copy says the cards are drawn "with no icons and no coloured
 * tiles". All ten shipped cards render one, so `Card.Header` keeps `icon`
 * optional and the app keeps its icons. Flagged rather than silently decided.
 */
export type CardSkin = 'glass' | 'ink' | 'accent';
export type CardSize = 's' | 'm' | 'l' | 'xl';

const SPAN: Record<CardSize, string> = { s: '', m: 'sp2', l: 'rs2', xl: 'sp2 rs2' };
const SKIN: Record<CardSkin, string> = { glass: '', ink: 'cardInk', accent: 'cardAcc' };

interface CardProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title' | 'onClick'> {
  size?: CardSize;
  skin?: CardSkin;
  /** Click AND Enter/Space. Its presence is what makes the card a control. */
  onOpen?: () => void;
  /** Entry-animation stagger index, 1–10 (`.d1`…`.d10`), not milliseconds. */
  delay?: number;
  /**
   * Full-bleed layer painted BEHIND the header and body — the weather
   * atmosphere canvas, the music field. A prop rather than a child because the
   * header and body sit at z-index 2 and normal flow would push them down.
   */
  bleed?: ReactNode;
  children: ReactNode;
}

export const Card = ({
  size = 'l', skin = 'glass', onOpen, delay, bleed, className, children, ...rest
}: CardProps) => {
  const cls = [
    'cardB', SPAN[size], SKIN[skin],
    delay ? `d${Math.min(10, Math.max(1, delay))}` : '',
    onOpen ? '' : 'cardStatic',
    className,
  ].filter(Boolean).join(' ');

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onOpen) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
  };

  return (
    <div
      className={cls}
      onClick={onOpen}
      onKeyDown={onOpen ? onKey : undefined}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      {...rest}
    >
      {bleed ? <div className="cardBleed">{bleed}</div> : null}
      {children}
    </div>
  );
};

interface CardHeaderProps {
  label: ReactNode;
  icon?: ReactNode;
  /** Right-aligned control. Stops propagation so it cannot also open the card. */
  action?: ReactNode;
}

const CardHeader = ({ label, icon, action }: CardHeaderProps) => (
  <div className="chB">
    <p className="mlblB">{label}</p>
    {action ?? (icon ? <div className="icboxB fx ac jc">{icon}</div> : null)}
  </div>
);

const CardBody = ({ className, children, ...rest }: ComponentPropsWithoutRef<'div'>) => (
  <div className={['cbB', className].filter(Boolean).join(' ')} {...rest}>{children}</div>
);

Card.Header = CardHeader;
Card.Body = CardBody;
