import { useState, useEffect, useCallback, useRef } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';

export interface Approval {
  id: string;
  run_id: string | null;
  tool_call_id: string;
  status: string;
  action_summary: string;
  reason: string | null;
  risk_level: string | null;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Resolving an approval
//
// THE DEFECT THIS REPLACES: `approveRequest`/`rejectRequest` used to UPDATE the
// `approvals` row (and its `tool_calls` row) straight through `localClient`.
// That is a row edit, not an execution. Rust holds the executable payload for a
// queued call in an in-memory PENDING map (src-tauri/src/control/mod.rs,
// `take_pending`) and only `approval_resolve` reaches it. So the old path made
// the card disappear and the badge clear while the mail thread was never
// archived — the user was shown "yes, done" for an action that had not run.
//
// Worse, it POISONED the correct path: `approval_resolve` re-reads the row and
// returns Err when `status != "pending"` (mod.rs), so any row the webview had
// already flipped could never execute afterwards, even once wired properly.
// Reject was the same shape in reverse — `take_pending` was never reached, so
// the refused payload stayed live in the queue for its whole TTL.
//
// Rust now owns every row transition. Nothing in this file writes `approvals`
// or `tool_calls` any more; it invokes the command and renders what came back.
// ---------------------------------------------------------------------------

/** The Tauri command. Its argument names are camelCased by Tauri v2 — `approvalId`, not `approval_id`. */
export const APPROVAL_RESOLVE_COMMAND = 'approval_resolve';

/** Minimal shape of the `invoke` we need; injected so the logic is testable without Tauri. */
export type InvokeFn = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * What actually happened to one approval, as the UI must state it.
 *
 * `ran` and `failed` are deliberately separate: the whole point of this tier is
 * that the user can answer "did it happen?", and an approved action that threw
 * must stay on screen as failed rather than vanish with the pending card.
 *
 * `partial` is the third answer, and it exists because "failed" was a lie in one
 * specific case. `ops_mail::archive`/`mark_read` call the Atlas Mail server FIRST
 * and update Atlas' local copy second, so a failure of the local step comes back
 * as an error AFTER the user's real mailbox has already changed — and the local
 * mirror still shows the thread unarchived, so this screen corroborated the wrong
 * conclusion until the next sync. Rust marks that case (`REMOTE_MAY_HAVE_APPLIED`
 * in ops_mail.rs) and it gets its own wording here.
 */
export type ResolveOutcome =
  | { kind: 'ran'; approvalId: string; op: string; result: unknown }
  | { kind: 'failed'; approvalId: string; op: string; error: string }
  | { kind: 'partial'; approvalId: string; op: string; error: string }
  | { kind: 'rejected'; approvalId: string; op: string }
  | { kind: 'expired'; approvalId: string; message: string }
  | { kind: 'already'; approvalId: string; message: string }
  | { kind: 'unknown'; approvalId: string; message: string }
  | { kind: 'error'; approvalId: string; message: string };

/**
 * The marker `ops_mail.rs` puts in an error whose mail change may have landed.
 *
 * Verbatim from `ops_mail::REMOTE_MAY_HAVE_APPLIED`. Pinned on both sides —
 * `the_partial_marker_is_the_literal_the_webview_matches` there, `a partial mail
 * failure is not reported as nothing happened` here — because a prose match
 * across a language boundary is exactly the contract that drifts silently, and the
 * only thing that holds it is a test at each end asserting the literal.
 */
export const PARTIAL_MARKER = 'your mailbox may already have changed';

/**
 * Why the approval could not be resolved at all.
 *
 * `approval_resolve` returns Err ONLY for that case (an op that ran and failed
 * comes back Ok with `status: "failed"`), and it says which case in prose. We
 * classify on the stable phrases mod.rs uses, because "something went wrong"
 * about a mail action leaves the user unable to tell whether their mailbox
 * changed — and in every one of these cases nothing ran at all.
 *
 * ALL FIVE OF ITS Err SHAPES ARE MATCHED HERE, and that is a correction: the
 * compare-and-set work added `"approval {id} had already been answered
 * elsewhere; nothing was run"` (the reject and approve paths that lose the claim)
 * and `"…had already been answered elsewhere"` (the lost expiry claim), and this
 * function tested only `includes('was already ')`. "had already been" does not
 * contain "was already ", so the one case the `already` outcome exists for fell to
 * the generic branch and rendered "This could not be resolved." — while the test
 * named "classification keys on the phrases mod.rs actually emits" asserted three
 * phrases and passed.
 *
 * The Rust side still has no machine-readable code for this; see the note returned
 * with this change. Matching prose is the weaker contract, so the default stays the
 * honest generic branch rather than a guess, and every phrase matched here is
 * pinned by a test carrying mod.rs's literal string.
 */
export function classifyResolveFailure(message: string): 'expired' | 'already' | 'unknown' | 'error' {
  const m = message.toLowerCase();
  // mod.rs: "…can no longer be acted on — it expired or the app restarted…"
  if (m.includes('can no longer be acted on')) return 'expired';
  // mod.rs: "approval {id} was already {status}"
  if (m.includes('was already ')) return 'already';
  // mod.rs (x3): "approval {id} had already been answered elsewhere[; nothing was run]"
  if (m.includes('already been answered')) return 'already';
  // mod.rs: "no such approval: {id}"
  if (m.includes('no such approval')) return 'unknown';
  return 'error';
}

function messageOf(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Call the command and translate its envelope into one outcome.
 *
 * Envelope (mod.rs `approval_resolve`):
 *   { approval_id, tool_call_id, op, status: "completed"|"failed"|"rejected",
 *     executed, result, error }
 */
export async function resolveApproval(
  invoke: InvokeFn,
  approvalId: string,
  approved: boolean,
): Promise<ResolveOutcome> {
  let envelope: Record<string, unknown>;
  try {
    envelope = (await invoke(APPROVAL_RESOLVE_COMMAND, { approvalId, approved })) as Record<string, unknown>;
  } catch (e) {
    const message = messageOf(e);
    const kind = classifyResolveFailure(message);
    return { kind, approvalId, message };
  }

  const op = typeof envelope?.op === 'string' ? envelope.op : 'that action';
  switch (envelope?.status) {
    case 'completed':
      return { kind: 'ran', approvalId, op, result: envelope.result ?? null };
    case 'failed': {
      const error =
        typeof envelope.error === 'string' && envelope.error ? envelope.error : 'no reason given';
      // A mail mutation that reached the server and then lost its local write is
      // not the same event as one that never left the machine, and the user is the
      // one who has to know the difference.
      return { kind: error.includes(PARTIAL_MARKER) ? 'partial' : 'failed', approvalId, op, error };
    }
    case 'rejected':
      return { kind: 'rejected', approvalId, op };
    default:
      // An envelope we cannot read is not a success. Saying so beats rendering
      // a blank "done" for an action whose fate we do not know.
      return {
        kind: 'error',
        approvalId,
        message: `Atlas answered with a result this screen could not read (status: ${String(envelope?.status)}).`,
      };
  }
}

/** One line of JSON detail under an outcome, or null when there is nothing worth showing. */
export function summarizeResult(value: unknown, max = 300): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() ? value.slice(0, max) : null;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!text || text === '{}' || text === '[]' || text === 'null') return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Copy + tone for one outcome. Kept pure so the wording is pinned by tests, not by eyeballing the app. */
export function describeOutcome(o: ResolveOutcome): { tone: 'good' | 'bad' | 'muted'; title: string; detail: string | null } {
  switch (o.kind) {
    case 'ran':
      return { tone: 'good', title: `Approved — ${o.op} ran.`, detail: summarizeResult(o.result) };
    case 'failed':
      return { tone: 'bad', title: `Approved, but ${o.op} did not complete.`, detail: o.error };
    case 'partial':
      return {
        tone: 'bad',
        // Deliberately NOT "did not complete": the server-side change may have
        // been applied, and this is the one wording that does not tell the user
        // something the app cannot know.
        title: `Approved — ${o.op} may have taken effect. Check Mail.`,
        detail: o.error,
      };
    case 'rejected':
      return { tone: 'muted', title: `Rejected — ${o.op} was not run.`, detail: null };
    case 'expired':
      return {
        tone: 'bad',
        title: 'This expired before it was approved.',
        detail: 'Nothing ran. Ask Atlas again if you still want it.',
      };
    case 'already':
      return {
        tone: 'bad',
        title: 'This was already answered somewhere else.',
        detail: 'Nothing new ran just now.',
      };
    case 'unknown':
      return {
        tone: 'bad',
        title: 'Atlas no longer has this request.',
        detail: 'Nothing ran. Ask Atlas again if you still want it.',
      };
    case 'error':
      return { tone: 'bad', title: 'This could not be resolved.', detail: o.message };
  }
}

async function tauriInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke(cmd, args);
}

