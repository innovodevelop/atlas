// Atlas brain — Rust port of services/atlas-brain (Phase 1).
//
// Pure-DB commands run natively against the shared DbState connection — no Bun
// process, no 355MB runtime, no stdio IPC. Streaming chat via brain_chat_stream
// calls the Claude API with ureq and emits Tauri events, replacing the HTTP SSE
// path once the full orchestrator is ported in Phase 2.
//
// Phase 1 scope: memory CRUD, personality CRUD, direct streaming chat.
// Phase 2 (next session): memory recall injection, tool loop, personality drift,
// proactive digest, teaching mode. The Bun sidecar can be deleted after Phase 2.

use std::io::BufRead;
use std::time::Duration;

use rusqlite::params;
use serde_json::{json, Value as Json};
use tauri::{Emitter, State};

use crate::db::DbState;
use crate::secrets;

// ---------------------------------------------------------------------------
// Streaming agent — no total-request timeout.
// http::agent() caps at TIMEOUT_TOTAL=20s, which kills long chat responses.
// This agent only has connect + per-read timeouts so SSE can run indefinitely.

fn stream_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(30)) // per BufRead::read call, not total
        .build()
}

/// Strip URLs from ureq errors — the API key can appear in the URL on some paths.
fn safe_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        ureq::Error::Transport(t) => format!("transport ({:?})", t.kind()),
    }
}

// ---------------------------------------------------------------------------
// Memory

