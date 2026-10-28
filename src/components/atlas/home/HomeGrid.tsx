/**
 * The widget grid under the band: six columns, 12 px gap, packed dense in the
 * user's order at each widget's span (§04). Stage mode gives it the row
 * budget the viewport has; Grid mode lets it grow.
 */
import type { ReactNode } from 'react';
import { packStage, type HomeSlot, type PackedSlot } from '@/lib/betaHome';

export interface HomeGridProps {
  slots: readonly HomeSlot[];
  /** Row budget; omit to let the grid grow (Grid layout). */
  rows?: number;
  density: 'Airy' | 'Regular' | 'Dense';
  render: (slot: PackedSlot) => ReactNode;
}

export function HomeGrid({ slots, rows, density, render }: HomeGridProps) {
  const packed = rows != null ? packStage(slots, rows).placed : packStage(slots, 999).placed;
  const gap = { Airy: 18, Regular: 12, Dense: 8 }[density];
  return (
    <div
      className="b-grid b-home-grid"
      style={{ gap, gridTemplateRows: rows != null ? `repeat(${rows}, minmax(121px, 1fr))` : undefined, gridAutoRows: rows != null ? undefined : 121 }}
    >
      {packed.map((p) => render(p))}
    </div>
  );
}
