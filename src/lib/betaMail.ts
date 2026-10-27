/**
 * The Beta Mail's reading of the mail model — pure, tested here, rendered by
 * src/pages/atlas/BetaMail.tsx and src/components/atlas/mail/*.
 *
 * `Atlas Mail Beta.dc.html` names lanes and states the app's model does not
 * have one-to-one (its "Archive", its per-message "Atlas replied"); this is
 * the honest mapping onto the statuses, drafts and audit rows that exist.
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

/** The card above the messages: what Atlas did or is waiting for, from rows only. */
export function atlasCard(
  thread: MailThread,
  audit: readonly MailAuditEvent[],
  liveDraft: MailDraft | null,
  pendingSend: boolean,
  matched: readonly { label: string; value: string }[],
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
        title: 'Snoozed',
        body: thread.snoozed_until ? `Back ${WHEN.format(new Date(thread.snoozed_until))}.` : 'Back later.',
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
