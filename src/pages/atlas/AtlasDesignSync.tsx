/**
 * Atlas Design Sync — `/design-sync`.
 *
 * Claude Design connector: view design bundles, audit status, link to versions.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Palette, Package } from 'lucide-react';
import { Panel, Empty, Row } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { useDesignSyncs } from '@/hooks/useDesignSync';
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

  return (
    <div className="ds-surface">
      <header className="ds-header">
        <button className="ds-back" onClick={() => navigate(-1)} aria-label="Back">
          <Palette className="i20" />
          <h1 className="ds-title">Design Sync</h1>
        </button>
        <p className="ds-eyebrow">admin</p>
      </header>

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
            body="Design bundles from Claude Design will appear here. The connector reads design/.sync-manifest.json and tracks implementation progress per surface."
          />
        ) : (
          syncs.map((s) => (
            <Row
              key={s.id}
              density="default"
              title={s.bundle_name}
              meta={`${STATUS_LABEL[s.status] ?? s.status} · synced ${s.synced_at}`}
              trail={<span>{s.sha256.slice(0, 8)}</span>}
            />
          ))
        )}
      </Panel>
    </div>
  );
}
