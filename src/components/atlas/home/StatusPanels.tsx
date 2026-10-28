/**
 * The status panels — what opens under the top bar's right cluster
 * (`Atlas Dashboard Beta.dc.html`, the Wi-Fi / Bluetooth / Devices / Battery
 * panels; handoff `atlas-topbar.js`).
 *
 * They read `useSystemVitals` (Rust, or the fixture in the browser, which says
 * so). Wi-Fi and Bluetooth carry the design's on/off switch, over the same
 * commands as Settings → This Mac (src/hooks/useMacControls.ts). A switch is
 * drawn only when it can work: in the Mac app, and for Bluetooth only with
 * the blueutil tool installed — otherwise the panel says what it needs, since
 * a switch that did nothing would break the README's rule. Every panel ends in
 * the one action that works — System Status, or Settings in a consumer build.
 *
 * Each kind is its own component, because the TopBar swaps `kind` on one
 * mounted panel and the Wi-Fi and Bluetooth bodies hold hooks of their own.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AtlasIcon } from '../AtlasIcon';
import type { IconName } from '../icons';
import { batteryTone, deviceKinds, type SystemVitalsState } from '@/hooks/useSystemVitals';
import { useBluetoothControls, useWifiControls } from '@/hooks/useMacControls';
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
  // Settings opens on the panel's own section (`/settings#wifi` …).
  const target = isRoutable('/system-status') ? '/system-status' : `/settings#${kind}`;

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

  return (
    <div className="b-panel b-status-panel" role="dialog" aria-label={TITLE[kind]} ref={ref}>
      {kind === 'wifi' ? <WifiPanel vitals={vitals} /> : null}
      {kind === 'bluetooth' ? <BluetoothPanel vitals={vitals} /> : null}
      {kind === 'battery' ? <BatteryPanel vitals={vitals} /> : null}
      {kind === 'devices' ? <DevicesPanel vitals={vitals} /> : null}
      <div className="b-sp-foot">
        <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => { onClose(); navigate(target); }}>
          {target === '/system-status' ? 'Open System Status' : 'Open Settings'}
        </button>
        <button type="button" className="b-btn b-btn--ghost b-btn--row" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function Head({ kind, state, vitals, children }: { kind: StatusPanelKind; state: string; vitals: SystemVitalsState; children?: ReactNode }) {
  return (
    <div className="b-sp-head">
      <span className="b-sp-icon"><AtlasIcon name={ICON[kind]} size={18} weight={1.8} /></span>
      <span className="b-sp-head-text"><b>{TITLE[kind]}</b><span>{state}</span></span>
      {vitals.fixture ? <span className="b-topbar-fixture">Sample</span> : null}
      {children}
    </div>
  );
}

/** The design's switch, for a power state that is known; busy while the tool runs. */
function PowerSwitch({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    setBusy(true);
    try { await onChange(!on); } finally { setBusy(false); }
  };
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} aria-busy={busy} className={`b-switch${on ? ' on' : ''}`} disabled={busy} onClick={() => void flip()}>
      <span />
    </button>
  );
}

