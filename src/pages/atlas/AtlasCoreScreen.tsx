import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Sparkles, Brain, Search, AlertTriangle, Activity,
  Database, DownloadCloud, Cpu, CheckCircle2, FileText, BookOpen, Loader, Clock, Radio, Bot, Zap,
} from 'lucide-react';
import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';
import { AtlasCoreTabs } from '@/components/atlas-ui/AtlasCoreTabs';
import { Button, Empty, Panel, Row, StatTile } from '@/components/atlas-ui/primitives';
import { useAtlasHealth } from '@/hooks/useAtlasHealth';
import { useAtlasKnowledge } from '@/hooks/useAtlasKnowledge';
import { useAtlasResearch } from '@/hooks/useAtlasResearch';
import { errorSeverityGlyph, useAtlasErrorLog } from '@/hooks/useAtlasErrorLog';
import { EDITION, surfaceByPath } from '@/surfaces';
import { isBetaUi } from '@/lib/betaFlag';
import { CoreHero } from '@/components/atlas/BetaScreenHero';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import type { IconName } from '@/components/atlas/icons';
import { useBetaNavigate } from '@/lib/viewTransitions';
import {
  QUEUE_STATUSES, agoLabel, coreEscapeStep, coreHeroLine, coreOverviewTiles, coreTabFromHash,
  coreTabIntro, coreTabStrip, indexingRow, researchRunning, researchTag, type TagTone,
} from '@/lib/betaCore';
import { escapeAction } from '@/lib/betaScreenKeys';
// Every rule in it is scoped to the Beta classes below, so importing it with
// the flag off changes nothing on the Workshop screen.
import '@/styles/beta/core.css';

/**
 * Registration data. Mirrored in `src/surfaces.ts`, which is what the router,
 * the dock and the account menu are built from; `surfaces.test.ts` fails if the
 * two ever disagree.
 *
 * Consumer, but not wholly: the registry entry carries a `consumerTabs` list,
 * because `TABS` below mixes "what Atlas knows about me" with operator
 * instrumentation (Live, Agent, Learning). `visibleTabs()` applies it — until
 * it did, `consumerTabs` was declared by the registry and read by nothing, and
 * a consumer build shipped the raw event stream, the agent editor and the
 * pipeline metrics with the tab strip intact.
 */
export const surface = {
  path: '/atlas-core',
  label: 'Core',
  icon: 'Cpu',
  entry: 'dock' as const,
  mock: false,
  edition: 'consumer' as const,
};

// `badge: 3` was a hardcoded literal on the Agent tab — it never counted
// anything. The Agent tab's own pending-approvals count is real
// (`useApprovals`), so a badge belongs there or nowhere; it does not belong
// here as a constant. Removed rather than faked.
const TABS = [
  { key: 'search', label: 'Search', icon: Search },
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'live', label: 'Live', icon: Radio, live: true },
  { key: 'agent', label: 'Agent', icon: Bot },
  { key: 'knowledge', label: 'Knowledge', icon: Brain },
  { key: 'research', label: 'Research', icon: BookOpen },
  { key: 'learning', label: 'Learning', icon: Zap },
  { key: 'memory', label: 'Memory', icon: Database },
];

/**
 * The tabs this edition shows.
 *
 * Admin (Lighthouse) gets all eight. Consumer gets the five the registry
 * names — Live is a raw event stream, Agent is agent CRUD plus the tool-call
 * log and the approval queue, Learning is validation-success rates and
 * pipeline metrics. None of the three is a thing a person asks Atlas about;
 * all three were shipping.
 *
 * An unfiltered fallback would be wrong in the fail-open direction, so a
 * registry entry with no `consumerTabs` yields NO tabs rather than every tab —
 * but `surfaces.test.ts` asserts the entry exists and that every key in it is
 * real, so the empty case is unreachable rather than merely unlikely.
 */
export function visibleTabs(edition: string = EDITION): typeof TABS {
  if (edition !== 'consumer') return TABS;
  const allowed = surfaceByPath('/atlas-core')?.consumerTabs ?? [];
  return TABS.filter((t) => allowed.includes(t.key));
}

/**
 * The Beta hero's intro for the three operator tabs. Written here, behind the
 * edition literal, and not in src/lib/betaCore.ts: Rollup folds `EDITION` to a
 * constant and drops this object from a consumer build, the same way
 * AtlasCoreTabs drops the panels themselves, so copy about tabs a consumer
 * never sees does not ship to one.
 */
