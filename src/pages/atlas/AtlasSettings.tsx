import { Suspense, lazy, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Minimize2, Mic, Mail, Wallet, LineChart, Plus, Check, RefreshCw, Trash2, Link2, Brain, Sparkles, Download, Music, ShieldCheck } from 'lucide-react';
import { VoiceSettingsPanel } from '@/components/atlas-health/VoiceSettingsPanel';
import { MemoryPrivacyPanel } from '@/components/atlas-health/MemoryPrivacyPanel';
import { PersonalityPanel } from '@/components/atlas-health/PersonalityPanel';
import { SoftwareUpdatePanel } from '@/components/atlas-health/SoftwareUpdatePanel';
import { EDITION } from '@/surfaces';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { ATLAS_PERMISSIONS, readOnboarding } from '@/lib/atlasPermissions';
import { Button, Panel, Row } from '@/components/atlas-ui/primitives';

// Workshop-native Settings overlay. Hosts the app's real settings (voice, mail,
// budget) behind one entry point — before this, AtlasSettingsPanel was only
// reachable via the removed legacy route. The embedded panels use shadcn
// components that read the (now warm) CSS variables, so they render in the
// Workshop palette without bespoke restyling. This is also the home for the
// brokerage/portfolio Connections panel (Phase C) and the Spotify connection —
// the latter is the consent-withdrawal control the Privacy Policy (§4.6/§5) and
// Terms (§4) point at, so it has to be as easy to reach as connecting was
// (GDPR Art. 7(3)).
//
// THE --acc TRAP, fixed here. This screen renders inside `.exp .th-cal`, where
// `--acc` is redefined as an HSL triplet. Every `hsl(var(--acc) / .12)` inline
// style below therefore painted the theme indigo `hsl(243 80% 72%)`, not Atlas
// Blue — and the same expression anywhere OUTSIDE `.exp` is an invalid
// declaration that browsers drop silently. All five are now the flat --wash
// token via <Panel tone="wash"> / <Button>, valid in every scope and the right
// colour. Likewise --negative (used 9x, defined 0x) and --positive (defined in
// index.css as a bare HSL triplet, so every `color: var(--positive)` here was
// an invalid declaration that painted nothing).

export type SettingsTab =
  | 'voice' | 'mail' | 'portfolio' | 'music' | 'budget'
  | 'personality' | 'memory' | 'permissions' | 'updates';

