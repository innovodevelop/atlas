# Atlas Mail — parallel build contract (Stages 6B / 6C / 6D)

Date: 2026-07-27
Supersedes nothing. Binding on implementers I1–I5 working simultaneously.
Where the design handoff (`Atlas Mail.dc.html`) and the audit
(`docs/design-sync/2026-07-26-audit-sphere-mail-header.md`) disagree, **the audit wins**.

This document is the only thing the five implementers share. If you need a name, a shape or a
boundary that is not written here, do not invent one — pick the option this document says is
"implementer judgement" and leave a `// CONTRACT-GAP:` comment naming the decision you took.

---

## 0. Non-negotiables (all implementers)

1. **Sending is blocked.** Cloudflare Email Sending requires the Workers Paid plan, which is not
   purchased. Build the whole approve-and-send path, then fail loudly at the last hop with the
   exact string `Sending requires the Workers Paid plan`. No UI copy, tooltip, toast or code
   comment may claim mail can be sent today.
2. **No fabricated data.** `confidence 0.94` and "matched 214 prior answers" have no source —
   omit them. Show the fact pills (what the decision matched on) instead.
3. **Empty states distinguish inbox-zero from filter-empty.** An empty *filtered* view is a data
   reason, never an achievement. See §7.
4. **Autonomy defaults to `approve_all`.** `autonomous` is only ever reached by explicit user
   choice on that mailbox. Never inherit, never default, never bulk-apply.
5. **The audit trail is LOCAL and append-only.** Copy says **"Logged on this Mac"**. Never
   "Atlas keeps the record". `mail_audit_events` accepts INSERT only — `trg_mail_audit_no_update`
   / `trg_mail_audit_no_delete` RAISE(ABORT) on UPDATE/DELETE and will fail the whole transaction.
6. Never run `cargo update` (vergen 9.0.6 / vergen-gitcl 1.0.5 are pinned transitively).
   Bun only — `bun`, `bunx`; no node/npm/pnpm. No secrets in code. Do not `git commit`/`git push`.
7. Comments explain **why**, not what — match the surrounding style.

---

## 1. File ownership map (exclusive)

No file appears twice. **Touching a file you do not own is a merge conflict by definition** — if
you need a change in someone else's file, write it in your own file behind the seam this contract
defines, and note it in your summary.

| Owner | Owns (exclusive) |
|---|---|
| **I1** — worker size cap | `/Users/magnuspilegaard/Desktop/Vibe Coding Projects/atlas-mail/src/**` (separate repo) — and nothing in helloatlas |
| **I2** — Rust bridge | `/Users/magnuspilegaard/Desktop/Vibe Coding Projects/helloatlas/src-tauri/src/mail.rs` (new) + the minimal `src-tauri/src/lib.rs` edit that registers it (`mod mail;` + the `mail::*` entries in `generate_handler!`) |
| **I3** — types + hook | `/Users/magnuspilegaard/Desktop/Vibe Coding Projects/helloatlas/src/types/mail.ts` (new), `/Users/magnuspilegaard/Desktop/Vibe Coding Projects/helloatlas/src/hooks/useAtlasMail.ts` (new), and the `MAIL_FNS` edit in `src/integrations/local/localClient.ts` |
| **I4** — shell UI | `/Users/magnuspilegaard/Desktop/Vibe Coding Projects/helloatlas/src/pages/atlas/AtlasMail.tsx` (new), `/Users/magnuspilegaard/Desktop/Vibe Coding Projects/helloatlas/src/components/atlas-ui/mail/**` **except the two I5 files named below**, the `/mail` route in `src/App.tsx`, the dock entry in `src/pages/atlas/AtlasDashboard.tsx`, and **all** edits to `src/styles/workshop.css` |
| **I5** — drafting + rules | `/Users/magnuspilegaard/Desktop/Vibe Coding Projects/helloatlas/services/atlas-brain/src/mailDraft.ts` (new) + its route registration in `services/atlas-brain/src/index.ts`, the new stylesheet `/Users/magnuspilegaard/Desktop/Vibe Coding Projects/helloatlas/src/styles/mail.css`, and exactly two components: `src/components/atlas-ui/mail/MailDraftComposer.tsx` and `src/components/atlas-ui/mail/MailRulesEditor.tsx` |

Explicit **must not touch** list, so nobody has to infer it:

