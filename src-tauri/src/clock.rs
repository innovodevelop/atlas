// The Clock's native half — what the webview's clock store
// (src/lib/betaClockStore.ts) cannot do from inside a WKWebView.
//
// THREE THINGS, each small, each with its limits stated:
//
// 1. KEEP AWAKE. An alarm rings only while Atlas runs on a Mac that is awake.
//    macOS lets no app wake a sleeping Mac, but it does let one keep the Mac
//    from idle-sleeping, and `caffeinate -i` is the system's own tool for it.
//    The hold is ONE child process started with a timeout (`-t`, the seconds
//    until the alarm) and Atlas' own pid (`-w`), so it ends by itself when the
//    alarm time has passed or when Atlas quits — even a crash that never gets
//    to call `clock_release_awake` cannot leave the Mac held. Closing the lid
//    still sleeps the Mac; an idle-sleep assertion cannot stop that, and the
//    Clock screen says so beside the switch.
//
// 2. RING ON A SPEAKER. The alarm editor offers the media players the
//    smart-home mirror already knows from Home Assistant (`clock_speakers`,
//    a read of the local tables and nothing else). At ring time
//    `clock_ring_speaker` speaks the alarm through Home Assistant's own
//    `tts.speak` service, on the LAN, with the bridge token already in the
//    Keychain — the only network call in this file, and the one the user
//    chose by picking a speaker. Nothing new is stored: the device id
//    resolves through the same mirror the home commands use.
//
// 3. VOICE. The brain reaches the desktop through the control port
//    (src/control), which lives in Rust; the alarms live in the webview's
//    store. `run_voice_command` is the bridge: it emits `clock:command` to
//    the webview and waits, bounded, for the store's own answer on
//    `clock_command_reply`. A window that never answers is reported as
//    exactly that — never as a success the store did not confirm.
//
// Every command here is `#[tauri::command(async)]`: none of them may run on the
// main thread (spawning a process and LAN HTTP both block; see src/http.rs).

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::db::DbState;
use crate::home::BridgeKind;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 1. Keep awake
// ---------------------------------------------------------------------------

/// The longest hold Atlas will take: the clock store looks eight days ahead
/// for an alarm (betaClock.ts `nextFire`), plus an hour of slack for a
/// daylight-saving change in between. Anything longer is a mistake, not a wish.
const AWAKE_MAX_SECS: u64 = 8 * 24 * 3600 + 3600;

struct Hold {
    child: Child,
    /// The instant the webview asked for, echoed back so it can tell its own
    /// hold from a stale one without converting through seconds.
    until_ms: u64,
}

static AWAKE: OnceLock<Mutex<Option<Hold>>> = OnceLock::new();

fn awake() -> &'static Mutex<Option<Hold>> {
    AWAKE.get_or_init(|| Mutex::new(None))
}

/// Seconds from `now_ms` to `until_ms`, rounded up so the hold never ends a
/// moment before the alarm. Pure, so the bounds are tested without spawning.
pub fn hold_seconds(until_ms: f64, now_ms: u64) -> Result<u64, String> {
    if !until_ms.is_finite() || until_ms <= 0.0 {
        return Err("the time to stay awake until is not a real instant".into());
    }
    let delta = until_ms - now_ms as f64;
    if delta <= 0.0 {
        return Err("that moment has already passed, so there is nothing to stay awake for".into());
    }
    let secs = (delta / 1000.0).ceil() as u64;
    if secs > AWAKE_MAX_SECS {
        return Err("Atlas keeps the Mac awake for an alarm in the next eight days at most".into());
    }
    Ok(secs.max(1))
}

/// End a hold: kill caffeinate and reap it so no zombie is left behind.
fn release(slot: &mut Option<Hold>) {
    if let Some(mut hold) = slot.take() {
        let _ = hold.child.kill();
        let _ = hold.child.wait();
    }
}

/// The hold that is really in force. A caffeinate whose timeout has run out
/// has exited on its own; it is reaped here and no longer counts.
fn live(slot: &mut Option<Hold>) -> Option<u64> {
    let running = match slot.as_mut() {
        Some(hold) => matches!(hold.child.try_wait(), Ok(None)),
        None => return None,
    };
    if running {
        slot.as_ref().map(|h| h.until_ms)
    } else {
        release(slot);
        None
    }
}

