import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_DOCK_STYLE, DOCK_DESTINATIONS, DOCK_STYLES, DOCK_STYLE_KEY, DOCK_STYLE_META,
  _resetDockNotes, badgeCount, getDockNotes, badgeText, contrastRatio, createDockStyleStore, crumbLine, currentDockId,
  hubSides, itemName, mergeNotes, parseDockStyle, publishDockNote, statusMini, stepIndex, voiceNote,
  type DockStorage,
} from './betaDock';
import { surfaceByPath } from '@/surfaces';

function memoryStorage(initial: Record<string, string> = {}): DockStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

describe('dock styles', () => {
  test('the guideline dock stays the default', () => {
    expect(DEFAULT_DOCK_STYLE).toBe('guide');
    expect(parseDockStyle(null)).toBe('guide');
  });

  test('every style has picker copy, in the same order, and the six boards are all there', () => {
    expect(DOCK_STYLE_META.map((m) => m.id)).toEqual([...DOCK_STYLES]);
    expect(DOCK_STYLE_META.filter((m) => m.board !== '§09').map((m) => m.board)).toEqual(['3a', '3b', '3c', '3d', '3e', '3f']);
    for (const m of DOCK_STYLE_META) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(20);
    }
  });

  test('an unknown stored value falls back to the default, never a blank dock', () => {
    expect(parseDockStyle('lens')).toBe('lens');
    expect(parseDockStyle('3a')).toBe('guide');
    expect(parseDockStyle('')).toBe('guide');
    expect(parseDockStyle(42)).toBe('guide');
  });
});

describe('dock style store', () => {
  test('reads the stored choice at creation', () => {
    const s = createDockStyleStore(() => memoryStorage({ [DOCK_STYLE_KEY]: 'capsule' }));
    expect(s.get()).toBe('capsule');
  });

  test('set persists, applies and notifies once', () => {
    const mem = memoryStorage();
    const s = createDockStyleStore(() => mem);
    let calls = 0;
    const off = s.subscribe(() => { calls += 1; });
    s.set('rail');
    expect(s.get()).toBe('rail');
    expect(mem.data[DOCK_STYLE_KEY]).toBe('rail');
    s.set('rail');
    expect(calls).toBe(1);
    off();
    s.set('lane');
    expect(calls).toBe(1);
  });

  test('a storage that throws still applies the choice for the session', () => {
    const broken: DockStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    const s = createDockStyleStore(() => broken);
    expect(s.get()).toBe('guide');
    s.set('hub');
    expect(s.get()).toBe('hub');
  });

  test('no storage at all (tests, SSR) is the default', () => {
    const s = createDockStyleStore(() => null);
    expect(s.get()).toBe('guide');
  });

  test('reload picks up a change made by another window', () => {
    const mem = memoryStorage();
    const s = createDockStyleStore(() => mem);
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    mem.data[DOCK_STYLE_KEY] = 'status';
    s.reload();
    expect(s.get()).toBe('status');
    s.reload();
    expect(calls).toBe(1);
  });
});

