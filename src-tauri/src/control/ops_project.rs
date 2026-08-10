// Result projection — what the brain is allowed to SEE, and how much of it.
//
// WHY EVERY LIST OP GOES THROUGH HERE
// The commands underneath return provider-shaped payloads: `music_search` hands
// back Spotify's entire search document (four result kinds, each item carrying
// album art URLs, market lists, external ids), and a mail thread carries whole
// message bodies. Three separate problems follow from handing those to a model
// verbatim:
//   1. Cost is proportional to the provider's schema instead of to the answer.
//   2. A large, volatile blob near the head of the context invalidates the
//      prompt cache for every later turn in the conversation.
//   3. Everything that lands in the context is one prompt-injection away from
//      being read back out — and mail bodies are attacker-authored text.
// So each op returns a hand-written projection of the few fields that answer
// the question, and the total is capped before it leaves this process.

use serde_json::{json, Map, Value};

/// Hard ceiling on the serialized size of one projected list.
///
/// 4 KB is roughly a thousand tokens — enough for tens of projected rows, and
/// small enough that a single tool result cannot dominate a turn. The cap is
/// applied to the projection, not to the upstream payload: the point is to
/// bound what reaches the model, not what we fetched.
pub const MAX_BYTES: usize = 4 * 1024;

/// Wrap projected rows in the list envelope, dropping any that do not fit.
///
/// Truncation is REPORTED, never silent: `truncated: true` tells the brain the
/// answer is partial so it can narrow the query and ask again. A model that is
/// handed a partial list with no marker will confidently describe it as
/// complete, which is exactly the fabrication this product refuses to do.
pub fn capped(items: Vec<Value>) -> Value {
    let mut kept: Vec<Value> = Vec::with_capacity(items.len());
    // Start from the two brackets the array itself costs.
    let mut bytes = 2usize;
    let mut truncated = false;
    for item in items {
        // +1 for the separating comma. Measuring the serialized form (rather
        // than counting rows) is what makes the bound hold for a row with an
        // unexpectedly long free-text field.
        let cost = item.to_string().len() + 1;
        if bytes + cost > MAX_BYTES {
            // SKIP the oversized row, do not STOP at it. `break` here was a
            // real defect: mail_threads is ordered newest-first and two of its
            // projected columns are attacker-authored and unbounded at ingest
            // (`subject`, `participants` — only `snippet` is capped, at
            // mail.rs:295). So a single inbound email with a 4 KB subject sat
            // at position 0 and emptied the entire list.
            //
            // Continuing means one hostile row costs itself and nothing else,
            // and `truncated` still tells the brain the answer is partial.
            //
            // WHAT THIS DOES NOT FIX, despite a comment here that used to claim
            // it did: the single-row lookup. `ops_db::read_one` used to take
            // items[0] of a capped list, and with exactly one row `continue` and
            // `break` are the same statement — the row was dropped either way,
            // `first()` saw nothing, and `mail.read_thread` answered "no such
            // thread in the local mail store" about a thread that demonstrably
            // exists. One attacker-chosen 5 KB subject made a thread
            // permanently unreadable AND un-archivable (mail.archive and
            // mail.mark_read call the same lookup through `confirm_thread`),
            // with Atlas asserting non-existence the whole time. That case is
            // fixed by `fit_one` below, which shrinks a single row instead of
            // dropping it — not by this loop.
            truncated = true;
            continue;
        }
        bytes += cost;
        kept.push(item);
    }
    let returned = kept.len();
    json!({ "items": kept, "returned": returned, "truncated": truncated })
}

/// The fewest characters a shrunken field is left with. Below this a value
/// stops identifying anything, so shrinking it further buys bytes at the cost
/// of the only thing it was kept for.
const FIT_MIN_CHARS: usize = 32;

