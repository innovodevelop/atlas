// Archive at the provider, for the mailboxes the user connected (Gmail,
// Outlook, IMAP) — the Mail screen's Archive action on a connected-mailbox
// message, and its Undo.
//
// WHAT CHANGES WHERE. The provider first: Gmail drops the message's INBOX
// label (gmail::set_in_inbox), Outlook moves it to the Archive folder
// (outlook::move_message), IMAP moves it to the server's Archive folder
// (mail_imap::archive_message). Only once the provider has done it does Atlas
// write its own row (mail_archived_messages), which is what the Archive lane
// lists. Undo runs the same way backwards. Nothing is deleted anywhere, and the
// request goes from this Mac straight to the provider; no Atlas server sees it.
//
// WHEN IT CANNOT. The connectors sign in read-only, so a Gmail or Outlook grant
// made before this feature cannot archive. That is not an error: the command
// answers { ok: false, reason: "reconnect" } and Mail offers "Reconnect
// <account> to archive", a sign-in that asks the provider for the one extra
// permission. An IMAP server without an Archive folder answers "no_folder";
// Atlas does not create folders in someone's mailbox.
//
// The admin mailbox (mail.rs, the atlas-mail worker) is not handled here: its
// threads archive through the worker's status route, from the webview.

use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::db::DbState;

/// Why a provider did not archive (or un-archive) a message.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// The stored grant cannot change mail (or is gone): reconnect with
    /// archiving allowed.
    NeedsScope,
    /// An IMAP server with no Archive folder.
    NoArchiveFolder,
    /// The message is no longer where Atlas left it.
    Gone,
    /// Anything else, as a sentence the UI can show.
    Failed(String),
}

/// One URL path segment, percent-encoded: provider message ids are opaque and
/// must not be able to add a path or a query to the request.
pub(crate) fn path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A connected-mailbox message as the archive needs it.
#[derive(Debug, PartialEq)]
struct Target {
    account_id: String,
    provider: String,
    email: String,
    provider_message_id: String,
    /// The Message-ID header, which IMAP Undo searches by.
    message_id: Option<String>,
    /// The IMAP folder it was archived to.
    folder: Option<String>,
    archived: bool,
}

/// A mailbox the user connected, as opposed to the admin mailbox mail.rs
/// syncs, which is also provider 'imap' (ids "cfmail:…" or a bare address).
fn is_user_mailbox(provider: &str, account_id: &str) -> bool {
    provider == "gmail" || provider == "outlook" || (provider == "imap" && account_id.starts_with("imap:"))
}