describe('dock destinations', () => {
  test('the guideline order: Home · Core · Teach · Mail · Architecture · Voice', () => {
    expect(DOCK_DESTINATIONS.map((d) => d.label)).toEqual(['Home', 'Core', 'Teach', 'Mail', 'Architecture', 'Voice']);
  });

  test('every destination is a registered surface, so the edition filter can judge it', () => {
    for (const d of DOCK_DESTINATIONS) expect(surfaceByPath(d.to)).toBeDefined();
    expect(surfaceByPath('/atlas-architecture')?.edition).toBe('admin');
  });

  test('current: exact paths, and /dashboard is Home', () => {
    expect(currentDockId('/')).toBe('home');
    expect(currentDockId('/dashboard')).toBe('home');
    expect(currentDockId('/home')).toBe('voice');
    expect(currentDockId('/mail')).toBe('mail');
    expect(currentDockId('/clock')).toBeUndefined();
    expect(currentDockId('/mail/123')).toBeUndefined();
  });

  test('white text on every colour-lane blob reads at 4.5:1 or better', () => {
    for (const d of DOCK_DESTINATIONS) expect(contrastRatio(d.fill, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  test('a deepened fill keeps the design accent where white already passed', () => {
    for (const d of DOCK_DESTINATIONS) {
      if (contrastRatio(d.accent, '#ffffff') >= 4.5) expect(d.fill).toBe(d.accent);
    }
  });

  test('contrast ratio matches the WCAG reference points', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});

describe('sphere hub', () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  test('Voice becomes the hub and the rest split 3 | 2, as on the board', () => {
    const { left, hub, right } = hubSides(DOCK_DESTINATIONS);
    expect(hub?.id).toBe('voice');
    expect(ids(left)).toEqual(['home', 'core', 'teach']);
    expect(ids(right)).toEqual(['mail', 'architecture']);
  });

  test('a consumer build without Architecture splits 2 | 2', () => {
    const { left, right } = hubSides(DOCK_DESTINATIONS.filter((d) => d.id !== 'architecture'));
    expect(ids(left)).toEqual(['home', 'core']);
    expect(ids(right)).toEqual(['teach', 'mail']);
  });

  test('no Voice, no hub — every item still drawn', () => {
    const { left, hub, right } = hubSides(DOCK_DESTINATIONS.filter((d) => d.id !== 'voice'));
    expect(hub).toBeUndefined();
    expect(left.length + right.length).toBe(5);
  });
});

describe('keyboard stepping', () => {
  test('arrows move on both axes and wrap', () => {
    expect(stepIndex('ArrowRight', 0, 4)).toBe(1);
    expect(stepIndex('ArrowDown', 3, 4)).toBe(0);
    expect(stepIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(stepIndex('ArrowUp', 2, 4)).toBe(1);
  });

  test('Home and End jump; other keys are not ours', () => {
    expect(stepIndex('Home', 2, 4)).toBe(0);
    expect(stepIndex('End', 0, 4)).toBe(3);
    expect(stepIndex('Enter', 0, 4)).toBeNull();
    expect(stepIndex('j', 0, 4)).toBeNull();
  });

  test('from outside the list, arrows land on an end; an empty list goes nowhere', () => {
    expect(stepIndex('ArrowRight', -1, 4)).toBe(0);
    expect(stepIndex('ArrowLeft', -1, 4)).toBe(3);
    expect(stepIndex('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('status lines', () => {
  afterEach(() => _resetDockNotes());
  const mail = DOCK_DESTINATIONS[3];

  test('the rail crumb: a reported crumb, else the status, else nothing', () => {
    expect(crumbLine(mail, { crumb: 'Needs you (3)', line: '3 need you' })).toBe('Mail › Needs you (3)');
    expect(crumbLine(mail, { line: '3 need you' })).toBe('3 need you');
    expect(crumbLine(mail, undefined)).toBeNull();
  });

  test('the status dock shows the short name until a screen reports', () => {
    expect(statusMini(DOCK_DESTINATIONS[4], undefined)).toBe('Layers');
    expect(statusMini(mail, { mini: '3 new' })).toBe('3 new');
  });

  test('badges: positive whole numbers only, capped in the drawing', () => {
    expect(badgeCount({ count: 3 })).toBe(3);
    expect(badgeCount({ count: 0 })).toBeNull();
    expect(badgeCount({ count: -2 })).toBeNull();
    expect(badgeCount({ count: Number.NaN })).toBeNull();
    expect(badgeCount(undefined)).toBeNull();
    expect(badgeText(7)).toBe('7');
    expect(badgeText(140)).toBe('99+');
  });

  test('the accessible name carries the visible state, and the count once', () => {
    expect(itemName(mail, undefined)).toBe('Mail');
    expect(itemName(mail, { mini: '3 new', count: 3 })).toBe('Mail, 3 new');
    expect(itemName(mail, { line: 'Synced', count: 2 })).toBe('Mail, Synced, 2 need you');
    expect(itemName(mail, { count: 2 })).toBe('Mail, 2 need you');
  });

  test('Voice reads the state bus in the top bar’s words', () => {
    expect(voiceNote('idle')).toEqual({ line: 'Listening', mini: 'listening' });
    expect(voiceNote('muted')).toEqual({ line: 'Muted', mini: 'muted' });
  });

  test('a screen’s own report beats the derived line', () => {
    const merged = mergeNotes({ voice: { line: 'In a conversation' } }, { voice: voiceNote('idle'), mail: { line: 'x' } });
    expect(merged.voice?.line).toBe('In a conversation');
    expect(merged.mail?.line).toBe('x');
  });

  test('publishing is idempotent and withdrawable', () => {
    publishDockNote('mail', { line: '3 need you', count: 3 });
    const first = getDockNotes();
    expect(first.mail).toEqual({ line: '3 need you', count: 3 });
    // The same report again is not a change: same snapshot, no re-render.
    publishDockNote('mail', { line: '3 need you', count: 3 });
    expect(getDockNotes()).toBe(first);
    publishDockNote('mail', { line: '2 need you', count: 2 });
    expect(getDockNotes()).not.toBe(first);
    publishDockNote('mail', null);
    expect(getDockNotes().mail).toBeUndefined();
    const empty = getDockNotes();
    publishDockNote('mail', null);
    expect(getDockNotes()).toBe(empty);
  });
});