- **I1**: nothing under `helloatlas/`. Not the schema, not the types.
- **I2**: no TypeScript at all. No `db_schema.sql`. No other Rust module than `mail.rs` + the two
  lines in `lib.rs`.
- **I3**: no `.tsx`. No CSS. No Rust. No file in `components/atlas-ui/mail/`.
- **I4**: no `src/hooks/**`, no `src/types/**`, no `services/atlas-brain/**`, no `src/styles/mail.css`,
  no `src-tauri/**`, and not the two I5 components.
- **I5**: no `workshop.css`, no `AtlasMail.tsx`, no other component in `components/atlas-ui/mail/`,
  no `App.tsx`, no hook or type file.

**`src-tauri/src/db_schema.sql` is owned by NOBODY.** The mail tables already exist (see §4.1) and
this build ships **without a schema migration**. If you believe you need a column, you are wrong —
re-read §5 and put the data in an existing JSON column (`extracted`, `action_config`,
`autonomy_condition`, `detail`).

CSS seam: **I4 writes markup, I5 writes `mail.css`.** I4 may use only (a) class names already in
`workshop.css` and (b) the `mail-*` class names enumerated in §6.4. I5 must style every name in
that list. `AtlasMail.tsx` (I4) does `import '@/styles/mail.css';`.

---

## 2. TypeScript types — `src/types/mail.ts` (I3 writes verbatim; I4/I5 import)

Field names are taken from the real worker SQL and the real `atlas.db` columns. Nothing here is
invented. Where a name looks wrong (`references_`), it is correct — see the WHY comments.

```ts
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
 * Metadata only. r2_key is always null today (no R2 bucket) and there is no route that
 * returns attachment bytes — the UI shows name/type/size and nothing is clickable.
 */
export interface WorkerAttachmentRow {
  id: string;
  message_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  r2_key: string | null;
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

export interface MailCounts extends Record<MailView, number> {}

/**
 * Why a list is empty. The UI must never render "inbox zero" copy for a filtered view —
 * "Needs approval, filtered to hello@" being empty is a data reason, not an achievement.
 */
export type MailEmptyReason =
  | 'no_threads_at_all'      // nothing has ever synced
  | 'view_empty'             // this status has no threads
  | 'filter_empty'           // this status has threads, but not in the active mailbox filter
  | 'search_empty'
  | 'not_synced_yet';        // never synced in this session and no local rows

/**
 * Thrown by every action that would put mail on the wire. `.message` is exactly
 * "Sending requires the Workers Paid plan" — render it verbatim, do not soften it.
 */
export class MailSendBlockedError extends Error {}
```

**Omitted on purpose** (no data source — audit §2.2): `confidence`, `matchedPriorAnswers`,
`draftAlt` (the hardcoded alternate draft), `draftingStep` copy, `sphereState`, the fixed
"14 threads since 6am" and "7 active rules" counters, and the €50k/$50k rule string. If a
number is not read from D1 or atlas.db, it does not render.

---

## 3. The hook API — `useAtlasMail()` (I3 implements; I4/I5 code against this only)

