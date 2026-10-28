/**
 * The Beta Browser — `/browser` while the beta_ui flag is on (Beta redesign
 * phase 5, `Atlas Browser Beta.dc.html`).
 *
 * Hero bar (the header sphere as the talk entry point, one honest line, the
 * tab count, Home), the sample strip, the tab rail, the page with its address
 * and Reader / Atlas toggles, "On this page", and the ink omnibox with its
 * three modes: Go, Ask, Find.
 *
 * The session is the one the Workshop page drives — `useAtlasBrowserMock()`
 * from `src/lib/mocks/browser.ts` — because Atlas has no browser engine: no
 * web view, no fetch of remote pages, and a CSP that would not frame one. So
 * the tabs and articles are that module's labelled sample, stamped where the
 * design stamps them, and every control does the real thing it can:
 *   - Find searches the actual strings on screen (`findMatches`), marks every
 *     hit and steps through them; the count can be trusted.
 *   - Go names the address it cannot load, and hands a real address to the
 *     user's own browser through the opener plugin instead of pretending.
 *   - Ask answers the prompts written for the open sample page, and nothing
 *     else; anything else is refused by name, with a way to ask Atlas itself
 *     in the Talk panel (which does not see this page).
 *   - Tabs select and close in the shared session; "Preview the empty state"
 *     reaches the screen's true day-one state, and back.
 * The day a real adapter returns `isMock: false`, the stamps go on their own.
 *
 * Keys: ⌘L go · ⌘K ask · ⌘F find · Enter submit (Shift+Enter: previous
 * match) · Esc leaves the omnibox, then goes Home.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  askSuggestionsFor, findMatches, goSuggestionsFor, openTab,
  useAtlasBrowserMock as useBrowser, type BrowserMode, type BrowserPage,
} from '@/lib/mocks/browser';
import {
  MODE_COPY, askRefusal, findCountLabel, goRefusal, heroLine, modeForShortcut,
  nextMode, noticeLine, segmentsFor, stepCursor, tabCountLabel, type BrowserRefusal,
} from '@/lib/betaBrowser';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import { useReducedMotion } from '@/components/atlas-ui/browser/useReducedMotion';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import type { IconName } from '@/components/atlas/icons';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/browser.css';

const MODE_ICON: Record<BrowserMode, IconName> = { go: 'browser', ask: 'sparkle', find: 'search' };
const SUBMIT_ICON: Record<BrowserMode, IconName> = { go: 'chevron right', ask: 'chevron up', find: 'chevron down' };

/** Below this the rail gives way to the tab strip and the panel lies over the page (beta/browser.css). */
const NARROW = 1100;

