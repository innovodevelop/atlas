/**
 * Atlas Browser — the `/browser` route.
 * Design: `Atlas Browser.dc.html` (design_handoff_atlas_suite_v2).
 *
 * ── THE ONE THING TO KNOW ───────────────────────────────────────────────────
 * There is no browser engine in Atlas. No web view, no fetch of remote HTML,
 * no reader-mode extractor — and the Tauri CSP (`default-src 'self'`) would
 * block a framed remote page anyway. This surface is therefore MOCK-BACKED, on
 * purpose and out loud: every tab and paragraph comes from
 * `@/lib/mocks/browser`, and the page wears a permanent "Sample data"
 * treatment in three places (the strip under the band, a stamp in the tab
 * rail, a stamp on the article) so nobody can read this as pages Atlas loaded.
 *
 * The two things an engine would do are refused rather than faked:
 *   - `open()` never succeeds. Typing an address renders a designed refusal
 *     naming the address — not the prototype's 1.2s shimmer back onto the same
 *     article.
 *   - `ask()` answers only the written prompts under the omnibox. Free text
 *     gets a refusal saying there is no model behind this surface.
 * Find-on-page is the one genuinely real feature: it searches the actual
 * strings on screen and the count can be trusted.
 *
 * ── SHELL ───────────────────────────────────────────────────────────────────
 * The design is a horizontal shell — rail, page, Atlas panel — with a floating
 * omnibox low on screen. Below its minimum width the shell scrolls sideways
 * inside `.br-viewport` rather than crushing three columns.
 *
 * ── CHROME ──────────────────────────────────────────────────────────────────
 * Band header; back-navigation through the headline plus Esc (AtlasDashboard's
 * `.greetB.returnable` + `.retbar` pattern). No dock is rendered here — the
 * wiring pass owns that — and no sphere is mounted; the omnibox mode chip
 * carries the cycle the design gives the sphere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, ArrowUp, BookOpen, ChevronDown, Clock, Compass, CornerUpLeft,
  FileText, Info, Link2, List, ListChecks, PanelRight, Quote, Scale, Search,
  Sparkles, Star, TriangleAlert, X, type LucideIcon,
} from 'lucide-react';
import { Button, Empty } from '@/components/atlas-ui/primitives';
import {
  ENGINE, IS_MOCK, MODE_COPY, askSuggestionsFor, blockedOn, findMatches,
  goSuggestionsFor, openTab, useAtlasBrowserMock as useBrowser,
  type BrowserMode, type PointKind,
} from '@/lib/mocks/browser';
import { BrowserTabRail } from '@/components/atlas-ui/browser/BrowserTabRail';
import { BrowserReader } from '@/components/atlas-ui/browser/BrowserReader';
import '@/styles/surfaces/browser.css';

/** The wiring pass reads this; it does not have to read the file. */
export const surface = {
  path: '/browser',
  label: 'Browser',
  icon: 'Compass',
  // `menu`, not `dock`: a surface with no engine behind it has not earned a
  // primary slot. It becomes a dock candidate the day a real adapter lands.
  entry: 'menu',
  mock: true,
};

/** Exact lucide exports the mock names for suggestion rows. */
const SUGGEST_ICONS: Record<string, LucideIcon> = {
  List, Scale, Quote, Clock, Star, Search, Compass, Sparkles,
};

/** Icon + tint per observation kind, shared by points and ask rows. */
const KIND_ICON: Record<PointKind, LucideIcon> = {
  claim: ListChecks, quote: Quote, link: Link2, warn: TriangleAlert,
};

/** What the user is being told after a submit that could not be honoured. */
type Refusal =
  | { kind: 'no-engine'; url: string; reason: string }
  | { kind: 'unanswerable'; question: string; reason: string };

const MODE_ORDER: BrowserMode[] = ['go', 'ask', 'find'];
const MODE_ICON: Record<BrowserMode, LucideIcon> = {
  go: Compass, ask: Sparkles, find: Search,
};
const SUBMIT_ICON: Record<BrowserMode, LucideIcon> = {
  go: ArrowRight, ask: ArrowUp, find: ChevronDown,
};

/** True when a keystroke belongs to whatever the user is typing into. */
const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
};

