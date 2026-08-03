import { CircleSlash, Info } from 'lucide-react';
import { Empty } from '@/components/atlas-ui/primitives';
import type { ModelTier } from '@/lib/mocks/modelLab';
import { TIERS, UNKNOWN_ID_FALLBACK } from '@/lib/mocks/modelLab';
import { ModelId, Pill } from './parts';
import { RouteMini } from './RouteFlow';

/**
 * "Every model, one wall" — the handoff's overview tab, with the routing table
 * in place of the 3D asset grid.
 *
 * The card's headline fact is what a call on this tier ACTUALLY invokes on the
 * lane the app is running, not the id the tier is named after. On the Bedrock
 * lane those differ for three of the five tiers, and a lab that showed only the
 * names would be advertising models this account cannot call.
 *
 * There is no fabricated telemetry on these cards — no latency, no cost, no
 * "requests today". Nothing in the repo measures any of it (see the Providers
 * tab, which shows the table that WOULD hold it and the fact that nothing
 * writes to it).
 */

const BAND_LABEL: Record<ModelTier['band'], string> = {
  frontier: 'Frontier',
  balanced: 'Balanced',
  fast: 'Fast',
};

function stateFor(tier: ModelTier, lane: 'anthropic' | 'bedrock') {
  if (lane === 'anthropic') {
    return { tone: 'ok' as const, label: 'Reaches the named model', id: tier.firstParty.model };
  }
  if (tier.bedrock.profile === null) {
    return { tone: 'off' as const, label: 'No profile mapped', id: null };
  }
  if (tier.bedrock.substituted) {
    return { tone: 'warn' as const, label: 'Substituted', id: tier.bedrock.profile };
  }
  return { tone: 'ok' as const, label: 'Entitled', id: tier.bedrock.profile };
}

interface ModelWallProps {
  /** The lane the runtime reports. `null` when it cannot be read at all. */
  lane: 'anthropic' | 'bedrock' | null;
  /**
   * The tier whose detail was open last. Esc walks back to this wall, and
   * without a mark you land on a grid of five cards with no idea which one you
   * just left.
   */
  recent: string | null;
  onOpen: (id: string) => void;
}

export const ModelWall = ({ lane, recent, onOpen }: ModelWallProps) => {
  // With no readable runtime the wall still has to say *something* concrete, so
  // it shows the Bedrock lane — the one with the entitlement problem — and
  // labels it as an assumption rather than as the live state.
  const shown: 'anthropic' | 'bedrock' = lane ?? 'bedrock';

  // Unreachable from the shipped table — five literal tiers — but wired into
  // the render path rather than exported and never called. An empty state that
  // no branch can reach is not a designed empty state, it is a decoration.
  if (TIERS.length === 0) return <ModelWallEmpty />;

  return (
    <>
      <div className="ml-wall">
        {TIERS.map((tier) => {
          const state = stateFor(tier, shown);
          return (
            <article
              key={tier.id}
              className={`ml-card${recent === tier.id ? ' ml-card-on' : ''}`}
              role="button"
              tabIndex={0}
              aria-current={recent === tier.id ? 'true' : undefined}
              aria-label={`${tier.label} — open routing detail`}
              onClick={() => onOpen(tier.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(tier.id); }
              }}
            >
              <div className="ml-stage">
                <span className="ml-kind">{BAND_LABEL[tier.band]}</span>
                <RouteMini tier={tier} />
              </div>
              <p className="ml-card-name">{tier.label}</p>
              <p className="ml-card-meta">
                {state.id ? <ModelId id={state.id} /> : <span className="ml-card-none">nothing to invoke</span>}
              </p>
              <div className="ml-card-foot">
                <Pill tone={state.tone}>{state.label}</Pill>
                {tier.isDefault && <Pill tone="accent">Default</Pill>}
              </div>
            </article>
          );
        })}
      </div>

      <div className="ml-wall-notes">
        <p className="ml-note">
          <Info className="i14" aria-hidden />
          <span>
            Showing what each tier invokes on the <strong>{shown === 'bedrock' ? 'Bedrock' : 'first-party'}</strong> lane
            {lane === null ? ' — assumed, because the running lane could not be read outside the desktop app.' : '.'}
          </span>
        </p>
        <p className="ml-note">
          <CircleSlash className="i14" aria-hidden />
          <span>
            An id the map does not recognise is not an error: <code className="ml-inline-id">mapModelToClaude()</code> returns
            the default tier, so a typo runs silently on <ModelId id={UNKNOWN_ID_FALLBACK} />.
          </span>
        </p>
      </div>
    </>
  );
};

/**
 * The wall's empty state — what a routing surface looks like when there is no
 * routing table. The tier list is a literal today and a fetch tomorrow, and a
 * surface with no designed empty state is how a panel ends up filled with
 * invented rows to stop it looking broken.
 */
export const ModelWallEmpty = () => (
  <Empty
    size="section"
    icon={<CircleSlash className="i20" />}
    title="No models mapped"
    body="The gateway has no routing table, so every call would fail closed rather than pick a model for you. Nothing is inferred here — an empty table means no model is reachable, not that a default is in use."
    status="error"
  />
);