const ADMIN_TAB_INTROS: Readonly<Record<string, string>> = EDITION === 'admin'
  ? {
      live: 'The raw event stream from the brain, as it happens.',
      agent: 'Agents, the approvals they are waiting on, and every tool call they made.',
      learning: 'Validation rates and pipeline metrics for what Atlas learns.',
    }
  : {};

/**
 * The screen. The beta_ui flag picks the body once per load (it is read at
 * boot and a change reloads the window), so the two bodies are two components
 * rather than one with branches through it: with the flag off the Workshop
 * component below is the screen exactly as it was.
 */
const AtlasCoreScreen = () => (isBetaUi() ? <BetaCoreScreen /> : <WorkshopCoreScreen />);

// Atlas Atlas Core — Intelligence Center (design: Atlas — Atlas Core).
// Top stats are wired to useAtlasHealth; the overview panels use the design's
// curated content.
const WorkshopCoreScreen = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const tabs = visibleTabs();
  // A tab hidden by the edition must not be reachable by having been selected:
  // `tab` is state, and nothing else validates it against what is on screen.
  const shownTab = tabs.some((t) => t.key === tab) ? tab : (tabs[0]?.key ?? 'overview');
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
            {/* No longer hardcoded to `thinking`. The 2026-07-26 audit called
                that "a small existing lie" — the sphere claimed Atlas was
                reasoning whenever this screen was open, which is most of the
                time it is open.

                This screen has no voice session, so it cannot compute full
                presence, and mounting one here purely to feed a sphere would
                start a second microphone pipeline. `activeResearch` is the one
                real signal it already holds: research topics currently running.
                So `working` when Atlas is genuinely doing background work, and
                `idle` when it is not. */}
            <AtlasSphereCanvas
              className="sphcv"
              state={(stats?.activeResearch ?? 0) > 0 ? 'working' : 'idle'}
              countScale={0.4}
            />
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
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.key} className={`ctab ${shownTab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
                <Icon className="i14" />{t.label}
                {t.live && <span className="live" />}
              </button>
            );
          })}
        </div>

        {shownTab !== 'overview' && <AtlasCoreTabs tab={shownTab} />}

        {shownTab === 'overview' && <OverviewTab knowledgeCount={stats?.knowledgeCount ?? 0} />}
      </div>
    </div>
  );
};

/**
 * The Overview tab.
 *
 * Every row here used to be invented. `docs/ROADMAP.md` flagged it as a
 * violation of the design plan's own rule — "honest UI, not fake data" — and
 * the 2026-08-03 audit found it was worse than that: a *regression*. The legacy
 * `/atlas-core-legacy` screen this replaced says "Waiting for data…", while
 * this one claimed "1,204 docs/hr" directly above a real "Indexed — 0 total",
 * "+12% from last period" on a value of zero, and four error rows, one naming
 * `gemini` — a provider Atlas no longer uses.
 *
 * Two of the four panels had a real hook available the whole time
 * (`useAtlasKnowledge`, `useAtlasResearch`); the sibling tabs in
 * `AtlasCoreTabs` have used them, with honest `<Empty>` states, since they were
 * written. The error panel needed `useAtlasErrorLog`, lifted out of the legacy
 * `ErrorLogStream` in this same pass.
 *
 * The throughput panel is the interesting one: there is no ingestion-rate,
 * pipeline-count or validation-pass series anywhere in the app, and inventing a
 * bar width is how this screen got here. So it now shows the one figure that IS
 * real — the indexed count — and says plainly that the rest is not measured.
 * A panel that admits it has one number beats four numbers that are fiction.
 */
function OverviewTab({ knowledgeCount }: { knowledgeCount: number }) {
  const { knowledge } = useAtlasKnowledge();
  const { topics } = useAtlasResearch();
  const { errors, failed } = useAtlasErrorLog(4);

  const recent = (knowledge ?? []).slice(0, 4);
  const queue = (topics ?? []).filter((t) => ['queued', 'researching', 'processing'].includes(t.status)).slice(0, 4);

  return (
    <div className="coregrid">
      <Panel title="Indexing" icon={<Database className="i16" />}>
        <Row
          lead={<span className="flowdot"><Database className="i16" /></span>}
          title="Indexed"
          meta={`${knowledgeCount.toLocaleString()} ${knowledgeCount === 1 ? 'entry' : 'entries'}`}
        />
        <Empty body="Ingestion rate, pipeline count and validation pass rate are not measured yet." />
      </Panel>

      <Panel title="Recent Knowledge" icon={<Brain className="i16" />}>
        {recent.map((k) => (
          <KbRow key={k.id} title={k.topic} meta={`${k.category} · ${(k.relevance_score ?? 0).toFixed(2)} relevance`} />
        ))}
        {recent.length === 0 && <Empty body="Nothing indexed yet." />}
      </Panel>

      <Panel title="Research Queue" icon={<BookOpen className="i16" />}>
        {queue.map((t) => (
          <QRow
            key={t.id}
            running={t.status !== 'queued'}
            title={t.topic}
            meta={`${t.status} · ${(t.sources ?? []).length} sources`}
          />
        ))}
        {queue.length === 0 && <Empty body="Queue is clear." />}
      </Panel>

      <Panel title="Recent Errors" icon={<AlertTriangle className="i16" />}>
        {(errors ?? []).map((e) => (
          <ErrRow
            key={e.id}
            sev={errorSeverityGlyph(e.severity)}
            msg={e.error_message}
            meta={`${e.severity} · ${new Date(e.created_at).toLocaleTimeString()}${e.resolved ? ' · resolved' : ''}`}
          />
        ))}
        {/* "no errors" and "could not read the log" are different states. */}
        {errors !== null && errors.length === 0 && !failed && <Empty body="No errors logged." status="resting" />}
        {failed && <Empty body="Could not read the error log." status="error" />}
      </Panel>
    </div>
  );
}

// Every one of these was a div on a `.flowrow` / `.kbrow` / `.qrow` / `.errrow`
// class whose only job was a 1px divider, plus a `last` prop feeding the
// matching `.last{border:none}` rule. They are <Row> slots now, and `last` is
// gone from all four signatures.
//
// `FlowRow` itself is gone: it rendered the invented throughput bar
// (`width` was a fabricated percentage) and lost its only caller when
// `OverviewTab`'s indexing panel switched to the honest one-number-plus-Empty
// version above. Kept as dead code it would have been the next screen's
// temptation to fake a bar width again.
function KbRow({ title, meta }: { title: string; meta: string }) {
  return <Row lead={<span className="kbico"><FileText className="i16" /></span>} title={title} meta={meta} />;
}
// `pct` is optional now, and nothing in the app passes it. The research topics
// returned by `useAtlasResearch` carry a status (`queued` / `researching` /
// `processing` / `completed`) and a source list — there is no percentage
// anywhere in the schema. The old 72% / 41% / 8% / 0% bars were invented to
// make the panel look alive. The bar renders only if a real number ever
// arrives; until then the status text carries the meaning.
function QRow({ running, title, meta, pct }: { running?: boolean; title: string; meta: string; pct?: number }) {
  return (
    <Row
      lead={running ? <Loader className="i16" style={{ color: 'var(--acc)' }} /> : <Clock className="i16" style={{ color: 'var(--ink3)' }} />}
      title={title}
      meta={meta}
      trail={
        pct == null ? undefined : (
          <>
            <span className="qbar" style={{ width: 120 }}><span className="qfill" style={{ display: 'block', height: '100%', width: `${pct}%` }} /></span>
            <span className="qpct">{pct}%</span>
          </>
        )
      }
    />
  );
}
function ErrRow({ sev, msg, meta }: { sev: 'e' | 'w' | 'i'; msg: string; meta: string }) {
  return <Row lead={<span className={`errsev sev-${sev}`} />} title={msg} meta={meta} />;
}

// ── Beta (Atlas Core Beta.dc.html) ──────────────────────────────────────────
//
// The same tabs, the same edition filter and the same hooks as the Workshop
// screen above; only the body is drawn the design's way. The open tab lives in
// the URL hash (`/atlas-core#memory`), which is how Architecture's "See
// exactly what Atlas remembers" lands on Memory, and a hash naming a tab this
// edition hides opens Overview. Every tab but Overview is still AtlasCoreTabs'
// own panel, restyled by core.css inside `.b-core-main`.

function BetaCoreScreen() {
  const navigate = useBetaNavigate();
  const routeNavigate = useNavigate();
  const location = useLocation();
  const tabs = visibleTabs();
  const keys = tabs.map((t) => t.key);
  const shownTab = coreTabFromHash(location.hash, keys) ?? (keys.includes('overview') ? 'overview' : (keys[0] ?? 'overview'));
  const { stats } = useAtlasHealth();
  const strip = coreTabStrip(tabs, shownTab);
  const current = strip.find((t) => t.current);
  const canOpen = (key: string) => keys.includes(key);

  // Replace, not push: switching tabs is not a place Back should walk through.
  const openTab = useCallback((key: string) => {
    routeNavigate(
      { pathname: location.pathname, search: location.search, hash: key === 'overview' ? '' : `#${key}` },
      { replace: true },
    );
  }, [routeNavigate, location.pathname, location.search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const act = escapeAction(e);
      if (act === 'blur') (e.target as HTMLElement).blur();
      if (act !== 'step') return;
      if (coreEscapeStep(shownTab) === 'overview') openTab('overview');
      else navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shownTab, openTab, navigate]);

  return (
    <div className="b-core" data-screen-label="Atlas — Atlas Core">
      <CoreHero
        eyebrow={`Atlas Core · ${(stats?.knowledgeCount ?? 0).toLocaleString()} known · ${stats?.activeResearch ?? 0} researching`}
        title="Core"
        intro={coreTabIntro(shownTab, ADMIN_TAB_INTROS)}
        state={(stats?.activeResearch ?? 0) > 0 ? 'working' : 'idle'}
      />
      <nav className="b-core-tabs" aria-label="Core sections">
        {strip.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`b-core-tab${t.current ? ' on' : ''}`}
            aria-current={t.current ? 'page' : undefined}
            onClick={() => openTab(t.key)}
          >
            <AtlasIcon name={t.icon} size={17} weight={1.6} />
            {t.label}
            {t.live ? <span className="b-core-tab-live" aria-hidden /> : null}
            {t.adminNote ? <span className="b-core-tab-admin">Admin</span> : null}
          </button>
        ))}
      </nav>
      <main className="b-core-main" aria-label={current ? `Core · ${current.label}` : 'Core'}>
        {shownTab === 'overview'
          ? <BetaCoreOverview stats={stats} canOpen={canOpen} onOpen={openTab} />
          : <AtlasCoreTabs tab={shownTab} />}
      </main>
    </div>
  );
}