const TABS: { key: SettingsTab; label: string; icon: typeof Mic }[] = [
  { key: 'voice', label: 'Voice', icon: Mic },
  { key: 'mail', label: 'Mail', icon: Mail },
  { key: 'portfolio', label: 'Portfolio', icon: LineChart },
  { key: 'music', label: 'Music', icon: Music },
  { key: 'budget', label: 'Budget & AI', icon: Wallet },
  { key: 'personality', label: 'Personality', icon: Sparkles },
  { key: 'memory', label: 'Memory & Privacy', icon: Brain },
  // T4 part 2. `App.tsx` claimed permissions were "reachable again from
  // Settings so choices are revisitable" and `AtlasPermissions.tsx` tells the
  // user "you can change it later" — both were false: `/permissions` was
  // referenced only by the route, the onboarding gate and the auth screen, and
  // Settings had no entry. This tab is what makes those two sentences true.
  { key: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { key: 'updates', label: 'Software Update', icon: Download },
];

/**
 * How this instance was opened. It exists for exactly one reason: the overlay
 * closes with `setState`, the route closes with `navigate(-1)`, and code that
 * wants to LEAVE Settings for another screen has to treat those differently.
 * See `PermissionsSettings` — doing `onClose(); navigate(…)` on the route path
 * queues a history traversal that pops straight back over the push.
 */
export type SettingsMode = 'overlay' | 'route';

/**
 * Tabs the consumer edition does NOT show.
 *
 * Budget & AI is per-tier token accounting, spend history, provider health and
 * an emergency kill switch — operator instrumentation for the person running
 * the fleet, not a setting a person changes about their assistant. It was
 * shipping in the consumer bundle with no gate of any kind: "Emergency Stop",
 * "Spent (30d)", "Token usage by tier" and "Usage & cost analytics" all grepped
 * out of dist/assets, on the entry chunk, reachable from first paint.
 *
 * A LIST OF WHAT TO REMOVE, not a list of what to keep, deliberately: a new
 * tab added tomorrow ships to consumers unless someone decides otherwise, which
 * is the right default for a settings screen and the wrong one for a
 * capability gate. `budget` is the only capability here.
 */
const ADMIN_ONLY_TABS: readonly SettingsTab[] = ['budget'];

/**
 * LAZY, AND ONLY IN ADMIN. Dropping the tab from the strip hides the screen; a
 * static import still ships every string in it — the whole spend/telemetry
 * panel was landing in the consumer ENTRY chunk. `EDITION` is substituted by
 * Vite as a literal, so Rollup folds this and the dead branch's `import()`
 * emits nothing. Same device as ADMIN_LOADERS in surfaces.ts.
 */
const AtlasBudgetTab = EDITION === 'admin'
  ? lazy(() => import('@/components/atlas-ui/AtlasBudgetTab').then((m) => ({ default: m.AtlasBudgetTab })))
  : null;

export function visibleSettingsTabs(edition: string = EDITION): typeof TABS {
  if (edition !== 'consumer') return TABS;
  return TABS.filter((t) => !ADMIN_ONLY_TABS.includes(t.key));
}

export const AtlasSettings = ({
  onClose, initialTab, mode = 'overlay',
}: { onClose: () => void; initialTab?: SettingsTab; mode?: SettingsMode }) => {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'voice');
  const tabs = visibleSettingsTabs();
  // `initialTab` is a prop and deep links exist, so a hidden tab must not be
  // reachable by being asked for — the strip and the body agree on one value.
  const shownTab = tabs.some((t) => t.key === tab) ? tab : (tabs[0]?.key ?? 'voice');

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div className="exp th-cal" data-screen-label="Atlas — Settings">
      <div className="expwash" />
      <header className="ehead">
        <div className="fx ac gap16"><div className="accline" /><h1 className="etitle">Settings</h1></div>
        <button className="closeBtn" onClick={onClose}>
          <Minimize2 className="i16" /><span>Close</span><span className="kbd">Esc</span>
        </button>
      </header>
      <div className="ebody">
        <div className="col gap16" style={{ width: '28%', minWidth: 260 }}>
          <Panel pad="sm" className="col" style={{ gap: 4 }}>
            {tabs.map((t) => {
              const Icon = t.icon;
              return (
                <Button
                  key={t.key}
                  variant="text"
                  icon={<Icon className="i16" />}
                  onClick={() => setTab(t.key)}
                  aria-current={shownTab === t.key ? 'true' : undefined}
                  style={{
                    justifyContent: 'flex-start', width: '100%', padding: '0 12px',
                    background: shownTab === t.key ? 'var(--wash)' : 'transparent',
                    color: shownTab === t.key ? 'var(--acc-text)' : 'var(--ink2)',
                    fontWeight: shownTab === t.key ? 600 : 500,
                  }}
                >
                  {t.label}
                </Button>
              );
            })}
          </Panel>
        </div>
        <div className="f1 col gap16" style={{ overflowY: 'auto' }}>
          <Panel nested fill>
            {shownTab === 'voice' && <VoiceSettingsPanel />}
            {shownTab === 'mail' && <MailSettings />}
            {shownTab === 'portfolio' && <PortfolioSettings />}
            {shownTab === 'music' && <MusicSettings />}
            {shownTab === 'budget' && AtlasBudgetTab && (
              <Suspense fallback={null}><AtlasBudgetTab /></Suspense>
            )}
            {shownTab === 'personality' && <PersonalityPanel />}
            {shownTab === 'memory' && <MemoryPrivacyPanel />}
            {shownTab === 'permissions' && <PermissionsSettings onClose={onClose} mode={mode} />}
            {shownTab === 'updates' && <SoftwareUpdatePanel />}
          </Panel>
        </div>
      </div>
    </div>
  );
};

