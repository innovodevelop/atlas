import { describe, expect, test } from 'bun:test';
import {
  SECTIONS, SECTION_BY_ID, agoLabel, batteryHeadline, btIcon, mailboxLine, navBadge, pctOf, providerLabel, resolveSection, sectionGroups, traitWord,
  updateCard, visibleSections,
} from './betaSettings';

describe('sections', () => {
  test('every id is unique and indexed', () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SECTIONS) expect(SECTION_BY_ID[s.id]).toBe(s);
  });
  test('the consumer edition hides Budget & AI, and only that', () => {
    const consumer = visibleSections('consumer').map((s) => s.id);
    expect(consumer).not.toContain('budget');
    expect(consumer.length).toBe(SECTIONS.length - 1);
    expect(visibleSections('admin').map((s) => s.id)).toContain('budget');
  });
  test('groups keep the design order', () => {
    expect(sectionGroups(visibleSections('admin')).map((g) => g.label)).toEqual(['Atlas', 'Connections', 'This Mac', 'System']);
    const system = sectionGroups(visibleSections('consumer')).find((g) => g.label === 'System')!;
    expect(system.items.map((s) => s.id)).toEqual(['updates', 'beta']);
  });
});

describe('resolveSection', () => {
  test('the hash wins over the tab', () => {
    expect(resolveSection('#wifi', 'memory', 'consumer')).toBe('wifi');
    expect(resolveSection('bluetooth', null, 'consumer')).toBe('bluetooth');
    expect(resolveSection('#battery', undefined, 'consumer')).toBe('battery');
    expect(resolveSection('#mail', null, 'consumer')).toBe('mail');
  });
  test('an unknown hash falls through to the tab, then to the default', () => {
    expect(resolveSection('#nope', 'memory', 'consumer')).toBe('memory');
    expect(resolveSection('', null, 'consumer')).toBe('voice');
    expect(resolveSection(null, 'bogus', 'consumer')).toBe('voice');
  });
  test('a hidden section is not reachable by asking for it', () => {
    expect(resolveSection('#budget', null, 'consumer')).toBe('voice');
    expect(resolveSection('#budget', null, 'admin')).toBe('budget');
  });
});

describe('navBadge', () => {
  const ctx = { mailAttention: 0, updateAvailable: false };
  test('mail counts the mailboxes that need you', () => {
    expect(navBadge(SECTION_BY_ID.mail, { ...ctx, mailAttention: 2 })).toEqual({ text: '2', tone: 'red' });
    expect(navBadge(SECTION_BY_ID.mail, ctx)).toBeNull();
  });
  test('updates says New only when one is available', () => {
    expect(navBadge(SECTION_BY_ID.updates, { ...ctx, updateAvailable: true })).toEqual({ text: 'New', tone: 'blue' });
    expect(navBadge(SECTION_BY_ID.updates, ctx)).toBeNull();
  });
  test('admin sections are stamped', () => {
    expect(navBadge(SECTION_BY_ID.budget, ctx)).toEqual({ text: 'Admin', tone: 'quiet' });
    expect(navBadge(SECTION_BY_ID.voice, ctx)).toBeNull();
  });
});

describe('traitWord', () => {
  test('ends, leans and the middle', () => {
    expect(traitWord(0.1, 'Casual', 'Formal')).toBe('Casual');
    expect(traitWord(0.3, 'Casual', 'Formal')).toBe('Leaning casual');
    expect(traitWord(0.5, 'Casual', 'Formal')).toBe('Balanced');
    expect(traitWord(0.7, 'Casual', 'Formal')).toBe('Leaning formal');
    expect(traitWord(0.95, 'Casual', 'Formal')).toBe('Formal');
  });
});

describe('batteryHeadline', () => {
  test('no battery is mains power', () => {
    expect(batteryHeadline(null)).toMatchObject({ kicker: 'No battery', big: '—', tone: 'quiet' });
  });
  test('before the first reading it says so, not "mains power"', () => {
    expect(batteryHeadline(null, true)).toMatchObject({ kicker: 'Checking', big: '…' });
    expect(batteryHeadline({ percent: 50, charging: false, on_power: false, remaining: null }, true).big).toBe('50%');
  });
  test('charging, on power, on battery, and low', () => {
    expect(batteryHeadline({ percent: 68, charging: true, on_power: true, remaining: '1:02 until full' })).toMatchObject({ kicker: 'Charging', big: '68%', line: '1:02 until full', tone: 'green' });
    expect(batteryHeadline({ percent: 100, charging: false, on_power: true, remaining: null })).toMatchObject({ kicker: 'On power', tone: 'blue' });
    expect(batteryHeadline({ percent: 40, charging: false, on_power: false, remaining: '3:12 remaining' })).toMatchObject({ kicker: 'On battery', line: '3:12 remaining', tone: 'blue' });
    expect(batteryHeadline({ percent: 9, charging: false, on_power: false, remaining: null })).toMatchObject({ tone: 'red' });
  });
});

describe('btIcon', () => {
  test('kind first, then the name', () => {
    expect(btIcon({ name: 'AirPods Pro', kind: 'Headphones' })).toBe('airpods');
    expect(btIcon({ name: 'Magic Trackpad', kind: null })).toBe('trackpad');
    expect(btIcon({ name: 'Marcus’s Apple Watch', kind: null })).toBe('watch');
    expect(btIcon({ name: 'Thing', kind: 'Mouse' })).toBe('trackpad');
    expect(btIcon({ name: 'Thing', kind: null })).toBe('bluetooth');
  });
});

