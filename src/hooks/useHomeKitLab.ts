/**
 * The HomeKit lab's wire — `/homekit-lab`, admin edition, Lighthouse builds.
 *
 * ── WHAT THIS TALKS TO ──────────────────────────────────────────────────────
 *
 * Two Rust commands, both compiled only under the `homekit` Cargo feature:
 * `home_homekit_discover` (browse `_hap._tcp` and say, per accessory, whether
 * it can be paired) and `home_homekit_pair` (SRP pair-setup with an 8-digit
 * code, then an inline sync). Plus `home_snapshot`, which is the ordinary
 * consumer command and needs no feature — it is how the lab shows what Atlas
 * ended up storing about a paired accessory.
 *
 * ── WHY SO LITTLE IS INTERPRETED HERE ───────────────────────────────────────
 *
 * The Rust side already writes the sentences. `PairingStatus::explain()` is one
 * paragraph per state, and `PairError`'s Display arm is one sentence per
 * protocol failure ("the accessory rejected that setup code", "the accessory
 * has locked itself after too many wrong codes"). This module passes both
 * through VERBATIM rather than re-wording them, because a lab whose error text
 * is a paraphrase of the error text is a lab that can be confidently wrong
 * about a protocol nobody here has ever run against a live accessory.
 *
 * `classifyFailure` is therefore deliberately small. It recognises exactly the
 * three failures that are NOT the accessory's fault and cannot be diagnosed
 * from the wire — no desktop, no user, no feature — and calls everything else
 * `reported`, which means "show Rust's words". Matching on Rust's prose to
 * split "network" from "protocol" would be a second copy of a taxonomy that
 * already exists in Rust, drifting silently the first time a sentence is
 * reworded.
 *
 * ── THE SETUP CODE ──────────────────────────────────────────────────────────
 *
 * `isValidSetupCode` mirrors `hap/pairing.rs::valid_setup_code` byte for byte,
 * INCLUDING the dashes, because the dashes are part of the SRP password: the
 * ten-character string `123-45-678` is `P`, and `12345678` is a different
 * password that no accessory will accept. Validating here does not replace the
 * Rust check (which is the one that matters); it exists so a typo produces an
 * inline "that is 7 digits" instead of a round trip and an accessory's
 * rate-limit counter ticking up.
 *
 * The code is never stored, never logged and never put in an error string. It
 * lives in component state for the length of one attempt.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import {
  HOME_COMMANDS, decodeSnapshot, NO_BRIDGE_SNAPSHOT, type LiveSnapshot,
} from '@/hooks/useSmartHome';

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * Tauri v2 camelCases Rust parameter names on the wire, so `setup_code` is sent
 * as `setupCode`. snake_case here fails deserialization, which on the receiving
 * end looks exactly like a command that quietly did nothing.
 */
export const HOMEKIT_COMMANDS = {
  discover: 'home_homekit_discover',
  pair: 'home_homekit_pair',
  snapshot: HOME_COMMANDS.snapshot,
} as const;

export type InvokeFn = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// What discovery answers with
// ---------------------------------------------------------------------------

/** The five answers `hap::discovery::PairingStatus` can give. */
export type PairingStatus =
  | 'available' | 'paired-to-atlas' | 'paired-elsewhere' | 'stale-pairing' | 'unknown';

const STATUSES: readonly PairingStatus[] = [
  'available', 'paired-to-atlas', 'paired-elsewhere', 'stale-pairing', 'unknown',
];

/** One `_hap._tcp` service, as `home_homekit_discover` describes it. */
export interface Accessory {
  /** The `id` TXT key — `XX:XX:XX:XX:XX:XX`. Pairings are keyed on this. */
  id: string;
  /** Already resolved by Rust: instance label, else model, else id. Never blank. */
  name: string;
  model: string | null;
  host: string;
  port: number;
  /** The `ci` number, unnamed on purpose — see the note in discovery.rs. */
  category: number | null;
  status: PairingStatus;
  /** `PairingStatus::explain()`, verbatim. The paragraph the user reads. */
  detail: string;
  /** `PairingStatus::can_attempt_pairing()`. NOT re-derived from `status`. */
  pairable: boolean;
  /** The accessory raised its own problem flag (`sf` bit 1). */
  problem: boolean;
}

