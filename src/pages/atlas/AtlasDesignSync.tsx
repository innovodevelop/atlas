/**
 * Atlas Design Sync — `/design-sync`.
 *
 * Claude Design handoffs: every bundle recorded in design/.sync-manifest.json,
 * its implementation status, the surfaces it touched and the version it
 * shipped in. "Sync manifest" mirrors the manifest into atlas_design_syncs
 * (brain designSync.ts); the manifest stays the source of truth.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Palette, Package, RefreshCw } from 'lucide-react';
import { Panel, Empty, Row, Button } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { useDesignSyncs, useSyncDesignManifest, parseSurfaces } from '@/hooks/useDesignSync';
import '@/styles/surfaces/designSync.css';

export const surface = {
  path: '/design-sync',
  label: 'Design sync',
  icon: 'Palette',
  entry: 'menu' as const,
  mock: false,
  edition: 'admin' as const,
};

const STATUS_LABEL: Record<string, string> = {
  received: 'Received',
  auditing: 'Auditing',
  implementing: 'Implementing',
  complete: 'Complete',
  rejected: 'Rejected',
};

export default function AtlasDesignSync() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // Same gate as AtlasDashboard.tsx:107-109 — see the note in AtlasAgentView.tsx.
  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const { syncs, isLoading, error } = useDesignSyncs();
  const syncManifest = useSyncDesignManifest();
  const sync = () => syncManifest.mutate();

  return (
    <div className="ds-surface">
      <header className="ds-header">
        <button className="ds-back" onClick={() => navigate(-1)} aria-label="Back">
          <Palette className="i20" />
          <h1 className="ds-title">Design Sync</h1>
        </button>
        <p className="ds-eyebrow">admin</p>
        <Button variant="ghost" size="sm" onClick={sync} loading={syncManifest.isPending}>
          <RefreshCw className="i14" />
          Sync manifest
        </Button>
      </header>

      {syncManifest.error && (
        <Empty status="error" title="Manifest not synced" body={(syncManifest.error as Error).message} />
      )}
      {(syncManifest.data?.skipped.length ?? 0) > 0 && (
        <Empty
          status="stale"
          title="Some manifest entries were skipped"
          body={syncManifest.data!.skipped.join(' · ')}
        />
      )}

      <Panel title="Design Bundles" tone="panel">
        {error ? (
          <Empty size="block" status="error" title="Couldn't load design syncs" body={error.message} />
        ) : isLoading ? (
          <Empty size="block" status="stale" body="Loading design bundles…" />
        ) : syncs.length === 0 ? (
          <Empty
            size="block"
            icon={<Package className="i20" />}
            title="No synced bundles tracked"
            body="Design bundles from Claude Design will appear here once design/.sync-manifest.json is synced."
            action={{ label: 'Sync now', onClick: sync }}
          />
        ) : (
          syncs.map((s) => {
            const surfaces = parseSurfaces(s.surfaces);
            const meta = [
              s.version_id && s.version_id.replace(/-/g, '.'),
              `synced ${s.synced_at.slice(0, 10)}`,
              surfaces.length > 0 && `${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}: ${surfaces.join(', ')}`,
            ].filter(Boolean).join(' · ');
            return (
              <Row
                key={s.id}
                density="default"
                lead={<span className={`ds-status ds-status-${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>}
                title={s.bundle_name}
                meta={meta}
                trail={<span title={s.audit_notes ?? undefined}>{s.sha256.slice(0, 8)}</span>}
              />
            );
          })
        )}
      </Panel>
    </div>
  );
}