describe('connections', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const at = (ms: number) => new Date(now - ms).toISOString();
  test('agoLabel floors each unit and gives up on junk', () => {
    expect(agoLabel(at(20_000), now)).toBe('just now');
    expect(agoLabel(at(6 * 60_000), now)).toBe('6 min ago');
    expect(agoLabel(at(59 * 60_000 + 59_000), now)).toBe('59 min ago');
    expect(agoLabel(at(3 * 3_600_000), now)).toBe('3 h ago');
    expect(agoLabel(at(30 * 3_600_000), now)).toBe('yesterday');
    expect(agoLabel(at(4 * 86_400_000), now)).toBe('4 days ago');
    expect(agoLabel(at(40 * 86_400_000), now)).not.toBeNull();
    expect(agoLabel(null, now)).toBeNull();
    expect(agoLabel('not a date', now)).toBeNull();
    expect(agoLabel(new Date(now + 5_000).toISOString(), now)).toBe('just now');
  });
  test('providerLabel names the three kinds and passes anything else through', () => {
    expect(providerLabel('gmail')).toBe('Gmail');
    expect(providerLabel('outlook')).toBe('Outlook');
    expect(providerLabel('imap')).toBe('IMAP');
    expect(providerLabel('exchange')).toBe('exchange');
  });
  test('mailboxLine: admin, scanning, active, transient failure, needs sign-in', () => {
    const base = { provider: 'gmail', status: 'active', last_error: null, last_synced_at: at(6 * 60_000) };
    const o = { userMailbox: true, scanning: false, now };
    expect(mailboxLine(base, { ...o, userMailbox: false })).toMatchObject({ tone: 'quiet' });
    expect(mailboxLine(base, { ...o, scanning: true }).text).toBe('Scanning…');
    expect(mailboxLine(base, o)).toEqual({ text: 'Active · read-only · scanned 6 min ago', tone: 'ok' });
    expect(mailboxLine({ ...base, last_synced_at: null }, o).text).toBe('Active · read-only · not scanned yet');
    expect(mailboxLine({ ...base, last_error: 'timeout' }, o).tone).toBe('quiet');
    expect(mailboxLine({ ...base, status: 'error', last_error: 'invalid_grant' }, o)).toEqual({ text: 'invalid_grant', tone: 'warn' });
    expect(mailboxLine({ ...base, status: 'expired' }, o)).toMatchObject({ text: 'Sign-in expired. Reconnect to resume scanning.', tone: 'warn' });
  });
});

describe('updateCard', () => {
  const base = { supported: true, version: '2.4.1', available: null, error: null, downloaded: 0, total: null } as const;
  test('the preview has nothing to update', () => {
    expect(updateCard({ ...base, supported: false, phase: 'idle' })).toMatchObject({ tone: 'paper', action: null });
  });
  test('idle and up to date offer a check', () => {
    expect(updateCard({ ...base, phase: 'idle' })).toMatchObject({ title: 'Atlas 2.4.1', action: 'check' });
    expect(updateCard({ ...base, phase: 'upToDate' })).toMatchObject({ kicker: 'Up to date', tone: 'green', action: 'check' });
  });
  test('available names the version and offers the install', () => {
    const c = updateCard({ ...base, phase: 'available', available: { version: '2.5.0', date: '2026-10-20 10:00:00 +0000' } });
    expect(c.title).toBe('Atlas 2.5.0');
    expect(c.body.startsWith('Released 2026-10-20.')).toBe(true);
    expect(c).toMatchObject({ tone: 'blue', action: 'install' });
  });
  test('downloading carries the percentage only with a known size', () => {
    expect(updateCard({ ...base, phase: 'downloading', available: { version: '2.5.0', date: null }, downloaded: 50, total: 200 })).toMatchObject({ tone: 'ink', pct: 25, action: null });
    expect(updateCard({ ...base, phase: 'downloading', available: { version: '2.5.0', date: null }, downloaded: 50, total: null }).pct).toBeNull();
    expect(pctOf(300, 200)).toBe(100);
  });
  test('errors show the real message and offer a retry', () => {
    expect(updateCard({ ...base, phase: 'error', error: 'feed unreachable' })).toMatchObject({ tone: 'red', body: 'feed unreachable', action: 'check', actionLabel: 'Try again' });
  });
  test('installed offers Restart Atlas (the app_restart command), and restarting says so', () => {
    expect(updateCard({ ...base, phase: 'installed' })).toMatchObject({ tone: 'ink', title: 'Restart Atlas to finish', action: 'restart', actionLabel: 'Restart Atlas' });
    expect(updateCard({ ...base, phase: 'installed', restarting: true })).toMatchObject({ title: 'Restarting…', action: null });
  });
  test('a background download waits for an install, now or overnight', () => {
    const avail = { ...base, available: { version: '2.5.0', date: null } };
    expect(updateCard({ ...avail, phase: 'downloaded' })).toMatchObject({ kicker: 'Downloaded', title: 'Atlas 2.5.0', action: 'install', actionLabel: 'Install now' });
    expect(updateCard({ ...avail, phase: 'downloaded' }).body).toContain('Nothing is installed until you say so');
    expect(updateCard({ ...avail, phase: 'downloaded', installOvernight: true }).body).toContain('between 2 and 5 AM');
    expect(updateCard({ ...avail, phase: 'installing' })).toMatchObject({ kicker: 'Installing', action: null });
  });
  test('the copy only promises an approval-only install while Install overnight is off', () => {
    expect(updateCard({ ...base, phase: 'idle' }).body).toContain('only ever happens when you approve it');
    expect(updateCard({ ...base, phase: 'idle', installOvernight: true }).body).toContain('plugged in and idle');
    const avail = { ...base, phase: 'available' as const, available: { version: '2.5.0', date: null } };
    expect(updateCard(avail).body).toContain('Nothing happens until you say so here.');
    expect(updateCard({ ...avail, installOvernight: true }).body).toContain('installs overnight');
  });
});
