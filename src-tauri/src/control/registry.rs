// The op registry — the complete list of what the brain may do to this desktop.
//
// FOUR TIERS ARE LIVE. The table below is no longer read-only:
//
//   Read (24)      pure reads — allowlisted tables and columns, always scoped
//                  to the caller's own user_id, never audited (policy.rs says
//                  why). Nothing here writes a row or changes remote state.
//   Write (6)      local SQLite rows in four pinned tables. Reversible, visible
//                  in the app, confined to this machine, and audited before
//                  dispatch.
//   Actuate (3)    music transport. Nothing in a table changes; what changes is
//                  the room the user is in. Runs on the interactive profile,
//                  queues for approval on the background one.
//   Approval (2)   mail mutations. Never auto-run, on any profile, because the
//                  model that calls them has just read attacker-authored text.
//
// The old guarantee ("every entry is Read, and a test says so") is gone, and
// what replaced it is stricter, not looser: `EXPECTED_TIERS` at the bottom of
// this file pins EVERY op to a hand-reviewed tier, so a silent promotion of a
// read — or a write declared at a tier that does not gate it — fails the build
// rather than shipping.
//
// THE `summary_keys` COLUMN IS THE APPROVALS CARD, not documentation. It is the
// only thing about a caller's arguments that reaches the button a human clicks
// (`audit::action_summary`), so what is written there is what consent covers:
//   None      the op declares no card and CANNOT be queued — `queue_for_approval`
//             refuses it before writing a row. That is the fail-closed default,
//             and it is what every Read and Write op here carries, because
//             neither tier can ever reach the queue.
//   Some(&[]) the op genuinely takes no arguments (music.pause). The card says
//             "(no arguments)" rather than leaving a blank where an object
//             should be.
//   Some(k)   exactly these fields render, in this order, and nothing else. k[0]
//             is the IDENTIFYING field — the one that ties the card to a
//             specific track, thread or level — and is the one guaranteed to
//             survive truncation. Fields the caller sent that are not listed are
//             never shown; only their count is.
// `EXPECTED_CARDS` at the bottom of this file pins each one to a hand review,
// for the same reason `EXPECTED_TIERS` pins the tiers.
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
#[path = "ops_health.rs"]
mod ops_health;
#[path = "ops_home.rs"]
mod ops_home;
#[path = "ops_mail.rs"]
mod ops_mail;
#[path = "ops_music.rs"]
mod ops_music;
#[path = "ops_portfolio.rs"]
mod ops_portfolio;
#[path = "ops_project.rs"]
mod ops_project;
#[path = "ops_write.rs"]
mod ops_write;

use serde_json::{json, Value};

use super::{Op, Tier};

// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY ABSENT
//
// Fifteen commands the app exposes over IPC are NOT reachable from this port,
// and the write/actuate/approval tiers did not change that — each is excluded
// for a reason of its own. The next person to read the table below will wonder
// where they went, and `DENIED` at the bottom of this file is the test that
// keeps them out, so the reasoning belongs next to it:
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
//   health_import         Takes a filesystem PATH and reports what it found
//                         there — the size, whether it parsed, how many records
//                         it held. That is a file-probing primitive wearing a
//                         health tool's clothes: a model could map a disk by
//                         error message alone. It is also a capability nobody
//                         needs, because importing is a person choosing a file
//                         in a picker while standing at the screen.
//
//   home_homekit_pair     Pairs Atlas with a HomeKit accessory. Needs the
//                         8-digit setup code printed on the device — a
//                         credential a person reads off a physical label while
//                         standing in front of it — and leaves a permanent key
//                         behind. A model that could run this could be talked
//                         into pairing with an accessory the user never chose,
//                         which is the smart-home equivalent of music_connect's
//                         consent screen. `home.discover`, which only LOOKS,
//                         is registered; this is not.
//
//   health_forget         Erases a person's entire health history. "Can Atlas
//                         delete my health data on its own?" has to answer no,
//                         and the cheapest way to guarantee that is for no op
//                         to name the command. There is no undo and no second
//                         copy — the export it came from is on the user's disk,
//                         not ours.
//
//   mail_send_reply       Sending mail is a different capability from filing
//                         it: an archive is undone by the user in one click, an
//                         email that left the building is not. It currently
//                         hard-refuses anyway (Workers Paid is not purchased),
//                         which is exactly why it must not be listed: an op
//                         that is safe only because a bill is unpaid is not
//                         safe. Approval tier does not change this — approving
//                         a send still needs a draft the user can read first,
//                         and there is no op that shows one.
//
// Three more commands are unlisted without being denied outright — they are
// writes nobody has reviewed rather than capabilities anyone rejected, and the
// allowlist below (`ALLOWED_COMMANDS`) is what keeps them out until somebody
// does: `mail_sync` and `mail_thread_fetch` (ops_mail.rs explains what each
// actually returns, and that mail_sync's rule pass can change an unbounded
// number of remote thread statuses behind one call), and `portfolio_sync`
// (rewrites the whole local DuckDB store from the brokerage).
//
// AND ONE CAPABILITY THAT IS MISSING RATHER THAN EXCLUDED
//   watchlist.remove      The brain can add a symbol and cannot take one off
//                         again, which is a real gap and not a decision. The
//                         only way to remove a row from `user_watchlist` is a
//                         DELETE — the table has no soft-delete column — and
//                         `db_delete` is denied above. Closing it needs a
//                         narrow, table-pinned removal command in db.rs (or a
//                         `deleted_at` column), not a widening of this file.
// ---------------------------------------------------------------------------

