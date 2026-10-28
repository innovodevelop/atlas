import { describe, expect, test } from 'bun:test';
import {
  appName, currentNetworkLine, energyRows, familyOf, gigabytes, historyBars, knownNetworkLine, macMeters, otherNetworkLine, otherNetworks,
  parseBattery, parseBluetooth, parseBootTime, parseChannel, parseDf, parseLowPowerMode, parseMac, parsePreferred, parseProcesses, parseRouter,
  parseSignal, parseVmStat, parseWifi, parseWifiPower, rateLabel, securityLabel, signalLine, signalWord, uptimeLabel, usedOf, wifiHeadline,
  type BatteryRaw, type MacRaw, type WifiRaw,
} from './macProbes';

// Shaped like the real tools' output on macOS 26/27, with made-up names and
// addresses. The summary keeps the DHCP packet dump ipconfig prints, because
// its `key : value`-looking lines are what a careless parser trips on.
const SUMMARY = `<dictionary> {
  BSSID : <redacted>
  IPv4 : <array> {
    0 : <dictionary> {
      Addresses : <array> {
        0 : 192.168.1.24
      }
      DHCP : <dictionary> {
        Packet : op = BOOTREPLY
router (ip_mult): {192.168.1.1}
      }
      Router : 192.168.1.1
    }
  }
  InterfaceType : WiFi
  LinkStatusActive : TRUE
  SSID : Fogware 5G
  Security : WPA3_SAE
}`;

const PROFILER = JSON.stringify({
  SPAirPortDataType: [{
    spairport_airport_interfaces: [{
      _name: 'en0',
      spairport_current_network_information: {
        _name: 'Fogware 5G',
        spairport_network_channel: '64 (5GHz, 80MHz)',
        spairport_network_rate: 1200,
        spairport_security_mode: 'spairport_security_mode_wpa3_personal',
        spairport_signal_noise: '-48 dBm / -95 dBm',
      },
      spairport_airport_other_local_wireless_networks: [
        { _name: 'Sutter Guest', spairport_network_channel: '11 (2GHz, 20MHz)', spairport_security_mode: 'spairport_security_mode_none', spairport_signal_noise: '-79 dBm / -93 dBm' },
        { _name: '<redacted>', spairport_network_channel: '4 (2GHz, 20MHz)', spairport_security_mode: 'spairport_security_mode_wpa2_personal' },
        { _name: 'Linden-Studio', spairport_network_channel: '100 (5GHz, 160MHz)', spairport_security_mode: 'spairport_security_mode_wpa2_personal', spairport_signal_noise: '-66 dBm / -93 dBm' },
        { _name: 'Linden-Studio', spairport_network_channel: '6 (2GHz, 20MHz)', spairport_security_mode: 'spairport_security_mode_wpa2_personal' },
      ],
    }],
  }],
});

const WIFI: WifiRaw = {
  device: 'en0',
  power: 'Wi-Fi Power (en0): On\n',
  summary: SUMMARY,
  ip: '192.168.1.24\n',
  route: '   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n',
  preferred: 'Preferred networks on en0:\n\tFogware 5G\n\tLinden-Studio\n\tCafé Ritual\n',
  profiler: PROFILER,
};