/**
 * Permissions — the revisit path the app promised and never built.
 *
 * `AtlasPermissions.tsx:25` says "You can change it later." Until now there was
 * no later: `/permissions` was reachable from the onboarding gate, the auth
 * screen and the URL bar, and from nowhere a signed-in user would look.
 *
 * Deliberately a SUMMARY plus a link, not a second set of switches. The consent
 * screen owns the choices, the copy explaining each one, and the code that
 * actually asks macOS (`requestPermission`). A duplicate switch here would be a
 * second thing to keep truthful, and the one that drifts is the one users see.
 * What it does add is the current answer — a consent record you cannot read is
 * not much of a consent record.
 */
function PermissionsSettings({ onClose, mode }: { onClose: () => void; mode: SettingsMode }) {
  const navigate = useNavigate();
  const record = readOnboarding();

  // ONE navigation, never two. On the overlay path Settings is rendered inside
  // the dashboard, so it has to be dismissed before the consent screen appears
  // — `onClose` there is a `setState`, which composes fine with a push. On the
  // ROUTE path `onClose` is `navigate(-1)`; a history traversal is queued, not
  // synchronous, so `onClose(); navigate('/permissions')` pushed /permissions
  // and then let the pending go(-1) pop straight back over it — the user landed
  // on whatever preceded Settings. Navigating away IS closing here, so the
  // route path simply navigates.
  const review = () => {
    if (mode === 'route') { navigate('/permissions'); return; }
    onClose();
    navigate('/permissions');
  };

  return (
    <div className="col gap16">
      <div>
        <h3 className="t14 fw6" style={{ color: 'var(--ink)', marginBottom: 6 }}>What Atlas may do</h3>
        <p className="fs12" style={{ color: 'var(--ink2)', lineHeight: 1.5 }}>
          These are the answers you gave when Atlas first started. Reviewing them reopens that same screen — nothing changes until you choose it there, and switching one back on re-asks macOS.
        </p>
      </div>

      <Panel pad="sm">
        {ATLAS_PERMISSIONS.map((p) => {
          const on = record?.choices?.[p.id];
          return (
            <Row
              key={p.id}
              title={p.title}
              meta={on ? p.blurb : p.withoutIt}
              trail={
                <span className="fs12" style={{ color: on ? 'var(--positive)' : 'var(--ink3)' }}>
                  {record ? (on ? 'Allowed' : 'Off') : 'Not answered'}
                </span>
              }
            />
          );
        })}
      </Panel>

      {record && (
        <p className="fs12 m0" style={{ color: 'var(--ink3)' }}>
          Answered {new Date(record.completedAt).toLocaleDateString()}.
        </p>
      )}

      <Button
        variant="primary"
        icon={<ShieldCheck className="i16" />}
        onClick={review}
        style={{ width: '100%' }}
      >
        Review permissions
      </Button>
    </div>
  );
}

