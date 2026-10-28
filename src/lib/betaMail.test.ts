import { describe, expect, test } from 'bun:test';
import type { MailAuditEvent, MailDraft, MailThread } from '@/types/mail';
import {
  addressOf, atlasCard, canReconnectToArchive, composePrompt, initialsOf, isArchived, isFirstContact, laterSendIso, mailboxChanges, mailboxToasts,
  mailGreeting, mailtoUrl, nextWakeDelay, refusalText, replySnoozes, watchTarget,
} from './betaMail';

const thread = (status: MailThread['status'], extra: Partial<MailThread> = {}): MailThread => ({
  id: 't1', account_id: 'a1', provider_thread_id: 'p1', subject: 'Hello', participants: ['dana@theverge.com'], status,
  snoozed_until: null, unread_count: 0, last_message_at: null, handled_at: null, updated_at: '2026-10-27T10:00:00Z', mailbox: 'me@x.dk', ...extra,
});
const ev = (seq: number, actor: MailAuditEvent['actor'], detail: string): MailAuditEvent => ({
  seq, id: `e${seq}`, thread_id: 't1', ts: '2026-10-27T10:00:00Z', actor, action: 'status_changed', detail, rule_id: null, model: null, prompt_version: null,
});
const draft: MailDraft = { id: 'd1', thread_id: 't1', body: 'Hi', state: 'proposed', scheduled_for: null, sent_at: null, model: null, prompt_version: null, updated_at: '' };

describe('mailGreeting', () => {
  test('counts what needs you', () => {
    expect(mailGreeting({ needs_you: 3, handled: 5 })).toMatchObject({ greeting: '3 things need you', subline: 'Atlas handled 5 and held the rest.' });
    expect(mailGreeting({ needs_you: 1, handled: 0 }).greeting).toBe('1 thing needs you');
    expect(mailGreeting({ needs_you: 0, handled: 0 })).toMatchObject({ greeting: 'Nothing needs you', subline: 'Atlas is handling the rest quietly.' });
  });
});

describe('atlasCard', () => {
  test('a held draft asks for the decision and uses the newest non-user detail', () => {
    const c = atlasCard(thread('approve'), [ev(1, 'rule', 'old'), ev(2, 'atlas', 'it is above your €50,000 limit.')], draft, false, [{ label: 'Rule', value: 'money' }]);
    expect(c.title).toBe('Atlas held a reply');
    expect(c.body).toBe('Atlas drafted a reply and stopped: it is above your €50,000 limit.');
    expect(c.decision?.label).toBe('Approve and send');
    expect(c.facts).toEqual(['Rule · money']);
  });
  test('a user event is not quoted as Atlas speaking', () => {
    expect(atlasCard(thread('triage'), [ev(3, 'user', 'marked read')], null, false, []).body).toBe('New since the last sync. Reply, snooze, or mark it done.');
  });
  test('handled and snoozed carry an undo back to Needs you', () => {
    expect(atlasCard(thread('handled'), [ev(1, 'atlas', 'Filed under the rule “newsletters”.')], null, false, [])).toMatchObject({ tone: 'done', title: 'Handled by Atlas', undo: { status: 'triage' } });
    expect(atlasCard(thread('handled'), [ev(1, 'user', 'done')], null, false, []).title).toBe('Marked done by you');
    expect(atlasCard(thread('snooze', { snoozed_until: '2026-10-28T08:00:00+01:00' }), [], null, false, []).undo?.label).toBe('Bring it back now');
  });
  test('a pending send wins over the status', () => {
    expect(atlasCard(thread('approve'), [], draft, true, []).pending).toBe(true);
  });
});

describe('isFirstContact', () => {
  const known = ['dana@theverge.com', 'priya@raman.studio'];
  test('known addresses are not first contact', () => {
    expect(isFirstContact('dana@theverge.com', known)).toBe(false);
    expect(isFirstContact('Dana@TheVerge.com', known)).toBe(false);
    expect(isFirstContact('priya', known)).toBe(false);
  });
  test('anyone new is', () => {
    expect(isFirstContact('new@person.io', known)).toBe(true);
    expect(isFirstContact('dana@theverge.com, new@person.io', known)).toBe(true);
    expect(isFirstContact('', known)).toBe(false);
  });
});

describe('compose helpers', () => {
  test('mailto carries subject and body, encoded', () => {
    expect(mailtoUrl('a@b.c', 'Hi there', 'Line 1\nLine 2')).toBe('mailto:a%40b.c?subject=Hi%20there&body=Line%201%0ALine%202');
    expect(mailtoUrl('a@b.c', '', '')).toBe('mailto:a%40b.c');
  });
  test('the prompt asks for only a body', () => {
    const p = composePrompt({ to: 'Dana', subject: 'Embargo', body: 'confirm Thursday', firstName: 'Magnus' });
    expect(p).toContain('to Dana');
    expect(p).toContain('Subject: Embargo.');
    expect(p).toContain('only the email body');
    expect(p).toContain('Sign it "Magnus"');
  });
  test('send later is tomorrow 08:00 with an offset', () => {
    const iso = laterSendIso(new Date(2026, 9, 27, 15, 0, 0));
    expect(iso.startsWith('2026-10-28T08:00:00')).toBe(true);
    expect(/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)).toBe(true);
  });
  test('initials', () => {
    expect(initialsOf('Dana Whitfield')).toBe('DW');
    expect(initialsOf('dana.whitfield@theverge.com')).toBe('DW');
    expect(initialsOf('')).toBe('?');
  });
});

