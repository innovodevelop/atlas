import { Suspense, lazy, memo, useState } from 'react';
import { Search, Database, FileText, BookOpen, Loader, Clock, Zap, CheckCircle2, Radio, Brain, Sparkles, Play, Pause, Plus } from 'lucide-react';
import { useBrainSearch, type SearchMode } from '@/hooks/useBrainSearch';
import { useAtlasKnowledge } from '@/hooks/useAtlasKnowledge';
import { useAtlasResearch } from '@/hooks/useAtlasResearch';
import { useAtlasMemory } from '@/hooks/useAtlasMemory';
import { EDITION } from '@/surfaces';
import { Button, Empty, Panel, Row } from './primitives';
import { fmtAgo } from './coreTabsShared';

// Atlas Core tab panels — Workshop design's 8-view Core, wired to real data.
// Each tab was a dead button showing the same static overview; these render
// the actual knowledge/research/learning/agent/live surfaces from existing
// hooks.
//
// The local `Panel` and `Empty` that used to live here are gone: they were the
// seed of the shared primitives and are now imported from ./primitives. The
// `hue` prop went with them — it drove a coloured panel ring that the
// borderless rule deletes, and it was passed as a raw HSL triplet.

const SEARCH_MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: 'keyword', label: 'Exact words', hint: 'Matches the words you typed, locally and instantly.' },
  { value: 'semantic', label: 'By meaning', hint: 'Asks the brain for things that mean the same, not just the same words.' },
  { value: 'hybrid', label: 'Both', hint: 'Runs both and merges them, ranking things found twice highest.' },
];

/**
 * Search. The mode picker and the embedding backfill were in `BrainSearchPanel`
 * in the deleted legacy tree — `useBrainSearch` still exposes `setSearchMode`
 * and `generateEmbeddings`, but after the deletion nothing called either, so
 * the hook was permanently pinned to `keyword` (`useBrainSearch.ts:102,281`).
 * A user searching for a paraphrase of something Atlas knows simply got
 * nothing, and the one control that could repair sqlite-vec coverage over
 * pre-existing rows was gone. Both are back.
 */
function SearchTab() {
  const {
    query, setQuery, resultsByType, isSearching, searchMode, setSearchMode, generateEmbeddings,
  } = useBrainSearch();
  const [backfill, setBackfill] = useState<'idle' | 'running' | string>('idle');
  const all = [...resultsByType.knowledge, ...resultsByType.research, ...resultsByType.finding].slice(0, 8);
  const mode = SEARCH_MODES.find((m) => m.value === searchMode);

  const runBackfill = async () => {
    setBackfill('running');
    try {
      // `/embed-backfill` answers `{ processed }` (atlas-brain/src/index.ts:383).
      const data = await generateEmbeddings(50);
      const n = Number(data?.processed ?? 0);
      setBackfill(n > 0 ? `Indexed ${n} more.` : 'Everything already has a vector.');
    } catch (e) {
      setBackfill(e instanceof Error ? e.message : 'Backfill failed.');
    }
  };

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
        <select
          className="field"
          style={{ width: '100%', marginBottom: 8 }}
          aria-label="How to search"
          value={searchMode}
          onChange={(e) => setSearchMode(e.target.value as SearchMode)}
        >
          {SEARCH_MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        {mode && <p className="fs12" style={{ color: 'var(--ink3)', margin: '0 0 12px' }}>{mode.hint}</p>}
        {isSearching && <Empty body="Searching…" />}
        {!isSearching && query && all.length === 0 && <Empty body="No matches yet." />}
        {!query && <Empty body="Type to search across everything Atlas knows." />}
      </Panel>
      <Panel
        icon={<FileText className="i16" />}
        title="Top results"
        action={
          searchMode !== 'keyword' ? (
            <Button
              size="sm"
              variant="text"
              icon={<Sparkles className="i14" />}
              loading={backfill === 'running'}
              onClick={() => void runBackfill()}
            >
              Index older entries
            </Button>
          ) : undefined
        }
      >
        {all.map((r) => (
          <Row key={r.id} lead={<span className="kbico"><FileText className="i16" /></span>} title={r.title} meta={r.type} />
        ))}
        {all.length === 0 && <Empty body="Results appear here." />}
        {/* Meaning-based search only finds rows that have a vector. Anything
            Atlas stored before embeddings were switched on has none, and this
            is the only trigger that fills them in. */}
        {backfill !== 'idle' && backfill !== 'running' && (
          <p className="fs12" style={{ color: 'var(--ink3)', marginTop: 10, marginBottom: 0 }}>{backfill}</p>
        )}
      </Panel>
    </div>
  );
}


// The Agent tab moved to ./AtlasAgentTab in T4 part 2. It was two read-only
// lists here; it is now the home of the agent CRUD, schedules, tool-call log and
// run timeline absorbed out of the unlinked legacy tree, which is too much
// surface to keep in the tab switch.

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