// Compact mail-accounts management (connect / status / disconnect), reusing the
// same read-only Gmail flow the Mail card uses.
function MailSettings() {
  const { accounts, isConnected, isConnecting, connect, disconnect, syncNow } = useMailIntelligence();
  return (
    <div className="col gap16">
      <div>
        <h3 className="t14 fw6" style={{ color: 'var(--ink)', marginBottom: 6 }}>Connected mailboxes</h3>
        <p className="fs12" style={{ color: 'var(--ink2)', lineHeight: 1.5 }}>
          Atlas scans connected mailboxes read-only and alerts you to bills, deadlines and documents. Your mailbox is never modified.
        </p>
      </div>
      {accounts.map((a) => (
        <Panel pad="sm" className="fx ac jb" key={a.id}>
          <div style={{ minWidth: 0 }}>
            <p className="t14 fw6 trunc m0" style={{ color: 'var(--ink)' }}>{a.email_address}</p>
            <p className="fs12 m0 fx ac gap6" style={{ color: a.status === 'active' ? 'var(--positive)' : 'var(--negative)' }}>
              <Check className="i12" />{a.status === 'active' ? 'Active · read-only' : a.status}
            </p>
          </div>
          <div className="fx ac gap8">
            <Button size="icon" variant="ghost" title="Scan now" aria-label="Scan now" onClick={syncNow}><RefreshCw className="i14" /></Button>
            <Button size="icon" variant="danger" title="Disconnect" aria-label="Disconnect mailbox" onClick={() => disconnect(a.id)}><Trash2 className="i14" /></Button>
          </div>
        </Panel>
      ))}
      <Button
        variant="primary"
        icon={<Plus className="i16" />}
        loading={isConnecting}
        onClick={() => connect().catch(() => {})}
        style={{ width: '100%' }}
      >
        {isConnecting ? 'Waiting for Google…' : isConnected ? 'Connect another mailbox' : 'Connect Gmail'}
      </Button>
    </div>
  );
}

// Brokerage connections for the local portfolio engine (SnapTrade → DuckDB,
// all on-device). The link happens in SnapTrade's own portal; Atlas never sees
// brokerage credentials.
function PortfolioSettings() {
  const { available, hasCredentials, connected, summary, isConnecting, isSyncing, error, connect, sync, disconnect } = usePortfolio();
  return (
    <div className="col gap16">
      <div>
        <h3 className="t14 fw6" style={{ color: 'var(--ink)', marginBottom: 6 }}>Brokerage connection</h3>
        <p className="fs12" style={{ color: 'var(--ink2)', lineHeight: 1.5 }}>
          Link your brokerage to sync holdings and transactions. Everything is pulled read-only and stored & analyzed locally on this Mac — never in the cloud. You sign in inside your broker's own window; Atlas never sees your brokerage password.
        </p>
      </div>

      {!available && (
        <Panel pad="sm" className="fs12" style={{ color: 'var(--ink2)' }}>
          Portfolio linking runs in the Atlas desktop app. Open Atlas on your Mac to connect a brokerage.
        </Panel>
      )}

      {available && !hasCredentials && (
        <Panel pad="sm" className="fs12" style={{ color: 'var(--negative)' }}>
          SnapTrade credentials aren't configured. See docs/portfolio-setup.md.
        </Panel>
      )}

      {available && hasCredentials && (
        <>
          {connected ? (
            <Panel pad="sm" className="fx ac jb">
              <div>
                <p className="t14 fw6 m0" style={{ color: 'var(--ink)' }}>Brokerage linked</p>
                <p className="fs12 m0 fx ac gap6" style={{ color: 'var(--positive)' }}>
                  <Check className="i12" />{summary?.accounts_count ?? 0} account{(summary?.accounts_count ?? 0) === 1 ? '' : 's'} · {summary?.holdings_count ?? 0} holdings · read-only
                </p>
              </div>
              <div className="fx ac gap8">
                <Button size="icon" variant="ghost" title="Sync now" aria-label="Sync now" onClick={sync} loading={isSyncing}><RefreshCw className="i14" /></Button>
                <Button size="icon" variant="danger" title="Disconnect" aria-label="Disconnect brokerage" onClick={disconnect}><Trash2 className="i14" /></Button>
              </div>
            </Panel>
          ) : (
            <Button
              variant="primary"
              icon={<Link2 className="i16" />}
              loading={isConnecting}
              onClick={() => connect().catch(() => {})}
              style={{ width: '100%' }}
            >
              {isConnecting ? 'Opening your broker…' : 'Connect a brokerage'}
            </Button>
          )}
          {error && <p className="fs12" style={{ color: 'var(--negative)' }}>{error}</p>}
        </>
      )}
    </div>
  );
}