interface BetaOverviewProps {
  stats: ReturnType<typeof useAtlasHealth>['stats'];
  canOpen: (key: string) => boolean;
  onOpen: (key: string) => void;
}

/**
 * The Beta overview: the ink knowledge card and four tiles, then the four
 * cards the Workshop overview had — over the same four hooks, so every figure
 * on it is one the Workshop screen already showed. Pause on a queued row is
 * the Research tab's own `pauseResearch`.
 */
function BetaCoreOverview({ stats, canOpen, onOpen }: BetaOverviewProps) {
  const { knowledge } = useAtlasKnowledge();
  const { topics, pauseResearch } = useAtlasResearch();
  const { errors, failed } = useAtlasErrorLog(4);
  const now = Date.now();

  const knowledgeCount = stats?.knowledgeCount ?? 0;
  const recent = (knowledge ?? []).slice(0, 4);
  const queue = (topics ?? []).filter((t) => QUEUE_STATUSES.includes(t.status)).slice(0, 4);
  const queued = (topics ?? []).filter((t) => t.status === 'queued').length;
  const tiles = coreOverviewTiles(stats
    ? { activeResearch: stats.activeResearch, queued, errorRate: stats.errorRate, healthScore: stats.healthScore }
    : null);
  const indexing = indexingRow(knowledgeCount, recent[0]?.created_at, now);

  return (
    <div className="b-core-grid">
      <div className="b-core-top">
        <section className="b-core-know" aria-label="Knowledge">
          <span className="b-core-know-k">Knowledge</span>
          <div className="b-core-know-v">
            <span className="b-core-know-n">{stats ? knowledgeCount.toLocaleString() : '—'}</span>
            <span className="b-core-know-u">entries indexed</span>
          </div>
          <p className="b-core-know-line">{coreHeroLine(stats?.activeResearch ?? 0)}</p>
          {canOpen('search') || canOpen('research') ? (
            <div className="b-core-know-actions">
              {canOpen('search') ? <button type="button" className="b-core-know-btn" onClick={() => onOpen('search')}>Search the brain</button> : null}
              {canOpen('research') ? <button type="button" className="b-core-know-btn b-core-know-btn--soft" onClick={() => onOpen('research')}>Start research</button> : null}
            </div>
          ) : null}
        </section>
        <div className="b-core-tiles">
          {tiles.map((t) => (
            <div key={t.key} className={`b-core-tile b-core-tile--${t.tone}`}>
              <span className="b-core-tile-k">{t.label}<AtlasIcon name={t.icon} size={17} weight={1.6} /></span>
              <span className="b-core-tile-v">{t.value}</span>
              <span className="b-core-tile-d">{t.detail}</span>
            </div>
          ))}
        </div>
      </div>

      <CoreCard
        icon="document"
        title="Recent knowledge"
        action={canOpen('knowledge') ? { label: 'All knowledge', onClick: () => onOpen('knowledge') } : undefined}
      >
        {recent.map((k) => (
          <CoreRow key={k.id} title={k.topic} sub={`${k.category} · ${(k.relevance_score ?? 0).toFixed(2)} relevance`} trail={agoLabel(k.created_at, now)} />
        ))}
        {recent.length === 0 ? <CoreEmpty>Nothing indexed yet.</CoreEmpty> : null}
      </CoreCard>

      <CoreCard
        icon="teach"
        title="Research queue"
        action={canOpen('research') ? { label: 'Open', onClick: () => onOpen('research') } : undefined}
      >
        {queue.map((t) => (
          <CoreRow
            key={t.id}
            chip={{ icon: 'teach', on: researchRunning(t.status) }}
            title={t.topic}
            sub={`${(t.sources ?? []).length} ${(t.sources ?? []).length === 1 ? 'source' : 'sources'} read`}
            tag={researchTag(t.status)}
            action={
              <button type="button" className="b-btn b-btn--row" aria-label={`Pause research on ${t.topic}`} onClick={() => void pauseResearch(t.id)}>
                Pause
              </button>
            }
          />
        ))}
        {queue.length === 0 ? <CoreEmpty>Queue is clear.</CoreEmpty> : null}
      </CoreCard>

      <CoreCard
        icon="download"
        title="Indexing"
        sub="The one figure Atlas actually measures. Throughput and pipeline counts aren’t tracked yet, so they aren’t shown."
      >
        <CoreRow title={indexing.title} sub={indexing.sub} trail={knowledgeCount > 0 ? 'Indexed' : undefined} trailGood />
      </CoreCard>

      <CoreCard icon="warning" title="Recent errors" note="The four newest entries in the error log, resolved or not.">
        {(errors ?? []).map((e) => (
          <CoreRow
            key={e.id}
            dot={errorSeverityGlyph(e.severity)}
            title={e.error_message}
            sub={`${e.severity} · ${new Date(e.created_at).toLocaleTimeString()}${e.resolved ? ' · resolved' : ''}`}
          />
        ))}
        {/* "no errors" and "could not read the log" are different states. */}
        {errors !== null && errors.length === 0 && !failed ? <CoreEmpty>No errors logged.</CoreEmpty> : null}
        {failed ? <CoreEmpty error>Could not read the error log.</CoreEmpty> : null}
      </CoreCard>
    </div>
  );
}