/// Every operation the control port exposes. A flat table so the whole
/// capability surface is one screen of code that can be read in a review.
pub static OPS: &[Op] = &[
    // --- music: catalogue and playback state. No connection, no disconnection. ---
    Op {
        name: "music.status",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Whether Spotify is linked, whether the account is Premium, and whether the Atlas playback device is up.",
        summary_keys: None,
        run: ops_music::status,
    },
    Op {
        name: "music.search",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Search Spotify. Needs 'query'; returns id/name/artist/uri for tracks, albums, artists and playlists.",
        summary_keys: None,
        run: ops_music::search,
    },
    Op {
        name: "music.library_tracks",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "The user's saved tracks, one page at a time ('offset', 'limit').",
        summary_keys: None,
        run: ops_music::library_tracks,
    },
    Op {
        name: "music.playlists",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "The user's playlists, one page at a time ('offset', 'limit').",
        summary_keys: None,
        run: ops_music::playlists,
    },
    Op {
        name: "music.playlist_tracks",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Tracks in one playlist. Needs 'playlist_id'.",
        summary_keys: None,
        run: ops_music::playlist_tracks,
    },
    Op {
        name: "music.now_playing",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "What is playing right now, or playing:false when nothing is.",
        summary_keys: None,
        run: ops_music::now_playing,
    },
    // --- smart home: the local mirror. No linking, no sync, no unlinking. ---
    Op {
        name: "home.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "The linked home: every device with its id, room, kind, current value and whether it is answering, plus the scenes. Reads Atlas' local mirror — it puts no traffic on the home network.",
        summary_keys: None,
        run: ops_home::list,
    },
    // LIGHTHOUSE ONLY. The cfg is the whole point: the Rust crate is shared by
    // both bundles, so an op registered unconditionally is reachable by the
    // model in Atlas.app whatever the frontend shipped. See ops_home.rs for
    // why a LAN browse is a Read, and
    // `no_homekit_op_is_reachable_without_the_cargo_feature` below for the test
    // that fails if this attribute is ever dropped.
    #[cfg(feature = "homekit")]
    Op {
        name: "home.discover",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "HomeKit accessories on this network, from one 2.5-second Bonjour browse: each one's id, name, model, address and whether it can be paired. An accessory already paired with another home — usually Apple Home — is reported as such, with what to do about it. Cannot pair anything.",
        summary_keys: None,
        run: ops_home::discover,
    },
    // --- health: derived daily values from the person's own Apple Health
    //     export. READ ONLY, and see ops_health.rs for why that is a promise
    //     rather than a milestone. ---
    Op {
        name: "health.summary",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "The most recent value of every health measurement Atlas has — steps, sleep stages, heart rate, weight — each with the day it was measured, plus how far back the data goes. Reads Atlas' local store; health data never leaves this machine.",
        summary_keys: None,
        run: ops_health::summary,
    },
    Op {
        name: "health.metric_history",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "One health measurement over time, newest day first. Needs 'metric' (the names are listed by health.summary); optional 'days', default 30, at most 400.",
        summary_keys: None,
        run: ops_health::metric_history,
    },
    Op {
        name: "health.workouts",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "Recent workouts with their activity, duration, distance and energy. Optional 'limit', default 10.",
        summary_keys: None,
        run: ops_health::workouts,
    },
    // --- mail: the local mirror only. See ops_mail.rs for why. ---
    Op {
        name: "mail.list_threads",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "Mail threads from the local store as of the last sync. Optional 'filters' {status}, 'limit'. Does not fetch new mail.",
        summary_keys: None,
        run: ops_mail::list_threads,
    },
    Op {
        name: "mail.read_thread",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "One thread's header and its messages' sender, subject and snippet. Needs 'thread_id'. Message bodies are not returned.",
        summary_keys: None,
        run: ops_mail::read_thread,
    },
    // --- portfolio: the local analytics store. No linking, no unlinking. ---
    Op {
        name: "portfolio.status",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "Whether a brokerage is linked and whether the app has credentials to link one.",
        summary_keys: None,
        run: ops_portfolio::status,
    },
    Op {
        name: "portfolio.summary",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "Total value, cost, cash and unrealised P/L across linked accounts, as of the last sync.",
        summary_keys: None,
        run: ops_portfolio::summary,
    },
    Op {
        name: "portfolio.holdings",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "The largest positions with quantity, price, market value and P/L.",
        summary_keys: None,
        run: ops_portfolio::holdings,
    },
    Op {
        name: "portfolio.history",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "Portfolio value over time as date/value points.",
        summary_keys: None,
        run: ops_portfolio::history,
    },
    Op {
        name: "portfolio.allocation",
        tier: Tier::Read,
        timeout_ms: 10_000,
        summary: "Allocation broken down by label and value.",
        summary_keys: None,
        run: ops_portfolio::allocation,
    },
    // --- outbound data fetches ---
    Op {
        name: "data.weather",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Current conditions and a short forecast for a city or lat/lon.",
        summary_keys: None,
        run: ops_data::weather,
    },
    Op {
        name: "data.stocks",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Latest quotes plus index levels. Optional 'symbols', an array of up to 25 ticker symbols (AAPL, BRK.B); with none it returns the dashboard's default set.",
        summary_keys: None,
        run: ops_data::stocks,
    },
    Op {
        name: "data.news",
        tier: Tier::Read,
        timeout_ms: 20_000,
        summary: "Top headlines for a news category.",
        summary_keys: None,
        run: ops_data::news,
    },
    // --- local app data. Each is pinned to one table by ops_db.rs. ---
    Op {
        name: "tasks.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "The user's tasks. Optional 'filters' {completed, priority, due_date}, 'order_by', 'limit'.",
        summary_keys: None,
        run: ops_db::tasks,
    },
    Op {
        name: "notes.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "The user's notes, most recently updated first.",
        summary_keys: None,
        run: ops_db::notes,
    },
    Op {
        name: "events.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "Calendar events, earliest start first.",
        summary_keys: None,
        run: ops_db::events,
    },
    Op {
        name: "watchlist.list",
        tier: Tier::Read,
        timeout_ms: 5_000,
        summary: "Ticker symbols the user is watching.",
        summary_keys: None,
        run: ops_db::watchlist,
    },
    // --- local app data, written. Each is pinned to one table by ops_write.rs,
    //     and the row's owner comes from the request's identity, never its
    //     arguments. Reversible in the app, audited before dispatch. ---
    Op {
        name: "tasks.create",
        tier: Tier::Write,
        timeout_ms: 5_000,
        summary: "Add a task. Needs 'title'; optional 'priority' (low|medium|high) and 'due_date' (a date, or a datetime with a UTC offset).",
        summary_keys: None,
        run: ops_write::tasks_create,
    },
    Op {
        name: "tasks.update",
        tier: Tier::Write,
        timeout_ms: 5_000,
        summary: "Change a task. Needs 'id' from tasks.list plus at least one of 'title', 'completed', 'priority', 'due_date' (null clears the due date).",
        summary_keys: None,
        run: ops_write::tasks_update,
    },
    Op {
        name: "notes.create",
        tier: Tier::Write,
        timeout_ms: 5_000,
        summary: "Write a note. Needs 'title'; optional 'content'.",
        summary_keys: None,
        run: ops_write::notes_create,
    },
    Op {
        name: "notes.update",
        tier: Tier::Write,
        timeout_ms: 5_000,
        summary: "Change a note. Needs 'id' from notes.list plus at least one of 'title', 'content' (null clears the body).",
        summary_keys: None,
        run: ops_write::notes_update,
    },
    Op {
        name: "events.create",
        tier: Tier::Write,
        timeout_ms: 5_000,
        summary: "Add a calendar event. Needs 'title' and 'start_time'; optional 'end_time', 'description', 'location', 'attendees'. Times need a UTC offset or must be a plain date.",
        summary_keys: None,
        run: ops_write::events_create,
    },
    Op {
        name: "watchlist.add",
        tier: Tier::Write,
        timeout_ms: 5_000,
        summary: "Watch a ticker. Needs 'symbol' (e.g. AAPL); optional 'name'. Adding one that is already there reports 'unchanged' rather than failing.",
        summary_keys: None,
        run: ops_write::watchlist_add,
    },
    // --- music transport. Nothing in a table changes; the room does. ---
    //
    // music.next and music.previous are ABSENT, and the reason is that they do
    // not work rather than that they are unsafe: music_engine.rs holds a queue
    // of exactly one track (:150-157 — nothing ever loads more), so Next and
    // Prev take the `if index + 1 < queue.len()` branch that does nothing, on
    // every call, from every caller. Registering them would give the model two
    // tools that always succeed and never act, and it would then tell the user
    // it had skipped a track. When playlist queueing lands (the follow-up noted
    // at music_engine.rs:11) they are two lines here.
    Op {
        name: "music.play",
        tier: Tier::Actuate,
        timeout_ms: 20_000,
        summary: "Play through the Atlas speaker device. With 'uri' (a spotify:track: uri from music.search) it starts that track; with no argument it resumes. Returns once the playback engine has accepted the command, which is before sound comes out.",
        summary_keys: Some(&["uri"]),
        run: ops_music::play,
    },
    Op {
        name: "music.pause",
        tier: Tier::Actuate,
        timeout_ms: 20_000,
        summary: "Pause playback on the Atlas speaker device. No arguments.",
        summary_keys: Some(&[]),
        run: ops_music::pause,
    },
    Op {
        name: "music.volume",
        tier: Tier::Actuate,
        timeout_ms: 20_000,
        summary: "Set output volume. Needs 'level', a fraction from 0.0 (silent) to 1.0 (full) — not a percentage.",
        summary_keys: Some(&["level"]),
        run: ops_music::volume,
    },
    // --- smart home. The lock rule, as three table rows. ---
    Op {
        name: "home.device_set",
        tier: Tier::Actuate,
        timeout_ms: 20_000,
        summary: "Set one device's value: brightness or position 0-100, volume 0-100, temperature in degrees. Needs 'device_id' from home.list and 'value'. Refuses a lock or a garage door — those are home.lock_set.",
        summary_keys: Some(&["device_id", "value"]),
        run: ops_home::device_set,
    },
    Op {
        name: "home.scene_run",
        tier: Tier::Actuate,
        timeout_ms: 20_000,
        summary: "Apply a scene. Needs 'scene_id' from home.list. Refuses any scene whose 'runnable_by_atlas' is false — one that can change a lock, or one the bridge will not say the contents of.",
        summary_keys: Some(&["scene_id"]),
        run: ops_home::scene_run,
    },
    // APPROVAL, ON BOTH PROFILES, IN BOTH DIRECTIONS. The design's own autonomy
    // rule is "Atlas can lock, but only you unlock" (src/lib/mocks/
    // smartHome.ts:419) — this is that sentence with teeth, and it is stricter
    // than the sentence on purpose: an Atlas that can lock the house unattended
    // can lock somebody out of it. `Tier::Approval` never auto-runs, so both
    // directions cost the user one click and neither costs them a door.
    Op {
        name: "home.lock_set",
        tier: Tier::Approval,
        timeout_ms: 20_000,
        summary: "Lock or unlock a door. Needs 'device_id' from home.list and 'locked' (true to lock, false to unlock). Always asks the user first, in both directions.",
        summary_keys: Some(&["device_id", "locked"]),
        run: ops_home::lock_set,
    },
    // --- mail. Approval tier: see the block above `archive` in ops_mail.rs. ---
    Op {
        name: "mail.archive",
        tier: Tier::Approval,
        timeout_ms: 20_000,
        summary: "File a thread away (status 'handled'), on the mail server and locally. Needs 'thread_id' from mail.list_threads. Always asks the user first.",
        summary_keys: Some(&["thread_id"]),
        run: ops_mail::archive,
    },
    Op {
        name: "mail.mark_read",
        tier: Tier::Approval,
        timeout_ms: 20_000,
        summary: "Clear a thread's unread badge, on the mail server and locally. Needs 'thread_id' from mail.list_threads. Always asks the user first.",
        summary_keys: Some(&["thread_id"]),
        run: ops_mail::mark_read,
    },
];