/// Hold this Mac awake until `until_ms` (epoch ms). Replaces any earlier hold,
/// so the store can move it when the alarm it is for moves.
#[tauri::command(async)]
pub fn clock_keep_awake(until_ms: f64) -> Result<Value, String> {
    let secs = hold_seconds(until_ms, now_ms())?;
    let mut slot = awake().lock().map_err(|_| "the keep-awake state is unavailable".to_string())?;
    release(&mut slot);
    // Arguments one by one, never through a shell: `secs` and the pid are the
    // only inputs, and both are numbers this function produced itself.
    let child = Command::new("/usr/bin/caffeinate")
        .arg("-i")
        .arg("-t")
        .arg(secs.to_string())
        .arg("-w")
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("macOS would not start caffeinate, so the Mac is not being kept awake: {e}"))?;
    let until = until_ms as u64;
    *slot = Some(Hold { child, until_ms: until });
    log::info!("[clock] keeping the Mac awake for {secs} s");
    Ok(json!({ "active": true, "untilMs": until }))
}

/// Let the Mac sleep again. Releasing when nothing is held is success.
#[tauri::command(async)]
pub fn clock_release_awake() -> Result<Value, String> {
    let mut slot = awake().lock().map_err(|_| "the keep-awake state is unavailable".to_string())?;
    let had = slot.is_some();
    release(&mut slot);
    if had {
        log::info!("[clock] released the keep-awake hold");
    }
    Ok(json!({ "active": false, "untilMs": Value::Null }))
}

/// Whether a hold is in force right now, and until when.
#[tauri::command(async)]
pub fn clock_awake_status() -> Result<Value, String> {
    let mut slot = awake().lock().map_err(|_| "the keep-awake state is unavailable".to_string())?;
    let until = live(&mut slot);
    Ok(json!({ "active": until.is_some(), "untilMs": until }))
}

// ---------------------------------------------------------------------------
// 2. Ring on a Home Assistant speaker
// ---------------------------------------------------------------------------

/// The speakers an alarm can ring on: Home Assistant media players in the
/// local mirror. A read of SQLite only — no bridge is contacted to list them.
#[tauri::command(async)]
pub fn clock_speakers(state: State<'_, DbState>, user_id: String) -> Result<Value, String> {
    if user_id.trim().is_empty() {
        return Err("sign in to see your speakers".into());
    }
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let bridge: Option<String> = conn
        .query_row(
            "SELECT state FROM home_bridges WHERE user_id = ?1 AND kind = 'home_assistant'",
            [&user_id],
            |r| r.get(0),
        )
        .ok();
    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.name, r.name, COALESCE(s.available, 1)
               FROM home_devices d
               JOIN home_bridges b ON b.id = d.bridge_id
               LEFT JOIN home_rooms r ON r.id = d.room_id
               LEFT JOIN home_device_state s ON s.device_id = d.id
              WHERE d.user_id = ?1
                AND d.kind = 'speaker'
                AND b.kind = 'home_assistant'
                AND d.external_id LIKE 'media_player.%'
              ORDER BY d.name",
        )
        .map_err(|e| e.to_string())?;
    let speakers: Vec<Value> = stmt
        .query_map([&user_id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "room": r.get::<_, Option<String>>(2)?,
                "available": r.get::<_, i64>(3)? != 0,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "linked": bridge.is_some(),
        "bridgeState": bridge,
        "speakers": speakers,
    }))
}

/// What the speaker says: the store composes it, this keeps it short and
/// printable. Pure, so the bounds are tested.
pub fn speech(message: &str) -> Result<String, String> {
    let words: Vec<&str> = message.split_whitespace().collect();
    let joined: String = words.join(" ").chars().filter(|c| !c.is_control()).collect();
    if joined.is_empty() {
        return Err("there is nothing to say on the speaker".into());
    }
    Ok(joined.chars().take(200).collect())
}

/// The Home Assistant text-to-speech engine last found, per bridge address, so
/// a ringing alarm that repeats does not re-read the whole state list.
static TTS: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();

fn tts_cache() -> &'static Mutex<Option<(String, String)>> {
    TTS.get_or_init(|| Mutex::new(None))
}

/// A bounded request to the bridge. The shared agent's 20 s ceiling is too long
/// for an alarm: the store falls back to the Mac's chime when this fails, and
/// a sleeper should not wait twenty seconds for it.
const HA_TIMEOUT: Duration = Duration::from_secs(6);