fn load_target(conn: &rusqlite::Connection, user_id: &str, message_id: &str) -> Result<Target, String> {
    type Row = (String, String, String, String, String, String, Option<String>, bool);
    let row: Option<Row> = conn
        .query_row(
            "SELECT m.account_id, a.provider, a.email_address, a.user_id, m.provider_message_id, m.extracted,
                    x.folder, x.message_id IS NOT NULL
               FROM mail_messages m
               JOIN mail_accounts a ON a.id = m.account_id
               LEFT JOIN mail_archived_messages x ON x.message_id = m.id
              WHERE m.id = ?1",
            [message_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (account_id, provider, email, owner, provider_message_id, extracted, folder, archived) =
        row.ok_or("That message is no longer stored on this Mac.")?;
    if owner != user_id {
        return Err("That message belongs to another Atlas user.".to_string());
    }
    if !is_user_mailbox(&provider, &account_id) {
        return Err("Atlas archives only the mailboxes you connected in Settings.".to_string());
    }
    let message_id = serde_json::from_str::<Value>(&extracted)
        .ok()
        .and_then(|v| v["message_id"].as_str().map(str::to_string));
    Ok(Target { account_id, provider, email, provider_message_id, message_id, folder, archived })
}

/// Atlas's own record, written after the provider confirmed the move.
fn record(
    conn: &rusqlite::Connection,
    user_id: &str,
    message_id: &str,
    t: &Target,
    archive: bool,
    folder: Option<&str>,
    new_provider_id: Option<&str>,
) -> Result<(), String> {
    if archive {
        conn.execute(
            "INSERT OR REPLACE INTO mail_archived_messages (message_id, user_id, account_id, folder)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![message_id, user_id, t.account_id, folder],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute("DELETE FROM mail_archived_messages WHERE message_id = ?1", [message_id])
            .map_err(|e| e.to_string())?;
        if let Some(id) = new_provider_id {
            conn.execute(
                "UPDATE mail_messages SET provider_message_id = ?1 WHERE id = ?2",
                rusqlite::params![id, message_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Archive one connected-mailbox message (`archive` true) or move it back to
/// the inbox (false). Never holds the DB lock across the network.
#[tauri::command(async)]
pub fn mail_archive_message(
    app: AppHandle,
    db: State<'_, DbState>,
    user_id: String,
    message_id: String,
    archive: bool,
) -> Result<Value, String> {
    let t = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        load_target(&conn, &user_id, &message_id)?
    };
    if t.archived == archive {
        return Ok(json!({ "ok": true, "unchanged": true }));
    }

    let moved: Result<(Option<String>, Option<String>), Refusal> = match t.provider.as_str() {
        "gmail" => crate::gmail::set_in_inbox(&t.account_id, &t.provider_message_id, !archive).map(|_| (None, None)),
        "outlook" => crate::outlook::move_message(&t.account_id, &t.provider_message_id, archive).map(|_| (None, None)),
        _ if archive => crate::mail_imap::archive_message(&t.account_id, &t.provider_message_id).map(|f| (Some(f), None)),
        _ => crate::mail_imap::restore_message(&t.account_id, t.folder.as_deref(), t.message_id.as_deref())
            .map(|id| (None, Some(id))),
    };

    let refused = |reason: &str| -> Result<Value, String> {
        Ok(json!({ "ok": false, "reason": reason, "provider": t.provider, "email": t.email, "accountId": t.account_id }))
    };
    match moved {
        Ok((folder, new_id)) => {
            {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                record(&conn, &user_id, &message_id, &t, archive, folder.as_deref(), new_id.as_deref())?;
            }
            let _ = app.emit("db:changed", json!({ "table": "mail_archived_messages", "op": "update" }));
            Ok(json!({ "ok": true, "folder": folder }))
        }
        Err(Refusal::NeedsScope) => refused("reconnect"),
        Err(Refusal::NoArchiveFolder) => refused("no_folder"),
        Err(Refusal::Gone) => refused("gone"),
        Err(Refusal::Failed(e)) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(include_str!("db_schema.sql")).unwrap();
        for (id, provider) in [("gmail:u1:me@x.dk", "gmail"), ("cfmail:u1:contact@x.dk", "imap"), ("imap:u1:me@y.dk", "imap")] {
            conn.execute(
                "INSERT INTO mail_accounts (id, user_id, provider, email_address) VALUES (?1, 'u1', ?2, ?1)",
                rusqlite::params![id, provider],
            )
            .unwrap();
        }
        for (id, account) in [("m1", "gmail:u1:me@x.dk"), ("m2", "cfmail:u1:contact@x.dk"), ("m3", "imap:u1:me@y.dk")] {
            conn.execute(
                "INSERT INTO mail_messages (id, user_id, account_id, provider_message_id, extracted)
                 VALUES (?1, 'u1', ?2, ?1, '{\"message_id\":\"<a@b>\"}')",
                rusqlite::params![id, account],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn ids_cannot_escape_their_path_segment() {
        assert_eq!(path_segment("AAMkAD-_.~"), "AAMkAD-_.~");
        assert_eq!(path_segment("a/b?c=d"), "a%2Fb%3Fc%3Dd");
    }

    #[test]
    fn only_the_owners_connected_mailboxes_can_archive() {
        let conn = db();
        let t = load_target(&conn, "u1", "m3").unwrap();
        assert_eq!((t.provider.as_str(), t.message_id.as_deref(), t.archived), ("imap", Some("<a@b>"), false));
        assert!(load_target(&conn, "u1", "m2").is_err(), "the admin mailbox");
        assert!(load_target(&conn, "u2", "m1").is_err(), "another user");
        assert!(load_target(&conn, "u1", "nope").is_err());
    }

    #[test]
    fn the_record_follows_the_provider_and_undo_renames_an_imap_message() {
        let conn = db();
        let t = load_target(&conn, "u1", "m3").unwrap();
        record(&conn, "u1", "m3", &t, true, Some("Archive"), None).unwrap();
        let t = load_target(&conn, "u1", "m3").unwrap();
        assert!(t.archived);
        assert_eq!(t.folder.as_deref(), Some("Archive"));
        record(&conn, "u1", "m3", &t, false, None, Some("42:99")).unwrap();
        let t = load_target(&conn, "u1", "m3").unwrap();
        assert!(!t.archived);
        assert_eq!(t.provider_message_id, "42:99");
        // Disconnecting forgets the record with the message.
        record(&conn, "u1", "m1", &load_target(&conn, "u1", "m1").unwrap(), true, None, None).unwrap();
        conn.execute("DELETE FROM mail_accounts WHERE id = 'gmail:u1:me@x.dk'", []).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM mail_archived_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }
}
