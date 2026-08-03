import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Clock, Sparkles, TrendingUp, Zap } from 'lucide-react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import { useUsageHistory } from '@/hooks/useUsageHistory';
import { useSpendingAlerts } from '@/hooks/useSpendingAlerts';
import { useAtlasProviderStatus } from '@/hooks/useAtlasProviderStatus';
import { BudgetSettingsPanel } from '@/components/atlas-health/BudgetSettingsPanel';
import { AtlasLearningControl } from './AtlasLearningControl';
import { SignedOut } from './SignedOut';
import { Button, Empty, Panel, Row, StatTile } from './primitives';

/**
 * Settings → Budget & AI.
 *
 * T4 part 2. The three usage/cost surfaces that only existed inside the unlinked
 * `/atlas-core-legacy` tree — `ModelUsageAnalytics`, `UsageHistoryChart` and
 * `CostOptimizationPanel` — land here, beside the budget controls they were
 * always about.
 *
 * FIVE THINGS DELIBERATELY NOT CARRIED ACROSS. The audit marked this trio as the
 * densest fabrication in the repo and it was right:
 *
 *  - `ModelUsageAnalytics.tsx:34-48` shipped a hardcoded price table for
 *    lovable_ai / perplexity / openai / jina / anthropic and multiplied it by a
 *    literal "estimate 500 tokens per successful call". Every dollar it rendered
 *    was invented twice over. The AGGREGATION is ported (real
 *    `runs.tokens_planner/worker/reasoner` sums); the pricing is not. This panel
 *    reports tokens, which Atlas actually records, and says so.
 *  - `UsageHistoryChart.tsx:17-37` charted five series, four of them providers
 *    Atlas no longer calls, through recharts — which brings its own bordered
 *    container chrome into a borderless design. No chart: the same numbers as
 *    rows, plus the honest reason the series is empty.
 *  - `CostOptimizationPanel.tsx:55-72`'s headline recommendation was "Switch to
 *    Lovable AI… 70% lower cost" with `savings = calls * 0.002`. Dead brand,
 *    dead provider, magic constant. The rules below are rewritten from signals
 *    that exist, and none of them quotes a saving Atlas cannot compute.
 *  - `ModelUsageAnalytics` embedded `<BudgetSettingsPanel />` as one of its own
 *    tabs. Absorbing it verbatim would have nested Budget inside Budget. The
 *    import is stripped; the live panel is mounted once, here, at the top.
 *  - The shadcn `tabs`/`select`/`badge`/`progress`/`chart` markup. T1 primitives
 *    and one native `<select>` instead.
 *
 * WHY "Spend history" IS EMPTY, AND WHY THAT IS THE TRUTH. `atlas_usage_history`
 * exists in `src-tauri/src/db_schema.sql:674` but nothing writes it: its only
 * writer was a Postgres trigger in the deleted Supabase migration
 * (`supabase/migrations/20260113235759_*.sql:77`), and the local Rust layer never
 * replaced it. So the table is structurally empty on every install. A chart
 * there would be a chart of nothing dressed as a chart of something.
 */

type Range = '7d' | '30d' | 'all';

const RANGE_LABEL: Record<Range, string> = {
  '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time',
};

const TIERS = [
  { key: 'planner', label: 'Planner' },
  { key: 'worker', label: 'Worker' },
  { key: 'reasoner', label: 'Reasoner' },
] as const;

// ---------------------------------------------------------------------------
// Token usage by tier  (was ModelUsageAnalytics, minus the invented prices)
// ---------------------------------------------------------------------------

