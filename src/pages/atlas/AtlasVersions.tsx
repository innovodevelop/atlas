/**
 * Atlas Versions — `/versions`.
 *
 * 5-version pre-plan, feature tracking, progress, changelog.
 * Source of truth: docs/VERSION-PLAN.md on GitHub, synced into SQLite by the
 * brain every 5 minutes (services/atlas-brain/src/planSync.ts). The strip at
 * the top says whether this Mac's checkout and the running build have caught
 * up with it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, RefreshCw, CheckCircle2, Clock, Circle, AlertTriangle, Github, HardDrive, Monitor } from 'lucide-react';
import { Card, Panel, Row, Empty, Button } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { useVersions, useVersionDetail, useSyncVersionPlan, usePlanSyncStatus, CHANGELOG_PAGE, type VersionRow, type FeatureRow, type PlanSyncStatus } from '@/hooks/useVersions';
import '@/styles/surfaces/versions.css';

export const surface = {
  path: '/versions',
  label: 'Versions',
  icon: 'GitBranch',
  entry: 'menu' as const,
  mock: false,
  edition: 'admin' as const,
};

const STATUS_ICON: Record<string, typeof Circle> = {
  planned: Clock,
  'in-progress': RefreshCw,
  released: CheckCircle2,
  blocked: AlertTriangle,
  done: CheckCircle2,
};

type GithubOnly = PlanSyncStatus['githubOnly'][number];

function FeatureItem({ feature, githubOnly }: { feature: FeatureRow; githubOnly?: GithubOnly }) {
  const Icon = STATUS_ICON[feature.status] ?? Circle;
  const tone = feature.status === 'done' ? 'ok' : feature.status === 'blocked' ? 'warn' : 'neutral';
  const meta = [
    feature.assigned_agent ? `Agent: ${feature.assigned_agent}` : null,
    githubOnly ? (githubOnly.local ? `Local checkout still says ${githubOnly.local}` : 'Not in the local checkout yet') : null,
  ].filter(Boolean).join(' · ');
  return (
    <Row
      density="default"
      lead={<span className={`vr-dot vr-dot-${tone}`} aria-hidden><Icon className="i14" /></span>}
      title={feature.title}
      meta={meta || undefined}
      trail={
        <span className="vr-trail">
          {githubOnly && <span className="vr-badge vr-badge-github" title="Changed on GitHub; this Mac's checkout hasn't pulled it">GitHub only</span>}
          <span className={`vr-badge vr-badge-${feature.status}`}>{feature.status}</span>
        </span>
      }
    />
  );
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');

function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** One line of the sync strip: ok / behind / unknown, with why. */
function SyncLine({ icon, label, state, detail }: {
  icon: React.ReactNode;
  label: string;
  state: 'ok' | 'behind' | 'unknown';
  detail: string;
}) {
  return (
    <div className={`vr-sync-line vr-sync-${state}`}>
      <span className="vr-sync-icon" aria-hidden>{icon}</span>
      <span className="vr-sync-label">{label}</span>
      <span className="vr-sync-state">{state === 'ok' ? 'Up to date' : state === 'behind' ? 'Behind' : 'Unknown'}</span>
      <span className="vr-sync-detail">{detail}</span>
    </div>
  );
}

/**
 * Where the latest roadmap change stands: merged on GitHub, pulled into this
 * Mac's checkout, built into the running app. Each line is judged against the
 * last commit that changed docs/VERSION-PLAN.md, not the branch head, so
 * unrelated commits don't make the roadmap look stale.
 */
function SyncStatusPanel({ status, error }: { status: PlanSyncStatus | undefined; error: unknown }) {
  if (!status) {
    return (
      <Panel tone="recessed" className="vr-sync">
        <p className="vr-sync-detail">{error ? `Sync status unavailable: ${error instanceof Error ? error.message : String(error)}` : 'Checking GitHub…'}</p>
      </Panel>
    );
  }
  const { github, local, app } = status;
  const plan = github.plan;
  const behind = (n: number | null) => (n === null ? '' : n === 0 ? '' : ` · ${n} commit${n === 1 ? '' : 's'} behind ${status.ref}`);

  const githubLine = github.ok && plan
    ? { state: 'ok' as const, detail: `${status.repo}@${status.ref} · plan ${short(plan.sha)}${plan.message ? ` “${plan.message}”` : ''} · ${ago(plan.date)} · checked ${ago(status.checkedAt)}` }
    : { state: 'unknown' as const, detail: `${github.error ?? 'Not checked yet'}${status.source === 'local' ? ' Showing the local checkout’s plan.' : ''}` };

  const localLine = !local.path
    ? { state: 'unknown' as const, detail: local.error ?? 'No checkout found' }
    : local.containsPlan === true
      ? { state: 'ok' as const, detail: `${local.path} · ${local.branch ?? ''} ${short(local.headSha)}${behind(local.behindBy)}${local.planDirty ? ' · uncommitted plan edits' : ''}` }
      : local.containsPlan === false
        ? { state: 'behind' as const, detail: `${local.path} · ${local.branch ?? ''} ${short(local.headSha)} doesn’t have plan ${short(plan?.sha)} — pull ${status.ref}${behind(local.behindBy)}` }
        : { state: 'unknown' as const, detail: `${local.path} · ${short(local.headSha)} (GitHub unreachable, can’t compare)` };

  const appLine = !app.buildSha
    ? { state: 'unknown' as const, detail: 'This build didn’t record its commit (dev server without git, or an old build).' }
    : app.containsPlan === true
      ? { state: 'ok' as const, detail: `Built from ${short(app.buildSha)}${behind(app.behindBy)}` }
      : app.containsPlan === false
        ? { state: 'behind' as const, detail: `Built from ${short(app.buildSha)}, before plan ${short(plan?.sha)} — rebuild to ship it${behind(app.behindBy)}` }
        : { state: 'unknown' as const, detail: `Built from ${short(app.buildSha)} (not on GitHub, or GitHub unreachable)` };

  return (
    <Panel tone="recessed" className="vr-sync">
      <SyncLine icon={<Github className="i14" />} label="GitHub" {...githubLine} />
      <SyncLine icon={<HardDrive className="i14" />} label="Local checkout" {...localLine} />
      <SyncLine icon={<Monitor className="i14" />} label="Mac app" {...appLine} />
      {status.githubOnly.length > 0 && (
        <p className="vr-sync-note">
          {status.githubOnly.length} feature change{status.githubOnly.length === 1 ? ' is' : 's are'} on GitHub only — marked below.
        </p>
      )}
    </Panel>
  );
}