/// Resolve an op by name.
///
/// A linear scan of `OPS` rather than a `match`, precisely so there is no
/// catch-all arm anywhere: an op is reachable if and only if somebody wrote a
/// line for it in the table above. Thirty-one entries make the scan free, and if
/// the table ever grows past the point where that is true, the fix is a map
/// built from the same table — never a pattern that can match a name nobody
/// listed.
pub fn lookup(name: &str) -> Option<&'static Op> {
    OPS.iter().find(|op| op.name == name)
}

// ---------------------------------------------------------------------------
// What an approvals card is allowed to say about its target
// ---------------------------------------------------------------------------

/// An identifying argument that names a row in Atlas' local mirror, plus the
/// columns of that row a card may show.
///
/// This lives in registry.rs because it is a CAPABILITY DECLARATION — "the
/// approvals path may read these columns of this table" — and the answer to
/// "what can the control port touch?" has to be answerable from this file alone.
///
/// KEYED ON THE ARGUMENT NAME, NOT THE OP NAME, deliberately. The key used is
/// `summary_keys[0]`, which is already defined as the op's identifying field, so
/// a new op that identifies its target with `thread_id` gets the same card
/// without anybody remembering to extend a per-op list — and a per-op list is
/// exactly the thing that silently omits the next op.
struct ObjectLookup {
    id_arg: &'static str,
    source: ObjectSource,
    columns: &'static [&'static str],
}

/// Where a card's object is read from, and therefore which guard proves the
/// card cannot see more than a read op already publishes.
///
/// TWO SOURCES BECAUSE THERE ARE TWO READ SURFACES, not because one was
/// convenient. `ops_db` publishes a generic column matrix that db-backed ops
/// share; the home module owns its own reads (`home.list` projects a snapshot,
/// not a table), so its tables are deliberately NOT in that matrix and a lookup
/// against them has to be checked against the home module's own published
/// columns instead. Both are checked — see
/// `a_card_lookup_reads_only_what_the_read_allowlist_publishes`.
enum ObjectSource {
    /// A row in Atlas' generic local mirror, read through `ops_db`'s matrix.
    Db(&'static str),
    /// A smart-home device, read through `ops_home` (which is scanned by the
    /// allowlist; registry.rs is not, which is why the call lives there).
    HomeDevice,
    /// A smart-home scene.
    HomeScene,
}

const OBJECT_LOOKUPS: &[ObjectLookup] = &[
    ObjectLookup {
        id_arg: "thread_id",
        source: ObjectSource::Db("mail_threads"),
        // Both are already in ops_db's `mail_threads` read allowlist, so this
        // grants the card nothing a read op could not already return. `subject`
        // answers "which mail is this?"; `participants` answers "whose".
        columns: &["subject", "participants"],
    },
    ObjectLookup {
        id_arg: "device_id",
        source: ObjectSource::HomeDevice,
        // THE WHOLE REASON THIS ENTRY EXISTS. `home.lock_set`'s device_id is a
        // uuid Atlas minted during a sync; no screen shows it. Without a lookup
        // the approvals card reads `device_id="8f3a…"` and the click means
        // "yes to whatever you had in mind". With it the card reads
        // "Front door lock · Hall", which is a decision a person can make.
        // `room_name` is not decoration: two rooms' worth of "Ceiling light" is
        // exactly the case where the name alone is not consent.
        columns: ops_home::DEVICE_CARD,
    },
    ObjectLookup {
        id_arg: "scene_id",
        source: ObjectSource::HomeScene,
        columns: ops_home::SCENE_CARD,
    },
];

/// What the approvals card can be told about the object an op would act on.
pub enum CardTarget {
    /// This op's identifying field does not name a local row — `music.play`
    /// identifies a Spotify uri, which has no local mirror. The card is the
    /// argument line alone, which for a uri is already legible.
    None,
    Found {
        columns: &'static [&'static str],
        row: Value,
    },
    /// The id resolved to nothing. `shown` is already bounded for echoing.
    Missing {
        id_arg: &'static str,
        shown: String,
    },
    /// The lookup itself failed, so nothing is known either way.
    Unreadable(String),
}

/// Which lookup, if any, an op's identifying field selects.
///
/// Pure and separate from `card_target` for the reason the rest of this module
/// splits the same way: the decision (which table may be read, on behalf of which
/// op) is the part that can be silently wrong, and a function that needs a live
/// `AppHandle` cannot be unit-tested.
fn object_lookup(op: &Op) -> Option<&'static ObjectLookup> {
    op.summary_keys
        .and_then(|keys| keys.first())
        .and_then(|key| OBJECT_LOOKUPS.iter().find(|l| l.id_arg == *key))
}