```ts
export interface UseAtlasMail {
  // ---- data ----
  account: MailAccount | null;        // the single hosted admin mailbox; null before first sync
  threads: MailThread[];              // already filtered by `view` + `mailbox` + `query`
  counts: MailCounts;                 // unfiltered per-view counts for the sidebar badges
  selectedThreadId: string | null;
  thread: MailThread | null;          // the selected thread
  messages: MailMessage[];            // for the selected thread, oldest first
  drafts: MailDraft[];                // for the selected thread, newest first
  audit: MailAuditEvent[];            // for the selected thread, newest first
  rules: MailRule[];

  // ---- view state ----
  view: MailView;
  mailbox: string | null;             // null = all mailboxes
  query: string;
  emptyReason: MailEmptyReason | null; // non-null iff `threads.length === 0`

  // ---- status ----
  loading: boolean;                   // first local read in flight
  syncing: boolean;                   // worker round-trip in flight
  error: string | null;               // last non-fatal error, already human-readable
  lastSyncedAt: string | null;
  /** Non-null while an approved send is inside its undo window. */
  pendingSend: { draftId: string; threadId: string; sendsAt: number } | null;

  // ---- view actions (synchronous, local only) ----
  setView(view: MailView): void;
  setMailbox(mailbox: string | null): void;
  setQuery(query: string): void;
  selectThread(threadId: string | null): void;
  /** Keyboard nav: moves the selection within the current filtered list. Safe at the ends. */
  selectRelative(delta: 1 | -1): void;

  // ---- thread actions (async; all write one mail_audit_events row) ----
  sync(): Promise<void>;
  markRead(threadId: string): Promise<void>;
  setStatus(threadId: string, status: MailThreadStatus): Promise<void>;
  /** `until` MUST be a full ISO-8601 string with offset, computed in the user's tz. */
  snooze(threadId: string, until: string): Promise<void>;

  // ---- draft actions ----
  /** Asks the brain for a draft. Creates a mail_drafts row in state 'proposed'. */
  draft(threadId: string, opts?: { instruction?: string; tone?: string }): Promise<MailDraft>;
  /** Local edit — no AI call. */
  saveDraft(draftId: string, body: string): Promise<MailDraft>;
  /** Re-asks the brain with an instruction. Returns a NEW 'proposed' draft; the old one is discarded. */
  reviseDraft(draftId: string, instruction: string): Promise<MailDraft>;
  discardDraft(draftId: string): Promise<void>;
  /** `sendAt` is ISO-8601 with offset. Sets state 'scheduled'. */
  scheduleDraft(draftId: string, sendAt: string): Promise<MailDraft>;

  // ---- the blocked path ----
  /**
   * Starts the undo window (see UNDO_SEND_MS). Resolves as soon as the window opens —
   * it does NOT resolve when mail leaves, because mail cannot leave today.
   */
  approveAndSend(draftId: string): Promise<void>;
  /** Cancels a pending send. No-op if the window already elapsed. */
  undoSend(): Promise<void>;
  /**
   * Fires automatically when the undo window elapses; exposed for tests.
   * ALWAYS rejects with MailSendBlockedError today. Callers must catch it and surface
   * `err.message` verbatim. It writes a SEND_BLOCKED audit row before rejecting.
   */
  sendNow(draftId: string): Promise<never>;

  // ---- rules ----
  saveRule(rule: Omit<MailRule, 'id'> & { id?: string }): Promise<MailRule>;
  deleteRule(ruleId: string): Promise<void>;
  reorderRules(orderedIds: string[]): Promise<void>;

  // ---- autonomy ----
  /**
   * Changing to 'autonomous' requires `confirmed: true`; the hook rejects otherwise.
   * An agent sending mail unsupervised is the highest-risk behaviour in the product,
   * so the guard lives in the hook, not only in the UI.
   */
  setAutonomy(accountId: string, mode: MailAutonomyMode, opts?: { confirmed?: boolean }): Promise<void>;
}

export const UNDO_SEND_MS = 8000;

export function useAtlasMail(): UseAtlasMail;
```

Contract notes binding on I3:

- Every async action is **optimistic-local-then-remote**: write atlas.db first (so the UI is
  instant and works offline), then call the worker; on worker failure, revert the local row and
  set `error`. Only `sendNow` has no local success state.
- Every async action appends exactly **one** `mail_audit_events` row, INSERT only, with
  `actor` = `'user'` for direct user actions, `'atlas'` for hook-initiated ones (sync, autofiled),
  `'rule'` when a rule fired (`rule_id` set). `model`/`prompt_version` are set only on
  `drafted`/`draft_revised`.
- `snooze` and `scheduleDraft` store the caller's offset-bearing ISO string unchanged. The hook
  must never call `toISOString()` on a locally-constructed date without applying the offset, and
  must never compare snooze/schedule times using UTC midnight. "Today" for `sent_today` is the
  user's local midnight, obtained via `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- `MAIL_FNS` edit: delete the `MAIL_FNS` short-circuit from `localClient.ts`. Those three legacy
  edge-function names (`mail-oauth-start`, `mail-sync`, `mail-disconnect`) belong to the abandoned
  consumer-mailbox path and have no replacement; the hook calls Tauri commands directly via
  `invoke` (see §4) and never goes through `functions.invoke`. Do **not** add mail entries to
  `LOCAL_FN`.
- Realtime: subscribe with `localClient.channel('mail').on('postgres_changes', { table: 'mail_threads' }, …)`
  and refetch. I2's commands emit `db:changed`, so this works without polling.
- Outside Tauri (browser dev), every remote action rejects with
  `Atlas Mail is only available in the desktop app.` and local reads return empty. Do not fake data.

---

## 4. Rust commands — `src-tauri/src/mail.rs` (I2 implements; I3 calls)

