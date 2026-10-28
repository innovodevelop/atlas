/**
 * The Beta Settings' reading of what Atlas can actually set — pure, tested
 * here, rendered by src/pages/atlas/BetaSettings.tsx.
 *
 * `Atlas Settings Beta.dc.html` draws thirteen sections in four groups. Nine
 * have a store behind them (the Workshop tabs), four read what this Mac
 * reports (`useSystemVitals`, read-only — the webview has no command to join a
 * network or pair a device), and a fourteenth, "Beta UI", is the way back to
 * the Workshop while the redesign is in beta. Which section a URL means — the
 * `#wifi` hash the status panels link with, the `?tab=memory` the account menu
 * has always sent — is decided here, so the page and every deep link agree.
 *
 * Nothing in this file imports a hook: the strict gate (tsconfig.strict.json)
 * checks the whole import closure of src/lib, and the hooks reach
 * localClient.ts, which is outside it. The shapes the page hands over are
 * therefore re-declared structurally where a hook's own type would do.
 */
import type { IconName } from '@/components/atlas/icons';
import type { PermissionId } from '@/lib/atlasPermissions';
import type { Battery, BtDevice } from '@/lib/systemVitals';

export type SettingsGroup = 'Atlas' | 'Connections' | 'This Mac' | 'System';

export type SectionId =
  | 'voice' | 'personality' | 'memory' | 'permissions'
  | 'mail' | 'portfolio' | 'music'
  | 'wifi' | 'bluetooth' | 'devices' | 'battery'
  | 'updates' | 'budget' | 'beta';

export interface SettingsSection {
  id: SectionId;
  group: SettingsGroup;
  label: string;
  icon: IconName;
  /** The one line under the title, from the design. */
  intro: string;
  /** Operator instrumentation; hidden in the consumer edition like the Workshop's Budget tab. */
  admin?: boolean;
}

/** The design's order, group by group. Copy is the handoff's. */
export const SECTIONS: readonly SettingsSection[] = [
  { id: 'voice', group: 'Atlas', label: 'Voice', icon: 'voice', intro: 'How Atlas sounds when it speaks, and how it listens for you.' },
  { id: 'personality', group: 'Atlas', label: 'Personality', icon: 'sparkle', intro: 'Tune how warm, playful, formal, detailed and direct Atlas is with you.' },
  { id: 'memory', group: 'Atlas', label: 'Memory & Privacy', icon: 'memory', intro: 'Everything Atlas remembers about you, stored on this Mac. Forget any of it at any time.' },
  { id: 'permissions', group: 'Atlas', label: 'Permissions', icon: 'lock', intro: 'What you allowed Atlas to do when it first started, and the way back to change it.' },
  { id: 'mail', group: 'Connections', label: 'Mail', icon: 'mail', intro: 'Mailboxes Atlas reads, read-only, for bills, deadlines and documents.' },
  { id: 'portfolio', group: 'Connections', label: 'Portfolio', icon: 'markets', intro: 'Your brokerage link. Holdings sync read-only and are analysed on this Mac only.' },
  { id: 'music', group: 'Connections', label: 'Music', icon: 'music', intro: 'Spotify playback through Atlas, and the control to withdraw it.' },
  { id: 'wifi', group: 'This Mac', label: 'Wi-Fi', icon: 'wi-fi', intro: 'The network this Mac is on, as macOS reports it.' },
  { id: 'bluetooth', group: 'This Mac', label: 'Bluetooth', icon: 'bluetooth', intro: 'Headphones, input devices and everything else connected to this Mac right now.' },
  { id: 'devices', group: 'This Mac', label: 'Devices', icon: 'mac', intro: 'This Mac and the devices Atlas can see around it.' },
  { id: 'battery', group: 'This Mac', label: 'Battery', icon: 'battery', intro: 'Charge and power, as this Mac reports them.' },
  { id: 'updates', group: 'System', label: 'Software Update', icon: 'download', intro: 'Keep Atlas current. Updates are signature-verified and never installed until you say so.' },
  { id: 'budget', group: 'System', label: 'Budget & AI', icon: 'energy', intro: 'Model spend, token usage by tier, provider health and the emergency stop.', admin: true },
  { id: 'beta', group: 'System', label: 'Beta UI', icon: 'sliders', intro: 'The redesigned Atlas, and the way back to the Workshop while it is in beta.' },
];