/// Resolve the object an approval would act on, from the LOCAL mirror.
///
/// Goes through `ops_db::read_one` or, for the home lookups, `ops_home`'s two
/// card readers. Both mean the same three things: scoped to the authenticated
/// user in SQL, projected to a reviewed column list, and unable to return a row
/// from another account. The caller supplies only the id.
pub fn card_target(
    app: &tauri::AppHandle,
    ctx: &crate::control::Ctx,
    op: &Op,
    args: &Value,
) -> CardTarget {
    let Some(lookup) = object_lookup(op) else {
        return CardTarget::None;
    };

    let id = args
        .get(lookup.id_arg)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    let resolved = match lookup.source {
        ObjectSource::Db(table) => ops_db::read_one(app, table, &id, ctx),
        ObjectSource::HomeDevice => ops_home::card_for_device(app, ctx, &id),
        ObjectSource::HomeScene => ops_home::card_for_scene(app, ctx, &id),
    };

    match resolved {
        Ok(Some(row)) => CardTarget::Found {
            columns: lookup.columns,
            row,
        },
        Ok(None) => CardTarget::Missing {
            id_arg: lookup.id_arg,
            // Bounded before it is echoed: an id that resolves to nothing is
            // exactly where a hostile value turns up, and the refusal is read
            // back by the model.
            shown: ops_project::snippet(&id),
        },
        Err(e) => CardTarget::Unreadable(e),
    }
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
    use crate::control::{policy, Profile};
    use std::collections::BTreeSet;

    // -----------------------------------------------------------------------
    // Layer 1: the ALLOWLIST — only these underlying commands may be called
    // -----------------------------------------------------------------------

    /// Every `crate::…` path a runner is allowed to name.
    ///
    /// THIS IS THE PRIMARY GUARD, and it is an allowlist because a denylist
    /// answers the wrong question. `DENIED` below proves "not these twelve";
    /// what a reviewer needs is "only these", so that a command added to db.rs
    /// or mail.rs next month is unreachable until a human writes a line here.
    /// The test fails CLOSED: an unrecognised path is a failure, not a warning.
    ///
    /// Types are in the list alongside functions because the extractor cannot
    /// tell them apart — `crate::db::DbState` and `crate::db::db_select` are the
    /// same shape of text. That is fine; a type is a capability too (naming
    /// `MusicState` is how a runner reaches the Spotify session at all).
    ///
    /// WHAT THIS CANNOT SEE — stated plainly, because a guard whose limits are
    /// undocumented gets trusted past them:
    ///   * It is a text scan of source, not a call graph. It proves which names
    ///     a runner MENTIONS, not which code actually runs.
    ///   * A helper defined in a NON-runner file (mod.rs, audit.rs) and called
    ///     as `super::…` is invisible here. Those files are covered by
    ///     `every_file_in_the_control_module_is_classified` — which forces a
    ///     human to classify any new file — and by review, not by this list.
    ///   * A path built by a macro is invisible. Nothing in these files does
    ///     that today; if something starts to, this comment is wrong and has to
    ///     change with it.
    ///
    /// Three holes that WOULD have been invisible are closed by
    /// `runner_imports_stay_scannable` instead of being documented away:
    /// `use … as` renames, glob imports, and grouped/module-level `use crate::`
    /// forms that leave the call site reading `db::db_delete`.
    const ALLOWED_COMMANDS: &[&str] = &[
        // The control port's own types, threaded through every runner.
        "crate::control::Ctx",
        "crate::control::Profile",
        // Local database. Reads via db_select; writes via db_insert/db_update,
        // both pinned to one table per runner by ops_write.rs. No delete.
        "crate::db::DbState",
        "crate::db::db_select",
        "crate::db::db_insert",
        "crate::db::db_update",
        // Outbound data fetches.
        "crate::datafetch::fetch_weather",
        "crate::datafetch::fetch_stocks",
        "crate::datafetch::fetch_news",
        // Music: catalogue reads, then the three transport actuations.
        "crate::music::MusicState",
        "crate::music::music_status",
        "crate::music::music_search",
        "crate::music::music_library_tracks",
        "crate::music::music_playlists",
        "crate::music::music_playlist_tracks",
        "crate::music::music_now_playing",
        "crate::music::music_load",
        "crate::music::music_play",
        "crate::music::music_pause",
        "crate::music::music_volume",
        // Smart home. The read is the whole snapshot projection (the home
        // module owns its own SQL, so no db_select appears for it); the three
        // mutations are the only ways to the house, and `home_lock_set` is the
        // only way to a lock. Deliberately ABSENT: home_link_home_assistant and
        // home_unlink (they write a Keychain credential), home_sync (a
        // bridge-wide network pull nobody asked for) and home_set_autonomy
        // (there is nothing to set — see ops_home.rs).
        // The HomeKit browse. A READ that puts one multicast query on the LAN
        // and can pair nothing — `crate::home::home_homekit_pair` is
        // deliberately absent and is on DENIED below, because pairing needs a
        // setup code the user reads off the accessory.
        "crate::home::home_homekit_discover",
        "crate::home::home_snapshot",
        "crate::home::home_device_set",
        "crate::home::home_scene_run",
        "crate::home::home_lock_set",
        // The approvals card's two readers, plus the column lists they return.
        "crate::home::card_device",
        "crate::home::card_scene",
        "crate::home::DEVICE_CARD_COLUMNS",
        "crate::home::SCENE_CARD_COLUMNS",
        // Health. THREE READS AND NOTHING ELSE — the surface tells the user
        // "Atlas can read your health data, never change it", and this is where
        // that is true or decoration. Deliberately ABSENT: health_import (it
        // takes a filesystem path and reports what it found there, which is a
        // file-probing primitive) and the command that erases a person's whole
        // health history. Both are on DENIED below as well.
        "crate::health::health_snapshot",
        "crate::health::health_series",
        "crate::health::health_workouts",
        "crate::health::metric_names",
        // Mail: the two Approval-tier mutations. Reads come from the local
        // mirror through db_select, so no mail read command is listed.
        "crate::mail::mail_mark_read",
        "crate::mail::mail_set_status",
        // Portfolio: analytics reads only.
        "crate::portfolio::portfolio_status",
        "crate::portfolio::portfolio_summary",
        "crate::portfolio::portfolio_holdings",
        "crate::portfolio::portfolio_history",
        "crate::portfolio::portfolio_allocation",
    ];

    /// Pull every `crate::<module>::<item>` a source mentions.
    ///
    /// Two segments, deliberately: a deeper path like `crate::db::inner::foo`
    /// is captured as `crate::db::inner`, which is not in the allowlist, so it
    /// FAILS rather than being silently accepted at a coarser granularity.
    fn crate_paths(source: &str) -> BTreeSet<String> {
        const MARK: &str = "crate::";
        let bytes = source.as_bytes();
        let ident_end = |from: usize| {
            let mut i = from;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            i
        };

        let mut found = BTreeSet::new();
        let mut cursor = 0usize;
        while let Some(rel) = source[cursor..].find(MARK) {
            let module_start = cursor + rel + MARK.len();
            let module_end = ident_end(module_start);
            if module_end > module_start && source[module_end..].starts_with("::") {
                let item_start = module_end + 2;
                let item_end = ident_end(item_start);
                if item_end > item_start {
                    found.insert(format!(
                        "crate::{}::{}",
                        &source[module_start..module_end],
                        &source[item_start..item_end]
                    ));
                }
            }
            cursor = module_start;
        }
        found
    }

    #[test]
    fn every_command_a_runner_names_is_on_the_allowlist() {
        let allowed: BTreeSet<&str> = ALLOWED_COMMANDS.iter().copied().collect();
        for (file, source) in RUNNER_SOURCES {
            for path in crate_paths(source) {
                assert!(
                    allowed.contains(path.as_str()),
                    "{file} names {path}, which nobody has reviewed. Add it to \
                     ALLOWED_COMMANDS in registry.rs — deliberately, with the absence \
                     notes above OPS read first — or stop calling it."
                );
            }
        }
    }

    /// The allowlist is only as good as the extractor's ability to see call
    /// sites. Three import forms defeat it, so all three are refused outright:
    /// `use crate::db::db_delete as save;` (the call site reads `save(…)`),
    /// `use crate::db::*;` (it reads `db_delete(…)`), and `use crate::db;` or
    /// `use crate::{db, mail};` (it reads `db::db_delete(…)`, and the `use`
    /// line itself carries no two-segment path for the scan to record).
    #[test]
    fn runner_imports_stay_scannable() {
        for (file, source) in RUNNER_SOURCES {
            for line in source.lines() {
                let trimmed = line.trim_start();
                let is_use = trimmed.starts_with("use crate::")
                    || trimmed.starts_with("pub use crate::");
                if !is_use {
                    continue;
                }
                assert!(
                    !trimmed.contains(" as "),
                    "{file}: `{trimmed}` renames a crate item, and the allowlist cannot \
                     follow a rename. Import it under its own name."
                );
                assert!(
                    !trimmed.contains('*') && !trimmed.contains('{'),
                    "{file}: `{trimmed}` is a glob or grouped import, which hides the \
                     command names from the allowlist. One full path per use."
                );
                assert!(
                    !crate_paths(trimmed).is_empty(),
                    "{file}: `{trimmed}` imports a module rather than an item, so the \
                     call site reads `module::command` and the allowlist never sees it."
                );
            }
        }
    }

    /// Baseline for the extractor. Without this, a `crate_paths` that returned
    /// an empty set would make every allowlist assertion above vacuously true.
    #[test]
    fn the_extractor_finds_what_is_there() {
        let paths = crate_paths(
            "use crate::music::MusicState;\n let x = crate::db::db_select(a);\n \
             // crate::db::db_insert in a comment counts too\n crate::db::inner::deep()",
        );
        assert!(paths.contains("crate::music::MusicState"));
        assert!(paths.contains("crate::db::db_select"));
        assert!(paths.contains("crate::db::db_insert"));
        // A three-segment path is captured at two segments, which is not on any
        // allowlist — so it fails closed rather than passing coarsely.
        assert!(paths.contains("crate::db::inner"));
        assert!(!paths.contains("crate::db::deep"));

        // And it really does look at the live files: the runners must between
        // them name something, or the whole guard is scanning nothing.
        let total: usize = RUNNER_SOURCES.iter().map(|(_, s)| crate_paths(s).len()).sum();
        assert!(total >= 20, "only {total} crate paths found across the runners");
    }

    #[test]
    fn the_allowlist_itself_is_well_formed() {
        let mut seen = BTreeSet::new();
        for path in ALLOWED_COMMANDS {
            assert!(seen.insert(*path), "duplicate allowlist entry {path}");
            assert!(
                path.starts_with("crate::") && path.matches("::").count() == 2,
                "{path} is not a two-segment crate path, so nothing will ever match it"
            );
        }
        // An allowlist entry nobody uses is either a capability that was
        // removed without cleaning up, or a grant somebody added "for later" —
        // both of which quietly widen what a future runner may reach.
        let referenced: BTreeSet<String> = RUNNER_SOURCES
            .iter()
            .flat_map(|(_, source)| crate_paths(source))
            .collect();
        for path in ALLOWED_COMMANDS {
            assert!(
                referenced.contains(*path),
                "{path} is allowed but nothing calls it; remove the grant rather than \
                 leaving it standing"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Layer 2: the DENYLIST — belt and braces
    // -----------------------------------------------------------------------

    /// The commands that must never be reachable from the control port.
    ///
    /// Redundant with the allowlist by construction, and kept anyway. The two
    /// fail differently: the allowlist stops a command nobody reviewed, this
    /// stops a command somebody reviewed and REJECTED. If a future edit widens
    /// `ALLOWED_COMMANDS` carelessly, this is the layer that still says no —
    /// and the reasoning for each entry is in the block comment above `OPS`,
    /// which is the thing a reviewer actually has to read.
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
        "health_import",
        "health_forget",
        // Pairing with a HomeKit accessory. Takes the 8-digit setup code from
        // the accessory's label and leaves a permanent key behind; see the
        // absence note in ops_home.rs.
        "home_homekit_pair",
    ];

    /// The runner modules, paired with their source text.
    ///
    /// `include_str!` rather than a field on `Op`: a runner is a fn pointer, so
    /// there is no way to ask an entry in `OPS` which `#[tauri::command]` it
    /// ends up calling. What CAN be checked is the text of the files those
    /// runners live in — which is the property that matters, since a forbidden
    /// call would have to be written into one of them.
    ///
    /// registry.rs itself is excluded on purpose: it is the file that must name
    /// every denied command, both in `DENIED` and in the comment explaining the
    /// absence, and a scan that included it could never pass. That exclusion is
    /// what `every_runner_lives_in_a_scanned_module` exists to make safe — it
    /// keeps executable code out of the one file neither scan reads.
    const RUNNER_SOURCES: &[(&str, &str)] = &[
        ("ops_data.rs", include_str!("ops_data.rs")),
        ("ops_db.rs", include_str!("ops_db.rs")),
        ("ops_health.rs", include_str!("ops_health.rs")),
        ("ops_home.rs", include_str!("ops_home.rs")),
        ("ops_mail.rs", include_str!("ops_mail.rs")),
        ("ops_music.rs", include_str!("ops_music.rs")),
        ("ops_portfolio.rs", include_str!("ops_portfolio.rs")),
        ("ops_project.rs", include_str!("ops_project.rs")),
        ("ops_write.rs", include_str!("ops_write.rs")),
    ];

    /// Files in src/control that are NOT runners, and are therefore covered by
    /// the allowlist only indirectly. Listing them is what turns "the scan
    /// globs ops_*.rs" from a silent gap into a compile-time decision: a new
    /// file has to be put in one list or the other by a person.
    const NON_RUNNER_SOURCES: &[&str] = &[
        "mod.rs",
        "registry.rs",
        "policy.rs",
        "audit.rs",
        "auth.rs",
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

    /// The slice of this file that IS the capability table.
    ///
    /// Scoped rather than whole-file on purpose: everything outside these
    /// brackets — `DENIED`, the absence notes, this test module — is allowed to
    /// name things the table may not contain, and a scan that could not tell
    /// the difference would have to be weakened until it proved nothing.
    fn ops_table() -> &'static str {
        let src = include_str!("registry.rs");
        let from = src.find("pub static OPS: &[Op] = &[").expect("the table exists");
        let rest = &src[from..];
        &rest[..rest.find("\n];\n").expect("the table has an end")]
    }

    /// The hole the two scans above share.
    ///
    /// Both read `RUNNER_SOURCES`, and registry.rs is deliberately not in it.
    /// But `Op::run` is a `fn` pointer and a NON-CAPTURING CLOSURE coerces to
    /// one — the pattern already compiles in this tree (mod.rs:939-947,
    /// audit.rs:446-454 both use it). So a runner written inline in the table
    /// above would be executable code in the one file the allowlist never reads
    /// and the denylist never scans: a closure calling `crate::db::db_delete`
    /// would pass every guard here except `EXPECTED_TIERS`, which one added line
    /// satisfies.
    ///
    /// Closed by refusing the SHAPE, not by scanning registry.rs for command
    /// names — that would make `DENIED` and the absence notes unwritable. Every
    /// `run:` must be a path into a module that IS in `RUNNER_SOURCES`, so the
    /// code an op executes always lives somewhere both guards read.
    /// Each op paired with the literal text of its `run:` value, read off the
    /// table rather than off `OPS` — a `fn` pointer cannot be asked where it
    /// came from, which is the whole reason the hole below exists.
    /// The cargo feature an op's table entry is gated on, if any.
    ///
    /// Read off the TEXT, because that is the only place a cfg attribute
    /// survives — the compiler has resolved and erased it long before anything
    /// can ask `OPS` which entries carried one. Reading it here is what lets
    /// the same test file assert, in BOTH builds, that a HomeKit op is
    /// registered if and only if the feature is on.
    const HOMEKIT_GATE: &str = "#[cfg(feature = \"homekit\")]";

    fn declared_runners() -> Vec<DeclaredRunner> {
        let mut out = Vec::new();
        let mut name: Option<&str> = None;
        let mut gated = false;
        for line in ops_table().lines() {
            let trimmed = line.trim();
            if trimmed == HOMEKIT_GATE {
                gated = true;
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("name: \"") {
                name = rest.split('"').next();
            }
            if let Some(value) = trimmed.strip_prefix("run: ") {
                out.push(DeclaredRunner {
                    op: name.take().expect("a run: with no name: above it"),
                    run: value.trim_end_matches(','),
                    homekit_only: std::mem::take(&mut gated),
                });
            }
        }
        out
    }

    struct DeclaredRunner {
        op: &'static str,
        run: &'static str,
        homekit_only: bool,
    }

    impl DeclaredRunner {
        /// Is this entry compiled into the build the test is running in?
        fn compiled(&self) -> bool {
            !self.homekit_only || cfg!(feature = "homekit")
        }
    }

    /// THE FEATURE GATE, PROVED FROM BOTH SIDES.
    ///
    /// The Rust crate is shared by Atlas.app and Lighthouse, and the control
    /// port is a REGISTRY rather than a webview: an op that is in `OPS` is
    /// reachable by the model in whichever bundle was built, regardless of
    /// which React screens shipped. So a HomeKit op that lost its `#[cfg]`
    /// would put a working HomeKit accessory controller in front of every
    /// consumer's model with no screen, no consent and no notice.
    ///
    /// Both directions are checked, and neither can go vacuous: the table must
    /// declare at least one gated op (or the test is testing nothing), every
    /// gated op must resolve exactly when the feature is on, and every op that
    /// is NOT gated must resolve in both builds.
    #[test]
    fn no_homekit_op_is_reachable_without_the_cargo_feature() {
        let runners = declared_runners();
        let gated: Vec<&str> = runners.iter().filter(|r| r.homekit_only).map(|r| r.op).collect();
        assert!(
            !gated.is_empty(),
            "no op in the table carries {HOMEKIT_GATE}, so this test proves nothing. Either the \
             HomeKit ops were removed — delete this test with them — or the attribute was dropped."
        );
        for name in &gated {
            assert_eq!(
                lookup(name).is_some(),
                cfg!(feature = "homekit"),
                "{name} carries {HOMEKIT_GATE} but {}",
                if cfg!(feature = "homekit") {
                    "does not resolve in a build WITH the feature"
                } else {
                    "still resolves in a build WITHOUT it — the consumer bundle would expose it"
                }
            );
        }
        for r in runners.iter().filter(|r| !r.homekit_only) {
            assert!(lookup(r.op).is_some(), "{} is ungated but does not resolve", r.op);
        }
        // And the runner module agrees: its function carries the same gate, or
        // the build with the feature off would not compile at all — which is
        // itself the guarantee, stated here so the next reader knows why there
        // is no separate assertion for it.
        let (_, ops_home_src) = RUNNER_SOURCES
            .iter()
            .find(|(f, _)| *f == "ops_home.rs")
            .expect("ops_home.rs is a runner");
        assert!(
            ops_home_src.contains(&format!("{HOMEKIT_GATE}\npub fn discover")),
            "ops_home::discover lost its feature gate"
        );
    }

    #[test]
    fn every_runner_lives_in_a_scanned_module() {
        let runners: Vec<(&str, &str)> = declared_runners()
            .iter()
            .filter(|r| r.compiled())
            .map(|r| (r.op, r.run))
            .collect();
        for (op, value) in &runners {
            let Some((module, item)) = value.split_once("::") else {
                panic!(
                    "{op}'s `run: {value}` is not a path into a runner module. An inline \
                     closure is executable code in registry.rs, which neither \
                     ALLOWED_COMMANDS nor DENIED can see — put the runner in an ops_* module."
                );
            };
            assert!(
                RUNNER_SOURCES.iter().any(|(f, _)| *f == format!("{module}.rs")),
                "{op}'s `run: {value}` names '{module}', which is not in RUNNER_SOURCES, so \
                 nothing scans the code this op actually executes"
            );
            assert!(
                !item.is_empty() && item.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "{op}'s `run: {value}` is not a plain function path"
            );
        }
        // Without this the whole test is vacuous the moment the table's
        // formatting changes and `strip_prefix` stops matching anything.
        assert_eq!(runners.len(), OPS.len(), "found {} runners for {} ops", runners.len(), OPS.len());
    }

    // -----------------------------------------------------------------------
    // The approvals card
    // -----------------------------------------------------------------------

    /// Every op that can reach the approvals queue, and the exact fields a human
    /// reviewed for its card.
    ///
    /// Written down twice for the same reason `EXPECTED_TIERS` is, and with a
    /// sharper consequence: this list IS the consent. A key here that the runner
    /// never reads renders `key=<not set>` on the button forever; a key the
    /// runner DOES read and that is missing here is an argument the user
    /// approves without ever seeing. Neither is something a compiler can judge.
    ///
    /// `music.pause` declares `&[]` — it genuinely takes no arguments, which the
    /// card says outright rather than leaving blank.
    const EXPECTED_CARDS: &[(&str, &[&str])] = &[
        ("music.play", &["uri"]),
        ("music.pause", &[]),
        ("music.volume", &["level"]),
        ("mail.archive", &["thread_id"]),
        ("mail.mark_read", &["thread_id"]),
        ("home.device_set", &["device_id", "value"]),
        ("home.scene_run", &["scene_id"]),
        // Both fields, in this order. `device_id` identifies (and resolves to
        // "Front door lock · Hall" through OBJECT_LOOKUPS); `locked` is the
        // whole content of the decision, and a card that showed only the door
        // would ask the user to approve "do something to the front door".
        ("home.lock_set", &["device_id", "locked"]),
    ];

    #[test]
    fn every_declared_card_is_the_one_a_human_reviewed() {
        for op in OPS {
            let reviewed = EXPECTED_CARDS.iter().find(|(name, _)| *name == op.name);
            match (op.summary_keys, reviewed) {
                (Some(keys), Some((_, expected))) => assert_eq!(
                    keys, *expected,
                    "{} renders a card nobody reviewed",
                    op.name
                ),
                (Some(keys), None) => panic!(
                    "{} declares the card {keys:?} but is not in EXPECTED_CARDS — a card is \
                     what the user consents to, so it is reviewed before it ships",
                    op.name
                ),
                (None, Some(_)) => panic!(
                    "{} has a reviewed card but declares none, so queue_for_approval will \
                     refuse it and the op is unusable",
                    op.name
                ),
                // A read or a local write that can never queue. `None` is the
                // fail-closed default and needs no card.
                (None, None) => {}
            }
        }
        for (name, _) in EXPECTED_CARDS {
            assert!(lookup(name).is_some(), "{name} has a reviewed card but is not registered");
        }
    }

    /// Which op resolves its target against which local table, reviewed by hand.
    ///
    /// The consequence of getting this wrong runs in both directions, which is why
    /// the test below checks both. An op that LOSES its entry goes back to the
    /// card that started this — `mail.archive with thread_id="9f2c…"`, a uuid the
    /// user has never seen on any screen, so the consent decision has no content.
    /// An op that GAINS one starts reading a table on the approvals path, and
    /// "which tables can this port touch?" must stay answerable from this file.
    const EXPECTED_CARD_OBJECTS: &[(&str, &str)] = &[
        ("mail.archive", "db:mail_threads"),
        ("mail.mark_read", "db:mail_threads"),
        // Every home op that can be queued names a real thing. `home.device_set`
        // and `home.scene_run` are Actuate and therefore queue on the background
        // profile; `home.lock_set` queues always.
        ("home.device_set", "home:device"),
        ("home.lock_set", "home:device"),
        ("home.scene_run", "home:scene"),
    ];

    /// The reviewed name for a source, so the table above stays readable.
    fn source_name(source: &ObjectSource) -> String {
        match source {
            ObjectSource::Db(table) => format!("db:{table}"),
            ObjectSource::HomeDevice => "home:device".to_string(),
            ObjectSource::HomeScene => "home:scene".to_string(),
        }
    }

    #[test]
    fn every_card_that_can_name_a_local_object_does() {
        for op in OPS {
            let reviewed = EXPECTED_CARD_OBJECTS
                .iter()
                .find(|(name, _)| *name == op.name)
                .map(|(_, source)| (*source).to_string());
            let resolved = object_lookup(op).map(|l| source_name(&l.source));
            assert_eq!(
                resolved, reviewed,
                "{} resolves its approvals card against {resolved:?} but {reviewed:?} was \
                 reviewed. Losing the lookup means the card names only an opaque id; gaining \
                 one means the approvals path reads a table nobody signed off on",
                op.name
            );
        }
        for (name, _) in EXPECTED_CARD_OBJECTS {
            assert!(lookup(name).is_some(), "{name} is reviewed but not registered");
        }
    }

    /// A card lookup must not be able to read anything a read op could not.
    ///
    /// `card_target` runs on the approvals path, before any consent exists, so if
    /// it could name a table or a column outside a published read surface it
    /// would be a second, unreviewed read surface reachable by a queued call.
    ///
    /// THE TWO SOURCES ARE CHECKED DIFFERENTLY BECAUSE THEY PUBLISH DIFFERENTLY,
    /// not because the home one is checked more loosely. A `Db` lookup answers
    /// to `ops_db`'s column matrix. A `Home` lookup answers to the home module's
    /// own published card columns — and that constant is not a second opinion:
    /// `home::tests::the_card_columns_are_the_ones_the_store_returns` proves it
    /// is exactly what the SQL returns, and that the same strings appear in the
    /// snapshot `home.list` projects from, so the card still shows nothing a
    /// read could not.
    #[test]
    fn a_card_lookup_reads_only_what_the_read_allowlist_publishes() {
        for lookup in OBJECT_LOOKUPS {
            assert!(
                !lookup.columns.is_empty(),
                "the card for '{}' shows no columns",
                lookup.id_arg
            );
            match lookup.source {
                ObjectSource::Db(table) => {
                    let cap = ops_db::cap_for(table).unwrap_or_else(|| {
                        panic!(
                            "the card lookup for '{}' names the table '{table}', which the read \
                             allowlist does not publish",
                            lookup.id_arg
                        )
                    });
                    for col in lookup.columns {
                        assert!(
                            cap.columns.contains(col),
                            "the card for '{}' would show {table}.{col}, which is not in that \
                             table's read allowlist",
                            lookup.id_arg
                        );
                    }
                }
                ObjectSource::HomeDevice => assert_eq!(
                    lookup.columns,
                    ops_home::DEVICE_CARD,
                    "the device card declares columns the home module does not publish"
                ),
                ObjectSource::HomeScene => assert_eq!(
                    lookup.columns,
                    ops_home::SCENE_CARD,
                    "the scene card declares columns the home module does not publish"
                ),
            }
        }
    }

    /// The identifying field of a home card must resolve to a NAME, or the
    /// whole entry is decoration.
    ///
    /// This is the failure the OBJECT_LOOKUPS entries exist to prevent, stated
    /// as an assertion: `home.lock_set`'s device_id is a uuid Atlas minted
    /// during a sync and no screen ever shows, so a card without the lookup
    /// reads `device_id="8f3a…"` and the click means "yes to whatever you had
    /// in mind". `columns[0]` is the field guaranteed to survive truncation, so
    /// it is the one that has to be the human-readable one.
    #[test]
    fn the_home_cards_lead_with_a_name_a_person_could_recognise() {
        for lookup in OBJECT_LOOKUPS {
            let leads_with = lookup.columns[0];
            match lookup.source {
                ObjectSource::HomeDevice => assert_eq!(leads_with, "name"),
                ObjectSource::HomeScene => assert_eq!(leads_with, "label"),
                ObjectSource::Db(_) => {}
            }
        }
    }

    /// The autonomy rules the surface shows and the tiers that enforce them are
    /// two statements of the same fact, written in two files. This is what stops
    /// them disagreeing — a "may Atlas unlock doors" switch reading `allowed:
    /// true` next to an op that queues for approval would be the product lying
    /// about itself.
    #[test]
    fn the_autonomy_card_matches_the_tiers_that_enforce_it() {
        let rules = crate::home::autonomy();
        let allowed = |id: &str| -> bool {
            rules
                .as_array()
                .expect("autonomy is a list")
                .iter()
                .find(|r| r["id"] == json!(id))
                .unwrap_or_else(|| panic!("no autonomy rule '{id}'"))["allowed"]
                .as_bool()
                .expect("allowed is a bool")
        };

        let lock = lookup("home.lock_set").expect("registered");
        assert_eq!(lock.tier, Tier::Approval);
        // Both directions go through the one Approval-tier op, so neither may
        // claim to be something Atlas does on its own.
        assert!(!allowed("unlock"), "'unlock' claims autonomy the tier refuses");
        assert!(!allowed("lock"), "'lock' claims autonomy the tier refuses");

        // The two the tier table really does allow unattended, interactively.
        for (rule, op_name) in [("lights", "home.device_set"), ("scenes", "home.scene_run")] {
            assert!(allowed(rule), "'{rule}' is shown as forbidden but {op_name} is Actuate");
            assert_eq!(lookup(op_name).expect("registered").tier, Tier::Actuate);
        }
    }

    /// The health surface tells the user, in words, "Atlas can read your health
    /// data, never change it" (`health::privacy()`). This is the assertion that
    /// makes the sentence true rather than decorative.
    ///
    /// TWO DIRECTIONS, BOTH NEEDED. A health op that gained a write tier would
    /// make the sentence false while the screen kept saying it; the rule
    /// disappearing from `privacy()` would leave the read-only guarantee real
    /// but unstated, which is how the next person to add `health.import` gets
    /// no warning at all. The strict "every op whose name starts with `health.`"
    /// form is deliberate: it covers ops that do not exist yet.
    #[test]
    fn the_health_privacy_card_matches_the_tiers_that_enforce_it() {
        let rules = crate::health::privacy();
        let rules = rules.as_array().expect("privacy is a list");
        let read_only = rules
            .iter()
            .find(|r| r["id"] == json!("atlas_reads_only"))
            .expect("the surface claims Atlas' health tools are read-only");
        assert_eq!(read_only["enabled"], json!(true));

        let health_ops: Vec<&Op> = OPS.iter().filter(|op| op.name.starts_with("health.")).collect();
        assert!(
            !health_ops.is_empty(),
            "this test is vacuous with no health ops — delete it or fix the table"
        );
        for op in health_ops {
            assert_eq!(
                op.tier,
                Tier::Read,
                "{} is {} tier, but the health surface tells the user every health tool \
                 Atlas has is read-only. Change the sentence in health::privacy() or change \
                 the tier — they are two statements of one fact.",
                op.name,
                op.tier.as_str()
            );
            // Read tier cannot reach the approvals queue, so a card would be a
            // promise of a button nobody will ever be shown.
            assert!(op.summary_keys.is_none(), "{} declares a card it can never render", op.name);
        }
    }

    /// One function's body, from its signature to the first column-zero `}`.
    /// Same device as `ops_write.rs`'s `fn_body` and `mod.rs`'s `body_of`.
    fn fn_body<'a>(source: &'a str, item: &str) -> Option<&'a str> {
        // `fn {item}(` rather than `pub fn …`: the helpers a runner delegates to
        // are private.
        let start = source.find(&format!("fn {item}("))?;
        let rest = &source[start..];
        let end = rest.find("\n}\n").unwrap_or(rest.len());
        Some(&rest[..end])
    }

    /// Every identifier in `body` that appears as a call, `name(`.
    fn called_names(body: &str) -> BTreeSet<String> {
        let bytes: Vec<char> = body.chars().collect();
        let mut out = BTreeSet::new();
        let mut word = String::new();
        for c in bytes {
            if c.is_ascii_alphanumeric() || c == '_' {
                word.push(c);
            } else {
                if c == '(' && !word.is_empty() {
                    out.insert(word.clone());
                }
                word.clear();
            }
        }
        out
    }

    /// The text a card field may legitimately be read in: the runner's own body
    /// plus the bodies of the same-module helpers it calls, one level deep.
    ///
    /// One level, and no more, because that is where the real code puts it:
    /// `ops_mail::archive` reads its `thread_id` through the module's private
    /// `fn thread_id(args, op)` validator rather than inline. Following the whole
    /// call graph would end up back at whole-module scope, which is the hole this
    /// replaced; stopping at zero levels would reject correct code.
    fn read_scope(source: &str, item: &str) -> String {
        let body = fn_body(source, item)
            .unwrap_or_else(|| panic!("no `fn {item}(` in its declared module"));
        let mut scope = body.to_string();
        for name in called_names(body) {
            if name == item {
                continue;
            }
            if let Some(helper) = fn_body(source, &name) {
                scope.push('\n');
                scope.push_str(helper);
            }
        }
        scope
    }

    /// A declared field must be an argument THAT RUNNER actually reads.
    ///
    /// The failure this catches is quiet: a card that names `uri` for an op
    /// whose runner reads `track_uri` shows `uri=<not set>` on every approval,
    /// so the human is asked to consent to an action with no visible object at
    /// all — and nothing else in the build would notice.
    ///
    /// SCOPED TO THE RUNNER, NOT THE MODULE, and that was a real hole rather
    /// than a tightening for its own sake. The scan used to search the whole
    /// runner file, and a module holds many runners: `ops_music.rs` reads
    /// `.get("limit")` and `.get("offset")` for its LIST ops, so declaring
    /// `music.pause`'s card as `Some(&["limit"])` satisfied a module-wide
    /// `contains` — even though `pause` takes `_args: &Value` and reads nothing
    /// at all. That is exactly the `limit=<not set>` card this test exists to
    /// prevent, passing the test that exists to prevent it.
    #[test]
    fn every_declared_card_field_is_an_argument_its_runner_reads() {
        let runners = declared_runners();
        for op in OPS {
            let Some(keys) = op.summary_keys else { continue };
            let run = runners
                .iter()
                .find(|r| r.op == op.name)
                .expect("every op has a run: line")
                .run;
            let (module, item) = run.split_once("::").expect("checked above");
            let (_, source) = RUNNER_SOURCES
                .iter()
                .find(|(f, _)| *f == format!("{module}.rs"))
                .expect("checked above");
            let body = read_scope(source, item);
            for key in keys {
                // The READ expression, not just the string. `ops_music.rs`
                // contains the word "track" in three unrelated projections, so
                // a bare `contains("\"track\"")` would have accepted a card
                // field the runner never looks at.
                assert!(
                    body.contains(&format!(".get(\"{key}\")")),
                    "{} declares the card field '{key}', which {module}::{item} never reads \
                     with args.get(\"{key}\") — the card would show '{key}=<not set>' on every \
                     approval, so the human consents to an action with no visible object",
                    op.name
                );
            }
        }
    }

    /// The guard on both guards. A file nobody classified is a file the
    /// allowlist never reads and the denylist never scans — precisely the
    /// silent gap both exist to prevent. Note the glob is `*.rs`, not `ops_*`:
    /// a runner called `writes.rs` used to slip through that filter.
    #[test]
    fn every_file_in_the_control_module_is_classified() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/control");
        let entries = std::fs::read_dir(dir).expect("src/control must be readable");
        let mut seen = 0usize;
        for entry in entries {
            let name = entry.expect("readable dir entry").file_name();
            let name = name.to_string_lossy().to_string();
            if !name.ends_with(".rs") {
                continue;
            }
            seen += 1;
            assert!(
                RUNNER_SOURCES.iter().any(|(f, _)| *f == name)
                    || NON_RUNNER_SOURCES.contains(&name.as_str()),
                "{name} is in src/control but in neither RUNNER_SOURCES nor \
                 NON_RUNNER_SOURCES. Decide which it is: a runner is scanned by the \
                 allowlist and the denylist, a non-runner is not."
            );
        }
        assert_eq!(
            seen,
            RUNNER_SOURCES.len() + NON_RUNNER_SOURCES.len(),
            "a classified file is missing from disk"
        );
    }

    // -----------------------------------------------------------------------
    // Tiers
    // -----------------------------------------------------------------------

    /// Every op and the tier a human decided it deserves.
    ///
    /// This replaces `every_registered_op_is_read_tier_in_this_milestone`,
    /// which stopped meaning anything the moment a write landed. Pinning the
    /// whole table keeps the teeth and adds some: a read silently promoted to
    /// write fails here, an actuation quietly declared `Write` (which would let
    /// the headless scheduler start music at 3am) fails here, and a new op
    /// cannot reach the port at all until somebody writes its tier down twice.
    const EXPECTED_TIERS: &[(&str, Tier)] = &[
        ("music.status", Tier::Read),
        ("music.search", Tier::Read),
        ("music.library_tracks", Tier::Read),
        ("music.playlists", Tier::Read),
        ("music.playlist_tracks", Tier::Read),
        ("music.now_playing", Tier::Read),
        ("home.list", Tier::Read),
        // Lighthouse only, and the tier is a decision worth writing down twice:
        // a Bonjour browse mutates nothing and addresses nothing, so it is a
        // Read — but it is the one Read in this table that puts a packet on the
        // user's own network. Its budget is a constant in `home::mod.rs`, not
        // an argument, so no caller can turn it into a scan.
        #[cfg(feature = "homekit")]
        ("home.discover", Tier::Read),
        ("health.summary", Tier::Read),
        ("health.metric_history", Tier::Read),
        ("health.workouts", Tier::Read),
        ("mail.list_threads", Tier::Read),
        ("mail.read_thread", Tier::Read),
        ("portfolio.status", Tier::Read),
        ("portfolio.summary", Tier::Read),
        ("portfolio.holdings", Tier::Read),
        ("portfolio.history", Tier::Read),
        ("portfolio.allocation", Tier::Read),
        ("data.weather", Tier::Read),
        ("data.stocks", Tier::Read),
        ("data.news", Tier::Read),
        ("tasks.list", Tier::Read),
        ("notes.list", Tier::Read),
        ("events.list", Tier::Read),
        ("watchlist.list", Tier::Read),
        ("tasks.create", Tier::Write),
        ("tasks.update", Tier::Write),
        ("notes.create", Tier::Write),
        ("notes.update", Tier::Write),
        ("events.create", Tier::Write),
        ("watchlist.add", Tier::Write),
        ("music.play", Tier::Actuate),
        ("music.pause", Tier::Actuate),
        ("music.volume", Tier::Actuate),
        ("home.device_set", Tier::Actuate),
        ("home.scene_run", Tier::Actuate),
        ("home.lock_set", Tier::Approval),
        ("mail.archive", Tier::Approval),
        ("mail.mark_read", Tier::Approval),
    ];

    #[test]
    fn every_op_carries_the_tier_a_human_wrote_down() {
        for op in OPS {
            let expected = EXPECTED_TIERS
                .iter()
                .find(|(name, _)| *name == op.name)
                .unwrap_or_else(|| {
                    panic!(
                        "{} is registered but has no reviewed tier. Add it to \
                         EXPECTED_TIERS deliberately — that is the review.",
                        op.name
                    )
                })
                .1;
            assert_eq!(
                op.tier, expected,
                "{} is declared {} but was reviewed as {}",
                op.name,
                op.tier.as_str(),
                expected.as_str()
            );
        }
        // Both directions: an op removed from OPS must be removed from here too,
        // or the next reviewer reads a capability list that includes a ghost.
        for (name, _) in EXPECTED_TIERS {
            assert!(lookup(name).is_some(), "{name} is reviewed but not registered");
        }
    }

    /// The reads are still reads.
    ///
    /// Redundant with the table above, and the redundancy is the point: this is
    /// the assertion a reviewer looks for when asking "did the write milestone
    /// quietly change what a read can do", and it should be findable by name
    /// rather than inferred from a 31-row table.
    #[test]
    fn the_read_surface_did_not_grow_or_change() {
        let reads: Vec<&str> = OPS
            .iter()
            .filter(|op| op.tier == Tier::Read)
            .map(|op| op.name)
            .collect();
        // 24 in the consumer build. Lighthouse adds exactly one — `home.discover`
        // — and the arithmetic is written out rather than made feature-blind so
        // that a second HomeKit read cannot appear without somebody editing this
        // line.
        let expected = 24 + if cfg!(feature = "homekit") { 1 } else { 0 };
        assert_eq!(reads.len(), expected, "the read surface changed size: {reads:?}");
        for name in &reads {
            let reviewed = EXPECTED_TIERS.iter().find(|(n, _)| n == name).expect("reviewed");
            assert_eq!(reviewed.1, Tier::Read, "{name} was promoted out of the read set");
        }
    }

    /// Every tier in the table is one the policy core actually gates, and gates
    /// the way this registry assumed when it assigned it.
    ///
    /// `policy::decide` is an exhaustive match, so it returns SOMETHING for any
    /// tier — which is exactly why "it compiles" is not evidence. What is
    /// checked here is the behaviour each tier was chosen for.
    #[test]
    fn every_declared_tier_is_gated_the_way_this_table_assumes() {
        use policy::Decision;
        for op in OPS {
            let interactive = policy::decide(op.tier, Profile::Interactive);
            let background = policy::decide(op.tier, Profile::Background);
            match op.tier {
                // A read runs everywhere and is not audited — that is what makes
                // the proactive cycle affordable.
                Tier::Read => {
                    assert_eq!(interactive, Decision::Run, "{}", op.name);
                    assert_eq!(background, Decision::Run, "{}", op.name);
                }
                // A local write runs on both profiles, but never unaudited: the
                // audit row is what makes "Atlas added a task overnight"
                // answerable instead of mysterious.
                Tier::Write => {
                    assert_eq!(interactive, Decision::RunAudited, "{}", op.name);
                    assert_eq!(background, Decision::RunAudited, "{}", op.name);
                }
                // An actuation needs somebody in the room. The headless
                // scheduler gets an approval card instead of a sound.
                Tier::Actuate => {
                    assert_eq!(interactive, Decision::RunAudited, "{}", op.name);
                    assert!(!background.executes_now(), "{} must not auto-run headless", op.name);
                }
                // Approval never auto-runs, on either profile.
                Tier::Approval => {
                    assert!(!interactive.executes_now(), "{}", op.name);
                    assert!(!background.executes_now(), "{}", op.name);
                }
            }
        }
    }

    /// No op sits at Approval tier without the queue that makes Approval mean
    /// anything: a decision that does not execute, a reason the brain can
    /// narrate, and a risk label the `approvals` CHECK constraint accepts.
    #[test]
    fn approval_tier_ops_have_a_real_approvals_path() {
        let approval_ops: Vec<&str> = OPS
            .iter()
            .filter(|op| op.tier == Tier::Approval)
            .map(|op| op.name)
            .collect();
        assert!(
            !approval_ops.is_empty(),
            "this test is vacuous if nothing is Approval tier — delete it or fix the table"
        );

        for op in OPS.iter().filter(|op| op.tier == Tier::Approval) {
            for profile in [Profile::Interactive, Profile::Background] {
                let decision = policy::decide(op.tier, profile);
                let policy::Decision::Queue(reason) = decision else {
                    panic!("{} did not queue on {profile:?}", op.name);
                };
                assert!(!reason.code().is_empty());
                assert!(!reason.message().is_empty());
            }
        }
        // The label the approvals row is written with must be one the schema's
        // CHECK constraint allows, or the card cannot be filed at all and the
        // op becomes permanently unrunnable.
        for tier in [Tier::Approval, Tier::Actuate, Tier::Write, Tier::Read] {
            assert!(
                ["low", "medium", "high", "critical"].contains(&policy::risk_level(tier)),
                "{} has a risk label the approvals CHECK constraint rejects",
                tier.as_str()
            );
        }
    }

    // -----------------------------------------------------------------------
    // Table hygiene
    // -----------------------------------------------------------------------

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
        // not a capability that was considered and refused.
        for name in [
            "",
            "data",
            "data.",
            "data.weather.now",
            "data.wether",
            "DATA.WEATHER",
            "MUSIC.PLAY",
            "music.connect",
            "music.disconnect",
            "music.next",      // absent: the engine queue holds one track
            "music.previous",  // same
            "music.seek",      // never registered; see the note on transport
            "mail.send",
            "mail.send_reply",
            "mail.sync",
            "tasks.delete",
            "notes.delete",
            "events.update",
            "watchlist.remove", // wanted, but needs a delete path db.rs does not have
            "db.select",
            "db.insert",
            "db.update",
            "db.delete",
            "portfolio.sync",
            "portfolio.disconnect",
            "home.link",        // writes a Keychain credential; never a tool
            "home.unlink",      // same
            "home.sync",        // a bridge-wide network pull nobody asked for
            "home.set_autonomy", // there is nothing to set; see ops_home.rs
            "home.pair",        // needs the setup code off the accessory's label
            "home.unpair",      // same credential story, in reverse
            "health.import",    // reads an arbitrary path; a file-probing primitive
            "health.forget",    // Atlas must not be able to erase a health history
            "health.samples",   // there are none — only derived daily values are kept
            "health.sync",      // nothing to sync from; macOS serves no health data
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

    /// A mutating op's summary has to say what it needs, because the brain
    /// builds its tool schema from this string and nothing else. An op whose
    /// description omits its required argument produces a model that guesses.
    #[test]
    fn mutating_summaries_name_their_arguments() {
        for op in OPS.iter().filter(|op| op.tier != Tier::Read) {
            let takes_no_args = matches!(op.name, "music.pause");
            if takes_no_args {
                assert!(op.summary.contains("No arguments"), "{}", op.name);
                continue;
            }
            assert!(
                op.summary.contains('\''),
                "{} must quote the argument names it needs",
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
        // The brain declares tools from this payload, so a tier it cannot read
        // is a tool it cannot classify.
        for entry in ops {
            let tier = entry["tier"].as_str().expect("tier string");
            assert!(["read", "write", "actuate", "approval"].contains(&tier), "{tier}");
        }
    }
}
