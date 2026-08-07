// The op registry — the complete list of what the brain may do to this desktop.
//
// READ-ONLY MILESTONE. Every entry below is `Tier::Read` and every runner is a
// pure read: nothing here writes a row, sends a request that changes remote
// state, opens a consent screen, or touches the Keychain. There is a test that
// says so, and it fails if a later entry breaks it.
//
// The runners call the EXISTING `#[tauri::command]` items directly, taking
// managed state off the `&AppHandle` with `state::<T>()` / `try_state::<T>()`.
// Tauri's command macro leaves the original function intact and `Manager::state`
// resolves from any handle, not only inside IPC dispatch (lib.rs already relies
// on this at :445 and :506). So there is NO wrapper-splitting refactor here, and
// none is needed for the write tiers later.
//
// The runners live in the ops_* modules declared below rather than in this file,
// so the table stays readable in one screen. They are declared HERE, not in
// mod.rs, so that a new runner module cannot appear without touching the file
// the capability table lives in.

#[path = "ops_data.rs"]
mod ops_data;
#[path = "ops_db.rs"]
mod ops_db;
#[path = "ops_mail.rs"]
mod ops_mail;
#[path = "ops_music.rs"]
mod ops_music;
#[path = "ops_portfolio.rs"]
mod ops_portfolio;
#[path = "ops_project.rs"]
mod ops_project;

use serde_json::{json, Value};

use super::{Op, Tier};

// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY ABSENT
//
// Eleven commands the app exposes over IPC are NOT reachable from this port,
// and will not become reachable by adding a write tier — each is excluded for a
// reason of its own. The next person to read the table below will wonder where
// they went, and `DENIED` at the bottom of this file is the test that keeps
// them out, so the reasoning belongs next to it:
//
//   brain_set_ai_key      Writes the macOS Keychain. Worse than "it is a write":
//                         an empty value silently CLEARS the stored key, so a
//                         model that calls it with a plausible-looking empty
//                         argument disables Atlas' own reasoning and leaves no
//                         trace of what happened.
//
//   db_delete             Nothing in this product deletes user rows. Finishing
//                         a task is completed=1 and filing a thread is
//                         archived_at — soft state, reversible by the user, and
//                         visible in history. A DELETE is none of those, and no
//                         write tier will change that.
//
//   db_info               Enumerates every table in the schema with row counts.
//                         That is reconnaissance: it answers "what is worth
//                         asking for" for an attacker and nothing at all for
//                         the user.
//
//   memory_upsert_vector  Takes a raw 768-dim embedding and writes it straight
//                         into the vec0 index. A vector that did not come from
//                         the embedding model is not wrong in a way anything
//                         detects — it silently poisons recall ranking for
//                         every future query. Memory is written by the ingest
//                         path that produces the embeddings, not by a caller.
//
//   music_connect         Returns a Spotify OAuth consent URL for the app to
//                         open in the system browser. A model that can raise a
//                         real consent screen at a moment of its own choosing
//                         is a phishing primitive, whatever the URL says.
//
//   music_disconnect      Destroys the Keychain refresh token. Unrecoverable
//                         without the user re-doing the whole OAuth flow.
//
//   portfolio_connect_url Same as music_connect: it raises a brokerage-linking
//                         consent screen.
//
//   portfolio_disconnect  Same as music_disconnect, and additionally WIPES the
//                         local DuckDB store — the entire holdings and activity
//                         history, gone.
//
//   atlas_brain_info      RETURNS THE SIDECAR TOKEN. Handing it out here would
//                         let anything that reached one op reach the brain's
//                         own API.
//
//   voice_gateway_info    Returns the same shared gateway token.
//
//   mail_ingest_errors    Operator diagnostics from the mail worker: internal
//                         failure detail that belongs in a log, not in a
//                         prompt, where it becomes both noise and a description
//                         of the server's internals.
//
//   mail_send_reply       Sending mail is out of scope for a read-only
//                         milestone. It currently hard-refuses anyway (Workers
//                         Paid is not purchased), which is exactly why it must
//                         not be listed: an op that is safe only because a bill
//                         is unpaid is not safe.
// ---------------------------------------------------------------------------

