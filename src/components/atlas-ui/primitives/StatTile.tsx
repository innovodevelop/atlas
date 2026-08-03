import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * A labelled number.
 *
 * Two genuinely different components shared the job: `.statcard`, Atlas Core's
 * 4-up KPI with its own surface and a 42px icon well, and `.estat`, the
 * surface-less centred micro-stat used 15× in the expanded views. `layout`
 * names the two rather than exposing `surface` as a boolean nobody would set
 * correctly.
 *
 * `trend` IS TYPED, and that is the point. It used to be arbitrary JSX, which
 * is how `/atlas-core` ends up rendering a hardcoded "+12% from last period"
 * beside a real value of `0` — the worst data-honesty defect in the app. A
 * `{ direction, label }` shape makes "no trend" the zero-cost default and makes
 * a fabricated one something you have to write on purpose.
 *
 * This component does not remove the fabrication that is already there. The
 * hardcoded trends, throughput numbers and knowledge rows in AtlasCoreScreen
 * are a data problem, not a styling one.
 */
export type StatDirection = 'up' | 'down' | 'flat';

interface StatTileProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  label: ReactNode;
  value: ReactNode;
  /** `kpi` is the surfaced Core tile; `micro` is the centred expanded-view stat. */
  layout?: 'kpi' | 'micro';
  icon?: ReactNode;
  trend?: { direction: StatDirection; label: ReactNode; icon?: ReactNode };
  /** Tabular numerals. On by default — README §7 requires them on every count. */
  tnum?: boolean;
}

export const StatTile = ({
  label, value, layout = 'kpi', icon, trend, tnum = true, className, ...rest
}: StatTileProps) => {
  if (layout === 'micro') {
    return (
      <div className={['estat', className].filter(Boolean).join(' ')} {...rest}>
        {icon}
        <div className={`esval${tnum ? ' tnum' : ''}`}>{value}</div>
        <div className="eslbl">{label}</div>
      </div>
    );
  }
  const dir = trend?.direction ?? 'flat';
  return (
    <div className={['statcard', className].filter(Boolean).join(' ')} {...rest}>
      <div>
        <p className="statlbl">{label}</p>
        <p className={`statval${tnum ? ' tnum' : ''}`}>{value}</p>
        {trend && (
          <span
            className="stattrend"
            style={{ color: dir === 'up' ? 'var(--grn)' : dir === 'down' ? 'var(--red)' : 'var(--ink2)' }}
          >
            {trend.icon}
            <span>{trend.label}</span>
          </span>
        )}
      </div>
      {icon && <div className="statico">{icon}</div>}
    </div>
  );
};
