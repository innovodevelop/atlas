import { Activity, Cpu, KeyRound, Server, TriangleAlert } from 'lucide-react';
import { Empty, Panel, Row } from '@/components/atlas-ui/primitives';
import { useAtlasProviderStatus, type ProviderStatusType } from '@/hooks/useAtlasProviderStatus';
import { useUsageHistory } from '@/hooks/useUsageHistory';
import { GATEWAY } from '@/lib/mocks/modelLab';
import { Kv, Note, Pill, SecLabel, type PillTone } from './parts';
import { activeLane, type ModelLabRuntime } from './useModelLabRuntime';

/**
 * The only tab on this surface that reads live state — and the one that has to
 * be most careful about the difference between "nothing happened" and "we
 * cannot see".
 *
 * Three sources, three different honest failures:
 *
 *  1. `brain_ai_status` / `atlas_brain_info` (Tauri) — key PRESENCE and whether
 *     the sidecar is up. Outside the desktop app these do not exist at all, so
 *     the panel says "desktop app required" rather than rendering "no key".
 *
 *  2. `atlas_provider_status` via `useAtlasProviderStatus()` — the table the app
 *     has always had for provider health. In the local-first build NOTHING
 *     WRITES IT: the only inserts live in `supabase/migrations/*`, which sit on
 *     no runtime path, and `src-tauri/src/db_schema.sql` creates the table
 *     without a seed. So the honest render is an empty state that names the
 *     reason, not four invented rows.
 *
 *  3. `atlas_usage_history` via `useUsageHistory()` — same shape of problem.
 *
 * A fourth fact worth surfacing, because it is invisible from the data: the
 * table's own CHECK constraint allows only lovable_ai / perplexity / anthropic /
 * jina / openai. Bedrock — the lane this app actually runs its background tier
 * on — cannot be recorded there even once something starts writing.
 */

const STATUS_TONE: Record<ProviderStatusType, PillTone> = {
  healthy: 'ok',
  degraded: 'warn',
  rate_limited: 'warn',
  error: 'off',
  credits_exhausted: 'off',
  unknown: 'neutral',
};

const LANE_LABEL: Record<'anthropic' | 'bedrock', string> = {
  anthropic: 'First-party (api.anthropic.com)',
  bedrock: 'Bedrock (eu-central-1)',
};

/**
 * `runtime` is a prop, not a second `useModelLabRuntime()` call: the page
 * already holds one, and mounting the hook twice would double the Tauri IPC for
 * a value that cannot change without an app relaunch.
 */