/// List the caller's stored memories (brain /memory/list equivalent).
#[tauri::command]
pub fn brain_memory_list(
    state: State<'_, DbState>,
    user_id: String,
) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, key, category, memory_type, importance, mention_count, \
             value, created_at, updated_at \
             FROM ai_memory WHERE user_id = ? \
             ORDER BY created_at DESC LIMIT 500",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<Json> = stmt
        .query_map(params![user_id], |row| {
            let val_raw: Option<String> = row.get(6)?;
            // Truncate preview to 160 chars — the brain does the same
            let preview: String = val_raw
                .as_deref()
                .unwrap_or("")
                .chars()
                .take(160)
                .collect();
            Ok(json!({
                "id":            row.get::<_, String>(0)?,
                "key":           row.get::<_, String>(1)?,
                "category":      row.get::<_, Option<String>>(2)?,
                "memory_type":   row.get::<_, Option<String>>(3)?,
                "importance":    row.get::<_, Option<f64>>(4)?,
                "mention_count": row.get::<_, Option<i64>>(5)?,
                "preview":       preview,
                "created_at":    row.get::<_, Option<String>>(7)?,
                "updated_at":    row.get::<_, Option<String>>(8)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(json!({ "memories": rows }))
}

/// Delete one user memory by id and/or key, cascading to memory_vectors.
#[tauri::command]
pub fn brain_memory_forget(
    state: State<'_, DbState>,
    user_id: String,
    id: Option<String>,
    key: Option<String>,
) -> Result<Json, String> {
    if id.is_none() && key.is_none() {
        return Err("id or key required".to_string());
    }
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    // Build WHERE clause and params for the memory lookup
    let mut where_parts = vec!["user_id = ?".to_string()];
    let mut lookup_params: Vec<String> = vec![user_id.clone()];
    if let Some(ref i) = id {
        where_parts.push("id = ?".to_string());
        lookup_params.push(i.clone());
    }
    if let Some(ref k) = key {
        where_parts.push("key = ?".to_string());
        lookup_params.push(k.clone());
    }

    let mem_ids: Vec<String> = conn
        .prepare(&format!(
            "SELECT id FROM ai_memory WHERE {}",
            where_parts.join(" AND ")
        ))
        .map_err(|e| e.to_string())?
        .query_map(
            rusqlite::params_from_iter(lookup_params.iter().map(String::as_str)),
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    if mem_ids.is_empty() {
        return Ok(json!({ "memories": 0, "vectors": 0 }));
    }

    let ph: String = mem_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    // Count vectors before deletion so the caller gets an honest report
    let vec_count: i64 = {
        let mut all: Vec<String> = vec![user_id.clone()];
        all.extend_from_slice(&mem_ids);
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM memory_vectors \
                 WHERE user_id = ? AND memory_item_id IN ({ph})"
            ),
            rusqlite::params_from_iter(all.iter().map(String::as_str)),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };

    // Delete vectors
    {
        let mut all: Vec<String> = vec![user_id.clone()];
        all.extend_from_slice(&mem_ids);
        conn.execute(
            &format!(
                "DELETE FROM memory_vectors WHERE user_id = ? AND memory_item_id IN ({ph})"
            ),
            rusqlite::params_from_iter(all.iter().map(String::as_str)),
        )
        .map_err(|e| e.to_string())?;
    }

    // Delete the memory rows
    {
        let mut all: Vec<String> = vec![user_id.clone()];
        all.extend_from_slice(&mem_ids);
        conn.execute(
            &format!("DELETE FROM ai_memory WHERE user_id = ? AND id IN ({ph})"),
            rusqlite::params_from_iter(all.iter().map(String::as_str)),
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(json!({ "memories": mem_ids.len(), "vectors": vec_count }))
}

/// GDPR Art.17 full erase — discovers every user_id-scoped table dynamically,
/// mirroring the TS eraseUserData in localDb.ts.
#[tauri::command]
pub fn brain_memory_erase_all(
    state: State<'_, DbState>,
    user_id: String,
    confirm: bool,
) -> Result<Json, String> {
    if !confirm {
        return Err("confirm: true required".to_string());
    }
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    // Discover all tables carrying a user_id column — avoids a hardcoded list
    // that silently goes stale whenever a new table is added.
    let user_tables: Vec<String> = conn
        .prepare(
            "SELECT m.name FROM sqlite_master m \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' \
             AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'user_id') \
             ORDER BY m.name",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut counts: serde_json::Map<String, Json> = serde_json::Map::new();

    // Child tables with no user_id owned through a parent — delete first
    for (table, sql) in [
        ("messages",  "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)"),
        ("run_steps", "DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE user_id = ?)"),
    ] {
        let n = conn.execute(sql, params![user_id]).unwrap_or(0);
        counts.insert(table.to_string(), json!(n));
    }

    // Collect vector ids for FTS/vec mirror cleanup (done after the main delete)
    let vec_ids: Vec<String> = conn
        .prepare("SELECT id FROM memory_vectors WHERE user_id = ?")
        .map_err(|e| e.to_string())?
        .query_map(params![user_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();

    // memory_vectors first, before user-scoped sweep (so we still have the ids)
    let n = conn
        .execute("DELETE FROM memory_vectors WHERE user_id = ?", params![user_id])
        .unwrap_or(0);
    counts.insert("memory_vectors".to_string(), json!(n));

    // Best-effort FTS5 + vec0 mirror cleanup
    if !vec_ids.is_empty() {
        let ph: String = vec_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        for table in ["memory_fts", "memory_vec"] {
            let sql = format!("DELETE FROM \"{table}\" WHERE id IN ({ph})");
            let _ = conn.execute(
                &sql,
                rusqlite::params_from_iter(vec_ids.iter().map(String::as_str)),
            );
        }
    }

    // All remaining user-scoped tables
    for table in &user_tables {
        if table == "memory_vectors" {
            continue; // already handled
        }
        let n = conn
            .execute(
                &format!("DELETE FROM \"{table}\" WHERE user_id = ?"),
                params![user_id],
            )
            .unwrap_or(0);
        counts.insert(table.clone(), json!(n));
    }

    Ok(Json::Object(counts))
}

// ---------------------------------------------------------------------------
// Personality

/// Get personality state (traits + lexicon + pinned). Returns defaults when
/// the user has no stored personality yet.
#[tauri::command]
pub fn brain_personality_get(
    state: State<'_, DbState>,
    user_id: String,
) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let row: Option<(Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT traits_json, lexicon_json, pinned_json \
             FROM atlas_personality WHERE user_id = ?",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    let parse_obj = |s: Option<&str>| -> Json {
        s.and_then(|v| serde_json::from_str(v).ok())
            .filter(|v: &Json| v.is_object())
            .unwrap_or_else(|| json!({}))
    };
    let parse_arr = |s: Option<&str>| -> Json {
        s.and_then(|v| serde_json::from_str(v).ok())
            .filter(|v: &Json| v.is_array())
            .unwrap_or_else(|| json!([]))
    };

    let (traits, lexicon, pinned) = row
        .as_ref()
        .map(|(t, l, p)| {
            (
                parse_obj(t.as_deref()),
                parse_obj(l.as_deref()),
                parse_arr(p.as_deref()),
            )
        })
        .unwrap_or_else(|| (json!({}), json!({}), json!([])));

    Ok(json!({ "traits": traits, "lexicon": lexicon, "pinned": pinned }))
}

/// Persist personality (source="user"): all incoming trait keys become pinned
/// so drift never silently overrides an explicit user setting.
#[tauri::command]
pub fn brain_personality_update(
    state: State<'_, DbState>,
    user_id: String,
    traits: Option<Json>,
    lexicon: Option<Json>,
) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    // Read current row (defaults to empty if not yet created)
    let (cur_traits, cur_lexicon, cur_pinned) = conn
        .query_row(
            "SELECT traits_json, lexicon_json, pinned_json \
             FROM atlas_personality WHERE user_id = ?",
            params![user_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .ok()
        .map(|(t, l, p)| {
            let traits_v: serde_json::Map<String, Json> = t
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            let lexicon_v: serde_json::Map<String, Json> = l
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            let pinned_v: Vec<String> = p
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            (traits_v, lexicon_v, pinned_v)
        })
        .unwrap_or_else(|| (Default::default(), Default::default(), vec![]));

    // Merge incoming traits over current
    let mut new_traits = cur_traits;
    let mut new_pinned = cur_pinned;
    if let Some(Json::Object(incoming)) = &traits {
        for (k, v) in incoming {
            new_traits.insert(k.clone(), v.clone());
            if !new_pinned.contains(k) {
                new_pinned.push(k.clone());
            }
        }
    }

    // Clamp all trait values to [0.0, 1.0]
    for v in new_traits.values_mut() {
        if let Some(f) = v.as_f64() {
            *v = json!(f.clamp(0.0, 1.0));
        }
    }

    // Lexicon replaces wholesale when provided; otherwise keep current
    let new_lexicon = match lexicon {
        Some(Json::Object(map)) => map,
        _ => cur_lexicon,
    };

    conn.execute(
        "INSERT INTO atlas_personality \
           (user_id, traits_json, lexicon_json, pinned_json, updated_at) \
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
         ON CONFLICT(user_id) DO UPDATE SET \
           traits_json  = excluded.traits_json, \
           lexicon_json = excluded.lexicon_json, \
           pinned_json  = excluded.pinned_json, \
           updated_at   = excluded.updated_at",
        params![
            user_id,
            serde_json::to_string(&new_traits).map_err(|e| e.to_string())?,
            serde_json::to_string(&new_lexicon).map_err(|e| e.to_string())?,
            serde_json::to_string(&new_pinned).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "traits":  Json::Object(new_traits),
        "lexicon": Json::Object(new_lexicon),
        "pinned":  new_pinned,
    }))
}

/// Reset personality to defaults and clear pinned traits.
#[tauri::command]
pub fn brain_personality_reset(
    state: State<'_, DbState>,
    user_id: String,
) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM atlas_personality WHERE user_id = ?",
        params![user_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({
        "traits": {
            "warmth": 0.5, "playfulness": 0.5, "formality": 0.5,
            "verbosity": 0.5, "directness": 0.5
        },
        "lexicon": {},
        "pinned": []
    }))
}

// ---------------------------------------------------------------------------
// Streaming chat

/// Stream a Claude chat response via Tauri events.
///
/// Emits `brain:token:{session_id}` (text delta) and `brain:done:{session_id}`
/// (final) or `brain:error:{session_id}` (on failure). The caller issues
/// `invoke('brain_chat_stream', {...})` after starting event listeners.
///
/// Phase 1: direct completion — system prompt from personality, no tool loop.
/// Phase 2 will add memory recall, the full tool loop, and turn capture.
#[tauri::command(async)]
pub fn brain_chat_stream(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    session_id: String,
    user_id: String,
    messages: Vec<Json>,
    system_prompt_override: Option<String>,
) -> Result<(), String> {
    let api_key = secrets::core_key("anthropic_api_key")
        .ok_or_else(|| "ANTHROPIC_API_KEY not configured — add it in Atlas settings".to_string())?;

    // Read personality BEFORE the HTTP connection so the DB lock is released
    // before the long-running SSE stream begins (other commands would block).
    let system = system_prompt_override
        .unwrap_or_else(|| build_system_prompt(&state, &user_id));

    let body = json!({
        "model": "claude-sonnet-5",
        "system": system,
        "messages": messages,
        "max_tokens": 8192,
        "stream": true
    });

    let resp = stream_agent()
        .post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", &api_key)
        .set("anthropic-version", "2023-06-01")
        .set("content-type", "application/json")
        .send_json(body)
        .map_err(|e| {
            let msg = safe_err(e);
            app.emit(&format!("brain:error:{session_id}"), &msg).ok();
            msg
        })?;

    let reader = std::io::BufReader::new(resp.into_reader());
    for line_result in reader.lines() {
        let line = line_result.map_err(|e| {
            let msg = format!("stream read error: {e}");
            app.emit(&format!("brain:error:{session_id}"), &msg).ok();
            msg
        })?;

        let Some(data) = line.strip_prefix("data: ") else { continue };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" { continue; }

        let Ok(event) = serde_json::from_str::<Json>(data) else { continue };

        match event.get("type").and_then(|v| v.as_str()) {
            // Anthropic streaming format: content_block_delta carries text
            Some("content_block_delta") => {
                if let Some(text) = event["delta"]["text"].as_str() {
                    app.emit(&format!("brain:token:{session_id}"), text).ok();
                }
            }
            Some("message_stop") => {
                app.emit(&format!("brain:done:{session_id}"), json!({})).ok();
                break;
            }
            Some("error") => {
                let msg = event["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown API error")
                    .to_string();
                app.emit(&format!("brain:error:{session_id}"), &msg).ok();
                return Err(msg);
            }
            _ => {}
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers

/// Build the system prompt from the user's stored personality traits.
/// Reads and immediately releases the DB lock — safe to call before any HTTP.
fn build_system_prompt(state: &State<'_, DbState>, user_id: &str) -> String {
    let base = "You are Atlas, an advanced AI Research Assistant running locally \
                on the user's Mac. You are helpful, knowledgeable, and conversational. \
                Keep responses clear and friendly.";

    let style = personality_style_hint(state, user_id);
    if style.is_empty() {
        base.to_string()
    } else {
        format!("{base} {style}")
    }
}

/// Return a terse communication-style instruction derived from the stored traits,
/// or an empty string if the user has no non-default personality state.
fn personality_style_hint(state: &State<'_, DbState>, user_id: &str) -> String {
    let Ok(conn) = state.conn.lock() else { return String::new() };
    let Ok(traits_raw) = conn.query_row(
        "SELECT traits_json FROM atlas_personality WHERE user_id = ?",
        params![user_id],
        |r| r.get::<_, Option<String>>(0),
    ) else {
        return String::new();
    };
    let traits: serde_json::Map<String, Json> = traits_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let describe = |k: &str, low: &str, high: &str| -> Option<String> {
        let v = traits.get(k)?.as_f64()?;
        if v >= 0.7 { Some(high.to_string()) }
        else if v <= 0.3 { Some(low.to_string()) }
        else { None }
    };

    let hints: Vec<String> = [
        describe("warmth",      "be professional and concise",  "be warm and personal"),
        describe("playfulness", "be serious and precise",       "be playful and witty"),
        describe("formality",   "be casual and approachable",   "be formal and structured"),
        describe("verbosity",   "be brief and to-the-point",    "give detailed, thorough answers"),
        describe("directness",  "explore context and nuance",   "be direct and decisive"),
    ]
    .into_iter()
    .flatten()
    .collect();

    if hints.is_empty() {
        String::new()
    } else {
        format!("Communication style: {}.", hints.join("; "))
    }
}