export const SECTION_BY_ID: Readonly<Record<SectionId, SettingsSection>> = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s]),
) as Record<SectionId, SettingsSection>;

export const DEFAULT_SECTION: SectionId = 'voice';

/** The sections an edition shows. Mirrors `visibleSettingsTabs`: only `consumer` hides the admin ones. */
export function visibleSections(edition: string): SettingsSection[] {
  return edition === 'consumer' ? SECTIONS.filter((s) => !s.admin) : [...SECTIONS];
}

export interface SectionGroup { label: SettingsGroup; items: SettingsSection[] }

/** The nav's groups, in the order the sections first name them. */
export function sectionGroups(sections: readonly SettingsSection[]): SectionGroup[] {
  const out: SectionGroup[] = [];
  for (const s of sections) {
    let g = out.find((x) => x.label === s.group);
    if (!g) { g = { label: s.group, items: [] }; out.push(g); }
    g.items.push(s);
  }
  return out;
}

/**
 * Which section a URL opens. The hash wins (`#wifi` from a status panel, `#mail`
 * from the Mail sidebar — and the nav itself writes the hash), then `?tab=`
 * (the account menu's `?tab=memory`), then the first section. An id the
 * edition does not show falls through rather than opening a hidden screen.
 */
export function resolveSection(hash: string | null | undefined, tab: string | null | undefined, edition: string): SectionId {
  const shown = new Set(visibleSections(edition).map((s) => s.id));
  for (const raw of [hash, tab]) {
    const id = (raw ?? '').replace(/^#/, '').trim();
    if (id && shown.has(id as SectionId)) return id as SectionId;
  }
  return DEFAULT_SECTION;
}

export interface NavBadge { text: string; tone: 'red' | 'blue' | 'quiet' }

/** The small pill after a nav label: a mailbox that needs you, an update, or "Admin". */
export function navBadge(section: SettingsSection, ctx: { mailAttention: number; updateAvailable: boolean }): NavBadge | null {
  if (section.id === 'mail' && ctx.mailAttention > 0) return { text: String(ctx.mailAttention), tone: 'red' };
  if (section.id === 'updates' && ctx.updateAvailable) return { text: 'New', tone: 'blue' };
  if (section.admin) return { text: 'Admin', tone: 'quiet' };
  return null;
}

/* ── Personality ─────────────────────────────────────────────────────────── */

export type TraitKey = 'warmth' | 'playfulness' | 'formality' | 'verbosity' | 'directness';

export interface TraitMeta { key: TraitKey; label: string; description: string; low: string; high: string }

/** The five dials, with the design's copy. The brain stores each as 0–1. */
export const TRAITS: readonly TraitMeta[] = [
  { key: 'warmth', label: 'Warmth', description: 'How caring and encouraging Atlas is with you.', low: 'Matter-of-fact', high: 'Very warm' },
  { key: 'playfulness', label: 'Playfulness', description: 'How much humour Atlas mixes in. It tones this down on its own when the moment is serious.', low: 'Strictly serious', high: 'Playful' },
  { key: 'formality', label: 'Formality', description: 'Relaxed and casual, or polished and professional.', low: 'Casual', high: 'Formal' },
  { key: 'verbosity', label: 'Detail', description: 'Quick and to the point, or thorough with context.', low: 'Brief', high: 'Detailed' },
  { key: 'directness', label: 'Directness', description: 'Gentle suggestions, or straight answers.', low: 'Gentle', high: 'Direct' },
];

/** The word beside a dial, for a value in 0–1: the ends, a lean, or balanced. */
export function traitWord(v: number, low: string, high: string): string {
  if (v < 0.2) return low;
  if (v > 0.8) return high;
  if (v < 0.42) return `Leaning ${low.toLowerCase()}`;
  if (v > 0.58) return `Leaning ${high.toLowerCase()}`;
  return 'Balanced';
}

/* ── This Mac ────────────────────────────────────────────────────────────── */

export const PERMISSION_ICON: Readonly<Record<PermissionId, IconName>> = {
  microphone: 'mic',
  notifications: 'bell',
  liveData: 'cloud',
  proactive: 'sparkle',
};

/** The glyph for a connected Bluetooth device, from its kind and failing that its name. */
export function btIcon(d: Pick<BtDevice, 'name' | 'kind'>): IconName {
  const k = (d.kind ?? '').toLowerCase();
  const n = d.name.toLowerCase();
  if (k.includes('headphone') || k.includes('headset') || /airpods|beats/.test(n)) return 'airpods';
  if (k.includes('watch') || n.includes('watch')) return 'watch';
  if (k.includes('phone') || n.includes('iphone')) return 'iphone';
  if (k.includes('keyboard') || n.includes('keyboard')) return 'keyboard';
  if (k.includes('trackpad') || k.includes('mouse') || /trackpad|mouse/.test(n)) return 'trackpad';
  if (k.includes('speaker') || n.includes('speaker')) return 'speaker';
  return 'bluetooth';
}

export interface BatteryHeadline { kicker: string; big: string; line: string; tone: 'green' | 'blue' | 'red' | 'quiet' }

/**
 * The battery hero: what the Mac is running on, the percentage, and the
 * estimate it gives. `loading` is the moment before the first reading: the
 * vitals hook reports `battery: null` both then and on a Mac with no battery,
 * and only the second of those is "mains power".
 */
export function batteryHeadline(b: Battery | null, loading = false): BatteryHeadline {
  if (!b && loading) return { kicker: 'Checking', big: '…', line: 'Reading the battery from this Mac.', tone: 'quiet' };
  if (!b) return { kicker: 'No battery', big: '—', line: 'This Mac runs on mains power.', tone: 'quiet' };
  const big = `${b.percent}%`;
  if (b.charging) return { kicker: 'Charging', big, line: b.remaining ?? 'Charging', tone: 'green' };
  if (b.on_power) return { kicker: 'On power', big, line: b.remaining ?? 'Plugged in, not charging', tone: 'blue' };
  return { kicker: 'On battery', big, line: b.remaining ?? 'On battery', tone: b.percent <= 15 ? 'red' : 'blue' };
}

/* ── Connections ─────────────────────────────────────────────────────────── */

const PROVIDER_LABEL: Readonly<Record<string, string>> = { gmail: 'Gmail', outlook: 'Outlook', imap: 'IMAP' };

/** The provider's name, as the trail of a mailbox row. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/**
 * How long ago an ISO timestamp was, as a mailbox row says it: "just now",
 * "6 min ago", "3 h ago", "yesterday", "4 days ago", then the date. Floors
 * rather than rounds, so 59 minutes never reads as "60 min ago".
 */
export function agoLabel(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The fields of a `MailAccount` (src/hooks/useMailIntelligence.ts) a row reads; not imported — see the file header. */
export interface MailboxInput { provider: string; status: string; last_error: string | null; last_synced_at: string | null }

export interface MailboxLine { text: string; tone: 'ok' | 'warn' | 'quiet' }

/**
 * The line under a mailbox's address. The admin mailbox is listed but is not
 * the user's to scan or remove. An active mailbox with a `last_error` had a
 * transient failure the background sync retries on its own (the hook's
 * reading); any other status needs the user to sign in again.
 */
export function mailboxLine(a: MailboxInput, o: { userMailbox: boolean; scanning: boolean; now: number }): MailboxLine {
  if (!o.userMailbox) return { text: 'Admin mailbox · managed by Atlas, can’t be removed here', tone: 'quiet' };
  if (o.scanning) return { text: 'Scanning…', tone: 'quiet' };
  if (a.status === 'active') {
    if (a.last_error) return { text: 'Active · the last scan failed; Atlas retries on its own', tone: 'quiet' };
    const ago = agoLabel(a.last_synced_at, o.now);
    return { text: `Active · read-only · ${ago ? `scanned ${ago}` : 'not scanned yet'}`, tone: 'ok' };
  }
  return { text: a.last_error ?? 'Sign-in expired. Reconnect to resume scanning.', tone: 'warn' };
}

/* ── Software Update ─────────────────────────────────────────────────────── */

/** Mirrors `UpdaterPhase` in src/hooks/useAppUpdater.ts (not imported — see the file header). */
export type UpdatePhase = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'installed' | 'error';

export interface UpdateInput {
  /** False outside the desktop app: the browser preview has no bundle. */
  supported: boolean;
  phase: UpdatePhase;
  /** The running version, once read. */
  version: string | null;
  available: { version: string; date: string | null } | null;
  error: string | null;
  downloaded: number;
  total: number | null;
}

export interface UpdateCard {
  kicker: string;
  title: string;
  body: string;
  tone: 'paper' | 'blue' | 'green' | 'ink' | 'red';
  /** Download progress, 0–100, only while downloading with a known size. */
  pct: number | null;
  action: 'check' | 'install' | null;
  actionLabel: string;
}

export function pctOf(downloaded: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** The update hero's copy and tone for every phase of the real updater. */
export function updateCard(u: UpdateInput): UpdateCard {
  const running = u.version ? `Atlas ${u.version}` : 'Atlas';
  if (!u.supported) {
    return { kicker: 'Desktop app', title: 'Updates live in the Mac app', body: 'This preview has no bundle to update. Open Atlas on your Mac to check for updates.', tone: 'paper', pct: null, action: null, actionLabel: '' };
  }
  switch (u.phase) {
    case 'checking':
      return { kicker: 'Checking', title: 'Looking for updates…', body: 'This takes a few seconds.', tone: 'blue', pct: null, action: null, actionLabel: '' };
    case 'upToDate':
      return { kicker: 'Up to date', title: running, body: 'You have the latest version. Last checked just now.', tone: 'green', pct: null, action: 'check', actionLabel: 'Check again' };
    case 'available': {
      const when = u.available?.date ? `Released ${u.available.date.split(' ')[0]}. ` : '';
      return { kicker: 'Update available', title: `Atlas ${u.available?.version ?? ''}`.trim(), body: `${when}It downloads in the background and its signature is verified before anything is installed. Nothing happens until you say so here.`, tone: 'blue', pct: null, action: 'install', actionLabel: 'Download and install' };
    }
    case 'downloading':
      return { kicker: 'Downloading', title: `Atlas ${u.available?.version ?? ''}`.trim(), body: 'Keep working. Atlas verifies the signature and installs when the download finishes.', tone: 'ink', pct: pctOf(u.downloaded, u.total), action: null, actionLabel: '' };
    case 'installed':
      return { kicker: 'Ready', title: 'Quit and reopen Atlas to finish', body: 'The signature was verified and the new version is staged. It starts the next time Atlas opens; conversations and memories carry over.', tone: 'ink', pct: null, action: null, actionLabel: '' };
    case 'error':
      return { kicker: 'Update check failed', title: 'Atlas keeps running', body: u.error ?? 'Unknown error. If you are offline, try again once you are connected.', tone: 'red', pct: null, action: 'check', actionLabel: 'Try again' };
    case 'idle':
    default:
      return { kicker: 'Not checked yet', title: running, body: 'Atlas checks the release feed when this screen opens. Installing only ever happens when you approve it here.', tone: 'paper', pct: null, action: 'check', actionLabel: 'Check for updates' };
  }
}
