// Atlas Mail data layer (Stage 6B, contract docs/design-sync/2026-07-27-mail-contract.md §3).
//
// One hook owns the whole mail surface: AtlasMail.tsx calls it once and passes
// slices down, so there is exactly one place that reads atlas.db, one place that
// talks to the worker through Tauri, and one place that appends to the audit
// trail. Children never call it — that is what keeps the audit trail complete.
//
// Two rules shape almost every line below:
//  1. Optimistic-local-then-remote. atlas.db is written first so the UI is
//     instant and works offline; a worker failure reverts the local row, because
//     a status the server never learned about gets silently overwritten by the
//     next sync and the user would watch their own action undo itself. The one
//     exception is markRead — see the comment there: reverting an unread count
//     re-arms the effect that asked for it, and the next sync re-asserts the
//     true count anyway, so that revert bought a loop and nothing else.
//  2. Every action appends exactly one append-only mail_audit_events row. The
//     trail is LOCAL — it never leaves this Mac.
//
// Sending is blocked: Cloudflare Email Sending needs the Workers Paid plan,
// which is not purchased. The whole approve-and-send path exists and fails
// loudly at the last hop rather than pretending to work.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri, localClient } from '@/integrations/local/localClient';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { useAuth } from '@/hooks/useAuth';
import { MAIL_AUDIT_ACTIONS, MailSendBlockedError } from '@/types/mail';
import type {
  MailAccount,
  MailAuditActor,
  MailAuditEvent,
  MailAutonomyMode,
  MailCounts,
  MailDraft,
  MailEmptyReason,
  MailMessage,
  MailRule,
  MailRuleAction,
  MailRulePredicate,
  MailThread,
  MailThreadStatus,
  MailView,
} from '@/types/mail';

export const UNDO_SEND_MS = 8000;

/** Verbatim, everywhere. Softening this is what the audit forbids. */
const SEND_BLOCKED_MESSAGE = 'Sending requires the Workers Paid plan';
const DESKTOP_ONLY = 'Atlas Mail is only available in the desktop app.';
const SIGN_IN_REQUIRED = 'Sign in to use Atlas Mail.';

/**
 * A snooze or schedule time must carry its own offset. Accepting a bare local
 * string here is how "send at 9am" silently becomes 9am UTC for a user in
 * Copenhagen — the class of bug the audit calls a safety issue, not polish.
 */
const ISO_WITH_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * How long the selection must sit still before Atlas fetches message bodies for
 * it. Long enough that j/k down a list is free, short enough that a deliberate
 * click still feels immediate — the local copy renders instantly either way.
 */