export interface Discovery {
  found: Accessory[];
  /** How long Rust listened. The empty state quotes it. */
  windowMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the wire is serde_json::Value; every field is checked below
type Raw = Record<string, any>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * One row, tolerantly.
 *
 * `id` is the only field whose absence drops the row: it is the identity every
 * later call is keyed on, and a row that cannot be paired or unlinked is a row
 * that does nothing but take up space. An unrecognised `status` becomes
 * `unknown` rather than being trusted — `unknown` is the honest answer for a
 * word this build does not know, and it is not `available`.
 */
export function decodeAccessory(raw: unknown): Accessory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  const id = str(r.id).trim();
  if (!id) return null;
  const status = STATUSES.includes(r.status as PairingStatus)
    ? (r.status as PairingStatus)
    : 'unknown';
  return {
    id,
    name: str(r.name).trim() || id,
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : null,
    host: str(r.host),
    port: typeof r.port === 'number' && Number.isFinite(r.port) ? r.port : 0,
    category: numOrNull(r.category),
    status,
    detail: str(r.detail),
    // Rust's answer, not a re-derivation: `pairable` and `status` are decided
    // together over there, and computing it again here is how two screens end
    // up disagreeing about whether a button should exist.
    pairable: r.pairable === true,
    problem: r.problem === true,
  };
}

export function decodeDiscovery(raw: unknown): Discovery {
  if (!raw || typeof raw !== 'object') return { found: [], windowMs: 0 };
  const r = raw as Raw;
  const found = Array.isArray(r.found)
    ? r.found.map(decodeAccessory).filter((a): a is Accessory => a !== null)
    : [];
  return { found, windowMs: numOrNull(r.windowMs) ?? 0 };
}

/** The chip on the row. `detail` is the paragraph; this is the word. */
export const STATUS_LABEL: Readonly<Record<PairingStatus, string>> = {
  'available': 'Unpaired',
  'paired-to-atlas': 'Paired with Atlas',
  'paired-elsewhere': 'Paired elsewhere',
  'stale-pairing': 'Stale pairing',
  'unknown': 'Unknown',
};

export type StatusTone = 'ok' | 'warn' | 'blocked' | 'neutral';

/**
 * `blocked` is reserved for the one state where Atlas cannot proceed no matter
 * what the developer types, and it is what suppresses the code field. A stale
 * pairing is `warn`, not `blocked`: the accessory is free, Atlas' own record is
 * the stale half, and pairing again is exactly the fix.
 */
export const statusTone = (s: PairingStatus): StatusTone => {
  switch (s) {
    case 'paired-to-atlas': return 'ok';
    case 'paired-elsewhere': return 'blocked';
    case 'stale-pairing': return 'warn';
    case 'available': return 'neutral';
    case 'unknown': return 'warn';
  }
};

// ---------------------------------------------------------------------------
// Scan state — "found nothing" and "never looked" are different screens
// ---------------------------------------------------------------------------

/**
 * THE DISTINCTION THIS TYPE EXISTS FOR: `idle` and `empty` both draw zero rows,
 * and they mean opposite things. `idle` is "Atlas has not asked the network
 * anything yet". `empty` is "Atlas asked, waited, and nothing on this LAN
 * answered" — which on THIS machine almost always means the HomeKit Accessory
 * Simulator is not installed, and that is a sentence only the `empty` screen
 * can say.
 */
export type ScanState = 'idle' | 'scanning' | 'failed' | 'empty' | 'found';

export function scanStateOf(
  input: { scanning: boolean; ran: boolean; failed: boolean; count: number },
): ScanState {
  if (input.scanning) return 'scanning';
  if (input.failed) return 'failed';
  if (!input.ran) return 'idle';
  return input.count > 0 ? 'found' : 'empty';
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * `reported` means "Rust said something and we are showing it". The other three
 * are conditions this module can establish on its own; everything the protocol
 * or the network produces is Rust's to word.
 */
export type FailureKind = 'not-desktop' | 'signed-out' | 'not-compiled' | 'reported';

export interface Failure {
  kind: FailureKind;
  /** What Rust (or this module) actually said. Shown verbatim, always. */
  message: string;
  /** What to do about it, when there is a specific answer. */
  hint: string | null;
}

export const DESKTOP_ONLY =
  'The HomeKit lab talks to the local network through Rust, so it only runs in the desktop app — not the browser dev server.';
export const SIGN_IN_REQUIRED =
  'Sign in first. A pairing is stored against a user, so Atlas needs to know whose home this is.';
export const NOT_COMPILED_HINT =
  'This build was compiled without the `homekit` Cargo feature, so the command is not registered at all. Only the Lighthouse build enables it: `bun run tauri:lighthouse`. Atlas.app ships with `default = []` on purpose.';

/**
 * Tauri rejects an unregistered command with its own message, not Rust's — the
 * handler never runs, so nothing in `home/` can have worded this. That is the
 * one wire-level string worth matching, and it is worth matching because the
 * alternative reading ("discovery is broken") is wrong in a way that costs an
 * afternoon.
 */
const NOT_COMPILED = /command\s+\S*homekit\S*\s+not\s+(found|allowed)/i;

/**
 * Rust rejects with a plain string, not an `Error`. The fallback is worded as
 * an admission rather than a diagnosis: something that is neither is a bug in
 * the caller, and claiming to know what it was would be an invention.
 */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'The command failed and said nothing Atlas could read.';
}

