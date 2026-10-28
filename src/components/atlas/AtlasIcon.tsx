/**
 * One glyph from icon set 1a "Precision" (see icons.ts). Draws with
 * `currentColor`, so the icon takes the colour of the text around it.
 */
import type { SVGProps } from 'react';
import { ICON_PATHS, type IconName } from './icons';

export interface AtlasIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** CSS px. Default 18. */
  size?: number;
  /** Stroke width. Default 1.9 — the set's weight. The dock uses 1.9, the top bar 1.7. */
  weight?: number;
  /** Accessible label; without it the icon is decorative. */
  title?: string;
}

export function AtlasIcon({ name, size = 18, weight = 1.9, title, ...rest }: AtlasIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
