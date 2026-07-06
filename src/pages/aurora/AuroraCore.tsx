import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Sparkles, Brain, Search, AlertTriangle, Activity, TrendingUp, TrendingDown,
  Database, DownloadCloud, Cpu, CheckCircle2, FileText, BookOpen, Loader, Clock, Radio, Bot, Zap,
} from 'lucide-react';
import { AtlasSphere } from '@/components/atlas/AtlasSphere';
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

// Aurora Atlas Core — Intelligence Center (design: Aurora — Atlas Core).
// Top stats are wired to useAtlasHealth; the overview panels use the design's
// curated content.
const AuroraCore = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const { stats } = useAtlasHealth();

  return (
    <div className="overlay" data-screen-label="Aurora — Atlas Core">
      <div className="ovwash" />
      <header className="corehead">
        <button className="backbtn" onClick={() => navigate('/')}><ArrowLeft className="i16" />Back to Dashboard</button>
        <div className="fx ac gap12">
          <div><h1 className="corebrand">Atlas Core</h1><p className="coretagline">Intelligence Center</p></div>
          <Sparkles className="i20" style={{ color: 'hsl(243 82% 78%)' }} />
        </div>
      </header>

      <div className="corebody">
        <div className="corehero">
          <div className="coreorb"><div className="coreorbglow" />
            <AtlasSphere state="thinking" audioLevel={0} context="core" className="orbcvB" />
          </div>
          <div className="statgrid">
            <StatCard cls="sc-p" label="Knowledge" value={(stats?.knowledgeCount ?? 0).toLocaleString()} icon={<Brain className="i20" />} trend={<span className="stattrend upB"><TrendingUp className="i12" /><span>+12% from last period</span></span>} />
            <StatCard cls="sc-s" label="Research" value={String(stats?.activeResearch ?? 0)} icon={<Search className="i20" />} trend={<span className="stattrend" style={{ color: 'hsl(240 20% 58%)' }}>active topics</span>} />
            <StatCard cls="sc-a" label="Error Rate" value={`${(stats?.errorRate ?? 0).toFixed(1)}%`} icon={<AlertTriangle className="i20" />} trend={<span className="stattrend upB"><TrendingDown className="i12" /><span>−2% from last period</span></span>} />
            <StatCard cls="sc-h" label="Health" value={`${Math.round(stats?.healthScore ?? 0)}%`} icon={<Activity className="i20" />} trend={<span className="stattrend upB"><Activity className="i12" /><span>all systems nominal</span></span>} />
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

        <div className="coregrid">
          <div className="cpanel" style={{ ['--pc' as string]: '243 75% 66%' }}>
            <h3 className="cph"><Database className="i16" style={{ color: 'hsl(243 82% 78%)' }} />Real-time Data Flow</h3>
            <FlowRow icon={<DownloadCloud className="i16" />} fc="200 75% 60%" title="Ingestion" meta="1,204 docs/hr" width="82%" />
            <FlowRow icon={<Cpu className="i16" />} fc="280 68% 68%" title="Processing" meta="18 pipelines" width="64%" />
            <FlowRow icon={<CheckCircle2 className="i16" />} fc="160 58% 56%" title="Validation" meta="99.2% pass" width="99%" />
            <FlowRow icon={<Database className="i16" />} fc="243 75% 66%" title="Indexed" meta={`${(stats?.knowledgeCount ?? 0).toLocaleString()} total`} width="74%" last />
          </div>

          <div className="cpanel" style={{ ['--pc' as string]: '280 68% 66%' }}>
            <h3 className="cph"><Brain className="i16" style={{ color: 'hsl(280 72% 78%)' }} />Recent Knowledge</h3>
            <KbRow title="Transformer scaling laws — 2026 review" meta="arXiv · indexed 4 min ago · 0.94 relevance" />
            <KbRow title="EU AI Act — compliance summary" meta="Policy · indexed 22 min ago · 0.89 relevance" />
            <KbRow title="Vector DB benchmarks Q2" meta="Engineering · indexed 1h ago · 0.86 relevance" />
            <KbRow title="Retrieval-augmented agents survey" meta="arXiv · indexed 2h ago · 0.83 relevance" last />
          </div>

          <div className="cpanel" style={{ ['--pc' as string]: '190 75% 58%' }}>
            <h3 className="cph"><BookOpen className="i16" style={{ color: 'hsl(190 75% 64%)' }} />Research Queue</h3>
            <QRow running title="Multimodal reasoning benchmarks" meta="running · 3 sources" pct={72} />
            <QRow running title="On-device inference costs" meta="running · 5 sources" pct={41} />
            <QRow title="Agent memory architectures" meta="queued · 2 sources" pct={8} />
            <QRow title="Prompt caching strategies" meta="queued · 4 sources" pct={0} last />
          </div>

          <div className="cpanel" style={{ ['--pc' as string]: '345 74% 64%' }}>
            <h3 className="cph"><AlertTriangle className="i16" style={{ color: 'hsl(345 80% 72%)' }} />Recent Errors</h3>
            <ErrRow sev="w" msg="Rate limit approached — provider gemini" meta="warning · 11:42:08 · auto-throttled" />
            <ErrRow sev="i" msg="Cache miss on embedding batch #4821" meta="info · 11:38:51 · recomputed" />
            <ErrRow sev="e" msg="Timeout fetching source (retry 2/3)" meta="error · 11:31:20 · recovered" />
            <ErrRow sev="i" msg='Schedule "daily-digest" completed' meta="info · 06:00:04 · 3 insights" last />
          </div>
        </div>
      </div>
    </div>
  );
};