### 4.1 Ground rules

- The mail tables already exist in `db_schema.sql` (`mail_accounts`, `mail_messages`,
  `mail_threads`, `mail_rules`, `mail_drafts`, `mail_audit_events`). **No schema change.**
- Generic CRUD (`db_select`/`db_insert`/`db_update`/`db_delete` in `db.rs`) is a table+column
  passthrough and already emits `db:changed`. I3 uses it via `localClient.from('mail_*')` for all
  plain reads and writes. `mail.rs` exists only for what CRUD cannot do: talking to the worker and
  performing the idempotent multi-row upsert of §5.
- Every mutating command in `mail.rs` must `app.emit("db:changed", json!({"table": …, "op": …}))`
  for each table it touched, exactly as `db.rs` does — otherwise the UI will not refresh.
- HTTP with `ureq`, same as `datafetch.rs`. Base URL constant with an env override:
  `const MAIL_API: &str = "https://atlas-mail.magnus-d7d.workers.dev";`,
  overridable by `ATLAS_MAIL_API` for local `wrangler dev`.
- The worker authenticates with the **user's Cloudflare JWT** as `Authorization: Bearer <token>`
  (HS256, verified worker-side, admin-allowlisted). The frontend already holds it via
  `getToken()`; it is passed in on every call. Do **not** read it from the Keychain, and do not
  confuse it with the brain's `x-sidecar-token`.
- Tauri v2 maps camelCase JS args to snake_case Rust params. Rust params below are snake_case;
  the JS column shows what I3 passes.
- Errors: return `Err(String)` with a sentence a human can read. Map worker statuses:
  `401 → "Your Atlas session is not authorised for this mailbox."`,
  `404 → "That thread no longer exists on the server."`,
  anything else → `"Atlas Mail server error (<status>)."`. Never surface a raw JSON body.

### 4.2 The account row

`mail_threads.account_id` is NOT NULL and references `mail_accounts`. The hosted admin mailbox has
no row yet, so `mail_sync` creates one on first run, idempotently:

- `id` = `"cfmail:" + mailbox` (deterministic, so a re-sync finds the same row)
- `provider` = `'imap'` — the CHECK constraint allows only gmail/outlook/imap and this build ships
  no schema migration; `'imap'` is the closest honest value for a mailbox Atlas reads over a
  server API. Comment the WHY in `mail.rs`.
- `autonomy_mode` = `'approve_all'` (the column default — do not pass a value)
- `email_address` = the mailbox, `status` = `'active'`, `last_synced_at` = sync completion time.

### 4.3 Commands

All return `Result<serde_json::Value, String>`.

| Command | Rust params | JS args | Returns |
|---|---|---|---|
| `mail_sync` | `token: String, user_id: String, limit: Option<u32>` | `{ token, userId, limit? }` | see below |
| `mail_thread_fetch` | `token: String, user_id: String, thread_id: String` | `{ token, userId, threadId }` | see below |
| `mail_mark_read` | `token: String, user_id: String, thread_id: String` | `{ token, userId, threadId }` | `{ "ok": true }` |
| `mail_set_status` | `token: String, user_id: String, thread_id: String, status: String` | `{ token, userId, threadId, status }` | `{ "ok": true, "status": "approve" }` |
| `mail_send_reply` | `token: String, user_id: String, thread_id: String, text: String, html: Option<String>` | `{ token, userId, threadId, text, html? }` | **always `Err`** |
| `mail_ingest_errors` | `token: String` | `{ token }` | `{ "errors": [ … ] }` |

`thread_id` in every command above is the **local** `mail_threads.id`; `mail.rs` resolves it to
`provider_thread_id` before hitting the worker. Reject a `thread_id` it cannot resolve with
`"That thread is not in the local store — sync first."`.

`mail_sync` returns:

```json
{
  "accountId": "cfmail:contact@helloatlas.dk",
  "mailbox": "contact@helloatlas.dk",
  "threadsSeen": 42,
  "threadsInserted": 3,
  "threadsUpdated": 39,
  "messagesInserted": 7,
  "lastSyncedAt": "2026-07-27T09:14:02Z",
  "warnings": ["1 thread skipped: malformed participants"]
}
```

`mail_thread_fetch` returns, after upserting the messages locally:

