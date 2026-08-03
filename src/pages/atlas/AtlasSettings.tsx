import { useEffect, useState } from 'react';
import { Minimize2, Mic, Mail, Wallet, LineChart, Plus, Check, RefreshCw, Trash2, Link2, Brain, Sparkles, Download, Music } from 'lucide-react';
import { VoiceSettingsPanel } from '@/components/atlas-health/VoiceSettingsPanel';
import { BudgetSettingsPanel } from '@/components/atlas-health/BudgetSettingsPanel';
import { MemoryPrivacyPanel } from '@/components/atlas-health/MemoryPrivacyPanel';
import { PersonalityPanel } from '@/components/atlas-health/PersonalityPanel';
import { SoftwareUpdatePanel } from '@/components/atlas-health/SoftwareUpdatePanel';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { Button, Panel } from '@/components/atlas-ui/primitives';

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

export type SettingsTab = 'voice' | 'mail' | 'portfolio' | 'music' | 'budget' | 'personality' | 'memory' | 'updates';

const TABS: { key: SettingsTab; label: string; icon: typeof Mic }[] = [
  { key: 'voice', label: 'Voice', icon: Mic },
  { key: 'mail', label: 'Mail', icon: Mail },
  { key: 'portfolio', label: 'Portfolio', icon: LineChart },
  { key: 'music', label: 'Music', icon: Music },
  { key: 'budget', label: 'Budget & AI', icon: Wallet },
  { key: 'personality', label: 'Personality', icon: Sparkles },
  { key: 'memory', label: 'Memory & Privacy', icon: Brain },
  { key: 'updates', label: 'Software Update', icon: Download },
];

export const AtlasSettings = ({ onClose, initialTab }: { onClose: () => void; initialTab?: SettingsTab }) => {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'voice');

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
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <Button
                  key={t.key}
                  variant="text"
                  icon={<Icon className="i16" />}
                  onClick={() => setTab(t.key)}
                  aria-current={tab === t.key ? 'true' : undefined}
                  style={{
                    justifyContent: 'flex-start', width: '100%', padding: '0 12px',
                    background: tab === t.key ? 'var(--wash)' : 'transparent',
                    color: tab === t.key ? 'var(--acc-text)' : 'var(--ink2)',
                    fontWeight: tab === t.key ? 600 : 500,
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
            {tab === 'voice' && <VoiceSettingsPanel />}
            {tab === 'mail' && <MailSettings />}
            {tab === 'portfolio' && <PortfolioSettings />}
            {tab === 'music' && <MusicSettings />}
            {tab === 'budget' && <BudgetSettingsPanel />}
            {tab === 'personality' && <PersonalityPanel />}
            {tab === 'memory' && <MemoryPrivacyPanel />}
            {tab === 'updates' && <SoftwareUpdatePanel />}
          </Panel>
        </div>
      </div>
    </div>
  );
};

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