const AtlasBrowser = () => {
  const navigate = useNavigate();
  const live = useBrowser();

  const [mode, setMode] = useState<BrowserMode>('ask');
  const [typed, setTyped] = useState('');
  const [cursor, setCursor] = useState(0);
  const [reader, setReader] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const tab = openTab(live.session);
  const tabs = live.session?.tabs ?? [];

  // Find is live while the mode is `find`; leaving the mode clears the marks.
  const query = mode === 'find' ? typed.trim() : '';
  const matches = useMemo(() => findMatches(tab?.page ?? null, query), [tab, query]);
  useEffect(() => { setCursor(0); }, [query, tab?.id]);

  const focusOmni = useCallback((m: BrowserMode) => {
    setMode(m);
    setTyped('');
    setSuggestOpen(true);
    inputRef.current?.focus();
  }, []);

  const cycleMode = useCallback(() => {
    setMode((m) => MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length]);
    setTyped('');
    setSuggestOpen(true);
  }, []);

  const goUp = useCallback(() => navigate('/'), [navigate]);

  /** Submit is per-mode: refuse (go), answer or refuse (ask), step (find). */
  const submit = useCallback((suggestionId?: string) => {
    if (mode === 'find') {
      if (matches.length) setCursor((c) => (c + 1) % matches.length);
      return;
    }
    setSuggestOpen(false);
    // `in`-narrowing rather than `!res.ok`: the app tsconfig is not strict,
    // and boolean-discriminant narrowing silently fails there.
    if (mode === 'go') {
      const res = live.open(typed);
      if ('kind' in res && res.kind === 'no-engine') {
        setRefusal({ kind: 'no-engine', url: res.url, reason: res.reason });
        setTyped('');
      }
      return;
    }
    const res = live.ask(typed, suggestionId);
    if (res.ok) {
      setRefusal(null);
      setSideOpen(true); // the answer lands in the panel — make sure it is on screen
      setTyped('');
    } else if ('kind' in res && res.kind === 'unanswerable') {
      setRefusal({ kind: 'unanswerable', question: res.question, reason: res.reason });
      setTyped('');
    }
  }, [mode, matches.length, typed, live]);

  // ⌘L / ⌘K / ⌘F pick a mode; Esc peels one layer (blur → popover → dashboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === 'l' || k === 'k' || k === 'f') {
          e.preventDefault();
          focusOmni(k === 'l' ? 'go' : k === 'k' ? 'ask' : 'find');
        }
        return;
      }
      if (e.key !== 'Escape' || meta || e.altKey) return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      if (suggestOpen) { setSuggestOpen(false); return; }
      goUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusOmni, suggestOpen, goUp]);

  const copy = MODE_COPY[mode];
  const ModeIcon = MODE_ICON[mode];
  const SubmitIcon = SUBMIT_ICON[mode];
  const askRows = askSuggestionsFor(tab);
  const goRows = useMemo(() => goSuggestionsFor(typed), [typed]);

  const headline = useMemo(() => ({
    lead: 'Browse with ', accent: 'Atlas.',
    subline: tabs.length
      ? `${tabs.length} sample ${tabs.length === 1 ? 'tab' : 'tabs'} kept open. Nothing here was loaded — Atlas has no browser engine yet.`
      : 'Every tab is closed. This is the surface on day one: an omnibox, and nothing invented behind it.',
    metaBig: String(tabs.length),
    metaSmall: tabs.length === 1 ? 'open tab' : 'open tabs',
  }), [tabs.length]);

  return (
    <div className="page br-page" data-screen-label="Atlas — Browser">
      <div className="br-wash" aria-hidden>
        <div className="br-wash-a" />
        <div className="br-wash-b" />
      </div>
      <div className="grain" aria-hidden />

      {/* Band header. The headline is the back control — there is no header
          link, by the same rule the dashboard follows. */}
      <section className="bandB">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="greetB returnable" onClick={goUp} title="Return to the dashboard">
            {headline.lead}<span className="accw">{headline.accent}</span>
          </h2>
          <p className="gsubB">{headline.subline}</p>
        </div>
        <div className="bandmetaB">
          <p className="bmvB tnum">{headline.metaBig}</p>
          <p className="bmlB">{headline.metaSmall}</p>
        </div>
      </section>

      <div className="br-chrome">
        <button className="retbar" onClick={goUp} aria-label="Return to the dashboard">
          <CornerUpLeft className="i16" />Tap the title or press Esc to return to the dashboard
        </button>

        {/* The sample-data treatment: the strip the other mock surfaces wear,
            plus the control that reaches the surface's own empty state. */}
        {live.isMock && (
          <div className="br-notice" role="note">
            <span className="br-notice-ico" aria-hidden>
              {tabs.length ? <Info className="i16" /> : <Sparkles className="i16" />}
            </span>
            <div className="br-notice-body">
              <p className="br-notice-title">
                {tabs.length ? 'Sample data — nothing here was loaded' : 'Empty state — day one'}
              </p>
              <p className="br-notice-text">
                {tabs.length
                  ? ENGINE.reason + ' Every tab and article is a fixed sample so the shell can be designed and reviewed; find-on-page is real, everything else refuses honestly.'
                  : 'This is what a real adapter returns before an engine reports in: no tabs, no shelves, no article. Every pane below is showing its true empty state.'}
              </p>
            </div>
            <div className="br-notice-act">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => (tabs.length ? live.closeAll() : live.restoreSample())}
              >
                {tabs.length ? 'Preview the empty state' : 'Restore the sample session'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* The shell. Below its minimum width it scrolls sideways — three live
          columns do not compress. */}
      <div className="br-viewport">
        <div className={`br-shell ${sideOpen ? 'br-shell-side' : ''}`}>
          <BrowserTabRail
            tabs={tabs}
            selectedTabId={live.session?.selectedTabId ?? null}
            kept={live.session?.kept ?? []}
            blocked={blockedOn(tab)}
            isMock={live.isMock}
            onSelect={live.selectTab}
            onClose={live.closeTab}
            onNewTab={() => focusOmni('go')}
          />

          <div className="br-main">
            {/* The design's floating toolbar, kept to the controls that are
                real: reader width and the Atlas panel. Back, reload and save
                all need an engine, and a dead button row is worse than none. */}
            <div className="br-tools">
              <Button
                size="icon"
                variant={reader ? 'ink' : 'text'}
                aria-pressed={reader}
                title="Reader view"
                aria-label="Reader view"
                onClick={() => setReader((r) => !r)}
              >
                <BookOpen className="i14" />
              </Button>
              <Button
                size="sm"
                variant={sideOpen ? 'primary' : 'text'}
                aria-pressed={sideOpen}
                title="Show what Atlas noticed on this page"
                onClick={() => setSideOpen((s) => !s)}
              >
                <PanelRight className="i14" />Atlas
              </Button>
            </div>
            <BrowserReader
              tab={tab}
              reader={reader}
              isMock={live.isMock}
              query={query}
              matches={matches}
              cursor={cursor}
            />
          </div>

          {sideOpen && (
            <aside className="br-side" aria-label="What Atlas noticed">
              <header className="br-side-head">
                <span className="br-side-dot" aria-hidden />
                <p className="br-side-title">On this page</p>
                {tab?.analysis && <span className="br-side-meta">read as you scrolled</span>}
              </header>

              {live.answers.map((a) => (
                <div className="br-answer" key={a.id}>
                  <div className="br-answer-head">
                    <p className="br-answer-q trunc">{a.question}</p>
                    <Button
                      size="icon"
                      variant="text"
                      aria-label="Dismiss this answer"
                      onClick={() => live.dismissAnswer(a.id)}
                    >
                      <X className="i12" />
                    </Button>
                  </div>
                  <p className="br-answer-body">{a.body}</p>
                  <p className="br-answer-basis"><FileText className="i12" />{a.basis}</p>
                </div>
              ))}

              {tab?.analysis ? (
                <>
                  <div className="br-sum">
                    <p>{tab.analysis.summary}</p>
                  </div>
                  {tab.analysis.points.map((p) => {
                    const Icon = KIND_ICON[p.kind];
                    return (
                      <div className="br-point" key={p.id} data-kind={p.kind}>
                        <span className="br-point-ico" aria-hidden><Icon className="i12" /></span>
                        <div style={{ minWidth: 0 }}>
                          <p className="br-point-title">{p.title}</p>
                          <p className="br-point-body">{p.body}</p>
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : tab?.page ? (
                <Empty
                  size="block"
                  status="stale"
                  icon={<Sparkles className="i20" />}
                  title="Not read yet"
                  body={`Atlas kept the copy of ${tab.host} but has not read it, so there is no summary and there are no observations — it will not invent them.`}
                />
              ) : (
                <Empty
                  size="block"
                  icon={<Sparkles className="i20" />}
                  title="Nothing to notice"
                  body="Open a tab with readable copy and what Atlas noticed about it appears here."
                />
              )}
            </aside>
          )}
        </div>
      </div>

      {/* The omnibox. Fixed low on screen like the design, above where the
          wiring pass's dock lives. Everything inert is pointer-transparent. */}
      <div className="br-omni-wrap">
        {refusal && (
          <div className="br-refuse" role="status">
            <span className="br-refuse-ico" aria-hidden><TriangleAlert className="i14" /></span>
            <div className="br-refuse-body">
              <p className="br-refuse-title">
                {refusal.kind === 'no-engine'
                  ? <>Could not open <span className="tnum">{refusal.url}</span></>
                  : <>Cannot answer “{refusal.question}”</>}
              </p>
              <p className="br-refuse-text">{refusal.reason}</p>
            </div>
            <Button size="icon" variant="text" aria-label="Dismiss" onClick={() => setRefusal(null)}>
              <X className="i12" />
            </Button>
          </div>
        )}

        {suggestOpen && (mode === 'ask' ? askRows.length > 0 : mode === 'go' ? goRows.length > 0 : matches.length > 0) && (
          <div className="br-suggest" role="listbox" aria-label={`${copy.label} suggestions`}>
            {mode === 'ask' && askRows.map((s) => {
              const Icon = SUGGEST_ICONS[s.icon] ?? Sparkles;
              return (
                <button
                  type="button" role="option" aria-selected={false}
                  className="br-suggest-row" key={s.id}
                  onClick={() => submit(s.id)}
                >
                  <span className="br-suggest-ico" data-kind={s.kind} aria-hidden><Icon className="i14" /></span>
                  <span className="br-suggest-label trunc">{s.label}</span>
                  <span className="br-suggest-meta">{s.meta}</span>
                </button>
              );
            })}
            {mode === 'go' && goRows.map((s) => {
              const Icon = SUGGEST_ICONS[s.icon] ?? Compass;
              return (
                <button
                  type="button" role="option" aria-selected={false}
                  className="br-suggest-row" key={s.id}
                  onClick={() => { setTyped(s.label); setSuggestOpen(false); inputRef.current?.focus(); }}
                >
                  <span className="br-suggest-ico" aria-hidden><Icon className="i14" /></span>
                  <span className="br-suggest-label trunc">{s.label}</span>
                  <span className="br-suggest-meta">{s.meta}</span>
                </button>
              );
            })}
            {mode === 'find' && matches.slice(0, 6).map((m, i) => (
              <button
                type="button" role="option" aria-selected={i === cursor}
                className="br-suggest-row" key={`${m.block}-${m.offset}`}
                onClick={() => setCursor(i)}
              >
                <span className="br-suggest-ico" aria-hidden><Search className="i14" /></span>
                <span className="br-suggest-label trunc">…{m.context}…</span>
                <span className="br-suggest-meta tnum">{i + 1} of {matches.length}</span>
              </button>
            ))}
          </div>
        )}

        <div className="br-omni" data-mode={mode}>
          <button
            type="button"
            className="br-mode"
            onClick={cycleMode}
            title="Switch between going somewhere, asking Atlas, and finding on the page"
          >
            <ModeIcon className="i14" />{copy.label}
          </button>
          {mode === 'ask' && tab && (
            <span className="br-scope" title={tab.title}>
              <FileText className="i12" /><span className="trunc">{tab.title}</span>
            </span>
          )}
          <input
            ref={inputRef}
            className="br-omni-in"
            placeholder={copy.placeholder}
            aria-label={copy.placeholder}
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onFocus={() => setSuggestOpen(true)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          />
          <span className="br-omni-meta tnum">
            {mode === 'find'
              ? (matches.length ? `${cursor + 1} of ${matches.length}` : '0 of 0')
              : copy.shortcut}
          </span>
          <button type="button" className="br-go" title={copy.submitTitle} onClick={() => submit()}>
            {copy.submit}
            <span className="br-go-ico" aria-hidden><SubmitIcon className="i14" /></span>
          </button>
        </div>
        <p className="br-omni-hint">
          Click the chip to switch modes · ⌘L to go, ⌘K to ask, ⌘F to find
        </p>
      </div>
    </div>
  );
};

export default AtlasBrowser;
