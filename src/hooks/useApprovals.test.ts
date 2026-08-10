/**
 * The approvals UI used to record a human "yes" and perform nothing.
 *
 * `approveRequest`/`rejectRequest` UPDATE-ed `approvals.status` and
 * `tool_calls.status` directly through `localClient`. The executable payload
 * for a queued call lives in an in-memory PENDING map on the Rust side and is
 * only reachable through the `approval_resolve` command, so the row flipped to
 * `approved`, the card disappeared, the badge cleared — and the mail thread was
 * never archived. The direct write also poisoned the real path: once the row is
 * no longer `pending`, `approval_resolve` returns Err ("was already approved")
 * forever after.
 *
 * These tests pin the wire and the verdict rendering, which is all of the fix
 * that can be proved without a packaged app: the command NAME, its camelCased
 * Tauri argument names, and the fact that every terminal state — including
 * approved-and-failed and expired — reaches the user as words rather than as a
 * silently vanished card.
 */
import { describe, expect, test } from 'bun:test';
import {
  APPROVAL_RESOLVE_COMMAND,
  PARTIAL_MARKER,
  classifyResolveFailure,
  describeOutcome,
  resolveApproval,
  summarizeResult,
  type InvokeFn,
} from '@/hooks/useApprovals';

const ID = 'ap_1';

/** Records what the webview put on the wire, then answers with `reply`. */
function spy(reply: unknown | (() => never)): { calls: Array<[string, Record<string, unknown>]>; invoke: InvokeFn } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const invoke: InvokeFn = async (cmd, args) => {
    calls.push([cmd, args]);
    if (typeof reply === 'function') return (reply as () => never)();
    return reply;
  };
  return { calls, invoke };
}

describe('the wire', () => {
  test('approving invokes approval_resolve, not a row update', async () => {
    const s = spy({ status: 'completed', op: 'mail.archive', result: { archived: 1 } });
    await resolveApproval(s.invoke, ID, true);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0][0]).toBe('approval_resolve');
    expect(APPROVAL_RESOLVE_COMMAND).toBe('approval_resolve');
  });

  test('the argument names are the camelCased ones Tauri v2 expects', async () => {
    // snake_case here would make the command reject the call at deserialization,
    // which looks exactly like the old bug: nothing runs.
    const s = spy({ status: 'rejected', op: 'mail.archive' });
    await resolveApproval(s.invoke, ID, false);
    expect(s.calls[0][1]).toEqual({ approvalId: ID, approved: false });
    expect(Object.keys(s.calls[0][1])).not.toContain('approval_id');
  });

  test('approved is the boolean the caller asked for', async () => {
    const s = spy({ status: 'completed', op: 'x', result: null });
    await resolveApproval(s.invoke, ID, true);
    expect(s.calls[0][1].approved).toBe(true);
  });
});

describe('the envelope becomes a verdict', () => {
  test('completed → ran, carrying what it did', async () => {
    const o = await resolveApproval(spy({ status: 'completed', op: 'mail.archive', result: { archived: 3 } }).invoke, ID, true);
    expect(o).toEqual({ kind: 'ran', approvalId: ID, op: 'mail.archive', result: { archived: 3 } });
    expect(describeOutcome(o)).toEqual({ tone: 'good', title: 'Approved — mail.archive ran.', detail: '{"archived":3}' });
  });

  test('failed → visible as failed, never as silence', async () => {
    // The regression this is here for: an approved action that throws must NOT
    // disappear with the pending card. `executed: true`, `status: "failed"`.
    const o = await resolveApproval(
      spy({ status: 'failed', op: 'mail.archive', executed: true, error: 'IMAP refused: NO [OVERQUOTA]' }).invoke, ID, true);
    expect(o.kind).toBe('failed');
    const d = describeOutcome(o);
    expect(d.tone).toBe('bad');
    expect(d.title).toBe('Approved, but mail.archive did not complete.');
    expect(d.detail).toBe('IMAP refused: NO [OVERQUOTA]');
  });

  test('rejected → says the op did not run', async () => {
    const o = await resolveApproval(spy({ status: 'rejected', op: 'mail.archive', executed: false }).invoke, ID, false);
    expect(describeOutcome(o)).toEqual({ tone: 'muted', title: 'Rejected — mail.archive was not run.', detail: null });
  });

  test('an unreadable envelope is not reported as success', async () => {
    const o = await resolveApproval(spy({ status: 'weird' }).invoke, ID, true);
    expect(o.kind).toBe('error');
    expect(describeOutcome(o).tone).toBe('bad');
  });
});