const BetaBrowser = () => {
  const navigate = useBetaNavigate();
  const live = useBrowser();
  const reduced = useReducedMotion();

  const [mode, setMode] = useState<BrowserMode>('ask');
  const [typed, setTyped] = useState('');
  const [cursor, setCursor] = useState(0);
  const [reader, setReader] = useState(false);
  const [side, setSide] = useState(() => typeof window === 'undefined' || window.innerWidth >= NARROW);
  // Open while the omnibox has focus, closed by a submit until the next keystroke.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [refusal, setRefusal] = useState<BrowserRefusal | null>(null);
  // Which tab each answer was asked on, so an answer about one article never
  // sits beside another. The answers themselves live in the shared session.
  const [answerTab, setAnswerTab] = useState<Record<string, string>>({});
  const [sphereEl, setSphereEl] = useState<HTMLDivElement | null>(null);
  const omniRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLElement>(null);

  const tabs = live.session?.tabs ?? [];
  const kept = live.session?.kept ?? [];
  const tab = openTab(live.session);
  const page = tab?.page ?? null;

  // The hero sphere is this screen's talk entry point.
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);

  /* ── Find ─────────────────────────────────────────────────────────────── */

  const query = mode === 'find' ? typed.trim() : '';
  const matches = useMemo(() => findMatches(page, query), [page, query]);
  const cur = matches.length ? Math.min(cursor, matches.length - 1) : -1;
  useEffect(() => { setCursor(0); }, [query, tab?.id]);

  // Bring the current match to the middle of the page pane — instantly for
  // anyone who asked for reduced motion.
  useEffect(() => {
    const pane = pageRef.current;
    const el = pane?.querySelector<HTMLElement>('[data-hit="cur"]');
    if (!pane || !el) return;
    pane.scrollTo({ top: Math.max(0, el.offsetTop - pane.clientHeight / 2), behavior: reduced ? 'auto' : 'smooth' });
  }, [cur, query, tab?.id, reduced]);

  const mark = useCallback((text: string, block: number): ReactNode => {
    if (!query) return text;
    return segmentsFor(text, block, matches, query.length).map((s, i) => (s.hit === null
      ? <Fragment key={i}>{s.text}</Fragment>
      : <mark key={i} className={`b-br-hit${s.hit === cur ? ' on' : ''}`} data-hit={s.hit === cur ? 'cur' : undefined}>{s.text}</mark>));
  }, [query, matches, cur]);

  /* ── The omnibox ──────────────────────────────────────────────────────── */

  const focusOmni = useCallback((m: BrowserMode, value = '') => {
    setMode(m);
    setTyped(value);
    setCursor(0);
    setSuggestOpen(true);
    const input = omniRef.current;
    if (!input) return;
    input.focus();
    // Select once React has rendered the new value, so typing replaces it.
    if (value) window.setTimeout(() => input.select(), 0);
  }, []);

  const cycleMode = useCallback(() => focusOmni(nextMode(mode)), [focusOmni, mode]);

  const askRows = useMemo(() => askSuggestionsFor(tab), [tab]);
  const goRows = useMemo(() => goSuggestionsFor(typed), [typed]);

  /** Submit is per mode: step (find), refuse or hand over (go), answer or refuse (ask). */
  const submit = useCallback((text: string = typed, promptId?: string, dir: 1 | -1 = 1) => {
    if (mode === 'find') {
      setCursor((c) => stepCursor(c, matches.length, dir));
      return;
    }
    const t = text.trim();
    if (!t && !promptId) return;
    setSuggestOpen(false);
    if (mode === 'go') {
      const res = live.open(t);
      // A real adapter opens a tab; this session never can, and says so.
      if ('tabId' in res) { live.selectTab(res.tabId); setTyped(''); return; }
      setRefusal(goRefusal(t, 'kind' in res && res.kind === 'no-engine' ? res.url : t));
      setSide(true);
      setTyped('');
      return;
    }
    // Ask: only this page's written prompts have answers. Matching here, not
    // in the session's free-text lookup, keeps another tab's prompt from
    // answering for this one.
    const prompt = askRows.find((s) => s.id === promptId || s.label.toLowerCase() === t.toLowerCase());
    if (!tab || !prompt) {
      setRefusal(askRefusal(t, !!tab));
    } else {
      const res = live.ask(prompt.label, prompt.id);
      if ('answer' in res) {
        const tabId = tab.id;
        setAnswerTab((m) => ({ ...m, [res.answer.id]: tabId }));
        setRefusal(null);
      }
    }
    setSide(true);
    setTyped('');
  }, [typed, mode, matches.length, live, askRows, tab]);

  const showSuggest = suggestOpen && (mode === 'ask' ? !typed.trim() && askRows.length > 0 : mode === 'go' ? goRows.length > 0 : false);
  const canSubmit = mode === 'find' ? matches.length > 1 : typed.trim().length > 0;

  // ⌘L / ⌘K / ⌘F pick a mode; Esc leaves the omnibox first, then goes Home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const m = modeForShortcut(e.key);
        if (m) { e.preventDefault(); focusOmni(m); }
        return;
      }
      if (e.key !== 'Escape' || e.altKey) return;
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); return; }
      navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusOmni, navigate]);

  /* ── Tabs ─────────────────────────────────────────────────────────────── */

  const selectTab = useCallback((id: string) => { live.selectTab(id); setRefusal(null); setCursor(0); }, [live]);
  const closeTab = useCallback((id: string) => { live.closeTab(id); setRefusal(null); }, [live]);
  const toggleEmpty = useCallback(() => {
    if (tabs.length) live.closeAll(); else live.restoreSample();
    setRefusal(null);
    setAnswerTab({});
  }, [tabs.length, live]);

  const answers = live.answers.filter((a) => !!tab && answerTab[a.id] === tab.id);
  const copy = MODE_COPY[mode];

  return (
    <div className="b-br" data-screen-label="Beta — Browser">
      <header className="b-br-hero">
        <div className="b-br-bar">
          <div className="b-br-sphere" ref={setSphereEl}>
            <VeilSphere size="mini" bg="#fffdfa" />
            <button type="button" className="b-br-talk" title="Talk to Atlas · ⌥ Space" aria-label="Talk to Atlas" onClick={() => openTalk()} />
          </div>
          <span className="b-br-sub">{heroLine(tabs.length, live.isMock)}</span>
          <span className="b-br-count" aria-label={`${tabs.length} ${tabCountLabel(tabs.length)}`}>
            <b>{tabs.length}</b><span className="b-br-count-l">{tabCountLabel(tabs.length)}</span>
          </span>
        </div>
        <button type="button" className="b-br-home" title="Back · Esc" onClick={() => navigate('/')}>← Home</button>
      </header>

      {live.isMock ? (
        <div className="b-br-note" role="note">
          <span className="b-br-stamp">Sample</span>
          <p title={noticeLine(tabs.length)}>{noticeLine(tabs.length)}</p>
          <button type="button" className="b-br-note-btn" onClick={toggleEmpty}>
            {tabs.length ? 'Preview the empty state' : 'Restore the sample session'}
          </button>
        </div>
      ) : null}

      <nav className="b-br-strip nosb" aria-label="Open tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`b-br-stab${t.id === tab?.id ? ' on' : ''}`}>
            <button type="button" className="b-br-stab-hit" aria-current={t.id === tab?.id ? 'page' : undefined} title={t.url} onClick={() => selectTab(t.id)}>
              <span className="b-br-fav" style={{ background: t.mark }} aria-hidden>{t.initial}</span>
              <span>{t.title}</span>
            </button>
            <button type="button" className="b-br-x" aria-label={`Close ${t.title}`} title="Close tab" onClick={() => closeTab(t.id)}>
              <AtlasIcon name="close" size={13} weight={2} />
            </button>
          </div>
        ))}
        <button type="button" className="b-br-strip-new" title="New tab · ⌘L" onClick={() => focusOmni('go')}>New tab</button>
      </nav>

      <div className={`b-br-grid${side ? ' side' : ''}`}>
        <aside className="b-br-rail nosb" aria-label="Tabs">
          <div className="b-br-rail-head">
            <span className="b-br-label">Open</span>
            <button type="button" className="b-br-new" title="New tab · ⌘L" onClick={() => focusOmni('go')}>New tab</button>
          </div>
          {tabs.map((t) => (
            <div key={t.id} className={`b-br-tab${t.id === tab?.id ? ' on' : ''}`}>
              <button type="button" className="b-br-tab-hit" aria-current={t.id === tab?.id ? 'page' : undefined} title={t.url} onClick={() => selectTab(t.id)}>
                <span className="b-br-fav" style={{ background: t.mark }} aria-hidden>{t.initial}</span>
                <span className="b-br-tab-text"><b>{t.title}</b><span>{t.host}</span></span>
              </button>
              <button type="button" className="b-br-x" aria-label={`Close ${t.title}`} title="Close tab" onClick={() => closeTab(t.id)}>
                <AtlasIcon name="close" size={13} weight={2} />
              </button>
            </div>
          ))}
          {!tabs.length ? (
            <p className="b-br-rail-empty">No tabs. Press ⌘L and type an address. Atlas will tell you honestly that it can’t open it yet.</p>
          ) : null}
          <span className="b-br-label b-br-kept-label">Kept</span>
          {kept.map((k) => (
            <div key={k.id} className="b-br-kept">
              <p>{k.label}</p>
              <p>{k.count} kept</p>
            </div>
          ))}
          {!kept.length ? <p className="b-br-kept-none">Nothing kept.</p> : null}
        </aside>

        <section className="b-br-page nosb" ref={pageRef} aria-label="Page">
          <div className="b-br-tools">
            <button type="button" className="b-br-addr" title="Edit this address · ⌘L" onClick={() => focusOmni('go', tab ? tab.url : '')}>
              <AtlasIcon name="lock" size={12} weight={2} />
              <span>{tab ? `https://${tab.url}` : 'No page'}</span>
            </button>
            <button type="button" className={`b-br-tool b-br-tool--reader${reader ? ' on' : ''}`} aria-pressed={reader} title="Reader view" onClick={() => setReader((r) => !r)}>Reader</button>
            <button type="button" className={`b-br-tool b-br-tool--atlas${side ? ' on' : ''}`} aria-pressed={side} title="Show what Atlas noticed on this page" onClick={() => setSide((s) => !s)}>Atlas</button>
          </div>
          {page ? (
            <Article page={page} reader={reader} sample={live.isMock} mark={mark} />
          ) : (
            <div className="b-br-none">
              <b>{tab ? 'No readable copy' : 'Nothing open'}</b>
              <span>
                {tab
                  ? `Atlas kept ${tab.host} but never read it. There is no text to show, and it will not invent one.`
                  : 'This is the browser on day one: an omnibox, and nothing invented behind it.'}
              </span>
            </div>
          )}
        </section>

        {side ? (
          <aside className="b-br-side nosb" aria-label="What Atlas noticed">
            <div className="b-br-side-head">
              <i aria-hidden />
              <p>On this page</p>
              <span className="b-br-sp" />
              {tab?.analysis ? <span className="b-br-side-meta">{live.isMock ? 'sample notes' : 'read as you scrolled'}</span> : null}
              <button type="button" className="b-br-side-close" aria-label="Hide what Atlas noticed" title="Hide" onClick={() => setSide(false)}>
                <AtlasIcon name="close" size={13} weight={2} />
              </button>
            </div>

            {answers.map((a) => (
              <div key={a.id} className="b-br-card b-br-answer">
                <div className="b-br-card-head">
                  <p>{a.question}</p>
                  <button type="button" className="b-br-dismiss" aria-label="Dismiss this answer" onClick={() => live.dismissAnswer(a.id)}>
                    <AtlasIcon name="close" size={12} weight={2} />
                  </button>
                </div>
                <p className="b-br-card-body">{a.body}</p>
                <p className="b-br-basis">{a.basis}</p>
              </div>
            ))}

            {refusal ? (
              <div className="b-br-card b-br-refuse" role="status">
                <div className="b-br-card-head">
                  <p>{refusal.title}</p>
                  <button type="button" className="b-br-dismiss" aria-label="Dismiss" onClick={() => setRefusal(null)}>
                    <AtlasIcon name="close" size={12} weight={2} />
                  </button>
                </div>
                <p className="b-br-card-body">{refusal.body}</p>
                <div className="b-br-card-actions">
                  {refusal.kind === 'no-engine' && refusal.href ? (
                    <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => { const href = refusal.href; if (href) void openExternal(href); }}>
                      <AtlasIcon name="open" size={13} weight={2} />Open in your browser
                    </button>
                  ) : null}
                  {refusal.kind === 'no-engine' && !refusal.href ? (
                    <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => { const t = refusal.typed; setRefusal(null); focusOmni('ask', t); }}>Ask instead</button>
                  ) : null}
                  {refusal.kind === 'unanswerable' ? (
                    <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => { const q = refusal.question; setRefusal(null); openTalk(q); }}>Ask Atlas in Talk</button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {tab?.analysis ? (
              <>
                <p className="b-br-sum">{tab.analysis.summary}</p>
                {tab.analysis.points.map((p) => (
                  <div key={p.id} className="b-br-point">
                    <span className="b-br-tag" data-kind={p.kind}>{p.kind}</span>
                    <p><b>{p.title}.</b> {p.body}</p>
                  </div>
                ))}
              </>
            ) : (
              <p className="b-br-side-none">
                {page
                  ? 'Not read yet. Atlas notices things as a page is read.'
                  : tab ? 'No readable copy, so nothing to notice.' : 'Nothing open, so nothing to notice.'}
              </p>
            )}
          </aside>
        ) : null}

        <div className="b-br-omni-wrap">
          {showSuggest ? (
            <div className="b-br-suggest" role="listbox" aria-label={`${copy.label} suggestions`}>
              {mode === 'ask' ? askRows.map((s) => (
                <button type="button" role="option" aria-selected={false} key={s.id} onMouseDown={(e) => e.preventDefault()} onClick={() => submit(s.label, s.id)}>
                  <span>{s.label}</span><span>{s.meta}</span>
                </button>
              )) : goRows.map((s) => (
                <button type="button" role="option" aria-selected={false} key={s.id} onMouseDown={(e) => e.preventDefault()} onClick={() => submit(s.label)}>
                  <span>{s.label}</span><span>{s.meta}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="b-br-omni" data-mode={mode}>
            <button type="button" className="b-br-mode" title="Switch between going somewhere, asking Atlas, and finding on the page" onClick={cycleMode}>
              <AtlasIcon name={MODE_ICON[mode]} size={15} weight={1.7} />{copy.label}<kbd>{copy.key}</kbd>
            </button>
            <input
              ref={omniRef}
              className="b-br-in"
              value={typed}
              placeholder={copy.placeholder}
              aria-label={copy.placeholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => { setTyped(e.target.value); setCursor(0); setSuggestOpen(true); }}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setSuggestOpen(false)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(typed, undefined, e.shiftKey ? -1 : 1); } }}
            />
            {mode === 'find' && query ? <span className="b-br-found" aria-live="polite">{findCountLabel(cur, matches.length)}</span> : null}
            <button type="button" className="b-br-go" aria-label={copy.submit} title={copy.submit} disabled={!canSubmit} onClick={() => submit()}>
              <AtlasIcon name={SUBMIT_ICON[mode]} size={16} weight={2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** The readable copy, in `pageBlocks()` order so find's block numbers line up. */
function Article({ page, reader, sample, mark }: { page: BrowserPage; reader: boolean; sample: boolean; mark: (text: string, block: number) => ReactNode }) {
  const before = page.paragraphs.length;
  const after = 2 + before + (page.figure ? 1 : 0);
  return (
    <article className={`b-br-article${reader ? ' reader' : ''}`}>
      <div className="b-br-byline">
        {sample ? <span className="b-br-stamp b-br-stamp--page">Sample page</span> : null}
        <span>{page.kicker} · {page.author.name} · {page.readMinutes} min read</span>
      </div>
      <h1 className="b-br-h1">{mark(page.headline, 0)}</h1>
      <p className="b-br-stand">{mark(page.standfirst, 1)}</p>
      {page.paragraphs.map((text, i) => <p key={`p${i}`} className="b-br-p">{mark(text, 2 + i)}</p>)}
      {page.figure ? (
        <figure className="b-br-fig">
          <div className={`b-br-fig-plate${page.figure.tone === 'slate' ? ' slate' : ''}`} aria-hidden />
          <figcaption>{mark(page.figure.caption, 2 + before)}</figcaption>
        </figure>
      ) : null}
      {page.paragraphsAfter.map((text, i) => <p key={`q${i}`} className="b-br-p">{mark(text, after + i)}</p>)}
      <p className="b-br-end">End of the copy Atlas kept. There is no next page to load.</p>
    </article>
  );
}

export default BetaBrowser;
