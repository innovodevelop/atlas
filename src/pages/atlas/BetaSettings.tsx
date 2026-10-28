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
 * mailboxes and the brokerage, both of which delete stored data. Voice adds
 * how Atlas listens (src/lib/voiceInput.ts, read by the voice session), and
 * Memory & Privacy the "Remember things I share" switch the brain obeys
 * (src/hooks/useMemorySettings.ts).
 *
 * "This Mac" reads and switches the Mac itself through src/hooks/
 * useMacControls.ts (Rust: src-tauri/src/mac_controls.rs): Wi-Fi power,
 * join and forget; Bluetooth power and connections when blueutil
 * is installed; the Mac's chip, memory, storage and processor; the battery's
 * 24-hour history, health and energy use, and the switch that pauses the
 * sphere (`atlas:sphere_paused`, src/lib/spherePause.ts). What needs an
 * administrator or has no tool stays out and the screen says so: Disconnect
 * (macOS rejoins at once), per-network auto-join and "ask to join", Low
 * Power Mode (shown read-only), optimised
 * charging, pairing, and Bluetooth without blueutil. Software Update adds the
 * two automatic-update switches (src/lib/updatePrefs.ts) and Restart Atlas
 * (the Rust `app_restart`). "Beta UI" is the way back.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { EDITION } from '@/surfaces';
import { useAtlasSettings, type AtlasSettings as VoiceDials } from '@/hooks/useAtlasSettings';
import { useStreamingTTS } from '@/hooks/useStreamingTTS';
import { usePersonality } from '@/hooks/usePersonality';
import { useAppUpdater } from '@/hooks/useAppUpdater';
import { isUserMailbox, useMailIntelligence, type MailAccount } from '@/hooks/useMailIntelligence';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { useSystemVitals, type BtDevice, type SystemVitalsState } from '@/hooks/useSystemVitals';
import { restartAtlas, useBatteryDetails, useBluetoothControls, useMacDetails, useWifiControls } from '@/hooks/useMacControls';
import { useRememberShared } from '@/hooks/useMemorySettings';
import {
  currentNetworkLine, gigabytes, historyBars, knownNetworkLine, macMeters, otherNetworkLine, otherNetworks, rateLabel, signalLine, uptimeLabel,
  wifiHeadline, type MeterTone, type NearbyNetwork, type PairedDevice,
} from '@/lib/macProbes';
import { onVoiceInputChange, readVoiceInput, setVoiceInput, type VoiceInputPrefs } from '@/lib/voiceInput';
import { onUpdatePrefsChange, readUpdatePrefs, setUpdatePrefs, type UpdatePrefs } from '@/lib/updatePrefs';
import { readSpherePaused, setSpheresPaused } from '@/lib/spherePause';
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
  const badgeCtx = { mailAttention, updateAvailable: updater.phase === 'available' || updater.phase === 'downloaded' };

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
          {current === 'memory' ? <MemorySection /> : null}
          {current === 'permissions' ? <PermissionsSection onReview={() => plainNavigate('/permissions')} /> : null}
          {current === 'mail' ? <MailSection mail={mail} say={say} /> : null}
          {current === 'portfolio' ? <PortfolioSection say={say} /> : null}
          {current === 'music' ? <MusicSection say={say} /> : null}
          {current === 'wifi' ? <WifiSection say={say} /> : null}
          {current === 'bluetooth' ? <BluetoothSection say={say} /> : null}
          {current === 'devices' ? <DevicesSection vitals={vitals} version={version} /> : null}
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