function StatCard({ cls, label, value, icon, trend }: { cls: string; label: string; value: string; icon: React.ReactNode; trend: React.ReactNode }) {
  return (
    <div className={`statcard ${cls}`}>
      <div className="fx jb" style={{ alignItems: 'flex-start' }}>
        <div><p className="statlbl">{label}</p><p className="statval tnum">{value}</p>{trend}</div>
        <div className="statico">{icon}</div>
      </div>
    </div>
  );
}
function FlowRow({ icon, fc, title, meta, width, last }: { icon: React.ReactNode; fc: string; title: string; meta: string; width: string; last?: boolean }) {
  return (
    <div className={`flowrow ${last ? 'last' : ''}`}>
      <div className="flownode"><div className="flowdot" style={{ ['--fc' as string]: fc }}>{icon}</div><div><p className="kbtitle">{title}</p><p className="kbmeta">{meta}</p></div></div>
      <div className="flowbar"><div className="flowfill" style={{ ['--fc' as string]: fc, width }} /></div>
    </div>
  );
}
function KbRow({ title, meta, last }: { title: string; meta: string; last?: boolean }) {
  return (
    <div className={`kbrow ${last ? 'last' : ''}`}><div className="kbico"><FileText className="i16" /></div><div className="f1"><p className="kbtitle">{title}</p><p className="kbmeta">{meta}</p></div></div>
  );
}
function QRow({ running, title, meta, pct, last }: { running?: boolean; title: string; meta: string; pct: number; last?: boolean }) {
  return (
    <div className={`qrow ${last ? 'last' : ''}`}>
      {running ? <Loader className="i16" style={{ color: 'hsl(190 75% 62%)' }} /> : <Clock className="i16" style={{ color: 'hsl(240 20% 56%)' }} />}
      <div className="f1"><p className="kbtitle">{title}</p><p className="kbmeta">{meta}</p></div>
      <div className="qbar"><div className="qfill" style={{ width: `${pct}%` }} /></div><span className="qpct">{pct}%</span>
    </div>
  );
}
function ErrRow({ sev, msg, meta, last }: { sev: 'e' | 'w' | 'i'; msg: string; meta: string; last?: boolean }) {
  return (
    <div className={`errrow ${last ? 'last' : ''}`}><span className={`errsev sev-${sev}`} /><div className="f1"><p className="errmsg">{msg}</p><p className="errmeta">{meta}</p></div></div>
  );
}

export default AuroraCore;
