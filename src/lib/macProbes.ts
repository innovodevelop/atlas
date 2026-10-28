/**
 * What Settings → This Mac reads from the macOS tools, parsed — pure, tested
 * in macProbes.test.ts, fed by the Rust commands in src-tauri/src/mac_controls.rs.
 *
 * Rust runs a fixed list of tools (networksetup, ipconfig, route,
 * system_profiler, sysctl, vm_stat, df, ps, ioreg, pmset) and hands their text
 * back; the reading of that text lives here, where it can be tested with
 * `bun test` on fixtures shaped like the real output. Every field the tools
 * may not give is `null`: "unknown" is an honest answer, a made-up 94 % is not.
 *
 * NETWORK NAMES. Since macOS 14.4, `ipconfig` and `system_profiler` print
 * "<redacted>" for network names to an app without Location Services access,
 * which Atlas does not ask for. Those are reported as hidden, never as a
 * network called "<redacted>". The known-network list is not redacted.
 *
 * Nothing here imports a hook (the strict gate checks src/lib's whole import
 * closure); the raw shapes mirror the Rust structs field for field.
 */

/** What macOS prints in place of a network name the asking app may not see. */
export const REDACTED = '<redacted>';

/* ── Wi-Fi ───────────────────────────────────────────────────────────────── */

/** Mirrors `WifiReadout` in mac_controls.rs. */
export interface WifiRaw {
  device: string;
  power: string;
  summary: string;
  ip: string;
  route: string;
  preferred: string;
  profiler: string | null;
}

export type SignalWord = 'Strong' | 'Good' | 'Weak';

export interface WifiLink {
  /** dBm, negative. */
  signal: number | null;
  rateMbps: number | null;
  channel: number | null;
  band: string | null;
  security: string | null;
}

export interface NearbyNetwork {
  name: string;
  security: string | null;
  band: string | null;
  signal: number | null;
}

export interface WifiState {
  device: string;
  /** Null when `networksetup` did not answer (no Wi-Fi hardware). */
  power: boolean | null;
  connected: boolean;
  /** The network in use, when macOS lets Atlas see its name. */
  ssid: string | null;
  /** Connected, but macOS hid the name. */
  nameHidden: boolean;
  security: string | null;
  ip: string | null;
  router: string | null;
  /** The preferred-network list, in macOS's order. */
  known: string[];
  /** From the profiler; null until a scan has run. */
  link: WifiLink | null;
  /** Named networks in range, strongest first; null until a scan has run. */
  nearby: NearbyNetwork[] | null;
  /** Networks in range whose names macOS hid. */
  hiddenNearby: number;
}

/** "Wi-Fi Power (en0): On" → true. */
export function parseWifiPower(out: string): boolean | null {
  const m = /:\s*(On|Off)\s*$/im.exec(out.trim());
  return m ? m[1].toLowerCase() === 'on' : null;
}

/** A `key : value` line of `ipconfig getsummary` (top level only matters here). */
function summaryValue(summary: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm');
  const m = re.exec(summary);
  return m ? m[1] : null;
}

/**
 * A security mode as a person reads it, from either tool:
 * `WPA2_PSK` (ipconfig), `spairport_security_mode_wpa2_personal` (profiler).
 */
