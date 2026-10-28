/**
 * The Beta Browser — `/browser` while the beta_ui flag is on (Beta redesign
 * phase 5, `Atlas Browser Beta.dc.html`). Admin edition only.
 *
 * Hero bar (the header sphere as the talk entry point, one line, the tab
 * count, Home), the strip that says what happens on this Mac, the tab rail
 * with Kept, the page with its address and Reader / Keep / Atlas toggles,
 * "On this page", and the ink omnibox with its three modes: Go, Ask, Find.
 *
 * Every page is real, and none of it is rendered as a web page:
 *   - Go hands the address to the brain on this Mac (`/browser/fetch`), which
 *     refuses anything but public http/https, caps the size, the time and the
 *     redirects, and returns the page as text blocks. The reader draws those
 *     blocks with its own markup — no script runs, no remote image loads.
 *     Links on the page open as new tabs through Go. "Open in your browser"
 *     hands the original to the user's own browser.
 *   - Tabs, history and Kept live on this Mac (`atlas:browser`, see
 *     betaBrowserStore.ts), with each page's copy so they read without
 *     fetching again.
 *   - Find searches the copy on screen (`findMatches`), marks every hit and
 *     steps through them.
 *   - Ask and "On this page" send the page's text — and only that — to the AI
 *     provider through page-grounded brain routes that never write memory.
 *     "On this page" is asked for, never run on its own.
 *
 * Keys: ⌘L go · ⌘K ask · ⌘F find · Enter submit (Shift+Enter: previous
 * match) · Esc leaves the omnibox, then goes Home.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ASK_PROMPTS, MAX_TABS, MODE_COPY, NOTICE_LINE, answerBasis, askFailed, askWithoutPage, bylineFor, clearHistory,
  closeTab as closeTabIn, dayLabel, displayAddress, endLine, externalUrl, fetchedLabel, findCountLabel, findMatches,
  goSuggestions, groupBlocks, heroLine, hostOf, initialFor, isKept, markFor, modeForShortcut, nextMode, notAnAddress,
  notOpened, notesBasis, openKept, openPage, pageTexts, removeKept, segmentsFor, selectTab as selectTabIn, selectedTab, setNotes,
  stepCursor, tabCountLabel, toggleKeep, tooManyTabs,
  type BrowserMode, type BrowserRefusal, type GoRow, type PageCopy, type ReaderBlock,
} from '@/lib/betaBrowser';
import { flushBrowser, getBrowser, updateBrowser, useBrowserSaveFailed, useBrowserState } from '@/lib/betaBrowserStore';
import { askAboutPage, failed, fetchPageCopy, noticeOnPage } from '@/lib/betaBrowserApi';
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
/** Links listed under a page before "Show all". */
const LINKS_SHOWN = 12;

/** An answer in "On this page". Session only: answers are not saved anywhere. */
interface Answer {
  id: string;
  tabId: string;
  /** The page it was asked of: a tab that loads another page drops it. */
  url: string;
  question: string;
  /** Null while Atlas is asking. */
  body: string | null;
  basis: string;
}

let answerSeq = 0;

