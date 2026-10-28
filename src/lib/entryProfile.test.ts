import { describe, expect, test } from 'bun:test';
import { rememberName, type ProfileNameRow, type ProfileStore } from './entryProfile';

/** An in-memory profile table that records what was asked of it. */
function fakeStore(initial: ProfileNameRow | null | undefined, opts: { failWrites?: boolean; throws?: boolean } = {}) {
  const calls: string[] = [];
  let row = initial;
  const store: ProfileStore = {
    async find() {
      calls.push('find');
      if (opts.throws) throw new Error('no tauri');
      return row;
    },
    async insert(_id, first) {
      calls.push(`insert:${first}`);
      if (opts.failWrites) return false;
      row = { first_name: first, nickname: null };
      return true;
    },
    async update(_id, first) {
      calls.push(`update:${first}`);
      if (opts.failWrites) return false;
      row = { ...(row as ProfileNameRow), first_name: first };
      return true;
    },
  };
  return { store, calls, current: () => row };
}

describe('rememberName', () => {
  test('a new account gets a profile row with its name', async () => {
    const f = fakeStore(null);
    expect(await rememberName('u1', '  Mads   Peter. ', f.store)).toBe('saved');
    expect(f.calls).toEqual(['find', 'insert:Mads Peter']);
  });
  test('an existing row without a name is updated, never inserted twice', async () => {
    const f = fakeStore({ first_name: null, nickname: '' });
    expect(await rememberName('u1', 'Marcus', f.store)).toBe('saved');
    expect(f.calls).toEqual(['find', 'update:Marcus']);
  });
  test('a name the user already set wins', async () => {
    expect(await rememberName('u1', 'Marcus', fakeStore({ first_name: 'Mark', nickname: null }).store)).toBe('kept');
    const f = fakeStore({ first_name: null, nickname: 'Hale' });
    expect(await rememberName('u1', 'Marcus', f.store)).toBe('kept');
    expect(f.calls).toEqual(['find']);
  });
  test('nothing to keep, nothing written', async () => {
    const f = fakeStore(null);
    expect(await rememberName('u1', '   ', f.store)).toBe('skipped');
    expect(await rememberName('', 'Marcus', f.store)).toBe('skipped');
    expect(f.calls).toEqual([]);
  });
  test('failures are reported, never thrown', async () => {
    expect(await rememberName('u1', 'Marcus', fakeStore(undefined).store)).toBe('failed');
    expect(await rememberName('u1', 'Marcus', fakeStore(null, { failWrites: true }).store)).toBe('failed');
    expect(await rememberName('u1', 'Marcus', fakeStore(null, { throws: true }).store)).toBe('failed');
  });
});
