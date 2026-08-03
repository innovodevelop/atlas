import { ArrowRight, CornerDownRight } from 'lucide-react';
import type { ModelTier } from '@/lib/mocks/modelLab';
import { GATEWAY } from '@/lib/mocks/modelLab';
import { ModelId, Pill, SecLabel } from './parts';

/**
 * The two drawings this surface uses.
 *
 * `RouteMini` is the card stage — the slot the handoff fills with a rendered
 * canvas object. There is no object to render here, so the stage holds the one
 * thing a routing card actually has to communicate at a glance: the request
 * splits into two lanes, and on one of them the endpoint you named is not the
 * endpoint you get. Its strokes are an ILLUSTRATION, not element borders
 * (README §1.1 exempts diagram lines explicitly), and it carries no id text —
 * the ids are real text in the card body below, where they are readable and
 * selectable rather than 8px SVG glyphs.
 *
 * `RouteFlow` is the detail hero. It is HTML, not SVG, for one reason: it is
 * mostly long identifiers, and identifiers in SVG cannot wrap, cannot be
 * selected comfortably and cannot be read by a screen reader in order.
 */

const laneLabel = { anthropic: 'First-party', bedrock: 'Bedrock' } as const;

export const RouteMini = ({ tier }: { tier: ModelTier }) => {
  const { substituted, profile } = tier.bedrock;
  const unmapped = profile === null;

  return (
    <svg
      className="ml-mini"
      viewBox="0 0 180 110"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={
        unmapped
          ? `${tier.label}: the first-party lane resolves, the Bedrock lane has no mapped profile.`
          : substituted
            ? `${tier.label}: the first-party lane resolves to the named model, the Bedrock lane is substituted.`
            : `${tier.label}: both lanes resolve to the named model.`
      }
    >
      <text className="ml-mini-lbl" x="14" y="26">FIRST-PARTY</text>
      <line x1="14" y1="34" x2="146" y2="34" className="ml-mini-line" />
      <circle cx="150" cy="34" r="4.5" className="ml-mini-dot-ok" />

      <text className="ml-mini-lbl" x="14" y="68">BEDROCK</text>

      {!substituted && !unmapped && (
        <>
          <line x1="14" y1="76" x2="146" y2="76" className="ml-mini-line" />
          <circle cx="150" cy="76" r="4.5" className="ml-mini-dot-ok" />
        </>
      )}

      {substituted && (
        <>
          <line x1="14" y1="76" x2="112" y2="76" className="ml-mini-line" />
          {/* The endpoint that was NAMED — dashed, ending in a struck ring. */}
          <line x1="112" y1="76" x2="146" y2="76" className="ml-mini-line ml-mini-line-dash" />
          <circle cx="150" cy="76" r="4.5" className="ml-mini-ring-denied" />
          <line x1="146.5" y1="79.5" x2="153.5" y2="72.5" className="ml-mini-slash" />
          {/* The endpoint actually invoked. */}
          <path d="M112 76 C 126 76, 126 98, 140 98" className="ml-mini-line ml-mini-line-div" />
          <circle cx="150" cy="98" r="4.5" className="ml-mini-dot-ok" />
        </>
      )}

      {unmapped && (
        <>
          <line x1="14" y1="76" x2="112" y2="76" className="ml-mini-line" />
          <line x1="112" y1="76" x2="140" y2="76" className="ml-mini-line ml-mini-line-dash" />
          <circle cx="148" cy="76" r="5" className="ml-mini-ring-open" />
        </>
      )}
    </svg>
  );
};

/**
 * Call site → gateway → lane. Every box is a fact from the mirrored source; the
 * arrows are the only decoration, and they are drawn glyphs.
 */
export const RouteFlow = ({ tier, active }: { tier: ModelTier; active: 'anthropic' | 'bedrock' | null }) => {
  const b = tier.bedrock;

  return (
    <div className="ml-flow">
      <div className="ml-flow-col">
        <SecLabel>Call site asks for</SecLabel>
        {tier.aliases.length > 0 ? (
          tier.aliases.map((a) => <ModelId key={a} id={a} />)
        ) : (
          <p className="ml-flow-none">No logical alias maps here — a caller has to name <ModelId id={tier.id} /> itself.</p>
        )}
        {tier.isDefault && (
          <p className="ml-flow-none">…and every id the map does not recognise, silently.</p>
        )}
      </div>

      <ArrowRight className="i16 ml-flow-arrow" aria-hidden />

      <div className="ml-flow-col">
        <SecLabel>Gateway collapses to</SecLabel>
        <ModelId id={tier.id} />
        <p className="ml-flow-none">mapModelToClaude() — one tier vocabulary for both lanes.</p>
      </div>

      <ArrowRight className="i16 ml-flow-arrow" aria-hidden />

      <div className="ml-flow-lanes">
        {GATEWAY.lanes.map((lane) => {
          const on = active === lane.id;
          return (
            <div key={lane.id} className={`ml-lane${on ? ' ml-lane-on' : ''}`}>
              <div className="ml-lane-head">
                <SecLabel>{laneLabel[lane.id]}</SecLabel>
                {on && <Pill tone="accent">Active</Pill>}
              </div>

              {lane.id === 'anthropic' ? (
                <>
                  <ModelId id={tier.firstParty.model} />
                  <p className="ml-flow-none">{tier.firstParty.note}</p>
                </>
              ) : b.profile === null ? (
                <>
                  <ModelId id={b.requested} strike />
                  <p className="ml-flow-none">
                    No default profile. Mapping this tier throws before any request is signed —
                    set <ModelId id={b.envOverride} /> to opt in.
                  </p>
                </>
              ) : b.substituted ? (
                <>
                  <div className="ml-lane-swap">
                    <ModelId id={b.requested} strike />
                    <Pill tone="warn">AccessDenied</Pill>
                  </div>
                  <div className="ml-lane-swap">
                    <CornerDownRight className="i14 ml-flow-arrow" aria-hidden />
                    <ModelId id={b.profile} />
                  </div>
                  <p className="ml-flow-none">{b.note}</p>
                </>
              ) : (
                <>
                  <ModelId id={b.profile} />
                  <p className="ml-flow-none">{b.note}</p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
