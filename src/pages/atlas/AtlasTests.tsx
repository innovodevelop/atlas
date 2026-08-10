/**
 * Atlas Tests — `/tests`.
 *
 * Test management: view suites, trigger runs, see pass/fail per version.
 * Atlas auto-suggests tests based on recent changes.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { TestTube2, Play, Search } from 'lucide-react';
import { Panel, Empty, Button, Row } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { useTestSuites, useRunTest, useDiscoverTests, type TestSuiteRow } from '@/hooks/useTests';
import '@/styles/surfaces/tests.css';

export const surface = {
  path: '/tests',
  label: 'Tests',
  icon: 'TestTube2',
  entry: 'menu' as const,
  mock: false,
  edition: 'admin' as const,
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
};

function suiteMeta(s: TestSuiteRow): string {
  const status = s.last_status ? STATUS_LABEL[s.last_status] ?? s.last_status : 'never run';
  return `${s.ci_job ?? 'no ci_job'} · ${s.total_runs} run${s.total_runs === 1 ? '' : 's'} · ${status}`;
}

export default function AtlasTests() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // Same gate as AtlasDashboard.tsx:107-109 — see the note in AtlasAgentView.tsx.
  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const { suites, isLoading, error } = useTestSuites();
  const runTest = useRunTest();
  const discoverTests = useDiscoverTests();

  return (
    <div className="ts-surface">
      <header className="ts-header">
        <button className="ts-back" onClick={() => navigate(-1)} aria-label="Back">
          <TestTube2 className="i20" />
          <h1 className="ts-title">Tests</h1>
        </button>
        <p className="ts-eyebrow">admin</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => discoverTests.mutate()}
          loading={discoverTests.isPending}
        >
          <Search className="i14" />
          Discover
        </Button>
        {/* "Run all" has no CI_JOBS entry that means literally every suite —
            'all' runs the repo-wide `bun run ci`, not each discovered suite
            row — so it stays disabled rather than implying per-suite fan-out
            that doesn't exist. */}
        <Button variant="ghost" size="sm" disabled>
          <Play className="i14" />
          Run all
        </Button>
      </header>

      <div className="ts-layout">
        <Panel title="Test Suites" tone="panel">
          {error ? (
            <Empty size="block" status="error" title="Couldn't load test suites" body={error.message} />
          ) : isLoading ? (
            <Empty size="block" status="stale" body="Loading test suites…" />
          ) : suites.length === 0 ? (
            <Empty
              size="block"
              icon={<TestTube2 className="i20" />}
              title="No test suites discovered"
              body="Run Discover to glob tests/ and services/*/src/*.test.ts into tracked suites."
              action={{ label: 'Discover now', onClick: () => discoverTests.mutate() }}
            />
          ) : (
            suites.map((s) => (
              <Row
                key={s.id}
                density="default"
                title={s.name}
                meta={suiteMeta(s)}
                trail={
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={runTest.isPending && runTest.variables === s.id}
                    onClick={() => runTest.mutate(s.id)}
                  >
                    <Play className="i14" />
                    Run
                  </Button>
                }
              />
            ))
          )}
        </Panel>

        <Panel title="AI Suggestions" tone="recessed">
          <Empty
            size="block"
            status="stale"
            title="No suggestions yet"
            body="Atlas will suggest tests based on recent code changes. This uses the Bedrock adapter to analyze git diffs and propose coverage gaps — not built yet."
          />
        </Panel>
      </div>
    </div>
  );
}
