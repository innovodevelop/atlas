/**
 * Presentation helpers shared by the mail components. Pure functions only —
 * nothing here reads the hook, so the components stay trivially testable.
 */
import type { MailThreadStatus, MailView } from '@/types/mail';

/** Sidebar order. `sent_today` reads 0 until the Workers Paid plan exists (contract §0.1). */
export const MAIL_VIEWS: readonly MailView[] = [
  'triage', 'approve', 'drafting', 'escalate', 'snoozed', 'handled', 'handoff', 'sent_today',
] as const;

/** View labels are the product's vocabulary, not the enum's — the empty-state copy interpolates them. */
export const VIEW_LABELS: Record<MailView, string> = {
  triage: 'Triage',
  approve: 'Needs approval',
  drafting: 'Atlas drafting',
  escalate: 'Escalations',
  snoozed: 'Scheduled',
  handled: 'Handled by Atlas',
  handoff: 'With humans',
  sent_today: 'Sent today',
};

export const STATUS_LABELS: Record<MailThreadStatus, string> = {
  triage: 'Triage',
  approve: 'Needs approval',
  drafting: 'Drafting',
  escalate: 'Escalated',
  snooze: 'Snoozed',
  handled: 'Handled',
  handoff: 'With humans',
};

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

/**
 * ISO-8601 carrying the machine's UTC offset, e.g. `2026-07-28T09:00:00+02:00`.
 *
 * `Date#toISOString()` renders the same instant in UTC, which is correct as an
 * instant but destroys the intent: a snooze the user set for "tomorrow 09:00"
 * comes back as 07:00Z and any later local-midnight comparison lands a day off
 * for anyone east or west of Greenwich. The contract (§3) requires the offset to
 * survive the round-trip, so it is written explicitly.
 */
export function isoWithOffset(d: Date): string {
  const offsetMinutes = -d.getTimezoneOffset(); // getTimezoneOffset is inverted: minutes WEST of UTC
  const sign = offsetMinutes >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
  );
}

export interface SnoozePreset {
  label: string;
  /** Offset-bearing ISO string, ready for `snooze()`. */
  until: string;
}

/**
 * Snooze options resolved in the user's own zone. The design hardcoded "07:00 CET";
 * a product that greets you about a trip to Paris cannot also assume you are in Berlin.
 */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const laterToday = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  const nextWeek = new Date(now);
  // Next Monday 09:00; `(8 - day) % 7 || 7` lands on Monday and never on today.
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7));
  nextWeek.setHours(9, 0, 0, 0);

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  return [
    { label: `In 3 hours · ${clock(laterToday)}`, until: isoWithOffset(laterToday) },
    { label: `Tomorrow ${clock(tomorrow)} ${zone}`, until: isoWithOffset(tomorrow) },
    { label: `Monday ${clock(nextWeek)} ${zone}`, until: isoWithOffset(nextWeek) },
  ];
}

/** Compact list-row time: clock today, weekday this week, date beyond that. */
export function shortTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - d.getTime() < 6 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Full timestamp for the reading pane and the audit trail — zone included, because the trail is evidence. */
export function fullTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

/** `"Ada Lovelace <ada@example.com>"` → `Ada Lovelace`; bare addresses pass through. */
export function displayName(address: string | null | undefined): string {
  if (!address) return 'Unknown sender';
  const named = address.match(/^\s*"?([^"<]+?)"?\s*</);
  if (named) return named[1].trim();
  return address.trim();
}

/** Bare `example.com` from any address form, for the "what it matched on" pills. */
export function senderDomain(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  return address.slice(at + 1).replace(/[>\s]/g, '').toLowerCase() || null;
}

export function participantSummary(participants: string[] | undefined): string {
  if (!participants || participants.length === 0) return 'Unknown sender';
  const names = participants.map(displayName);
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
