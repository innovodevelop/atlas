/**
 * Types and pure helpers for the machine's vitals (battery, Wi-Fi,
 * Bluetooth), shared by the `useSystemVitals` hook and its tests. The shape
 * mirrors `SystemVitals` in src-tauri/src/system_vitals.rs.
 */
export interface Battery { percent: number; charging: boolean; on_power: boolean; remaining: string | null }
export interface Wifi { ssid: string | null; connected: boolean }
export interface BtDevice { name: string; kind: string | null; battery_percent: number | null }
export interface Bluetooth { on: boolean; connected: BtDevice[] }
export interface SystemVitals {
  battery: Battery | null;
  wifi: Wifi | null;
  /** Null until the first (slow) Bluetooth probe has finished. */
  bluetooth: Bluetooth | null;
  bluetooth_at: number | null;
}

/** What the browser preview shows. Never mistaken for the Mac: the hook marks it. */
export const FIXTURE_VITALS: SystemVitals = {
  battery: { percent: 68, charging: false, on_power: false, remaining: '3:12 remaining' },
  wifi: { ssid: 'Fogware 5G', connected: true },
  bluetooth: { on: true, connected: [{ name: 'AirPods Pro', kind: 'Headphones', battery_percent: 80 }] },
  bluetooth_at: null,
};

export type DeviceKind = 'headphones' | 'keyboard' | 'mouse' | 'trackpad' | 'speaker' | 'other';

/** Which device glyphs the top bar lights up, one per kind, from the connected list. */
export function deviceKinds(bt: Bluetooth | null): Set<DeviceKind> {
  const out = new Set<DeviceKind>();
  for (const d of bt?.connected ?? []) {
    const k = (d.kind ?? '').toLowerCase();
    if (k.includes('headphone') || k.includes('headset') || /airpods|beats/i.test(d.name)) out.add('headphones');
    else if (k.includes('keyboard')) out.add('keyboard');
    else if (k.includes('mouse')) out.add('mouse');
    else if (k.includes('trackpad')) out.add('trackpad');
    else if (k.includes('speaker')) out.add('speaker');
    else out.add('other');
  }
  return out;
}

/** The battery bar's tone. */
export function batteryTone(b: Battery | null): 'normal' | 'low' | 'charging' | 'none' {
  if (!b) return 'none';
  if (b.charging) return 'charging';
  if (b.percent <= 15 && !b.on_power) return 'low';
  return 'normal';
}