export function securityLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/^spairport_security_mode_/, '').trim();
  if (!s) return null;
  if (/^(none|open)$/i.test(s)) return 'Open';
  return s
    .split(/[_\s]+/)
    .map((w) => {
      if (/^(psk|sae|personal)$/i.test(w)) return 'Personal';
      if (/^(wpa\d?|wep|owe)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .filter((w, i, all) => all.indexOf(w) === i)
    .join(' ');
}

/** "64 (5GHz, 80MHz)" → { channel: 64, band: "5 GHz" }. */
export function parseChannel(raw: string | null | undefined): { channel: number | null; band: string | null } {
  if (!raw) return { channel: null, band: null };
  const ch = /^\s*(\d+)/.exec(raw);
  const g = /\((\d+)GHz/i.exec(raw);
  const band = g ? (g[1] === '2' ? '2.4 GHz' : `${g[1]} GHz`) : null;
  return { channel: ch ? Number(ch[1]) : null, band };
}

/** "-62 dBm / -95 dBm" → -62. */
export function parseSignal(raw: string | null | undefined): number | null {
  const m = raw ? /(-?\d+)\s*dBm/i.exec(raw) : null;
  return m ? Number(m[1]) : null;
}

/** The design's three words for a signal (bars: Strong, Good, Weak). */
export function signalWord(dbm: number | null): SignalWord | null {
  if (dbm == null) return null;
  if (dbm >= -60) return 'Strong';
  if (dbm >= -70) return 'Good';
  return 'Weak';
}

/** "Strong · −48 dBm", with a real minus sign. */
export function signalLine(dbm: number | null): string | null {
  const w = signalWord(dbm);
  return w == null || dbm == null ? null : `${w} · ${dbm < 0 ? '−' : ''}${Math.abs(dbm)} dBm`;
}

/** 585 → "585 Mbps", 1200 → "1.2 Gbps". */
export function rateLabel(mbps: number | null): string | null {
  if (mbps == null || !Number.isFinite(mbps) || mbps <= 0) return null;
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(1).replace(/\.0$/, '')} Gbps` : `${Math.round(mbps)} Mbps`;
}

/** `networksetup -listpreferredwirelessnetworks`: a header line, then one tab-indented name per line. */
export function parsePreferred(out: string): string[] {
  if (!/^Preferred networks on/m.test(out)) return [];
  return out
    .split('\n')
    .slice(1)
    .filter((l) => /^\s/.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `route -n get default` → the gateway, when it is an address. */
export function parseRouter(out: string): string | null {
  const m = /^\s*gateway:\s*(\S+)\s*$/m.exec(out);
  return m ? m[1] : null;
}

interface ProfilerNetwork {
  _name?: string;
  spairport_network_channel?: string;
  spairport_security_mode?: string;
  spairport_signal_noise?: string;
  spairport_network_rate?: number;
}

/** `system_profiler SPAirPortDataType -json` → the interface entry for `device`. */
function profilerInterface(json: string, device: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json) as { SPAirPortDataType?: Array<{ spairport_airport_interfaces?: Array<Record<string, unknown>> }> };
    const ifaces = v.SPAirPortDataType?.[0]?.spairport_airport_interfaces ?? [];
    return ifaces.find((i) => i._name === device) ?? ifaces[0] ?? null;
  } catch {
    return null;
  }
}

export function parseWifi(raw: WifiRaw): WifiState {
  const ssidRaw = summaryValue(raw.summary, 'SSID');
  const connected = !!ssidRaw;
  const nameHidden = connected && ssidRaw === REDACTED;
  const iface = raw.profiler ? profilerInterface(raw.profiler, raw.device) : null;

  let link: WifiLink | null = null;
  const cur = iface?.spairport_current_network_information as ProfilerNetwork | undefined;
  if (cur) {
    const { channel, band } = parseChannel(cur.spairport_network_channel);
    link = {
      signal: parseSignal(cur.spairport_signal_noise),
      rateMbps: typeof cur.spairport_network_rate === 'number' ? cur.spairport_network_rate : null,
      channel,
      band,
      security: securityLabel(cur.spairport_security_mode),
    };
  }

  let nearby: NearbyNetwork[] | null = null;
  let hiddenNearby = 0;
  if (iface) {
    const others = (iface.spairport_airport_other_local_wireless_networks ?? []) as ProfilerNetwork[];
    const seen = new Set<string>();
    nearby = [];
    for (const n of others) {
      const name = (n._name ?? '').trim();
      if (!name || name === REDACTED) { hiddenNearby++; continue; }
      if (seen.has(name)) continue;
      seen.add(name);
      nearby.push({
        name,
        security: securityLabel(n.spairport_security_mode),
        band: parseChannel(n.spairport_network_channel).band,
        signal: parseSignal(n.spairport_signal_noise),
      });
    }
    nearby.sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999));
  }

  const ip = raw.ip.trim();
  return {
    device: raw.device,
    power: parseWifiPower(raw.power),
    connected,
    ssid: connected && !nameHidden ? ssidRaw : null,
    nameHidden,
    security: securityLabel(summaryValue(raw.summary, 'Security')) ?? link?.security ?? null,
    ip: connected && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null,
    router: connected ? parseRouter(raw.route) : null,
    known: parsePreferred(raw.preferred),
    link: connected ? link : null,
    nearby,
    hiddenNearby,
  };
}

/** The line under the Wi-Fi card's title. */
export function wifiHeadline(w: WifiState | null): string {
  if (!w) return 'Checking…';
  if (w.power === false) return 'Off. Atlas keeps working on-device; mail and sync resume when you reconnect.';
  if (!w.connected) return 'On · not connected';
  return w.ssid ? `Connected to ${w.ssid}` : 'Connected';
}

/* ── Bluetooth ──────────────────────────────────────────────────────────── */

/** Mirrors `BluetoothReadout` in mac_controls.rs. */
export interface BluetoothRaw {
  blueutil: string | null;
  profiler: string;
  power: string | null;
}

export interface PairedDevice {
  name: string;
  /** "AA:BB:CC:DD:EE:FF", as macOS prints it; null when it did not say. */
  address: string | null;
  kind: string | null;
  connected: boolean;
  battery: number | null;
}

export interface BluetoothState {
  /** Null until read; from blueutil when installed, else system_profiler. */
  on: boolean | null;
  /** True when blueutil is installed, so the switches can work. */
  canSwitch: boolean;
  devices: PairedDevice[];
}

const ADDRESS = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

function batteryOf(props: Record<string, unknown>): number | null {
  for (const k of ['device_batteryLevelMain', 'device_batteryLevel', 'device_batteryLevelLeft', 'device_batteryLevelRight', 'device_batteryLevelCase']) {
    const v = props[k];
    if (typeof v === 'string') {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
    }
  }
  return null;
}

function devicesOf(list: unknown, connected: boolean): PairedDevice[] {
  if (!Array.isArray(list)) return [];
  const out: PairedDevice[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    for (const [name, raw] of Object.entries(item as Record<string, unknown>)) {
      const props = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const addr = typeof props.device_address === 'string' && ADDRESS.test(props.device_address) ? props.device_address : null;
      out.push({
        name,
        address: addr,
        kind: typeof props.device_minorType === 'string' ? props.device_minorType : null,
        connected,
        battery: batteryOf(props),
      });
    }
  }
  return out;
}

export function parseBluetooth(raw: BluetoothRaw): BluetoothState {
  let on: boolean | null = null;
  let devices: PairedDevice[] = [];
  try {
    const v = JSON.parse(raw.profiler) as { SPBluetoothDataType?: Array<Record<string, unknown>> };
    const entry = v.SPBluetoothDataType?.[0];
    if (entry) {
      const state = (entry.controller_properties as Record<string, unknown> | undefined)?.controller_state;
      if (typeof state === 'string') on = state.toLowerCase() === 'attrib_on';
      devices = [...devicesOf(entry.device_connected, true), ...devicesOf(entry.device_not_connected, false)];
    }
  } catch {
    /* no profiler output (the panel skips it): power comes from blueutil alone */
  }
  const tool = raw.power?.trim();
  if (raw.blueutil && (tool === '1' || tool === '0')) on = tool === '1';
  return { on, canSwitch: !!raw.blueutil, devices };
}

/* ── This Mac ───────────────────────────────────────────────────────────── */

/** Mirrors `MacReadout` in mac_controls.rs. */
export interface MacRaw {
  cpu_brand: string;
  memsize: string;
  logical_cpus: string;
  hw_model: string;
  boottime: string;
  pressure: string;
  os_version: string;
  machine_name: string;
  vm_stat: string;
  df: string;
  ps: string;
  self_pid: number;
}

export interface ProcessRow { pid: number; ppid: number; cpu: number; rssKb: number; comm: string }

export interface MacState {
  name: string | null;
  chip: string | null;
  memoryBytes: number | null;
  macos: string | null;
  /** Unix seconds the Mac booted. */
  bootedAt: number | null;
  /** Share of the whole processor in use, 0–100. */
  cpuPct: number | null;
  /** Atlas and its sidecars' share of the whole processor, 0–100. */
  atlasCpuPct: number | null;
  memoryUsedBytes: number | null;
  pressure: 'normal' | 'warn' | 'critical' | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
}

/** `ps -A -o pid=,ppid=,%cpu=,rss=,comm=`. The command may contain spaces, so it is the rest of the line. */
export function parseProcesses(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), comm: m[5] });
  }
  return rows;
}

/** `pid` and every process below it (Atlas's sidecars are its children). */
export function familyOf(rows: readonly ProcessRow[], pid: number): Set<number> {
  const family = new Set<number>([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (!family.has(r.pid) && family.has(r.ppid)) { family.add(r.pid); grew = true; }
    }
  }
  return family;
}

/** `vm_stat` → bytes in use the way Activity Monitor counts it: active + wired + compressed. */
export function parseVmStat(out: string): number | null {
  const size = /page size of (\d+) bytes/.exec(out);
  const pages = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(out);
    return m ? Number(m[1]) : null;
  };
  const active = pages('Pages active');
  const wired = pages('Pages wired down');
  if (!size || active == null || wired == null) return null;
  const compressed = pages('Pages occupied by compressor') ?? 0;
  return (active + wired + compressed) * Number(size[1]);
}

/**
 * `df -k <volume>` → the container's size and what is in use. On APFS the
 * volume's own "Used" leaves out the system volume and snapshots, so in use
 * is size minus available, which is what Finder shows.
 */
export function parseDf(out: string): { total: number; used: number } | null {
  const line = out.split('\n').slice(1).find((l) => l.trim());
  const cols = line?.trim().split(/\s+/);
  if (!cols || cols.length < 4) return null;
  const blocks = Number(cols[1]);
  const avail = Number(cols[3]);
  if (!Number.isFinite(blocks) || !Number.isFinite(avail) || blocks <= 0) return null;
  return { total: blocks * 1024, used: Math.max(0, blocks - avail) * 1024 };
}

/** `sysctl -n kern.boottime`: "{ sec = 1792882133, usec = 970100 } Sun Oct 25 …". */
export function parseBootTime(out: string): number | null {
  const m = /sec\s*=\s*(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

function positive(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseMac(raw: MacRaw): MacState {
  const cpus = positive(raw.logical_cpus) ?? 1;
  const procs = parseProcesses(raw.ps);
  const total = procs.reduce((s, p) => s + p.cpu, 0);
  const atlas = familyOf(procs, raw.self_pid);
  const mine = procs.filter((p) => atlas.has(p.pid)).reduce((s, p) => s + p.cpu, 0);
  const pct = (v: number) => Math.min(100, Math.round(v / cpus));
  const disk = parseDf(raw.df);
  const level = raw.pressure.trim();
  return {
    name: raw.machine_name.trim() || raw.hw_model.trim() || null,
    chip: raw.cpu_brand.trim() || null,
    memoryBytes: positive(raw.memsize),
    macos: raw.os_version.trim() || null,
    bootedAt: parseBootTime(raw.boottime),
    cpuPct: procs.length ? pct(total) : null,
    atlasCpuPct: procs.length ? pct(mine) : null,
    memoryUsedBytes: parseVmStat(raw.vm_stat),
    pressure: level === '1' ? 'normal' : level === '2' ? 'warn' : level === '4' ? 'critical' : null,
    diskTotalBytes: disk?.total ?? null,
    diskUsedBytes: disk?.used ?? null,
  };
}

/** 17179869184 → "16 GB"; 588e9 → "588 GB" (decimal for disks, binary for memory, as macOS shows each). */
export function gigabytes(bytes: number | null, binary = false): string {
  if (bytes == null) return '—';
  const gb = bytes / (binary ? 1024 ** 3 : 1e9);
  if (gb >= 1000 && !binary) return `${(gb / 1000).toFixed(1).replace(/\.0$/, '')} TB`;
  return gb >= 10 ? `${Math.round(gb).toLocaleString('en-US')} GB` : `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
}

/** "up 6 days", "up 3 hours", "up 12 minutes". */
export function uptimeLabel(bootedAt: number | null, nowMs: number): string | null {
  if (bootedAt == null) return null;
  const s = Math.max(0, Math.floor(nowMs / 1000 - bootedAt));
  const d = Math.floor(s / 86400);
  if (d >= 1) return `up ${d} ${d === 1 ? 'day' : 'days'}`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `up ${h} ${h === 1 ? 'hour' : 'hours'}`;
  const m = Math.max(1, Math.floor(s / 60));
  return `up ${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/* ── Battery ────────────────────────────────────────────────────────────── */

export interface BatterySample { at: string; percent: number; charging: boolean; on_power: boolean }

/** Mirrors `BatteryReadout` in mac_controls.rs. */
export interface BatteryRaw {
  ioreg: string;
  health: string;
  pmset: string;
  ps: string;
  self_pid: number;
  history: BatterySample[];
}

export interface EnergyRow {
  name: string;
  /** Share of the processor time in use right now, 0–100. */
  share: number;
  processes: number;
  atlas: boolean;
}

export interface BatteryState {
  /** False on a Mac with no battery (nothing in ioreg, no health report). */
  present: boolean;
  cycleCount: number | null;
  /** 0–100, as macOS reports it, else computed from the raw capacities. */
  maxCapacityPct: number | null;
  /** macOS's own word ("Good", "Service Recommended"). */
  condition: string | null;
  /** `pmset -g`'s `lowpowermode`; null when the line is absent. */
  lowPowerMode: boolean | null;
  energy: EnergyRow[];
  history: BatterySample[];
}

/** A number for `key` in the ioreg lines, top level (`"Key" = 5`) or nested (`"Key"=5`). */
function ioregNumber(ioreg: string, key: string): number | null {
  const m = new RegExp(`"${key}"\\s*=\\s*(\\d+)`).exec(ioreg);
  return m ? Number(m[1]) : null;
}

/** `pmset -g` → the `lowpowermode` setting. */
export function parseLowPowerMode(pmset: string): boolean | null {
  const m = /^\s*lowpowermode\s+(\d)/m.exec(pmset);
  return m ? m[1] === '1' : null;
}

/** "/Applications/Safari.app/Contents/MacOS/Safari" → "Safari"; a bare tool → its file name. */
export function appName(comm: string): string {
  const app = /([^/]+)\.app\//.exec(comm);
  if (app) return app[1];
  const base = comm.split('/').pop() ?? comm;
  return base || comm;
}

/**
 * What is using the processor, grouped by app, largest first: the top
 * `limit`, then "Everything else". Atlas (this process and its sidecars) is
 * one row. CPU share is the stand-in for energy: macOS reports per-app energy
 * only to Activity Monitor, and the processor is what an app controls.
 */
export function energyRows(psOut: string, selfPid: number, limit = 3): EnergyRow[] {
  const all = parseProcesses(psOut);
  const procs = all.filter((p) => p.cpu > 0);
  const total = procs.reduce((s, p) => s + p.cpu, 0);
  if (total <= 0) return [];
  // The family from every process, idle ones too: a sidecar's parent may be at 0 %.
  const atlas = familyOf(all, selfPid);
  const groups = new Map<string, { cpu: number; n: number; atlas: boolean }>();
  for (const p of procs) {
    const mine = atlas.has(p.pid);
    const key = mine ? 'Atlas' : appName(p.comm);
    const g = groups.get(key) ?? { cpu: 0, n: 0, atlas: mine };
    g.cpu += p.cpu;
    g.n += 1;
    groups.set(key, g);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].cpu - a[1].cpu);
  const top = sorted.slice(0, limit);
  const atlasEntry = sorted.find(([k]) => k === 'Atlas');
  // Atlas always gets its own row: it is the one app on the list the user can change from here.
  if (atlasEntry && !top.includes(atlasEntry)) top.splice(limit - 1, 1, atlasEntry);
  const rest = sorted.filter((e) => !top.includes(e));
  const share = (cpu: number) => Math.round((cpu / total) * 100);
  const rows: EnergyRow[] = top.map(([name, g]) => ({ name, share: share(g.cpu), processes: g.n, atlas: g.atlas }));
  if (rest.length) {
    const cpu = rest.reduce((s, [, g]) => s + g.cpu, 0);
    const n = rest.reduce((s, [, g]) => s + g.n, 0);
    rows.push({ name: 'Everything else', share: share(cpu), processes: n, atlas: false });
  }
  return rows;
}

export function parseBattery(raw: BatteryRaw): BatteryState {
  let health: Record<string, unknown> = {};
  try { health = raw.health ? (JSON.parse(raw.health) as Record<string, unknown>) : {}; } catch { health = {}; }
  const reported = typeof health.sppower_battery_health_maximum_capacity === 'string'
    ? Number.parseInt(health.sppower_battery_health_maximum_capacity, 10)
    : NaN;
  const design = ioregNumber(raw.ioreg, 'DesignCapacity');
  const rawMax = ioregNumber(raw.ioreg, 'AppleRawMaxCapacity') ?? ioregNumber(raw.ioreg, 'NominalChargeCapacity');
  const computed = design && rawMax ? Math.min(100, Math.round((rawMax / design) * 100)) : null;
  const cycles = typeof health.sppower_battery_cycle_count === 'number' ? health.sppower_battery_cycle_count : ioregNumber(raw.ioreg, 'CycleCount');
  return {
    present: !!raw.ioreg.trim() || !!raw.health.trim(),
    cycleCount: cycles,
    maxCapacityPct: Number.isFinite(reported) ? reported : computed,
    condition: typeof health.sppower_battery_health === 'string' ? health.sppower_battery_health : null,
    lowPowerMode: parseLowPowerMode(raw.pmset),
    energy: energyRows(raw.ps, raw.self_pid),
    history: raw.history,
  };
}

export interface HistoryBar {
  /** 0–100, or null for an hour with no sample. */
  percent: number | null;
  tone: 'battery' | 'charging' | 'now' | 'empty';
  /** The bar's tooltip: "68% · 2 PM". */
  title: string;
}

function hourLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric' });
}

/**
 * The 24-hour chart: one bar per hour ending now, each the last sample taken
 * in that hour. Charging hours are green, the current hour is blue, an hour
 * with no sample (Atlas was closed, the Mac asleep) is an empty slot rather
 * than a guess.
 */
export function historyBars(samples: readonly BatterySample[], nowMs: number): { bars: HistoryBar[]; startLabel: string; midLabel: string } {
  const HOUR = 3_600_000;
  const start = nowMs - 24 * HOUR;
  const slots: Array<BatterySample | null> = Array.from({ length: 24 }, () => null);
  for (const s of samples) {
    const t = Date.parse(s.at);
    if (!Number.isFinite(t) || t <= start || t > nowMs) continue;
    const i = Math.min(23, Math.floor((t - start) / HOUR));
    const prev = slots[i];
    if (!prev || Date.parse(prev.at) <= t) slots[i] = s;
  }
  const bars = slots.map((s, i): HistoryBar => {
    const at = hourLabel(start + (i + 1) * HOUR);
    if (!s) return { percent: null, tone: 'empty', title: `No reading · ${at}` };
    return { percent: s.percent, tone: i === 23 ? 'now' : s.charging ? 'charging' : 'battery', title: `${s.percent}% · ${at}` };
  });
  const startDate = new Date(start);
  const yesterday = startDate.getDate() !== new Date(nowMs).getDate();
  return {
    bars,
    startLabel: `${yesterday ? 'Yesterday ' : ''}${hourLabel(start)}`,
    midLabel: hourLabel(start + 12 * HOUR),
  };
}
