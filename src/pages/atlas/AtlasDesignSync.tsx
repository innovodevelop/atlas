/**
 * Atlas Design Sync — `/design-sync`.
 *
 * Claude Design connector: view design bundles, audit status, link to versions.
 */
import { useNavigate } from 'react-router-dom';
import { Palette, Package } from 'lucide-react';
import { Panel, Empty } from '@/components/atlas-ui/primitives';
import '@/styles/surfaces/designSync.css';

export const surface = {
  path: '/design-sync',
  label: 'Design Sync',
  icon: 'Palette',
  entry: 'menu' as const,
  mock: false,
};

export default function AtlasDesignSync() {
  const navigate = useNavigate();

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
        <Empty
          size="block"
          icon={<Package className="i20" />}
          title="No synced bundles tracked"
          body="Design bundles from Claude Design will appear here. The connector reads design/.sync-manifest.json and tracks implementation progress per surface."
        />
      </Panel>
    </div>
  );
}
