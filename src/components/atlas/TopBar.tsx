/**
 * The Beta top bar — on every screen (handoff `atlas-topbar.js`).
 *
 * Left: wordmark → Home, what Atlas is doing (the state bus), where you are.
 * Right: the devices on Bluetooth, Bluetooth, Wi-Fi and battery → System
 * Status. The right cluster is real data from Rust (`useSystemVitals`); in
 * the browser preview it is the fixture and says so.
 */
import { useLocation } from 'react-router-dom';
import { AtlasIcon } from './AtlasIcon';
import type { IconName } from './icons';
import { STATE_COLOUR, STATE_LABEL, useAtlasState } from '@/lib/atlasStateBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { deviceKinds, useSystemVitals } from '@/hooks/useSystemVitals';
import { isRoutable, surfaceByPath } from '@/surfaces';

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
  const kinds = [...deviceKinds(vitals.bluetooth)];
  const battery = vitals.battery;
  const wifi = vitals.wifi;
  const bt = vitals.bluetooth;
  // System Status is an admin surface; a consumer build sends the cluster to
  // Settings, which has the same panels.
  const target = isRoutable('/system-status') ? '/system-status' : '/settings';

  return (
    <div className="b-topbar" role="banner">
      <button type="button" className="b-topbar-word" title="Home" onClick={() => navigate('/')}>atlas</button>
      <span className="b-topbar-state" title="What Atlas is doing">
        <i style={{ background: STATE_COLOUR[state] }} />
        <span>{STATE_LABEL[state]}</span>
      </span>
      <span className="b-topbar-screen" title="You are here">{screenLabel(pathname)}</span>

      <button
        type="button"
        className="b-topbar-right"
        title={vitals.fixture ? 'Devices, network and battery (sample — not this Mac)' : 'Devices, network and battery'}
        onClick={() => navigate(target)}
      >
        <span className="b-topbar-devices" aria-label={`${kinds.length + 1} devices`}>
          <span><AtlasIcon name="mac" size={16} weight={1.7} /></span>
          {kinds.map((k) => (
            <span key={k}><AtlasIcon name={KIND_ICON[k]} size={16} weight={1.7} /></span>
          ))}
        </span>
        <span className={`b-topbar-item${bt?.on ? '' : ' off'}`} style={{ marginLeft: 6 }} aria-label={bt?.on ? 'Bluetooth on' : 'Bluetooth off'}>
          <AtlasIcon name="bluetooth" size={18} weight={1.7} style={{ color: bt?.on ? 'var(--b-blue)' : undefined }} />
        </span>
        <span className={`b-topbar-item b-topbar-net${wifi?.connected ? '' : ' off'}`} aria-label={wifi?.connected ? `Wi-Fi ${wifi.ssid}` : 'Wi-Fi off'}>
          <AtlasIcon name={wifi?.connected ? 'wi-fi' : 'wi-fi off'} size={18} weight={1.7} />
          {wifi?.connected ? wifi.ssid : 'No Wi-Fi'}
        </span>
        {battery ? (
          <span className="b-topbar-item" aria-label={`Battery ${battery.percent}%${battery.charging ? ', charging' : ''}`}>
            <span className={`b-topbar-bat${battery.percent <= 15 && !battery.on_power ? ' low' : ''}${battery.charging ? ' charging' : ''}`}>
              <b style={{ width: `${battery.percent}%` }} />
            </span>
            <span className="b-num">{battery.percent}%</span>
          </span>
        ) : (
          <span className="b-topbar-item off" aria-label="No battery"><AtlasIcon name="energy" size={18} weight={1.7} /></span>
        )}
        {vitals.fixture ? <span className="b-topbar-fixture">Sample</span> : null}
      </button>
    </div>
  );
}