function TokenUsagePanel() {
  const { user } = useAuth();
  const [range, setRange] = useState<Range>('7d');
  const [stats, setStats] = useState<{ planner: number; worker: number; reasoner: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Signed out is a finished read — but an UNPERFORMED one. Leaving `stats`
    // null pinned the panel on "Reading run history…"; setting it to zeros made
    // it claim "No tokens recorded", a statement about a table it never
    // queried. Neither is true, so the panel returns early below instead.
    if (!user) { setStats(null); setFailed(false); return; }
    let cancelled = false;
    (async () => {
      setStats(null);
      setFailed(false);
      try {
        let q = supabase
          .from('runs')
          .select('tokens_planner, tokens_worker, tokens_reasoner')
          .eq('user_id', user.id);
        if (range !== 'all') {
          const days = range === '7d' ? 7 : 30;
          q = q.gte('created_at', new Date(Date.now() - days * 86400_000).toISOString());
        }
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        if (cancelled) return;
        setStats(
          (data ?? []).reduce(
            (acc: { planner: number; worker: number; reasoner: number }, r: Record<string, number>) => ({
              planner: acc.planner + (r.tokens_planner || 0),
              worker: acc.worker + (r.tokens_worker || 0),
              reasoner: acc.reasoner + (r.tokens_reasoner || 0),
            }),
            { planner: 0, worker: 0, reasoner: 0 },
          ),
        );
      } catch {
        if (!cancelled) { setFailed(true); setStats({ planner: 0, worker: 0, reasoner: 0 }); }
      }
    })();
    return () => { cancelled = true; };
  }, [user, range]);

  const total = stats ? stats.planner + stats.worker + stats.reasoner : 0;

  if (!user) return <SignedOut what="Token usage" />;

  return (
    <Panel
      icon={<Zap className="i16" />}
      title="Token usage by tier"
      action={
        <select
          className="field"
          style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }}
          aria-label="Time range"
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
        >
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <option key={r} value={r}>{RANGE_LABEL[r]}</option>
          ))}
        </select>
      }
    >
      {/* Tokens, not dollars. Atlas records `runs.tokens_*` for real; it records
          no per-model price anywhere, and the legacy panel's price table named
          providers this build does not call. */}
      {total > 0 && (
        <div className="statgrid" style={{ marginBottom: 12 }}>
          <StatTile label="Total tokens" value={total.toLocaleString()} icon={<BarChart3 className="i20" />} />
          {TIERS.map((t) => (
            <StatTile
              key={t.key}
              label={`${t.label} · ${Math.round((stats![t.key] / total) * 100)}%`}
              value={stats![t.key].toLocaleString()}
            />
          ))}
        </div>
      )}

      {stats === null && <Empty body="Reading run history…" />}
      {failed && <Empty body="Could not read run history." status="error" />}
      {stats !== null && !failed && total === 0 && (
        <Empty
          size="block"
          title="No tokens recorded"
          body={`No agent run in ${RANGE_LABEL[range].toLowerCase()} reported token use. Chat and voice do not write to the run log — this counts agent runs only.`}
          icon={<Zap className="i20" />}
          status="resting"
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Spend history  (was UsageHistoryChart, minus recharts and the dead series)
// ---------------------------------------------------------------------------

function SpendHistoryPanel() {
  const [granularity, setGranularity] = useState<'daily' | 'weekly'>('daily');
  const { history, isLoading, totalSpent, avgDailySpend, projectedWeeklySpend } = useUsageHistory(granularity, 30);

  const peak = useMemo(() => Math.max(1, ...history.map((h) => h.total)), [history]);

  return (
    <Panel
      icon={<TrendingUp className="i16" />}
      title="Spend history"
      action={
        <select
          className="field"
          style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }}
          aria-label="Granularity"
          value={granularity}
          onChange={(e) => setGranularity(e.target.value as 'daily' | 'weekly')}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      }
    >
      {history.length > 0 && (
        <>
          <div className="statgrid" style={{ marginBottom: 12 }}>
            <StatTile label="Spent (30d)" value={`$${totalSpent.toFixed(2)}`} />
            <StatTile label="Average / day" value={`$${avgDailySpend.toFixed(2)}`} />
            <StatTile label="Projected / week" value={`$${projectedWeeklySpend.toFixed(2)}`} />
          </div>
          {history.map((h) => (
            <Row
              key={h.date}
              density="compact"
              title={h.date}
              trail={
                <span className="fx ac gap8">
                  <span className="flowbar" style={{ width: 120 }}>
                    <span
                      className="flowfill"
                      style={{ display: 'block', height: '100%', width: `${Math.round((h.total / peak) * 100)}%` }}
                    />
                  </span>
                  <span className="tnum">${h.total.toFixed(2)}</span>
                </span>
              }
            />
          ))}
        </>
      )}

      {isLoading && <Empty body="Reading usage history…" />}
      {!isLoading && history.length === 0 && (
        <Empty
          size="block"
          title="No spend history"
          body="Atlas has no daily usage log. The table exists, but the only thing that ever wrote it was a Supabase trigger that was removed when Atlas went local-first — nothing has replaced it yet, so this stays empty rather than showing an estimate."
          icon={<TrendingUp className="i20" />}
          status="stale"
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Cost controls  (was CostOptimizationPanel, rules rewritten)
// ---------------------------------------------------------------------------

interface Rec {
  id: string;
  title: string;
  body: string;
  icon: React.ReactNode;
}

function CostControlsPanel() {
  const { providers } = useAtlasProviderStatus();
  const { history } = useUsageHistory('daily', 30);
  const { budgetSettings, dailyBudgetUsedPct, hasSpendData } = useSpendingAlerts();

  const recs = useMemo<Rec[]>(() => {
    const out: Rec[] = [];

    // 1. Wasted calls. Real: `atlas_provider_status.failed_calls` is a counter
    //    the app increments. Reported as calls, not as a dollar figure — the
    //    legacy rule multiplied it by a literal 0.001 and called that a saving.
    const wasteful = (providers ?? []).filter(
      (p) => (p.total_calls ?? 0) > 20 && (p.failed_calls ?? 0) / (p.total_calls || 1) > 0.1,
    );
    if (wasteful.length > 0) {
      const wasted = wasteful.reduce((n, p) => n + (p.failed_calls ?? 0), 0);
      out.push({
        id: 'failures',
        title: `${wasted.toLocaleString()} failed calls are being paid for`,
        body: `${wasteful.map((p) => p.provider).join(', ')} ${wasteful.length === 1 ? 'is' : 'are'} failing more than one call in ten. A failed call still costs its input tokens. Check the provider's health before raising the budget.`,
        icon: <AlertTriangle className="i16" />,
      });
    }

    // 2. Pacing. Fires only against a MEASURED spend. This rule shipped in the
    //    first absorb pass reading `dailyBudgetUsedPct` straight out of
    //    `useSpendingAlerts`, which at the time derived it from the same
    //    "500 tokens per call × hardcoded price table" estimate this file's
    //    header says was left behind — the fabrication was simply one hook
    //    deeper. The hook now sums the recorded spend log and reports
    //    `hasSpendData: false` when there is none, which is the case on every
    //    install today, so this rule correctly stays silent.
    if (hasSpendData && budgetSettings && dailyBudgetUsedPct > 50 && dailyBudgetUsedPct < 100) {
      out.push({
        id: 'pace',
        title: `${dailyBudgetUsedPct.toFixed(0)}% of today's budget is gone`,
        body: `Your daily limit is $${budgetSettings.daily_budget_usd.toFixed(2)}. At this rate Atlas will stop before the day does.`,
        icon: <Clock className="i16" />,
      });
    }

    // 3. Week-over-week spike. Only fires with two real weeks of history — which
    //    means never, today (see SpendHistoryPanel). Kept because it costs
    //    nothing and becomes correct the moment something writes the table.
    if (history.length >= 14) {
      const recent = history.slice(-7).reduce((n, d) => n + d.total, 0) / 7;
      const prior = history.slice(-14, -7).reduce((n, d) => n + d.total, 0) / 7;
      if (prior > 0 && recent > prior * 1.5) {
        out.push({
          id: 'spike',
          title: `Spend is up ${Math.round(((recent - prior) / prior) * 100)}% week over week`,
          body: `Daily average went from $${prior.toFixed(2)} to $${recent.toFixed(2)}.`,
          icon: <TrendingUp className="i16" />,
        });
      }
    }

    return out;
  }, [providers, history, budgetSettings, dailyBudgetUsedPct, hasSpendData]);

  return (
    <Panel icon={<Sparkles className="i16" />} title="Cost controls">
      {recs.map((r) => (
        <Row key={r.id} lead={<span className="kbico">{r.icon}</span>} title={r.title} meta={r.body} />
      ))}
      {recs.length === 0 && (
        <Empty
          size="block"
          title="Nothing to flag"
          body="Atlas raises a suggestion here when a provider starts wasting calls, when you are burning through the daily budget early, or when weekly spend jumps. None of those is true right now."
          icon={<Sparkles className="i20" />}
          status="resting"
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function AtlasBudgetTab() {
  const [showAnalytics, setShowAnalytics] = useState(false);

  return (
    <div className="col gap16">
      <BudgetSettingsPanel />

      {/* Above the fold, deliberately. This is the switch that stops Atlas
          spending money on its own; the legacy panel that owned it was deleted
          with the rest of the tree, leaving a default-on background loop with
          no off switch anywhere in the app. See AtlasLearningControl. */}
      <AtlasLearningControl />

      {/* The limits are the setting; the analytics explain it. Folded by default
          so the tab still opens on the control the user came for. */}
      <Button
        variant="text"
        icon={<BarChart3 className="i16" />}
        onClick={() => setShowAnalytics((v) => !v)}
        aria-expanded={showAnalytics}
        style={{ justifyContent: 'flex-start', width: '100%', padding: '0 12px' }}
      >
        {showAnalytics ? 'Hide usage & cost analytics' : 'Usage & cost analytics'}
      </Button>

      {showAnalytics && (
        <>
          <TokenUsagePanel />
          <SpendHistoryPanel />
          <CostControlsPanel />
        </>
      )}
    </div>
  );
}

export default AtlasBudgetTab;