/// Every operation the control port exposes. A flat table so the whole
/// capability surface is one screen of code that can be read in a review.
pub static OPS: &[Op] = &[
    // --- music: catalogue and playback state. No transport, no connection. ---
    Op {
        name: "music.status",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Whether Spotify is linked, whether the account is Premium, and whether the Atlas playback device is up.",
        run: ops_music::status,
    },
    Op {
        name: "music.search",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Search Spotify. Needs 'query'; returns id/name/artist/uri for tracks, albums, artists and playlists.",
        run: ops_music::search,
    },
    Op {
        name: "music.library_tracks",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "The user's saved tracks, one page at a time ('offset', 'limit').",
        run: ops_music::library_tracks,
    },
    Op {
        name: "music.playlists",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "The user's playlists, one page at a time ('offset', 'limit').",
        run: ops_music::playlists,
    },
    Op {
        name: "music.playlist_tracks",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Tracks in one playlist. Needs 'playlist_id'.",
        run: ops_music::playlist_tracks,
    },
    Op {
        name: "music.now_playing",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "What is playing right now, or playing:false when nothing is.",
        run: ops_music::now_playing,
    },
    // --- mail: the local mirror only. See ops_mail.rs for why. ---
    Op {
        name: "mail.list_threads",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "Mail threads from the local store as of the last sync. Optional 'filters' {status}, 'limit'. Does not fetch new mail.",
        run: ops_mail::list_threads,
    },
    Op {
        name: "mail.read_thread",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "One thread's header and its messages' sender, subject and snippet. Needs 'thread_id'. Message bodies are not returned.",
        run: ops_mail::read_thread,
    },
    // --- portfolio: the local analytics store. No linking, no unlinking. ---
    Op {
        name: "portfolio.status",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "Whether a brokerage is linked and whether the app has credentials to link one.",
        run: ops_portfolio::status,
    },
    Op {
        name: "portfolio.summary",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "Total value, cost, cash and unrealised P/L across linked accounts, as of the last sync.",
        run: ops_portfolio::summary,
    },
    Op {
        name: "portfolio.holdings",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "The largest positions with quantity, price, market value and P/L.",
        run: ops_portfolio::holdings,
    },
    Op {
        name: "portfolio.history",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "Portfolio value over time as date/value points.",
        run: ops_portfolio::history,
    },
    Op {
        name: "portfolio.allocation",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "Allocation broken down by label and value.",
        run: ops_portfolio::allocation,
    },
    // --- outbound data fetches ---
    Op {
        name: "data.weather",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Current conditions and a short forecast for a city or lat/lon.",
        run: ops_data::weather,
    },
    Op {
        name: "data.stocks",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Latest quotes for a list of ticker symbols, plus index levels.",
        run: ops_data::stocks,
    },
    Op {
        name: "data.news",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Top headlines for a news category.",
        run: ops_data::news,
    },
    // --- local app data. Each is pinned to one table by ops_db.rs. ---
    Op {
        name: "tasks.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "The user's tasks. Optional 'filters' {completed, priority, due_date}, 'order_by', 'limit'.",
        run: ops_db::tasks,
    },
    Op {
        name: "notes.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "The user's notes, most recently updated first.",
        run: ops_db::notes,
    },
    Op {
        name: "events.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "Calendar events, earliest start first.",
        run: ops_db::events,
    },
    Op {
        name: "watchlist.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "Ticker symbols the user is watching.",
        run: ops_db::watchlist,
    },
];

/// Resolve an op by name.
///
/// A linear scan of `OPS` rather than a `match`, precisely so there is no
/// catch-all arm anywhere: an op is reachable if and only if somebody wrote a
/// line for it in the table above. Twenty entries make the scan free, and if the
/// table ever grows past the point where that is true, the fix is a map built
/// from the same table — never a pattern that can match a name nobody listed.
pub fn lookup(name: &str) -> Option<&'static Op> {
    OPS.iter().find(|op| op.name == name)
}

