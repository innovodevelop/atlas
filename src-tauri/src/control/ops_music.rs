// Music reads, plus the three transport actuations.
//
// These call the existing `#[tauri::command]` items in crate::music directly,
// taking `MusicState` off the AppHandle. Tauri's command macro leaves the
// original function intact and `Manager::state::<T>()` resolves from any
// `&AppHandle`, so no wrapper-splitting refactor is involved.
//
// Every command here returns Spotify's raw response document — the webview
// models only the handful of fields it renders, so nothing in the app ever
// trimmed them. That is fine for a UI and wrong for a model, which pays for
// every byte and will happily repeat any of them back out. Hence `entity`.
//
// Connect/disconnect are not in this file. registry.rs records why.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use super::ops_project;
use crate::control::Ctx;
use crate::music::MusicState;

fn music(app: &AppHandle) -> Result<State<'_, MusicState>, String> {
    app.try_state::<MusicState>()
        .ok_or_else(|| "the music player is not available in this build".to_string())
}

/// The four fields a model needs to talk about a track, album, artist or
/// playlist and then act on it: what it is, what it is called, who made it, and
/// the uri that a later playback tier would need.
///
/// `artist` is null for an artist entry and for a playlist — Spotify has no
/// `artists` array on either, and filling it in with the entity's own name
/// would be a fabricated relationship.
fn entity(v: &Value) -> Value {
    let artist = v["artists"].as_array().map(|a| {
        a.iter()
            .filter_map(|x| x["name"].as_str())
            .collect::<Vec<_>>()
            .join(", ")
    });
    json!({
        "id": v["id"],
        "name": v["name"],
        "artist": artist,
        "uri": v["uri"],
    })
}

/// Project one of Spotify's `{ items: [...] }` pages, optionally reaching
/// through a wrapper key first (`/me/tracks` and playlist tracks wrap each
/// entry as `{ added_at, track: {...} }`).
fn page(payload: &Value, key: &str, unwrap: Option<&str>) -> Value {
    let items = payload[key]["items"]
        .as_array()
        .or_else(|| payload["items"].as_array())
        .cloned()
        .unwrap_or_default();
    let projected: Vec<Value> = items
        .iter()
        .map(|it| match unwrap {
            Some(k) => entity(&it[k]),
            None => entity(it),
        })
        // A page can contain nulls (a removed track still occupies its slot in
        // a playlist). Dropping them beats emitting rows of nulls the model has
        // to reason about.
        .filter(|e| !e["id"].is_null())
        .collect();
    ops_project::capped(projected)
}

// ---------------------------------------------------------------------------

/// Connection + playback-device state. Returned whole: it is a five-field
/// struct we author, not a provider document, so there is nothing to project.
pub fn status(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let st = crate::music::music_status(music(app)?);
    serde_json::to_value(st).map_err(|e| e.to_string())
}

pub fn search(app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    // A search with no query has no defensible default, so this is the one read
    // argument that is required rather than defaulted.
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| "music.search needs a non-empty 'query'".to_string())?;
    let limit = args.get("limit").and_then(Value::as_u64).map(|l| l as u32);

    let raw = crate::music::music_search(music(app)?, query.to_string(), limit)?;
    // Spotify returns four parallel result sets. Each is capped independently,
    // so a flood of one kind cannot crowd out the others.
    Ok(json!({
        "tracks": page(&raw, "tracks", None),
        "albums": page(&raw, "albums", None),
        "artists": page(&raw, "artists", None),
        "playlists": page(&raw, "playlists", None),
    }))
}

pub fn library_tracks(app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let (offset, limit) = paging(args);
    let raw = crate::music::music_library_tracks(music(app)?, offset, limit)?;
    Ok(page(&raw, "items", Some("track")))
}

pub fn playlists(app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let (offset, limit) = paging(args);
    let raw = crate::music::music_playlists(music(app)?, offset, limit)?;
    Ok(page(&raw, "items", None))
}