/** One row of a card: the round icon chip, a title and a line, an optional meter and trail, then its buttons. */
function Row({ icon, chip = 'quiet', title, sub, subTone = 'quiet', trail, trailTone, emphasis, meter, children }: {
  icon?: IconName; chip?: ChipTone; title: string; sub?: string; subTone?: LineTone; trail?: string; trailTone?: 'ok' | 'warn' | 'ink';
  emphasis?: boolean; meter?: { pct: number; tone?: MeterTone } | null; children?: ReactNode;
}) {
  return (
    <div className={`b-st-row${emphasis ? ' b-st-row--emphasis' : ''}`}>
      {icon ? <span className={`b-st-row-ico b-st-row-ico--${chip}`}><AtlasIcon name={icon} size={17} weight={1.5} /></span> : null}
      <div className="b-st-row-text">
        <p className="b-st-row-t">{title}</p>
        {sub ? <p className={`b-st-row-s b-st-row-s--${subTone}`}>{sub}</p> : null}
        {meter ? (
          <div className={`b-st-meter b-st-meter--${meter.tone ?? 'ink'}`} role="meter" aria-label={title} aria-valuenow={Math.round(meter.pct)} aria-valuemin={0} aria-valuemax={100}>
            <b style={{ width: `${Math.max(0, Math.min(100, meter.pct))}%` }} />
          </div>
        ) : null}
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

/** The design's on/off switch (the shell's .b-switch). */
function Toggle({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`b-switch b-st-switch${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The browser preview's stand-in for a section that only the Mac app can run. */
function MacOnly({ title, icon, what }: { title: string; icon: IconName; what: string }) {
  return (
    <section className="b-st-card" aria-label={title}>
      <CardHead title={title} />
      <Row icon={icon} title="Runs in the Mac app" sub={`${what} run in the Atlas desktop app. Open Atlas on your Mac to use them.`} />
    </section>
  );
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
  // How Atlas listens: stored on this Mac, read live by the voice session.
  const [input, setInput] = useState<VoiceInputPrefs>(readVoiceInput);
  useEffect(() => onVoiceInputChange(setInput), []);
  const flip = (key: keyof VoiceInputPrefs) => (on: boolean) => setInput(setVoiceInput({ [key]: on }));
  const wakeTitle = `Listen for ${(phrases.length ? phrases : ['Hey Atlas']).map((p) => `“${p}”`).join(' or ')}`;

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
          title={wakeTitle}
          sub={phrases.length ? 'Wake word is detected on-device. Nothing is sent until Atlas wakes.' : 'The wake-word model did not load; the microphone button and push to talk still work.'}
        >
          <Toggle on={input.wakeWord} label={wakeTitle} onChange={flip('wakeWord')} />
        </Row>
        <Row title="Push to talk" sub="Hold the right ⌥ Option key on Home or the Voice screen to speak, and release to send. macOS keeps fn for itself, so Option stands in. Works alongside the wake word.">
          <Toggle on={input.pushToTalk} label="Push to talk" onChange={flip('pushToTalk')} />
        </Row>
        <Row title="Mute when the Mac is locked" sub="Atlas stops listening the moment the screen locks.">
          <Toggle on={input.muteWhenLocked} label="Mute when the Mac is locked" onChange={flip('muteWhenLocked')} />
        </Row>
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
    if (ok) { setImapOpen(false); setImap(EMPTY_IMAP); say('Mailbox connected'); } else setImapFailed(true);
  };

  const hasGmail = accounts.some((a) => a.provider === 'gmail');
  const hasOutlook = accounts.some((a) => a.provider === 'outlook');
  const waiting = connectingProvider === 'outlook' ? 'Waiting for Microsoft…' : 'Waiting for Google…';

  return (
    <>
      <section className="b-st-card" aria-label="Connected mailboxes">
        <CardHead title="Connected mailboxes" sub="Atlas scans connected mailboxes read-only, every 15 minutes while it is open, and alerts you to bills, deadlines and documents. Your mailbox is never modified." />
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
          <CardHead title="Connect a mailbox over IMAP" sub="For iCloud, Fastmail, Yahoo and most other providers. Atlas reads the inbox over TLS only and never changes it. Many providers need an app-specific password here, not your normal one." />
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

/** A Wi-Fi network name as 802.11 allows it (1–32 bytes); mac_controls.rs checks it again. */
function ssidOk(name: string): boolean {
  const bytes = new TextEncoder().encode(name).length;
  return bytes > 0 && bytes <= 32;
}

/**
 * One action at a time per section: which control is working, the last
 * failure in the tool's own words, and a runner that records both. A toast
 * only follows an action the command confirmed.
 */
function useMacAction(say: Say) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run = useCallback(async (key: string, action: () => Promise<void>, done?: string): Promise<boolean> => {
    setBusy(key);
    setFailure(null);
    try {
      await action();
      if (done) say(done);
      return true;
    } catch (e) {
      setFailure(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, [say]);
  return { busy, failure, setFailure, run };
}

/** The join form: which network, and whether its name was picked from a list (then it is not editable). */
interface JoinTarget { ssid: string; fixed: boolean }

/** Known networks listed before "Show all": a Mac that has travelled knows a hundred or more. */
const KNOWN_SHOWN = 8;

/**
 * Wi-Fi, over useWifiControls: the power switch, the network in use with its
 * signal, speed, address and router, the known networks (join, forget), the
 * networks in range, and joining one by name with a password.
 * The password lives in this form's state only while it is typed; it goes to
 * `wifi_join` as an argument and the field is emptied whatever the outcome.
 */
function WifiSection({ say }: { say: Say }) {
  const ctl = useWifiControls({ scan: true });
  const { busy, failure, setFailure, run } = useMacAction(say);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [form, setForm] = useState<JoinTarget | null>(null);
  const [password, setPassword] = useState('');
  const [allKnown, setAllKnown] = useState(false);

  if (!ctl.available) return <MacOnly title="Wi-Fi" icon="wi-fi" what="Turning Wi-Fi on and off, joining and forgetting networks" />;
  const w = ctl.wifi;

  const openForm = (target: JoinTarget) => { setForm(target); setPassword(''); setFailure(null); };
  const closeForm = () => { setForm(null); setPassword(''); setFailure(null); };
  // A known network joins with the password macOS already holds; when it
  // will not, the form opens for one, with the tool's reason above it.
  const joinKnown = async (ssid: string) => {
    const ok = await run(`join:${ssid}`, () => ctl.join(ssid), `Joined ${ssid}`);
    if (!ok) { setForm({ ssid, fixed: true }); setPassword(''); }
  };
  const joinOther = (n: NearbyNetwork) => {
    if (n.security && n.security !== 'Open') openForm({ ssid: n.name, fixed: true });
    else void run(`join:${n.name}`, () => ctl.join(n.name), `Joined ${n.name}`);
  };
  const formSsid = form ? (form.fixed ? form.ssid : form.ssid.trim()) : '';
  const submit = async () => {
    const ssid = formSsid;
    if (!form || !ssidOk(ssid)) return;
    const secret = password;
    setPassword('');
    const ok = await run(`join:${ssid}`, () => ctl.join(ssid, secret || undefined), `Joined ${ssid}`);
    if (ok) setForm(null);
  };
  const joining = busy?.startsWith('join:') ? busy.slice(5) : null;
  const known = w ? w.known.filter((n) => n !== w.ssid) : [];
  const others = w ? otherNetworks(w) : [];

  return (
    <>
      <section className="b-st-card" aria-label="Wi-Fi">
        <CardHead title="Wi-Fi" sub={joining ? `Joining ${joining}…` : w ? wifiHeadline(w) : ctl.error ?? 'Checking…'}>
          {w?.power != null ? (
            <Toggle on={w.power} label="Wi-Fi" disabled={busy != null} onChange={(on) => void run('power', () => ctl.setPower(on), on ? 'Wi-Fi on' : 'Wi-Fi off')} />
          ) : null}
        </CardHead>
        {w && w.power == null ? <p className="b-st-note">macOS reports no Wi-Fi on this Mac.</p> : null}
        {failure && !form && !confirm ? <p className="b-st-err" role="alert">{failure}</p> : null}
      </section>

      {w?.power && w.connected ? (
        <section className="b-st-card b-st-card--current" aria-label="Current network">
          <CardHead title={w.ssid ?? 'Wi-Fi network'} sub={currentNetworkLine(w)} />
          <div className="b-st-stats">
            <Stat k="Signal" v={signalLine(w.link?.signal ?? null) ?? (ctl.scanning ? '…' : '—')} />
            <Stat k="Speed" v={rateLabel(w.link?.rateMbps ?? null) ?? (ctl.scanning ? '…' : '—')} />
            <Stat k="IP address" v={w.ip ?? '—'} />
            <Stat k="Router" v={w.router ?? '—'} />
          </div>
          {w.nameHidden ? <p className="b-st-note">macOS tells apps a network’s name only with Location Services access, which Atlas does not ask for.</p> : null}
          {/* No Disconnect: macOS rejoins a known network about a second after any app leaves it (mac_controls.rs). */}
          <p className="b-st-note">macOS rejoins known networks on its own, so leaving this one for good means forgetting it below or turning Wi-Fi off.</p>
        </section>
      ) : null}

      {w?.power && known.length ? (
        <section className="b-st-card" aria-label="Known networks">
          <CardHead title="Known networks" sub="This Mac joins these on its own when one is in range. Turning auto-join off for one needs an administrator, in System Settings → Wi-Fi." />
          {(allKnown ? known : known.slice(0, KNOWN_SHOWN)).map((n) => (
            <div key={n}>
              <Row icon="wi-fi" chip={joining === n ? 'on' : 'quiet'} title={n} sub={joining === n ? 'Joining…' : knownNetworkLine(n, w)} subTone={joining === n ? 'blue' : 'quiet'}>
                <button type="button" className="b-btn b-btn--tinted b-st-rowb" disabled={busy != null} onClick={() => void joinKnown(n)}>{joining === n ? 'Joining…' : 'Join'}</button>
                <button type="button" className="b-btn b-btn--ghost b-st-rowb" aria-expanded={confirm === n} disabled={busy != null} onClick={() => { setConfirm(confirm === n ? null : n); setFailure(null); }}>Forget</button>
              </Row>
              {confirm === n ? (
                <Confirm
                  text={`Forget ${n}? This Mac won’t join it again until you enter the password.`}
                  go="Forget network" busy={busy === `forget:${n}`}
                  onGo={() => void run(`forget:${n}`, () => ctl.forget(n), 'Network forgotten').then((ok) => { if (ok) setConfirm(null); })}
                  onKeep={() => { setConfirm(null); setFailure(null); }}
                />
              ) : null}
              {confirm === n && failure ? <p className="b-st-err" role="alert">{failure}</p> : null}
            </div>
          ))}
          {known.length > KNOWN_SHOWN ? (
            <div className="b-st-actions">
              <button type="button" className="b-btn" aria-expanded={allKnown} onClick={() => setAllKnown(!allKnown)}>{allKnown ? 'Show fewer' : `Show all ${known.length}`}</button>
            </div>
          ) : null}
        </section>
      ) : null}

      {w?.power ? (
        <section className="b-st-card" aria-label="Other networks">
          <CardHead title="Other networks" sub={ctl.scanning && !w.nearby ? 'Looking for networks…' : undefined}>
            <button type="button" className="b-btn b-btn--tinted b-st-rowb" disabled={ctl.scanning} onClick={() => void ctl.scan()}>{ctl.scanning ? 'Scanning…' : 'Scan again'}</button>
          </CardHead>
          {others.map((n) => (
            <Row key={n.name} icon="wi-fi" chip={joining === n.name ? 'on' : 'quiet'} title={n.name} sub={joining === n.name ? 'Joining…' : otherNetworkLine(n)} subTone={joining === n.name ? 'blue' : 'quiet'}>
              <button type="button" className="b-btn b-btn--tinted b-st-rowb" disabled={busy != null} onClick={() => joinOther(n)}>{joining === n.name ? 'Joining…' : 'Join'}</button>
            </Row>
          ))}
          {w.nearby && !others.length && !w.hiddenNearby ? <div className="b-empty"><p><b>No other networks in range</b></p><p>Scan again, or join one by its name.</p></div> : null}
          {w.hiddenNearby ? (
            <p className="b-st-note">
              {w.hiddenNearby === 1 ? 'One more network is' : `${w.hiddenNearby} more networks are`} in range. macOS hides their names from apps without Location Services access, so join one by its name below.
            </p>
          ) : null}
          {!form ? (
            <div className="b-st-actions">
              <button type="button" className="b-btn" disabled={busy != null} onClick={() => openForm({ ssid: '', fixed: false })}>Join another network…</button>
            </div>
          ) : null}
        </section>
      ) : null}

      {w?.power && form ? (
        <section className="b-st-card b-st-form" aria-label="Join a network">
          <CardHead
            title={form.fixed ? `Join ${form.ssid}` : 'Join a network'}
            sub="The password goes straight to macOS, which keeps it in the Keychain as it does for every network. Atlas never stores it. Leave it empty for an open network."
          />
          {!form.fixed ? (
            <input
              className="b-input" autoComplete="off" spellCheck={false} maxLength={32} placeholder="Network name" aria-label="Network name"
              value={form.ssid} onChange={(e) => { setForm({ ssid: e.target.value, fixed: false }); setFailure(null); }}
            />
          ) : null}
          <input
            className="b-input" type="password" autoComplete="off" spellCheck={false} maxLength={64} placeholder="Password" aria-label="Password"
            value={password} onChange={(e) => { setPassword(e.target.value); setFailure(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          {failure ? <p className="b-st-err" role="alert">{failure}</p> : null}
          <div className="b-st-form-actions">
            <button type="button" className="b-btn b-btn--primary" disabled={busy != null || !ssidOk(formSsid)} onClick={() => void submit()}>{joining ? 'Joining…' : 'Join'}</button>
            <button type="button" className="b-btn" disabled={busy != null} onClick={closeForm}>Cancel</button>
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * Bluetooth, over useBluetoothControls: power and connecting paired devices
 * when blueutil is installed, and otherwise the same list read-only with what
 * the switches need.
 */
function BluetoothSection({ say }: { say: Say }) {
  const ctl = useBluetoothControls();
  const { busy, failure, run } = useMacAction(say);

  if (!ctl.available) return <MacOnly title="Bluetooth" icon="bluetooth" what="Bluetooth and the devices paired with this Mac" />;
  const bt = ctl.bluetooth;
  const devices = bt?.devices ?? [];
  const connected = devices.filter((d) => d.connected);
  const low = connected.filter((d) => d.battery != null && d.battery <= 15);
  const canAct = !!bt?.canSwitch && bt.on === true;
  const sub = bt == null
    ? (ctl.error ?? 'Checking… the first Bluetooth read takes a moment.')
    : bt.on === false
      ? 'Off. AirPods, trackpads and Apple Watch unlock are paused until you turn it back on.'
      : `${connected.length} connected`;
  const toggleDevice = (d: PairedDevice, key: string) => {
    if (!d.address) return;
    const address = d.address;
    void run(key, () => ctl.setConnected(address, !d.connected), d.connected ? `${d.name} disconnected` : `${d.name} connected`);
  };

  return (
    <>
      <section className="b-st-card" aria-label="Bluetooth">
        <CardHead title="Bluetooth" sub={sub}>
          {bt?.canSwitch && bt.on != null ? (
            <Toggle on={bt.on} label="Bluetooth" disabled={busy != null} onChange={(on) => void run('power', () => ctl.setPower(on), on ? 'Bluetooth on' : 'Bluetooth off')} />
          ) : null}
        </CardHead>
        {bt && !bt.canSwitch ? (
          <p className="b-st-note">
            Switching Bluetooth and connecting devices from Atlas needs the free blueutil tool (brew install blueutil), which is not on this Mac. Atlas never installs it; until then this list is read-only, and the macOS menu bar has the switches.
          </p>
        ) : null}
        {failure ? <p className="b-st-err" role="alert">{failure}</p> : null}
      </section>

      {bt?.on !== false ? (
        <section className="b-st-card" aria-label="My devices">
          <CardHead title="My devices" sub={bt && !devices.length ? undefined : 'Paired with this Mac. Pairing and removing devices stay in System Settings → Bluetooth.'} />
          {devices.map((d, i) => {
            // macOS can list one device twice (an iPhone seen over two radios), so the index keeps keys apart.
            const key = `dev:${d.address ?? d.name}-${i}`;
            const working = busy === key;
            return (
              <Row
                key={key} icon={btIcon({ name: d.name, kind: d.kind })} chip={d.connected ? 'ink' : 'quiet'} title={d.name}
                sub={working ? (d.connected ? 'Disconnecting…' : 'Connecting…') : d.connected ? `${d.kind ?? 'Bluetooth device'} · connected` : 'Not connected'}
                subTone={working ? 'blue' : 'quiet'}
                trail={d.connected && d.battery != null ? `${d.battery}%` : undefined} trailTone={d.battery != null && d.battery <= 15 ? 'warn' : 'ink'}
              >
                {canAct && d.address ? (
                  <button type="button" className={`b-btn b-st-rowb ${d.connected ? 'b-st-paper' : 'b-btn--tinted'}`} disabled={busy != null} onClick={() => toggleDevice(d, key)}>
                    {working ? '…' : d.connected ? 'Disconnect' : 'Connect'}
                  </button>
                ) : null}
              </Row>
            );
          })}
          {bt && !devices.length ? <div className="b-empty"><p><b>No paired devices</b></p><p>Pair one in System Settings → Bluetooth; it appears here and in the top bar.</p></div> : null}
          {bt == null ? <div className="b-empty"><p><b>Looking for devices</b></p><p>The first check takes a moment.</p></div> : null}
          {low.length ? <p className="b-st-note b-st-note--warn">{low.map((d) => d.name).join(', ')} {low.length === 1 ? 'is' : 'are'} low on battery. Charge soon.</p> : null}
        </section>
      ) : null}
    </>
  );
}

function DeviceRow({ d }: { d: BtDevice }) {
  const low = d.battery_percent != null && d.battery_percent <= 15;
  return (
    <Row icon={btIcon(d)} chip="ink" title={d.name} sub={`${d.kind ?? 'Bluetooth device'} · connected`}
      trail={d.battery_percent != null ? `${d.battery_percent}%` : undefined} trailTone={low ? 'warn' : 'ink'} />
  );
}

/** This Mac: what it is (chip, memory, macOS, Atlas), how long it has been up, and the three meters. */
function DevicesSection({ vitals, version }: { vitals: SystemVitalsState; version: string | null }) {
  const { available, mac, error } = useMacDetails();
  const bt = vitals.bluetooth;
  if (!available) return <MacOnly title="This Mac" icon="mac" what="The chip, memory, storage and processor readings" />;
  const meters = mac ? macMeters(mac) : null;
  const uptime = mac ? uptimeLabel(mac.bootedAt, Date.now()) : null;
  const pending = mac ? '—' : '…';
  return (
    <>
      <section className="b-st-card" aria-label="This Mac">
        <CardHead title={mac?.name ?? 'This Mac'} sub={mac ? ['This Mac', uptime].filter(Boolean).join(' · ') : error ?? 'Reading this Mac…'} />
        <div className="b-st-stats">
          <Stat k="Chip" v={mac?.chip ?? pending} />
          <Stat k="Memory" v={mac?.memoryBytes != null ? gigabytes(mac.memoryBytes, true) : pending} />
          <Stat k="macOS" v={mac?.macos ?? pending} />
          <Stat k="Atlas" v={version ?? '…'} />
        </div>
        <Row title="Processor" sub={meters?.processor?.sub ?? pending} meter={meters?.processor} />
        <Row title="Memory" sub={meters?.memory?.sub ?? pending} meter={meters?.memory} />
        <Row title="Storage" sub={meters?.storage?.sub ?? pending} meter={meters?.storage} />
      </section>
      <section className="b-st-card" aria-label="Connected devices">
        <CardHead title="Connected now" sub="Bluetooth devices this Mac is using right now. Connect and disconnect them under Bluetooth." />
        {(bt?.connected ?? []).map((d, i) => <DeviceRow d={d} key={`${d.name}-${i}`} />)}
        {!bt?.connected.length ? <p className="b-st-note">{bt == null ? 'Looking for Bluetooth devices…' : 'No Bluetooth devices are connected right now.'}</p> : null}
      </section>
    </>
  );
}

/**
 * Battery: the charge with its last 24 hours (recorded every ten minutes by
 * mac_controls.rs), what is using the processor, Low Power Mode as macOS has
 * it (read-only: switching it needs an administrator), the switch that holds
 * the sphere still, and the battery's health.
 */
function BatterySection({ vitals }: { vitals: SystemVitalsState }) {
  const { available, battery: detail } = useBatteryDetails();
  const [paused, setPaused] = useState(readSpherePaused);
  const b = vitals.battery;
  const loading = reading(vitals);
  const head = batteryHeadline(b, loading);
  const hist = detail?.present ? historyBars(detail.history, Date.now()) : null;
  const recorded = hist ? hist.bars.filter((x) => x.percent != null).length : 0;
  const pauseTitle = 'Pause the sphere';
  const flipPause = (on: boolean) => { setSpheresPaused(on); setPaused(on); };
  const lowPower = detail?.lowPowerMode;

  return (
    <>
      <section className="b-st-card" aria-label="Battery">
        <div className="b-st-bat">
          <div className="b-st-bat-left">
            <span className="b-st-kicker">{lowPower ? 'Low Power Mode' : head.kicker}{vitals.fixture ? ' · sample' : ''}</span>
            <span className="b-st-bat-big b-num">{head.big}</span>
            <span className="b-st-bat-line">{head.line}</span>
            <div className={`b-st-bar b-st-bar--${head.tone}`} role="progressbar" aria-valuenow={b?.percent ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Charge"><b style={{ width: `${b?.percent ?? 0}%` }} /></div>
          </div>
          {hist ? (
            <div className="b-st-hist">
              <div className="b-st-hist-head"><span>Last 24 hours</span><small>Charge level</small></div>
              <div className="b-st-hist-bars" role="img" aria-label={`Charge level over the last 24 hours: ${recorded} of 24 hours recorded`}>
                {hist.bars.map((x, i) => (
                  <span key={i} className={`b-st-hist-bar b-st-hist-bar--${x.tone}`} style={x.percent != null ? { height: `${Math.max(4, x.percent)}%` } : undefined} title={x.title} />
                ))}
              </div>
              <div className="b-st-hist-axis"><span>{hist.startLabel}</span><span>{hist.midLabel}</span><span>Now</span></div>
              <div className="b-st-hist-key"><span><i className="b-st-hist-key--battery" />On battery</span><span><i className="b-st-hist-key--power" />Plugged in</span></div>
              {recorded < 2 ? <p className="b-st-note">Atlas records the charge every ten minutes while it runs, so the chart fills in over the next day.</p> : null}
            </div>
          ) : (
            <div className="b-st-stats b-st-stats--start">
              <Stat k="Power" v={b ? (b.on_power ? 'Adapter' : 'Battery') : loading ? '…' : 'Mains'} />
              <Stat k="Charging" v={b ? (b.charging ? 'Yes' : 'No') : loading ? '…' : '—'} ok={!!b?.charging} />
              <Stat k="Source" v={vitals.fixture ? 'Sample' : 'This Mac'} />
            </div>
          )}
        </div>
      </section>

      {detail?.energy.length ? (
        <section className="b-st-card" aria-label="Using significant energy">
          <CardHead title="Using significant energy" sub="Each app’s share of the processor right now. macOS reports energy per app only to Activity Monitor; the processor is the part an app decides." />
          {detail.energy.map((r) => (
            <Row
              key={r.name} title={r.name} sub={r.atlas ? `Atlas and its helpers · ${r.processes} ${r.processes === 1 ? 'process' : 'processes'}` : `${r.processes} ${r.processes === 1 ? 'process' : 'processes'}`}
              meter={{ pct: r.share, tone: r.atlas ? 'blue' : 'ink' }} trail={`${r.share}%`} trailTone="ink"
            />
          ))}
        </section>
      ) : null}

      <section className="b-st-card" aria-label="Power">
        <CardHead title="Power" />
        {available ? (
          <Row
            title="Low Power Mode"
            sub="Set in System Settings → Battery. Switching it needs an administrator’s password, so Atlas shows it and leaves the switch to macOS."
            trail={lowPower == null ? (detail ? '—' : '…') : lowPower ? 'On' : 'Off'} trailTone={lowPower ? 'ok' : undefined}
          />
        ) : null}
        <Row title={pauseTitle} sub="The Veil sphere holds still on every screen to save energy. Its colour still shows when Atlas is listening or speaking.">
          <Toggle on={paused} label={pauseTitle} onChange={flipPause} />
        </Row>
      </section>

      {detail?.present ? (
        <section className="b-st-card" aria-label="Battery health">
          <CardHead title="Battery health" />
          <div className="b-st-stats">
            <Stat k="Maximum capacity" v={detail.maxCapacityPct != null ? `${detail.maxCapacityPct}%` : '—'} />
            <Stat k="Cycle count" v={detail.cycleCount != null ? String(detail.cycleCount) : '—'} />
            <Stat k="Condition" v={detail.condition ?? '—'} ok={/^(good|normal)$/i.test(detail.condition ?? '')} />
          </div>
        </section>
      ) : null}
    </>
  );
}

/* ── Memory & Privacy ────────────────────────────────────────────────────── */

/** The "Remember things I share" switch the brain obeys, above the Workshop's own memory panel. */
function MemorySection() {
  const remember = useRememberShared();
  const title = 'Remember things I share';
  const sub = 'Atlas saves facts from conversation, like names, plans and preferences, and a short summary of each chat. Off means it only remembers what you ask it to.';
  return (
    <>
      <section className="b-st-card" aria-label="Remembering">
        <CardHead title="Remembering" />
        <Row
          title={title} sub={remember.available ? sub : `${sub} The switch is kept on this Mac, in the Atlas desktop app.`}
          trail={remember.available && remember.on == null && !remember.error ? '…' : undefined}
        >
          {remember.available && remember.on != null ? (
            <Toggle on={remember.on} label={title} disabled={remember.saving} onChange={(on) => void remember.set(on)} />
          ) : null}
        </Row>
        {remember.error ? <p className="b-st-note b-st-note--warn">{remember.error}</p> : null}
      </section>
      <section className="b-st-card b-st-embed" aria-label="Memory and privacy"><MemoryPrivacyPanel /></section>
    </>
  );
}

/* ── Software Update ─────────────────────────────────────────────────────── */

function UpdatesSection({ updater, version }: { updater: ReturnType<typeof useAppUpdater>; version: string | null }) {
  const [prefs, setPrefs] = useState<UpdatePrefs>(readUpdatePrefs);
  useEffect(() => onUpdatePrefsChange(setPrefs), []);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const card = updateCard({
    supported: updater.supported,
    phase: updater.phase,
    version,
    available: updater.update ? { version: updater.update.version, date: updater.update.date } : null,
    error: updater.error,
    downloaded: updater.progress.downloaded,
    total: updater.progress.total,
    installOvernight: prefs.installOvernight,
    restarting,
  });
  const busy = updater.phase === 'checking' || updater.phase === 'downloading' || updater.phase === 'installing' || restarting;
  const flip = (key: keyof UpdatePrefs) => (on: boolean) => setPrefs(setUpdatePrefs({ [key]: on }));
  // The window closes moments after `app_restart` answers, so "Restarting…"
  // stays up; a refusal brings the button back with the reason.
  const restart = async () => {
    setRestarting(true);
    setRestartError(null);
    try {
      await restartAtlas();
    } catch (e) {
      setRestarting(false);
      setRestartError(`Atlas could not restart itself: ${errorText(e)}. Quit and reopen it instead.`);
    }
  };
  const act = () => {
    if (card.action === 'install') void updater.install();
    else if (card.action === 'restart') void restart();
    else void updater.check();
  };
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
        {(updater.phase === 'available' || updater.phase === 'downloaded') && updater.update?.notes ? <div className="b-st-notes">{updater.update.notes}</div> : null}
        {card.action ? (
          <div className="b-st-actions">
            <button type="button" className={`b-btn ${card.action === 'check' ? 'b-btn--tinted' : 'b-btn--primary'}`} disabled={busy} onClick={act}>{card.actionLabel}</button>
          </div>
        ) : null}
      </section>
      {updater.supported ? (
        <section className="b-st-card" aria-label="Automatic updates">
          <CardHead title="Automatic updates" sub="Off until you switch them on. Every update is signature-verified before anything is installed, either way." />
          <Row title="Download updates automatically" sub="Atlas checks the release feed every six hours and downloads a new version in the background. Installing still waits for you, or for the night.">
            <Toggle on={prefs.autoDownload} label="Download updates automatically" onChange={flip('autoDownload')} />
          </Row>
          <Row title="Install overnight" sub="When plugged in and idle between 2 and 5 AM. Atlas installs the update and restarts itself; conversations and memories carry over.">
            <Toggle on={prefs.installOvernight} label="Install overnight" onChange={flip('installOvernight')} />
          </Row>
        </section>
      ) : null}
      <section className="b-st-card" aria-label="Current version">
        <CardHead title="Current version" sub="Updates come from the signed release feed; nothing unsigned or altered is ever installed." />
        <div className="b-st-stats">
          <Stat k="Atlas" v={version ?? (updater.supported ? '…' : 'Browser preview')} />
          <Stat k="Signature" v="Verified before install" ok />
          <Stat k="Installs" v={prefs.installOvernight ? 'Overnight, or when you approve' : 'Only when you approve'} />
        </div>
        {updater.supported && card.action !== 'restart' ? (
          <Row title="Restart Atlas" sub="Quits and reopens Atlas, its brain and its voice. Settings that take effect on a restart apply then.">
            <button type="button" className="b-btn b-st-paper b-st-rowb" disabled={busy} onClick={() => void restart()}>{restarting ? 'Restarting…' : 'Restart Atlas'}</button>
          </Row>
        ) : null}
        {restartError ? <p className="b-st-note b-st-note--warn">{restartError}</p> : null}
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