```json
{
  "threadId": "<local mail_threads.id>",
  "messagesInserted": 2,
  "messagesUpdated": 5,
  "attachments": [
    { "messageId": "<worker msg id>", "filename": "invoice.pdf", "mimeType": "application/pdf", "sizeBytes": 18422 }
  ]
}
```

Attachment rows are **not** persisted to a table (there is none) — they go into the owning
message's `extracted.attachments` JSON, and `has_attachments` is set to 1. `r2_key` is always null
and there is no byte-fetch route, so the UI shows metadata and nothing is downloadable.

`mail_send_reply` **must not** call the worker's `POST /api/threads/:id/reply`. That route has no
try/catch around `env.EMAIL.send` and will throw an unhandled exception on the current plan, which
surfaces as an opaque connection-level failure. Instead the command returns, unconditionally and
as its first statement:

```rust
// Cloudflare Email Sending needs the Workers Paid plan, which is not purchased. Calling the
// worker's /reply route here would hit an unguarded env.EMAIL.send and come back as an opaque
// 500 — a legible refusal is the honest failure mode until the plan is bought.
Err("Sending requires the Workers Paid plan".into())
```

Before returning, it inserts one `mail_audit_events` row with `actor='atlas'`,
`action='send_blocked'`, `detail='Workers Paid plan not active'`.

### 4.4 `lib.rs` edit (the only one I2 makes there)

`mod mail;` alongside the other module declarations, and inside the existing
`tauri::generate_handler![...]` block:

```
mail::mail_sync,
mail::mail_thread_fetch,
mail::mail_mark_read,
mail::mail_set_status,
mail::mail_send_reply,
mail::mail_ingest_errors,
```

No `.manage(...)` — `mail.rs` holds no shared state; it opens the db the same way `db.rs` does.

---

## 5. Sync model — worker rows → atlas.db rows

**Idempotency is the whole point.** A re-sync must not duplicate a thread, duplicate a message, or
change an unread count that did not change on the server.

### 5.1 Conflict keys

| Local table | Conflict key (already UNIQUE in the schema) | Value from the worker |
|---|---|---|
| `mail_accounts` | `UNIQUE(user_id, provider, email_address)` | `('<user>', 'imap', mailbox)`; id is `cfmail:<mailbox>` |
| `mail_threads` | `UNIQUE(account_id, provider_thread_id)` | `provider_thread_id` = worker `mail_threads.id` (the UUID) |
| `mail_messages` | `UNIQUE(account_id, provider_message_id)` | `provider_message_id` = worker `mail_messages.id` (row id, **not** the RFC 2822 `message_id`) |

Use `provider_message_id` = the worker's row id, not the header Message-ID: the header is nullable
in D1 (outbound rows insert it as NULL) and a NULL key cannot be a conflict key.

Local `mail_threads.id` / `mail_messages.id` are freshly minted UUIDs on first insert and **never
regenerated**. Look up by the conflict key, insert if absent, update if present.

### 5.2 Field mapping

`mail_threads` ← worker thread row:

| local | ← worker | note |
|---|---|---|
| `provider_thread_id` | `id` | conflict key |
| `subject` | `subject` | |
| `participants` | `participants` | already a JSON string on both sides — copy verbatim, do not re-encode |
| `status` | `status` | same enum on both sides; the server is authoritative |
| `unread_count` | `unread_count` | **assigned, never incremented** — this is what stops double-counting |
| `last_message_at` | `last_message_at` | |
| `snoozed_until`, `handled_at` | same-named columns (detail fetch only) | list projection omits them; leave untouched on a list sync |
| `updated_at` | sync time | |

`mail_messages` ← worker message row:

| local | ← worker |
|---|---|
| `provider_message_id` | `id` |
| `from_address` | `from_address` |
| `subject` | `subject` |
| `snippet` | first 200 chars of `body_text`, whitespace-collapsed (worker sends no snippet) |
| `received_at` | `sent_at` |
| `has_attachments` | 1 if the detail response has any attachment for this message |
| `extracted` | JSON: `direction`, `to_address`, `body_text`, `body_html`, `message_id`, `truncated`, `attachments` |
| `category` | leave at the `'other'` default — nothing classifies mail yet, so do not guess |
| `importance` | leave at 0 for the same reason |

### 5.3 Ordering and failure

1. Upsert the account.
2. `GET /api/threads?limit=200`, upsert every thread in one transaction.
3. For the selected thread only, `GET /api/threads/:id` and upsert its messages. **Do not
   fan out** a detail fetch per thread on a list sync — 200 requests on every refresh is the
   behaviour the perf review exists to prevent.