pub fn playlist_tracks(app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let playlist_id = args
        .get("playlist_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "music.playlist_tracks needs a 'playlist_id'".to_string())?;
    let (offset, limit) = paging(args);
    let raw =
        crate::music::music_playlist_tracks(music(app)?, playlist_id.to_string(), offset, limit)?;
    Ok(page(&raw, "items", Some("track")))
}

/// Current playback. `/me/player` answers 204 when nothing is active, which the
/// command turns into JSON null — reported as `playing: false` with no track
/// rather than as an error, because "nothing is playing" is a real answer.
pub fn now_playing(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let raw = crate::music::music_now_playing(music(app)?)?;
    if raw.is_null() {
        return Ok(json!({ "playing": false, "track": Value::Null }));
    }
    Ok(json!({
        "playing": raw["is_playing"].as_bool().unwrap_or(false),
        "progress_ms": raw["progress_ms"],
        "device": raw["device"]["name"],
        "track": entity(&raw["item"]),
    }))
}

/// Offset/limit, read leniently: both are bounded by the command itself
/// (Spotify's own page maximums), so a nonsense value degrades to the default
/// instead of failing a read.
fn paging(args: &Value) -> (Option<u32>, Option<u32>) {
    (
        args.get("offset").and_then(Value::as_u64).map(|v| v as u32),
        args.get("limit").and_then(Value::as_u64).map(|v| v as u32),
    )
}

// ---------------------------------------------------------------------------
// Transport — Tier::Actuate
//
// WHY THESE ARE ACTUATE AND NOT WRITE
// Nothing here touches a row. What they change is the room the user is sitting
// in: audio out of the speakers, on a Spotify Connect device named "Atlas" that
// is visible from their phone. There is no undo for a sound that already
// played, which is the whole distinction the tier draws — and it is why
// policy::decide sends every one of these to the approvals queue when the
// request arrives on the background profile, where nobody is there to hear it.
//
// A transport command is FIRE AND FORGET: `send_cmd` hands an `EngineCmd` to
// the engine's mpsc channel and returns. `Ok` from any of these means the
// engine accepted the command, not that audio is out yet, and the summaries in
// registry.rs say so rather than letting the model infer otherwise.
// ---------------------------------------------------------------------------

/// The base62 length Spotify ids have. Checked so a truncated or invented id
/// fails here rather than inside the engine.
const SPOTIFY_ID_LEN: usize = 22;

/// Validate a `spotify:track:…` / `spotify:episode:…` uri.
///
/// THIS CHECK IS LOAD-BEARING, not defensive tidiness. music_engine.rs:156
/// handles a uri it cannot parse by writing `log::warn!` and continuing — the
/// channel send already succeeded, so `music_load` returns `Ok(())` and nothing
/// plays. Without this function the op would report success for every malformed
/// uri, and the model would tell the user their song is playing while the room
/// stayed silent.
///
/// Album, artist and playlist uris are refused for the same reason rather than
/// passed through: the engine's queue holds one track (music_engine.rs:157), so
/// a container uri is not something it can start. The error names the read op
/// that turns a container into track uris, which is the one thing the caller
/// needs to know to fix its next attempt.
fn track_uri(raw: &str) -> Result<String, String> {
    let uri = raw.trim();
    let rest = uri
        .strip_prefix("spotify:track:")
        .or_else(|| uri.strip_prefix("spotify:episode:"));
    if let Some(id) = rest {
        if id.len() == SPOTIFY_ID_LEN && id.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Ok(uri.to_string());
        }
        // Char-wise, not byte-wise: the id is arbitrary caller text and a byte
        // slice through a multi-byte character would panic on a worker thread.
        let shown: String = id.chars().take(40).collect();
        return Err(format!(
            "'{shown}' is not a complete Spotify id; a uri looks like spotify:track: followed by \
             {SPOTIFY_ID_LEN} letters and digits"
        ));
    }
    for (kind, plural) in [("album", "album"), ("artist", "artist"), ("playlist", "playlist")] {
        if uri.starts_with(&format!("spotify:{kind}:")) {
            return Err(format!(
                "music.play takes a single track, and this is {} {plural} uri. Use music.playlist_tracks \
                 or music.search to pick a spotify:track: uri from it first.",
                if kind == "album" { "an" } else { "a" }
            ));
        }
    }
    Err("'uri' must be a spotify:track: or spotify:episode: uri, as returned by music.search".into())
}

/// Start playback. With `uri`, load that track (the engine starts it on load);
/// without one, resume whatever is loaded.
pub fn play(app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    match args.get("uri") {
        Some(Value::Null) | None => {
            crate::music::music_play(app.clone(), music(app)?)?;
            Ok(json!({ "requested": "resume" }))
        }
        Some(v) => {
            let uri = v
                .as_str()
                .ok_or_else(|| "'uri' must be a string".to_string())
                .and_then(track_uri)?;
            // Load only. `player.load(u, true, 0)` in music_engine.rs already
            // starts playback, so sending Play afterwards would be a second
            // command doing nothing — and on a slow load it can race ahead of
            // the track it was meant to start.
            crate::music::music_load(app.clone(), music(app)?, uri.clone())?;
            Ok(json!({ "requested": "play", "uri": uri }))
        }
    }
}

pub fn pause(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    crate::music::music_pause(app.clone(), music(app)?)?;
    Ok(json!({ "requested": "pause" }))
}