export const ProvidersView = ({ runtime }: { runtime: ModelLabRuntime }) => {
  const lane = activeLane(runtime.status);
  const { providers, isLoading: providersLoading } = useAtlasProviderStatus();
  const usage = useUsageHistory('daily', 30);

  return (
    <div className="ml-providers">
      <Panel>
        <div className="ml-panel-head">
          <SecLabel>Runtime</SecLabel>
          <Cpu className="i16 ml-panel-ico" aria-hidden />
        </div>

        {!runtime.available ? (
          <Empty
            size="block"
            icon={<Server className="i20" />}
            title="Desktop app required"
            body="The active lane and the key inventory live in the macOS Keychain and the brain sidecar. A browser can see neither — so this reports nothing rather than reporting 'no keys'."
          />
        ) : runtime.loading ? (
          <Empty status="stale" body="Reading the Keychain…" />
        ) : runtime.error ? (
          <Empty
            size="block"
            icon={<TriangleAlert className="i20" />}
            status="error"
            title="Could not read the runtime"
            body={runtime.error}
            action={{ label: 'Try again', onClick: runtime.reload }}
          />
        ) : (
          <>
            <Kv
              k="Active lane"
              v={lane ? <Pill tone="accent">{LANE_LABEL[lane]}</Pill> : <Pill tone="neutral">unknown</Pill>}
            />
            <Kv
              k="Anthropic key"
              v={<Pill tone={runtime.status?.anthropic ? 'ok' : 'off'}>{runtime.status?.anthropic ? 'present' : 'absent'}</Pill>}
            />
            <Kv
              k="AWS credential pair"
              v={<Pill tone={runtime.status?.bedrock ? 'ok' : 'off'}>{runtime.status?.bedrock ? 'present' : 'absent'}</Pill>}
            />
            <Kv
              k="Brain sidecar"
              v={<Pill tone={runtime.brain?.running ? 'ok' : 'off'}>{runtime.brain?.running ? 'running' : 'not running'}</Pill>}
            />
            {runtime.brain?.integrity_error && (
              <Note>Integrity: {runtime.brain.integrity_error}</Note>
            )}
            <Note>
              Key presence only — the command never returns a value. Selection follows {GATEWAY.switchEnv},
              read from the Keychain ({GATEWAY.switchKeychain}) when the sidecar is spawned, so a key change
              takes effect on the next launch. {GATEWAY.failClosed}
            </Note>
          </>
        )}
      </Panel>

      <Panel>
        <div className="ml-panel-head">
          <SecLabel>Provider health</SecLabel>
          <Activity className="i16 ml-panel-ico" aria-hidden />
        </div>

        {providersLoading ? (
          <Empty status="stale" body="Reading atlas_provider_status…" />
        ) : providers.length === 0 ? (
          <Empty
            size="block"
            icon={<Activity className="i20" />}
            status="stale"
            title="No provider health recorded"
            body="atlas_provider_status exists in the local schema, but nothing in the app or either sidecar writes to it — the only inserts live in the retired Supabase migrations. Latency, error counts and success rates are therefore unmeasured, not zero."
          />
        ) : (
          providers.map((p) => (
            <Row
              key={p.id}
              lead={<span className={`ml-dot ml-dot-${STATUS_TONE[p.status]}`} aria-hidden />}
              title={p.provider}
              meta={
                p.last_success
                  ? `last success ${new Date(p.last_success).toLocaleString()}`
                  : p.last_error
                    ? `last error ${p.last_error}`
                    : 'no calls recorded'
              }
              trail={
                <>
                  {p.avg_response_time_ms != null && (
                    <span className="ml-trail tnum">{p.avg_response_time_ms} ms</span>
                  )}
                  <span className="ml-trail tnum">
                    {p.successful_calls}/{p.total_calls}
                  </span>
                  <Pill tone={STATUS_TONE[p.status]}>{p.status.replace('_', ' ')}</Pill>
                </>
              }
            />
          ))
        )}
        <Note>
          The table can only hold five provider names (lovable_ai, perplexity, anthropic, jina, openai) — a
          CHECK constraint, not a convention. Bedrock, which serves the background tier, has no row shape here
          at all, so even a future writer could not record it without a schema change.
        </Note>
      </Panel>

      <Panel>
        <div className="ml-panel-head">
          <SecLabel>Spend · last 30 days</SecLabel>
          <KeyRound className="i16 ml-panel-ico" aria-hidden />
        </div>
        {usage.isLoading ? (
          <Empty status="stale" body="Reading atlas_usage_history…" />
        ) : usage.history.length === 0 ? (
          <Empty
            size="block"
            status="stale"
            title="No usage recorded"
            body="atlas_usage_history has no rows for this window. Like provider health, it has no writer on the local-first path — so there is no per-model cost to compare, and none is estimated here."
          />
        ) : (
          <>
            <Kv k="Days recorded" v={<span className="tnum">{usage.history.length}</span>} />
            <Kv k="Total estimated cost" v={<span className="tnum">${usage.totalSpent.toFixed(2)}</span>} />
            <Note>
              Cost is aggregated per PROVIDER, never per model, and the named buckets in that aggregation
              (lovable_ai / perplexity / openai / anthropic / firecrawl) predate the Bedrock lane — Bedrock
              spend would land in the total and in no bucket. The "top provider" that aggregation computes is
              deliberately not shown for that reason.
            </Note>
          </>
        )}
      </Panel>
    </div>
  );
};
