/**
 * The Beta Settings — `/settings` while the beta_ui flag is on (Beta redesign
 * phase 5, `Atlas Settings Beta.dc.html`).
 *
 * The compact header (sphere, group eyebrow, section title, intro, Home), the
 * design's grouped section navigation, and the deep links: `?tab=<id>` as the
 * account menu has always sent, and `#wifi` / `#bluetooth` / `#battery` /
 * `#mail` from the status panels and the Mail sidebar. The URL is the only
 * source of truth for which section is open — the nav writes the hash — so a
 * deep link and a click are the same thing, and arriving by one lands on the
 * section with its title focused and its nav item in view.
 *
 * Every section runs on the app's real stores. Memory & Privacy (with account
 * deletion) and Budget & AI render the Workshop's own components, because
 * their destructive flows and their copy are exactly what the privacy policy
 * promises and a second copy would be the one that drifts. Voice,
 * Personality, Permissions, Mail, Portfolio, Music and Software Update are
 * redrawn on the design's cards over the same hooks the Workshop tabs use —
 * which is also how the design's confirm-before-disconnect reaches the
 * mailboxes and the brokerage, both of which delete stored data. "This Mac"
 * reads `useSystemVitals` and shows what the Mac reports: no switch, no join,
 * no pair, because the webview has no command for any of them. "Beta UI" is
 * the way back.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { EDITION } from '@/surfaces';
import { useAtlasSettings, type AtlasSettings as VoiceDials } from '@/hooks/useAtlasSettings';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { usePersonality } from '@/hooks/usePersonality';
import { useAppUpdater } from '@/hooks/useAppUpdater';
import { isUserMailbox, useMailIntelligence, type MailAccount } from '@/hooks/useMailIntelligence';
import { useMailboxToasts } from '@/hooks/useMailboxToasts';
import { useMailAlertsPref } from '@/hooks/useMailAlertsPref';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { useSystemVitals, type BtDevice, type SystemVitalsState } from '@/hooks/useSystemVitals';
import { ATLAS_PERMISSIONS, readOnboarding } from '@/lib/atlasPermissions';
import { getActiveWakePhrases } from '@/lib/wakeWord';
import { setBetaUi } from '@/lib/betaFlag';
import {
  PERMISSION_ICON, SECTION_BY_ID, TRAITS, batteryHeadline, btIcon, mailboxLine, megabytes, navBadge, providerLabel, resolveSection, sectionGroups,
  traitWord, updateCard, visibleSections,
  type SectionId,
} from '@/lib/betaSettings';
import { MODELS, VOICES } from '@/components/atlas-health/VoiceSettingsPanel';
import { MemoryPrivacyPanel } from '@/components/atlas-health/MemoryPrivacyPanel';
import { DockStylePicker } from '@/components/atlas/DockStylePicker';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import type { IconName } from '@/components/atlas/icons';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/settings.css';

/** The page paper behind the transparent header sphere, for its dust lift. */
const PAGE_RGB = [249, 247, 244] as const;

/** Lazy, and only in admin — the same device as `AtlasSettings.tsx`, for the same reason: a static import ships the spend panel to consumers. */
const AtlasBudgetTab = EDITION === 'admin'
  ? lazy(() => import('@/components/atlas-ui/AtlasBudgetTab').then((m) => ({ default: m.AtlasBudgetTab })))
  : null;

type MailIntel = ReturnType<typeof useMailIntelligence>;
type Say = (text: string) => void;