const BetaBrowser = () => {
  const navigate = useBetaNavigate();
  const browser = useBrowserState();
  const saveFailed = useBrowserSaveFailed();
  const reduced = useReducedMotion();

  const [mode, setMode] = useState<BrowserMode>(() => (getBrowser().tabs.length ? 'ask' : 'go'));
  const [typed, setTyped] = useState('');
  const [cursor, setCursor] = useState(0);
  const [reader, setReader] = useState(false);
  const [side, setSide] = useState(() => typeof window === 'undefined' || window.innerWidth >= NARROW);
  // Open while the omnibox has focus, closed by a submit until the next keystroke.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [refusal, setRefusal] = useState<BrowserRefusal | null>(null);
  const [answers, setAnswers] = useState<Answer[]>([]);
  // The fetch in flight: the address, and the tab it loads into (null: a new tab).
  const [pending, setPending] = useState<{ href: string; replaceTabId: string | null } | null>(null);
  // Set while the address bar is being edited: Go then loads into that tab.
  const [goTarget, setGoTarget] = useState<string | null>(null);
  const [noticing, setNoticing] = useState<string | null>(null);
  const [allLinks, setAllLinks] = useState(false);
  const [sphereEl, setSphereEl] = useState<HTMLDivElement | null>(null);
  const omniRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const fetchCtl = useRef<AbortController | null>(null);
  const inflight = useRef(new Set<AbortController>());

  const tabs = browser.tabs;
  const tab = selectedTab(browser);
  const page = tab?.page ?? null;
  const now = new Date();

  // The hero sphere is this screen's talk entry point.
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);

  // Leaving the screen: write the session now, and stop what is in flight.
  useEffect(() => {
    const live = inflight.current;
    return () => {
      flushBrowser();
      fetchCtl.current?.abort();
      live.forEach((c) => c.abort());
    };
  }, []);

  /* ── Find ─────────────────────────────────────────────────────────────── */

  const query = mode === 'find' ? typed.trim() : '';
  const texts = useMemo(() => pageTexts(page), [page]);
  const matches = useMemo(() => findMatches(texts, query), [texts, query]);
  const cur = matches.length ? Math.min(cursor, matches.length - 1) : -1;
  useEffect(() => { setCursor(0); }, [query, tab?.id]);
  useEffect(() => { setAllLinks(false); }, [tab?.id]);

  // Bring the current match to the middle of the page pane — instantly for
  // anyone who asked for reduced motion.
  useEffect(() => {
    const pane = pageRef.current;
    const el = pane?.querySelector<HTMLElement>('[data-hit="cur"]');
    if (!pane || !el) return;
    const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTo({ top: Math.max(0, top - pane.clientHeight / 2), behavior: reduced ? 'auto' : 'smooth' });
  }, [cur, query, tab?.id, reduced]);

  const mark = useCallback((text: string, block: number): ReactNode => {
    if (!query) return text;
    return segmentsFor(text, block, matches, query.length).map((s, i) => (s.hit === null
      ? <Fragment key={i}>{s.text}</Fragment>
      : <mark key={i} className={`b-br-hit${s.hit === cur ? ' on' : ''}`} data-hit={s.hit === cur ? 'cur' : undefined}>{s.text}</mark>));
  }, [query, matches, cur]);

  /* ── The omnibox ──────────────────────────────────────────────────────── */

  const focusOmni = useCallback((m: BrowserMode, value = '', target: string | null = null) => {
    setMode(m);
    setTyped(value);
    setCursor(0);
    setGoTarget(target);
    setSuggestOpen(true);
    const input = omniRef.current;
    if (!input) return;
    input.focus();
    // Select once React has rendered the new value, so typing replaces it.
    if (value) window.setTimeout(() => input.select(), 0);
  }, []);

  const cycleMode = useCallback(() => focusOmni(nextMode(mode)), [focusOmni, mode]);

  /** Go: fetch on this Mac, then open the copy in a new tab or in `replaceTabId`. */
  const go = useCallback(async (input: string, replaceTabId: string | null) => {
    setSuggestOpen(false);
    const href = externalUrl(input);
    if (!href) { setRefusal(notAnAddress(input)); setSide(true); return; }
    if (!replaceTabId && getBrowser().tabs.length >= MAX_TABS) { setRefusal(tooManyTabs()); setSide(true); return; }
    fetchCtl.current?.abort();
    const ctl = new AbortController();
    fetchCtl.current = ctl;
    setRefusal(null);
    setPending({ href, replaceTabId });
    const res = await fetchPageCopy(href, ctl.signal);
    if (ctl.signal.aborted) return;
    fetchCtl.current = null;
    setPending(null);
    if (failed(res)) {
      setRefusal(notOpened(href, res.message, res.reason));
      setSide(true);
      return;
    }
    updateBrowser((s) => openPage(s, res.page, { replaceTabId, now: new Date() }));
    setRefusal(null);
  }, []);

  const stopLoading = useCallback(() => {
    fetchCtl.current?.abort();
    fetchCtl.current = null;
    setPending(null);
  }, []);

  /** Ask: one answer from the open page's text, through a route that never writes memory. */
  const ask = useCallback(async (question: string) => {
    setSide(true);
    const t = selectedTab(getBrowser());
    if (!t?.page) { setRefusal(askWithoutPage(question, !!t)); return; }
    answerSeq += 1;
    const id = `a${answerSeq}`;
    const tabId = t.id;
    setRefusal(null);
    setAnswers((a) => [{ id, tabId, url: t.url, question, body: null, basis: '' }, ...a]);
    const ctl = new AbortController();
    inflight.current.add(ctl);
    const res = await askAboutPage({ url: t.url, title: t.title, text: pageTexts(t.page).join('\n\n') }, question, ctl.signal);
    inflight.current.delete(ctl);
    if (ctl.signal.aborted) return;
    if (failed(res)) {
      setAnswers((a) => a.filter((x) => x.id !== id));
      setRefusal(askFailed(question, res.message));
      return;
    }
    setAnswers((a) => a.map((x) => (x.id === id ? { ...x, body: res.answer, basis: answerBasis(res.provider, res.partial) } : x)));
  }, []);

  /** "On this page", on request: what is worth noticing, kept with the tab. */
  const readThisPage = useCallback(async () => {
    const t = selectedTab(getBrowser());
    if (!t?.page) return;
    setNoticing(t.id);
    setRefusal(null);
    const ctl = new AbortController();
    inflight.current.add(ctl);
    const res = await noticeOnPage({ url: t.url, title: t.title, text: pageTexts(t.page).join('\n\n') }, new Date(), ctl.signal);
    inflight.current.delete(ctl);
    if (ctl.signal.aborted) return;
    setNoticing(null);
    if (failed(res)) { setRefusal(askFailed(null, res.message)); return; }
    updateBrowser((s) => setNotes(s, t.id, res.notes));
  }, []);

  const pickGo = useCallback((row: GoRow) => {
    setSuggestOpen(false);
    setTyped('');
    setGoTarget(null);
    setRefusal(null);
    if (row.source === 'tab') { updateBrowser((s) => selectTabIn(s, row.ref, new Date())); return; }
    if (row.source === 'kept') {
      const next = openKept(getBrowser(), row.ref, new Date());
      if (next) { updateBrowser(() => next); return; }
    }
    void go(row.url, null);
  }, [go]);

  const hasPage = !!page;
  const askRows = hasPage ? ASK_PROMPTS : [];
  const goRows = useMemo(() => (mode === 'go' ? goSuggestions(browser, typed, new Date()) : []), [mode, browser, typed]);
  const offerClear = mode === 'go' && !typed.trim() && browser.history.length > 0;

  /** Submit is per mode: step (find), fetch (go), ask (ask). */
  const submit = useCallback((text: string = typed, dir: 1 | -1 = 1) => {
    if (mode === 'find') {
      setCursor((c) => stepCursor(c, matches.length, dir));
      return;
    }
    const t = text.trim();
    if (!t) return;
    setSuggestOpen(false);
    setTyped('');
    if (mode === 'go') {
      const target = goTarget;
      setGoTarget(null);
      void go(t, target);
      return;
    }
    void ask(t);
  }, [typed, mode, matches.length, goTarget, go, ask]);

  const showSuggest = suggestOpen && (mode === 'ask' ? !typed.trim() && askRows.length > 0 : mode === 'go' ? goRows.length > 0 || offerClear : false);
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

  const selectTab = useCallback((id: string) => {
    updateBrowser((s) => selectTabIn(s, id, new Date()));
    setRefusal(null);
    setCursor(0);
  }, []);
  const closeTab = useCallback((id: string) => {
    updateBrowser((s) => closeTabIn(s, id));
    setAnswers((a) => a.filter((x) => x.tabId !== id));
    setRefusal(null);
  }, []);
  const openKeptPage = useCallback((keptId: string, url: string) => {
    setRefusal(null);
    const next = openKept(getBrowser(), keptId, new Date());
    if (next) updateBrowser(() => next);
    else void go(url, null);
  }, [go]);

  const tabAnswers = answers.filter((a) => !!tab && a.tabId === tab.id && a.url === tab.url);
  const copy = MODE_COPY[mode];
  const kept = tab ? isKept(browser, tab.url) : false;
  const loadingHere = pending && (pending.replaceTabId === null || pending.replaceTabId === tab?.id);

  return (
    <div className="b-br" data-screen-label="Beta — Browser">
      <header className="b-br-hero">
        <div className="b-br-bar">
          <div className="b-br-sphere" ref={setSphereEl}>
            <VeilSphere size="mini" bg="#fffdfa" />
            <button type="button" className="b-br-talk" title="Talk to Atlas · ⌥ Space" aria-label="Talk to Atlas" onClick={() => openTalk()} />
          </div>
          <span className="b-br-sub">{heroLine(tabs.length)}</span>
          <span className="b-br-count" aria-label={`${tabs.length} ${tabCountLabel(tabs.length)}`}>
            <b>{tabs.length}</b><span className="b-br-count-l">{tabCountLabel(tabs.length)}</span>
          </span>
        </div>
        <button type="button" className="b-br-home" title="Back · Esc" onClick={() => navigate('/')}>← Home</button>
      </header>

      <div className="b-br-note" role="note">
        <span className="b-br-stamp">On this Mac</span>
        <p title={NOTICE_LINE}>{NOTICE_LINE}</p>
        {saveFailed ? (
          <p className="b-br-note-warn" role="status">This Mac’s storage refused the session, so these tabs and kept pages won’t be here next time.</p>
        ) : null}
      </div>

      <nav className="b-br-strip nosb" aria-label="Open tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`b-br-stab${t.id === tab?.id ? ' on' : ''}`}>
            <button type="button" className="b-br-stab-hit" aria-current={t.id === tab?.id ? 'page' : undefined} title={t.url} onClick={() => selectTab(t.id)}>
              <span className="b-br-fav" style={{ background: markFor(t.host) }} aria-hidden>{initialFor(t.host)}</span>
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
                <span className="b-br-fav" style={{ background: markFor(t.host) }} aria-hidden>{initialFor(t.host)}</span>
                <span className="b-br-tab-text"><b>{t.title}</b><span>{t.host}</span></span>
              </button>
              <button type="button" className="b-br-x" aria-label={`Close ${t.title}`} title="Close tab" onClick={() => closeTab(t.id)}>
                <AtlasIcon name="close" size={13} weight={2} />
              </button>
            </div>
          ))}
          {!tabs.length ? (
            <p className="b-br-rail-empty">No tabs. Press ⌘L and type an address; Atlas fetches the page on this Mac and shows its text.</p>
          ) : null}
          <span className="b-br-label b-br-kept-label">Kept</span>
          {browser.kept.map((k) => (
            <div key={k.id} className="b-br-kept">
              <button type="button" className="b-br-kept-hit" title={k.url} onClick={() => openKeptPage(k.id, k.url)}>
                <p>{k.title}</p>
                <p>Kept {dayLabel(new Date(k.keptAt))}{k.page ? '' : ' · loads again'}</p>
              </button>
              <button type="button" className="b-br-x" aria-label={`Remove ${k.title} from Kept`} title="Remove from Kept" onClick={() => updateBrowser((s) => removeKept(s, k.id))}>
                <AtlasIcon name="close" size={12} weight={2} />
              </button>
            </div>
          ))}
          {!browser.kept.length ? <p className="b-br-kept-none">Nothing kept.</p> : null}
        </aside>

        <section className="b-br-page nosb" ref={pageRef} aria-label="Page">
          <div className="b-br-tools">
            <button type="button" className="b-br-addr" title="Edit this address · ⌘L" onClick={() => focusOmni('go', tab ? tab.url : '', tab ? tab.id : null)}>
              {tab && !tab.url.startsWith('https:') ? (
                <span className="b-br-addr-flag" title="Not encrypted: this page came over http">http</span>
              ) : (
                <AtlasIcon name="lock" size={12} weight={2} />
              )}
              <span>{tab ? displayAddress(tab.url) : 'No page'}</span>
            </button>
            <button type="button" className={`b-br-tool b-br-tool--reader${reader ? ' on' : ''}`} aria-pressed={reader} title="Reader view" onClick={() => setReader((r) => !r)}>Reader</button>
            {tab ? (
              <button type="button" className={`b-br-tool b-br-tool--keep${kept ? ' on' : ''}`} aria-pressed={kept} title={kept ? 'Remove this page from Kept' : 'Keep this page, with its text, on this Mac'} onClick={() => updateBrowser((s) => toggleKeep(s, tab.id, new Date()))}>
                {kept ? 'Kept' : 'Keep'}
              </button>
            ) : null}
            <button type="button" className={`b-br-tool b-br-tool--atlas${side ? ' on' : ''}`} aria-pressed={side} title="Show what Atlas noticed on this page" onClick={() => setSide((s) => !s)}>Atlas</button>
          </div>
          {loadingHere && pending ? (
            <div className="b-br-none" role="status" aria-live="polite">
              <b>Opening {hostOf(pending.href)}</b>
              <span>Atlas is fetching the page on this Mac. It shows the text only: no scripts run and no images load.</span>
              <button type="button" className="b-btn b-btn--row" onClick={stopLoading}>Stop</button>
            </div>
          ) : page ? (
            <Article page={page} reader={reader} mark={mark} now={now} allLinks={allLinks} onAllLinks={() => setAllLinks(true)} onLink={(href) => void go(href, null)} />
          ) : tab ? (
            <div className="b-br-none">
              <b>No copy of this page</b>
              <span>Space for saved pages ran short, so its text was left out when the session was saved. Load it again to read it here.</span>
              <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => void go(tab.url, tab.id)}>Load it again</button>
            </div>
          ) : (
            <div className="b-br-none">
              <b>Nothing open</b>
              <span>This is the browser on day one: an omnibox, and nothing invented behind it.</span>
            </div>
          )}
        </section>

        {side ? (
          <aside className="b-br-side nosb" aria-label="What Atlas noticed">
            <div className="b-br-side-head">
              <i aria-hidden />
              <p>On this page</p>
              <span className="b-br-sp" />
              {tab?.notes ? <span className="b-br-side-meta">read on request · {fetchedLabel(tab.notes.at, now)}</span> : null}
              <button type="button" className="b-br-side-close" aria-label="Hide what Atlas noticed" title="Hide" onClick={() => setSide(false)}>
                <AtlasIcon name="close" size={13} weight={2} />
              </button>
            </div>

            {tabAnswers.map((a) => (
              <div key={a.id} className="b-br-card b-br-answer" aria-busy={a.body === null}>
                <div className="b-br-card-head">
                  <p>{a.question}</p>
                  {a.body !== null ? (
                    <button type="button" className="b-br-dismiss" aria-label="Dismiss this answer" onClick={() => setAnswers((x) => x.filter((y) => y.id !== a.id))}>
                      <AtlasIcon name="close" size={12} weight={2} />
                    </button>
                  ) : null}
                </div>
                <p className="b-br-card-body">{a.body ?? 'Asking about this page…'}</p>
                {a.body !== null ? <p className="b-br-basis">{a.basis}</p> : null}
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
                  {refusal.kind === 'not-opened' && refusal.href ? (
                    <button type="button" className="b-btn b-btn--primary b-btn--row" onClick={() => { const href = refusal.href; if (href) void openExternal(href); }}>
                      <AtlasIcon name="open" size={13} weight={2} />Open in your browser
                    </button>
                  ) : null}
                  {refusal.kind === 'not-address' ? (
                    <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => { const t = refusal.typed; setRefusal(null); focusOmni('ask', t); }}>Ask instead</button>
                  ) : null}
                  {refusal.kind === 'no-answer' && refusal.question ? (
                    <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => { const q = refusal.question; setRefusal(null); if (q) openTalk(q); }}>Ask Atlas in Talk</button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {tab?.notes ? (
              <>
                {tab.notes.summary ? <p className="b-br-sum">{tab.notes.summary}</p> : null}
                {tab.notes.points.map((p, i) => (
                  <div key={i} className="b-br-point">
                    <span className="b-br-tag" data-kind={p.kind}>{p.kind}</span>
                    <p><b>{p.title}.</b> {p.body}</p>
                  </div>
                ))}
                <p className="b-br-basis b-br-notes-basis">{notesBasis(tab.notes.provider, tab.notes.partial)}</p>
              </>
            ) : page && tab ? (
              <div className="b-br-side-none">
                <span>Not read yet. Atlas notices things on a page when you ask: it sends the page’s text to your AI provider, and saves nothing to memory.</span>
                <button type="button" className="b-btn b-btn--primary b-btn--row" disabled={noticing === tab.id} onClick={() => void readThisPage()}>
                  {noticing === tab.id ? 'Reading…' : 'Read this page'}
                </button>
              </div>
            ) : (
              <p className="b-br-side-none">
                {tab ? 'No copy of this page, so nothing to notice.' : 'Nothing open, so nothing to notice.'}
              </p>
            )}
          </aside>
        ) : null}

        <div className="b-br-omni-wrap">
          {showSuggest ? (
            <div className="b-br-suggest" role="listbox" aria-label={`${copy.label} suggestions`}>
              {mode === 'ask' ? askRows.map((s) => (
                <button type="button" role="option" aria-selected={false} key={s.id} onMouseDown={(e) => e.preventDefault()} onClick={() => submit(s.label)}>
                  <span>{s.label}</span><span>{s.meta}</span>
                </button>
              )) : (
                <>
                  {goRows.map((r) => (
                    <button type="button" role="option" aria-selected={false} key={r.id} title={r.url} onMouseDown={(e) => e.preventDefault()} onClick={() => pickGo(r)}>
                      <span>{r.label}</span><span>{r.meta}</span>
                    </button>
                  ))}
                  {offerClear ? (
                    <button type="button" role="option" aria-selected={false} className="b-br-suggest-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => { updateBrowser(clearHistory); setSuggestOpen(false); }}>
                      <span>Clear browsing history</span><span>{browser.history.length} {browser.history.length === 1 ? 'address' : 'addresses'}</span>
                    </button>
                  ) : null}
                </>
              )}
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
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(typed, e.shiftKey ? -1 : 1); } }}
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

/** One block of the copy, drawn with the reader's own markup. `n` is its number for find. */
function Block({ block, n, mark }: { block: ReaderBlock; n: number; mark: (text: string, block: number) => ReactNode }) {
  switch (block.kind) {
    case 'heading':
      return (block.level ?? 2) <= 2
        ? <h2 className="b-br-h2">{mark(block.text, n)}</h2>
        : <h3 className="b-br-h3">{mark(block.text, n)}</h3>;
    case 'quote':
      return <blockquote className="b-br-quote">{mark(block.text, n)}</blockquote>;
    case 'caption':
      return <p className="b-br-cap">{mark(block.text, n)}</p>;
    case 'code':
      return <pre className="b-br-code">{mark(block.text, n)}</pre>;
    default:
      return <p className="b-br-p">{mark(block.text, n)}</p>;
  }
}

/** The readable copy, in `pageTexts()` order so find's block numbers line up. */
function Article({ page, reader, mark, now, allLinks, onAllLinks, onLink }: {
  page: PageCopy;
  reader: boolean;
  mark: (text: string, block: number) => ReactNode;
  now: Date;
  allLinks: boolean;
  onAllLinks: () => void;
  onLink: (href: string) => void;
}) {
  const groups = useMemo(() => groupBlocks(page.blocks), [page.blocks]);
  const links = allLinks ? page.links : page.links.slice(0, LINKS_SHOWN);
  return (
    <article className={`b-br-article${reader ? ' reader' : ''}`} lang={page.lang ?? undefined}>
      <div className="b-br-byline"><span>{bylineFor(page)}</span></div>
      <h1 className="b-br-h1">{mark(page.title, 0)}</h1>
      {groups.map((g) => (g.type === 'list' ? (
        <ul key={`l${g.items[0].n}`} className="b-br-ul">
          {g.items.map((it) => <li key={it.n} className="b-br-li">{mark(it.block.text, it.n)}</li>)}
        </ul>
      ) : <Block key={g.n} block={g.block} n={g.n} mark={mark} />))}
      {!page.blocks.length ? <p className="b-br-p b-br-empty-copy">This page has no text Atlas could read. It may be built by scripts, which never run here; your own browser can show it.</p> : null}
      {page.links.length ? (
        <section className="b-br-links" aria-label="Links on this page">
          <p className="b-br-label">Links on this page · {page.links.length}</p>
          {links.map((l) => (
            <button type="button" key={l.href} className="b-br-link" title={`Open ${l.href} in a new tab`} onClick={() => onLink(l.href)}>
              <span>{l.text}</span><span>{hostOf(l.href)}</span>
            </button>
          ))}
          {!allLinks && page.links.length > LINKS_SHOWN ? (
            <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={onAllLinks}>Show all {page.links.length} links</button>
          ) : null}
        </section>
      ) : null}
      <p className="b-br-end">{endLine(page, now)}</p>
      <div className="b-br-end-actions">
        <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => void openExternal(page.url)}>
          <AtlasIcon name="open" size={13} weight={2} />Open in your browser
        </button>
      </div>
    </article>
  );
}

export default BetaBrowser;