// Spotify connection for the music player. Playback runs on consent, so this is
// also the withdrawal control the legal docs promise: disconnecting deletes the
// Spotify refresh token from the macOS Keychain (service "atlas-music") and
// stops the playback engine. It cannot un-authorise Atlas inside Spotify — that
// lives in the Spotify account settings — so the copy says so rather than
// over-promising. Confirmation is a second click (not a typed phrase like the
// memory erase): reconnecting is a single OAuth round trip, nothing is lost.
function MusicSettings() {
  const { available, connected, premium, isConnecting, error, connect, disconnect } = useMusicPlayer();
  const [confirming, setConfirming] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const onDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await disconnect();
    } finally {
      setIsDisconnecting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="col gap16">
      <div>
        <h3 className="t14 fw6" style={{ color: 'var(--ink)', marginBottom: 6 }}>Spotify connection</h3>
        <p className="fs12" style={{ color: 'var(--ink2)', lineHeight: 1.5 }}>
          Connect Spotify to play your own library through Atlas. You sign in on Spotify's own page and Atlas never sees your Spotify password — only an access token, kept in this Mac's Keychain. Playback happens on your consent, and you can withdraw it here at any time.
        </p>
      </div>

      {!available && (
        <Panel pad="sm" className="fs12" style={{ color: 'var(--ink2)' }}>
          Music runs in the Atlas desktop app. Open Atlas on your Mac to connect or disconnect Spotify.
        </Panel>
      )}

      {available && (
        <>
          {connected ? (
            <>
              <Panel pad="sm" className="fx ac jb">
                <div>
                  <p className="t14 fw6 m0" style={{ color: 'var(--ink)' }}>Spotify connected</p>
                  <p className="fs12 m0 fx ac gap6" style={{ color: 'var(--positive)' }}>
                    <Check className="i12" />{premium ? 'Premium account · plays inside Atlas' : 'Connected · Spotify Premium is required for playback'}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="danger"
                  title="Disconnect Spotify"
                  aria-label="Disconnect Spotify"
                  onClick={() => setConfirming(true)}
                  disabled={confirming || isDisconnecting}
                >
                  <Trash2 className="i14" />
                </Button>
              </Panel>

              {confirming && (
                <Panel pad="sm" className="col gap10">
                  <p className="fs12 m0" style={{ color: 'var(--ink2)', lineHeight: 1.5 }}>
                    Disconnecting stops playback and deletes your Spotify token from this Mac's Keychain, so Atlas loses all access to your Spotify account. Your Spotify account, library and playlists are untouched — to also remove Atlas from the apps listed in your Spotify account settings, do that on Spotify's website. You can reconnect at any time.
                  </p>
                  <div className="fx ac gap8">
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Trash2 className="i14" />}
                      loading={isDisconnecting}
                      onClick={onDisconnect}
                    >
                      {isDisconnecting ? 'Disconnecting…' : 'Disconnect Spotify'}
                    </Button>
                    <Button size="sm" onClick={() => setConfirming(false)} disabled={isDisconnecting}>
                      Keep connected
                    </Button>
                  </div>
                </Panel>
              )}
            </>
          ) : (
            <Button
              variant="primary"
              icon={<Music className="i16" />}
              loading={isConnecting}
              onClick={() => connect().catch(() => {})}
              style={{ width: '100%' }}
            >
              {isConnecting ? 'Waiting for Spotify…' : 'Connect Spotify'}
            </Button>
          )}
          {error && <p className="fs12" style={{ color: 'var(--negative)' }}>{error}</p>}
        </>
      )}
    </div>
  );
}

export default AtlasSettings;