export function classifyFailure(e: unknown): Failure {
  const message = messageOf(e);
  if (NOT_COMPILED.test(message)) {
    return { kind: 'not-compiled', message, hint: NOT_COMPILED_HINT };
  }
  return { kind: 'reported', message, hint: null };
}

// ---------------------------------------------------------------------------
// The setup code
// ---------------------------------------------------------------------------

/**
 * Mirrors `hap/pairing.rs::valid_setup_code`: exactly ten ASCII characters,
 * dashes at index 3 and 6, digits everywhere else. The dashes are part of the
 * SRP password — see the module header.
 */
export function isValidSetupCode(code: string): boolean {
  if (code.length !== 10) return false;
  for (let i = 0; i < 10; i++) {
    const c = code[i];
    if (i === 3 || i === 6) {
      if (c !== '-') return false;
    } else if (c < '0' || c > '9') {
      return false;
    }
  }
  return true;
}

/**
 * Whatever was typed → `XXX-XX-XXX`, as far as it goes.
 *
 * Non-digits are dropped and the dashes are re-inserted, so pasting
 * `12345678`, `123-45-678` or `1234 5678` all reach the same ten characters —
 * the field cannot be the reason a correct code is refused. It is a formatter,
 * not a validator: eight digits is only what a COMPLETE code looks like, so
 * a partial entry stays partial and `isValidSetupCode` still says no.
 */
export function formatSetupCode(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 3) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

export type PairIntent =
  | { ok: true; args: { accessoryId: string; host: string; port: number; setupCode: string } }
  | { ok: false; reason: string };

/**
 * Everything that can be decided before a byte leaves the machine.
 *
 * The `pairable === false` arm is the important one and it is not a duplicate
 * of hiding the button: the screen does not render a code field for an
 * accessory paired elsewhere, so reaching here means something else called
 * this — and answering with the accessory's own `detail` is better than
 * sending a request whose only possible outcome is the accessory's refusal and
 * one more tick on its rate limiter.
 */
export function pairIntent(a: Accessory, code: string): PairIntent {
  if (!a.pairable) {
    return { ok: false, reason: a.detail || 'This accessory cannot be paired from here.' };
  }
  if (!a.host || !a.port) {
    return {
      ok: false,
      reason: 'Discovery gave no address for this accessory, so there is nothing to connect to. Scan again.',
    };
  }
  if (!isValidSetupCode(code)) {
    return {
      ok: false,
      reason: 'A HomeKit setup code is eight digits, written 123-45-678. The dashes are part of it.',
    };
  }
  return { ok: true, args: { accessoryId: a.id, host: a.host, port: a.port, setupCode: code } };
}

/**
 * What the lab prints about the call it made. The setup code is REPLACED, not
 * truncated: a dev tool that echoes a credential into a transcript is a dev
 * tool that leaks one.
 */
export function describeCall(cmd: string, args: Record<string, unknown>): string {
  const shown = Object.entries(args)
    .map(([k, v]) => `${k}: ${k === 'setupCode' ? '•••-••-•••' : JSON.stringify(v)}`)
    .join(', ');
  return `${cmd}({ ${shown} })`;
}

// ---------------------------------------------------------------------------
// The result of one pairing attempt
// ---------------------------------------------------------------------------

export interface PairOutcome {
  accessoryId: string;
  /** The call, with the code redacted — see `describeCall`. */
  call: string;
  ok: boolean;
  /** On success: what the inline sync stored. On failure: null. */
  synced: { devices: number; scenes: number; rooms: number } | null;
  /** On failure: the words. On success: null. */
  failure: Failure | null;
}

