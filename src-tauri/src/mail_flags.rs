// Bill and deadline flags for the mailboxes the user connected (Gmail,
// Outlook, IMAP), and the notification behind Settings → Mail → Alerts,
// "Tell me about bills and deadlines".
//
// WHAT IT READS. Only what a scan already stores on this Mac: the sender, the
// subject and the provider's preview line (Gmail's snippet, Outlook's
// bodyPreview; an IMAP envelope carries no preview, so IMAP mail is judged on
// its subject alone). Nothing leaves the Mac to decide it: no model call, no
// network. That is also its limit. It is a fixed list of English and Danish
// words, not an understanding of the message, and it is tuned to stay quiet
// rather than to catch everything: a subject has to name a bill or a deadline
// outright, or the preview has to name one together with an amount or a date,
// and receipts and promotions are left alone.
//
// WHAT IT WRITES. For a flagged message: mail_messages.category ('bills' for a
// bill, 'important' for a deadline) and importance (the weights the greeting
// gives these alert types, so the Home inbox sorts them first); one row in
// mail_alerts, the store the Home inbox, the greeting and Settings already
// read; and one row in mail_alert_threads, which is what makes all of this
// happen once per thread however many reminders the thread collects.
//
// WHEN IT NOTIFIES. After every scan of any mailbox, while the user's switch is
// on (mail_prefs; no row means on, the design's default), for each flagged
// thread not yet announced: one whose due date falls within a week either side
// of today, or that names no date and arrived in the last week. More than
// MAX_NOTIFICATIONS at once collapse into a single summary, so connecting a
// mailbox for the first time cannot set off a burst. A thread flagged while
// the switch was off is announced when it is turned on only if it is still
// coming due, which is what "something due in the next 7 days" promises.
//
// A running focus session holds these like Atlas's other messages: they are
// not posted, and the Focus screen lists them when it ends (focus_mode.rs).
//
// The scan modules call `mark` before a sync and `after_sync` after a
// successful one; everything here works on the rows that sync inserted.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::db::DbState;

/// Mail older than this is not flagged at all: a first scan reaches weeks
/// back, and a month-old invoice is history, not something that needs you.
const FLAG_WINDOW_DAYS: i64 = 14;
/// The design's "due in the next 7 days", applied on both sides of today so
/// a reminder about something just overdue is still said out loud.
const NOTIFY_WINDOW_DAYS: i64 = 7;
/// Beyond this many announcements in one pass, Atlas posts one summary.
const MAX_NOTIFICATIONS: usize = 3;
/// How many freshly scanned messages one pass looks at.
const MAX_MESSAGES_PER_PASS: i64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlagKind {
    Bill,
    Deadline,
}

