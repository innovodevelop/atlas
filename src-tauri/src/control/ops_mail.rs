// Mail reads — both served from the LOCAL mirror, not from the network.
//
// WHY NOT mail_sync / mail_thread_fetch, WHICH IS WHAT YOU MIGHT EXPECT
// Two independent reasons, and either one alone would be enough:
//
// 1. NEITHER RETURNS ANY MAIL. `mail_sync` returns counters
//    ({threadsSeen, threadsInserted, rulesApplied, …}) and `mail_thread_fetch`
//    returns {messagesInserted, messagesUpdated, attachments}. The threads and
//    the message bodies go into SQLite; the return value is a sync report. An
//    op that called either would hand the model a set of numbers and no mail.
//
// 2. NEITHER IS A READ. `mail_sync` opens a write transaction over
//    mail_accounts/mail_threads/mail_audit_events and then runs the autonomy
//    rules, which call the worker to MOVE threads between statuses — that is
//    actuation, performed on the user's mailbox, and this milestone ships no
//    actuation. `mail_thread_fetch` upserts mail_messages and overwrites
//    mail_threads.status from the server.
//
// So the read form of both is the mirror those two commands maintain, which the
// UI and the scheduler already keep current. The consequence is honest and
// worth stating plainly: these ops see mail as of the last sync. They cannot
// pull new mail, and this milestone gives the brain no way to.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::ops_db;
use crate::control::Ctx;

pub fn list_threads(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    ops_db::read(app, "mail_threads", args, ctx, &[])
}

/// One thread's header plus its messages' senders, subjects and snippets.
///
/// Bodies are NOT returned. They live in `mail_messages.extracted`, they are
/// unbounded, and they are written by whoever emailed the user — putting that
/// text in a model's context is the textbook prompt-injection path, and it is
/// also the single largest cache-busting payload in the app. The snippet is
/// enough to say what a thread is about, which is what a triage assistant is
/// for. A body-reading op is a separate decision with its own review.
pub fn read_thread(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let thread_id = args
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "mail.read_thread needs a 'thread_id'".to_string())?;

    // Resolve the thread first, scoped to the Ctx user. A thread belonging to
    // another account is indistinguishable from one that does not exist.
    let thread = ops_db::read_one(app, "mail_threads", thread_id, ctx)?
        .ok_or_else(|| "no such thread in the local mail store".to_string())?;

    // `args` is deliberately not forwarded: the caller does not get to widen
    // this into a general mail_messages query with its own filters. The only
    // thing it may vary is how many messages come back.
    let message_args = json!({ "limit": args.get("limit").cloned().unwrap_or(json!(50)) });
    let messages = ops_db::read(
        app,
        "mail_messages",
        &message_args,
        ctx,
        &[("thread_id", Value::String(thread_id.to_string()))],
    )?;

    Ok(json!({ "thread": thread, "messages": messages }))
}