function CoreCard({ icon, title, sub, note, action, children }: {
  icon: IconName;
  title: string;
  sub?: string;
  note?: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section className="b-core-card" aria-label={title}>
      <div className="b-core-card-head">
        <span className="b-core-card-ico"><AtlasIcon name={icon} size={20} weight={1.6} /></span>
        <div className="b-core-card-titles">
          <h2 className="b-core-card-title">{title}</h2>
          {sub ? <p className="b-core-card-sub">{sub}</p> : null}
        </div>
        {action ? <button type="button" className="b-core-card-btn" onClick={action.onClick}>{action.label}</button> : null}
      </div>
      {children}
      {note ? <p className="b-core-card-note">{note}</p> : null}
    </section>
  );
}

function CoreRow({ title, sub, trail, trailGood, dot, chip, tag, action }: {
  title: string;
  sub?: string;
  trail?: string;
  trailGood?: boolean;
  /** The error log's own severity glyph: error, warning, info. */
  dot?: ReturnType<typeof errorSeverityGlyph>;
  chip?: { icon: IconName; on: boolean };
  tag?: { label: string; tone: TagTone };
  action?: ReactNode;
}) {
  return (
    <div className="b-core-row">
      {dot ? <span className={`b-core-dot b-core-dot--${dot}`} aria-hidden /> : null}
      {chip ? <span className={`b-core-chip${chip.on ? ' on' : ''}`} aria-hidden><AtlasIcon name={chip.icon} size={16} weight={1.7} /></span> : null}
      <div className="b-core-row-main">
        <p className="b-core-row-t">{title}</p>
        {sub ? <p className="b-core-row-s">{sub}</p> : null}
      </div>
      {tag ? <span className={`b-core-tag b-core-tag--${tag.tone}`}>{tag.label}</span> : null}
      {trail ? <span className={`b-core-row-trail${trailGood ? ' good' : ''}`}>{trail}</span> : null}
      {action}
    </div>
  );
}

function CoreEmpty({ error, children }: { error?: boolean; children: ReactNode }) {
  return <p className={`b-core-empty${error ? ' error' : ''}`} role="status">{children}</p>;
}

export default AtlasCoreScreen;
