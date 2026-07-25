import { useEffect, useState } from 'react';
import { Minimize2, Mic, Mail, Wallet, LineChart, Plus, Check, RefreshCw, Trash2, Link2, Brain, Sparkles, Download } from 'lucide-react';
import { VoiceSettingsPanel } from '@/components/atlas-health/VoiceSettingsPanel';
import { BudgetSettingsPanel } from '@/components/atlas-health/BudgetSettingsPanel';
import { MemoryPrivacyPanel } from '@/components/atlas-health/MemoryPrivacyPanel';
import { PersonalityPanel } from '@/components/atlas-health/PersonalityPanel';
import { SoftwareUpdatePanel } from '@/components/atlas-health/SoftwareUpdatePanel';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';
import { usePortfolio } from '@/hooks/usePortfolio';

// Workshop-native Settings overlay. Hosts the app's real settings (voice, mail,
// budget) behind one entry point — before this, AtlasSettingsPanel was only
// reachable via the removed legacy route. The embedded panels use shadcn
// components that read the (now warm) CSS variables, so they render in the
// Workshop palette without bespoke restyling. This is also the home for the
// brokerage/portfolio Connections panel (Phase C).

type SettingsTab = 'voice' | 'mail' | 'portfolio' | 'budget' | 'personality' | 'memory' | 'updates';

const TABS: { key: SettingsTab; label: string; icon: typeof Mic }[] = [
  { key: 'voice', label: 'Voice', icon: Mic },
  { key: 'mail', label: 'Mail', icon: Mail },
  { key: 'portfolio', label: 'Portfolio', icon: LineChart },
  { key: 'budget', label: 'Budget & AI', icon: Wallet },
  { key: 'personality', label: 'Personality', icon: Sparkles },
  { key: 'memory', label: 'Memory & Privacy', icon: Brain },
  { key: 'updates', label: 'Software Update', icon: Download },
];

export const AtlasSettings = ({ onClose }: { onClose: () => void }) => {
  const [tab, setTab] = useState<SettingsTab>('voice');

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
          <div className="gpanel col" style={{ gap: 4 }}>
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  className="fx ac gap10 t14"
                  onClick={() => setTab(t.key)}
                  style={{
                    padding: '11px 12px', borderRadius: 12, border: 'none', cursor: 'pointer',
                    fontFamily: 'inherit', textAlign: 'left', width: '100%',
                    background: tab === t.key ? 'hsl(var(--acc) / .1)' : 'transparent',
                    color: tab === t.key ? 'hsl(var(--acc))' : 'hsl(240 20% 40%)',
                    fontWeight: tab === t.key ? 600 : 500,
                  }}
                >
                  <Icon className="i16" />{t.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="f1 col gap16" style={{ overflowY: 'auto' }}>
          <div className="gpanel2 f1">
            {tab === 'voice' && <VoiceSettingsPanel />}
            {tab === 'mail' && <MailSettings />}
            {tab === 'portfolio' && <PortfolioSettings />}
            {tab === 'budget' && <BudgetSettingsPanel />}
            {tab === 'personality' && <PersonalityPanel />}
            {tab === 'memory' && <MemoryPrivacyPanel />}
            {tab === 'updates' && <SoftwareUpdatePanel />}
          </div>
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
        <h3 className="t14 fw6" style={{ color: 'hsl(240 30% 20%)', marginBottom: 6 }}>Connected mailboxes</h3>
        <p className="fs12" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
          Atlas scans connected mailboxes read-only and alerts you to bills, deadlines and documents. Your mailbox is never modified.
        </p>
      </div>
      {accounts.map((a) => (
        <div className="fx ac jb gpanel" key={a.id} style={{ padding: 14 }}>
          <div style={{ minWidth: 0 }}>
            <p className="t14 fw6 trunc m0" style={{ color: 'hsl(240 30% 20%)' }}>{a.email_address}</p>
            <p className="fs12 m0 fx ac gap6" style={{ color: a.status === 'active' ? 'var(--positive)' : 'var(--negative)' }}>
              <Check className="i12" />{a.status === 'active' ? 'Active · read-only' : a.status}
            </p>
          </div>
          <div className="fx ac gap8">
            <button className="xbtn fx ac jc" title="Scan now" onClick={syncNow}><RefreshCw className="i14" /></button>
            <button className="xbtn fx ac jc" title="Disconnect" onClick={() => disconnect(a.id)}><Trash2 className="i14" /></button>
          </div>
        </div>
      ))}
      <button
        className="fx ac jc gap8 fw6"
        onClick={() => connect().catch(() => {})}
        disabled={isConnecting}
        style={{
          width: '100%', padding: 12, borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14,
          background: 'hsl(var(--acc) / .12)', border: '1px solid hsl(var(--acc) / .3)', color: 'hsl(var(--acc))',
          opacity: isConnecting ? 0.6 : 1,
        }}
      >
        <Plus className="i16" />{isConnecting ? 'Waiting for Google…' : isConnected ? 'Connect another mailbox' : 'Connect Gmail'}
      </button>
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
        <h3 className="t14 fw6" style={{ color: 'hsl(240 30% 20%)', marginBottom: 6 }}>Brokerage connection</h3>
        <p className="fs12" style={{ color: 'hsl(240 20% 50%)', lineHeight: 1.5 }}>
          Link your brokerage to sync holdings and transactions. Everything is pulled read-only and stored & analyzed locally on this Mac — never in the cloud. You sign in inside your broker's own window; Atlas never sees your brokerage password.
        </p>
      </div>

      {!available && (
        <div className="gpanel fs12" style={{ padding: 14, color: 'hsl(240 20% 50%)' }}>
          Portfolio linking runs in the Atlas desktop app. Open Atlas on your Mac to connect a brokerage.
        </div>
      )}

      {available && !hasCredentials && (
        <div className="gpanel fs12" style={{ padding: 14, color: 'var(--negative)' }}>
          SnapTrade credentials aren't configured. See docs/portfolio-setup.md.
        </div>
      )}

      {available && hasCredentials && (
        <>
          {connected ? (
            <div className="fx ac jb gpanel" style={{ padding: 14 }}>
              <div>
                <p className="t14 fw6 m0" style={{ color: 'hsl(240 30% 20%)' }}>Brokerage linked</p>
                <p className="fs12 m0 fx ac gap6" style={{ color: 'var(--positive)' }}>
                  <Check className="i12" />{summary?.accounts_count ?? 0} account{(summary?.accounts_count ?? 0) === 1 ? '' : 's'} · {summary?.holdings_count ?? 0} holdings · read-only
                </p>
              </div>
              <div className="fx ac gap8">
                <button className="xbtn fx ac jc" title="Sync now" onClick={sync} disabled={isSyncing}><RefreshCw className="i14" /></button>
                <button className="xbtn fx ac jc" title="Disconnect" onClick={disconnect}><Trash2 className="i14" /></button>
              </div>
            </div>
          ) : (
            <button
              className="fx ac jc gap8 fw6"
              onClick={() => connect().catch(() => {})}
              disabled={isConnecting}
              style={{
                width: '100%', padding: 12, borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14,
                background: 'hsl(var(--acc) / .12)', border: '1px solid hsl(var(--acc) / .3)', color: 'hsl(var(--acc))',
                opacity: isConnecting ? 0.6 : 1,
              }}
            >
              <Link2 className="i16" />{isConnecting ? 'Opening your broker…' : 'Connect a brokerage'}
            </button>
          )}
          {error && <p className="fs12" style={{ color: 'var(--negative)' }}>{error}</p>}
        </>
      )}
    </div>
  );
}

export default AtlasSettings;
