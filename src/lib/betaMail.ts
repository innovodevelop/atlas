/**
 * The Beta Mail's reading of the mail model — pure, tested here, rendered by
 * src/pages/atlas/BetaMail.tsx and src/components/atlas/mail/*.
 *
 * `Atlas Mail Beta.dc.html` names lanes and states the app's model does not
 * have one-to-one (its "Archive", its per-message "Atlas replied"); this is
 * the honest mapping onto the statuses, drafts and audit rows that exist.
 * Archive is 'handled' on the worker plus a local mail_archived row; a reply
 * watch is a mail_snoozes row beside the snooze.
 */
import type { IconName } from '@/components/atlas/icons';
import { isoWithOffset } from '@/components/atlas-ui/mail/mailFormat';
import type { MailAuditEvent, MailCounts, MailDraft, MailThread, MailThreadStatus, MailView } from '@/types/mail';

export type ChipTone = 'need' | 'held' | 'done' | 'quiet';

export interface Lane {
  view: MailView;
  label: string;
  icon: IconName;
  desc: string;
  /** The count pill turns red when this lane has anything. */
  urgent?: boolean;
}

export const LANES: readonly Lane[] = [
  { view: 'needs_you', label: 'Needs you', icon: 'warning', desc: 'Decisions, held replies and drafts. Everything else is handled.', urgent: true },
  { view: 'handled', label: 'Atlas handled', icon: 'sparkle', desc: 'Replied or filed, each with the rule it used.' },
  { view: 'inbox', label: 'Inbox', icon: 'inbox', desc: 'Every account, newest first.' },
  { view: 'snoozed', label: 'Snoozed', icon: 'clock', desc: 'Back when you said.' },
  { view: 'sent_today', label: 'Sent today', icon: 'send', desc: 'By you and by Atlas.' },
  { view: 'archive', label: 'Archive', icon: 'folder', desc: 'Out of the way, never deleted.' },
];

export const LANE_BY_VIEW: ReadonlyMap<MailView, Lane> = new Map(LANES.map((l) => [l.view, l]));

export const STATUS_CHIP: Record<MailThreadStatus, { label: string; tone: ChipTone }> = {
  triage: { label: 'Needs you', tone: 'need' },
  approve: { label: 'Held for you', tone: 'held' },
  drafting: { label: 'Draft ready', tone: 'held' },
  escalate: { label: 'Escalated', tone: 'need' },
  snooze: { label: 'Snoozed', tone: 'quiet' },
  handled: { label: 'Handled', tone: 'done' },
  handoff: { label: 'With a human', tone: 'quiet' },
};

export function laneCount(counts: Partial<MailCounts>, view: MailView): number {
  return counts[view] ?? 0;
}

/** The hero's greeting and subline, from the counts alone. */
export function mailGreeting(counts: Partial<MailCounts>): { greeting: string; subline: string; needN: number; handledN: number } {
  const needN = counts.needs_you ?? 0;
  const handledN = counts.handled ?? 0;
  const greeting = needN ? `${needN} ${needN === 1 ? 'thing needs' : 'things need'} you` : 'Nothing needs you';
  const subline = needN
    ? handledN ? `Atlas handled ${handledN} and held the rest.` : 'Atlas held these for you.'
    : handledN ? `Atlas is handling the rest quietly — ${handledN} so far.` : 'Atlas is handling the rest quietly.';
  return { greeting, subline, needN, handledN };
}

export interface AtlasCard {
  tone: ChipTone;
  title: string;
  body: string;
  facts: string[];
  /** The one primary action: approve the live draft and send. */
  decision?: { label: string };
  /** Put the thread back: which status it returns to. */
  undo?: { label: string; status: MailThreadStatus };
  pending?: boolean;
}

