import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Sparkles, Brain, Search, AlertTriangle, Activity,
  Database, DownloadCloud, Cpu, CheckCircle2, FileText, BookOpen, Loader, Clock, Radio, Bot, Zap,
} from 'lucide-react';
import { AtlasSphereLazy as AtlasSphere } from '@/components/atlas/AtlasSphereLazy';
import { AtlasCoreTabs } from '@/components/atlas-ui/AtlasCoreTabs';
import { Button, Panel, Row, StatTile } from '@/components/atlas-ui/primitives';
import { useAtlasHealth } from '@/hooks/useAtlasHealth';

const TABS = [
  { key: 'search', label: 'Search', icon: Search },
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'live', label: 'Live', icon: Radio, live: true },
  { key: 'agent', label: 'Agent', icon: Bot, badge: 3 },
  { key: 'knowledge', label: 'Knowledge', icon: Brain },
  { key: 'research', label: 'Research', icon: BookOpen },
  { key: 'learning', label: 'Learning', icon: Zap },
];

// Atlas Atlas Core — Intelligence Center (design: Atlas — Atlas Core).
// Top stats are wired to useAtlasHealth; the overview panels use the design's
// curated content.
const AtlasCoreScreen = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const { stats } = useAtlasHealth();

  return (
    <div className="overlay" data-screen-label="Atlas — Atlas Core">
      <div className="ovwash" />
      <header className="corehead">
        <Button variant="text" icon={<ArrowLeft className="i16" />} onClick={() => navigate('/')}>Back to Dashboard</Button>
        <div className="fx ac gap12">
          <div><h1 className="corebrand">Atlas Core</h1><p className="coretagline">Intelligence Center</p></div>
          <Sparkles className="i20" style={{ color: 'hsl(243 82% 78%)' }} />
        </div>
      </header>

      <div className="corebody">
        <div className="corehero">
          <div className="coreorb"><div className="coreorbglow" />
            {/* Still hardcoded — the 2026-07-26 audit named it and it is a data
                wiring job, not a styling one. */}
            <AtlasSphere state="thinking" audioLevel={0} context="core" className="orbcvB" />
          </div>
          <div className="statgrid">
            {/* `trend` is typed `{ direction, label }` now, and the two entries
                that used it are gone: "+12% from last period" and "−2% from
                last period" were hardcoded strings attached to real values of
                0 and 0.0%. There is no period-over-period series behind either
                number, so the honest render is no trend at all. */}
            <StatTile label="Knowledge" value={(stats?.knowledgeCount ?? 0).toLocaleString()} icon={<Brain className="i20" />} />
            <StatTile label="Research" value={String(stats?.activeResearch ?? 0)} icon={<Search className="i20" />} trend={{ direction: 'flat', label: 'active topics' }} />
            <StatTile label="Error Rate" value={`${(stats?.errorRate ?? 0).toFixed(1)}%`} icon={<AlertTriangle className="i20" />} />
            <StatTile label="Health" value={`${Math.round(stats?.healthScore ?? 0)}%`} icon={<Activity className="i20" />} trend={{ direction: 'flat', label: 'all systems nominal' }} />
          </div>
        </div>

        <div className="coretabs">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.key} className={`ctab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
                <Icon className="i14" />{t.label}
                {t.badge && <span className="badge">{t.badge}</span>}
                {t.live && <span className="live" />}
              </button>
            );
          })}
        </div>

        {tab !== 'overview' && <AtlasCoreTabs tab={tab} />}

        {tab === 'overview' && (
        <div className="coregrid">
          {/* The per-panel `--pc` accent hue is gone with the coloured ring it
              drove; panels are separated by fill and space now.
              STILL FABRICATED, and out of T1's scope: the throughput figures,
              the four knowledge rows and the four error rows below are
              hardcoded, and sit directly above a real "Indexed — 0 total".
              Extracting them into typed primitives does not make them true. */}
          <Panel title="Real-time Data Flow" icon={<Database className="i16" />}>
            <FlowRow icon={<DownloadCloud className="i16" />} title="Ingestion" meta="1,204 docs/hr" width="82%" />
            <FlowRow icon={<Cpu className="i16" />} title="Processing" meta="18 pipelines" width="64%" />
            <FlowRow icon={<CheckCircle2 className="i16" />} title="Validation" meta="99.2% pass" width="99%" />
            <FlowRow icon={<Database className="i16" />} title="Indexed" meta={`${(stats?.knowledgeCount ?? 0).toLocaleString()} total`} width="74%" />
          </Panel>

          <Panel title="Recent Knowledge" icon={<Brain className="i16" />}>
            <KbRow title="Transformer scaling laws — 2026 review" meta="arXiv · indexed 4 min ago · 0.94 relevance" />
            <KbRow title="EU AI Act — compliance summary" meta="Policy · indexed 22 min ago · 0.89 relevance" />
            <KbRow title="Vector DB benchmarks Q2" meta="Engineering · indexed 1h ago · 0.86 relevance" />
            <KbRow title="Retrieval-augmented agents survey" meta="arXiv · indexed 2h ago · 0.83 relevance" />
          </Panel>

          <Panel title="Research Queue" icon={<BookOpen className="i16" />}>
            <QRow running title="Multimodal reasoning benchmarks" meta="running · 3 sources" pct={72} />
            <QRow running title="On-device inference costs" meta="running · 5 sources" pct={41} />
            <QRow title="Agent memory architectures" meta="queued · 2 sources" pct={8} />
            <QRow title="Prompt caching strategies" meta="queued · 4 sources" pct={0} />
          </Panel>

          <Panel title="Recent Errors" icon={<AlertTriangle className="i16" />}>
            <ErrRow sev="w" msg="Rate limit approached — provider gemini" meta="warning · 11:42:08 · auto-throttled" />
            <ErrRow sev="i" msg="Cache miss on embedding batch #4821" meta="info · 11:38:51 · recomputed" />
            <ErrRow sev="e" msg="Timeout fetching source (retry 2/3)" meta="error · 11:31:20 · recovered" />
            <ErrRow sev="i" msg='Schedule "daily-digest" completed' meta="info · 06:00:04 · 3 insights" />
          </Panel>
        </div>
        )}
      </div>
    </div>
  );
};

// Every one of these was a div on a `.flowrow` / `.kbrow` / `.qrow` / `.errrow`
// class whose only job was a 1px divider, plus a `last` prop feeding the
// matching `.last{border:none}` rule. They are <Row> slots now, and `last` is
// gone from all four signatures.
function FlowRow({ icon, title, meta, width }: { icon: React.ReactNode; title: string; meta: string; width: string }) {
  return (
    <Row
      lead={<span className="flowdot">{icon}</span>}
      title={title}
      meta={meta}
      trail={<span className="flowbar" style={{ width: 120 }}><span className="flowfill" style={{ display: 'block', height: '100%', width }} /></span>}
    />
  );
}
function KbRow({ title, meta }: { title: string; meta: string }) {
  return <Row lead={<span className="kbico"><FileText className="i16" /></span>} title={title} meta={meta} />;
}
function QRow({ running, title, meta, pct }: { running?: boolean; title: string; meta: string; pct: number }) {
  return (
    <Row
      lead={running ? <Loader className="i16" style={{ color: 'var(--acc)' }} /> : <Clock className="i16" style={{ color: 'var(--ink3)' }} />}
      title={title}
      meta={meta}
      trail={
        <>
          <span className="qbar" style={{ width: 120 }}><span className="qfill" style={{ display: 'block', height: '100%', width: `${pct}%` }} /></span>
          <span className="qpct">{pct}%</span>
        </>
      }
    />
  );
}
function ErrRow({ sev, msg, meta }: { sev: 'e' | 'w' | 'i'; msg: string; meta: string }) {
  return <Row lead={<span className={`errsev sev-${sev}`} />} title={msg} meta={meta} />;
}

export default AtlasCoreScreen;