function WifiPanel({ vitals }: { vitals: SystemVitalsState }) {
  const ctl = useWifiControls();
  const [error, setError] = useState<string | null>(null);
  const { wifi } = vitals;
  const power = ctl.wifi?.power ?? null;
  const source = vitals.fixture ? 'Sample' : 'This Mac';
  const name = wifi?.ssid ?? null;
  const setPower = async (on: boolean) => {
    setError(null);
    try { await ctl.setPower(on); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const state = power === false ? 'Off' : wifi?.connected ? (name ? `Connected to ${name}` : 'Connected') : power ? 'On · not connected' : 'Not connected';

  return (
    <>
      <Head kind="wifi" state={state} vitals={vitals}>
        {ctl.available && power != null ? <PowerSwitch label="Wi-Fi" on={power} onChange={setPower} /> : null}
      </Head>
      {error ? <p className="b-sp-note" role="alert">{error}</p> : null}
      {power === false ? (
        <div className="b-empty">
          <p><b>Wi-Fi is off</b></p>
          <p>Atlas keeps working on-device; mail and sync resume when you reconnect.</p>
          <button type="button" className="b-btn b-btn--tinted b-btn--row" onClick={() => void setPower(true)}>Turn Wi-Fi on</button>
        </div>
      ) : (
        <>
          {wifi?.connected ? (
            <div className="b-sp-cur">
              <span className="b-sp-cur-icon"><AtlasIcon name="wi-fi" size={18} weight={1.8} /></span>
              <span className="b-sp-cur-text"><b>{name ?? 'Wi-Fi network'}</b><span>{name ? 'Connected' : 'Connected · macOS hides the name from Atlas'}</span></span>
            </div>
          ) : (
            <div className="b-empty"><p><b>No Wi-Fi network</b></p><p>Join one in Settings or from the menu bar; Atlas keeps working offline on what it already has.</p></div>
          )}
          <div className="b-sp-stats">
            <span><small>Network</small><b>{name ?? (wifi?.connected ? 'Hidden' : '—')}</b></span>
            <span><small>Status</small><b>{wifi?.connected ? 'Online' : 'Off'}</b></span>
            <span><small>Source</small><b>{source}</b></span>
          </div>
        </>
      )}
    </>
  );
}

function BluetoothPanel({ vitals }: { vitals: SystemVitalsState }) {
  // Without the device list: the panel has it from the vitals already.
  const ctl = useBluetoothControls({ devices: false });
  const [error, setError] = useState<string | null>(null);
  const bt = vitals.bluetooth;
  const on = ctl.bluetooth?.on ?? bt?.on ?? null;
  const source = vitals.fixture ? 'Sample' : 'This Mac';
  const n = bt?.connected.length ?? 0;
  const setPower = async (next: boolean) => {
    setError(null);
    try { await ctl.setPower(next); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const state = on == null ? 'Checking…' : on ? `${n} connected` : 'Off';

  return (
    <>
      <Head kind="bluetooth" state={state} vitals={vitals}>
        {ctl.available && ctl.bluetooth?.canSwitch && on != null ? <PowerSwitch label="Bluetooth" on={on} onChange={setPower} /> : null}
      </Head>
      {error ? <p className="b-sp-note" role="alert">{error}</p> : null}
      {on && bt?.connected.length ? (
        <div className="b-sp-list">
          {bt.connected.map((d, i) => (
            // Two devices can share a name (two pairs of AirPods called the same).
            <span className="b-row" key={`${d.name}-${i}`}>
              <span className="b-row-chip"><AtlasIcon name={kindOf(d.kind)} size={15} weight={1.8} /></span>
              <span className="b-sp-row-text"><b>{d.name}</b><span>{d.kind ?? 'Bluetooth device'}</span></span>
              {d.battery_percent != null ? <span className="b-num b-sp-row-val">{d.battery_percent}%</span> : null}
            </span>
          ))}
        </div>
      ) : (
        <div className="b-empty"><p><b>{on == null ? 'Looking for devices' : on ? 'Nothing connected' : 'Bluetooth is off'}</b></p><p>{on == null ? 'The first Bluetooth check takes a moment.' : 'Pair devices in macOS; they appear here and in the bar.'}</p></div>
      )}
      <div className="b-sp-stats">
        <span><small>Bluetooth</small><b>{on == null ? '…' : on ? 'On' : 'Off'}</b></span>
        <span><small>Connected</small><b>{n}</b></span>
        <span><small>Source</small><b>{source}</b></span>
      </div>
      {ctl.available && ctl.bluetooth && !ctl.bluetooth.canSwitch ? (
        <p className="b-sp-note">Switching Bluetooth from Atlas needs the free blueutil tool (brew install blueutil). Atlas never installs it.</p>
      ) : null}
    </>
  );
}

function BatteryPanel({ vitals }: { vitals: SystemVitalsState }) {
  const { battery } = vitals;
  const tone = batteryTone(battery);
  const source = vitals.fixture ? 'Sample' : 'This Mac';
  const state = battery ? `${battery.percent}%${battery.charging ? ', charging' : battery.on_power ? ', on power' : ''}` : 'No battery';
  return (
    <>
      <Head kind="battery" state={state} vitals={vitals} />
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
}

function DevicesPanel({ vitals }: { vitals: SystemVitalsState }) {
  const { battery, wifi, bluetooth: bt } = vitals;
  const kinds = [...deviceKinds(bt)];
  const state = `${kinds.length + 1} ${kinds.length ? 'devices' : 'device'}`;
  return (
    <>
      <Head kind="devices" state={state} vitals={vitals} />
      <div className="b-sp-list">
        <span className="b-row">
          <span className="b-row-chip"><AtlasIcon name="mac" size={15} weight={1.8} /></span>
          <span className="b-sp-row-text"><b>This Mac</b><span>{wifi?.connected ? (wifi.ssid ? `On ${wifi.ssid}` : 'On Wi-Fi') : 'Offline'}{battery ? ` · ${battery.percent}%` : ''}</span></span>
        </span>
        {(bt?.connected ?? []).map((d, i) => (
          <span className="b-row" key={`${d.name}-${i}`}>
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
