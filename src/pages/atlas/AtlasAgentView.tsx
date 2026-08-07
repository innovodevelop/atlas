/**
 * Atlas Agent View — `/agent-view`.
 *
 * Live/real-time view of Claude Code sessions, CI pipelines, and autonomous agents.
 */
import { useNavigate } from 'react-router-dom';
import { Monitor, Radio } from 'lucide-react';
import { Panel, Empty } from '@/components/atlas-ui/primitives';
import '@/styles/surfaces/agentView.css';

export const surface = {
  path: '/agent-view',
  label: 'Agent View',
  icon: 'Monitor',
  entry: 'menu' as const,
  mock: false,
};

export default function AtlasAgentView() {
  const navigate = useNavigate();

  return (
    <div className="av-surface">
      <header className="av-header">
        <button className="av-back" onClick={() => navigate(-1)} aria-label="Back">
          <Monitor className="i20" />
          <h1 className="av-title">Agent View</h1>
        </button>
        <p className="av-eyebrow">admin</p>
        <span className="av-live"><Radio className="i12" /> Live</span>
      </header>

      <div className="av-layout">
        <Panel title="Active Sessions" tone="panel">
          <Empty
            size="block"
            icon={<Monitor className="i20" />}
            title="No active sessions"
            body="Claude Code sessions, CI pipelines, and autonomous agents will appear here when running. The file watcher for JSONL transcripts activates on next build."
          />
        </Panel>

        <Panel title="Event Feed" tone="recessed">
          <Empty
            size="block"
            status="stale"
            title="Waiting for events"
            body="File edits, tool calls, milestones, questions, and discoveries will stream here in real-time."
          />
        </Panel>
      </div>
    </div>
  );
}