/// Set output volume, 0.0 (silent) to 1.0 (full).
///
/// OUT OF RANGE IS REFUSED, NOT CLAMPED. music_engine.rs:164 clamps to
/// `0.0..=1.0` before scaling to the mixer, so `level: 50` — which is what a
/// model produces when it reads "50%" — would clamp to 1.0 and put the user's
/// speakers at maximum. Silently obeying the opposite of the intent, loudly, in
/// a room we cannot see, is not a failure mode worth having; a refusal naming
/// the scale costs one round trip.
pub fn volume(app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let level = args
        .get("level")
        .and_then(Value::as_f64)
        .ok_or_else(|| "music.volume needs 'level', a number from 0.0 (silent) to 1.0 (full)".to_string())?;
    if !(0.0..=1.0).contains(&level) {
        return Err(format!(
            "'level' is {level}; it is a fraction from 0.0 (silent) to 1.0 (full), not a percentage"
        ));
    }
    crate::music::music_volume(app.clone(), music(app)?, level as f32)?;
    Ok(json!({ "requested": "volume", "level": level }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_keeps_four_fields_and_nothing_else() {
        let track = json!({
            "id": "t1",
            "name": "Song",
            "uri": "spotify:track:t1",
            "artists": [{ "name": "A", "id": "a1" }, { "name": "B", "id": "b1" }],
            "album": { "images": [{ "url": "https://example.invalid/cover.jpg" }] },
            "available_markets": ["DK", "SE", "NO"],
            "external_ids": { "isrc": "XX" },
        });
        let out = entity(&track);
        let obj = out.as_object().unwrap();
        assert_eq!(obj.len(), 4, "projection must not grow silently");
        assert_eq!(out["id"], json!("t1"));
        assert_eq!(out["artist"], json!("A, B"));
        assert_eq!(out["uri"], json!("spotify:track:t1"));
        // The expensive, useless parts of the provider document are gone.
        assert!(obj.get("album").is_none());
        assert!(obj.get("available_markets").is_none());
        assert!(obj.get("external_ids").is_none());
    }

    #[test]
    fn entity_does_not_invent_an_artist() {
        let artist = json!({ "id": "a1", "name": "A", "uri": "spotify:artist:a1" });
        assert_eq!(entity(&artist)["artist"], Value::Null);
    }

    #[test]
    fn page_unwraps_and_drops_holes() {
        let raw = json!({ "items": [
            { "added_at": "x", "track": { "id": "1", "name": "One", "uri": "u1" } },
            { "added_at": "y", "track": Value::Null },
        ]});
        let out = page(&raw, "items", Some("track"));
        assert_eq!(out["returned"], json!(1));
        assert_eq!(out["items"][0]["id"], json!("1"));
    }

    /// The uri check is the difference between "nothing played" and "nothing
    /// played, and Atlas said it did".
    #[test]
    fn only_a_complete_track_or_episode_uri_is_playable() {
        let good = format!("spotify:track:{}", "a".repeat(SPOTIFY_ID_LEN));
        assert_eq!(track_uri(&good).unwrap(), good);
        let ep = format!("spotify:episode:{}", "0".repeat(SPOTIFY_ID_LEN));
        assert!(track_uri(&ep).is_ok());
        // Trimmed, because a uri copied out of a tool result carries whitespace.
        assert_eq!(track_uri(&format!("  {good}  ")).unwrap(), good);

        for bad in [
            "",
            "spotify:track:",
            "spotify:track:short",
            "spotify:track:aaaaaaaaaaaaaaaaaaaaaaaaaaaa", // too long
            "https://open.spotify.com/track/abc",
            "Bohemian Rhapsody",
            "spotify:track:aaaaaaaaaaaaaaaaaaaa;\u{0}", // control char in the id
            "spotify:track:æøåæøåæøåæøåæøåæøåæøå",      // multi-byte, must not panic
        ] {
            assert!(track_uri(bad).is_err(), "'{bad}' must not reach the engine");
        }
    }

    /// A container uri is the mistake a model actually makes, because
    /// music.search hands it four kinds of uri and only one of them plays.
    #[test]
    fn a_container_uri_is_refused_with_the_op_that_opens_it() {
        for kind in ["album", "artist", "playlist"] {
            let uri = format!("spotify:{kind}:{}", "a".repeat(SPOTIFY_ID_LEN));
            let err = track_uri(&uri).expect_err("a container is not a track");
            assert!(err.contains("music.playlist_tracks"), "{err}");
        }
    }

    #[test]
    fn page_reads_the_search_shape() {
        let raw = json!({ "tracks": { "items": [
            { "id": "1", "name": "One", "uri": "u1", "artists": [{ "name": "A" }] }
        ]}});
        let out = page(&raw, "tracks", None);
        assert_eq!(out["returned"], json!(1));
        assert_eq!(out["items"][0]["artist"], json!("A"));
    }
}
