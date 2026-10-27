/**
 * The status panels — what opens under the top bar's right cluster
 * (`Atlas Dashboard Beta.dc.html`, the Wi-Fi / Bluetooth / Devices / Battery
 * panels; handoff `atlas-topbar.js`).
 *
 * They read `useSystemVitals` (Rust, or the fixture in the browser, which says
 * so). The design's on/off switches are not here: the webview has no command
 * to turn Wi-Fi or Bluetooth off, and a switch that did nothing would break
 * the README's rule. Every panel ends in the one action that works —
 * System Status, or Settings in a consumer build.
 */
import { useEffect, useRef } from 'react';
import { AtlasIcon } from '../AtlasIcon';
import type { IconName } from '../icons';
import { batteryTone, deviceKinds, type SystemVitalsState } from '@/hooks/useSystemVitals';
import { useBetaNavigate } from '@/lib/viewTransitions';
import { isRoutable } from '@/surfaces';

export type StatusPanelKind = 'devices' | 'bluetooth' | 'wifi' | 'battery';

const TITLE: Record<StatusPanelKind, string> = { devices: 'Devices', bluetooth: 'Bluetooth', wifi: 'Wi-Fi', battery: 'Battery' };
const ICON: Record<StatusPanelKind, IconName> = { devices: 'mac', bluetooth: 'bluetooth', wifi: 'wi-fi', battery: 'energy' };
const KIND_ICON: Record<string, IconName> = {
  headphones: 'airpods', keyboard: 'keyboard', mouse: 'trackpad', trackpad: 'trackpad', speaker: 'speaker', other: 'bluetooth',
};

function kindOf(kind: string | null): IconName {
  const k = (kind ?? '').toLowerCase();
  for (const key of Object.keys(KIND_ICON)) if (k.includes(key.slice(0, 5))) return KIND_ICON[key];
  return 'bluetooth';
}

export interface StatusPanelProps {
  kind: StatusPanelKind;
  vitals: SystemVitalsState;
  onClose: () => void;
}