const DETAIL_FETCH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface UseAtlasMail {
  // ---- data ----
  account: MailAccount | null;
  threads: MailThread[];
  counts: MailCounts;
  selectedThreadId: string | null;
  thread: MailThread | null;
  messages: MailMessage[];
  drafts: MailDraft[];
  audit: MailAuditEvent[];
  /**
   * Audit rows with no thread: `sync` and `autonomy_changed`. They are written
   * with thread_id NULL, so the thread-scoped `audit` above can never contain
   * them — and "why did Atlas change my autonomy setting" is exactly the
   * question the trail exists to answer. Account-wide, not thread-filtered.
   */
  accountAudit: MailAuditEvent[];
  rules: MailRule[];

  // ---- view state ----
  view: MailView;
  mailbox: string | null;
  query: string;
  emptyReason: MailEmptyReason | null;

  // ---- status ----
  loading: boolean;
  syncing: boolean;
  /** A hard failure: the operation the user asked for did not happen. */
  error: string | null;
  /**
   * Non-fatal: the operation happened, but something is degraded (a sync that
   * skipped a mailbox, a background detail fetch that could not reach the
   * worker). Rendered differently from `error` — a warning must never look like
   * "your action failed", and an error must never look like a note.
   */
  warning: string | null;
  lastSyncedAt: string | null;
  pendingSend: { draftId: string; threadId: string; sendsAt: number } | null;

  // ---- view actions (synchronous, local only) ----
  setView(view: MailView): void;
  setMailbox(mailbox: string | null): void;
  setQuery(query: string): void;
  selectThread(threadId: string | null): void;
  selectRelative(delta: 1 | -1): void;
  dismissError(): void;
  dismissWarning(): void;

  // ---- thread actions ----
  sync(): Promise<void>;
  markRead(threadId: string): Promise<void>;
  setStatus(threadId: string, status: MailThreadStatus): Promise<void>;
  snooze(threadId: string, until: string): Promise<void>;

  // ---- draft actions ----
  draft(threadId: string, opts?: { instruction?: string; tone?: string }): Promise<MailDraft>;
  saveDraft(draftId: string, body: string): Promise<MailDraft>;
  reviseDraft(draftId: string, instruction: string): Promise<MailDraft>;
  discardDraft(draftId: string): Promise<void>;
  scheduleDraft(draftId: string, sendAt: string): Promise<MailDraft>;

  // ---- the blocked path ----
  approveAndSend(draftId: string): Promise<void>;
  undoSend(): Promise<void>;
  sendNow(draftId: string): Promise<never>;

  // ---- rules ----
  saveRule(rule: Omit<MailRule, 'id'> & { id?: string }): Promise<MailRule>;
  deleteRule(ruleId: string): Promise<void>;
  reorderRules(orderedIds: string[]): Promise<void>;

  // ---- autonomy ----
  setAutonomy(accountId: string, mode: MailAutonomyMode, opts?: { confirmed?: boolean }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Row decoding
//
// localClient reconstructs `extracted` (a known jsonb column) and the has_*/
// enabled booleans for us; the mail-specific JSON columns are not in its
// column-type sets and this hook owns them rather than editing a file it does
// not own (contract §1 gives I3 only the MAIL_FNS edit in localClient.ts).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB row / free-form JSON shape is decided at runtime by the query and payload
type Row = Record<string, any>;

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function msgOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;      // Rust commands reject with a plain string
  return 'Something went wrong in Atlas Mail.';
}

function toAccount(row: Row): MailAccount {
  return {
    id: row.id,
    user_id: row.user_id,
    provider: row.provider,
    email_address: row.email_address,
    status: row.status,
    last_error: row.last_error ?? null,
    last_synced_at: row.last_synced_at ?? null,
    autonomy_mode: row.autonomy_mode,
    autonomy_condition: parseJson<Record<string, unknown>>(row.autonomy_condition, {}),
    colour: row.colour ?? null,
  };
}

function toThread(row: Row, mailbox: string): MailThread {
  return {
    id: row.id,
    account_id: row.account_id,
    provider_thread_id: row.provider_thread_id,
    subject: row.subject ?? null,
    participants: parseJson<string[]>(row.participants, []),
    status: row.status,
    snoozed_until: row.snoozed_until ?? null,
    unread_count: Number(row.unread_count ?? 0),
    last_message_at: row.last_message_at ?? null,
    handled_at: row.handled_at ?? null,
    updated_at: row.updated_at,
    mailbox,
  };
}

function toMessage(row: Row): MailMessage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB row / free-form JSON shape is decided at runtime by the query and payload
  const extracted = parseJson<Record<string, any>>(row.extracted, {});
  return {
    id: row.id,
    account_id: row.account_id,
    thread_id: row.thread_id ?? null,
    provider_message_id: row.provider_message_id,
    from_address: row.from_address ?? null,
    subject: row.subject ?? null,
    snippet: row.snippet ?? null,
    received_at: row.received_at ?? null,
    has_attachments: row.has_attachments === true || row.has_attachments === 1,
    extracted: {
      direction: extracted.direction === 'outbound' ? 'outbound' : 'inbound',
      to_address: extracted.to_address ?? null,
      body_text: extracted.body_text ?? null,
      body_html: extracted.body_html ?? null,
      message_id: extracted.message_id ?? null,
      // `undefined` means "worker predates the size cap", which is not the same
      // as "known to be complete" — keep the distinction instead of defaulting.
      truncated: extracted.truncated == null ? undefined : Boolean(extracted.truncated),
      attachments: Array.isArray(extracted.attachments) ? extracted.attachments : undefined,
    },
  };
}

function toDraft(row: Row): MailDraft {
  return {
    id: row.id,
    thread_id: row.thread_id,
    body: row.body ?? '',
    state: row.state,
    scheduled_for: row.scheduled_for ?? null,
    sent_at: row.sent_at ?? null,
    model: row.model ?? null,
    prompt_version: row.prompt_version ?? null,
    updated_at: row.updated_at,
  };
}

function toRule(row: Row): MailRule {
  return {
    id: row.id,
    account_id: row.account_id ?? null,
    label: row.label,
    predicate: parseJson<MailRulePredicate>(row.predicate, {}),
    action: row.action as MailRuleAction,
    action_config: parseJson<Record<string, unknown>>(row.action_config, {}),
    enabled: row.enabled === true || row.enabled === 1,
    position: Number(row.position ?? 0),
  };
}

function toAuditEvent(row: Row): MailAuditEvent {
  return {
    seq: Number(row.seq ?? 0),
    id: row.id,
    thread_id: row.thread_id ?? null,
    ts: row.ts,
    actor: row.actor as MailAuditActor,
    action: row.action,
    detail: row.detail ?? '',
    rule_id: row.rule_id ?? null,
    model: row.model ?? null,
    prompt_version: row.prompt_version ?? null,
  };
}

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(cmd, args);
}

/** Drafting runs on the local brain sidecar; the CF JWT and the sidecar token are different tokens. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB row / free-form JSON shape is decided at runtime by the query and payload
async function brainPost(path: string, body: unknown): Promise<any> {
  const brain = await getBrainEndpoint();
  if (!brain) throw new Error(DESKTOP_ONLY);
  const res = await fetch(`${brain.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken() ?? ''}`,
      'x-sidecar-token': brain.token,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Atlas could not write that draft.');
  return data;
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

const MAIL_VIEWS: readonly MailView[] = [
  'triage', 'approve', 'drafting', 'escalate', 'snoozed', 'handled', 'handoff', 'sent_today',
] as const;

/** 'snoozed' is the view, 'snooze' is the status — the one place they differ. */
const VIEW_STATUS: Record<Exclude<MailView, 'sent_today'>, MailThreadStatus> = {
  triage: 'triage',
  approve: 'approve',
  drafting: 'drafting',
  escalate: 'escalate',
  snoozed: 'snooze',
  handled: 'handled',
  handoff: 'handoff',
};