describe('Wi-Fi', () => {
  test('power, preferred list and router', () => {
    expect(parseWifiPower('Wi-Fi Power (en0): On\n')).toBe(true);
    expect(parseWifiPower('Wi-Fi Power (en0): Off')).toBe(false);
    expect(parseWifiPower('en7 is not a Wi-Fi interface.')).toBeNull();
    expect(parsePreferred(WIFI.preferred)).toEqual(['Fogware 5G', 'Linden-Studio', 'Café Ritual']);
    expect(parsePreferred('Error: en0 is not a Wi-Fi interface.')).toEqual([]);
    expect(parseRouter(WIFI.route)).toBe('192.168.1.1');
    expect(parseRouter('route: writing to routing socket: not in table')).toBeNull();
  });

  test('labels from both tools', () => {
    expect(securityLabel('WPA2_PSK')).toBe('WPA2 Personal');
    expect(securityLabel('WPA3_SAE')).toBe('WPA3 Personal');
    expect(securityLabel('spairport_security_mode_wpa2_personal')).toBe('WPA2 Personal');
    expect(securityLabel('spairport_security_mode_none')).toBe('Open');
    expect(securityLabel(null)).toBeNull();
    expect(parseChannel('64 (5GHz, 80MHz)')).toEqual({ channel: 64, band: '5 GHz' });
    expect(parseChannel('11 (2GHz, 40MHz)')).toEqual({ channel: 11, band: '2.4 GHz' });
    expect(parseSignal('-62 dBm / -95 dBm')).toBe(-62);
    expect(signalWord(-48)).toBe('Strong');
    expect(signalWord(-66)).toBe('Good');
    expect(signalWord(-82)).toBe('Weak');
    expect(signalLine(-48)).toBe('Strong · −48 dBm');
    expect(rateLabel(585)).toBe('585 Mbps');
    expect(rateLabel(1200)).toBe('1.2 Gbps');
    expect(rateLabel(0)).toBeNull();
  });

  test('a connected Mac, after a scan', () => {
    const w = parseWifi(WIFI);
    expect(w).toMatchObject({ power: true, connected: true, ssid: 'Fogware 5G', nameHidden: false, security: 'WPA3 Personal', ip: '192.168.1.24', router: '192.168.1.1' });
    expect(w.link).toEqual({ signal: -48, rateMbps: 1200, channel: 64, band: '5 GHz', security: 'WPA3 Personal' });
    // Strongest first, duplicates folded, hidden names counted rather than shown.
    expect(w.nearby!.map((n) => n.name)).toEqual(['Linden-Studio', 'Sutter Guest']);
    expect(w.hiddenNearby).toBe(1);
    expect(wifiHeadline(w)).toBe('Connected to Fogware 5G');
  });

  test('macOS hides the name: connected, unnamed, never "<redacted>"', () => {
    const w = parseWifi({ ...WIFI, summary: SUMMARY.replace('SSID : Fogware 5G', 'SSID : <redacted>'), profiler: null });
    expect(w).toMatchObject({ connected: true, ssid: null, nameHidden: true, link: null, nearby: null });
    expect(wifiHeadline(w)).toBe('Connected');
  });

  test('off, and on but not connected', () => {
    const off = parseWifi({ ...WIFI, power: 'Wi-Fi Power (en0): Off', summary: '<dictionary> {\n  InterfaceType : WiFi\n  LinkStatusActive : FALSE\n}', ip: '', profiler: null });
    expect(off).toMatchObject({ power: false, connected: false, ip: null, router: null });
    expect(wifiHeadline(off)).toMatch(/^Off\./);
    expect(wifiHeadline({ ...off, power: true })).toBe('On · not connected');
    expect(wifiHeadline(null)).toBe('Checking…');
  });

  test('the current, known and other networks as the cards say them', () => {
    const w = parseWifi(WIFI);
    expect(currentNetworkLine(w)).toBe('Connected · WPA3 Personal · 5 GHz');
    // Seen by the scan: what it saw. Not seen, and nothing in range was hidden: not in range.
    expect(knownNetworkLine('Linden-Studio', w)).toBe('Good · WPA2 Personal · 5 GHz');
    expect(knownNetworkLine('Café Ritual', { ...w, hiddenNearby: 0 })).toBe('Not in range');
    // A hidden network in range could be it, and before a scan nothing is known.
    expect(knownNetworkLine('Café Ritual', w)).toBe('Saved on this Mac');
    expect(knownNetworkLine('Café Ritual', { ...w, nearby: null })).toBe('Saved on this Mac');
    expect(otherNetworks(w).map((n) => n.name)).toEqual(['Sutter Guest']);
    expect(otherNetworkLine(otherNetworks(w)[0])).toBe('Open · Weak · 2.4 GHz');
    expect(otherNetworkLine({ name: 'x', security: 'WPA2 Personal', band: null, signal: null })).toBe('Secured');
  });

  test('this Mac’s own output on macOS 27: every name hidden, the link still read', () => {
    // Recorded from `ipconfig getsummary en0` and `system_profiler SPAirPortDataType -json`
    // on the Mac this was built on (addresses changed), where Atlas has no Location Services access.
    const profiler = JSON.stringify({
      SPAirPortDataType: [{
        spairport_airport_interfaces: [
          {
            _name: 'en0',
            spairport_current_network_information: {
              _name: '<redacted>', spairport_network_channel: '64 (5GHz, 80MHz)', spairport_network_phymode: '802.11ac', spairport_network_rate: 585,
              spairport_security_mode: 'spairport_security_mode_wpa2_personal', spairport_signal_noise: '-61 dBm / -95 dBm',
            },
            spairport_airport_other_local_wireless_networks: Array.from({ length: 6 }, (_, i) => ({
              _name: '<redacted>', spairport_network_channel: `${i + 1} (2GHz, 20MHz)`, spairport_security_mode: 'spairport_security_mode_wpa2_personal',
            })),
          },
          { _name: 'awdl0', spairport_current_network_information: { spairport_network_type: 'spairport_network_type_station' } },
        ],
      }],
    });
    const summary = '<dictionary> {\n  BSSID : <redacted>\n  ConnectionID : 9\n  InterfaceType : WiFi\n  LinkStatusActive : TRUE\n  NetworkID : <redacted>\n  SSID : <redacted>\n  Security : WPA2_PSK\n}';
    const w = parseWifi({ device: 'en0', power: 'Wi-Fi Power (en0): On', summary, ip: '10.0.0.183\n', route: '    gateway: 10.0.0.1\n', preferred: 'Preferred networks on en0:\n\tHome Net\n\tPhone Hotspot\n', profiler });
    expect(w).toMatchObject({ power: true, connected: true, ssid: null, nameHidden: true, security: 'WPA2 Personal', ip: '10.0.0.183', router: '10.0.0.1', hiddenNearby: 6 });
    expect(w.link).toMatchObject({ signal: -61, rateMbps: 585, band: '5 GHz' });
    expect(w.nearby).toEqual([]);
    expect(otherNetworks(w)).toEqual([]);
    expect(knownNetworkLine('Home Net', w)).toBe('Saved on this Mac');
    expect(signalLine(w.link!.signal)).toBe('Good · −61 dBm');
  });
});

