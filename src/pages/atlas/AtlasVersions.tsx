/**
 * Atlas Versions — `/versions`.
 *
 * 5-version pre-plan, feature tracking, progress, changelog.
 * Source of truth: docs/VERSION-PLAN.md (parsed into SQLite by the brain).
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, RefreshCw, CheckCircle2, Clock, Circle, AlertTriangle } from 'lucide-react';
import { Card, Panel, Row, Empty, Button } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { useVersions, useVersionDetail, useSyncVersionPlan, type VersionRow, type FeatureRow } from '@/hooks/useVersions';
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

function FeatureItem({ feature }: { feature: FeatureRow }) {
  const Icon = STATUS_ICON[feature.status] ?? Circle;
  const tone = feature.status === 'done' ? 'ok' : feature.status === 'blocked' ? 'warn' : 'neutral';
  return (
    <Row
      density="default"
      lead={<span className={`vr-dot vr-dot-${tone}`} aria-hidden><Icon className="i14" /></span>}
      title={feature.title}
      meta={feature.assigned_agent ? `Agent: ${feature.assigned_agent}` : undefined}
      trail={<span className={`vr-badge vr-badge-${feature.status}`}>{feature.status}</span>}
    />
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
          Sync plan
        </Button>
      </header>

      {isLoading ? (
        <Empty status="stale" body="Loading versions…" />
      ) : versions.length === 0 ? (
        <Empty
          size="section"
          icon={<GitBranch className="i24" />}
          title="No versions tracked"
          body="Run 'Sync plan' to parse docs/VERSION-PLAN.md into the database."
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
                    {features.map(f => <FeatureItem key={f.id} feature={f} />)}
                  </div>
                )}
              </Panel>

              {changelog.length > 0 && (
                <Panel title="Changelog" tone="recessed">
                  {changelog.map(c => (
                    <Row
                      key={c.id}
                      density="compact"
                      lead={<span className={`vr-cat vr-cat-${c.category}`}>{c.category}</span>}
                      title={c.title}
                      meta={c.description ?? undefined}
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