/// The `/v1/capabilities` payload. The brain calls this at startup to learn
/// what tools to declare; an empty or absent response means it declares none.
pub fn capabilities() -> Value {
    let ops: Vec<Value> = OPS
        .iter()
        .map(|op| {
            json!({
                "name": op.name,
                "tier": op.tier.as_str(),
                "timeout_ms": op.timeout_ms,
                "summary": op.summary,
            })
        })
        .collect();
    json!({ "ops": ops })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The commands that must never be reachable from the control port.
    /// The reasoning for each is in the block comment above `OPS` — this is the
    /// enforcement, that is the explanation, and they have to be kept together.
    const DENIED: &[&str] = &[
        "brain_set_ai_key",
        "db_delete",
        "db_info",
        "memory_upsert_vector",
        "music_connect",
        "music_disconnect",
        "portfolio_connect_url",
        "portfolio_disconnect",
        "atlas_brain_info",
        "voice_gateway_info",
        "mail_ingest_errors",
        "mail_send_reply",
    ];

    /// The runner modules, paired with their source text.
    ///
    /// `include_str!` rather than a field on `Op`: a runner is a fn pointer, so
    /// there is no way to ask an entry in `OPS` which `#[tauri::command]` it
    /// ends up calling. What CAN be checked is that no runner module mentions a
    /// denied command at all — which is the property that actually matters,
    /// since a forbidden call would have to be written into one of these files.
    ///
    /// registry.rs itself is excluded on purpose: it is the file that must name
    /// every denied command, both in `DENIED` and in the comment explaining the
    /// absence, and a scan that included it could never pass.
    const RUNNER_SOURCES: &[(&str, &str)] = &[
        ("ops_data.rs", include_str!("ops_data.rs")),
        ("ops_db.rs", include_str!("ops_db.rs")),
        ("ops_mail.rs", include_str!("ops_mail.rs")),
        ("ops_music.rs", include_str!("ops_music.rs")),
        ("ops_portfolio.rs", include_str!("ops_portfolio.rs")),
        ("ops_project.rs", include_str!("ops_project.rs")),
    ];

    #[test]
    fn no_denied_command_is_reachable_from_any_runner() {
        for (file, source) in RUNNER_SOURCES {
            for denied in DENIED {
                assert!(
                    !source.contains(denied),
                    "{file} mentions {denied}, which the control port must never reach — \
                     see the absence notes above OPS in registry.rs before changing this"
                );
            }
        }
    }

    #[test]
    fn no_op_is_named_after_a_denied_command() {
        for op in OPS {
            // Compare on the bare verb: `music.disconnect` and `music_disconnect`
            // are the same capability wearing different punctuation.
            let flat = op.name.replace('.', "_");
            for denied in DENIED {
                assert!(
                    !flat.contains(denied) && !denied.contains(&flat),
                    "op {} names the denied command {denied}",
                    op.name
                );
            }
        }
    }

    /// The guard on the guard. `RUNNER_SOURCES` is a hand-written list, and a
    /// new ops_*.rs that nobody added to it would be scanned by nothing at all —
    /// which is precisely the silent gap the denylist exists to prevent.
    #[test]
    fn every_runner_module_on_disk_is_scanned() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/control");
        let entries = std::fs::read_dir(dir).expect("src/control must be readable");
        for entry in entries {
            let name = entry.expect("readable dir entry").file_name();
            let name = name.to_string_lossy().to_string();
            if !name.starts_with("ops_") || !name.ends_with(".rs") {
                continue;
            }
            assert!(
                RUNNER_SOURCES.iter().any(|(f, _)| *f == name),
                "{name} is not in RUNNER_SOURCES, so the denylist never looks at it"
            );
        }
    }

    #[test]
    fn every_registered_op_is_read_tier_in_this_milestone() {
        for op in OPS {
            assert_eq!(op.tier, Tier::Read, "{} is not a read", op.name);
        }
    }

    #[test]
    fn lookup_finds_every_registered_op() {
        for op in OPS {
            assert_eq!(lookup(op.name).map(|o| o.name), Some(op.name));
        }
    }

    #[test]
    fn lookup_returns_none_for_unregistered_names() {
        // Nothing resolves by accident: not a plausible-looking sibling, not a
        // near-miss, not a namespace prefix, not the empty string, and above all
        // not a mutation dressed as one of the read namespaces.
        for name in [
            "",
            "data",
            "data.",
            "data.weather.now",
            "data.wether",
            "DATA.WEATHER",
            "music.play",
            "music.pause",
            "music.connect",
            "music.disconnect",
            "mail.send",
            "mail.send_reply",
            "mail.mark_read",
            "tasks.create",
            "tasks.delete",
            "db.select",
            "db.delete",
            "portfolio.sync",
            "portfolio.disconnect",
            "shell.exec",
        ] {
            assert!(lookup(name).is_none(), "{name} must not resolve");
        }
    }

    #[test]
    fn op_names_are_unique() {
        for (i, op) in OPS.iter().enumerate() {
            assert!(
                OPS.iter().take(i).all(|prev| prev.name != op.name),
                "duplicate op name {}",
                op.name
            );
        }
    }

    #[test]
    fn every_op_declares_a_timeout_and_a_summary() {
        for op in OPS {
            assert!(op.timeout_ms > 0, "{} has no time budget", op.name);
            assert!(
                op.summary.len() > 20,
                "{} needs a summary the brain can build a tool description from",
                op.name
            );
        }
    }

    #[test]
    fn capabilities_lists_the_whole_table() {
        let caps = capabilities();
        let ops = caps["ops"].as_array().expect("ops array");
        assert_eq!(ops.len(), OPS.len());
        for (entry, op) in ops.iter().zip(OPS) {
            assert_eq!(entry["name"], json!(op.name));
            assert_eq!(entry["tier"], json!(op.tier.as_str()));
        }
    }
}