const BT_JSON = JSON.stringify({
  SPBluetoothDataType: [{
    controller_properties: { controller_state: 'attrib_on' },
    device_connected: [{ 'Studio AirPods': { device_address: 'A4:83:E7:12:34:56', device_minorType: 'Headphones', device_batteryLevelLeft: '80%' } }],
    device_not_connected: [
      { 'Magic Keyboard': { device_address: 'B0:BE:83:00:11:22', device_minorType: 'Keyboard' } },
      { 'Odd Device': { device_address: 'not-an-address' } },
    ],
  }],
});

describe('Bluetooth', () => {
  test('connected and paired devices, with addresses', () => {
    const b = parseBluetooth({ blueutil: null, profiler: BT_JSON, power: null });
    expect(b.on).toBe(true);
    expect(b.canSwitch).toBe(false);
    expect(b.devices).toEqual([
      { name: 'Studio AirPods', address: 'A4:83:E7:12:34:56', kind: 'Headphones', connected: true, battery: 80 },
      { name: 'Magic Keyboard', address: 'B0:BE:83:00:11:22', kind: 'Keyboard', connected: false, battery: null },
      { name: 'Odd Device', address: null, kind: null, connected: false, battery: null },
    ]);
  });

  test('blueutil answers the power question when it is installed', () => {
    expect(parseBluetooth({ blueutil: '/opt/homebrew/bin/blueutil', profiler: BT_JSON, power: '0\n' })).toMatchObject({ on: false, canSwitch: true });
    // The status panel skips the profiler: power from blueutil alone.
    expect(parseBluetooth({ blueutil: '/opt/homebrew/bin/blueutil', profiler: '', power: '1' })).toEqual({ on: true, canSwitch: true, devices: [] });
    expect(parseBluetooth({ blueutil: null, profiler: '', power: null })).toEqual({ on: null, canSwitch: false, devices: [] });
  });
});

const PS = [
  '    1     0   2.0  19328 /sbin/launchd',
  '  500     1  40.0 400000 /Applications/Atlas.app/Contents/MacOS/app',
  '  501   500  20.0 300000 /Applications/Atlas.app/Contents/MacOS/atlas-brain',
  '  502   500   0.0  90000 /Applications/Atlas.app/Contents/MacOS/atlas-voice-gateway',
  '  503   502  10.0  10000 /usr/bin/some helper',
  '  600     1  60.0 900000 /Applications/Safari.app/Contents/MacOS/Safari',
  '  601     1  30.0 200000 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent',
  '  700     1  20.0  50000 /usr/libexec/logd',
  '  800     1  10.0  50000 /usr/sbin/bluetoothd',
].join('\n');

