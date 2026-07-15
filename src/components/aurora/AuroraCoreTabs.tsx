import { memo } from 'react';
import { Search, Database, FileText, BookOpen, Loader, Clock, Bot, Zap, CheckCircle2, AlertTriangle, Radio } from 'lucide-react';
import { useBrainSearch } from '@/hooks/useBrainSearch';
import { useAtlasKnowledge } from '@/hooks/useAtlasKnowledge';
import { useAtlasResearch } from '@/hooks/useAtlasResearch';
import { useAtlasLearning } from '@/hooks/useAtlasLearning';
import { useAgents } from '@/hooks/useAgents';
import { useApprovals } from '@/hooks/useApprovals';
import { useAtlasProviderStatus } from '@/hooks/useAtlasProviderStatus';

// Atlas Core tab panels — Workshop design's 8-view Core, wired to real data.
// Each tab was a dead button showing the same static overview; these render
// the actual knowledge/research/learning/agent/live surfaces from existing
// hooks. Uses the design's .cpanel/.kbrow/.qrow chrome (workshop.css).

const fmtAgo = (iso?: string | null) => {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const Panel = ({ hue, icon, title, children }: { hue: string; icon: React.ReactNode; title: string; children: React.ReactNode }) => (
  <div className="cpanel" style={{ ['--pc' as string]: hue }}>
    <h3 className="cph">{icon}{title}</h3>
    {children}
  </div>
);
const Empty = ({ label }: { label: string }) => <p className="kbmeta" style={{ padding: '8px 0' }}>{label}</p>;

function SearchTab() {
  const { query, setQuery, resultsByType, isSearching } = useBrainSearch();
  const all = [...resultsByType.knowledge, ...resultsByType.research, ...resultsByType.finding].slice(0, 8);
  return (
    <div className="coregrid">
      <Panel hue="25 100% 50%" icon={<Search className="i16" />} title="Search the brain">
        <input
          className="field"
          style={{ width: '100%', marginBottom: 12 }}
          placeholder="Search knowledge, research, findings…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isSearching && <Empty label="Searching…" />}
        {!isSearching && query && all.length === 0 && <Empty label="No matches yet." />}
        {!query && <Empty label="Type to search across everything Atlas knows." />}
      </Panel>
      <Panel hue="227 88% 58%" icon={<FileText className="i16" />} title="Top results">
        {all.map((r) => (
          <div className="kbrow" key={r.id}>
            <div className="kbico"><FileText className="i16" /></div>
            <div className="f1"><p className="kbtitle">{r.title}</p><p className="kbmeta">{r.type}</p></div>
          </div>
        ))}
        {all.length === 0 && <Empty label="Results appear here." />}
      </Panel>
    </div>
  );
}

function LiveTab() {
  const { providers } = useAtlasProviderStatus();
  const rows = providers ?? [];
  return (
    <div className="coregrid">
      <Panel hue="25 100% 50%" icon={<Radio className="i16" />} title="Live connections">
        {rows.map((p: { provider: string; status?: string; is_available?: boolean }) => {
          const ok = p.is_available ?? p.status === 'active';
          return (
            <div className="flowrow" key={p.provider}>
              <div className="flownode">
                <div className="flowdot" style={{ ['--fc' as string]: ok ? '158 45% 34%' : '9 57% 48%' }}><CheckCircle2 className="i16" /></div>
                <div><p className="kbtitle" style={{ textTransform: 'capitalize' }}>{p.provider}</p><p className="kbmeta">{ok ? 'connected' : (p.status || 'offline')}</p></div>
              </div>
              <div className="flowbar"><div className="flowfill" style={{ ['--fc' as string]: ok ? '158 45% 34%' : '9 57% 48%', width: ok ? '99%' : '20%' }} /></div>
            </div>
          );
        })}
        {rows.length === 0 && <Empty label="No providers reporting." />}
      </Panel>
      <Panel hue="227 88% 58%" icon={<Zap className="i16" />} title="Ambient">
        <div className="kbrow"><div className="kbico"><Radio className="i16" /></div><div className="f1"><p className="kbtitle">Listening for "Hey Atlas"</p><p className="kbmeta">wake word · ambient</p></div></div>
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
      <Panel hue="25 100% 50%" icon={<Bot className="i16" />} title="Agents">
        {(agents ?? []).map((a) => (
          <div className="kbrow" key={a.id}>
            <div className="kbico"><Bot className="i16" /></div>
            <div className="f1"><p className="kbtitle">{a.name}</p><p className="kbmeta">{a.is_active ? 'active' : 'idle'} · {a.max_steps} steps</p></div>
          </div>
        ))}
        {(agents ?? []).length === 0 && <Empty label="No agents configured." />}
      </Panel>
      <Panel hue="345 74% 55%" icon={<AlertTriangle className="i16" />} title={`Needs approval · ${pending.length}`}>
        {pending.map((a) => (
          <div className="kbrow" key={a.id}>
            <div className="kbico"><AlertTriangle className="i16" /></div>
            <div className="f1"><p className="kbtitle">{a.action_summary}</p><p className="kbmeta">{a.risk_level || 'review'} · {fmtAgo(a.created_at)}</p></div>
          </div>
        ))}
        {pending.length === 0 && <Empty label="Nothing waiting on you." />}
      </Panel>
    </div>
  );
}

function KnowledgeTab() {
  const { knowledge, categories } = useAtlasKnowledge();
  const recent = (knowledge ?? []).slice(0, 6);
  return (
    <div className="coregrid">
      <Panel hue="25 100% 50%" icon={<Database className="i16" />} title="Domains">
        {(categories ?? []).map((c: string) => {
          const n = (knowledge ?? []).filter((k) => k.category === c).length;
          return (
            <div className="flowrow" key={c}>
              <div className="flownode"><div className="flowdot" style={{ ['--fc' as string]: '25 100% 50%' }}><Database className="i16" /></div><div><p className="kbtitle" style={{ textTransform: 'capitalize' }}>{c}</p><p className="kbmeta">{n} entries</p></div></div>
            </div>
          );
        })}
        {(categories ?? []).length === 0 && <Empty label="No knowledge domains yet." />}
      </Panel>
      <Panel hue="227 88% 58%" icon={<FileText className="i16" />} title="Recently indexed">
        {recent.map((k) => (
          <div className="kbrow" key={k.id}><div className="kbico"><FileText className="i16" /></div><div className="f1"><p className="kbtitle">{k.topic}</p><p className="kbmeta">{k.category} · {(k.relevance_score ?? 0).toFixed(2)} relevance</p></div></div>
        ))}
        {recent.length === 0 && <Empty label="Nothing indexed yet." />}
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
      <Panel hue="25 100% 50%" icon={<BookOpen className="i16" />} title="Research queue">
        {queue.map((t) => {
          const running = t.status !== 'queued';
          return (
            <div className="qrow" key={t.id}>
              {running ? <Loader className="i16" style={{ color: 'hsl(25 100% 50%)' }} /> : <Clock className="i16" style={{ color: 'hsl(30 3% 55%)' }} />}
              <div className="f1"><p className="kbtitle">{t.topic}</p><p className="kbmeta">{t.status} · {(t.sources ?? []).length} sources</p></div>
            </div>
          );
        })}
        {queue.length === 0 && <Empty label="Queue is clear." />}
      </Panel>
      <Panel hue="158 45% 34%" icon={<CheckCircle2 className="i16" />} title="Completed reports">
        {done.map((t) => (
          <div className="kbrow" key={t.id}><div className="kbico"><CheckCircle2 className="i16" /></div><div className="f1"><p className="kbtitle">{t.topic}</p><p className="kbmeta">{(t.findings ?? []).length} findings</p></div></div>
        ))}
        {done.length === 0 && <Empty label="No completed reports yet." />}
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
      <Panel hue="25 100% 50%" icon={<Zap className="i16" />} title="Learning metrics">
        <div className="flowrow"><div className="flownode"><div className="flowdot" style={{ ['--fc' as string]: '158 45% 34%' }}><CheckCircle2 className="i16" /></div><div><p className="kbtitle">Validation success</p><p className="kbmeta">{m.successRate}% pass</p></div></div><div className="flowbar"><div className="flowfill" style={{ ['--fc' as string]: '158 45% 34%', width: `${m.successRate}%` }} /></div></div>
        <div className="flowrow"><div className="flownode"><div className="flowdot" style={{ ['--fc' as string]: '25 100% 50%' }}><Database className="i16" /></div><div><p className="kbtitle">Knowledge velocity</p><p className="kbmeta">{m.knowledgeVelocity}/period</p></div></div></div>
        <div className="flowrow last"><div className="flownode"><div className="flowdot" style={{ ['--fc' as string]: '227 88% 58%' }}><BookOpen className="i16" /></div><div><p className="kbtitle">Queue depth</p><p className="kbmeta">{m.queueDepth} queued</p></div></div></div>
      </Panel>
      <Panel hue="227 88% 58%" icon={<CheckCircle2 className="i16" />} title="Recent validations">
        {logs.map((v: { id: string; verdict: string; created_at: string; grounding?: string }) => (
          <div className="errrow" key={v.id}><span className={`errsev ${v.verdict === 'valid' ? 'sev-i' : v.verdict === 'fake' ? 'sev-e' : 'sev-w'}`} /><div className="f1"><p className="errmsg" style={{ textTransform: 'capitalize' }}>{v.verdict}{v.grounding ? ` · ${v.grounding}` : ''}</p><p className="errmeta">{fmtAgo(v.created_at)}</p></div></div>
        ))}
        {logs.length === 0 && <Empty label="No validations yet." />}
      </Panel>
    </div>
  );
}

export const AuroraCoreTabs = memo(({ tab }: { tab: string }) => {
  switch (tab) {
    case 'search': return <SearchTab />;
    case 'live': return <LiveTab />;
    case 'agent': return <AgentTab />;
    case 'knowledge': return <KnowledgeTab />;
    case 'research': return <ResearchTab />;
    case 'learning': return <LearningTab />;
    default: return null;
  }
});
AuroraCoreTabs.displayName = 'AuroraCoreTabs';