impl FlagKind {
    fn alert_type(self) -> &'static str {
        match self {
            FlagKind::Bill => "bill",
            FlagKind::Deadline => "deadline",
        }
    }
    fn category(self) -> &'static str {
        match self {
            FlagKind::Bill => "bills",
            FlagKind::Deadline => "important",
        }
    }
    /// Mirrors MAIL_WEIGHTS in src/lib/greetingGate.ts.
    fn importance(self) -> f64 {
        match self {
            FlagKind::Bill => 0.85,
            FlagKind::Deadline => 0.9,
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Flag {
    pub kind: FlagKind,
    pub due: Option<NaiveDate>,
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/// Whole words or phrases that name a bill. Matched on word boundaries.
const BILL_PHRASES: &[&str] = &[
    "invoice", "invoices", "your bill", "new bill", "bill is ready", "bill is due", "bill from",
    "payment due", "payment reminder", "amount due", "balance due", "payment request",
    "faktura", "fakturaen", "regning", "regningen", "opkrævning", "opkrævningen",
    "betalingspåmindelse", "rykker", "til betaling", "at betale", "forfaldsdato", "betalingsservice",
];
/// Danish writes a bill as a compound (elregning, varmeregning, momsfaktura),
/// so these also count at the end of a longer word.
const BILL_SUFFIXES: &[&str] = &["regning", "regningen", "faktura", "fakturaen", "opkrævning"];
/// Compounds that end like a bill and are not one.
const NOT_BILLS: &[&str] = &["beregning", "beregningen", "omregning", "omregningen", "genberegning"];

const DEADLINE_PHRASES: &[&str] = &[
    "deadline", "deadlines", "due by", "due on", "due date", "expires", "expiring", "expires on",
    "last day to", "respond by", "reply by", "frist", "fristen", "sidste frist", "sidste dag",
    "udløber", "senest",
];
/// ansøgningsfrist, afleveringsfrist, betalingsfrist.
const DEADLINE_SUFFIXES: &[&str] = &["frist", "fristen"];

/// A subject that says the money already moved.
const RECEIPT_PHRASES: &[&str] = &[
    "receipt", "kvittering", "kvitteringen", "payment received", "payment confirmation",
    "thank you for your payment", "thanks for your payment", "has been paid", "betaling modtaget",
    "tak for din betaling", "er betalt", "refund", "refusion", "order confirmation", "ordrebekræftelse",
];
/// A subject that is selling something; its "expires tonight" is not a deadline.
const PROMO_PHRASES: &[&str] = &[
    "sale", "udsalg", "rabat", "tilbud", "deal", "deals", "black friday", "last chance",
    "sidste chance", "newsletter", "nyhedsbrev", "webinar", "free trial", "gratis",
];
const CURRENCIES: &[&str] = &["kr", "dkk", "eur", "usd", "gbp", "sek", "nok", "kroner"];
/// A date right after one of these is the due date, not the invoice date.
const DUE_WORDS: &[&str] = &[
    "due", "by", "before", "until", "inden", "senest", "betales", "payable", "expires", "udløber",
    "deadline", "frist",
];

const MONTHS: &[(&str, u32)] = &[
    ("januar", 1), ("january", 1), ("jan", 1),
    ("februar", 2), ("february", 2), ("feb", 2),
    ("marts", 3), ("march", 3), ("mar", 3),
    ("april", 4), ("apr", 4),
    ("maj", 5), ("may", 5),
    ("juni", 6), ("june", 6), ("jun", 6),
    ("juli", 7), ("july", 7), ("jul", 7),
    ("august", 8), ("aug", 8),
    ("september", 9), ("sept", 9), ("sep", 9),
    ("oktober", 10), ("october", 10), ("okt", 10), ("oct", 10),
    ("november", 11), ("nov", 11),
    ("december", 12), ("dec", 12),
];
const MONTH_ABBR: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// One run of letters or digits, lower-cased, with its byte span in the
/// original text so the separators between two tokens can be read back.
struct Tok {
    start: usize,
    end: usize,
    text: String,
}

fn tokens(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut cur: Option<(usize, String)> = None;
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() {
            match &mut cur {
                Some((_, s)) => s.extend(c.to_lowercase()),
                None => cur = Some((i, c.to_lowercase().collect())),
            }
        } else if let Some((start, s)) = cur.take() {
            out.push(Tok { start, end: i, text: s });
        }
    }
    if let Some((start, s)) = cur {
        out.push(Tok { start, end: text.len(), text: s });
    }
    out
}

/// A text as words, for phrase and suffix matching.
struct Words {
    toks: Vec<Tok>,
    /// " w1 w2 … " so a phrase matches only on word boundaries.
    padded: String,
}

impl Words {
    fn new(text: &str) -> Self {
        let toks = tokens(text);
        let padded = format!(" {} ", toks.iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join(" "));
        Self { toks, padded }
    }
    fn has_phrase(&self, phrases: &[&str]) -> bool {
        phrases.iter().any(|p| self.padded.contains(&format!(" {p} ")))
    }
    fn has_suffix(&self, suffixes: &[&str], except: &[&str]) -> bool {
        self.toks
            .iter()
            .any(|t| suffixes.iter().any(|s| t.text.ends_with(s)) && !except.contains(&t.text.as_str()))
    }
    fn names_bill(&self) -> bool {
        self.has_phrase(BILL_PHRASES) || self.has_suffix(BILL_SUFFIXES, NOT_BILLS)
    }
    fn names_deadline(&self) -> bool {
        self.has_phrase(DEADLINE_PHRASES) || self.has_suffix(DEADLINE_SUFFIXES, &[])
    }
}

fn has_amount(raw: &str, words: &Words) -> bool {
    raw.chars().any(|c| c.is_ascii_digit())
        && (raw.contains(['€', '$', '£']) || words.toks.iter().any(|t| CURRENCIES.contains(&t.text.as_str())))
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

fn month_of(word: &str) -> Option<u32> {
    MONTHS.iter().find(|(m, _)| *m == word).map(|(_, n)| *n)
}

/// "3", "03", "3rd", "21st".
fn day_of(word: &str) -> Option<u32> {
    let digits: String = word.chars().take_while(|c| c.is_ascii_digit()).collect();
    let rest = &word[digits.len()..];
    if digits.is_empty() || digits.len() > 2 || !["", "st", "nd", "rd", "th"].contains(&rest) {
        return None;
    }
    digits.parse().ok().filter(|d| (1..=31).contains(d))
}

fn year_of(word: &str) -> Option<i32> {
    if word.len() == 4 && word.chars().all(|c| c.is_ascii_digit()) {
        word.parse().ok().filter(|y| (2000..=2100).contains(y))
    } else {
        None
    }
}

/// A date written without its year is the next one on or after the mail's own
/// date, allowing for a reminder that names a date a little in the past.
fn resolve(month: u32, day: u32, received: NaiveDate) -> Option<NaiveDate> {
    let this = NaiveDate::from_ymd_opt(received.year(), month, day)?;
    if this < received - Duration::days(60) {
        NaiveDate::from_ymd_opt(received.year() + 1, month, day)
    } else {
        Some(this)
    }
}

/// Every date the text names, with the index of the token it starts at.
fn date_candidates(text: &str, toks: &[Tok], received: NaiveDate) -> Vec<(usize, NaiveDate)> {
    let gap = |a: usize, b: usize| -> &str { &text[toks[a].end..toks[b].start] };
    let near = |a: usize, b: usize| -> bool {
        let g = gap(a, b);
        g.len() <= 3 && !g.contains('\n')
    };
    let digits = |i: usize| toks[i].text.chars().all(|c| c.is_ascii_digit());
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        // 2026-11-03 · 03.11.2026 · 3/11/26
        if i + 2 < toks.len() && digits(i) && digits(i + 1) && digits(i + 2) {
            let (g1, g2) = (gap(i, i + 1), gap(i + 1, i + 2));
            if g1.len() == 1 && g1 == g2 && [".", "/", "-"].contains(&g1) {
                let (a, b, c) = (&toks[i].text, &toks[i + 1].text, &toks[i + 2].text);
                let parsed = if a.len() == 4 {
                    NaiveDate::from_ymd_opt(a.parse().unwrap_or(0), b.parse().unwrap_or(0), c.parse().unwrap_or(0))
                } else if a.len() <= 2 && b.len() <= 2 && (c.len() == 4 || c.len() == 2) {
                    let y: i32 = c.parse().unwrap_or(0);
                    let y = if c.len() == 2 { 2000 + y } else { y };
                    NaiveDate::from_ymd_opt(y, b.parse().unwrap_or(0), a.parse().unwrap_or(0))
                } else {
                    None
                };
                if let Some(d) = parsed {
                    out.push((i, d));
                    i += 3;
                    continue;
                }
            }
        }
        // 3 November 2026 · 3. nov
        if i + 1 < toks.len() && near(i, i + 1) {
            if let (Some(day), Some(month)) = (day_of(&toks[i].text), month_of(&toks[i + 1].text)) {
                let year = (i + 2 < toks.len() && near(i + 1, i + 2)).then(|| year_of(&toks[i + 2].text)).flatten();
                let d = match year {
                    Some(y) => NaiveDate::from_ymd_opt(y, month, day),
                    None => resolve(month, day, received),
                };
                if let Some(d) = d {
                    out.push((i, d));
                    i += if year.is_some() { 3 } else { 2 };
                    continue;
                }
            }
            // November 3, 2026 · Nov 3rd
            if let (Some(month), Some(day)) = (month_of(&toks[i].text), day_of(&toks[i + 1].text)) {
                let year = (i + 2 < toks.len() && near(i + 1, i + 2)).then(|| year_of(&toks[i + 2].text)).flatten();
                let d = match year {
                    Some(y) => NaiveDate::from_ymd_opt(y, month, day),
                    None => resolve(month, day, received),
                };
                if let Some(d) = d {
                    out.push((i, d));
                    i += if year.is_some() { 3 } else { 2 };
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

fn is_due_word(word: &str) -> bool {
    DUE_WORDS.contains(&word) || word.ends_with("frist") || word.ends_with("fristen") || word.starts_with("forfald")
}

/// The due date the text names. A date right after a due word wins
/// ("betalingsfrist 03.11.2026", "due by Nov 3"); otherwise the earliest date
/// after the mail's own day, since a date on the day it was sent is almost
/// always the invoice or issue date.
pub fn due_date(text: &str, received: NaiveDate) -> Option<NaiveDate> {
    let toks = tokens(text);
    let found = date_candidates(text, &toks, received);
    let keyed = found
        .iter()
        .filter(|(at, _)| (at.saturating_sub(4)..*at).any(|k| is_due_word(&toks[k].text)))
        .map(|(_, d)| *d)
        .min();
    keyed.or_else(|| found.iter().map(|(_, d)| *d).filter(|d| *d > received).min())
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Bill, deadline or nothing, from the subject and the preview line.
pub fn classify(subject: &str, snippet: &str, received: NaiveDate) -> Option<Flag> {
    let subj = Words::new(subject);
    let snip = Words::new(snippet);
    let due = due_date(&format!("{subject}\n{snippet}"), received);
    let money = has_amount(subject, &subj) || has_amount(snippet, &snip);

    let bill = !subj.has_phrase(RECEIPT_PHRASES)
        && (subj.names_bill() || (snip.names_bill() && (money || due.is_some())));
    if bill {
        return Some(Flag { kind: FlagKind::Bill, due });
    }
    let promo = subject.contains('%') || subj.has_phrase(PROMO_PHRASES);
    let deadline = !promo && (subj.names_deadline() || (snip.names_deadline() && due.is_some()));
    if deadline {
        return Some(Flag { kind: FlagKind::Deadline, due });
    }
    None
}

/// Whether a flagged thread is announced now.
pub fn should_notify(due: Option<NaiveDate>, received: NaiveDate, today: NaiveDate) -> bool {
    let window = Duration::days(NOTIFY_WINDOW_DAYS);
    match due {
        Some(d) => d >= today - window && d <= today + window,
        None => received >= today - window,
    }
}

// ---------------------------------------------------------------------------
// Threads and copy
// ---------------------------------------------------------------------------

/// "Dana <dana@x.com>" → "dana@x.com".
pub fn sender_address(from: &str) -> String {
    let inner = match (from.find('<'), from.rfind('>')) {
        (Some(a), Some(b)) if b > a => &from[a + 1..b],
        _ => from,
    };
    inner.trim().to_lowercase()
}

/// "Dana Whitfield <dana@x.com>" → "Dana Whitfield"; a bare address stays.
fn sender_name(from: &str) -> String {
    let name = from.split('<').next().unwrap_or("").trim().trim_matches('"').trim();
    if name.is_empty() || !from.contains('<') {
        sender_address(from)
    } else {
        name.to_string()
    }
}

/// The subject without its Re:/Fwd:/SV:/VS:/AW: prefixes, lower-cased, with
/// its whitespace collapsed: how a thread is told apart without a thread id.
pub fn subject_key(subject: &str) -> String {
    let mut s = subject.trim().to_lowercase();
    loop {
        let before = s.len();
        for p in ["re:", "fw:", "fwd:", "sv:", "vs:", "aw:", "wg:"] {
            if let Some(rest) = s.strip_prefix(p) {
                s = rest.trim_start().to_string();
            }
        }
        if s.len() == before {
            break;
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn thread_key(account_id: &str, from: &str, subject: &str) -> String {
    format!("{account_id}|{}|{}", sender_address(from), subject_key(subject))
}

fn short_date(d: NaiveDate) -> String {
    format!("{} {}", d.day(), MONTH_ABBR[d.month0() as usize])
}

/// The alert's title: what the Home inbox shows and the greeting may say.
fn alert_title(kind: FlagKind, from: &str, due: Option<NaiveDate>, today: NaiveDate) -> String {
    let what = match kind {
        FlagKind::Bill => "Bill",
        FlagKind::Deadline => "Deadline",
    };
    let when = match due {
        Some(d) if d < today => format!(", was due {}", short_date(d)),
        Some(d) => format!(", due {}", short_date(d)),
        None => String::new(),
    };
    format!("{what} from {}{when}", sender_name(from))
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Now, in db_schema.sql's timestamp format, so it compares with created_at.
pub fn mark() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// A stored timestamp as the local calendar day it fell on.
fn local_day(ts: &str) -> Option<NaiveDate> {
    if let Ok(t) = DateTime::parse_from_rfc3339(ts) {
        return Some(t.with_timezone(&Local).date_naive());
    }
    ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(ts, f).ok())
        .map(|n| n.and_utc().with_timezone(&Local).date_naive())
}

/// The switch. No row is the design's default: on.
pub fn alerts_enabled(conn: &Connection, user_id: &str) -> bool {
    conn.query_row("SELECT alerts_enabled FROM mail_prefs WHERE user_id = ?1", [user_id], |r| r.get::<_, i64>(0))
        .optional()
        .ok()
        .flatten()
        .map(|v| v != 0)
        .unwrap_or(true)
}

/// Flag the messages this account's sync inserted since `since`. Returns how
/// many threads got a new alert.
pub fn flag_messages(conn: &Connection, user_id: &str, account_id: &str, since: &str, today: NaiveDate) -> Result<usize, String> {
    type Fresh = (String, Option<String>, Option<String>, Option<String>, Option<String>);
    let fresh: Vec<Fresh> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, from_address, subject, snippet, received_at FROM mail_messages
                  WHERE account_id = ?1 AND user_id = ?2 AND created_at >= ?3
                  ORDER BY received_at ASC LIMIT ?4",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![account_id, user_id, since, MAX_MESSAGES_PER_PASS], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    if fresh.is_empty() {
        return Ok(0);
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut raised = 0usize;
    for (id, from, subject, snippet, received_at) in fresh {
        let received = received_at.as_deref().and_then(local_day).unwrap_or(today);
        if received < today - Duration::days(FLAG_WINDOW_DAYS) {
            continue;
        }
        let from = from.unwrap_or_default();
        let subject = subject.unwrap_or_default();
        let Some(flag) = classify(&subject, snippet.as_deref().unwrap_or(""), received) else { continue };
        let key = thread_key(account_id, &from, &subject);
        let known = tx
            .query_row(
                "SELECT 1 FROM mail_alert_threads WHERE user_id = ?1 AND thread_key = ?2",
                rusqlite::params![user_id, key],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if known {
            continue;
        }
        let alert_id = uuid::Uuid::new_v4().to_string();
        let due_on = flag.due.map(|d| d.format("%Y-%m-%d").to_string());
        tx.execute(
            "UPDATE mail_messages SET category = ?1, importance = MAX(importance, ?2) WHERE id = ?3",
            rusqlite::params![flag.kind.category(), flag.kind.importance(), id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO mail_alerts (id, user_id, message_id, alert_type, title, body, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                alert_id,
                user_id,
                id,
                flag.kind.alert_type(),
                alert_title(flag.kind, &from, flag.due, today),
                if subject.trim().is_empty() { "(no subject)".to_string() } else { subject.clone() },
                json!({
                    "thread_key": key,
                    "due_on": due_on,
                    "from": sender_address(&from),
                    "found_in": "subject and preview",
                })
                .to_string(),
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO mail_alert_threads (user_id, thread_key, alert_id, alert_type, due_on, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![user_id, key, alert_id, flag.kind.alert_type(), due_on, received_at],
        )
        .map_err(|e| e.to_string())?;
        raised += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(raised)
}

/// One notification to post.
#[derive(Debug, PartialEq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// Pick what to announce now and mark it announced. Nothing while the switch
/// is off; an acknowledged alert is never announced.
pub fn take_notices(conn: &Connection, user_id: &str, today: NaiveDate) -> Result<Vec<Notice>, String> {
    if !alerts_enabled(conn, user_id) {
        return Ok(Vec::new());
    }
    type Pending = (String, Option<String>, Option<String>, String, Option<String>);
    let pending: Vec<Pending> = {
        let mut stmt = conn
            .prepare(
                "SELECT t.thread_key, t.due_on, t.received_at, a.title, a.body
                   FROM mail_alert_threads t JOIN mail_alerts a ON a.id = t.alert_id
                  WHERE t.user_id = ?1 AND t.notified_at IS NULL AND a.acknowledged = 0
                  ORDER BY t.due_on IS NULL, t.due_on, t.created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let due_now: Vec<&Pending> = pending
        .iter()
        .filter(|(_, due_on, received_at, _, _)| {
            let due = due_on.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
            let received = received_at.as_deref().and_then(local_day).unwrap_or(today);
            should_notify(due, received, today)
        })
        .collect();
    if due_now.is_empty() {
        return Ok(Vec::new());
    }

    let notices = if due_now.len() > MAX_NOTIFICATIONS {
        vec![Notice {
            title: "Atlas Mail".to_string(),
            body: format!("{} bills and deadlines are due around now. They are in your inbox on Home.", due_now.len()),
        }]
    } else {
        due_now
            .iter()
            .map(|(_, _, _, title, body)| Notice { title: title.clone(), body: body.clone().unwrap_or_default() })
            .collect()
    };
    let stamp = mark();
    for (key, ..) in &due_now {
        conn.execute(
            "UPDATE mail_alert_threads SET notified_at = ?1 WHERE user_id = ?2 AND thread_key = ?3",
            rusqlite::params![stamp, user_id, key],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(notices)
}

/// After a successful scan of one mailbox: flag what it brought in, then post
/// whatever is due to be announced. Never fails the sync it follows; a
/// problem here is logged, and the next scan tries again.
pub fn after_sync(app: &AppHandle, db: &DbState, user_id: &str, account_id: &str, since: &str) {
    let today = Local::now().date_naive();
    let (raised, notices) = {
        let Ok(conn) = db.conn.lock() else { return };
        let raised = flag_messages(&conn, user_id, account_id, since, today).unwrap_or_else(|e| {
            eprintln!("[mail] bill and deadline flags not written: {e}");
            0
        });
        let notices = take_notices(&conn, user_id, today).unwrap_or_else(|e| {
            eprintln!("[mail] alert notifications not prepared: {e}");
            Vec::new()
        });
        (raised, notices)
    };
    if raised > 0 {
        let _ = app.emit("db:changed", json!({ "table": "mail_alerts", "op": "INSERT" }));
        let _ = app.emit("db:changed", json!({ "table": "mail_messages", "op": "UPDATE" }));
    }
    for n in notices {
        // A running focus session holds it (focus_mode.rs): the webview files
        // it with the session, and the Focus screen lists it at the end.
        if crate::focus_mode::holding() {
            let _ = app.emit("focus:held", json!({ "source": "Mail", "title": n.title, "body": n.body }));
            continue;
        }
        // The notification stays on this Mac (Notification Centre). A denied
        // permission is the user's answer, not an error worth surfacing.
        let _ = app.notification().builder().title(&n.title).body(&n.body).show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(include_str!("db_schema.sql")).unwrap();
        conn.execute(
            "INSERT INTO mail_accounts (id, user_id, provider, email_address) VALUES ('gmail:u1:me@x.dk', 'u1', 'gmail', 'me@x.dk')",
            [],
        )
        .unwrap();
        conn
    }

    fn add(conn: &Connection, id: &str, from: &str, subject: &str, snippet: &str, received: &str) {
        conn.execute(
            "INSERT INTO mail_messages (id, user_id, account_id, provider_message_id, from_address, subject, snippet, received_at)
             VALUES (?1, 'u1', 'gmail:u1:me@x.dk', ?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, from, subject, snippet, received],
        )
        .unwrap();
    }

    #[test]
    fn a_subject_that_names_a_bill_is_a_bill() {
        let r = d(2026, 10, 28);
        assert_eq!(classify("Din elregning er klar", "", r).map(|f| f.kind), Some(FlagKind::Bill));
        assert_eq!(classify("Invoice #2207 from Northwind", "", r).map(|f| f.kind), Some(FlagKind::Bill));
        assert_eq!(classify("Faktura 1234", "", r).map(|f| f.kind), Some(FlagKind::Bill));
        assert_eq!(classify("Betalingspåmindelse", "", r).map(|f| f.kind), Some(FlagKind::Bill));
    }

    #[test]
    fn receipts_promotions_and_lookalikes_are_left_alone() {
        let r = d(2026, 10, 28);
        assert_eq!(classify("Kvittering for din faktura", "", r), None);
        assert_eq!(classify("Your receipt from Apple", "Invoice total 99 kr", r), None);
        assert_eq!(classify("Beregning af din pension", "", r), None);
        assert_eq!(classify("Last chance: offer expires tonight", "", r), None);
        assert_eq!(classify("50% off ends Sunday, deadline approaching", "", r), None);
        assert_eq!(classify("Bill Gates on climate", "", r), None);
        assert_eq!(classify("Lunch on Friday?", "Are you free?", r), None);
    }

    #[test]
    fn a_preview_counts_only_with_an_amount_or_a_date() {
        let r = d(2026, 10, 28);
        assert_eq!(classify("Hello from Ørsted", "Your bill is ready, amount due 412,50 kr", r).map(|f| f.kind), Some(FlagKind::Bill));
        assert_eq!(classify("Update", "We changed how your invoice looks", r), None);
        assert_eq!(classify("Aflevering", "Afleveringsfristen er 3. november", r).map(|f| f.kind), Some(FlagKind::Deadline));
        assert_eq!(classify("Aflevering", "Husk fristen", r), None);
    }

    #[test]
    fn the_due_date_is_the_one_after_a_due_word() {
        let r = d(2026, 10, 28);
        assert_eq!(due_date("Fakturadato 28.10.2026, betalingsfrist 05.11.2026", r), Some(d(2026, 11, 5)));
        assert_eq!(due_date("Payment due by Nov 3rd", r), Some(d(2026, 11, 3)));
        assert_eq!(due_date("Due on 3 November 2026", r), Some(d(2026, 11, 3)));
        assert_eq!(due_date("Expires 2026-11-10", r), Some(d(2026, 11, 10)));
    }

    #[test]
    fn without_a_due_word_the_mails_own_day_is_not_the_due_date() {
        let r = d(2026, 10, 28);
        assert_eq!(due_date("Invoice 28.10.2026", r), None);
        assert_eq!(due_date("Invoice 28.10.2026, pay 10.11.2026", r), Some(d(2026, 11, 10)));
        assert_eq!(due_date("Version 2.0.1 released", r), None);
        assert_eq!(due_date("See you on the 3 and the 4", r), None);
    }

    #[test]
    fn a_yearless_date_lands_on_the_next_one() {
        assert_eq!(due_date("due 5 jan", d(2026, 12, 20)), Some(d(2027, 1, 5)));
        assert_eq!(due_date("senest 1. november", d(2026, 10, 28)), Some(d(2026, 11, 1)));
    }

    #[test]
    fn notifications_cover_a_week_either_side() {
        let today = d(2026, 10, 28);
        assert!(should_notify(Some(d(2026, 11, 4)), today, today));
        assert!(!should_notify(Some(d(2026, 11, 20)), today, today));
        assert!(should_notify(Some(d(2026, 10, 25)), today, today));
        assert!(!should_notify(Some(d(2026, 10, 1)), today, today));
        assert!(should_notify(None, d(2026, 10, 27), today));
        assert!(!should_notify(None, d(2026, 10, 10), today));
    }

    #[test]
    fn a_thread_is_its_sender_and_subject_without_reply_prefixes() {
        assert_eq!(subject_key("Re: SV: Fwd:  Faktura   1234"), "faktura 1234");
        assert_eq!(
            thread_key("a1", "Ørsted <Kundeservice@orsted.dk>", "RE: Din elregning"),
            thread_key("a1", "kundeservice@orsted.dk", "Din elregning")
        );
        assert_eq!(sender_name("\"Ørsted\" <k@orsted.dk>"), "Ørsted");
        assert_eq!(sender_name("k@orsted.dk"), "k@orsted.dk");
    }

    #[test]
    fn a_thread_raises_one_alert_and_one_notification() {
        let conn = db();
        let today = Local::now().date_naive();
        let now = mark();
        add(&conn, "m1", "Ørsted <k@orsted.dk>", "Din elregning er klar", "Beløb 412,50 kr", &now);
        add(&conn, "m2", "Ørsted <k@orsted.dk>", "Re: Din elregning er klar", "Påmindelse", &now);
        add(&conn, "m3", "Dana <dana@x.com>", "Lunch?", "Friday works", &now);
        assert_eq!(flag_messages(&conn, "u1", "gmail:u1:me@x.dk", "2000-01-01", today).unwrap(), 1);
        let (cat, alerts): (String, i64) = conn
            .query_row(
                "SELECT category, (SELECT COUNT(*) FROM mail_alerts) FROM mail_messages WHERE id = 'm1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((cat.as_str(), alerts), ("bills", 1));

        let first = take_notices(&conn, "u1", today).unwrap();
        assert_eq!(first, vec![Notice { title: "Bill from Ørsted".into(), body: "Din elregning er klar".into() }]);
        assert!(take_notices(&conn, "u1", today).unwrap().is_empty(), "once per thread");
        // A re-scan of the same messages raises nothing new.
        assert_eq!(flag_messages(&conn, "u1", "gmail:u1:me@x.dk", "2000-01-01", today).unwrap(), 0);
    }

    #[test]
    fn the_switch_holds_notifications_and_old_mail_is_not_flagged() {
        let conn = db();
        let today = Local::now().date_naive();
        conn.execute("INSERT INTO mail_prefs (user_id, alerts_enabled) VALUES ('u1', 0)", []).unwrap();
        add(&conn, "m1", "a@b.dk", "Faktura 1", "", &mark());
        add(&conn, "m2", "a@b.dk", "Faktura 2", "", "2020-01-01T08:00:00.000Z");
        assert_eq!(flag_messages(&conn, "u1", "gmail:u1:me@x.dk", "2000-01-01", today).unwrap(), 1);
        assert!(take_notices(&conn, "u1", today).unwrap().is_empty());
        conn.execute("UPDATE mail_prefs SET alerts_enabled = 1 WHERE user_id = 'u1'", []).unwrap();
        assert_eq!(take_notices(&conn, "u1", today).unwrap().len(), 1);
    }

    #[test]
    fn many_at_once_collapse_into_one_summary() {
        let conn = db();
        let today = Local::now().date_naive();
        for i in 0..5 {
            add(&conn, &format!("m{i}"), &format!("s{i}@b.dk"), "Faktura", "", &mark());
        }
        assert_eq!(flag_messages(&conn, "u1", "gmail:u1:me@x.dk", "2000-01-01", today).unwrap(), 5);
        let n = take_notices(&conn, "u1", today).unwrap();
        assert_eq!(n.len(), 1);
        assert!(n[0].body.starts_with("5 bills and deadlines"));
    }

    #[test]
    fn disconnecting_forgets_the_threads() {
        let conn = db();
        let today = Local::now().date_naive();
        add(&conn, "m1", "a@b.dk", "Faktura", "", &mark());
        flag_messages(&conn, "u1", "gmail:u1:me@x.dk", "2000-01-01", today).unwrap();
        conn.execute("DELETE FROM mail_accounts WHERE id = 'gmail:u1:me@x.dk'", []).unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM mail_alert_threads", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }
}