function VersionCard({ version, selected, onSelect }: { version: VersionRow; selected: boolean; onSelect: () => void }) {
  const progress = version.feature_count > 0 ? Math.round((version.done_count / version.feature_count) * 100) : 0;
  return (
    <Card
      size="m"
      skin={selected ? 'accent' : 'glass'}
      onOpen={onSelect}
      delay={0}
    >
      <Card.Header
        label={<span className="vr-semver">{version.semver}</span>}
        action={<span className={`vr-status vr-status-${version.status}`}>{version.status}</span>}
      />
      <Card.Body>
        <p className="vr-codename">{version.codename}</p>
        <div className="vr-progress-bar">
          <div className="vr-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <p className="vr-progress-label">{version.done_count}/{version.feature_count} features · {progress}%</p>
        {version.target_date && <p className="vr-target">Target: {version.target_date}</p>}
      </Card.Body>
    </Card>
  );
}

export default function AtlasVersions() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // Same gate as AtlasDashboard.tsx:107-109 — see the note in AtlasAgentView.tsx.
  // This was the last of the four admin surfaces reachable while signed out:
  // /versions rendered the whole version plan, and its Sync button POSTed to
  // /admin/versions/sync, to anyone who typed the URL.
  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);
  const { versions, isLoading, refetch } = useVersions();
  const syncPlan = useSyncVersionPlan();
  // The brain syncs from GitHub every 5 minutes on its own; this polls its
  // status (and refreshes the versions when a tick applied a new plan).
  const syncStatus = usePlanSyncStatus();
  const githubOnly = new Map((syncStatus.data?.githubOnly ?? []).map((f) => [f.id, f]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { features, changelog, isLoading: detailLoading } = useVersionDetail(selectedId);

  const handleSync = useCallback(() => {
    syncPlan.mutate(undefined, { onSuccess: () => refetch() });
  }, [syncPlan, refetch]);

  const selected = versions.find(v => v.id === selectedId);

  return (
    <div className="vr-surface">
      <header className="vr-header">
        <button className="vr-back" onClick={() => navigate(-1)} aria-label="Back">
          <GitBranch className="i20" />
          <h1 className="vr-title">Versions</h1>
        </button>
        <p className="vr-eyebrow">admin</p>
        <Button variant="ghost" size="sm" onClick={handleSync} loading={syncPlan.isPending}>
          <RefreshCw className="i14" />
          Sync now
        </Button>
      </header>

      <SyncStatusPanel status={syncStatus.data} error={syncStatus.error} />

      {syncPlan.data?.changelog_error && (
        <Empty status="error" title="Changelog not refreshed" body={syncPlan.data.changelog_error} />
      )}

      {isLoading ? (
        <Empty status="stale" body="Loading versions…" />
      ) : versions.length === 0 ? (
        <Empty
          size="section"
          icon={<GitBranch className="i24" />}
          title="No versions tracked"
          body="The plan syncs from GitHub every 5 minutes. Press Sync now to fetch it straight away."
          action={{ label: 'Sync now', onClick: handleSync }}
        />
      ) : (
        <>
          <section className="vr-timeline">
            {versions.map(v => (
              <VersionCard
                key={v.id}
                version={v}
                selected={v.id === selectedId}
                onSelect={() => setSelectedId(v.id)}
              />
            ))}
          </section>

          {selected && (
            <section className="vr-detail">
              <Panel title={`${selected.semver} — ${selected.codename}`} icon={<GitBranch className="i16" />}>
                {detailLoading ? (
                  <Empty status="stale" body="Loading features…" />
                ) : features.length === 0 ? (
                  <Empty size="block" title="No features" body="This version has no tracked features yet." />
                ) : (
                  <div className="vr-features">
                    {features.map(f => <FeatureItem key={f.id} feature={f} githubOnly={githubOnly.get(f.id)} />)}
                  </div>
                )}
              </Panel>

              {changelog.length > 0 && (
                <Panel
                  title={changelog.length >= CHANGELOG_PAGE ? `Changelog · latest ${CHANGELOG_PAGE}` : 'Changelog'}
                  tone="recessed"
                >
                  {changelog.map(c => (
                    <Row
                      key={c.id}
                      density="compact"
                      lead={<span className={`vr-cat vr-cat-${c.category}`}>{c.category}</span>}
                      title={c.title}
                      meta={c.description ?? undefined}
                      trail={<span>{c.related_feature ? `${c.related_feature} · ` : ''}{c.created_at.slice(0, 10)}</span>}
                    />
                  ))}
                </Panel>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
