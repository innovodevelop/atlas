import { KeyRound, Layers, Lock, ShieldAlert } from 'lucide-react';
import { Empty, Panel, StatTile } from '@/components/atlas-ui/primitives';
import type { ModelTier } from '@/lib/mocks/modelLab';
import { GATEWAY, OPUS5_RECHECK_ON, VERIFIED_ON } from '@/lib/mocks/modelLab';
import { Kv, ModelId, Note, Pill, SecLabel } from './parts';
import { RouteFlow } from './RouteFlow';

/**
 * The handoff's "device editor" shape — a hero stage on the left with a 4-up
 * strip under it, and a 380px column of control cards on the right — carrying
 * routing facts instead of geometry sliders.
 *
 * THE SLIDERS ARE DELIBERATELY ABSENT, and the Parameters card says why on
 * screen. `model_configs` exists in `src-tauri/src/db_schema.sql` with exactly
 * the columns a parameter editor wants (tier, model_name, max_tokens,
 * temperature, is_default) — and nothing in the app or either sidecar reads or
 * writes it. A slider bound to that table would be a control that moves a
 * number no request ever sees, which is worse than no control at all.
 */
export const ModelDetail = ({
  tier, lane,
}: { tier: ModelTier; lane: 'anthropic' | 'bedrock' | null }) => {
  const b = tier.bedrock;

  return (
    <div className="ml-split">
      <section className="ml-split-main">
        <div className="ml-stage-hero">
          <div className="ml-stage-tag">
            <SecLabel>{tier.label}</SecLabel>
            <span className="ml-stage-sub">{tier.blurb}</span>
          </div>
          <RouteFlow tier={tier} active={lane} />
        </div>

        <div className="ml-facts">
          <StatTile
            layout="micro"
            tnum={false}
            value={b.geo === 'worldwide' ? 'Worldwide' : b.geo === 'eea' ? 'EEA' : 'n/a'}
            label="routing geography"
          />
          <StatTile
            layout="micro"
            tnum={false}
            value={tier.capabilities.adaptive ? 'Adaptive' : 'Fixed'}
            label="thinking / effort"
          />
          <StatTile
            layout="micro"
            value={GATEWAY.maxTokens.streaming.toLocaleString()}
            label="max output tokens · streaming"
          />
          <StatTile
            layout="micro"
            value={String(tier.aliases.length)}
            label={`logical id${tier.aliases.length === 1 ? '' : 's'} mapped here`}
          />
        </div>
      </section>

      <aside className="ml-aside">
        <Panel>
          <SecLabel>Reached by</SecLabel>
          {tier.aliases.length > 0 ? (
            tier.aliases.map((a) => <Kv key={a} k={<ModelId id={a} />} v="maps here" />)
          ) : (
            <Empty body="No logical alias maps to this tier — it is reachable only by naming it, or through an explicit env override." />
          )}
          {tier.isDefault && (
            <Kv k="Unrecognised ids" v={<Pill tone="accent">land here</Pill>} />
          )}
        </Panel>

        <Panel>
          <div className="ml-panel-head">
            <SecLabel>Bedrock profile</SecLabel>
            <Layers className="i16 ml-panel-ico" aria-hidden />
          </div>
          {b.profile === null ? (
            <>
              <Kv k="Named" v={<ModelId id={b.requested} strike />} />
              <Empty
                status="stale"
                body={<>No <code className="ml-inline-id">TIER_DEFAULT</code> entry, so mapping this tier throws before a request is signed. Set <ModelId id={b.envOverride} /> to opt in — one deliberate act, the same rule every other tier obeys.</>}
              />
            </>
          ) : (
            <>
              <Kv k="Named" v={<ModelId id={b.requested} strike={b.substituted} />} />
              <Kv k="Invoked" v={<ModelId id={b.profile} />} diff={b.substituted} />
            </>
          )}
          <Kv k="Override" v={<ModelId id={b.envOverride} />} />
          <Kv k="Region" v="eu-central-1" />
          <Note>{b.note}</Note>
        </Panel>

        <Panel>
          <div className="ml-panel-head">
            <SecLabel>Entitlement</SecLabel>
            <ShieldAlert className="i16 ml-panel-ico" aria-hidden />
          </div>
          <Kv
            k={<ModelId id={b.requested} />}
            v={<Pill tone={b.requestedState === 'invocable' ? 'ok' : 'warn'}>
              {b.requestedState === 'invocable' ? 'answers' : 'AccessDenied'}
            </Pill>}
          />
          {b.profile && b.substituted && (
            <Kv k={<ModelId id={b.profile} />} v={<Pill tone="ok">answers</Pill>} />
          )}
          <Note>
            Verified by a signed InvokeModel against eu-central-1 on {VERIFIED_ON}, not read off a docs page.
            Listing a profile proves it exists, not that this account may invoke it.
            {tier.id === 'claude-opus-5' && ` Re-checked as the root account on ${OPUS5_RECHECK_ON}, which rules IAM out — the newest tier needs its own model-access request.`}
          </Note>
        </Panel>

        <Panel>
          <div className="ml-panel-head">
            <SecLabel>Capabilities</SecLabel>
            <KeyRound className="i16 ml-panel-ico" aria-hidden />
          </div>
          <Kv
            k="Adaptive thinking"
            v={<Pill tone={tier.capabilities.adaptive ? 'ok' : 'off'}>{tier.capabilities.adaptive ? 'supported' : 'not sent'}</Pill>}
          />
          <Kv
            k="Thinking on Bedrock"
            v={b.thinking === 'omitted' ? 'omitted' : b.thinking === 'explicitly-disabled' ? 'explicitly disabled' : 'unconditional'}
          />
          <Kv k="web_search / web_fetch" v={<Pill tone="warn">first-party lane only</Pill>} />
          <Note>{tier.capabilities.note}</Note>
          <Note>{GATEWAY.serverToolBridge}</Note>
        </Panel>

        <Panel>
          <div className="ml-panel-head">
            <SecLabel>Parameters</SecLabel>
            <Lock className="i16 ml-panel-ico" aria-hidden />
          </div>
          <Kv k="max_tokens · blocking" v={<span className="tnum">{GATEWAY.maxTokens.blocking.toLocaleString()}</span>} />
          <Kv k="max_tokens · streaming" v={<span className="tnum">{GATEWAY.maxTokens.streaming.toLocaleString()}</span>} />
          <Kv k="effort" v="medium" />
          {/* `size="inline"`, so no icon slot — the lock lives in the head row. */}
          <Empty
            status="stale"
            body={<>Read-only. <code className="ml-inline-id">model_configs</code> exists in the local schema with max_tokens and temperature columns, but nothing reads or writes it — a slider here would move a number no request ever sees.</>}
          />
        </Panel>
      </aside>
    </div>
  );
};