4. Insert exactly one audit row for the sync: `actor='atlas'`, `action='sync'`,
   `detail='<n> threads, <m> new messages'`, `thread_id=NULL`.
5. A per-thread failure is collected into `warnings[]` and the sync continues. A failure of step 2
   aborts the transaction and returns `Err` — a partial thread list would silently look like mail
   had disappeared.

### 5.4 Direction of truth

The worker's D1 is authoritative for `status`, `unread_count`, `last_message_at` and message
bodies. atlas.db is authoritative — and the *only* store — for drafts, rules, autonomy and the
audit trail. A local status change writes locally first, then `POST /api/threads/:id/status`; if
that POST fails the local row is reverted, because a status the server does not know about will be
overwritten by the next sync and the user would watch their action undo itself minutes later.

Implicit server-side transitions to account for (they will arrive as ordinary sync updates, not as
events): an inbound reply to a `handled` or `snooze` thread flips it back to `triage`, and the
reply route sets `handled`. Never assume the local status survives a sync.

---

## 6. Component boundary — I4 ⟷ I5

### 6.1 I4 owns

`src/pages/atlas/AtlasMail.tsx` — the route component. Calls `useAtlasMail()` **once** and passes
slices down; no child calls the hook itself.

In `src/components/atlas-ui/mail/`:

- `MailShell.tsx` — three-pane grid (sidebar / thread list / reading pane) + responsive collapse
- `MailSidebar.tsx` — the 8 views, counts, mailbox filter
- `MailThreadList.tsx` — virtualised list (see §6.5)
- `MailThreadRow.tsx`
- `MailReadingPane.tsx` — header actions, message thread, attachment metadata, mounts I5's composer
- `MailEmptyState.tsx`
- `MailAuditTrail.tsx` — collapsible "Logged on this Mac" timeline
- `MailStatusChip.tsx`

### 6.2 I5 owns

- `MailDraftComposer.tsx`
- `MailRulesEditor.tsx`
- `services/atlas-brain/src/mailDraft.ts` + its one-line registration in the brain's `index.ts`
- `src/styles/mail.css`

### 6.3 Exact props (both sides code against these; neither may change them)

```tsx
// I4 → renders <MailDraftComposer/> inside MailReadingPane
export interface MailDraftComposerProps {
  threadId: string;
  drafts: MailDraft[];                 // newest first; [] means none yet
  /** Non-null while an approved send sits in its undo window. */
  pendingSend: { draftId: string; threadId: string; sendsAt: number } | null;
  busy: boolean;
  /** Pass-throughs from useAtlasMail — identical signatures, do not wrap. */
  onDraft: (opts?: { instruction?: string; tone?: string }) => Promise<MailDraft>;
  onSave: (draftId: string, body: string) => Promise<MailDraft>;
  onRevise: (draftId: string, instruction: string) => Promise<MailDraft>;
  onDiscard: (draftId: string) => Promise<void>;
  onSchedule: (draftId: string, sendAt: string) => Promise<MailDraft>;
  onApproveAndSend: (draftId: string) => Promise<void>;
  onUndoSend: () => Promise<void>;
  /** Fact pills: what the decision matched on. Empty array renders no pill strip. */
  matchedOn: Array<{ label: string; value: string }>;
}

// I4 → renders <MailRulesEditor/> in a panel it owns (route-level, not per-thread)
export interface MailRulesEditorProps {
  rules: MailRule[];
  accounts: MailAccount[];
  busy: boolean;
  onSave: (rule: Omit<MailRule, 'id'> & { id?: string }) => Promise<MailRule>;
  onDelete: (ruleId: string) => Promise<void>;
  onReorder: (orderedIds: string[]) => Promise<void>;
  onSetAutonomy: (accountId: string, mode: MailAutonomyMode, opts?: { confirmed?: boolean }) => Promise<void>;
  onClose: () => void;
}
```

I5's components import types from `@/types/mail` only. They must not import `useAtlasMail`, must
not call `invoke`, and must not fetch. Everything they need arrives as a prop — that is what lets
I4 and I5 land independently.

