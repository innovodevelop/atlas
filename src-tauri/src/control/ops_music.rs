// Music reads.
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
