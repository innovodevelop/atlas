/**
 * The HomeKit lab's decisions, pinned.
 *
 * Same shape as `useSmartHome.test.ts`: the hook itself needs a renderer, so
 * everything that can be wrong WITHOUT being obvious is a pure function and
 * those are what this file exercises. The four properties below are the ones
 * the screen's honesty rests on —
 *
 *   · "found nothing" and "never looked" are different states
 *   · an accessory paired elsewhere is never offered a code field
 *   · the setup code's DASHES are part of the password
 *   · a failure shows what failed, and never shows the code
 *
 * — so each of them is asserted directly rather than being implied by a
 * rendering test that would pass with the logic deleted.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyFailure, decodeAccessory, decodeDiscovery, describeCall, formatSetupCode,
  isValidSetupCode, messageOf, pairIntent, scanStateOf, statusTone, STATUS_LABEL,
  NOT_COMPILED_HINT, type Accessory,
} from '@/hooks/useHomeKitLab';

const acc = (over: Partial<Accessory> = {}): Accessory => ({
  id: '4A:2B:9C:11:00:FE',
  name: 'Simulated Lamp',
  model: 'HAS-Lamp',
  host: 'Lamp-1.local',
  port: 51826,
  category: 5,
  status: 'available',
  detail: 'Ready to pair. Enter the 8-digit setup code printed on the accessory.',
  pairable: true,
  problem: false,
  ...over,
});

// ── decoding ────────────────────────────────────────────────────────────────

describe('discovery decodes tolerantly, and fails towards "unknown"', () => {
  test('a full row survives intact', () => {
    const d = decodeDiscovery({
      windowMs: 2500,
      found: [{
        id: 'AA:BB:CC:DD:EE:FF', name: 'Lamp', model: 'HAS-Lamp', host: 'lamp.local',
        port: 51826, category: 5, status: 'paired-elsewhere', detail: 'Already paired…',
        pairable: false, problem: true,
      }],
    });
    expect(d.windowMs).toBe(2500);
    expect(d.found).toHaveLength(1);
    expect(d.found[0].status).toBe('paired-elsewhere');
    expect(d.found[0].pairable).toBe(false);
    expect(d.found[0].problem).toBe(true);
  });

  test('a row with no id is dropped — there is nothing to pair or unlink', () => {
    expect(decodeDiscovery({ found: [{ name: 'Nameless', host: 'x.local' }] }).found).toEqual([]);
    expect(decodeAccessory({ id: '   ' })).toBeNull();
  });

  test('a status word this build does not know becomes "unknown", never "available"', () => {
    // The failure this prevents: a future Rust variant decoding to the one
    // state that says "go ahead and type your code".
    const a = decodeAccessory({ id: 'X', status: 'paired-to-the-neighbours' })!;
    expect(a.status).toBe('unknown');
  });

  test('`pairable` comes from Rust and is not re-derived from `status`', () => {
    // Rust decides both together. A row that claims "available" but was not
    // marked pairable must not grow a code field here.
    const a = decodeAccessory({ id: 'X', status: 'available' })!;
    expect(a.pairable).toBe(false);
  });

  test('a nameless accessory falls back to its id rather than a blank row', () => {
    expect(decodeAccessory({ id: 'AA:BB' })!.name).toBe('AA:BB');
  });

  test('a non-object payload is an empty browse, not a crash', () => {
    expect(decodeDiscovery(null)).toEqual({ found: [], windowMs: 0 });
    expect(decodeDiscovery({ found: 'lots' })).toEqual({ found: [], windowMs: 0 });
  });
});

// ── the state machine ───────────────────────────────────────────────────────

describe('never-looked and found-nothing are different states', () => {
  test('zero accessories reads as `idle` before a scan and `empty` after one', () => {
    const before = scanStateOf({ scanning: false, ran: false, failed: false, count: 0 });
    const after = scanStateOf({ scanning: false, ran: true, failed: false, count: 0 });
    expect(before).toBe('idle');
    expect(after).toBe('empty');
    // The whole point: same count, different screen.
    expect(before).not.toBe(after);
  });

  test('a failed scan is neither of those', () => {
    expect(scanStateOf({ scanning: false, ran: true, failed: true, count: 0 })).toBe('failed');
    // …and failure outranks a stale list, so an error is never drawn under rows
    // that describe an older, successful browse.
    expect(scanStateOf({ scanning: false, ran: true, failed: true, count: 3 })).toBe('failed');
  });

  test('scanning outranks everything', () => {
    expect(scanStateOf({ scanning: true, ran: true, failed: true, count: 3 })).toBe('scanning');
  });

  test('accessories found', () => {
    expect(scanStateOf({ scanning: false, ran: true, failed: false, count: 2 })).toBe('found');
  });
});

// ── the pairing gate ────────────────────────────────────────────────────────

describe('an accessory paired elsewhere is never asked for a code', () => {
  test('the intent is refused with the accessory\'s own explanation', () => {
    const elsewhere = acc({
      status: 'paired-elsewhere',
      pairable: false,
      detail: 'Already paired with another home — most likely Apple Home.',
    });
    const intent = pairIntent(elsewhere, '123-45-678');
    expect(intent.ok).toBe(false);
    // Rust's sentence, not a paraphrase invented here.
    expect(intent.ok === false && intent.reason).toBe(elsewhere.detail);
  });

  test('…and its tone is the one that suppresses the field', () => {
    expect(statusTone('paired-elsewhere')).toBe('blocked');
    // Every other state must NOT be blocked, or the screen quietly stops
    // offering codes to accessories that would accept one.
    for (const s of ['available', 'stale-pairing', 'unknown', 'paired-to-atlas'] as const) {
      expect(statusTone(s)).not.toBe('blocked');
    }
  });

  test('a stale pairing is still pairable — that is the fix, not the block', () => {
    const stale = acc({ status: 'stale-pairing', pairable: true });
    expect(pairIntent(stale, '123-45-678').ok).toBe(true);
    expect(statusTone('stale-pairing')).toBe('warn');
  });

  test('an accessory with no address is refused before any socket opens', () => {
    expect(pairIntent(acc({ host: '' }), '123-45-678').ok).toBe(false);
    expect(pairIntent(acc({ port: 0 }), '123-45-678').ok).toBe(false);
  });

  test('every status has a label', () => {
    for (const s of ['available', 'paired-to-atlas', 'paired-elsewhere', 'stale-pairing', 'unknown'] as const) {
      expect(STATUS_LABEL[s].length).toBeGreaterThan(0);
    }
  });
});

// ── the setup code ──────────────────────────────────────────────────────────

describe('the setup code keeps its dashes', () => {
  /** Mirrors hap/pairing.rs::the_setup_code_keeps_its_dashes_and_is_exactly_ten_bytes. */
  test('valid only as XXX-XX-XXX', () => {
    expect(isValidSetupCode('123-45-678')).toBe(true);
    expect(isValidSetupCode('000-00-000')).toBe(true);
    // The dashes are part of the SRP password, so the bare digits are a
    // DIFFERENT password — not a lenient spelling of the same one.
    expect(isValidSetupCode('12345678')).toBe(false);
    expect(isValidSetupCode('123-456-78')).toBe(false);
    expect(isValidSetupCode('12-345-678')).toBe(false);
    expect(isValidSetupCode('123-45-67')).toBe(false);
    expect(isValidSetupCode('123-45-6789')).toBe(false);
    expect(isValidSetupCode('abc-de-fgh')).toBe(false);
    expect(isValidSetupCode('')).toBe(false);
    expect(isValidSetupCode('12a-45-678')).toBe(false);
  });

  test('the field formats towards the only spelling Rust accepts', () => {
    expect(formatSetupCode('12345678')).toBe('123-45-678');
    expect(formatSetupCode('123-45-678')).toBe('123-45-678');
    expect(formatSetupCode('1234 5678')).toBe('123-45-678');
    // Partial entry stays partial — formatting is not validating.
    expect(formatSetupCode('1')).toBe('1');
    expect(formatSetupCode('1234')).toBe('123-4');
    expect(isValidSetupCode(formatSetupCode('1234'))).toBe(false);
    // …and a ninth digit cannot be typed into an 8-digit code.
    expect(formatSetupCode('123456789')).toBe('123-45-678');
  });

  test('a malformed code is refused here, before the accessory\'s rate limiter sees it', () => {
    const intent = pairIntent(acc(), '123-45-67');
    expect(intent.ok).toBe(false);
    expect(intent.ok === false && intent.reason).toContain('123-45-678');
  });

  test('a well-formed code produces the exact args the Rust command names', () => {
    const intent = pairIntent(acc(), '123-45-678');
    expect(intent.ok).toBe(true);
    // camelCase: Tauri v2 renames `setup_code` on the wire, and snake_case
    // here fails deserialization in a way that looks like a no-op command.
    expect(intent.ok === true && intent.args).toEqual({
      accessoryId: '4A:2B:9C:11:00:FE',
      host: 'Lamp-1.local',
      port: 51826,
      setupCode: '123-45-678',
    });
  });
});