/**
 * "Today" is the user's local midnight, not UTC midnight: a Date built from the
 * host clock already resolves in Intl.DateTimeFormat().resolvedOptions().timeZone,
 * so zeroing its time fields is the timezone-correct day boundary.
 */
function localDayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function threadMatchesQuery(t: MailThread, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (t.subject && t.subject.toLowerCase().includes(needle)) return true;
  if (t.mailbox.toLowerCase().includes(needle)) return true;
  return t.participants.some((p) => p.toLowerCase().includes(needle));
}

function byRecencyDesc(a: MailThread, b: MailThread): number {
  return (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '');
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useAtlasMail(): UseAtlasMail {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [allThreads, setAllThreads] = useState<MailThread[]>([]);
  const [allDrafts, setAllDrafts] = useState<MailDraft[]>([]);
  const [rules, setRules] = useState<MailRule[]>([]);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [audit, setAudit] = useState<MailAuditEvent[]>([]);
  const [accountAudit, setAccountAudit] = useState<MailAuditEvent[]>([]);

  const [view, setView] = useState<MailView>('triage');
  const [mailbox, setMailbox] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [pendingSend, setPendingSend] = useState<UseAtlasMail['pendingSend']>(null);

  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftsRef = useRef<MailDraft[]>([]);
  draftsRef.current = allDrafts;
  const threadsRef = useRef<MailThread[]>([]);
  threadsRef.current = allThreads;

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  const loadAll = useCallback(async () => {
    // Not signed in, or running in a browser dev server: no local DB and no
    // identity to scope rows by. Render empty rather than throwing.
    if (!userId || !isTauri()) {
      setAccounts([]);
      setAllThreads([]);
      setAllDrafts([]);
      setRules([]);
      setLoading(false);
      return;
    }
    try {
      const [accRes, thrRes, drfRes, rulRes] = await Promise.all([
        localClient.from('mail_accounts').select('*').eq('user_id', userId),
        localClient.from('mail_threads').select('*').eq('user_id', userId),
        localClient.from('mail_drafts').select('*').eq('user_id', userId),
        localClient.from('mail_rules').select('*').eq('user_id', userId).order('position'),
      ]);

      const accountRows: MailAccount[] = (accRes.data ?? []).map(toAccount);
      const mailboxOf = new Map(accountRows.map((a) => [a.id, a.email_address]));

      setAccounts(accountRows);
      setAllThreads(
        (thrRes.data ?? [])
          .map((r: Row) => toThread(r, mailboxOf.get(r.account_id) ?? ''))
          .sort(byRecencyDesc),
      );
      setAllDrafts((drfRes.data ?? []).map(toDraft));
      setRules((rulRes.data ?? []).map(toRule));
      setLastSyncedAt((prev) => prev ?? accountRows[0]?.last_synced_at ?? null);
    } catch (e) {
      setError(msgOf(e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const loadThreadDetail = useCallback(async (threadId: string | null) => {
    if (!threadId || !userId || !isTauri()) {
      setMessages([]);
      setAudit([]);
      return;
    }
    try {
      const [msgRes, audRes] = await Promise.all([
        localClient.from('mail_messages').select('*').eq('thread_id', threadId).order('received_at'),
        localClient
          .from('mail_audit_events')
          .select('*')
          .eq('thread_id', threadId)
          .order('seq', { ascending: false }),
      ]);
      setMessages((msgRes.data ?? []).map(toMessage));
      setAudit((audRes.data ?? []).map(toAuditEvent));
      // Opening a thread is a completed operation: a failure from three threads
      // ago has no bearing here and must not keep occupying the banner.
      setError(null);
    } catch (e) {
      setError(msgOf(e));
    }
  }, [userId]);

  /**
   * The account-wide half of the trail. `sync` and `autonomy_changed` rows carry
   * thread_id NULL, so the .eq('thread_id', …) query above is structurally
   * incapable of returning them — they need their own read or they are written
   * and never readable. `is` is filtered client-side by localClient, so the
   * user_id eq is what keeps the scan bounded.
   */
  const loadAccountAudit = useCallback(async () => {
    if (!userId || !isTauri()) {
      setAccountAudit([]);
      return;
    }
    try {
      const { data } = await localClient
        .from('mail_audit_events')
        .select('*')
        .eq('user_id', userId)
        .is('thread_id', null)
        .order('seq', { ascending: false })
        .limit(100);
      setAccountAudit((data ?? []).map(toAuditEvent));
    } catch (e) {
      // The account trail is a read-only panel; failing to load it must not
      // take over the banner an action is using.
      setWarning(msgOf(e));
    }
  }, [userId]);

  useEffect(() => {
    void loadAll();
    void loadAccountAudit();
  }, [loadAll, loadAccountAudit]);

  useEffect(() => {
    void loadThreadDetail(selectedThreadId);
  }, [loadThreadDetail, selectedThreadId]);

  // I2's commands emit `db:changed` for every table they touch, so a
  // subscription is enough — no polling. The payload carries no row data, so
  // handlers re-query rather than patching state from the event.
  useEffect(() => {
    if (!isTauri() || !userId) return;
    const channel = localClient.channel('mail');
    for (const table of ['mail_accounts', 'mail_threads', 'mail_drafts', 'mail_rules']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        void loadAll();
      });
    }
    for (const table of ['mail_messages', 'mail_audit_events']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        void loadThreadDetail(selectedThreadId);
        // An account-level row (sync, autonomy_changed) lands in the same table
        // and would otherwise only appear after a relaunch.
        if (table === 'mail_audit_events') void loadAccountAudit();
      });
    }
    channel.subscribe();
    return () => {
      localClient.removeChannel(channel);
    };
  }, [userId, loadAll, loadThreadDetail, loadAccountAudit, selectedThreadId]);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    if (detailFetchTimer.current) clearTimeout(detailFetchTimer.current);
  }, []);

  // -------------------------------------------------------------------------
  // Derived view
  // -------------------------------------------------------------------------

  // A thread counts as "sent today" via its drafts; there is no thread column
  // for it. It reads 0 until the Workers Paid plan exists, which is correct.
  const sentTodayThreadIds = useMemo(() => {
    const dayStart = localDayStartMs();
    const ids = new Set<string>();
    for (const d of allDrafts) {
      if (d.state === 'sent' && d.sent_at && Date.parse(d.sent_at) >= dayStart) ids.add(d.thread_id);
    }
    return ids;
  }, [allDrafts]);

  const threadsInView = useCallback(
    (v: MailView) =>
      v === 'sent_today'
        ? allThreads.filter((t) => sentTodayThreadIds.has(t.id))
        : allThreads.filter((t) => t.status === VIEW_STATUS[v]),
    [allThreads, sentTodayThreadIds],
  );

  const counts = useMemo(() => {
    const out = {} as MailCounts;
    for (const v of MAIL_VIEWS) out[v] = threadsInView(v).length;
    return out;
  }, [threadsInView]);

  const inView = useMemo(() => threadsInView(view), [threadsInView, view]);
  const inMailbox = useMemo(
    () => (mailbox ? inView.filter((t) => t.mailbox === mailbox) : inView),
    [inView, mailbox],
  );
  const threads = useMemo(
    () => inMailbox.filter((t) => threadMatchesQuery(t, query)),
    [inMailbox, query],
  );

  const emptyReason = useMemo<MailEmptyReason | null>(() => {
    if (threads.length > 0) return null;
    // "Have we ever looked?" is a property of the mailbox, not of this process:
    // lastSyncedAt is seeded from the persisted account.last_synced_at in
    // loadAll, so a relaunch on an empty mailbox says "nothing has arrived"
    // instead of contradicting the sidebar's "Last synced 14:32".
    if (allThreads.length === 0) return lastSyncedAt ? 'no_threads_at_all' : 'not_synced_yet';
    // §6.6: the view/filter distinction is counts[view] > 0 with an empty list.
    if (inView.length === 0) return 'view_empty';
    if (inMailbox.length === 0) return 'filter_empty';
    return 'search_empty';
  }, [threads.length, allThreads.length, lastSyncedAt, inView.length, inMailbox.length]);

  const thread = useMemo(
    () => allThreads.find((t) => t.id === selectedThreadId) ?? null,
    [allThreads, selectedThreadId],
  );

  // Only *live* drafts. Discarding a draft sets state:'discarded' but leaves the
  // row in place (the trail has to keep showing what Atlas proposed), and there
  // is no updated_at trigger on mail_drafts — so filtering by thread alone would
  // hand the composer the draft the user just threw away and never give the
  // "Draft a reply" button back. 'sent' is excluded for the same reason: a sent
  // reply is history, not something the composer should reopen for editing.
  const drafts = useMemo(
    () =>
      allDrafts
        .filter((d) => d.thread_id === selectedThreadId && d.state !== 'discarded' && d.state !== 'sent')
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')),
    [allDrafts, selectedThreadId],
  );

  // -------------------------------------------------------------------------
  // Write plumbing
  // -------------------------------------------------------------------------

  /**
   * The head of every action: asserts a usable session (throwing the sentence
   * the UI should render — callers surface `err.message` as-is) and clears the
   * banner the previous action left behind.
   *
   * Clearing at the START rather than on success is deliberate. setError(null)
   * used to happen in exactly one place (sync), so a single failure sat on
   * screen through every thread the user opened afterwards. Clearing on success
   * instead would race: `loadAll` runs from the db:changed subscription too, and
   * a write that succeeds locally then fails remotely (markRead) would have its
   * error wiped by the reload its own local write triggered. Start clean, fail
   * loud — an action that fails re-sets the banner from its own catch.
   */
  const beginAction = useCallback((): string => {
    if (!isTauri()) throw new Error(DESKTOP_ONLY);
    if (!userId) throw new Error(SIGN_IN_REQUIRED);
    setError(null);
    return userId;
  }, [userId]);

  const appendAudit = useCallback(
    async (e: {
      threadId: string | null;
      actor: MailAuditActor;
      action: string;
      detail: string;
      ruleId?: string | null;
      model?: string | null;
      promptVersion?: string | null;
    }) => {
      if (!userId || !isTauri()) return;
      // Best-effort: a failed audit write must not roll back the action the user
      // already saw succeed. It is logged, not silently swallowed.
      const { error: auditError } = await localClient.from('mail_audit_events').insert({
        id: uuid(),
        user_id: userId,
        thread_id: e.threadId,
        actor: e.actor,
        action: e.action,
        detail: e.detail,
        rule_id: e.ruleId ?? null,
        model: e.model ?? null,
        prompt_version: e.promptVersion ?? null,
      });
      if (auditError) console.error('mail audit write failed:', auditError.message);
    },
    [userId],
  );

  const patchThreadLocal = useCallback(async (threadId: string, patch: Row) => {
    const { error: err } = await localClient.from('mail_threads').update(patch).eq('id', threadId);
    if (err) throw new Error(err.message);
    setAllThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, ...patch } : t)));
  }, []);

  const findDraft = useCallback((draftId: string): MailDraft => {
    const d = draftsRef.current.find((x) => x.id === draftId);
    if (!d) throw new Error('That draft is no longer in the local store.');
    return d;
  }, []);

  // -------------------------------------------------------------------------
  // View actions
  // -------------------------------------------------------------------------

  const selectThread = useCallback(
    (threadId: string | null) => {
      setSelectedThreadId(threadId);
      // The selection itself is a completed operation; a stale banner from an
      // earlier thread must not follow the user around the list.
      setError(null);
      // Cursor movement is not a request for network I/O. Holding `j` down the
      // list used to fire one mail_thread_fetch per row; the fetch now waits for
      // the selection to settle, so 40 keystrokes cost one round-trip, not 40.
      if (detailFetchTimer.current) clearTimeout(detailFetchTimer.current);
      if (!threadId || !userId || !isTauri()) return;
      detailFetchTimer.current = setTimeout(() => {
        detailFetchTimer.current = null;
        // Message bodies are fetched for the selected thread only — a detail
        // request per row on every list sync is exactly what the perf review
        // exists to prevent. Deliberately NOT `syncing`: that flag means "the
        // mailbox is syncing", and flipping it here disabled the composer and
        // the sync button on every arrow key. Failure is non-fatal — the local
        // copy still renders — so it is a warning, not an error.
        void tauriInvoke('mail_thread_fetch', { token: getToken() ?? '', userId, threadId })
          .then(() => loadThreadDetail(threadId))
          .catch((e) => setWarning(msgOf(e)));
      }, DETAIL_FETCH_DEBOUNCE_MS);
    },
    [userId, loadThreadDetail],
  );

  const selectRelative = useCallback(
    (delta: 1 | -1) => {
      if (threads.length === 0) return;
      const current = threads.findIndex((t) => t.id === selectedThreadId);
      // No selection yet: j lands on the first row, k on the last.
      const next = current === -1 ? (delta === 1 ? 0 : threads.length - 1) : current + delta;
      if (next < 0 || next >= threads.length) return;   // safe at the ends
      selectThread(threads[next].id);
    },
    [threads, selectedThreadId, selectThread],
  );

  // -------------------------------------------------------------------------
  // Thread actions
  // -------------------------------------------------------------------------

  const sync = useCallback(async () => {
    const uid = beginAction();
    setSyncing(true);
    setError(null);
    setWarning(null);
    try {
      const res = await tauriInvoke<{ lastSyncedAt?: string; warnings?: string[] }>('mail_sync', {
        token: getToken() ?? '',
        userId: uid,
        limit: 200,
      });
      setLastSyncedAt(res?.lastSyncedAt ?? new Date().toISOString());
      // A sync that returned warnings still synced. Reporting that through
      // `error` told the user their sync failed when it had not.
      if (res?.warnings?.length) setWarning(res.warnings.join(' '));
      await loadAll();
      await loadAccountAudit();
      // mail_sync writes its own `sync` audit row inside the transaction that
      // wrote the threads — a second one here would double-count the sync.
    } catch (e) {
      setError(msgOf(e));
    } finally {
      setSyncing(false);
    }
  }, [beginAction, loadAll, loadAccountAudit]);

  const markRead = useCallback(
    async (threadId: string) => {
      // The already-read check runs BEFORE beginAction so the no-op path writes
      // no state at all — not even clearing the banner. markRead is the one
      // action fired by an effect rather than a click, so "called again with
      // nothing to do" has to be completely inert or it feeds the render loop
      // this function is otherwise careful not to start.
      const before = threadsRef.current.find((t) => t.id === threadId);
      if (!before || before.unread_count === 0) return;
      const uid = beginAction();
      await patchThreadLocal(threadId, { unread_count: 0 });
      try {
        await tauriInvoke('mail_mark_read', { token: getToken() ?? '', userId: uid, threadId });
      } catch (e) {
        // Deliberately NOT reverted, unlike every other action here. The local
        // 0 is what makes this call idempotent: reverting restores a non-zero
        // unread_count, which changes the thread object identity, which re-runs
        // the caller's mark-read effect, which calls this again — an unbounded
        // loop at network-failure speed. A read receipt is also the one action
        // that heals itself: mail.rs upsert_thread ASSIGNS unread_count from the
        // worker rather than incrementing, so the next sync restores the true
        // count if the worker never learned about this one.
        setError(msgOf(e));
        throw e instanceof Error ? e : new Error(msgOf(e));
      }
      await appendAudit({
        threadId,
        actor: 'user',
        action: MAIL_AUDIT_ACTIONS.MARKED_READ,
        detail: `${before.unread_count} unread cleared`,
      });
    },
    [beginAction, patchThreadLocal, appendAudit],
  );

  const setStatus = useCallback(
    async (threadId: string, status: MailThreadStatus) => {
      const uid = beginAction();
      const before = threadsRef.current.find((t) => t.id === threadId);
      if (!before) throw new Error('That thread is not in the local store — sync first.');
      await patchThreadLocal(threadId, {
        status,
        handled_at: status === 'handled' ? new Date().toISOString() : before.handled_at,
      });
      try {
        await tauriInvoke('mail_set_status', { token: getToken() ?? '', userId: uid, threadId, status });
      } catch (e) {
        await patchThreadLocal(threadId, { status: before.status, handled_at: before.handled_at });
        setError(msgOf(e));
        throw e instanceof Error ? e : new Error(msgOf(e));
      }
      await appendAudit({
        threadId,
        actor: 'user',
        action: MAIL_AUDIT_ACTIONS.STATUS_CHANGED,
        detail: `${before.status} → ${status}`,
      });
    },
    [beginAction, patchThreadLocal, appendAudit],
  );

  const snooze = useCallback(
    async (threadId: string, until: string) => {
      const uid = beginAction();
      if (!ISO_WITH_OFFSET.test(until)) {
        throw new Error('Snooze time must be an ISO-8601 timestamp with a timezone offset.');
      }
      const before = threadsRef.current.find((t) => t.id === threadId);
      if (!before) throw new Error('That thread is not in the local store — sync first.');
      // Stored verbatim: re-encoding the caller's offset-bearing string is how a
      // snooze silently moves hours.
      await patchThreadLocal(threadId, { status: 'snooze', snoozed_until: until });
      try {
        await tauriInvoke('mail_set_status', {
          token: getToken() ?? '',
          userId: uid,
          threadId,
          status: 'snooze',
        });
      } catch (e) {
        await patchThreadLocal(threadId, { status: before.status, snoozed_until: before.snoozed_until });
        setError(msgOf(e));
        throw e instanceof Error ? e : new Error(msgOf(e));
      }
      await appendAudit({
        threadId,
        actor: 'user',
        action: MAIL_AUDIT_ACTIONS.SNOOZED,
        detail: `until ${until}`,
      });
    },
    [beginAction, patchThreadLocal, appendAudit],
  );

  // -------------------------------------------------------------------------
  // Draft actions
  // -------------------------------------------------------------------------

  const insertDraftRow = useCallback(
    async (uid: string, threadId: string, res: { body?: string; model?: string; promptVersion?: string }) => {
      const { data, error: err } = await localClient
        .from('mail_drafts')
        .insert({
          id: uuid(),
          user_id: uid,
          thread_id: threadId,
          body: res.body ?? '',
          state: 'proposed',
          model: res.model ?? null,
          prompt_version: res.promptVersion ?? null,
        })
        .select()
        .single();
      if (err) throw new Error(err.message);
      return toDraft(data as Row);
    },
    [],
  );

  const draft = useCallback(
    async (threadId: string, opts?: { instruction?: string; tone?: string }) => {
      const uid = beginAction();
      const res = await brainPost('/mail/draft', {
        threadId,
        instruction: opts?.instruction,
        tone: opts?.tone,
      });
      const created = await insertDraftRow(uid, threadId, res);
      await appendAudit({
        threadId,
        actor: 'atlas',
        action: MAIL_AUDIT_ACTIONS.DRAFTED,
        detail: opts?.instruction ? `instruction: ${opts.instruction}` : 'unprompted draft',
        model: created.model,
        promptVersion: created.prompt_version,
      });
      await loadAll();
      return created;
    },
    [beginAction, insertDraftRow, appendAudit, loadAll],
  );

  const saveDraft = useCallback(
    async (draftId: string, body: string) => {
      beginAction();
      const before = findDraft(draftId);
      const { data, error: err } = await localClient
        .from('mail_drafts')
        .update({ body })
        .eq('id', draftId)
        .select()
        .single();
      if (err) throw new Error(err.message);
      // CONTRACT-GAP: MAIL_AUDIT_ACTIONS is fixed verbatim by contract §2 and has
      // no `draft_saved`. A hand edit is logged as draft_revised by actor 'user'
      // with no model — which is exactly what distinguishes it from an AI revision.
      await appendAudit({
        threadId: before.thread_id,
        actor: 'user',
        action: MAIL_AUDIT_ACTIONS.DRAFT_REVISED,
        detail: 'Edited by hand',
      });
      await loadAll();
      return toDraft(data as Row);
    },
    [beginAction, findDraft, appendAudit, loadAll],
  );

  const reviseDraft = useCallback(
    async (draftId: string, instruction: string) => {
      const uid = beginAction();
      const before = findDraft(draftId);
      const res = await brainPost('/mail/draft', {
        threadId: before.thread_id,
        instruction,
        previousDraft: before.body,
      });
      const created = await insertDraftRow(uid, before.thread_id, res);
      // The superseded draft is discarded rather than overwritten so the trail
      // still shows what Atlas proposed before the user pushed back.
      const { error: err } = await localClient
        .from('mail_drafts')
        .update({ state: 'discarded' })
        .eq('id', draftId);
      if (err) throw new Error(err.message);
      await appendAudit({
        threadId: before.thread_id,
        actor: 'atlas',
        action: MAIL_AUDIT_ACTIONS.DRAFT_REVISED,
        detail: `instruction: ${instruction}`,
        model: created.model,
        promptVersion: created.prompt_version,
      });
      await loadAll();
      return created;
    },
    [beginAction, findDraft, insertDraftRow, appendAudit, loadAll],
  );

  const discardDraft = useCallback(
    async (draftId: string) => {
      beginAction();
      const before = findDraft(draftId);
      const { error: err } = await localClient
        .from('mail_drafts')
        .update({ state: 'discarded' })
        .eq('id', draftId);
      if (err) throw new Error(err.message);
      await appendAudit({
        threadId: before.thread_id,
        actor: 'user',
        action: MAIL_AUDIT_ACTIONS.DRAFT_DISCARDED,
        detail: 'Draft discarded',
      });
      await loadAll();
    },
    [beginAction, findDraft, appendAudit, loadAll],
  );

  const scheduleDraft = useCallback(
    async (draftId: string, sendAt: string) => {
      beginAction();
      if (!ISO_WITH_OFFSET.test(sendAt)) {
        throw new Error('Send time must be an ISO-8601 timestamp with a timezone offset.');
      }
      const before = findDraft(draftId);
      const { data, error: err } = await localClient
        .from('mail_drafts')
        .update({ state: 'scheduled', scheduled_for: sendAt })
        .eq('id', draftId)
        .select()
        .single();
      if (err) throw new Error(err.message);
      await appendAudit({
        threadId: before.thread_id,
        actor: 'user',
        action: MAIL_AUDIT_ACTIONS.SCHEDULED,
        detail: `send at ${sendAt}`,
      });
      await loadAll();
      return toDraft(data as Row);
    },
    [beginAction, findDraft, appendAudit, loadAll],
  );

  // -------------------------------------------------------------------------
  // The blocked path
  // -------------------------------------------------------------------------

  const sendNow = useCallback(
    async (draftId: string): Promise<never> => {
      const d = draftsRef.current.find((x) => x.id === draftId);
      if (userId && isTauri() && d) {
        // mail_send_reply refuses as its first statement and writes the
        // send_blocked audit row itself, so the refusal and its record come from
        // one place. It never resolves; the catch is the expected path.
        try {
          await tauriInvoke('mail_send_reply', {
            token: getToken() ?? '',
            userId,
            threadId: d.thread_id,
            text: d.body,
          });
        } catch {
          // Expected — Rust already logged it.
        }
      }
      throw new MailSendBlockedError(SEND_BLOCKED_MESSAGE);
    },
    [userId],
  );

  const sendNowRef = useRef(sendNow);
  sendNowRef.current = sendNow;

  const approveAndSend = useCallback(
    async (draftId: string) => {
      beginAction();
      const d = findDraft(draftId);
      if (pendingSend) throw new Error('Another reply is already waiting to go out.');
      await appendAudit({
        threadId: d.thread_id,
        actor: 'user',
        action: MAIL_AUDIT_ACTIONS.SEND_ATTEMPTED,
        // The trail is permanent and append-only, so it must not read as though
        // mail nearly went out. Sending is refused unconditionally in
        // mail.rs (Cloudflare Email Sending needs the unpurchased Workers Paid
        // plan), and someone reading this record months later has no way to
        // know that unless the row says so.
        detail:
          `approved, ${UNDO_SEND_MS / 1000}s undo window — ` +
          'sending is disabled (Workers Paid plan not active), nothing was sent',
      });
      setPendingSend({ draftId, threadId: d.thread_id, sendsAt: Date.now() + UNDO_SEND_MS });
      // Resolves as soon as the window opens, not when mail leaves — mail cannot
      // leave today, and a promise that waited for it would never settle.
      undoTimer.current = setTimeout(() => {
        undoTimer.current = null;
        setPendingSend(null);
        sendNowRef.current(draftId).catch((e) => setError(msgOf(e)));
      }, UNDO_SEND_MS);
    },
    [beginAction, findDraft, pendingSend, appendAudit],
  );

  const undoSend = useCallback(async () => {
    if (undoTimer.current) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    if (!pendingSend) return;   // window already elapsed — no-op, not an error
    const { draftId, threadId } = pendingSend;
    setPendingSend(null);
    await appendAudit({
      threadId,
      actor: 'user',
      action: MAIL_AUDIT_ACTIONS.SEND_UNDONE,
      // Same honesty constraint as SEND_ATTEMPTED: "pulled back" alone implies
      // something was in flight to pull back from.
      detail: `draft ${draftId} withdrawn before the undo window closed — nothing had been sent`,
    });
  }, [pendingSend, appendAudit]);

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  // Rule CRUD writes no audit row: the trail records what Atlas did to a thread,
  // and MAIL_AUDIT_ACTIONS (fixed verbatim by contract §2) has no rule_created /
  // rule_deleted. A rule firing does get logged, as `rule_matched`.
  const saveRule = useCallback(
    async (rule: Omit<MailRule, 'id'> & { id?: string }) => {
      const uid = beginAction();
      // The columns a save owns. `id` and `user_id` are deliberately absent:
      // an edit must not be able to move a rule to another id or another user.
      const columns = {
        account_id: rule.account_id ?? null,
        label: rule.label,
        predicate: JSON.stringify(rule.predicate ?? {}),
        action: rule.action,
        action_config: JSON.stringify(rule.action_config ?? {}),
        enabled: rule.enabled ? 1 : 0,
        position: rule.position ?? 0,
      };

      // NOT .upsert(). localClient's upsert is insert under another name and
      // db_insert builds a plain INSERT, so editing an existing rule raised
      // "UNIQUE constraint failed" — and because the editor fires this through
      // `void submit()`, that rejection was swallowed and every edit looked
      // like it saved while changing nothing. Update first when we were handed
      // an id, and fall back to insert only if that id matched no row (a caller
      // holding an id for a rule deleted in another window).
      if (rule.id) {
        const { data, error: err } = await localClient
          .from('mail_rules')
          .update(columns)
          .eq('id', rule.id)
          .select()
          .single();
        if (!err) {
          await loadAll();
          return toRule(data as Row);
        }
        // PGRST116 is localClient's "no rows matched"; anything else is real.
        if (err.code !== 'PGRST116') throw new Error(err.message);
      }

      const { data, error: err } = await localClient
        .from('mail_rules')
        .insert({ id: rule.id ?? uuid(), user_id: uid, ...columns })
        .select()
        .single();
      if (err) throw new Error(err.message);
      await loadAll();
      return toRule(data as Row);
    },
    [beginAction, loadAll],
  );

  const deleteRule = useCallback(
    async (ruleId: string) => {
      beginAction();
      const { error: err } = await localClient.from('mail_rules').delete().eq('id', ruleId);
      if (err) throw new Error(err.message);
      await loadAll();
    },
    [beginAction, loadAll],
  );

  const reorderRules = useCallback(
    async (orderedIds: string[]) => {
      beginAction();
      // Position is the evaluation order, so it is written for every id in one
      // pass — a partial reorder would change which rule wins.
      for (let i = 0; i < orderedIds.length; i++) {
        const { error: err } = await localClient
          .from('mail_rules')
          .update({ position: i })
          .eq('id', orderedIds[i]);
        if (err) throw new Error(err.message);
      }
      await loadAll();
    },
    [beginAction, loadAll],
  );

  // -------------------------------------------------------------------------
  // Autonomy
  // -------------------------------------------------------------------------

  const setAutonomy = useCallback(
    async (accountId: string, mode: MailAutonomyMode, opts?: { confirmed?: boolean }) => {
      beginAction();
      // The guard lives here rather than only in the UI: an agent sending mail
      // unsupervised is the highest-risk behaviour in the product, and a second
      // caller must not be able to reach it by skipping a dialog.
      if (mode === 'autonomous' && !opts?.confirmed) {
        throw new Error('Autonomous sending has to be confirmed explicitly for this mailbox.');
      }
      const before = accounts.find((a) => a.id === accountId);
      const { error: err } = await localClient
        .from('mail_accounts')
        .update({ autonomy_mode: mode })
        .eq('id', accountId);
      if (err) throw new Error(err.message);
      await appendAudit({
        threadId: null,
        actor: 'user',
        action: MAIL_AUDIT_ACTIONS.AUTONOMY_CHANGED,
        detail: `${before?.email_address ?? accountId}: ${before?.autonomy_mode ?? 'approve_all'} → ${mode}`,
      });
      await loadAll();
      // This is the row a user comes to the trail looking for; it carries no
      // thread, so nothing else on screen would pull it in.
      await loadAccountAudit();
    },
    [beginAction, accounts, appendAudit, loadAll, loadAccountAudit],
  );

  // Dismissal is explicit rather than timed: a banner that clears itself is one
  // the user can miss entirely, and both of these describe something that
  // already happened.
  const dismissError = useCallback(() => setError(null), []);
  const dismissWarning = useCallback(() => setWarning(null), []);

  return {
    account: accounts[0] ?? null,
    threads,
    counts,
    selectedThreadId,
    thread,
    messages,
    drafts,
    audit,
    accountAudit,
    rules,

    view,
    mailbox,
    query,
    emptyReason,

    loading,
    syncing,
    error,
    warning,
    lastSyncedAt,
    pendingSend,

    setView,
    setMailbox,
    setQuery,
    selectThread,
    selectRelative,
    dismissError,
    dismissWarning,

    sync,
    markRead,
    setStatus,
    snooze,

    draft,
    saveDraft,
    reviseDraft,
    discardDraft,
    scheduleDraft,

    approveAndSend,
    undoSend,
    sendNow,

    saveRule,
    deleteRule,
    reorderRules,

    setAutonomy,
  };
}

export default useAtlasMail;