const MAC: MacRaw = {
  cpu_brand: 'Apple M5\n',
  memsize: '17179869184\n',
  logical_cpus: '10\n',
  hw_model: 'Mac17,2\n',
  boottime: '{ sec = 1792882133, usec = 970100 } Sun Oct 25 00:48:53 2026\n',
  pressure: '2\n',
  os_version: '27.2\n',
  machine_name: 'MacBook Pro',
  vm_stat: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                    31301.\nPages active:                                 199461.\nPages wired down:                             222699.\nPages occupied by compressor:                 354987.\n',
  df: 'Filesystem   1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on\n/dev/disk3s5   482746452 405515820  27925812    94% 3881182 279258120    1%   /System/Volumes/Data\n',
  ps: PS,
  self_pid: 500,
};

describe('This Mac', () => {
  test('process table and Atlas’s family', () => {
    const rows = parseProcesses(PS);
    expect(rows).toHaveLength(9);
    expect(rows[4]).toEqual({ pid: 503, ppid: 502, cpu: 10, rssKb: 10000, comm: '/usr/bin/some helper' });
    expect([...familyOf(rows, 500)].sort()).toEqual([500, 501, 502, 503]);
  });

  test('memory, disk and boot time', () => {
    expect(parseVmStat(MAC.vm_stat)).toBe((199461 + 222699 + 354987) * 16384);
    expect(parseVmStat('nonsense')).toBeNull();
    expect(parseDf(MAC.df)).toEqual({ total: 482746452 * 1024, used: (482746452 - 27925812) * 1024 });
    expect(parseDf('')).toBeNull();
    expect(parseBootTime(MAC.boottime)).toBe(1792882133);
  });

  test('the whole reading', () => {
    const m = parseMac(MAC);
    expect(m).toMatchObject({ name: 'MacBook Pro', chip: 'Apple M5', memoryBytes: 17179869184, macos: '27.2', bootedAt: 1792882133, pressure: 'warn' });
    // 192 % across ten cores is 19 % of the whole processor; Atlas and its sidecars 70 % → 7 %.
    expect(m.cpuPct).toBe(19);
    expect(m.atlasCpuPct).toBe(7);
    expect(parseMac({ ...MAC, machine_name: '' }).name).toBe('Mac17,2');
    expect(parseMac({ ...MAC, ps: '', pressure: '' })).toMatchObject({ cpuPct: null, atlasCpuPct: null, pressure: null });
  });

  test('sizes and uptime as the screen says them', () => {
    expect(gigabytes(17179869184, true)).toBe('16 GB');
    expect(gigabytes(588_000_000_000)).toBe('588 GB');
    expect(gigabytes(1_000_000_000_000)).toBe('1 TB');
    expect(gigabytes(6_800_000_000)).toBe('6.8 GB');
    expect(gigabytes(null)).toBe('—');
    const now = 1792882133 * 1000;
    expect(uptimeLabel(1792882133 - 6 * 86400, now)).toBe('up 6 days');
    expect(uptimeLabel(1792882133 - 3600, now)).toBe('up 1 hour');
    expect(uptimeLabel(1792882133 - 30, now)).toBe('up 1 minute');
    expect(uptimeLabel(null, now)).toBeNull();
  });

  test('the three meters as the Devices card draws them', () => {
    expect(usedOf(19.5e9, 1e12)).toBe('19.5 of 1,000 GB');
    expect(usedOf(18.2 * 1024 ** 3, 36 * 1024 ** 3, true)).toBe('18.2 of 36 GB');
    expect(usedOf(null, 1e12)).toBeNull();
    const m = parseMac(MAC);
    const { processor, memory, storage } = macMeters(m);
    expect(processor).toEqual({ sub: '19% in use · Atlas uses 7%', pct: 19, tone: 'ink' });
    // Pressure level 2 is macOS's warning: said, and the meter turns red.
    expect(memory!.sub).toBe(`${usedOf(m.memoryUsedBytes, m.memoryBytes, true)} · pressure elevated`);
    expect(memory!.tone).toBe('red');
    expect(macMeters({ ...m, pressure: 'normal' }).memory!.tone).toBe('green');
    expect(storage!.sub).toBe('466 of 494 GB');
    expect(storage!.pct).toBeCloseTo(94.2, 1);
    expect(storage!.tone).toBe('ink');
    expect(macMeters({ ...m, diskUsedBytes: 0.96e12, diskTotalBytes: 1e12 }).storage!.tone).toBe('red');
    expect(macMeters({ ...m, cpuPct: null, memoryUsedBytes: null, diskTotalBytes: null })).toEqual({ processor: null, memory: null, storage: null });
  });
});