describe('snooze until they reply', () => {
  test('the watch is the other person, by address, with a week-out fallback', () => {
    const t = thread('triage', { participants: ['Dana Whitfield <Dana@TheVerge.com>', 'me@x.dk'] });
    const opts = replySnoozes(t, new Date(2026, 9, 28, 15, 0, 0));
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ label: 'When Dana replies', watch: 'dana@theverge.com' });
    expect(opts[0].until.startsWith('2026-11-04T09:00:00')).toBe(true);
    expect(/(?:Z|[+-]\d{2}:\d{2})$/.test(opts[0].until)).toBe(true);
  });
  test('a thread with several people also offers anyone', () => {
    const t = thread('triage', { participants: ['dana@theverge.com', 'priya@raman.studio', 'me@x.dk'] });
    expect(replySnoozes(t).map((o) => o.watch)).toEqual(['dana@theverge.com', '*']);
    expect(replySnoozes(thread('triage', { participants: ['me@x.dk'] })).map((o) => o.watch)).toEqual(['*']);
  });
  test('addresses and targets', () => {
    expect(addressOf('"Dana W" <Dana@X.com>')).toBe('dana@x.com');
    expect(addressOf(' Dana@X.com ')).toBe('dana@x.com');
    expect(watchTarget(thread('triage', { participants: ['ME@x.dk', 'priya@raman.studio'] }))).toEqual({ address: 'priya@raman.studio', name: 'priya' });
  });
  test('the wake timer aims at the earliest snoozed thread', () => {
    const now = Date.parse('2026-10-28T10:00:00Z');
    const rows = [
      { status: 'snooze' as const, snoozed_until: '2026-10-28T12:00:00Z' },
      { status: 'snooze' as const, snoozed_until: '2026-10-28T11:00:00+00:00' },
      { status: 'triage' as const, snoozed_until: '2026-10-28T10:30:00Z' },
    ];
    expect(nextWakeDelay(rows, now)).toBe(3_600_000);
    expect(nextWakeDelay([{ status: 'snooze', snoozed_until: '2026-10-27T10:00:00Z' }], now)).toBe(0);
    expect(nextWakeDelay([{ status: 'snooze', snoozed_until: null }], now)).toBeNull();
  });
  test('the card says who it waits for', () => {
    const c = atlasCard(thread('snooze', { snoozed_until: '2026-11-04T09:00:00+01:00' }), [], null, false, [], { watch: 'dana@theverge.com' });
    expect(c.title).toBe('Waiting for dana@theverge.com to reply');
    expect(c.body).toContain('when dana@theverge.com replies, or ');
    expect(atlasCard(thread('snooze'), [], null, false, [], { watch: '*' }).body).toBe('Atlas checks every sync and brings it back when anyone replies.');
  });
});

describe('archive', () => {
  test('a thread stays archived until it leaves handled or a reply arrives', () => {
    expect(isArchived(thread('handled', { last_message_at: '2026-10-28T09:00:00Z' }), '2026-10-28T10:00:00Z')).toBe(true);
    expect(isArchived(thread('handled', { last_message_at: '2026-10-28T11:00:00Z' }), '2026-10-28T10:00:00Z')).toBe(false);
    expect(isArchived(thread('triage'), '2026-10-28T10:00:00Z')).toBe(false);
    expect(isArchived(thread('handled'), null)).toBe(false);
  });
  test('the archived card offers the way back', () => {
    expect(atlasCard(thread('handled'), [], null, false, [], { archived: true })).toMatchObject({ title: 'Archived', undo: { status: 'triage' } });
  });
  test('refusals say what to do', () => {
    const r = { ok: false as const, reason: 'reconnect' as const, provider: 'gmail', email: 'me@gmail.com', accountId: 'gmail:u:me@gmail.com' };
    expect(refusalText(r, true)).toBe('Reconnect me@gmail.com to archive');
    expect(refusalText({ ...r, reason: 'no_folder', provider: 'imap' }, true)).toContain('has no Archive folder');
    expect(canReconnectToArchive('outlook')).toBe(true);
    expect(canReconnectToArchive('imap')).toBe(false);
  });
});

describe('mailbox toasts', () => {
  const mine = (a: { id: string }) => !a.id.startsWith('cfmail:');
  const acct = (id: string, status = 'active') => ({ id, provider: 'gmail', email_address: id.split(':').pop() ?? id, status });
  test('a new or recovered mailbox is connected, a missing one disconnected', () => {
    const prev = [acct('gmail:u:a@x.com'), acct('gmail:u:b@x.com', 'error'), acct('cfmail:u:c@x.com')];
    const next = [acct('gmail:u:b@x.com'), acct('outlook:u:d@x.com'), acct('outlook:u:e@x.com', 'error')];
    const changes = mailboxChanges(prev, next, mine);
    expect(changes).toEqual({ connected: ['b@x.com', 'd@x.com'], disconnected: ['a@x.com'] });
    expect(mailboxToasts(changes)).toEqual(['Mailbox connected · b@x.com', 'Mailbox connected · d@x.com', 'Mailbox disconnected · a@x.com']);
  });
  test('nothing changed, nothing said', () => {
    const list = [acct('gmail:u:a@x.com')];
    expect(mailboxToasts(mailboxChanges(list, [...list], mine))).toEqual([]);
  });
});
