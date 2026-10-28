/**
 * The Beta widget catalog and widget sheet — `/widgets` and `/widget-sheet`
 * while the beta_ui flag is on (Beta redesign phase 2,
 * `Atlas Widgets Beta.dc.html`). One page, two tabs: the route picks the tab,
 * and the tabs move between the routes.
 *
 * Catalog: every widget Home can show (`WIDGETS` in betaHome.ts), grouped,
 * at every size it offers, on paper and ink, drawn by Home's own faces from
 * the same live hooks — so a number here is the number on Home. The design's
 * size, data and design switches filter it; "Empty" forces every face into
 * its empty state, whose one action is real (a screen, or a question to
 * Atlas). Widgets with no source yet are marked Soon.
 *
 * States (the sheet): the six core widgets in loading, default, attention,
 * empty and offline. Default is the live face. Attention and offline read
 * what they can from live data (the overdue task, the meeting about to
 * start, the last mail sync); when the attention rule does not hold right
 * now the row says so in a muted tone instead of inventing an alert. Each
 * row says what the widget is reading — a missing provider key matters,
 * because the Mac app then answers with its built-in sample.
 *
 * The sphere in the band is the talk entry point; Esc and the title go Home.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { HomeWidget } from '@/components/atlas/home/widgets';
import { WidgetFace, type FacePreview, type FacePreviewCopy } from '@/components/atlas/home/WidgetFace';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { useSourceStatus } from '@/components/atlas-ui/widgetSheet/useSourceStatus';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { WIDGETS, WIDGET_BY_ID, type WidgetGroup, type WidgetSize } from '@/lib/betaHome';
import {
  ATTENTION_IDLE, ATTENTION_RULE, CORE_WIDGETS, DESIGN_CHOICES, MODE_CHOICES, OFFLINE_COPY, SHEET_STATES, SIZE_CHOICES,
  SOURCE_LABEL, STATE_RULES, catalogPlan, designLabel, emptyCopy, gridColumnsFor, groupChips, groupOrder,
  isCoreWidget, sizeDim, sizeLabel, sourceVerdict,
  type CatalogCell, type CatalogMode, type DesignChoice, type EmptyAction, type SizeChoice,
} from '@/lib/betaWidgetCatalog';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isRoutable } from '@/surfaces';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/widgetCatalog.css';

type Tab = 'catalog' | 'states';
const TAB_PATH: Record<Tab, string> = { catalog: '/widgets', states: '/widget-sheet' };

/** The design's column count, from the window width. */
function useGridColumns(): number {
  const [cols, setCols] = useState(() => gridColumnsFor(window.innerWidth));
  useEffect(() => {
    const onResize = () => setCols(gridColumnsFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return cols;
}

/**
 * True once the element has come within a screen of the viewport, and then
 * for good. The catalog draws close to a hundred faces, each with its own
 * hooks; mounting them as they scroll into reach keeps the first paint to the
 * dozen that are visible, and never unmounting avoids refetching on the way
 * back up.
 */
function useSeen(): [(el: HTMLElement | null) => void, boolean] {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (seen || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);
  return [setEl, seen];
}

interface FaceSlotProps {
  id: string;
  size: WidgetSize;
  tone?: 'paper' | 'ink';
  delay: number;
  preview?: FacePreview;
  copy: FacePreviewCopy;
  /** From the container's `useSeen`: mount the live adapter, or hold its loading skeleton. */
  seen: boolean;
}

/** The live face once it is near the viewport; until then, that face's own loading skeleton (no hooks). */
function LazyFace({ id, size, tone, delay, preview, copy, seen }: FaceSlotProps) {
  if (seen) return <HomeWidget id={id} size={size} delay={delay} forceTone={tone} preview={preview} previewCopy={copy} />;
  return <WidgetFace label={WIDGET_BY_ID.get(id)?.label ?? id} size={size} tone={tone} preview="loading" />;
}

const BetaWidgetCatalog = () => {
  const navigate = useBetaNavigate();
  const { pathname } = useLocation();
  const tab: Tab = pathname.startsWith('/widget-sheet') ? 'states' : 'catalog';
  const gridCols = useGridColumns();
  const sphereRef = useRef<HTMLDivElement | null>(null);

  const [size, setSize] = useState<SizeChoice>('all');
  const [design, setDesign] = useState<DesignChoice>('both');
  const [mode, setMode] = useState<CatalogMode>('live');
  const [group, setGroup] = useState<WidgetGroup | 'all'>('all');

  // The band sphere is this screen's talk entry point.
  useEffect(() => { setTalkAnchor(sphereRef.current); return () => setTalkAnchor(null); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!isTyping(e.target) && e.key === 'Escape') navigate('/'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  /** An empty-state action, made real: a screen this build ships, or a question to Atlas. */
  const resolve = useCallback((a: EmptyAction | undefined) => {
    if (!a) return undefined;
    if ('ask' in a) return { label: a.label, onClick: () => openTalk(a.ask) };
    const route = a.route;
    return isRoutable(route) ? { label: a.label, onClick: () => navigate(route) } : undefined;
  }, [navigate]);

  /** What a forced state says that the widget cannot read for itself. */
  const copyFor = useCallback((id: string): FacePreviewCopy => {
    const e = emptyCopy(id);
    return {
      empty: { title: e.title, hint: e.hint, action: resolve(e.action) },
      attention: isCoreWidget(id) ? { text: ATTENTION_IDLE[id], tone: 'muted', icon: 'info' } : undefined,
      offline: isCoreWidget(id) ? OFFLINE_COPY[id] : undefined,
    };
  }, [resolve]);

  const plan = useMemo(() => catalogPlan({ group, size, design, gridCols }), [group, size, design, gridCols]);
  const shown = plan.reduce((n, s) => n + s.widgets.length, 0);
  const groups = groupOrder();
  const unwired = WIDGETS.filter((w) => w.source === 'unwired').length;

  const subline = tab === 'states'
    ? 'The six core Home widgets across their five states. Attention adds one row; nothing else on the card moves.'
    : `${WIDGETS.length} widgets in ${groups.length} groups, each at every size it offers, on paper or ink, drawn from the same live data as Home. ${unwired} are not wired to a source yet and are marked Soon.`;

  return (
    <div className="b-wc nosb" data-screen-label={tab === 'states' ? 'Beta — Widget sheet' : 'Beta — Widget catalog'}>
      <header className="b-band b-band--short b-wc-band">
        <div className="b-band-sphere" ref={sphereRef}><VeilSphere size="short" bg="#f1eeea" /></div>
        <div className="b-wc-band-text">
          <span className="b-eyebrow">Home · Widgets</span>
          <button type="button" className="b-wc-title" title="Back to Home · Esc" onClick={() => navigate('/')}>Widgets</button>
          <p className="b-wc-sub">{subline}</p>
        </div>
        {tab === 'catalog' ? (
          <div className="b-wc-count" aria-live="polite">
            <b>{shown}</b>
            <span>shown · {sizeLabel(size)} · {designLabel(design)}</span>
          </div>
        ) : null}
      </header>

      <div className="b-wc-bar">
        <div className="b-wc-tabs" role="tablist" aria-label="Widgets view">
          {(['catalog', 'states'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={`b-wc-tab${tab === k ? ' on' : ''}`}
              onClick={() => { if (tab !== k) navigate(TAB_PATH[k], { replace: true }); }}
            >
              <AtlasIcon name={k === 'catalog' ? 'grid view' : 'loading'} size={16} weight={1.6} />
              {k === 'catalog' ? 'Catalog' : 'States'}
            </button>
          ))}
        </div>
        {tab === 'catalog' ? (
          <>
            <span className="b-wc-spacer" />
            <div className="b-wc-seg" role="group" aria-label="Size">
              {SIZE_CHOICES.map((z) => (
                <button key={z.id} type="button" aria-pressed={size === z.id} className={size === z.id ? 'on' : ''} onClick={() => setSize(z.id)}>
                  {z.label}{z.dim ? <span className="b-wc-dim">{z.dim}</span> : null}
                </button>
              ))}
            </div>
            <div className="b-wc-seg" role="group" aria-label="Data">
              {MODE_CHOICES.map((m) => (
                <button key={m.id} type="button" aria-pressed={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>{m.label}</button>
              ))}
            </div>
            <div className="b-wc-seg" role="group" aria-label="Design">
              {DESIGN_CHOICES.map((d) => (
                <button key={d.id} type="button" aria-pressed={design === d.id} className={design === d.id ? 'on' : ''} onClick={() => setDesign(d.id)}>
                  <span className={`b-wc-swatch b-wc-swatch--${d.id}`} aria-hidden />{d.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {tab === 'catalog' ? (
        <CatalogView
          plan={plan}
          gridCols={gridCols}
          group={group}
          onGroup={setGroup}
          size={size}
          onShowAll={() => { setSize('all'); setGroup('all'); }}
          preview={mode === 'empty' ? 'empty' : undefined}
          copyFor={copyFor}
        />
      ) : (
        <SheetView copyFor={copyFor} />
      )}
    </div>
  );
};

interface CatalogViewProps {
  plan: ReturnType<typeof catalogPlan>;
  gridCols: number;
  group: WidgetGroup | 'all';
  onGroup: (g: WidgetGroup | 'all') => void;
  size: SizeChoice;
  onShowAll: () => void;
  preview?: FacePreview;
  copyFor: (id: string) => FacePreviewCopy;
}

function CatalogView({ plan, gridCols, group, onGroup, size, onShowAll, preview, copyFor }: CatalogViewProps) {
  const chips = useMemo(() => groupChips(), []);
  return (
    <>
      <div className="b-wc-chips" role="group" aria-label="Groups">
        {chips.map((c) => (
          <button key={c.id} type="button" aria-pressed={group === c.id} className={`b-wc-chip${group === c.id ? ' on' : ''}`} onClick={() => onGroup(c.id)}>
            {c.label}<span className="b-wc-dim">{c.n}</span>
          </button>
        ))}
      </div>

      {plan.map((sec) => (
        <section key={sec.group} className="b-wc-group" aria-label={sec.group}>
          <header className="b-wc-group-head">
            <h2 className="b-wc-group-name">{sec.group}</h2>
            <span className="b-wc-group-n">{sec.widgets.length} {sec.widgets.length === 1 ? 'widget' : 'widgets'}</span>
            <ul className="b-wc-index">
              {sec.widgets.map((w) => (
                <li key={w.id} title={w.meta}>{w.label}<span className={`b-wc-src b-wc-src--${w.source}`}>{SOURCE_LABEL[w.source]}</span></li>
              ))}
            </ul>
          </header>
          <div className="b-wc-grid" style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}>
            {sec.cells.map((cell, i) => <CatalogCellView key={cell.key} cell={cell} index={i} preview={preview} copy={copyFor(cell.id)} />)}
          </div>
        </section>
      ))}

      {plan.length === 0 ? (
        <div className="b-empty b-wc-none">
          <p><b>Nothing at this size here.</b></p>
          <p>{size === 'all' ? 'No widget carries this group.' : `No widget in ${group === 'all' ? 'the catalog' : group} comes at ${size}.`}</p>
          <button type="button" className="b-btn b-btn--primary" onClick={onShowAll}>Show every size</button>
        </div>
      ) : null}
    </>
  );
}

function CatalogCellView({ cell, index, preview, copy }: { cell: CatalogCell; index: number; preview?: FacePreview; copy: FacePreviewCopy }) {
  const [ref, seen] = useSeen();
  const def = WIDGET_BY_ID.get(cell.id);
  const tone = cell.tone === 'ink' ? 'Ink' : 'Paper';
  return (
    <div
      ref={ref}
      className="b-wc-cell"
      style={{ gridColumn: `span ${cell.cols}`, gridRow: `span ${cell.rows}` }}
      data-screen-label={`${def?.label ?? cell.id} ${cell.size} ${tone}`}
    >
      <LazyFace id={cell.id} size={cell.size} tone={cell.tone} delay={(index % 8) * 40} preview={preview} copy={copy} seen={seen} />
      <span className="b-wc-cap">
        <b>{cell.size}</b>{sizeDim(cell.size)} · {tone}
        {def?.source === 'unwired' ? <span className="b-wc-src b-wc-src--unwired">Soon</span> : null}
      </span>
    </div>
  );
}

function SheetView({ copyFor }: { copyFor: (id: string) => FacePreviewCopy }) {
  const status = useSourceStatus();
  const mail = useMailIntelligence();
  const mailConnected = mail.isLoading ? null : mail.isConnected;
  return (
    <>
      <section className="b-wc-rules" aria-label="State rules">
        {STATE_RULES.map((r) => <div key={r.t} className="b-wc-rule"><b>{r.t}</b><span>{r.d}</span></div>)}
      </section>
      {CORE_WIDGETS.map((id) => {
        const def = WIDGET_BY_ID.get(id);
        const src = sourceVerdict(id, status, mailConnected);
        const copy = copyFor(id);
        return (
          <section key={id} className="b-wc-row" aria-label={`${def?.label ?? id} states`} data-screen-label={`${def?.label ?? id} states`}>
            <div className="b-wc-row-head">
              <p className="b-wc-row-name">{def?.label ?? id}</p>
              <p className="b-wc-row-desc">{ATTENTION_RULE[id]}</p>
              <span className={`b-status b-status--${src.tone} b-wc-row-src`} title={src.title}><i /><span>{src.text}</span></span>
            </div>
            <div className="b-wc-states">
              {SHEET_STATES.map((st, i) => <StateCell key={st.id} id={id} state={st} delay={i * 50} copy={copy} />)}
            </div>
          </section>
        );
      })}
    </>
  );
}

function StateCell({ id, state, delay, copy }: { id: string; state: (typeof SHEET_STATES)[number]; delay: number; copy: FacePreviewCopy }) {
  const [ref, seen] = useSeen();
  return (
    <figure className="b-wc-state">
      <figcaption className={`b-wc-tag b-wc-tag--${state.id}`}><i aria-hidden />{state.label}</figcaption>
      <div className="b-wc-state-face" ref={ref}>
        <LazyFace id={id} size="L" delay={delay} preview={state.preview} copy={copy} seen={seen} />
      </div>
    </figure>
  );
}

export default BetaWidgetCatalog;