/**
 * Research. The queue and the completed reports were already here; the
 * CONTROLS were not — `startResearch`, `pauseResearch` and `resumeResearch`
 * lost their only caller when `ResearchExplorer` was deleted with the legacy
 * tree, leaving research something Atlas could only decide to do on its own.
 * Paired with the autonomous-learning switch now back in Settings → Budget,
 * the user can both start a run and stop one.
 */
function ResearchTab() {
  const { topics, startResearch, pauseResearch, resumeResearch } = useAtlasResearch();
  const [newTopic, setNewTopic] = useState('');
  const [starting, setStarting] = useState(false);
  const queue = (topics ?? []).filter((t) => ['queued', 'researching', 'processing'].includes(t.status));
  const paused = (topics ?? []).filter((t) => t.status === 'paused');
  const done = (topics ?? []).filter((t) => t.status === 'completed').slice(0, 6);

  const start = async () => {
    const topic = newTopic.trim();
    if (!topic) return;
    setStarting(true);
    // `startResearch` reports its own failure through a toast and resolves to
    // null; it does not reject. Clearing the field regardless would lose what
    // the user typed on a failed start, so it is only cleared on success.
    const created = await startResearch(topic);
    setStarting(false);
    if (created) setNewTopic('');
  };

  return (
    <div className="coregrid">
      <Panel icon={<BookOpen className="i16" />} title="Research queue">
        <div className="fx ac gap8" style={{ marginBottom: 12 }}>
          <input
            className="field f1"
            aria-label="Topic to research"
            placeholder="Ask Atlas to research something…"
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void start(); }}
          />
          <Button
            size="sm"
            variant="primary"
            icon={<Plus className="i14" />}
            loading={starting}
            disabled={!newTopic.trim()}
            onClick={() => void start()}
          >
            Research
          </Button>
        </div>

        {queue.map((t) => {
          const running = t.status !== 'queued';
          return (
            <Row
              key={t.id}
              lead={running ? <Loader className="i16" style={{ color: 'var(--acc)' }} /> : <Clock className="i16" style={{ color: 'var(--ink3)' }} />}
              title={t.topic}
              meta={`${t.status} · ${(t.sources ?? []).length} sources`}
              trail={
                <Button
                  size="icon"
                  variant="ghost"
                  title="Pause"
                  aria-label={`Pause research on ${t.topic}`}
                  onClick={() => void pauseResearch(t.id)}
                >
                  <Pause className="i14" />
                </Button>
              }
            />
          );
        })}
        {paused.map((t) => (
          <Row
            key={t.id}
            lead={<Pause className="i16" style={{ color: 'var(--ink3)' }} />}
            title={t.topic}
            meta={`paused · ${(t.sources ?? []).length} sources`}
            trail={
              <Button
                size="icon"
                variant="ghost"
                title="Resume"
                aria-label={`Resume research on ${t.topic}`}
                onClick={() => void resumeResearch(t.id)}
              >
                <Play className="i14" />
              </Button>
            }
          />
        ))}
        {queue.length === 0 && paused.length === 0 && <Empty body="Queue is clear." />}
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


/**
 * The agent editor, the tool-call log, the run timeline and the approval queue.
 *
 * LAZY, AND ONLY IN ADMIN. Hiding the Agent tab from the consumer tab strip
 * (AtlasCoreScreen's `visibleTabs`) hides the UI; it does not remove the code —
 * a static import here pulled AtlasAgentTab into the AtlasCoreScreen chunk
 * regardless, and `system_prompt`, "No agents yet" and "Run timeline" all
 * grepped out of a consumer build. `EDITION` is substituted by Vite as a string
 * literal, so Rollup folds this ternary and the `import()` in the dead branch
 * emits no chunk at all — the same trick as ADMIN_LOADERS in surfaces.ts.
 */
const isAdmin = EDITION === 'admin';
const AgentTab = isAdmin
  ? lazy(() => import('./AtlasAgentTab').then((m) => ({ default: m.AgentTab })))
  : null;
const LiveTab = isAdmin
  ? lazy(() => import('./AtlasCoreAdminTabs').then((m) => ({ default: m.LiveTab })))
  : null;
const LearningTab = isAdmin
  ? lazy(() => import('./AtlasCoreAdminTabs').then((m) => ({ default: m.LearningTab })))
  : null;

/** `null` on a consumer build, and the tab that would render it is not on the
 *  strip either — the screen's `visibleTabs()` and this table are the two
 *  halves of one decision, and neither on its own removes any code. */
const adminOnly = (Tab: React.LazyExoticComponent<() => JSX.Element> | null) =>
  (Tab ? <Suspense fallback={<Empty body="Loading…" />}><Tab /></Suspense> : null);

export const AtlasCoreTabs = memo(({ tab }: { tab: string }) => {
  switch (tab) {
    case 'search': return <SearchTab />;
    case 'live': return adminOnly(LiveTab);
    case 'agent': return adminOnly(AgentTab);
    case 'knowledge': return <KnowledgeTab />;
    case 'research': return <ResearchTab />;
    case 'learning': return adminOnly(LearningTab);
    case 'memory': return <MemoryTab />;
    default: return null;
  }
});
AtlasCoreTabs.displayName = 'AtlasCoreTabs';