/// The bridge's error, in words that never carry the token or a response body.
fn ha_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => {
            "Home Assistant rejected Atlas' token. Link the bridge again in Smart Home.".into()
        }
        ureq::Error::Status(code, _) => format!("Home Assistant answered with an error ({code})."),
        ureq::Error::Transport(_) => {
            "Atlas could not reach Home Assistant on the network.".into()
        }
    }
}

/// The first `tts.*` entity the bridge reports: the engine `tts.speak` needs.
pub fn pick_tts(states: &Value) -> Option<String> {
    let mut engines: Vec<String> = states
        .as_array()?
        .iter()
        .filter_map(|s| s["entity_id"].as_str())
        .filter(|id| id.starts_with("tts.") && id.len() > 4)
        .map(str::to_string)
        .collect();
    engines.sort();
    engines.into_iter().next()
}

fn tts_engine(base: &str, token: &str) -> Result<String, String> {
    if let Ok(cache) = tts_cache().lock() {
        if let Some((b, engine)) = cache.as_ref() {
            if b == base {
                return Ok(engine.clone());
            }
        }
    }
    let states: Value = crate::http::agent()
        .get(&format!("{base}/api/states"))
        .timeout(HA_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(ha_error)?
        .into_json()
        .map_err(|_| "Home Assistant sent a state list Atlas could not read.".to_string())?;
    let engine = pick_tts(&states).ok_or_else(|| {
        "Home Assistant has no text-to-speech engine set up, so it cannot speak the alarm. Add one \
         (Piper, Google Translate or Home Assistant Cloud) in Home Assistant."
            .to_string()
    })?;
    if let Ok(mut cache) = tts_cache().lock() {
        *cache = Some((base.to_string(), engine.clone()));
    }
    Ok(engine)
}

/// Speak `message` on one Home Assistant speaker. The store calls this when an
/// alarm set to ring there goes off, and rings the Mac instead when it fails.
#[tauri::command(async)]
pub fn clock_ring_speaker(
    state: State<'_, DbState>,
    user_id: String,
    device_id: String,
    message: String,
) -> Result<Value, String> {
    let message = speech(&message)?;
    let target = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        crate::home::store::device_target(&conn, &user_id, &device_id)
            .map_err(String::from)?
            .ok_or_else(|| "that speaker is no longer in Atlas' home store".to_string())?
    };
    if target.kind != "speaker" || !target.external_id.starts_with("media_player.") {
        return Err(format!("{} is not a speaker", target.name));
    }
    if target.bridge.kind != BridgeKind::HomeAssistant {
        return Err(format!(
            "{} is not on Home Assistant, the only bridge Atlas can speak through",
            target.name
        ));
    }
    let base = target
        .bridge
        .base_url
        .as_deref()
        .map(|u| u.trim_end_matches('/'))
        .filter(|u| !u.is_empty())
        .ok_or_else(|| "the Home Assistant bridge has no address stored. Link it again.".to_string())?
        .to_string();
    let token = crate::home::keys::ha_token()
        .ok_or_else(|| "Atlas has no Home Assistant token in the Keychain. Link the bridge again.".to_string())?;
    let engine = tts_engine(&base, &token)?;
    let sent = crate::http::agent()
        .post(&format!("{base}/api/services/tts/speak"))
        .timeout(HA_TIMEOUT)
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(json!({
            "entity_id": engine,
            "media_player_entity_id": target.external_id,
            "message": message,
        }));
    if let Err(e) = sent {
        // The engine may have been removed since it was cached; look again next time.
        if let Ok(mut cache) = tts_cache().lock() {
            *cache = None;
        }
        return Err(ha_error(e));
    }
    Ok(json!({ "speaker": target.name, "engine": engine }))
}

// ---------------------------------------------------------------------------
// 3. Voice: the brain's clock tools, answered by the webview's store
// ---------------------------------------------------------------------------

/// The actions the store answers. Anything else never reaches the webview.
pub const VOICE_ACTIONS: &[&str] = &["set_alarm", "stop_alarm", "snooze_alarm"];

/// How long a tool call waits for the store. A spoken turn has eight seconds in
/// all (orchestrator.ts `toolTimeBudgetMs`), and the store answers in
/// milliseconds when it is there at all.
const VOICE_WAIT: Duration = Duration::from_secs(5);

