/**
 * Atlas Agent View — `/agent-view`.
 *
 * Live/real-time view of Claude Code sessions, CI pipelines, and autonomous agents.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Monitor, Radio, RefreshCw, Download } from 'lucide-react';
import { Panel, Empty, Row, Button } from '@/components/atlas-ui/primitives';
import { useAuth } from '@/hooks/useAuth';
import { useAgentSessions, useAgentEvents, useIngestSessions, useSyncCiRuns, type AgentSessionRow } from '@/hooks/useAgentView';
import '@/styles/surfaces/agentView.css';

export const surface = {
  path: '/agent-view',
  label: 'Agent view',
  icon: 'Monitor',
  entry: 'menu' as const,
  mock: false,
  edition: 'admin' as const,
};

const STATUS_LABEL: Record<AgentSessionRow['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export default function AtlasAgentView() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const { sessions, isLoading: sessionsLoading, error: sessionsError } = useAgentSessions();
  const { events, isLoading: eventsLoading, error: eventsError } = useAgentEvents(selectedId);
  const ingest = useIngestSessions();
  const syncCi = useSyncCiRuns();

  return (
    <div className="av-surface">
      <header className="av-header">
        <button className="av-back" onClick={() => navigate(-1)} aria-label="Back">
          <Monitor className="i20" />
          <h1 className="av-title">Agent View</h1>
        </button>
        <p className="av-eyebrow">admin</p>
        <Button variant="ghost" size="sm" onClick={() => ingest.mutate()} loading={ingest.isPending}>
          <Download className="i14" />
          Ingest JSONL
        </Button>
        <Button variant="ghost" size="sm" onClick={() => syncCi.mutate()} loading={syncCi.isPending}>
          <RefreshCw className="i14" />
          Sync CI
        </Button>
        <span className="av-live"><Radio className="i12" /> Live</span>
      </header>

      <div className="av-layout">
        <Panel title="Active Sessions" tone="panel">
          {sessionsError ? (
            <Empty size="block" status="error" title="Couldn't load sessions" body={sessionsError.message} />
          ) : sessionsLoading ? (
            <Empty size="block" status="stale" body="Loading sessions…" />
          ) : sessions.length === 0 ? (
            <Empty
              size="block"
              icon={<Monitor className="i20" />}
              title="No active sessions"
              body="Claude Code sessions, CI pipelines, and autonomous agents will appear here when running."
            />
          ) : (
            sessions.map((s) => (
              <Row
                key={s.id}
                density="default"
                title={s.task_summary ?? s.session_type}
                meta={`${s.session_type} · ${STATUS_LABEL[s.status]}`}
                trail={s.status === 'active' ? <Radio className="i12" /> : undefined}
                selected={s.id === selectedId}
                onSelect={() => setSelectedId(s.id)}
              />
            ))
          )}
        </Panel>

        <Panel title="Event Feed" tone="recessed">
          {!selectedId ? (
            <Empty
              size="block"
              status="stale"
              title="Waiting for events"
              body="Select an active session to stream its file edits, tool calls, milestones, questions, and discoveries."
            />
          ) : eventsError ? (
            <Empty size="block" status="error" title="Couldn't load events" body={eventsError.message} />
          ) : eventsLoading ? (
            <Empty size="block" status="stale" body="Loading events…" />
          ) : events.length === 0 ? (
            <Empty size="block" title="No events yet" body="This session hasn't logged any events." />
          ) : (
            events.map((e) => (
              <Row key={e.id} density="compact" title={e.event_type} meta={e.ts} />
            ))
          )}
        </Panel>
      </div>
    </div>
  );
}