export function StatusPanel({ kind, vitals, onClose }: StatusPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useBetaNavigate();
  const target = isRoutable('/system-status') ? '/system-status' : '/settings';

  // Esc and a click anywhere else close it; the cluster's own buttons swap panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest('.b-topbar-right')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  const { battery, wifi, bluetooth: bt } = vitals;
  const kinds = [...deviceKinds(bt)];
  const source = vitals.fixture ? 'Sample' : 'This Mac';

  let state = '';
  let body: JSX.Element;
  if (kind === 'wifi') {
    state = wifi?.connected ? `Connected to ${wifi.ssid}` : 'Not connected';
    body = (
      <>
        {wifi?.connected ? (
          <div className="b-sp-cur">
            <span className="b-sp-cur-icon"><AtlasIcon name="wi-fi" size={18} weight={1.8} /></span>
            <span className="b-sp-cur-text"><b>{wifi.ssid}</b><span>Connected</span></span>
          </div>
        ) : (
          <div className="b-empty"><p><b>No Wi-Fi network</b></p><p>Join one from the menu bar; Atlas keeps working offline on what it already has.</p></div>
        )}
        <div className="b-sp-stats">
          <span><small>Network</small><b>{wifi?.ssid ?? '—'}</b></span>
          <span><small>Status</small><b>{wifi?.connected ? 'Online' : 'Off'}</b></span>
          <span><small>Source</small><b>{source}</b></span>
        </div>
      </>
    );
  } else if (kind === 'bluetooth') {
    state = bt == null ? 'Checking…' : bt.on ? `${bt.connected.length} connected` : 'Off';
    body = (
      <>
        {bt?.connected.length ? (
          <div className="b-sp-list">
            {bt.connected.map((d) => (
              <span className="b-row" key={d.name}>
                <span className="b-row-chip"><AtlasIcon name={kindOf(d.kind)} size={15} weight={1.8} /></span>
                <span className="b-sp-row-text"><b>{d.name}</b><span>{d.kind ?? 'Bluetooth device'}</span></span>
                {d.battery_percent != null ? <span className="b-num b-sp-row-val">{d.battery_percent}%</span> : null}
              </span>
            ))}
          </div>
        ) : (
          <div className="b-empty"><p><b>{bt == null ? 'Looking for devices' : bt.on ? 'Nothing connected' : 'Bluetooth is off'}</b></p><p>{bt == null ? 'The first Bluetooth check takes a moment.' : 'Pair devices in macOS; they appear here and in the bar.'}</p></div>
        )}
        <div className="b-sp-stats">
          <span><small>Bluetooth</small><b>{bt == null ? '…' : bt.on ? 'On' : 'Off'}</b></span>
          <span><small>Connected</small><b>{bt?.connected.length ?? 0}</b></span>
          <span><small>Source</small><b>{source}</b></span>
        </div>
      </>
    );
  } else if (kind === 'battery') {
    const tone = batteryTone(battery);
    state = battery ? `${battery.percent}%${battery.charging ? ', charging' : battery.on_power ? ', on power' : ''}` : 'No battery';
    body = (
      <>
        {battery ? (
          <div className="b-sp-cur b-sp-cur--battery">
            <span className="b-sp-bat"><b className={tone} style={{ width: `${battery.percent}%` }} /></span>
            <span className="b-sp-cur-text"><b>{battery.percent}%</b><span>{battery.remaining ?? (battery.charging ? 'Charging' : battery.on_power ? 'On power' : 'On battery')}</span></span>
          </div>
        ) : (
          <div className="b-empty"><p><b>No battery</b></p><p>This Mac runs on mains power.</p></div>
        )}
        <div className="b-sp-stats">
          <span><small>Power</small><b>{battery ? (battery.on_power ? 'Adapter' : 'Battery') : 'Mains'}</b></span>
          <span><small>Charging</small><b>{battery?.charging ? 'Yes' : 'No'}</b></span>
          <span><small>Source</small><b>{source}</b></span>
        </div>
      </>
    );
  } else {
    state = `${kinds.length + 1} ${kinds.length ? 'devices' : 'device'}`;
    body = (
      <>
        <div className="b-sp-list">
          <span className="b-row">
            <span className="b-row-chip"><AtlasIcon name="mac" size={15} weight={1.8} /></span>
            <span className="b-sp-row-text"><b>This Mac</b><span>{wifi?.connected ? `On ${wifi.ssid}` : 'Offline'}{battery ? ` · ${battery.percent}%` : ''}</span></span>
          </span>
          {(bt?.connected ?? []).map((d) => (
            <span className="b-row" key={d.name}>
              <span className="b-row-chip"><AtlasIcon name={kindOf(d.kind)} size={15} weight={1.8} /></span>
              <span className="b-sp-row-text"><b>{d.name}</b><span>{d.kind ?? 'Bluetooth'}</span></span>
              {d.battery_percent != null ? <span className="b-num b-sp-row-val">{d.battery_percent}%</span> : null}
            </span>
          ))}
        </div>
        {vitals.fixture ? <p className="b-sp-note">These are sample devices — the browser preview cannot see this Mac.</p> : null}
      </>
    );
  }

  return (
    <div className="b-panel b-status-panel" role="dialog" aria-label={TITLE[kind]} ref={ref}>
      <div className="b-sp-head">
        <span className="b-sp-icon"><AtlasIcon name={ICON[kind]} size={18} weight={1.8} /></span>
        <span className="b-sp-head-text"><b>{TITLE[kind]}</b><span>{state}</span></span>
        {vitals.fixture ? <span className="b-topbar-fixture">Sample</span> : null}
      </div>
      {body}
      <div className="b-sp-foot">
        <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => { onClose(); navigate(target); }}>
          {target === '/system-status' ? 'Open System Status' : 'Open Settings'}
        </button>
        <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