export function useApprovals() {
  const { user } = useAuth();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  /** Newest first. Survives the pending card disappearing — that is the point. */
  const [outcomes, setOutcomes] = useState<ResolveOutcome[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  /**
   * Synchronous double-fire guard. `resolvingId` is state, so it is still stale
   * inside a second handler dispatched in the same tick (a double-click, or a
   * StrictMode double-invocation) — by the time React re-renders, both calls are
   * already in flight against a Rust side with a real race in it. A ref changes
   * on assignment, so the second call never leaves the webview.
   */
  const inFlight = useRef<Set<string>>(new Set());

  const fetchApprovals = useCallback(async () => {
    // Signed out is a resolved state, not a pending one. Returning before the
    // `finally` left `isLoading` true forever, so any consumer that gated on it
    // sat on a spinner instead of reaching its empty state. Same bug shape as
    // the one fixed in useAgents/useSchedules/useToolCalls/useAgentRuns.
    if (!user) { setApprovals([]); setPendingCount(0); setIsLoading(false); return; }


    try {
      const { data, error } = await supabase
        .from('approvals')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      const typedData = (data || []).map(a => ({
        ...a,
        risk_level: a.risk_level || 'medium'
      }));

      setApprovals(typedData);
      setPendingCount(typedData.filter(a => a.status === 'pending').length);
    } catch (error) {
      console.error('Error fetching approvals:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const resolve = useCallback(async (approvalId: string, approved: boolean): Promise<ResolveOutcome | null> => {
    if (!user) return null;
    if (inFlight.current.has(approvalId)) return null;
    inFlight.current.add(approvalId);
    setResolvingId(approvalId);
    try {
      const outcome = await resolveApproval(tauriInvoke, approvalId, approved);
      // Replace any earlier outcome for the same id so a retried card does not
      // show two contradictory verdicts at once.
      setOutcomes((prev) => [outcome, ...prev.filter((o) => o.approvalId !== approvalId)].slice(0, 10));
      // Rust already moved the row; re-read rather than guessing its new state.
      await fetchApprovals();
      return outcome;
    } finally {
      inFlight.current.delete(approvalId);
      setResolvingId((cur) => (cur === approvalId ? null : cur));
    }
  }, [user, fetchApprovals]);

  const approveRequest = useCallback((approvalId: string) => resolve(approvalId, true), [resolve]);

  /**
   * No `reason` parameter: `approval_resolve` does not take one, and the old
   * code's way of keeping it — a direct UPDATE of `approvals.reason` — is the
   * exact write that poisoned the row for the real path. Persisting a reason
   * needs the argument added in Rust; until then the UI must not claim the
   * agent is told why.
   */
  const rejectRequest = useCallback((approvalId: string) => resolve(approvalId, false), [resolve]);

  const dismissOutcome = useCallback((approvalId: string) => {
    setOutcomes((prev) => prev.filter((o) => o.approvalId !== approvalId));
  }, []);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('approvals-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'approvals',
          filter: `user_id=eq.${user.id}`
        },
        () => {
          fetchApprovals();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchApprovals]);

  const getRiskColor = (level: string) => {
    switch (level) {
      case 'high': return 'text-red-400 bg-red-400/10';
      case 'medium': return 'text-yellow-400 bg-yellow-400/10';
      case 'low': return 'text-green-400 bg-green-400/10';
      default: return 'text-muted-foreground bg-muted';
    }
  };

  return {
    approvals,
    pendingCount,
    isLoading,
    fetchApprovals,
    approveRequest,
    rejectRequest,
    outcomes,
    dismissOutcome,
    resolvingId,
    getRiskColor,
  };
}
