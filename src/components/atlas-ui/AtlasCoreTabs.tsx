import { memo } from 'react';
import { Search, Database, FileText, BookOpen, Loader, Clock, Bot, Zap, CheckCircle2, AlertTriangle, Radio, Brain } from 'lucide-react';
import { useBrainSearch } from '@/hooks/useBrainSearch';
import { useAtlasKnowledge } from '@/hooks/useAtlasKnowledge';
import { useAtlasResearch } from '@/hooks/useAtlasResearch';
import { useAtlasLearning } from '@/hooks/useAtlasLearning';
import { useAgents } from '@/hooks/useAgents';
import { useApprovals } from '@/hooks/useApprovals';
import { useAtlasProviderStatus } from '@/hooks/useAtlasProviderStatus';
import { useAtlasMemory } from '@/hooks/useAtlasMemory';
import { Empty, Panel, Row } from './primitives';

// Atlas Core tab panels — Workshop design's 8-view Core, wired to real data.
// Each tab was a dead button showing the same static overview; these render
// the actual knowledge/research/learning/agent/live surfaces from existing
// hooks.
//
// The local `Panel` and `Empty` that used to live here are gone: they were the
// seed of the shared primitives and are now imported from ./primitives. The
// `hue` prop went with them — it drove a coloured panel ring that the
// borderless rule deletes, and it was passed as a raw HSL triplet.