struct Reply {
    ok: bool,
    message: String,
    data: Option<Value>,
}

static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<Reply>>>> = OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<Reply>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ask the webview's clock store to do one thing and return what it said.
///
/// `args` has already been validated by the control-port runner
/// (control/ops_clock.rs); the store validates again, because it is the side
/// that knows the user's alarms and time zone.
pub fn run_voice_command(app: &AppHandle, action: &str, args: Value) -> Result<Value, String> {
    if !VOICE_ACTIONS.contains(&action) {
        return Err(format!("the Clock has no action '{action}'"));
    }
    let id = format!("ck{}-{}", now_ms(), SEQ.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = mpsc::channel();
    pending()
        .lock()
        .map_err(|_| "the Clock bridge is unavailable".to_string())?
        .insert(id.clone(), tx);
    let emitted = app.emit("clock:command", json!({ "id": id, "action": action, "args": args }));
    let answer = match emitted {
        Ok(()) => rx.recv_timeout(VOICE_WAIT).ok(),
        Err(e) => {
            log::warn!("[clock] could not emit clock:command: {e}");
            None
        }
    };
    if let Ok(mut map) = pending().lock() {
        map.remove(&id);
    }
    match answer {
        Some(r) if r.ok => Ok(json!({ "done": true, "message": r.message, "alarm": r.data })),
        // The store answered and said no — nothing ringing to stop, a time it
        // could not read. That is a truthful result, not a transport failure,
        // so the model reports it instead of retrying.
        Some(r) => Ok(json!({ "done": false, "changed_anything": false, "message": r.message })),
        None => Err(
            "The Clock in the Atlas window did not answer within five seconds, so Atlas cannot \
             say whether anything changed. The window may be closed or still loading — ask the \
             user to check Clock."
                .into(),
        ),
    }
}

/// The store's answer to one `clock:command`. A late or unknown id is ignored:
/// the tool call it belonged to has already reported that it got no answer.
#[tauri::command(async)]
pub fn clock_command_reply(id: String, ok: bool, message: String, data: Option<Value>) -> Result<(), String> {
    let tx = pending()
        .lock()
        .map_err(|_| "the Clock bridge is unavailable".to_string())?
        .remove(&id);
    if let Some(tx) = tx {
        let message: String = message.chars().filter(|c| !c.is_control()).take(500).collect();
        let _ = tx.send(Reply { ok, message, data });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hold_is_rounded_up_and_bounded() {
        assert_eq!(hold_seconds(10_500.0, 10_000), Ok(1));
        assert_eq!(hold_seconds(70_001.0, 10_000), Ok(61));
        assert!(hold_seconds(9_000.0, 10_000).is_err(), "a moment that has passed");
        assert!(hold_seconds(f64::NAN, 10_000).is_err());
        assert!(hold_seconds(f64::INFINITY, 10_000).is_err());
        let nine_days = 9.0 * 24.0 * 3600.0 * 1000.0;
        assert!(hold_seconds(nine_days, 0).is_err(), "longer than the store ever looks ahead");
        let seven_days = 7.0 * 24.0 * 3600.0 * 1000.0;
        assert!(hold_seconds(seven_days, 0).is_ok());
    }

    #[test]
    fn speech_is_one_short_printable_line() {
        assert_eq!(speech("  Wake up.\n It is 07:30.  ").unwrap(), "Wake up. It is 07:30.");
        assert!(speech("   ").is_err());
        assert_eq!(speech(&"a".repeat(500)).unwrap().len(), 200);
        assert_eq!(speech("bell\u{7} rings").unwrap(), "bell rings");
    }

    #[test]
    fn the_tts_engine_is_a_tts_entity_and_the_choice_is_stable() {
        let states = json!([
            { "entity_id": "media_player.kitchen" },
            { "entity_id": "tts.piper" },
            { "entity_id": "tts.google_translate_en_com" },
            { "entity_id": "tts." },
        ]);
        assert_eq!(pick_tts(&states).as_deref(), Some("tts.google_translate_en_com"));
        assert_eq!(pick_tts(&json!([{ "entity_id": "light.lamp" }])), None);
        assert_eq!(pick_tts(&json!({})), None);
    }

    #[test]
    fn only_the_three_voice_actions_exist() {
        assert_eq!(VOICE_ACTIONS, &["set_alarm", "stop_alarm", "snooze_alarm"]);
    }
}