function decodeSyncReport(raw: unknown): { devices: number; scenes: number; rooms: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  const sync = (r.sync ?? {}) as Raw;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { devices: n(sync.devices), scenes: n(sync.scenes), rooms: n(sync.rooms) };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface HomeKitLabDeps {
  invoke?: InvokeFn;
  /** Overridden in tests; production reads the Tauri global. */
  desktop?: boolean;
  userId?: string | null;
}

export interface UseHomeKitLab {
  /** Non-null when the page cannot work at all — no desktop, no user. */
  blocked: Failure | null;
  scanState: ScanState;
  found: Accessory[];
  windowMs: number;
  /** The last scan's failure, when `scanState === 'failed'`. */
  scanFailure: Failure | null;
  scan(): Promise<void>;
  pairing: string | null;
  outcome: PairOutcome | null;
  pair(a: Accessory, code: string): Promise<void>;
  clearOutcome(): void;
  /** What Atlas stored — the mirror, read back through `home_snapshot`. */
  snapshot: LiveSnapshot;
  snapshotFailure: Failure | null;
  refreshSnapshot(): Promise<void>;
}

export function useHomeKitLab(deps?: HomeKitLabDeps): UseHomeKitLab {
  const { user } = useAuth();
  const invoke = deps?.invoke ?? (tauriInvoke as InvokeFn);
  const desktop = deps?.desktop ?? isTauri();
  const userId = deps?.userId !== undefined ? deps.userId : (user?.id ?? null);

  const [scanning, setScanning] = useState(false);
  const [ran, setRan] = useState(false);
  const [found, setFound] = useState<Accessory[]>([]);
  const [windowMs, setWindowMs] = useState(0);
  const [scanFailure, setScanFailure] = useState<Failure | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PairOutcome | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(NO_BRIDGE_SNAPSHOT);
  const [snapshotFailure, setSnapshotFailure] = useState<Failure | null>(null);

  // A scan takes seconds and the developer can navigate away mid-listen.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /**
   * Memoised for its IDENTITY, not its cost. It is a dependency of
   * `refreshSnapshot`, which an effect calls — a fresh object literal every
   * render would re-run that effect every render, and the only reason it does
   * not become a loop of `home_snapshot` calls is that the blocked path
   * returns before it sets any state. Depending on that is a trap for whoever
   * edits this next.
   */
  const blocked: Failure | null = useMemo(() => (
    !desktop
      ? { kind: 'not-desktop', message: DESKTOP_ONLY, hint: null }
      : !userId
        ? { kind: 'signed-out', message: SIGN_IN_REQUIRED, hint: null }
        : null
  ), [desktop, userId]);

  const refreshSnapshot = useCallback(async () => {
    if (blocked || !userId) return;
    try {
      const payload = await invoke(HOMEKIT_COMMANDS.snapshot, { userId });
      if (!alive.current) return;
      setSnapshot(decodeSnapshot(payload, Date.now()));
      setSnapshotFailure(null);
    } catch (e) {
      if (!alive.current) return;
      setSnapshotFailure(classifyFailure(e));
    }
  }, [blocked, invoke, userId]);

  useEffect(() => { void refreshSnapshot(); }, [refreshSnapshot]);

  const scan = useCallback(async () => {
    if (blocked) return;
    setScanning(true);
    setScanFailure(null);
    try {
      const payload = await invoke(HOMEKIT_COMMANDS.discover);
      if (!alive.current) return;
      const d = decodeDiscovery(payload);
      setFound(d.found);
      setWindowMs(d.windowMs);
    } catch (e) {
      if (!alive.current) return;
      setScanFailure(classifyFailure(e));
      setFound([]);
    } finally {
      if (alive.current) {
        setScanning(false);
        // Set LAST, and set even on failure: `ran` is "Atlas has asked", which
        // is what separates the empty screen from the day-one screen.
        setRan(true);
      }
    }
  }, [blocked, invoke]);

  const pair = useCallback(async (a: Accessory, code: string) => {
    if (blocked || !userId) return;
    const intent = pairIntent(a, code);
    if (intent.ok === false) {
      setOutcome({
        accessoryId: a.id,
        call: 'nothing was sent',
        ok: false,
        synced: null,
        failure: { kind: 'reported', message: intent.reason, hint: null },
      });
      return;
    }
    const args = { userId, ...intent.args };
    const call = describeCall(HOMEKIT_COMMANDS.pair, args);
    setPairing(a.id);
    setOutcome(null);
    try {
      const payload = await invoke(HOMEKIT_COMMANDS.pair, args);
      if (!alive.current) return;
      setOutcome({ accessoryId: a.id, call, ok: true, synced: decodeSyncReport(payload), failure: null });
      // Both change: the accessory now reports itself paired, and the mirror
      // now holds whatever the inline sync pulled.
      await refreshSnapshot();
      await scan();
    } catch (e) {
      if (!alive.current) return;
      setOutcome({ accessoryId: a.id, call, ok: false, synced: null, failure: classifyFailure(e) });
    } finally {
      if (alive.current) setPairing(null);
    }
  }, [blocked, invoke, refreshSnapshot, scan, userId]);

  return {
    blocked,
    scanState: scanStateOf({ scanning, ran, failed: scanFailure !== null, count: found.length }),
    found,
    windowMs,
    scanFailure,
    scan,
    pairing,
    outcome,
    pair,
    clearOutcome: useCallback(() => setOutcome(null), []),
    snapshot,
    snapshotFailure,
    refreshSnapshot,
  };
}

export default useHomeKitLab;
