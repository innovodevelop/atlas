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
            // at position 0 and emptied the entire list. Worse, `read_one`
            // reads items[0] of a capped list, so that same email made
            // `mail.read_thread` answer "no such thread" about a thread that
            // demonstrably exists — a confident assertion of non-existence,
            // which is precisely the fabrication this file refuses.
            //
            // Continuing means one hostile row costs itself and nothing else,
            // and `truncated` still tells the brain the answer is partial.
            truncated = true;
            continue;
        }
        bytes += cost;
        kept.push(item);
    }
    let returned = kept.len();
    json!({ "items": kept, "returned": returned, "truncated": truncated })
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
    /// list — and because `read_one` reads items[0], it also turned an existing
    /// thread into "no such thread". Big row FIRST here, which is the ordering
    /// that actually bit.
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
