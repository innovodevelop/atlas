/**
 * Shared mail types. Two vocabularies live here on purpose:
 *  - `Worker*` mirrors atlas-mail's D1 rows byte-for-byte (snake_case, JSON-as-string).
 *  - `Mail*`   is the local atlas.db shape the UI renders.
 * Keeping them separate is what makes the sync mapping in §5 auditable instead of implicit.
 */

/** Exact enum from atlas-mail/schema.sql CHECK and index.ts `allowed[]`. Do not extend. */
export type MailThreadStatus =
  | 'triage'
  | 'approve'
  | 'drafting'
  | 'escalate'
  | 'snooze'
  | 'handled'
  | 'handoff';

export const MAIL_THREAD_STATUSES: readonly MailThreadStatus[] = [
  'triage', 'approve', 'drafting', 'escalate', 'snooze', 'handled', 'handoff',
] as const;

/** atlas.db mail_accounts.autonomy_mode. 'autonomous' is never a default — see §0.4. */
export type MailAutonomyMode = 'approve_all' | 'conditional' | 'autonomous';

/** atlas.db mail_drafts.state. */
export type MailDraftState = 'proposed' | 'scheduled' | 'sent' | 'discarded';

/** atlas.db mail_rules.action. */
export type MailRuleAction = 'approve' | 'draft' | 'escalate' | 'snooze' | 'handoff' | 'handle';

/** atlas.db mail_audit_events.actor. */
export type MailAuditActor = 'atlas' | 'user' | 'rule';

// ---------------------------------------------------------------------------
// Worker wire shapes (GET https://atlas-mail.magnus-d7d.workers.dev/api/...)
// ---------------------------------------------------------------------------

/** Row from GET /api/threads — the list projection, not all columns. */
export interface WorkerThreadRow {
  id: string;                  // 36-char UUID; the path-param regex requires this shape
  mailbox: string;
  subject: string | null;
  /** JSON-encoded array of addresses. The worker does NOT parse it — callers must JSON.parse. */
  participants: string;
  status: MailThreadStatus;
  unread_count: number;
  last_message_at: string | null;
}

/** `thread` from GET /api/threads/:id — SELECT *, so it carries three extra columns. */
export interface WorkerThreadFull extends WorkerThreadRow {
  subject_key: string | null;
  snoozed_until: string | null;
  handled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerMessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  message_id: string | null;   // RFC 2822 Message-ID, UNIQUE in D1
  from_address: string;
  to_address: string;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  sent_at: string | null;
  /**
   * Optional, added by I1's size cap (stage 6B). Absent on any worker deploy that
   * predates it, so every consumer must treat `undefined` as "not truncated".
   */
  truncated?: 0 | 1;
  raw_size_bytes?: number | null;
}

/**
 * Metadata only. blob_key is always null today (no blob store wired up) and
 * there is no route that returns attachment bytes — the UI shows name/type/size
 * and nothing is clickable.
 *
 * Named blob_key, not r2_key: the store is S3. This mirrors the worker's
 * mail_attachments column exactly — they drifted apart once already, when the
 * worker migrated and this type did not.
 */
export interface WorkerAttachmentRow {
  id: string;
  message_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  blob_key: string | null;
}

export interface WorkerThreadDetail {
  thread: WorkerThreadFull;
  messages: WorkerMessageRow[];
  attachments: WorkerAttachmentRow[];
}

// ---------------------------------------------------------------------------
// Local shapes (atlas.db, what the UI renders)
// ---------------------------------------------------------------------------

/** atlas.db mail_accounts row, decoded. */
export interface MailAccount {
  id: string;
  user_id: string;
  provider: 'gmail' | 'outlook' | 'imap';
  email_address: string;
  status: 'active' | 'error' | 'disconnected';
  last_error: string | null;
  last_synced_at: string | null;
  autonomy_mode: MailAutonomyMode;
  /** JSON object, already parsed. Shape is implementer-defined; `{}` means no conditions. */
  autonomy_condition: Record<string, unknown>;
  colour: string | null;
}

/** atlas.db mail_threads row + the joined bits the list row needs. */
export interface MailThread {
  id: string;                       // local uuid (NOT the worker id)
  account_id: string;
  /** The worker's thread uuid. Conflict key with account_id — see §5. */
  provider_thread_id: string;
  subject: string | null;
  /** Parsed here, unlike the worker's JSON string. */
  participants: string[];
  status: MailThreadStatus;
  snoozed_until: string | null;
  unread_count: number;
  last_message_at: string | null;
  handled_at: string | null;
  updated_at: string;
  /** Denormalised for the list row; comes from the account, not the thread table. */
  mailbox: string;
}

