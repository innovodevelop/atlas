/* eslint-disable @typescript-eslint/no-explicit-any -- the live-stack tests
   stand up minimal `window` / `document` / element doubles on globalThis. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { drop, focusables, openLayer, raise, shouldReturnFocus, topLayer, trapTab } from './shellLayers';

describe('the layer stack', () => {
  test('raise puts a layer on top, moving it if it was already open', () => {
    expect(raise([], 'talk')).toEqual(['talk']);
    expect(raise(['talk'], 'status')).toEqual(['talk', 'status']);
    expect(raise(['talk', 'status'], 'talk')).toEqual(['status', 'talk']);
  });

  test('drop removes only that layer and leaves the input alone', () => {
    const s = ['talk', 'status'];
    expect(drop(s, 'talk')).toEqual(['status']);
    expect(drop(s, 'nope')).toEqual(['talk', 'status']);
    expect(s).toEqual(['talk', 'status']);
  });
});

describe('trapTab', () => {
  test('wraps forward from the last and back from the first', () => {
    expect(trapTab(2, 3, false)).toBe(0);
    expect(trapTab(0, 3, true)).toBe(2);
  });

  test('in the middle, the browser moves focus (it stays inside anyway)', () => {
    expect(trapTab(1, 3, false)).toBeNull();
    expect(trapTab(1, 3, true)).toBeNull();
    expect(trapTab(0, 3, false)).toBeNull();
    expect(trapTab(2, 3, true)).toBeNull();
  });

  test('focus outside the layer comes back in at the matching end', () => {
    expect(trapTab(-1, 3, false)).toBe(0);
    expect(trapTab(-1, 3, true)).toBe(2);
  });

  test('a single control keeps focus on itself', () => {
    expect(trapTab(0, 1, false)).toBe(0);
    expect(trapTab(0, 1, true)).toBe(0);
  });

  test('an empty layer is left to the caller', () => {
    expect(trapTab(-1, 0, false)).toBeNull();
  });
});

describe('shouldReturnFocus', () => {
  test('only when focus went down with the layer, and only for the keyboard', () => {
    expect(shouldReturnFocus(true, 'keyboard')).toBe(true);
    expect(shouldReturnFocus(true, 'pointer')).toBe(false);
    expect(shouldReturnFocus(false, 'keyboard')).toBe(false);
    expect(shouldReturnFocus(false, 'pointer')).toBe(false);
  });
});

// ---- The live stack, against DOM doubles -------------------------------------

type Listener = (e: any) => void;
let listeners: { type: string; fn: Listener; capture: boolean }[] = [];
let active: any = null;

function el(name: string, opts: { tabIndex?: number; hidden?: boolean; inert?: boolean } = {}): any {
  const node: any = {
    name,
    tabIndex: opts.tabIndex ?? 0,
    closest: (sel: string) => (sel === '[inert]' && opts.inert ? {} : null),
    getClientRects: () => (opts.hidden ? [] : [{}]),
    focus: () => { active = node; },
  };
  return node;
}

function rootWith(items: any[]): any {
  const attrs = new Map<string, string>();
  const root: any = {
    querySelectorAll: () => items,
    hasAttribute: (k: string) => attrs.has(k),
    setAttribute: (k: string, v: string) => { attrs.set(k, v); },
    focus() { active = root; },
    attrs,
  };
  return root;
}

function key(k: string, extra: Partial<{ shiftKey: boolean; isComposing: boolean; altKey: boolean }> = {}) {
  const e: any = {
    key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, defaultPrevented: false,
    stopped: false,
    ...extra,
    preventDefault() { e.defaultPrevented = true; },
    stopImmediatePropagation() { e.stopped = true; },
  };
  for (const l of listeners.filter((x) => x.type === 'keydown')) l.fn(e);
  return e;
}

beforeEach(() => {
  listeners = [];
  active = null;
  (globalThis as any).window = {
    addEventListener: (type: string, fn: Listener, capture: boolean) => { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener: (type: string, fn: Listener) => { listeners = listeners.filter((l) => !(l.type === type && l.fn === fn)); },
  };
  (globalThis as any).document = { get activeElement() { return active; } };
});

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

describe('openLayer', () => {
  test('one capture listener while any layer is open, none after', () => {
    const closeA = openLayer({ id: 'a', root: () => null, onEscape: () => {} });
    const closeB = openLayer({ id: 'b', root: () => null, onEscape: () => {} });
    expect(listeners).toHaveLength(1);
    expect(listeners[0].capture).toBe(true);
    closeA();
    expect(listeners).toHaveLength(1);
    closeB();
    expect(listeners).toHaveLength(0);
    expect(topLayer()).toBeNull();
  });

  test('Esc closes the topmost layer only, and the page never sees it', () => {
    const closed: string[] = [];
    const removeTalk = openLayer({ id: 'talk', root: () => null, onEscape: () => closed.push('talk') });
    const removeStatus = openLayer({ id: 'status', root: () => null, onEscape: () => closed.push('status') });
    expect(topLayer()).toBe('status');
    const e = key('Escape');
    expect(closed).toEqual(['status']);
    expect(e.defaultPrevented).toBe(true);
    expect(e.stopped).toBe(true);
    removeStatus();
    key('Escape');
    expect(closed).toEqual(['status', 'talk']);
    removeTalk();
  });

  test('Esc while an IME is composing is left to the IME', () => {
    const closed: string[] = [];
    const remove = openLayer({ id: 'talk', root: () => null, onEscape: () => closed.push('talk') });
    const e = key('Escape', { isComposing: true });
    expect(closed).toEqual([]);
    expect(e.stopped).toBe(false);
    remove();
  });

  test('a stale removal does not take down a layer re-opened under the same id', () => {
    const first = openLayer({ id: 'talk', root: () => null, onEscape: () => {} });
    const second = openLayer({ id: 'talk', root: () => null, onEscape: () => {} });
    first();
    expect(topLayer()).toBe('talk');
    second();
    expect(topLayer()).toBeNull();
    expect(listeners).toHaveLength(0);
  });

  test('Tab wraps inside the topmost layer and skips what Tab cannot reach', () => {
    const a = el('a'), hidden = el('hidden', { hidden: true }), inert = el('inert', { inert: true }), minus = el('minus', { tabIndex: -1 }), b = el('b');
    const root = rootWith([a, hidden, inert, minus, b]);
    expect(focusables(root).map((x: any) => x.name)).toEqual(['a', 'b']);
    const remove = openLayer({ id: 'talk', root: () => root, onEscape: () => {} });

    active = b;
    let e = key('Tab');
    expect(active).toBe(a);
    expect(e.defaultPrevented).toBe(true);

    e = key('Tab', { shiftKey: true });
    expect(active).toBe(b);

    // Focus behind the layer (a click elsewhere): the next Tab brings it back.
    active = el('page');
    key('Tab');
    expect(active).toBe(a);

    // A move in the middle is the browser's.
    const c = el('c');
    const root3 = rootWith([a, c, b]);
    remove();
    const remove3 = openLayer({ id: 'talk', root: () => root3, onEscape: () => {} });
    active = a;
    e = key('Tab');
    expect(e.defaultPrevented).toBe(false);
    expect(active).toBe(a);
    remove3();
  });

  test('a layer with nothing focusable keeps focus on itself', () => {
    const root = rootWith([]);
    const remove = openLayer({ id: 'status', root: () => root, onEscape: () => {} });
    const e = key('Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(active).toBe(root);
    expect(root.attrs.get('tabindex')).toBe('-1');
    remove();
  });

  test('Alt/Ctrl/Meta+Tab are not held', () => {
    const a = el('a');
    const remove = openLayer({ id: 'talk', root: () => rootWith([a]), onEscape: () => {} });
    active = null;
    const e = key('Tab', { altKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(active).toBeNull();
    remove();
  });
});
