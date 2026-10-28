/**
 * The Beta top bar — on every screen (handoff `atlas-topbar.js`).
 *
 * Left: wordmark → Home, what Atlas is doing (the state bus), where you are.
 * Right: the devices on Bluetooth, Bluetooth, Wi-Fi and battery; each opens
 * its status panel under the bar (StatusPanels.tsx). The right cluster is
 * real data from Rust (`useSystemVitals`); in the browser preview it is the
 * fixture and says so.
 *
 * Keyboard: the bar is the first stop in the shell's focus order (then the
 * page, then the dock). Every button has a name a screen reader can say; the
 * state pill and the screen name are text, not controls. An open status panel
 * is a shell layer (src/hooks/useShellLayer.ts): focus moves into it, Tab
 * stays inside, Esc closes it, and focus returns to the button that opened it.
 * The state pill is deliberately not a live region: it changes on every voice
 * turn and would talk over Atlas's own voice.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AtlasIcon } from './AtlasIcon';
import type { IconName } from './icons';
import { StatusPanel, type StatusPanelKind } from './home/StatusPanels';
import { useShellLayer } from '@/hooks/useShellLayer';
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
  '/answer': 'Answer',
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

const PANEL_ID = 'b-status-layer';

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

  // The panel's own markup is StatusPanels.tsx; the layer around it (focus in,
  // Tab held, Esc, focus back) is the bar's, because the bar owns the trigger.
  const layerRef = useRef<HTMLDivElement | null>(null);
  const triggers = useRef<Partial<Record<StatusPanelKind, HTMLButtonElement | null>>>({});
  // The last panel shown: by the time the layer closes, `panel` is already null.
  const lastKind = useRef<StatusPanelKind | null>(null);
  useLayoutEffect(() => { if (panel) lastKind.current = panel; }, [panel]);
  useShellLayer(panel !== null, {
    id: 'status-panel',
    ref: layerRef,
    onClose: close,
    // The dialog itself, so a screen reader reads its name and state first and
    // no button lights up under a pointer; Tab goes on to its first control.
    initialFocus: () => layerRef.current?.querySelector<HTMLElement>('[role="dialog"]') ?? null,
    // The button of the panel on screen when it closed (a click on another
    // button swaps panels without closing the layer).
    returnFocus: (opener) => (lastKind.current && triggers.current[lastKind.current]) || opener,
  });
  const trigger = (k: StatusPanelKind) => ({
    ref: (el: HTMLButtonElement | null) => { triggers.current[k] = el; },
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': panel === k,
    'aria-controls': panel === k ? PANEL_ID : undefined,
    onClick: () => toggle(k),
  });

  return (
    <div className="b-topbar" role="banner">
      <button type="button" className="b-topbar-word" title="Home" aria-label="Atlas Home" onClick={() => navigate('/')}>atlas</button>
      <span className="b-topbar-state" title="What Atlas is doing">
        <i style={{ background: STATE_COLOUR[state] }} aria-hidden="true" />
        <span>{STATE_LABEL[state]}</span>
      </span>
      <span className="b-topbar-screen" title="You are here">{screenLabel(pathname)}</span>

      <div className="b-topbar-right">
        <button
          type="button"
          className={`b-topbar-btn${panel === 'devices' ? ' on' : ''}`}
          title={`Devices${sample}`}
          aria-label={`Devices: this Mac${kinds.length ? ` and ${kinds.length} on Bluetooth` : ''}`}
          {...trigger('devices')}
        >
          <span className="b-topbar-devices" aria-hidden="true">
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
          {...trigger('bluetooth')}
        >
          <AtlasIcon name="bluetooth" size={18} weight={1.7} style={{ color: bt?.on ? 'var(--b-blue)' : undefined }} />
        </button>
        <button
          type="button"
          className={`b-topbar-btn b-topbar-item b-topbar-net${wifi?.connected ? '' : ' off'}${panel === 'wifi' ? ' on' : ''}`}
          title={`Wi-Fi${sample}`}
          aria-label={wifi?.connected ? `Wi-Fi ${wifi.ssid}` : 'Wi-Fi off'}
          {...trigger('wifi')}
        >
          <AtlasIcon name={wifi?.connected ? 'wi-fi' : 'wi-fi off'} size={18} weight={1.7} />
          <span className="b-topbar-ssid">{wifi?.connected ? wifi.ssid : 'No Wi-Fi'}</span>
        </button>
        <button
          type="button"
          className={`b-topbar-btn b-topbar-item${battery ? '' : ' off'}${panel === 'battery' ? ' on' : ''}`}
          title={`Battery${sample}`}
          aria-label={battery ? `Battery ${battery.percent}%${battery.charging ? ', charging' : ''}` : 'No battery'}
          {...trigger('battery')}
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

      {/* display: contents, so the wrapper adds no flex item (and no gap) to the bar. */}
      {panel ? (
        <div ref={layerRef} id={PANEL_ID} style={{ display: 'contents' }}>
          <StatusPanel kind={panel} vitals={vitals} onClose={close} />
        </div>
      ) : null}
    </div>
  );
}