`matchedOn` replaces the design's fabricated confidence score. I4 builds it from real data only:
the rule label that fired (from the thread's most recent `rule_matched` audit row), the sender
domain, the mailbox, and whether attachments are present. If none of those exist, pass `[]` — do
not fill the strip.

### 6.4 CSS class contract

I4 writes these class names; I5 styles all of them in `mail.css`. Neither side invents a `mail-*`
name that is not on this list without adding it here first.

```
mail-shell  mail-shell-sidebar  mail-shell-list  mail-shell-pane  mail-shell-collapsed
mail-side  mail-side-group  mail-side-item  mail-side-item-active  mail-side-count  mail-side-filter
mail-list  mail-list-viewport  mail-list-row  mail-list-row-active  mail-list-row-unread
mail-row-bar  mail-row-head  mail-row-from  mail-row-time  mail-row-subject  mail-row-snippet  mail-row-meta
mail-pane  mail-pane-head  mail-pane-actions  mail-pane-body  mail-msg  mail-msg-head  mail-msg-body
mail-msg-truncated  mail-attach  mail-attach-item
mail-chip  mail-chip-triage  mail-chip-approve  mail-chip-drafting  mail-chip-escalate
mail-chip-snooze  mail-chip-handled  mail-chip-handoff
mail-empty  mail-empty-title  mail-empty-body  mail-empty-action
mail-audit  mail-audit-toggle  mail-audit-item  mail-audit-actor  mail-audit-ts
mail-compose  mail-compose-body  mail-compose-actions  mail-compose-pills  mail-compose-pill
mail-compose-undo  mail-compose-blocked
mail-rules  mail-rules-row  mail-rules-form  mail-rules-autonomy  mail-rules-autonomy-warn
mail-danger  mail-muted  mail-kbd
mail-route
mail-notices  mail-notice  mail-notice-warn  mail-notice-error
mail-ingest-errors  mail-ingest-error
```

Added after the first build (2026-07-27): `mail-route`, the four `mail-notice*`
names, and the `mail-ingest-error*` pair. This list predated the route-level
notice surface, which did not exist when the contract was written — the error
banner originally lived inside the reading pane, where a send refusal was only
visible if a thread happened to be open. Folding the names in here rather than
leaving the `CONTRACT-GAP` comments to rot, since the whole point of §6.4 is
that neither side has to guess.

Colours: the handoff is 100% inline hex with zero custom properties, so **none of it ports
directly**. Use the existing `workshop.css` tokens — `--pg --rz --sk --wt --ink --ink2 --ink3
--bd --acc --acch --acc-text --alt --rsm --rmd --rlg --grn --red --surface --bd-soft --body
--amber --amber-text --grn-text --red-text --neutral --neutral-text --handoff --dark-card` —
and add nothing new to `workshop.css` unless a status colour genuinely has no token (I4's call;
`--handoff` already exists precisely for the handoff status). `mail.css` must reference tokens,
never raw hex.

Status → token, so both sides agree: triage `--ink2`, approve `--amber`, drafting `--acc`,
escalate `--red`, snooze `--neutral`, handled `--grn`, handoff `--handoff`.

### 6.5 Behaviour I4 must implement (audit: these are safety, not polish)

- **Virtualisation** in `MailThreadList` above 60 rows. No third-party dependency — a windowed
  slice over a fixed row height is enough and keeps the bundle flat.
- **Keyboard navigation**: `j`/`k` and `↑`/`↓` → `selectRelative`, `Enter` opens, `e` → handled,
  `a` → approve, `s` → snooze dialog, `u` → undo pending send, `/` focuses search, `Esc` clears
  selection. Ignore all of these while focus is inside an input/textarea/contenteditable.
  Render the shortcut hints with `mail-kbd`.
- **Undo send**: while `pendingSend` is non-null, show the countdown and an Undo control
  (`mail-compose-undo`). When it elapses the hook calls `sendNow`, which rejects; render
  `err.message` verbatim in `mail-compose-blocked`. Do not auto-retry.
- **Responsive collapse** is undefined in the handoff (it assumes a fixed ≥1400px shell with no
  media queries). Decision: below 1100px the sidebar becomes a top row of view pills
  (`mail-shell-collapsed`); below 820px the list and pane become two stacked full-width panes,
  with selection switching which is visible. I4 owns the details.

### 6.6 Empty-state copy (I4, verbatim)

| reason | title | body |
|---|---|---|
| `not_synced_yet` | "Not synced yet" | "Sync to load contact@helloatlas.dk." |
| `no_threads_at_all` | "No mail stored" | "Nothing has arrived at this mailbox yet." |
| `view_empty` | "Nothing in {view}" | "No threads have this status." |
| `filter_empty` | "Nothing in {view} for {mailbox}" | "Other mailboxes have threads here — clear the filter to see them." |
| `search_empty` | "No matches" | "No thread matches “{query}”." |

`filter_empty` must never render celebratory copy. The distinction between `view_empty` and
`filter_empty` comes from `counts[view] > 0` while the filtered list is empty.

---

## 7. Brain route — `POST /mail/draft` (I5)

Registered in `services/atlas-brain/src/index.ts` alongside the existing routes, following the
`createLearningHandlers` / `createProactiveHandlers` factory pattern:

```ts
import { createMailDraftHandlers } from "./mailDraft.ts";
const mailDraft = createMailDraftHandlers({ db: localDb, requireUser, json });
// …inside fetch():
if (req.method === "POST" && url.pathname === "/mail/draft") return await mailDraft.draft(req);
```

Request (from the hook, over the existing `brainPost` pattern — `Authorization: Bearer <CF JWT>`
**and** `x-sidecar-token: <brain.token>`; they are two different tokens, do not conflate them):

```json
{
  "threadId": "<local mail_threads.id>",
  "instruction": "optional user instruction",
  "tone": "optional",
  "previousDraft": "optional — present on revise"
}
```

Response:

```json
{ "body": "…", "model": "claude-…", "promptVersion": "mail-draft-v1" }
```

Errors: `{ "error": "…" }` with 400/401/500, matching the other brain routes. The route reads the
thread and its messages from the local `atlas.db` via `db` — it must not call the Cloudflare
worker, and it must not send anything. `model` and `promptVersion` are stored on the
`mail_drafts` row and echoed into the `drafted` audit event; they are the only provenance the user
gets, so they must be the real values, not constants.

Hard containment, matching `/research`: **exactly one AI pass per call.** No recursion, no
self-fetch, no follow-up questions to itself.

---

## 8. I1 — worker size cap (stage 6B), contract obligations

I1 may change anything under `atlas-mail/src/**` subject to three constraints:

1. **No existing response field may be renamed, removed or change type.** `references_` keeps its
   trailing underscore (it is a SQL reserved word), `participants` stays a JSON *string*, thread
   ids stay 36-char UUIDs (the route regex depends on it).
2. New fields are additive and optional: `truncated` (0|1) and `raw_size_bytes` on message rows,
   already declared optional in §2 so a client running against an older worker still typechecks.
3. If a body is capped, the stored `body_text` must end at a clean boundary and `truncated` must be
   1. Never silently drop a message: an oversized message that cannot be stored goes to
   `mail_ingest_errors`, which is what that table is for.

I1 does not touch the reply route's send call. Sending stays blocked and stays unguarded-looking
in that route only because §4.3 forbids anyone from calling it.

---

## 9. Decisions this contract makes (so nobody re-litigates them mid-build)

- Mail is a **full route** `/mail`, not the existing dashboard `expanded === 'email'` overlay.
  The overlay and `AtlasInboxCard` stay as they are; I4 adds a dock button (`Mail` icon) that
  `navigate('/mail')`, above the catch-all route in `App.tsx`.
- The hosted mailbox is stored as `provider = 'imap'` to avoid a schema migration nobody owns.
- `provider_message_id` is the worker's row id, not the RFC 2822 Message-ID.
- `unread_count` is assigned from the server, never incremented locally.
- Attachments are metadata inside `extracted`, with no table and no download affordance.
- `sent_today` remains a view; it will read 0 until the Workers Paid plan exists, and its empty
  state is a filter reason, not a celebration.
- No schema migration ships with this work.

## 10. Where an implementer still has to use judgement

- **I2**: the exact SQL for the upserts (the schema has the UNIQUE constraints; whether you use
  `INSERT … ON CONFLICT DO UPDATE` or select-then-write is yours, as long as it is one transaction
  per sync and ids are stable).
- **I3**: how much state lives in React vs. re-read from atlas.db after each `db:changed`. The
  contract only fixes the returned surface.
- **I4**: the responsive breakpoints' fine detail, the virtualisation window size, and whether the
  rules editor is a route panel or a sheet.
- **I5**: the drafting prompt itself, the tone vocabulary, and the rules-editor form layout —
  subject to `MailRulePredicate` being the only predicate shape.
- **All**: if you find a field this contract names that does not exist in the real source, stop and
  report it rather than inventing a substitute.