/** atlas.db mail_messages row, plus the body which lives in `extracted`. */
export interface MailMessage {
  id: string;
  account_id: string;
  thread_id: string | null;
  provider_message_id: string;      // the worker's mail_messages.id
  from_address: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: string | null;
  has_attachments: boolean;
  /**
   * atlas.db mail_messages.extracted, parsed. The sync writes exactly these keys —
   * everything the reading pane needs that has no dedicated column.
   */
  extracted: {
    direction: 'inbound' | 'outbound';
    to_address: string | null;
    body_text: string | null;
    body_html: string | null;
    message_id: string | null;
    /** From WorkerMessageRow.truncated; undefined on pre-size-cap worker deploys. */
    truncated?: boolean;
    attachments?: Array<{ filename: string | null; mime_type: string | null; size_bytes: number | null }>;
  };
}

/** atlas.db mail_drafts row. */
export interface MailDraft {
  id: string;
  thread_id: string;
  body: string;
  state: MailDraftState;
  /** ISO-8601 WITH offset. Never a bare local string — see §3 note on scheduling. */
  scheduled_for: string | null;
  sent_at: string | null;
  model: string | null;
  prompt_version: string | null;
  updated_at: string;
}

/** atlas.db mail_rules row, predicate/action_config parsed. */
export interface MailRule {
  id: string;
  account_id: string | null;        // null = applies to every mailbox
  label: string;
  predicate: MailRulePredicate;
  action: MailRuleAction;
  action_config: Record<string, unknown>;
  enabled: boolean;
  position: number;
}

/**
 * Rule predicate. Deliberately small and declarative: every field is something the
 * sync already has locally, so a rule can be evaluated without a network call.
 * All present fields must match (AND). Absent field = not constrained.
 */
export interface MailRulePredicate {
  from_contains?: string;
  subject_contains?: string;
  body_contains?: string;
  mailbox?: string;
  has_attachments?: boolean;
  /** Only these are legal; the editor must not offer free-form operators. */
  unread_only?: boolean;
}

/** atlas.db mail_audit_events row. Append-only; there is no update path. */
export interface MailAuditEvent {
  seq: number;
  id: string;
  thread_id: string | null;
  ts: string;
  actor: MailAuditActor;
  action: string;                   // free text, but use MAIL_AUDIT_ACTIONS below
  detail: string;
  rule_id: string | null;
  model: string | null;
  prompt_version: string | null;
}

/** The action vocabulary. Extending it is fine; renaming an existing one is not. */
export const MAIL_AUDIT_ACTIONS = {
  SYNCED: 'sync',
  STATUS_CHANGED: 'status_changed',
  MARKED_READ: 'marked_read',
  SNOOZED: 'snoozed',
  DRAFTED: 'drafted',
  DRAFT_REVISED: 'draft_revised',
  DRAFT_DISCARDED: 'draft_discarded',
  SCHEDULED: 'scheduled',
  SEND_ATTEMPTED: 'send_attempted',
  SEND_BLOCKED: 'send_blocked',
  SEND_UNDONE: 'send_undone',
  RULE_MATCHED: 'rule_matched',
  AUTONOMY_CHANGED: 'autonomy_changed',
} as const;

/** Sidebar views. `sent_today` is a real view even though sending is blocked — it reads 0. */
export type MailView =
  | 'triage'
  | 'approve'
  | 'drafting'
  | 'escalate'
  | 'snoozed'
  | 'handled'
  | 'handoff'
  | 'sent_today';

export type MailCounts = Record<MailView, number>;

/**
 * Why a list is empty. The UI must never render "inbox zero" copy for a filtered view —
 * "Needs approval, filtered to hello@" being empty is a data reason, not an achievement.
 */
export type MailEmptyReason =
  | 'no_threads_at_all'      // nothing has ever synced
  | 'view_empty'             // this status has no threads
  | 'filter_empty'           // this status has threads, but not in the active mailbox filter
  | 'search_empty'
  // Never synced AT ALL — read from the persisted account.last_synced_at, not
  // from session state. Session-scoped, this contradicted the sidebar's
  // "Last synced 14:32" on every relaunch of an empty mailbox.
  | 'not_synced_yet';

/**
 * Thrown by every action that would put mail on the wire. `.message` is exactly
 * "Sending requires the Workers Paid plan" — render it verbatim, do not soften it.
 */
export class MailSendBlockedError extends Error {}