describe('Err means the approval could not be resolved — and nothing ran', () => {
  const boom = (message: string) => spy((() => { throw new Error(message); }) as () => never).invoke;

  test('expired is named, not generalised to "something went wrong"', async () => {
    // A user told "something went wrong" about a mail action cannot tell whether
    // their mailbox changed. This wording says it did not.
    const o = await resolveApproval(
      boom(`approval ${ID} can no longer be acted on — it expired or the app restarted since it was requested. Nothing was run; ask again.`),
      ID, true);
    expect(o.kind).toBe('expired');
    const d = describeOutcome(o);
    expect(d.title).toBe('This expired before it was approved.');
    expect(d.detail).toContain('Nothing ran');
  });

  test('already resolved is its own answer', async () => {
    const o = await resolveApproval(boom(`approval ${ID} was already approved`), ID, true);
    expect(o.kind).toBe('already');
    expect(describeOutcome(o).detail).toBe('Nothing new ran just now.');
  });

  test('unknown id is its own answer', async () => {
    const o = await resolveApproval(boom(`no such approval: ${ID}`), ID, true);
    expect(o.kind).toBe('unknown');
    expect(describeOutcome(o).detail).toContain('Nothing ran');
  });

  test('anything else keeps the raw text rather than inventing a cause', async () => {
    const o = await resolveApproval(boom('refusing to run mail.archive: audit write failed: disk full'), ID, true);
    expect(o.kind).toBe('error');
    expect(describeOutcome(o).detail).toContain('disk full');
  });

  test('classification keys on ALL FIVE phrases mod.rs actually emits', () => {
    // Copied from mod.rs, not paraphrased. The previous version of this test
    // asserted three of the five while claiming in its own name to cover what
    // Rust emits, so the two "had already been answered elsewhere" messages the
    // compare-and-set work introduced fell through to the generic branch and the
    // user was told "This could not be resolved." about the one case the
    // `already` outcome exists for.
    expect(classifyResolveFailure('approval x can no longer be acted on — it expired')).toBe('expired');
    expect(classifyResolveFailure('approval x was already rejected')).toBe('already');
    expect(classifyResolveFailure('approval x was already approved')).toBe('already');
    // mod.rs, reject path and approve path, on a lost compare-and-set.
    expect(
      classifyResolveFailure('approval x had already been answered elsewhere; nothing was run'),
    ).toBe('already');
    // mod.rs `unclaimable`, on a lost expiry claim.
    expect(classifyResolveFailure('approval x had already been answered elsewhere')).toBe('already');
    expect(classifyResolveFailure('no such approval: x')).toBe('unknown');
    expect(classifyResolveFailure('connection closed')).toBe('error');
  });

  test('a lost claim reads as already answered, not as an unexplained failure', async () => {
    const o = await resolveApproval(
      boom(`approval ${ID} had already been answered elsewhere; nothing was run`),
      ID, true);
    expect(o.kind).toBe('already');
    const d = describeOutcome(o);
    expect(d.title).toBe('This was already answered somewhere else.');
    expect(d.detail).toBe('Nothing new ran just now.');
  });
});

describe('a mail change that half-happened', () => {
  // ops_mail.rs calls the Atlas Mail server FIRST and updates Atlas' own copy
  // second, so a failure of the local write comes back after the user's real
  // mailbox has already changed. Reporting that as "did not complete" — which is
  // what every other `failed` means — tells the user their mail is untouched while
  // the thread is in fact filed, and the stale local mirror agrees with the lie
  // until the next sync.
  test('a partial mail failure is not reported as nothing happened', async () => {
    const error =
      `database is locked — ${PARTIAL_MARKER}: mail.archive tells the Atlas Mail server first ` +
      `and updates Atlas' own copy second, and this failure could be from either step.`;
    const o = await resolveApproval(
      spy({ status: 'failed', op: 'mail.archive', executed: true, error }).invoke, ID, true);
    expect(o.kind).toBe('partial');
    const d = describeOutcome(o);
    expect(d.title).toBe('Approved — mail.archive may have taken effect. Check Mail.');
    expect(d.title).not.toContain('did not complete');
    expect(d.detail).toContain('database is locked');
  });

  test('the marker is the literal ops_mail.rs emits', () => {
    // Mirror of `the_partial_marker_is_the_literal_the_webview_matches` in
    // src-tauri/src/control/ops_mail.rs. Change one, change both.
    expect(PARTIAL_MARKER).toBe('your mailbox may already have changed');
  });

  test('an ordinary failure is still an ordinary failure', async () => {
    const o = await resolveApproval(
      spy({ status: 'failed', op: 'mail.archive', executed: true, error: 'IMAP refused: NO' }).invoke,
      ID, true);
    expect(o.kind).toBe('failed');
    expect(describeOutcome(o).title).toBe('Approved, but mail.archive did not complete.');
  });
});

describe('summarizeResult', () => {
  test('nothing worth showing stays null', () => {
    expect(summarizeResult(null)).toBeNull();
    expect(summarizeResult({})).toBeNull();
    expect(summarizeResult('   ')).toBeNull();
  });

  test('long output is truncated rather than flooding the panel', () => {
    const s = summarizeResult({ blob: 'x'.repeat(1000) }, 50);
    expect(s!.length).toBeLessThanOrEqual(51);
    expect(s!.endsWith('…')).toBe(true);
  });
});