/** The design's toast: one line on ink, gone after 2.4 s. Only for outcomes the hooks actually confirm. */
function useToastLine(): { text: string; say: Say } {
  const [text, setText] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const say = useCallback<Say>((t) => {
    setText(t);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(''), 2400);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { text, say };
}

const BetaSettings = () => {
  const navigate = useBetaNavigate();
  const plainNavigate = useNavigate();
  const location = useLocation();
  const vitals = useSystemVitals();
  const mail = useMailIntelligence();
  const updater = useAppUpdater();
  const { text: toast, say } = useToastLine();
  useMailboxToasts(mail.accounts, mail.isLoading, say);
  const [version, setVersion] = useState<string | null>(null);
  const [sphereEl, setSphereEl] = useState<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  const sections = useMemo(() => visibleSections(EDITION), []);
  const groups = useMemo(() => sectionGroups(sections), [sections]);
  const tab = new URLSearchParams(location.search).get('tab');
  const current = resolveSection(location.hash, tab, EDITION);
  const section = SECTION_BY_ID[current];

  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (!isTyping(e.target) && e.key === 'Escape') navigate('/'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // A deep link or a nav click lands at the top of the section with its title
  // focused, so a screen reader announces where it arrived. A plain visit to
  // /settings leaves focus alone on its first paint.
  const arrived = useRef(false);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    if (arrived.current || location.hash || tab) titleRef.current?.focus({ preventScroll: true });
    arrived.current = true;
  }, [current, location.hash, tab]);

  // The section's nav item must be visible too. At phone width the nav is a
  // sideways strip, and `#battery` sits off its right edge; on a short window
  // the column scrolls. Only the nav itself scrolls — scrollIntoView would
  // also move the page, which holds still under the top bar. Offsets, not
  // rects: the nav is still mid-`b-pop` (scaled) on a deep link's first
  // paint, and offsets ignore transforms. Run again once the web fonts are
  // in, because they change every label's width.
  useEffect(() => {
    let alive = true;
    const reveal = () => {
      const nav = navRef.current;
      const item = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!alive || !nav || !item) return;
      const outX = item.offsetLeft < nav.scrollLeft || item.offsetLeft + item.offsetWidth > nav.scrollLeft + nav.clientWidth;
      const outY = item.offsetTop < nav.scrollTop || item.offsetTop + item.offsetHeight > nav.scrollTop + nav.clientHeight;
      if (outX) nav.scrollLeft = item.offsetLeft - (nav.clientWidth - item.offsetWidth) / 2;
      if (outY) nav.scrollTop = item.offsetTop - (nav.clientHeight - item.offsetHeight) / 2;
    };
    reveal();
    void document.fonts?.ready.then(reveal);
    return () => { alive = false; };
  }, [current]);

  // Checking is read-only and safe to do when Settings opens (it is what puts
  // "New" on the nav); installing never is, and only the Update section's
  // button does it.
  const { supported, check } = updater;
  useEffect(() => { if (supported) void check(); }, [supported, check]);
  useEffect(() => {
    if (!supported) return;
    import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setVersion).catch(() => {});
  }, [supported]);

  const open = (id: SectionId) => plainNavigate({ pathname: '/settings', search: '', hash: `#${id}` }, { replace: true });
  const mailAttention = mail.accounts.filter(isUserMailbox).filter((a) => a.status !== 'active').length;
  const badgeCtx = { mailAttention, updateAvailable: updater.phase === 'available' };

  return (
    <div className="b-st" data-screen-label="Beta — Settings">
      <header className="b-st-hero">
        <button type="button" className="b-st-sphere" ref={setSphereEl} onClick={() => openTalk()} aria-label="Talk to Atlas" title="Talk to Atlas · ⌥ Space">
          <VeilSphere size="panel" bg="transparent" tone={PAGE_RGB} alpha={0.7} />
        </button>
        <div className="b-st-hero-text">
          <span className="b-eyebrow b-st-eyebrow">Settings · {section.group}</span>
          <h1 className="b-st-h1" ref={titleRef} tabIndex={-1}>{section.label}</h1>
          <p className="b-st-intro">{section.intro}</p>
        </div>
        <button type="button" className="b-st-home" title="Back · Esc" onClick={() => navigate('/')}>← Home</button>
      </header>

      <div className="b-st-grid">
        <nav className="b-st-nav nosb" aria-label="Settings sections" ref={navRef}>
          {groups.map((g) => (
            <div className="b-st-group" key={g.label}>
              <p className="b-st-group-l">{g.label}</p>
              {g.items.map((s) => {
                const badge = navBadge(s, badgeCtx);
                const on = s.id === current;
                return (
                  <button type="button" key={s.id} className={`b-st-navbtn${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => open(s.id)}>
                    <AtlasIcon name={s.icon} size={18} weight={1.5} />
                    <span>{s.label}</span>
                    {badge ? <span className={`b-st-badge b-st-badge--${badge.tone}`}>{badge.text}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <main className="b-st-main" ref={mainRef}>
          {current === 'voice' ? <VoiceSection /> : null}
          {current === 'personality' ? <PersonalitySection /> : null}
          {current === 'memory' ? <section className="b-st-card b-st-embed" aria-label="Memory and privacy"><MemoryPrivacyPanel /></section> : null}
          {current === 'permissions' ? <PermissionsSection onReview={() => plainNavigate('/permissions')} /> : null}
          {current === 'mail' ? <MailSection mail={mail} say={say} /> : null}
          {current === 'portfolio' ? <PortfolioSection say={say} /> : null}
          {current === 'music' ? <MusicSection say={say} /> : null}
          {current === 'wifi' ? <WifiSection vitals={vitals} /> : null}
          {current === 'bluetooth' ? <BluetoothSection vitals={vitals} /> : null}
          {current === 'devices' ? <DevicesSection vitals={vitals} /> : null}
          {current === 'battery' ? <BatterySection vitals={vitals} /> : null}
          {current === 'updates' ? <UpdatesSection updater={updater} version={version} /> : null}
          {current === 'budget' && AtlasBudgetTab ? (
            <section className="b-st-card b-st-embed" aria-label="Budget and AI"><Suspense fallback={null}><AtlasBudgetTab /></Suspense></section>
          ) : null}
          {current === 'beta' ? <BetaSection /> : null}
        </main>
      </div>

      {toast ? <div className="b-st-toast" role="status"><i />{toast}</div> : null}
    </div>
  );
};

/* ── Card vocabulary ─────────────────────────────────────────────────────── */

function CardHead({ title, sub, warn, children }: { title: string; sub?: string; warn?: boolean; children?: ReactNode }) {
  return (
    <div className="b-st-card-head">
      <div>
        <p className={`b-st-card-t${warn ? ' b-st-card-t--warn' : ''}`}>{title}</p>
        {sub ? <p className="b-st-card-s">{sub}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Stat({ k, v, ok }: { k: string; v: string; ok?: boolean }) {
  return <div className="b-st-stat"><small>{k}</small><b className={ok ? 'ok' : undefined}>{v}</b></div>;
}

type ChipTone = 'quiet' | 'on' | 'ink' | 'ok' | 'warn' | 'off';
type LineTone = 'quiet' | 'ok' | 'warn' | 'blue';

/** One row of a card: the round icon chip, a title and a line, an optional trail, then its buttons. */
function Row({ icon, chip = 'quiet', title, sub, subTone = 'quiet', trail, trailTone, emphasis, children }: {
  icon?: IconName; chip?: ChipTone; title: string; sub?: string; subTone?: LineTone; trail?: string; trailTone?: 'ok' | 'warn' | 'ink';
  emphasis?: boolean; children?: ReactNode;
}) {
  return (
    <div className={`b-st-row${emphasis ? ' b-st-row--emphasis' : ''}`}>
      {icon ? <span className={`b-st-row-ico b-st-row-ico--${chip}`}><AtlasIcon name={icon} size={17} weight={1.5} /></span> : null}
      <div className="b-st-row-text">
        <p className="b-st-row-t">{title}</p>
        {sub ? <p className={`b-st-row-s b-st-row-s--${subTone}`}>{sub}</p> : null}
      </div>
      {trail || children ? (
        <div className="b-st-row-end">
          {trail ? <span className={`b-st-trail${trailTone ? ` b-st-trail--${trailTone}` : ''}`}>{trail}</span> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** The design's inline confirmation under a row, for the actions that delete something. */
function Confirm({ text, go, busy, onGo, onKeep }: { text: string; go: string; busy: boolean; onGo: () => void; onKeep: () => void }) {
  return (
    <div className="b-st-confirm" role="group" aria-label="Confirm">
      <p>{text}</p>
      <div>
        <button type="button" className="b-btn b-st-confirmb b-st-red" disabled={busy} onClick={onGo}>{busy ? 'Working…' : go}</button>
        <button type="button" className="b-btn b-st-confirmb b-st-paper" disabled={busy} onClick={onKeep}>Keep</button>
      </div>
    </div>
  );
}

/** The "Sample" stamp the top bar uses, for the browser preview's fixture vitals. */
function SampleStamp({ vitals }: { vitals: SystemVitalsState }) {
  return vitals.fixture ? <span className="b-topbar-fixture" title="The browser preview cannot see this Mac">Sample</span> : null;
}

/* ── Voice ───────────────────────────────────────────────────────────────── */

function VoiceSection() {
  const { settings, setSetting } = useAtlasSettings();
  const { speak, isPlaying } = useStreamingTTS();
  const voice = VOICES.find((v) => v.id === settings.voiceId);
  const preview = () => { void speak(`Hi, I'm Atlas — this is the ${voice?.name ?? 'selected'} voice.`, settings.voiceId, settings.ttsModel); };
  // The consent record is what the mic row shows: Settings never asks macOS itself (see PermissionsSection).
  const consent = readOnboarding();
  const mic = consent?.choices?.microphone;
  const phrases = getActiveWakePhrases();

  return (
    <>
      <section className="b-st-card" aria-label="Voice output">
        <CardHead title="Voice output" sub="The voice Atlas speaks with in conversation and briefings.">
          <button type="button" className={`b-btn ${isPlaying ? 'b-st-ink' : 'b-btn--tinted'}`} disabled={isPlaying} onClick={preview}>
            {isPlaying ? `Playing ${voice?.name ?? 'voice'}…` : 'Preview voice'}
          </button>
        </CardHead>
        <div className="b-st-voices" role="radiogroup" aria-label="Voice">
          {VOICES.map((v) => {
            const on = v.id === settings.voiceId;
            return (
              <button type="button" key={v.id} role="radio" aria-checked={on} className={`b-st-voice${on ? ' on' : ''}`} onClick={() => setSetting('voiceId', v.id)}>
                <span className="b-st-voice-n">{v.name}{on ? <AtlasIcon name="check" size={15} weight={2} /> : null}</span>
                <span className="b-st-voice-d">{v.description}</span>
              </button>
            );
          })}
        </div>
        <p className="b-st-sublabel">Speech model</p>
        <div className="b-st-models" role="radiogroup" aria-label="Speech model">
          {MODELS.map((m) => {
            const on = m.id === settings.ttsModel;
            return (
              <button type="button" key={m.id} role="radio" aria-checked={on} className={`b-st-model${on ? ' on' : ''}`} onClick={() => setSetting('ttsModel', m.id as VoiceDials['ttsModel'])}>
                <b>{m.name}</b><span>{m.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="b-st-card" aria-label="Voice input">
        <CardHead title="Voice input" sub="How Atlas listens. The microphone permission is managed under Permissions." />
        <Row
          icon="mic" chip={mic ? 'on' : 'quiet'} title="Microphone"
          sub={consent ? (mic ? 'Allowed when Atlas first asked. macOS owns the system prompt.' : 'Switched off when Atlas first asked. Review permissions to allow it.') : 'Not answered yet.'}
          trail={consent ? (mic ? 'Allowed' : 'Off') : '—'} trailTone={mic ? 'ok' : undefined}
        />
        <Row
          icon="voice" title={phrases.length ? `Listens for ${phrases.map((p) => `“${p}”`).join(' or ')}` : 'No wake word loaded'}
          sub={phrases.length ? 'Detected on this Mac by Atlas’s own model, once the microphone is on. Nothing is sent until Atlas wakes.' : 'The wake-word model did not load; the microphone button still works.'}
          trail="On-device"
        />
      </section>
    </>
  );
}

/* ── Personality ─────────────────────────────────────────────────────────── */

function PersonalitySection() {
  const { traits, lexicon, isLoading, loadError, isSaving, setTrait, reset } = usePersonality();
  const words = Object.entries(lexicon);
  const status = loadError ? loadError : isLoading ? 'Loading…' : isSaving ? 'Saving…' : 'Saved. Changes apply from your next message.';

  return (
    <>
      <section className="b-st-card" aria-label="How Atlas talks to you">
        <CardHead title="How Atlas talks to you" sub={status} warn={!!loadError}>
          {/* The hook confirms the reset with its own toast, so this button does not add one. */}
          <button type="button" className="b-btn" disabled={isLoading || isSaving || !!loadError} onClick={() => void reset()}>Reset to defaults</button>
        </CardHead>
        {!loadError ? TRAITS.map((t) => {
          const v = traits[t.key];
          return (
            <div className="b-st-trait" key={t.key}>
              <div className="b-st-trait-h"><span>{t.label}</span><span className="b-st-trait-w">{traitWord(v, t.low, t.high)}</span></div>
              <p>{t.description}</p>
              <input type="range" min={0} max={100} step={1} value={Math.round(v * 100)} disabled={isLoading} aria-label={t.label} onChange={(e) => setTrait(t.key, Number(e.target.value) / 100)} />
              <div className="b-st-trait-ends"><span>{t.low}</span><span>{t.high}</span></div>
            </div>
          );
        }) : null}
        {!loadError ? <p className="b-st-note">Atlas also nudges these slowly on its own as it learns what works for you, a small step at a time. Your setting always wins, and everything here stays on this Mac.</p> : null}
      </section>
      {!loadError ? (
        <section className="b-st-card" aria-label="Words Atlas has picked up">
          <CardHead title="Words Atlas has picked up" sub="Learned from how you talk. Shown so you can see exactly what Atlas noticed; it can’t be edited here — use Memory & Privacy to remove anything Atlas shouldn’t keep." />
          {words.length ? (
            <div className="b-st-chips">{words.map(([w, m]) => <span className="b-st-chip" key={w}><b>{w}</b><span>{m}</span></span>)}</div>
          ) : (
            <div className="b-empty"><p><b>Nothing yet</b></p><p>Atlas picks these up naturally as you talk.</p></div>
          )}
        </section>
      ) : null}
    </>
  );
}

/* ── Permissions ─────────────────────────────────────────────────────────── */

/**
 * A summary and a link, not a second set of switches — the consent screen owns
 * the choices, the copy and the code that asks macOS (the Workshop's
 * reasoning, kept). On the route path navigating away is closing.
 */
function PermissionsSection({ onReview }: { onReview: () => void }) {
  const record = readOnboarding();
  return (
    <section className="b-st-card" aria-label="What Atlas may do">
      <CardHead title="What Atlas may do" sub="These are the answers you gave when Atlas first started. Reviewing them reopens that same screen. Nothing changes until you choose it there, and switching one back on re-asks macOS." />
      {ATLAS_PERMISSIONS.map((p) => {
        const on = record?.choices?.[p.id];
        return (
          <Row key={p.id} icon={PERMISSION_ICON[p.id]} chip={on ? 'on' : 'quiet'} title={p.title} sub={on ? p.blurb : p.withoutIt}
            trail={record ? (on ? 'Allowed' : 'Off') : 'Not answered'} trailTone={on ? 'ok' : undefined} />
        );
      })}
      {record ? <p className="b-st-note">Answered {new Date(record.completedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.</p> : null}
      <div className="b-st-actions"><button type="button" className="b-btn b-btn--primary" onClick={onReview}>Review permissions</button></div>
    </section>
  );
}

/* ── Mail ────────────────────────────────────────────────────────────────── */

const EMPTY_IMAP = { email: '', host: '', port: '993', username: '', password: '' };

/**
 * The mailboxes, over the same `useMailIntelligence` the Workshop tab uses
 * (the page's instance, passed down, so the nav badge and this list are one
 * read). Reconnecting is a fresh sign-in: Gmail and Outlook rows are keyed by
 * address, so the OAuth round trip updates the row it came from, and an IMAP
 * row is re-saved by the form, prefilled with its address.
 */
function MailSection({ mail, say }: { mail: MailIntel; say: Say }) {
  const { accounts, isConnecting, connectingProvider, error, connect, connectImap, cancelConnect, disconnect, syncNow } = mail;
  const alerts = useMailAlertsPref();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [imapOpen, setImapOpen] = useState(false);
  const [imap, setImap] = useState(EMPTY_IMAP);
  const [imapBusy, setImapBusy] = useState(false);
  const [imapFailed, setImapFailed] = useState(false);
  const formRef = useRef<HTMLElement | null>(null);
  const now = Date.now();

  // The form opens under the mailboxes, often below the fold of the main
  // column: bring it up and put the cursor in its first field, as the design
  // scrolls to it. Only the main column moves.
  useEffect(() => {
    const form = formRef.current;
    const main = form?.closest('.b-st-main');
    if (!imapOpen || !form || !main) return;
    const below = form.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (below > 0) main.scrollBy({ top: below + 18, behavior: smooth ? 'smooth' : 'auto' });
    form.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }, [imapOpen]);

  const scan = async (id: string) => {
    setScanning(id);
    try { await syncNow(id); } finally { setScanning(null); }
  };
  // The hook reports a failed disconnect through `error` and re-reads the
  // list either way, so the row disappearing is the confirmation; a toast
  // here could not know which of the two happened.
  const drop = async (id: string) => {
    setBusy(id);
    try { await disconnect(id); } finally { setBusy(null); setConfirm(null); }
  };
  const reconnect = (a: MailAccount) => {
    if (a.provider === 'gmail' || a.provider === 'outlook') { void connect(a.provider); return; }
    setImap({ ...EMPTY_IMAP, email: a.email_address });
    setImapFailed(false);
    setImapOpen(true);
  };
  const field = (k: keyof typeof EMPTY_IMAP) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = k === 'port' ? e.target.value.replace(/\D/g, '') : e.target.value;
    setImap((f) => ({ ...f, [k]: v }));
    setImapFailed(false);
  };
  const imapReady = !!imap.email && !!imap.host && !!imap.password && !imapBusy;
  const submitImap = async () => {
    if (!imapReady) return;
    setImapBusy(true);
    const ok = await connectImap({ email: imap.email, host: imap.host, port: Number(imap.port) || 993, username: imap.username || undefined, password: imap.password });
    setImapBusy(false);
    // The "Mailbox connected" toast comes from the account list changing
    // (useMailboxToasts), the same way for IMAP, Gmail and Outlook.
    if (ok) { setImapOpen(false); setImap(EMPTY_IMAP); } else setImapFailed(true);
  };

  const hasGmail = accounts.some((a) => a.provider === 'gmail');
  const hasOutlook = accounts.some((a) => a.provider === 'outlook');
  const waiting = connectingProvider === 'outlook' ? 'Waiting for Microsoft…' : 'Waiting for Google…';

  return (
    <>
      <section className="b-st-card" aria-label="Connected mailboxes">
        <CardHead title="Connected mailboxes" sub="Atlas scans connected mailboxes read-only, every 15 minutes while it is open, and alerts you to bills, deadlines and documents. It changes a mailbox only when you archive a message in Mail, and Gmail and Outlook ask you to allow that first." />
        {accounts.map((a) => {
          const mine = isUserMailbox(a);
          const ok = a.status === 'active';
          const line = mailboxLine(a, { userMailbox: mine, scanning: scanning === a.id, now });
          return (
            <div key={a.id}>
              <Row icon="inbox" chip={ok ? 'ink' : 'warn'} title={a.email_address} sub={line.text} subTone={line.tone} trail={providerLabel(a.provider)}>
                {mine ? (
                  <>
                    {ok ? (
                      <button type="button" className="b-btn b-btn--tinted b-st-rowb" disabled={scanning === a.id} onClick={() => void scan(a.id)}>{scanning === a.id ? 'Scanning…' : 'Scan now'}</button>
                    ) : (
                      <button type="button" className="b-btn b-btn--primary b-st-rowb" disabled={isConnecting} onClick={() => reconnect(a)}>Reconnect</button>
                    )}
                    <button type="button" className="b-btn b-btn--danger b-st-rowb" aria-expanded={confirm === a.id} onClick={() => setConfirm(confirm === a.id ? null : a.id)}>Disconnect</button>
                  </>
                ) : null}
              </Row>
              {confirm === a.id ? (
                <Confirm
                  text={`Disconnect ${a.email_address}? Atlas stops scanning it and deletes the mail it stored from this mailbox. The mailbox itself is untouched.`}
                  go="Disconnect" busy={busy === a.id} onGo={() => void drop(a.id)} onKeep={() => setConfirm(null)}
                />
              ) : null}
            </div>
          );
        })}
        {!accounts.length ? <div className="b-empty"><p><b>No mailbox connected</b></p><p>Connect one below. Atlas only ever reads it.</p></div> : null}
        {error && !imapFailed ? <p className="b-st-note b-st-note--warn">{error}</p> : null}
        <div className="b-st-actions">
          {isConnecting ? (
            <>
              <button type="button" className="b-btn" disabled>{waiting}</button>
              {/* The connect buttons are locked while waiting, so an abandoned sign-in tab would otherwise hold them until the ten-minute timeout. */}
              <button type="button" className="b-btn b-btn--ghost" onClick={cancelConnect}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="b-btn b-btn--primary" onClick={() => void connect('gmail')}>{hasGmail ? 'Connect another Gmail' : 'Connect Gmail'}</button>
              <button type="button" className="b-btn b-btn--tinted" onClick={() => void connect('outlook')}>{hasOutlook ? 'Connect another Outlook' : 'Connect Outlook / Microsoft 365'}</button>
              {!imapOpen ? <button type="button" className="b-btn" onClick={() => { setImap(EMPTY_IMAP); setImapFailed(false); setImapOpen(true); }}>Connect another mailbox (IMAP)</button> : null}
            </>
          )}
        </div>
      </section>

      {imapOpen ? (
        <section className="b-st-card b-st-form" aria-label="Connect a mailbox over IMAP" ref={formRef}>
          <CardHead title="Connect a mailbox over IMAP" sub="For iCloud, Fastmail, Yahoo and most other providers. Atlas reads the inbox over TLS only, and changes it only when you archive a message in Mail (moved to its Archive folder). Many providers need an app-specific password here, not your normal one." />
          <input className="b-input" type="email" autoComplete="off" placeholder="Email address" aria-label="Email address" value={imap.email} onChange={field('email')} />
          <div className="b-st-form-pair">
            <input className="b-input" autoComplete="off" placeholder="IMAP server, e.g. imap.mail.me.com" aria-label="IMAP server" value={imap.host} onChange={field('host')} />
            <input className="b-input b-num b-st-port" inputMode="numeric" placeholder="993" aria-label="Port" value={imap.port} onChange={field('port')} />
          </div>
          <input className="b-input" autoComplete="off" placeholder="Username (if not the email address)" aria-label="Username" value={imap.username} onChange={field('username')} />
          <input className="b-input" type="password" autoComplete="off" placeholder="Password" aria-label="Password" value={imap.password} onChange={field('password')} />
          {imapFailed && error ? <p className="b-st-err" role="alert">{error}</p> : null}
          <div className="b-st-form-actions">
            <button type="button" className="b-btn b-btn--primary" disabled={!imapReady} onClick={() => void submitImap()}>{imapBusy ? 'Signing in…' : 'Connect'}</button>
            <button type="button" className="b-btn" disabled={imapBusy} onClick={() => { setImapOpen(false); setImapFailed(false); }}>Cancel</button>
          </div>
        </section>
      ) : null}

      <section className="b-st-card" aria-label="Alerts">
        <CardHead title="Alerts" />
        <Row
          icon="bell"
          chip={alerts.enabled ? 'on' : 'quiet'}
          title="Tell me about bills and deadlines"
          sub={alerts.blocked
            ? 'On, but macOS has notifications for Atlas turned off. Allow them in System Settings → Notifications.'
            : 'A notification when Atlas finds something due in the next 7 days, once per thread. Found in the subject and preview a scan already stored; nothing leaves this Mac.'}
          subTone={alerts.blocked ? 'warn' : 'quiet'}
        >
          <button
            type="button"
            role="switch"
            aria-checked={alerts.enabled}
            aria-label="Tell me about bills and deadlines"
            className={`b-switch${alerts.enabled ? ' on' : ''}`}
            disabled={alerts.saving}
            onClick={() => void alerts.setEnabled(!alerts.enabled)}
          ><span /></button>
        </Row>
        {alerts.error ? <p className="b-st-note b-st-note--warn">{alerts.error}</p> : null}
      </section>
    </>
  );
}

/* ── Portfolio ───────────────────────────────────────────────────────────── */

/** The brokerage link, over `usePortfolio` (SnapTrade → the on-device DuckDB). */
function PortfolioSection({ say }: { say: Say }) {
  const p = usePortfolio();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  // `disconnect` throws when Rust refuses, unlike the hook's other actions, so
  // this is the one place a toast can honestly say it worked.
  const drop = async () => {
    setBusy(true);
    setDropError(null);
    try {
      await p.disconnect();
      say('Brokerage disconnected');
    } catch (e) {
      setDropError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  const s = p.summary;
  return (
    <section className="b-st-card" aria-label="Brokerage connection">
      <CardHead title="Brokerage connection" sub="Holdings and transactions are pulled read-only and stored and analysed locally on this Mac, never in the cloud. You sign in inside your broker’s own window, so Atlas never sees your password." />
      {!p.available ? (
        <Row icon="banking" title="Runs in the Mac app" sub="Portfolio linking runs in the Atlas desktop app. Open Atlas on your Mac to connect a brokerage." />
      ) : !p.hasCredentials ? (
        <Row icon="banking" chip="warn" title="SnapTrade is not configured" sub="The brokerage link needs SnapTrade credentials on this Mac first. See docs/portfolio-setup.md." subTone="warn" />
      ) : p.connected ? (
        <>
          {s ? (
            <div className="b-st-stats">
              <Stat k="Accounts" v={String(s.accounts_count)} />
              <Stat k="Holdings" v={String(s.holdings_count)} />
            </div>
          ) : null}
          <Row icon="banking" chip="ink" title="Brokerage linked" sub="Read-only · via SnapTrade" subTone="ok">
            <button type="button" className="b-btn b-btn--tinted b-st-rowb" disabled={p.isSyncing} onClick={() => void p.sync()}>{p.isSyncing ? 'Syncing…' : 'Sync now'}</button>
            <button type="button" className="b-btn b-btn--danger b-st-rowb" aria-expanded={confirm} onClick={() => setConfirm(!confirm)}>Disconnect</button>
          </Row>
          {confirm ? (
            <Confirm text="Disconnect your brokerage? Atlas deletes the synced holdings and history from this Mac. Your brokerage account is untouched." go="Disconnect" busy={busy} onGo={() => void drop()} onKeep={() => setConfirm(false)} />
          ) : null}
        </>
      ) : (
        <>
          <Row icon="banking" title={p.isConnecting ? 'Opening your broker…' : 'No brokerage linked'} sub={p.isConnecting ? 'Finish signing in in the broker’s window.' : 'Portfolio and Money stay empty until you link one.'} />
          <div className="b-st-actions">
            <button type="button" className="b-btn b-btn--primary" disabled={p.isConnecting} onClick={() => void p.connect()}>{p.isConnecting ? 'Opening your broker…' : 'Connect a brokerage'}</button>
          </div>
        </>
      )}
      {p.error || dropError ? <p className="b-st-note b-st-note--warn">{dropError ?? p.error}</p> : null}
    </section>
  );
}

/* ── Music ───────────────────────────────────────────────────────────────── */

/**
 * The Spotify connection — the consent-withdrawal control the Privacy Policy
 * and Terms point at, so it is as easy to reach as connecting was. It cannot
 * un-authorise Atlas inside Spotify, and the confirmation says so.
 */
function MusicSection({ say }: { say: Say }) {
  const { available, connected, premium, isConnecting, error, connect, disconnect } = useMusicPlayer();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // The store swallows a failed disconnect into `error` and leaves
  // `connected` true, so the toast waits for `connected` to actually drop.
  const [awaitingDrop, setAwaitingDrop] = useState(false);
  useEffect(() => {
    if (!awaitingDrop) return;
    if (!connected) { say('Spotify disconnected · token deleted'); setAwaitingDrop(false); } else if (error) setAwaitingDrop(false);
  }, [awaitingDrop, connected, error, say]);

  const drop = async () => {
    setBusy(true);
    setAwaitingDrop(true);
    try { await disconnect(); } finally { setBusy(false); setConfirm(false); }
  };

  return (
    <section className="b-st-card" aria-label="Spotify connection">
      <CardHead title="Spotify connection" sub="Play your own library through Atlas. You sign in on Spotify’s own page, and Atlas keeps only an access token in this Mac’s Keychain. Playback happens with your consent, and you can withdraw it here at any time." />
      {!available ? (
        <Row icon="music" title="Runs in the Mac app" sub="Music runs in the Atlas desktop app. Open Atlas on your Mac to connect or disconnect Spotify." />
      ) : connected ? (
        <>
          <Row icon="music" chip="ink" title="Spotify connected" sub={premium ? 'Premium account · plays inside Atlas' : 'Connected · Spotify Premium is needed for playback'} subTone={premium ? 'ok' : 'quiet'}>
            <button type="button" className="b-btn b-btn--danger b-st-rowb" aria-expanded={confirm} onClick={() => setConfirm(!confirm)}>Disconnect</button>
          </Row>
          {confirm ? (
            <Confirm
              text="Disconnecting stops playback and deletes your Spotify token from this Mac’s Keychain, so Atlas loses all access to your Spotify account. Your Spotify account, library and playlists are untouched. To also remove Atlas from the apps listed in your Spotify account, do that on Spotify’s website. You can reconnect at any time."
              go="Disconnect Spotify" busy={busy} onGo={() => void drop()} onKeep={() => setConfirm(false)}
            />
          ) : null}
        </>
      ) : (
        <>
          <Row icon="music" title={isConnecting ? 'Waiting for Spotify…' : 'Not connected'} sub={isConnecting ? 'Approve Atlas on Spotify’s page.' : 'Spotify Premium is needed for playback.'} />
          <div className="b-st-actions">
            <button type="button" className="b-btn b-btn--primary" disabled={isConnecting} onClick={() => void connect()}>{isConnecting ? 'Waiting for Spotify…' : 'Connect Spotify'}</button>
          </div>
        </>
      )}
      {error ? <p className="b-st-note b-st-note--warn">{error}</p> : null}
    </section>
  );
}

/* ── This Mac ────────────────────────────────────────────────────────────── */

/** True on the Mac before `system_vitals` has answered once: nulls then mean "not read yet", not "absent". */
function reading(vitals: SystemVitalsState): boolean {
  return !vitals.fixture && vitals.at == null;
}

function WifiSection({ vitals }: { vitals: SystemVitalsState }) {
  const { wifi } = vitals;
  const source = vitals.fixture ? 'Sample' : 'This Mac';
  return (
    <section className="b-st-card" aria-label="Wi-Fi">
      <CardHead title="Wi-Fi" sub={wifi == null ? 'Checking…' : wifi.connected ? `Connected to ${wifi.ssid}` : 'Not connected'}><SampleStamp vitals={vitals} /></CardHead>
      {wifi?.connected ? (
        <Row emphasis icon="wi-fi" chip="on" title={wifi.ssid ?? 'Wi-Fi'} sub="Connected" subTone="blue" />
      ) : wifi == null ? (
        <div className="b-empty"><p><b>Reading this Mac</b></p><p>The first check takes a moment.</p></div>
      ) : (
        <div className="b-empty"><p><b>No Wi-Fi network</b></p><p>Join one from the macOS menu bar; Atlas keeps working offline on what it already has.</p></div>
      )}
      <div className="b-st-stats b-st-stats--top">
        <Stat k="Network" v={wifi?.ssid ?? '—'} />
        <Stat k="Status" v={wifi == null ? '…' : wifi.connected ? 'Online' : 'Off'} ok={!!wifi?.connected} />
        <Stat k="Source" v={source} />
      </div>
      <p className="b-st-note">Joining, forgetting and auto-join live in macOS. Atlas reads which network this Mac is on and nothing more.</p>
    </section>
  );
}

function DeviceRow({ d }: { d: BtDevice }) {
  const low = d.battery_percent != null && d.battery_percent <= 15;
  return (
    <Row icon={btIcon(d)} chip="ink" title={d.name} sub={`${d.kind ?? 'Bluetooth device'} · connected`}
      trail={d.battery_percent != null ? `${d.battery_percent}%` : undefined} trailTone={low ? 'warn' : 'ink'} />
  );
}

function BluetoothSection({ vitals }: { vitals: SystemVitalsState }) {
  const bt = vitals.bluetooth;
  const n = bt?.connected.length ?? 0;
  const low = (bt?.connected ?? []).filter((d) => d.battery_percent != null && d.battery_percent <= 15);
  return (
    <>
      <section className="b-st-card" aria-label="Bluetooth">
        <CardHead title="Bluetooth" sub={bt == null ? 'Checking… the first Bluetooth probe takes a moment.' : bt.on ? `${n} connected` : 'Off. Turn it on from the macOS menu bar; Atlas has no switch for it.'}><SampleStamp vitals={vitals} /></CardHead>
        <div className="b-st-stats b-st-stats--top">
          <Stat k="Bluetooth" v={bt == null ? '…' : bt.on ? 'On' : 'Off'} ok={!!bt?.on} />
          <Stat k="Connected" v={bt == null ? '…' : String(n)} />
          <Stat k="Source" v={vitals.fixture ? 'Sample' : 'This Mac'} />
        </div>
      </section>
      <section className="b-st-card" aria-label="Connected devices">
        <CardHead title="Connected now" sub="Pairing, connecting and forgetting live in macOS; this is what it reports." />
        {n ? bt!.connected.map((d) => <DeviceRow d={d} key={d.name} />) : (
          <div className="b-empty"><p><b>{bt == null ? 'Looking for devices' : bt.on ? 'Nothing connected' : 'Bluetooth is off'}</b></p><p>{bt == null ? 'The first check takes a moment.' : 'Devices you connect in macOS appear here and in the top bar.'}</p></div>
        )}
        {low.length ? <p className="b-st-note b-st-note--warn">{low.map((d) => d.name).join(', ')} {low.length === 1 ? 'is' : 'are'} low on battery. Charge soon.</p> : null}
      </section>
    </>
  );
}

function DevicesSection({ vitals }: { vitals: SystemVitalsState }) {
  const { wifi, battery, bluetooth: bt } = vitals;
  const line = reading(vitals)
    ? 'Reading this Mac…'
    : `${wifi?.connected ? `On ${wifi.ssid}` : 'Offline'}${battery ? ` · ${battery.percent}%${battery.charging ? ', charging' : ''}` : ' · mains power'}`;
  return (
    <section className="b-st-card" aria-label="Devices">
      <CardHead title="This Mac and what is around it" sub="What macOS reports right now. Chip, memory and storage readings are not wired yet, so they are not shown."><SampleStamp vitals={vitals} /></CardHead>
      <Row emphasis icon="mac" chip="on" title="This Mac" sub={line} subTone="blue" />
      {(bt?.connected ?? []).map((d) => <DeviceRow d={d} key={d.name} />)}
      {!bt?.connected.length ? <p className="b-st-note">{bt == null ? 'Looking for Bluetooth devices…' : 'No Bluetooth devices are connected right now.'}</p> : null}
    </section>
  );
}

function BatterySection({ vitals }: { vitals: SystemVitalsState }) {
  const b = vitals.battery;
  const loading = reading(vitals);
  const head = batteryHeadline(b, loading);
  return (
    <>
      <section className="b-st-card" aria-label="Battery">
        <div className="b-st-bat">
          <div className="b-st-bat-left">
            <span className="b-st-kicker">{head.kicker}{vitals.fixture ? ' · sample' : ''}</span>
            <span className="b-st-bat-big b-num">{head.big}</span>
            <span className="b-st-bat-line">{head.line}</span>
            <div className={`b-st-bar b-st-bar--${head.tone}`} role="progressbar" aria-valuenow={b?.percent ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Charge"><b style={{ width: `${b?.percent ?? 0}%` }} /></div>
          </div>
          <div className="b-st-stats b-st-stats--start">
            <Stat k="Power" v={b ? (b.on_power ? 'Adapter' : 'Battery') : loading ? '…' : 'Mains'} />
            <Stat k="Charging" v={b ? (b.charging ? 'Yes' : 'No') : loading ? '…' : '—'} ok={!!b?.charging} />
            <Stat k="Source" v={vitals.fixture ? 'Sample' : 'This Mac'} />
          </div>
        </div>
      </section>
      <section className="b-st-card" aria-label="On battery">
        <CardHead title="Atlas on battery" sub="Atlas reads the charge for the top bar and the status panel every thirty seconds. It has no low-power mode of its own yet, so there is nothing to switch here; macOS’s Low Power Mode applies as usual." />
      </section>
    </>
  );
}

/* ── Software Update ─────────────────────────────────────────────────────── */

function UpdatesSection({ updater, version }: { updater: ReturnType<typeof useAppUpdater>; version: string | null }) {
  const card = updateCard({
    supported: updater.supported,
    phase: updater.phase,
    version,
    available: updater.update ? { version: updater.update.version, date: updater.update.date } : null,
    error: updater.error,
    downloaded: updater.progress.downloaded,
    total: updater.progress.total,
  });
  const busy = updater.phase === 'checking' || updater.phase === 'downloading';
  return (
    <>
      <section className={`b-st-upd b-st-upd--${card.tone}`} aria-label="Update status" aria-live="polite">
        <span className="b-st-kicker">{card.kicker}</span>
        <span className="b-st-upd-t">{card.title}</span>
        <p>{card.body}</p>
        {updater.phase === 'downloading' ? (
          <div className="b-st-prog">
            <div><b className={card.pct == null ? 'b-st-prog-unknown' : undefined} style={{ width: `${card.pct ?? 30}%` }} /></div>
            <span className="b-num">{card.pct != null ? `${card.pct}% · ${megabytes(updater.progress.downloaded)} of ${megabytes(updater.progress.total ?? 0)}` : `${megabytes(updater.progress.downloaded)} downloaded`}</span>
          </div>
        ) : null}
        {updater.phase === 'available' && updater.update?.notes ? <div className="b-st-notes">{updater.update.notes}</div> : null}
        {card.action ? (
          <div className="b-st-actions">
            <button type="button" className={`b-btn ${card.action === 'install' ? 'b-btn--primary' : 'b-btn--tinted'}`} disabled={busy} onClick={() => void (card.action === 'install' ? updater.install() : updater.check())}>{card.actionLabel}</button>
          </div>
        ) : null}
      </section>
      <section className="b-st-card" aria-label="Current version">
        <CardHead title="Current version" sub="Updates come from the signed release feed; nothing unsigned or altered is ever installed." />
        <div className="b-st-stats">
          <Stat k="Atlas" v={version ?? (updater.supported ? '…' : 'Browser preview')} />
          <Stat k="Signature" v="Verified before install" ok />
          <Stat k="Installs" v="Only when you approve" />
        </div>
      </section>
    </>
  );
}

/* ── Beta UI ─────────────────────────────────────────────────────────────── */

function BetaSection() {
  const back = () => {
    // A `?beta=1` still on the URL outranks the stored choice (betaFlag.ts),
    // so the reload would switch the Beta straight back on. Land on a clean
    // /settings instead, which in the Workshop opens its own Settings.
    try { window.history.replaceState(window.history.state, '', '/settings'); } catch { /* keep the URL; the stored choice still applies */ }
    setBetaUi(false, { reload: true });
  };
  return (
    <section className="b-st-card" aria-label="Interface">
      <CardHead title="Interface" sub="The redesign ships behind the beta_ui flag while it is finished screen by screen. Switching back reloads the window; nothing you have stored changes, and ?beta=1 brings you here again." />
      <Row emphasis icon="sparkle" chip="on" title="Beta UI" sub="On — you are using the redesigned Atlas." subTone="blue">
        <button type="button" className="b-btn b-st-rowb b-st-paper" onClick={back}>Back to the Workshop UI</button>
      </Row>
      {/* The final dock is chosen here, in the app, rather than in the design file. */}
      <DockStylePicker />
    </section>
  );
}

export default BetaSettings;