/// Bound ONE row without ever dropping it.
///
/// `capped` is the list rule and it is right for a list: a row that does not fit
/// is skipped, the rest still answer the question, and `truncated` says so.
/// Applying that rule to a single-row lookup is what produced the defect
/// described in `capped` above — the caller asked "does this thread exist" and a
/// size decision answered "no". Existence is not a size question, so this
/// function has no way to return nothing: it shrinks the longest string field,
/// repeatedly, until the row fits, and marks the row `truncated` so neither the
/// model nor the user reads a clipped subject as the whole one.
///
/// A row whose bulk is NOT in string fields cannot be shrunk and comes back
/// oversized. That is deliberate: nothing in the readable tables stores bulk
/// anywhere but TEXT columns, and if that ever changes, an oversized honest row
/// is still a better answer than a fabricated absence.
pub fn fit_one(row: Value) -> Value {
    if row.to_string().len() <= MAX_BYTES {
        return row;
    }
    // db_select only ever produces objects; the other arm exists for totality.
    let Value::Object(mut map) = row else { return row };

    let mut shrunk = false;
    // Each pass halves the longest string, so the size falls geometrically and
    // this loop is bounded by far fewer than 64 iterations for any real row.
    // The count is here so a pathological map cannot spin a worker.
    for _ in 0..64 {
        let size = serde_json::to_string(&map).map(|s| s.len()).unwrap_or(0);
        if size <= MAX_BYTES {
            break;
        }
        let longest = map
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.chars().count())))
            .filter(|(_, len)| *len > FIT_MIN_CHARS)
            .max_by_key(|(_, len)| *len);
        let Some((key, len)) = longest else { break };
        let keep = (len / 2).max(FIT_MIN_CHARS);
        if let Some(Value::String(s)) = map.get_mut(&key) {
            *s = s.chars().take(keep).collect::<String>();
            s.push('…');
        }
        shrunk = true;
    }
    if shrunk {
        map.insert("truncated".to_string(), Value::Bool(true));
    }
    Value::Object(map)
}

/// The longest caller-supplied fragment any error message will echo.
const MAX_ECHO_CHARS: usize = 40;

/// Bound a caller-chosen string before it appears in an error message.
///
/// An error must never be a larger context payload than a success. Several
/// messages name the offending key back to the model ("'{col}' is not a
/// readable column"), and the key comes straight off the wire: an unbounded one
/// turned a rejection into a few hundred kilobytes of attacker-authored text
/// sitting in the model's context, on a path that writes no audit row and costs
/// one rate-limit token. Control characters are flattened for the same reason
/// `audit::sanitize` flattens them — a newline inside a quoted fragment forges
/// structure in anything that later formats the message into lines.
pub fn snippet(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .take(MAX_ECHO_CHARS)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect();
    if raw.chars().count() > MAX_ECHO_CHARS {
        out.push('…');
    }
    out
}

