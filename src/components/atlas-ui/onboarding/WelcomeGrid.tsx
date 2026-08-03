import type { ReactNode } from 'react';
import { LayoutGrid } from 'lucide-react';
import { Empty } from '@/components/atlas-ui/primitives';

/**
 * The welcome bento — "here is what that turns on".
 *
 * WHAT THIS DELIBERATELY DOES NOT SHOW. The design's version of this grid is
 * six tiles reading "Eleven threads handled before coffee", "32 devices",
 * "€81,240 net across four accounts", a seven-bar heart-rate sparkline and a
 * lit-device matrix — every number invented, and four of the six surfaces
 * (Smart home, Health, Banking, Browser) have no route, no page and no data
 * source in this app (handoff README §2 lists them as "Not built"). A first-run
 * screen is the worst possible place to promise them: it is the one moment the
 * user has no way to check. T4 spent a week deleting exactly this class of
 * fabrication out of Atlas Core.
 *
 * So the grid keeps the design's shape — a 6-column bento, span 3 / 3 / 2 / 2 /
 * 2 / 6, staggered entry — and binds it to the only thing that is genuinely
 * known at this point in the flow: which capabilities the user just chose, and
 * which of those macOS actually granted. `note` is the live line. There is no
 * metric slot at all, because there is no metric.
 */
export type WelcomeFeatureState = 'on' | 'off' | 'denied' | 'neutral';

export interface WelcomeFeature {
  id: string;
  name: string;
  /** The claim. A sentence, never a statistic. */
  claim: string;
  /** What is true about it right now — the granted line, or what will not work. */
  note: string;
  state: WelcomeFeatureState;
  span: 2 | 3 | 6;
  icon: ReactNode;
}

const STATE_WORD: Record<WelcomeFeatureState, string> = {
  on: 'on',
  off: 'off',
  denied: 'refused by macOS',
  neutral: 'always on',
};

export function WelcomeGrid({ features }: { features: WelcomeFeature[] }) {
  if (features.length === 0) {
    return (
      <Empty
        size="section"
        icon={<LayoutGrid className="i20" />}
        title="Nothing to show yet"
        body="Atlas could not read its own capability list, so there is nothing honest to put here. Everything still works — you can review permissions in Settings."
      />
    );
  }

  return (
    <div className="onb-bento">
      {features.map((f, i) => (
        <article
          key={f.id}
          className={`onb-feat onb-feat-${f.state} onb-span-${f.span}`}
          style={{ animationDelay: `${0.18 + i * 0.07}s` }}
        >
          <header className="onb-feat-head">
            <span className="onb-feat-ico" aria-hidden>{f.icon}</span>
            <p className="onb-feat-name">{f.name}</p>
            <span className="onb-feat-state">{STATE_WORD[f.state]}</span>
          </header>
          <p className="onb-feat-claim">{f.claim}</p>
          {/* The per-tile empty state: a feature whose capability is off says
              what will not work, in the same words the permission tile used. */}
          <p className="onb-feat-note">{f.note}</p>
        </article>
      ))}
    </div>
  );
}

export default WelcomeGrid;