describe('Battery', () => {
  const raw: BatteryRaw = {
    ioreg: '|   "MaxCapacity" = 100\n|   "CycleCount" = 164\n|   "BatteryData" = {"AppleRawMaxCapacity"=5926,"DesignCapacity"=6249}',
    health: JSON.stringify({ sppower_battery_cycle_count: 164, sppower_battery_health: 'Good', sppower_battery_health_maximum_capacity: '94 %' }),
    pmset: 'System-wide power settings:\nCurrently in use:\n standby              1\n lowpowermode         0\n womp                 1\n',
    ps: PS,
    self_pid: 500,
    history: [],
  };

  test('health as macOS reports it, then computed from the capacities', () => {
    expect(parseBattery(raw)).toMatchObject({ present: true, cycleCount: 164, maxCapacityPct: 94, condition: 'Good', lowPowerMode: false });
    // No health report: the raw capacities (5926 of 6249 mAh) and ioreg's cycle count.
    expect(parseBattery({ ...raw, health: '' })).toMatchObject({ cycleCount: 164, maxCapacityPct: 95, condition: null });
    expect(parseBattery({ ...raw, ioreg: '', health: '', pmset: '' })).toMatchObject({ present: false, cycleCount: null, maxCapacityPct: null, lowPowerMode: null });
    expect(parseLowPowerMode(' lowpowermode         1\n')).toBe(true);
  });

  test('energy use, grouped by app, Atlas as one row', () => {
    expect(appName('/Applications/Safari.app/Contents/MacOS/Safari')).toBe('Safari');
    expect(appName('/usr/libexec/logd')).toBe('logd');
    const rows = energyRows(PS, 500);
    expect(rows.map((r) => r.name)).toEqual(['Atlas', 'Safari', 'com.apple.WebKit.WebContent', 'Everything else']);
    expect(rows[0]).toEqual({ name: 'Atlas', share: 36, processes: 3, atlas: true });
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeGreaterThanOrEqual(99);
    // Atlas keeps a row even when it is not among the largest.
    const quiet = PS.replace('40.0 400000', ' 1.0 400000').replace('20.0 300000', ' 0.0 300000').replace('10.0  10000', ' 0.0  10000');
    expect(energyRows(quiet, 500).map((r) => r.name)).toEqual(['Safari', 'com.apple.WebKit.WebContent', 'Atlas', 'Everything else']);
    expect(energyRows('', 500)).toEqual([]);
  });

  test('24 hourly bars, empty where nothing was recorded', () => {
    const now = Date.parse('2026-10-28T15:30:00Z');
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const { bars } = historyBars([
      { at: at(23.5), percent: 100, charging: false, on_power: false },
      { at: at(10.2), percent: 72, charging: true, on_power: true },
      { at: at(10.1), percent: 74, charging: true, on_power: true },
      { at: at(0.1), percent: 68, charging: false, on_power: false },
      { at: at(30), percent: 50, charging: false, on_power: false },
    ], now);
    expect(bars).toHaveLength(24);
    expect(bars[0]).toMatchObject({ percent: 100, tone: 'battery' });
    // Two samples in one hour: the later one.
    expect(bars[13]).toMatchObject({ percent: 74, tone: 'power' });
    expect(bars[23]).toMatchObject({ percent: 68, tone: 'now' });
    expect(bars[5]).toMatchObject({ percent: null, tone: 'empty' });
    expect(bars.filter((b) => b.percent != null)).toHaveLength(3);
  });
});