/// Keep only `cols` from a row object, in the order `cols` lists them.
///
/// A column the row does not have is omitted rather than emitted as null: the
/// caller's allowlist describes what MAY be returned, and inventing a key for
/// something the store did not produce is a small lie the model will act on.
pub fn pick(row: &Value, cols: &[&str]) -> Value {
    let mut out = Map::with_capacity(cols.len());
    for col in cols {
        if let Some(v) = row.get(*col) {
            out.insert((*col).to_string(), v.clone());
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_passes_small_lists_through_untouched() {
        let out = capped(vec![json!({ "a": 1 }), json!({ "a": 2 })]);
        assert_eq!(out["returned"], json!(2));
        assert_eq!(out["truncated"], json!(false));
        assert_eq!(out["items"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn capped_marks_truncation_and_stays_under_the_ceiling() {
        // 200 rows of ~64 bytes each is well past 4 KB.
        let filler = "x".repeat(56);
        let items: Vec<Value> = (0..200).map(|_| json!({ "t": filler })).collect();
        let out = capped(items);
        assert_eq!(out["truncated"], json!(true));
        let kept = out["items"].as_array().unwrap();
        assert!(!kept.is_empty(), "the cap must not swallow the whole list");
        assert!(
            out["items"].to_string().len() <= MAX_BYTES,
            "projection exceeded the {MAX_BYTES}-byte ceiling"
        );
        assert_eq!(out["returned"], json!(kept.len()));
    }

    /// Regression test: one oversized row must cost only itself.
    ///
    /// `capped` used to `break`, so an item too large to fit stopped the whole
    /// loop. mail_threads is ordered newest-first and `subject` is unbounded
    /// attacker-authored text, so one email with a huge subject emptied the
    /// list. Big row FIRST here, which is the ordering that actually bit.
    #[test]
    fn capped_skips_an_oversized_row_and_keeps_the_rest() {
        let huge = json!({ "subject": "x".repeat(MAX_BYTES * 2) });
        let items = vec![huge, json!({ "id": "keep-me" }), json!({ "id": "me-too" })];

        let out = capped(items);

        assert_eq!(out["returned"], 2, "the small rows must survive the big one");
        assert_eq!(out["truncated"], true, "dropping a row must still be reported");
        assert_eq!(out["items"][0]["id"], "keep-me");
        assert_eq!(out["items"][1]["id"], "me-too");
    }

    #[test]
    fn capped_handles_an_empty_list() {
        let out = capped(vec![]);
        assert_eq!(out["returned"], json!(0));
        assert_eq!(out["truncated"], json!(false));
    }

    /// The single-row rule is the opposite of the list rule, on purpose.
    ///
    /// The defect: `read_one` took items[0] of a `capped()` list, so a row whose
    /// projection exceeded 4 KB was dropped and the lookup returned `None` —
    /// which `mail.read_thread` reports as "no such thread in the local mail
    /// store". A single inbound email with a ~5 KB subject (unbounded at ingest,
    /// and `subject` is in the read allowlist) therefore made its own thread
    /// permanently unreadable and un-archivable, with Atlas confidently
    /// asserting the thread did not exist.
    #[test]
    fn a_row_too_big_for_the_list_still_exists_as_a_single_row() {
        let huge = json!({ "id": "t1", "subject": "x".repeat(MAX_BYTES * 2) });

        // The list path drops it, and that is correct for a list.
        assert_eq!(capped(vec![huge.clone()])["returned"], 0);

        // The single-row path must not. This is the assertion that was false.
        let one = fit_one(huge);
        assert_eq!(one["id"], "t1", "the identifying field must survive");
        assert!(
            one.to_string().len() <= MAX_BYTES,
            "the row is bounded, it is just not deleted"
        );
        assert_eq!(one["truncated"], true, "a clipped subject must say it is clipped");
        let subject = one["subject"].as_str().expect("subject survives as a string");
        assert!(subject.ends_with('…'), "the clip must be visible: {subject}");
    }

    #[test]
    fn fit_one_leaves_a_row_that_already_fits_exactly_alone() {
        let row = json!({ "id": "t1", "subject": "hello" });
        assert_eq!(fit_one(row.clone()), row);
        assert!(fit_one(row).get("truncated").is_none(), "no marker on an untouched row");
    }

    /// A row nothing can shrink comes back oversized rather than absent.
    /// Fabricating "this does not exist" is the failure mode; being long is not.
    #[test]
    fn fit_one_never_returns_nothing_even_when_it_cannot_shrink() {
        let numbers: Vec<Value> = (0..2000).map(|i| json!(i)).collect();
        let row = json!({ "id": "t1", "blob": numbers });
        let out = fit_one(row);
        assert_eq!(out["id"], "t1");
    }

    /// An error is a context payload too, and this one is built from a string
    /// the caller chose: `'{col}' is not a readable column` echoed an unbounded
    /// key back to the model, so a rejection could carry more attacker-authored
    /// text than any success on the same op.
    #[test]
    fn an_echoed_fragment_is_bounded_and_cannot_forge_lines() {
        let hostile = "a".repeat(100_000);
        let out = snippet(&hostile);
        assert!(out.chars().count() <= MAX_ECHO_CHARS + 1, "{} chars", out.chars().count());
        assert!(out.ends_with('…'), "clipping must be visible");

        // Short fragments are passed through unchanged — the message still has
        // to tell the model which field it got wrong.
        assert_eq!(snippet("completed"), "completed");

        // A newline would let the fragment forge a second line of the message.
        assert_eq!(snippet("a\nb\tc\u{0}d"), "a?b?c?d");
    }

    #[test]
    fn pick_keeps_only_allowlisted_keys_and_omits_absent_ones() {
        let row = json!({ "id": "1", "title": "t", "user_id": "u", "secret": "s" });
        let out = pick(&row, &["id", "title", "due_date"]);
        assert_eq!(out["id"], json!("1"));
        assert_eq!(out["title"], json!("t"));
        assert!(out.get("user_id").is_none());
        assert!(out.get("secret").is_none());
        // Absent column is omitted, not nulled.
        assert!(out.get("due_date").is_none());
    }
}
