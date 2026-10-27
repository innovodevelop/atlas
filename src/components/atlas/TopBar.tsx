/**
 * The Beta top bar — on every screen (handoff `atlas-topbar.js`).
 *
 * Left: wordmark → Home, what Atlas is doing (the state bus), where you are.
 * Right: the devices on Bluetooth, Bluetooth, Wi-Fi and battery; each opens
 * its status panel under the bar (StatusPanels.tsx). The right cluster is
 * real data from Rust (`useSystemVitals`); in the browser preview it is the
 * fixture and says so.
 */
import { useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AtlasIcon } from './AtlasIcon';
import type { IconName } from './icons';
import { StatusPanel, type StatusPanelKind } from './home/StatusPanels';
import { STATE_COLOUR, STATE_LABEL, useAtlasState } from '@/lib/atlasStateBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { deviceKinds, useSystemVitals } from '@/hooks/useSystemVitals';
import { surfaceByPath } from '@/surfaces';

/** The Beta screen names; the registry's labels are the fallback. */
export const BETA_SCREEN_LABEL: Record<string, string> = {
  '/': 'Home',
  '/dashboard': 'Home',
  '/atlas-core': 'Core',
  '/atlas-teach': 'Teach',
  '/mail': 'Mail',
  '/atlas-architecture': 'Architecture',
  '/home': 'Voice',
  '/settings': 'Settings',
  '/system-status': 'System Status',
  '/money': 'Money',
  '/health': 'Health',
  '/smart-home': 'Smart Home',
  '/browser': 'Browser',
  '/model-lab': 'Model Lab',
  '/agent-view': 'Agent View',
  '/answer-views': 'Answers',
  '/onboarding': 'Welcome',
  '/permissions': 'Permissions',
  '/auth': 'Sign in',
};

export function screenLabel(pathname: string): string {
  return BETA_SCREEN_LABEL[pathname] ?? surfaceByPath(pathname)?.label ?? 'Atlas';
}

const KIND_ICON: Record<string, IconName> = {
  headphones: 'airpods', keyboard: 'keyboard', mouse: 'trackpad', trackpad: 'trackpad', speaker: 'speaker', other: 'bluetooth',
};

export function TopBar() {
  const { pathname } = useLocation();
  const navigate = useBetaNavigate();
  const state = useAtlasState();
  const vitals = useSystemVitals();
  const [panel, setPanel] = useState<StatusPanelKind | null>(null);
  const kinds = [...deviceKinds(vitals.bluetooth)];
  const battery = vitals.battery;
  const wifi = vitals.wifi;
  const bt = vitals.bluetooth;
  const toggle = (k: StatusPanelKind) => setPanel((cur) => (cur === k ? null : k));
  const close = useCallback(() => setPanel(null), []);
  const sample = vitals.fixture ? ' (sample — not this Mac)' : '';

  return (
    <div className="b-topbar" role="banner">
      <button type="button" className="b-topbar-word" title="Home" onClick={() => navigate('/')}>atlas</button>
      <span className="b-topbar-state" title="What Atlas is doing">
        <i style={{ background: STATE_COLOUR[state] }} />
        <span>{STATE_LABEL[state]}</span>
      </span>
      <span className="b-topbar-screen" title="You are here">{screenLabel(pathname)}</span>

      <div className="b-topbar-right">
        <button
          type="button"
          className={`b-topbar-btn${panel === 'devices' ? ' on' : ''}`}
          title={`Devices${sample}`}
          aria-expanded={panel === 'devices'}
          onClick={() => toggle('devices')}
        >
          <span className="b-topbar-devices" aria-label={`${kinds.length + 1} devices`}>
            <span><AtlasIcon name="mac" size={16} weight={1.7} /></span>
            {kinds.map((k) => (
              <span key={k}><AtlasIcon name={KIND_ICON[k]} size={16} weight={1.7} /></span>
            ))}
          </span>
        </button>
        <button
          type="button"
          className={`b-topbar-btn b-topbar-item${bt?.on ? '' : ' off'}${panel === 'bluetooth' ? ' on' : ''}`}
          title={`Bluetooth${sample}`}
          aria-label={bt?.on ? 'Bluetooth on' : 'Bluetooth off'}
          aria-expanded={panel === 'bluetooth'}
          onClick={() => toggle('bluetooth')}
        >
          <AtlasIcon name="bluetooth" size={18} weight={1.7} style={{ color: bt?.on ? 'var(--b-blue)' : undefined }} />
        </button>
        <button
          type="button"
          className={`b-topbar-btn b-topbar-item b-topbar-net${wifi?.connected ? '' : ' off'}${panel === 'wifi' ? ' on' : ''}`}
          title={`Wi-Fi${sample}`}
          aria-label={wifi?.connected ? `Wi-Fi ${wifi.ssid}` : 'Wi-Fi off'}
          aria-expanded={panel === 'wifi'}
          onClick={() => toggle('wifi')}
        >
          <AtlasIcon name={wifi?.connected ? 'wi-fi' : 'wi-fi off'} size={18} weight={1.7} />
          <span className="b-topbar-ssid">{wifi?.connected ? wifi.ssid : 'No Wi-Fi'}</span>
        </button>
        <button
          type="button"
          className={`b-topbar-btn b-topbar-item${battery ? '' : ' off'}${panel === 'battery' ? ' on' : ''}`}
          title={`Battery${sample}`}
          aria-label={battery ? `Battery ${battery.percent}%${battery.charging ? ', charging' : ''}` : 'No battery'}
          aria-expanded={panel === 'battery'}
          onClick={() => toggle('battery')}
        >
          {battery ? (
            <>
              <span className={`b-topbar-bat${battery.percent <= 15 && !battery.on_power ? ' low' : ''}${battery.charging ? ' charging' : ''}`}>
                <b style={{ width: `${battery.percent}%` }} />
              </span>
              <span className="b-num">{battery.percent}%</span>
            </>
          ) : (
            <AtlasIcon name="energy" size={18} weight={1.7} />
          )}
        </button>
        {vitals.fixture ? <span className="b-topbar-fixture">Sample</span> : null}
      </div>

      {panel ? <StatusPanel kind={panel} vitals={vitals} onClose={close} /> : null}
    </div>
  );
}
