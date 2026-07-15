import { useEffect, useState } from 'react';
import { Minimize2, Mic, Mail, SlidersHorizontal, Wallet, Plus, Check, RefreshCw, Trash2 } from 'lucide-react';
import { VoiceSettingsPanel } from '@/components/atlas-health/VoiceSettingsPanel';
import { BudgetSettingsPanel } from '@/components/atlas-health/BudgetSettingsPanel';
import { useMailIntelligence } from '@/hooks/useMailIntelligence';

// Workshop-native Settings overlay. Hosts the app's real settings (voice, mail,
// budget) behind one entry point — before this, AtlasSettingsPanel was only
// reachable via the removed legacy route. The embedded panels use shadcn
// components that read the (now warm) CSS variables, so they render in the
// Workshop palette without bespoke restyling. This is also the home for the
// brokerage/portfolio Connections panel (Phase C).

type SettingsTab = 'voice' | 'mail' | 'budget';

const TABS: { key: SettingsTab; label: string; icon: typeof Mic }[] = [
  { key: 'voice', label: 'Voice', icon: Mic },
  { key: 'mail', label: 'Mail', icon: Mail },
  { key: 'budget', label: 'Budget & AI', icon: Wallet },
];

export const AuroraSettings = ({ onClose }: { onClose: () => void }) => {
  const [tab, setTab] = useState<SettingsTab>('voice');

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div className="exp th-cal" data-screen-label="Aurora — Settings">
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
            {tab === 'budget' && <BudgetSettingsPanel />}
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

export default AuroraSettings;