const fmtAgo = (iso?: string | null) => {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function SearchTab() {
  const { query, setQuery, resultsByType, isSearching } = useBrainSearch();
  const all = [...resultsByType.knowledge, ...resultsByType.research, ...resultsByType.finding].slice(0, 8);
  return (
    <div className="coregrid">
      <Panel icon={<Search className="i16" />} title="Search the brain">
        <input
          className="field"
          style={{ width: '100%', marginBottom: 12 }}
          placeholder="Search knowledge, research, findings…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isSearching && <Empty body="Searching…" />}
        {!isSearching && query && all.length === 0 && <Empty body="No matches yet." />}
        {!query && <Empty body="Type to search across everything Atlas knows." />}
      </Panel>
      <Panel icon={<FileText className="i16" />} title="Top results">
        {all.map((r) => (
          <Row key={r.id} lead={<span className="kbico"><FileText className="i16" /></span>} title={r.title} meta={r.type} />
        ))}
        {all.length === 0 && <Empty body="Results appear here." />}
      </Panel>
    </div>
  );
}

function LiveTab() {
  const { providers } = useAtlasProviderStatus();
  const rows = providers ?? [];
  return (
    <div className="coregrid">
      <Panel icon={<Radio className="i16" />} title="Live connections">
        {rows.map((p: { provider: string; status?: string; is_available?: boolean }) => {
          const ok = p.is_available ?? p.status === 'active';
          return (
            <Row
              key={p.provider}
              lead={<span className="flowdot" style={{ color: ok ? 'var(--grn)' : 'var(--red)' }}><CheckCircle2 className="i16" /></span>}
              title={<span style={{ textTransform: 'capitalize' }}>{p.provider}</span>}
              meta={ok ? 'connected' : (p.status || 'offline')}
              trail={<span className="flowbar" style={{ width: 120 }}><span className="flowfill" style={{ display: 'block', height: '100%', background: ok ? 'var(--grn)' : 'var(--red)', width: ok ? '99%' : '20%' }} /></span>}
            />
          );
        })}
        {rows.length === 0 && <Empty body="No providers reporting." />}
      </Panel>
      <Panel icon={<Zap className="i16" />} title="Ambient">
        <Row lead={<span className="kbico"><Radio className="i16" /></span>} title={'Listening for "Hey Atlas"'} meta="wake word · ambient" />
      </Panel>
    </div>
  );
}

function AgentTab() {
  const { agents } = useAgents();
  const { approvals } = useApprovals();
  const pending = (approvals ?? []).filter((a) => a.status === 'pending');
  return (
    <div className="coregrid">
      <Panel icon={<Bot className="i16" />} title="Agents">
        {(agents ?? []).map((a) => (
          <Row key={a.id} lead={<span className="kbico"><Bot className="i16" /></span>} title={a.name} meta={`${a.is_active ? 'active' : 'idle'} · ${a.max_steps} steps`} />
        ))}
        {(agents ?? []).length === 0 && <Empty body="No agents configured." />}
      </Panel>
      <Panel icon={<AlertTriangle className="i16" />} title={`Needs approval · ${pending.length}`}>
        {pending.map((a) => (
          <Row key={a.id} lead={<span className="kbico"><AlertTriangle className="i16" /></span>} title={a.action_summary} meta={`${a.risk_level || 'review'} · ${fmtAgo(a.created_at)}`} />
        ))}
        {pending.length === 0 && <Empty body="Nothing waiting on you." />}
      </Panel>
    </div>
  );
}

function KnowledgeTab() {
  const { knowledge, categories } = useAtlasKnowledge();
  const recent = (knowledge ?? []).slice(0, 6);
  return (
    <div className="coregrid">
      <Panel icon={<Database className="i16" />} title="Domains">
        {(categories ?? []).map((c: string) => {
          const n = (knowledge ?? []).filter((k) => k.category === c).length;
          return (
            <Row
              key={c}
              lead={<span className="flowdot"><Database className="i16" /></span>}
              title={<span style={{ textTransform: 'capitalize' }}>{c}</span>}
              meta={`${n} ${n === 1 ? 'entry' : 'entries'}`}
            />
          );
        })}
        {(categories ?? []).length === 0 && <Empty body="No knowledge domains yet." />}
      </Panel>
      <Panel icon={<FileText className="i16" />} title="Recently indexed">
        {recent.map((k) => (
          <Row key={k.id} lead={<span className="kbico"><FileText className="i16" /></span>} title={k.topic} meta={`${k.category} · ${(k.relevance_score ?? 0).toFixed(2)} relevance`} />
        ))}
        {recent.length === 0 && <Empty body="Nothing indexed yet." />}
      </Panel>
    </div>
  );
}

function ResearchTab() {
  const { topics } = useAtlasResearch();
  const queue = (topics ?? []).filter((t) => ['queued', 'researching', 'processing'].includes(t.status));
  const done = (topics ?? []).filter((t) => t.status === 'completed').slice(0, 6);
  return (
    <div className="coregrid">
      <Panel icon={<BookOpen className="i16" />} title="Research queue">
        {queue.map((t) => {
          const running = t.status !== 'queued';
          return (
            <Row
              key={t.id}
              lead={running ? <Loader className="i16" style={{ color: 'var(--acc)' }} /> : <Clock className="i16" style={{ color: 'var(--ink3)' }} />}
              title={t.topic}
              meta={`${t.status} · ${(t.sources ?? []).length} sources`}
            />
          );
        })}
        {queue.length === 0 && <Empty body="Queue is clear." />}
      </Panel>
      <Panel icon={<CheckCircle2 className="i16" />} title="Completed reports">
        {done.map((t) => (
          <Row key={t.id} lead={<span className="kbico"><CheckCircle2 className="i16" /></span>} title={t.topic} meta={`${(t.findings ?? []).length} findings`} />
        ))}
        {done.length === 0 && <Empty body="No completed reports yet." />}
      </Panel>
    </div>
  );
}

/**
 * The Memory tab — the eighth tab the design plan specified and the screen
 * never had. `docs/ROADMAP.md`: "Atlas Core: Memory tab — Specified, never
 * built | Plan called for 8 tabs; AtlasCoreScreen.tsx has 7."
 *
 * Read-only by design. Forget-one and erase-all already live in
 * Settings → Memory & Privacy with a typed confirmation; putting a second copy
 * of a GDPR-relevant destructive control here would mean two places to keep
 * right. Core answers "what does Atlas know"; Settings owns "make it forget".
 */
function MemoryTab() {
  const { memories, byCategory, state, message } = useAtlasMemory();
  const categories = Object.keys(byCategory).sort();
  const recent = memories.slice(0, 8);

  return (
    <div className="coregrid">
      <Panel icon={<Database className="i16" />} title="What Atlas remembers">
        {categories.map((c) => (
          <Row
            key={c}
            lead={<span className="flowdot"><Brain className="i16" /></span>}
            title={<span style={{ textTransform: 'capitalize' }}>{c.replace(/_/g, ' ')}</span>}
            meta={`${byCategory[c].length} ${byCategory[c].length === 1 ? 'memory' : 'memories'}`}
          />
        ))}
        {state === 'loading' && <Empty body="Reading local memory…" />}
        {state === 'ready' && categories.length === 0 && (
          <Empty body="Nothing stored yet. Atlas writes a memory when something is worth keeping." status="resting" />
        )}
        {state === 'unavailable' && <Empty body={message ?? 'Unavailable here.'} status="stale" />}
        {state === 'error' && <Empty body={message ?? 'Could not read memory.'} status="error" />}
      </Panel>

      <Panel icon={<FileText className="i16" />} title="Most recent">
        {recent.map((m) => (
          <Row
            key={m.id}
            lead={<span className="kbico"><FileText className="i16" /></span>}
            title={m.key}
            meta={`${m.category}${m.importance != null ? ` · importance ${m.importance}` : ''}`}
          />
        ))}
        {state === 'ready' && recent.length === 0 && <Empty body="No memories to show." />}
        {state !== 'ready' && <Empty body="Manage and erase memories in Settings → Memory & Privacy." />}
      </Panel>
    </div>
  );
}

function LearningTab() {
  const { validationLogs, learningMetrics } = useAtlasLearning();
  const logs = (validationLogs ?? []).slice(0, 6);
  const m = learningMetrics;
  return (
    <div className="coregrid">
      <Panel icon={<Zap className="i16" />} title="Learning metrics">
        <Row
          lead={<span className="flowdot" style={{ color: 'var(--grn)' }}><CheckCircle2 className="i16" /></span>}
          title="Validation success"
          meta={`${m.successRate}% pass`}
          trail={<span className="flowbar" style={{ width: 120 }}><span className="flowfill" style={{ display: 'block', height: '100%', background: 'var(--grn)', width: `${m.successRate}%` }} /></span>}
        />
        <Row lead={<span className="flowdot"><Database className="i16" /></span>} title="Knowledge velocity" meta={`${m.knowledgeVelocity}/period`} />
        <Row lead={<span className="flowdot"><BookOpen className="i16" /></span>} title="Queue depth" meta={`${m.queueDepth} queued`} />
      </Panel>
      <Panel icon={<CheckCircle2 className="i16" />} title="Recent validations">
        {logs.map((v: { id: string; verdict: string; created_at: string; grounding?: string }) => (
          <Row
            key={v.id}
            lead={<span className={`errsev ${v.verdict === 'valid' ? 'sev-i' : v.verdict === 'fake' ? 'sev-e' : 'sev-w'}`} />}
            title={<span style={{ textTransform: 'capitalize' }}>{v.verdict}{v.grounding ? ` · ${v.grounding}` : ''}</span>}
            meta={fmtAgo(v.created_at)}
          />
        ))}
        {logs.length === 0 && <Empty body="No validations yet." />}
      </Panel>
    </div>
  );
}

export const AtlasCoreTabs = memo(({ tab }: { tab: string }) => {
  switch (tab) {
    case 'search': return <SearchTab />;
    case 'live': return <LiveTab />;
    case 'agent': return <AgentTab />;
    case 'knowledge': return <KnowledgeTab />;
    case 'research': return <ResearchTab />;
    case 'learning': return <LearningTab />;
    case 'memory': return <MemoryTab />;
    default: return null;
  }
});
AtlasCoreTabs.displayName = 'AtlasCoreTabs';
