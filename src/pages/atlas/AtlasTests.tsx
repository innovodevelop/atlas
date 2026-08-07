/**
 * Atlas Tests — `/tests`.
 *
 * Test management: view suites, trigger runs, see pass/fail per version.
 * Atlas auto-suggests tests based on recent changes.
 */
import { useNavigate } from 'react-router-dom';
import { TestTube2, Play } from 'lucide-react';
import { Panel, Empty, Button } from '@/components/atlas-ui/primitives';
import '@/styles/surfaces/tests.css';

export const surface = {
  path: '/tests',
  label: 'Tests',
  icon: 'TestTube2',
  entry: 'menu' as const,
  mock: false,
};

export default function AtlasTests() {
  const navigate = useNavigate();

  return (
    <div className="ts-surface">
      <header className="ts-header">
        <button className="ts-back" onClick={() => navigate(-1)} aria-label="Back">
          <TestTube2 className="i20" />
          <h1 className="ts-title">Tests</h1>
        </button>
        <p className="ts-eyebrow">admin</p>
        <Button variant="ghost" size="sm" disabled>
          <Play className="i14" />
          Run all
        </Button>
      </header>

      <div className="ts-layout">
        <Panel title="Test Suites" tone="panel">
          <Empty
            size="block"
            icon={<TestTube2 className="i20" />}
            title="No test suites discovered"
            body="No test suites are discovered yet. Auto-discovery from tests/ and services/atlas-brain/src/*.test.ts is planned but not built."
          />
        </Panel>

        <Panel title="AI Suggestions" tone="recessed">
          <Empty
            size="block"
            status="stale"
            title="No suggestions yet"
            body="Atlas will suggest tests based on recent code changes. This uses the Bedrock adapter to analyze git diffs and propose coverage gaps."
          />
        </Panel>
      </div>
    </div>
  );
}
