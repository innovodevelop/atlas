import { describe, expect, test } from 'bun:test';
import type { MailAuditEvent, MailDraft, MailThread } from '@/types/mail';
import { atlasCard, composePrompt, initialsOf, isFirstContact, laterSendIso, mailGreeting, mailtoUrl } from './betaMail';

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