const WHEN = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function latestEvent(audit: readonly MailAuditEvent[]): MailAuditEvent | null {
  return [...audit].sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/** What the reader knows about a thread beyond its row: its reply watch, whether it is archived. */
export interface ThreadExtras {
  /** '*' or a lower-cased address the snooze waits for (mail_snoozes). */
  watch?: string | null;
  archived?: boolean;
}

/** "dana@x.com", or "anyone" for the '*' watch. */
export function watchWho(watch: string): string {
  return watch === '*' ? 'anyone' : watch;
}

/** The card above the messages: what Atlas did or is waiting for, from rows only. */
export function atlasCard(
  thread: MailThread,
  audit: readonly MailAuditEvent[],
  liveDraft: MailDraft | null,
  pendingSend: boolean,
  matched: readonly { label: string; value: string }[],
  extras: ThreadExtras = {},
): AtlasCard {
  const facts = matched.map((p) => `${p.label} · ${p.value}`);
  const latest = latestEvent(audit);
  const detail = latest && latest.actor !== 'user' && latest.detail ? latest.detail : null;
  if (pendingSend) {
    return { tone: 'held', title: 'Sending in a moment', body: 'Your reply goes out when the countdown ends. Undo keeps it as a draft.', facts, pending: true };
  }
  switch (thread.status) {
    case 'approve':
      return liveDraft
        ? { tone: 'held', title: 'Atlas held a reply', body: detail ? `Atlas drafted a reply and stopped: ${detail}` : 'Atlas drafted a reply and stopped — this one is yours to approve.', facts, decision: { label: 'Approve and send' } }
        : { tone: 'held', title: 'Held for your approval', body: detail ?? 'This thread is waiting for your decision. Draft a reply below, or mark it done.', facts };
    case 'drafting':
      return liveDraft
        ? { tone: 'held', title: 'Draft ready in your tone', body: 'Read it below, change anything, then send.', facts }
        : { tone: 'held', title: 'Atlas is drafting', body: 'A draft will appear below, or write your own.', facts };
    case 'triage':
      return { tone: 'need', title: 'This needs your decision', body: detail ?? 'New since the last sync. Reply, snooze, or mark it done.', facts };
    case 'escalate':
      return { tone: 'need', title: 'Escalated to you', body: detail ?? 'Atlas would not act on this alone.', facts };
    case 'handoff':
      return { tone: 'quiet', title: 'With a human', body: detail ?? 'Handed off. Atlas will not touch it until you take it back.', facts, undo: { label: 'Take it back', status: 'triage' } };
    case 'handled':
      if (extras.archived) {
        return { tone: 'done', title: 'Archived', body: 'Out of the way, never deleted. A reply brings it back to the inbox.', facts, undo: { label: 'Move back to Needs you', status: 'triage' } };
      }
      return {
        tone: 'done',
        title: latest?.actor === 'user' ? 'Marked done by you' : 'Handled by Atlas',
        body: detail ?? 'Out of the way, never deleted.',
        facts,
        undo: { label: 'Move back to Needs you', status: 'triage' },
      };
    case 'snooze':
      return {
        tone: 'quiet',
        title: extras.watch ? `Waiting for ${watchWho(extras.watch)} to reply` : 'Snoozed',
        body: extras.watch
          ? `Atlas checks every sync and brings it back when ${watchWho(extras.watch)} replies${thread.snoozed_until ? `, or ${WHEN.format(new Date(thread.snoozed_until))} at the latest` : ''}.`
          : thread.snoozed_until ? `Back ${WHEN.format(new Date(thread.snoozed_until))}.` : 'Back later.',
        facts,
        undo: { label: 'Bring it back now', status: 'triage' },
      };
  }
}

/** "First time writing to …": any recipient no thread has ever carried. */
export function isFirstContact(to: string, known: readonly string[]): boolean {
  const tokens = to.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.some((t) => !known.some((k) => k === t || (t.includes('@') && k === t) || (!t.includes('@') && k.startsWith(t))));
}

/** What a new message opens in the user's own mail app with — Atlas cannot start conversations yet. */
export function mailtoUrl(to: string, subject: string, body: string): string {
  const q = [subject ? `subject=${encodeURIComponent(subject)}` : '', body ? `body=${encodeURIComponent(body)}` : ''].filter(Boolean).join('&');
  return `mailto:${encodeURIComponent(to.trim())}${q ? `?${q}` : ''}`;
}

export function composePrompt(opts: { to: string; subject: string; body: string; firstName: string | null }): string {
  const who = opts.to.trim() ? ` to ${opts.to.trim()}` : '';
  const about = opts.subject.trim() ? ` Subject: ${opts.subject.trim()}.` : '';
  const say = opts.body.trim() ? ` What I want to say: ${opts.body.trim()}` : ' Keep it to a short, friendly note asking for a reply.';
  const sign = opts.firstName ? ` Sign it "${opts.firstName}".` : '';
  return `Write a short, friendly email from me${who}.${about}${say} Reply with only the email body, no subject line and no preamble.${sign}`;
}

export const REWRITES: readonly { key: string; label: string; instruction: string }[] = [
  { key: 'short', label: 'Shorter', instruction: 'Make it shorter and more direct. Keep the meaning and the tone.' },
  { key: 'warm', label: 'Warmer', instruction: 'Make it warmer and friendlier without making it longer.' },
];

/** "Send later" default: tomorrow 08:00 in the user's zone, with its offset. */
export function laterSendIso(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return isoWithOffset(d);
}

export function initialsOf(name: string): string {
  const parts = name.replace(/[<>"]/g, '').split('@')[0].split(/[\s._-]+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '?');
}

// ---------------------------------------------------------------------------
// Snooze "until they reply" (row 21)
// ---------------------------------------------------------------------------

/** "Dana Whitfield <Dana@X.com>" → "dana@x.com"; a bare address is lower-cased. Mirrors mail_flags::sender_address. */
export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** The person a reply would come from: the first participant that is not our own mailbox. */
export function watchTarget(thread: Pick<MailThread, 'participants' | 'mailbox'>): { address: string; name: string } | null {
  const own = thread.mailbox.trim().toLowerCase();
  const who = thread.participants.find((p) => addressOf(p) !== own);
  if (!who) return null;
  const address = addressOf(who);
  if (!address.includes('@')) return null;
  const named = who.includes('<') ? who.split('<')[0].trim().replace(/^"|"$/g, '') : '';
  return { address, name: (named || address.split('@')[0]).split(/\s+/)[0] };
}

export interface ReplySnooze {
  label: string;
  hint: string;
  /** The lower-cased address, or '*' for anyone. */
  watch: string;
  /** The fallback: the thread comes back then even if nobody replied. */
  until: string;
}

/** How long a reply watch waits before the snooze comes back on its own. */
export const REPLY_FALLBACK_DAYS = 7;

/**
 * The design's "When Dana replies · Atlas watches", plus "anyone" for a thread
 * with several people in it. Each carries a fallback a week out at 09:00, so a
 * reply that never comes cannot hide the thread for good.
 */
export function replySnoozes(thread: Pick<MailThread, 'participants' | 'mailbox'>, now = new Date()): ReplySnooze[] {
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + REPLY_FALLBACK_DAYS);
  fallback.setHours(9, 0, 0, 0);
  const until = isoWithOffset(fallback);
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(fallback);
  const hint = `Atlas watches · back ${day} at the latest`;
  const own = thread.mailbox.trim().toLowerCase();
  const others = new Set(thread.participants.map(addressOf).filter((a) => a !== own));
  const out: ReplySnooze[] = [];
  const target = watchTarget(thread);
  if (target) out.push({ label: `When ${target.name} replies`, hint, watch: target.address, until });
  if (!target || others.size > 1) out.push({ label: 'When anyone replies', hint, watch: '*', until });
  return out;
}

/**
 * Milliseconds until the earliest snoozed thread is due, for the timer that
 * asks Rust to wake it while Mail is open; 0 when one is already due, null
 * when nothing is snoozed with a time. Capped to what setTimeout accepts.
 */
export function nextWakeDelay(threads: readonly Pick<MailThread, 'status' | 'snoozed_until'>[], now = Date.now()): number | null {
  let soonest: number | null = null;
  for (const t of threads) {
    if (t.status !== 'snooze' || !t.snoozed_until) continue;
    const at = Date.parse(t.snoozed_until);
    if (Number.isNaN(at)) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  if (soonest === null) return null;
  return Math.min(Math.max(0, soonest - now), 2_147_483_647);
}

// ---------------------------------------------------------------------------
// Archive (row 22)
// ---------------------------------------------------------------------------

/**
 * Whether an archived thread is still archived. The worker has no archived
 * status, so an archived thread is 'handled' there with a row in
 * mail_archived; it stops counting as archived once anything moves it out of
 * 'handled' or a newer message arrives (a reply brings it back, as in every
 * mail client).
 */
export function isArchived(thread: Pick<MailThread, 'status' | 'last_message_at'>, archivedAt: string | null | undefined): boolean {
  if (!archivedAt || thread.status !== 'handled') return false;
  if (!thread.last_message_at) return true;
  const last = Date.parse(thread.last_message_at);
  const at = Date.parse(archivedAt);
  return Number.isNaN(last) || Number.isNaN(at) || last <= at;
}

/** What `mail_archive_message` answers when the provider did not move the message. */
export interface ArchiveRefusal {
  ok: false;
  reason: 'reconnect' | 'no_folder' | 'gone';
  provider: string;
  email: string;
  accountId: string;
}

export type ArchiveResult = { ok: true } | ArchiveRefusal;

/** The sentence for a refusal; for `reconnect` it is also the button's label. */
export function refusalText(r: ArchiveRefusal, archiving: boolean): string {
  switch (r.reason) {
    case 'reconnect': return `Reconnect ${r.email} to ${archiving ? 'archive' : 'move mail back'}`;
    case 'no_folder': return `${r.email} has no Archive folder. Atlas does not create one; archive it in your mail app.`;
    case 'gone': return `${r.email} no longer has this message where Atlas left it.`;
  }
}

/** Only a Gmail or Outlook grant is widened by signing in again; IMAP already logs in with full access. */
export function canReconnectToArchive(provider: string): provider is 'gmail' | 'outlook' {
  return provider === 'gmail' || provider === 'outlook';
}

// ---------------------------------------------------------------------------
// Mailbox toasts (row 24)
// ---------------------------------------------------------------------------

export interface MailboxRow {
  id: string;
  provider: string;
  email_address: string;
  status: string;
}

/**
 * Which mailboxes finished connecting or were disconnected between two reads
 * of the account list. Connected: active now, and missing or not active
 * before (a reconnect that worked counts). Disconnected: gone. `isMine` keeps
 * it to the mailboxes the user connects themselves.
 */
export function mailboxChanges<T extends MailboxRow>(prev: readonly T[], next: readonly T[], isMine: (a: T) => boolean): { connected: string[]; disconnected: string[] } {
  const before = new Map(prev.filter(isMine).map((a) => [a.id, a]));
  const after = new Map(next.filter(isMine).map((a) => [a.id, a]));
  const connected = [...after.values()].filter((a) => a.status === 'active' && before.get(a.id)?.status !== 'active').map((a) => a.email_address);
  const disconnected = [...before.values()].filter((a) => !after.has(a.id)).map((a) => a.email_address);
  return { connected, disconnected };
}

/** The toast lines for those changes: the design's "Mailbox connected", with the address. */
export function mailboxToasts(changes: { connected: string[]; disconnected: string[] }): string[] {
  return [
    ...changes.connected.map((e) => `Mailbox connected · ${e}`),
    ...changes.disconnected.map((e) => `Mailbox disconnected · ${e}`),
  ];
}