// ── failure ─────────────────────────────────────────────────────────────────

describe('a failure shows what failed', () => {
  test('the accessory\'s own words survive untouched', () => {
    const raw = 'the accessory has locked itself after too many wrong codes';
    const f = classifyFailure(raw);
    expect(f.kind).toBe('reported');
    expect(f.message).toBe(raw);
    expect(f.hint).toBeNull();
  });

  test('an unregistered command is diagnosed, because Rust never got to speak', () => {
    const f = classifyFailure('Command home_homekit_discover not found');
    expect(f.kind).toBe('not-compiled');
    expect(f.hint).toBe(NOT_COMPILED_HINT);
    // The raw wire message is still shown — the hint is added, not substituted.
    expect(f.message).toBe('Command home_homekit_discover not found');
  });

  test('…and a protocol error that merely mentions "not found" is NOT that', () => {
    // The regex is anchored on the command name for this reason: an accessory
    // saying a characteristic was not found must not be reported as a build
    // configuration problem.
    expect(classifyFailure('the accessory said characteristic 9 was not found').kind)
      .toBe('reported');
  });

  test('Rust rejects with a string, and a non-string is admitted rather than guessed at', () => {
    expect(messageOf('plain string')).toBe('plain string');
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf({ weird: true })).toContain('said nothing');
  });

  test('the printed call never contains the setup code', () => {
    const call = describeCall('home_homekit_pair', {
      userId: 'u1', accessoryId: 'AA:BB', host: 'lamp.local', port: 51826, setupCode: '123-45-678',
    });
    expect(call).toContain('home_homekit_pair');
    expect(call).toContain('accessoryId');
    expect(call).toContain('•••-••-•••');
    // The one assertion this test exists for.
    expect(call).not.toContain('123-45-678');
    expect(call).not.toContain('12345678');
  });
});
