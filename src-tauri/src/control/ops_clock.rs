// The Clock's three voice actions for the brain: set an alarm, stop the alarm
// that is ringing, snooze it — "wake me at seven", "stop", "snooze".
//
// WHERE THE ALARMS ARE. Not in SQLite: they live in the webview's clock store
// (src/lib/betaClockStore.ts, saved to the webview's localStorage), which is
// also what rings them. So these runners touch no table at all. They check
// the arguments HERE, in Rust, where the model cannot argue with the check,
// build a fresh object holding only the fields they checked, and hand it to
// `crate::clock::run_voice_command`, which asks the store and waits a bounded
// time for its answer. The store's answer — including "nothing is ringing" —
// is what the model reads back.
//
// WHY WRITE, NOT ACTUATE. What changes is Atlas' own alarm list and Atlas' own
// chime, both shown on the Clock screen and undone there in one click. An alarm
// set this way rings on This Mac; picking a Home Assistant speaker for it is a
// choice only the alarm editor offers, so no call here reaches past the app.

use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::control::Ctx;

/// The label's limit, the same as the alarm editor's input.
const MAX_LABEL: usize = 60;
/// Snooze bounds. Nine minutes is the default the store applies when absent.
const SNOOZE_MIN: f64 = 1.0;
const SNOOZE_MAX: f64 = 30.0;

/// Weekday words the store understands, normalised to their first three letters.
const DAYS: &[&str] = &["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const FULL_DAYS: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

pub fn set_alarm(app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let clean = set_alarm_args(args)?;
    crate::clock::run_voice_command(app, "set_alarm", clean)
}

pub fn stop_alarm(app: &AppHandle, _args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    crate::clock::run_voice_command(app, "stop_alarm", json!({}))
}

pub fn snooze_alarm(app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let clean = snooze_args(args)?;
    crate::clock::run_voice_command(app, "snooze_alarm", clean)
}

/// `07:00`, `7:05` → `07:00`, `07:05`. Hours 0–23, minutes 0–59, nothing else.
fn normalise_time(raw: &str) -> Option<String> {
    let (h, m) = raw.trim().split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    if !h.chars().all(|c| c.is_ascii_digit()) || !m.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let hh: u32 = h.parse().ok()?;
    let mm: u32 = m.parse().ok()?;
    (hh <= 23 && mm <= 59).then(|| format!("{hh:02}:{mm:02}"))
}

/// `"Monday"`, `"mon"`, `"Thurs"` → the day's three letters; anything else is
/// refused. The word has to be the start of the day's name, at least three
/// letters of it — so "monkey" is not Monday.
fn normalise_day(raw: &str) -> Option<&'static str> {
    let word = raw.trim().to_ascii_lowercase();
    if word.len() < 3 {
        return None;
    }
    FULL_DAYS
        .iter()
        .position(|full| full.starts_with(word.as_str()))
        .map(|i| DAYS[i])
}

fn set_alarm_args(args: &Value) -> Result<Value, String> {
    let time_raw = args
        .get("time")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| {
            "clock.set_alarm needs 'time', the alarm time as 24-hour HH:MM on the user's own clock \
             (seven in the morning is 07:00)"
                .to_string()
        })?;
    let time = normalise_time(time_raw).ok_or_else(|| {
        let shown: String = time_raw.chars().take(16).collect();
        format!("'time' must be 24-hour HH:MM, such as 07:00 or 19:30 — '{shown}' is not")
    })?;

    let mut out = Map::new();
    out.insert("time".into(), json!(time));

    match args.get("label") {
        None | Some(Value::Null) => {}
        Some(Value::String(label)) => {
            let label = label.trim();
            if label.chars().count() > MAX_LABEL {
                return Err(format!("'label' is limited to {MAX_LABEL} characters"));
            }
            if !label.is_empty() {
                out.insert("label".into(), json!(label));
            }
        }
        Some(_) => return Err("'label' must be text".into()),
    }

    match args.get("days") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            if list.len() > 7 {
                return Err("'days' lists each weekday at most once".into());
            }
            let mut days: Vec<&str> = Vec::new();
            for d in list {
                let day = d.as_str().and_then(normalise_day).ok_or_else(|| {
                    "'days' takes weekday names: mon, tue, wed, thu, fri, sat, sun".to_string()
                })?;
                if !days.contains(&day) {
                    days.push(day);
                }
            }
            out.insert("days".into(), json!(days));
        }
        Some(_) => {
            return Err("'days' must be a list of weekday names, such as [\"mon\", \"fri\"]".into())
        }
    }
    Ok(Value::Object(out))
}

fn snooze_args(args: &Value) -> Result<Value, String> {
    match args.get("minutes") {
        None | Some(Value::Null) => Ok(json!({})),
        Some(v) => {
            let m = v
                .as_f64()
                .filter(|m| m.is_finite())
                .ok_or_else(|| "'minutes' must be a number".to_string())?;
            if !(SNOOZE_MIN..=SNOOZE_MAX).contains(&m) {
                return Err("'minutes' must be between 1 and 30".into());
            }
            Ok(json!({ "minutes": m.round() }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_time_is_24_hour_hh_mm_and_nothing_else() {
        assert_eq!(normalise_time("07:00").as_deref(), Some("07:00"));
        assert_eq!(normalise_time("7:05").as_deref(), Some("07:05"));
        assert_eq!(normalise_time(" 19:30 ").as_deref(), Some("19:30"));
        for bad in [
            "7", "24:00", "07:60", "7:5", "seven", "07:00:00", "-1:00", "", "1a:00",
        ] {
            assert_eq!(normalise_time(bad), None, "{bad}");
        }
    }

    #[test]
    fn set_alarm_keeps_only_the_fields_it_checked() {
        let out = set_alarm_args(&json!({
            "time": "6:45", "label": "  Run ", "days": ["Monday", "wed", "WED", "fri"], "user_id": "someone",
        }))
        .unwrap();
        assert_eq!(
            out,
            json!({ "time": "06:45", "label": "Run", "days": ["mon", "wed", "fri"] })
        );
    }

    #[test]
    fn set_alarm_refuses_what_it_cannot_read() {
        assert!(set_alarm_args(&json!({})).unwrap_err().contains("'time'"));
        assert!(set_alarm_args(&json!({ "time": "seven" })).is_err());
        assert!(set_alarm_args(&json!({ "time": "07:00", "days": ["monkey"] })).is_err());
        assert!(set_alarm_args(&json!({ "time": "07:00", "days": "weekdays" })).is_err());
        assert!(set_alarm_args(&json!({ "time": "07:00", "label": 7 })).is_err());
        assert!(set_alarm_args(&json!({ "time": "07:00", "label": "x".repeat(61) })).is_err());
        // An empty label is no label: the store names it "Alarm".
        assert_eq!(
            set_alarm_args(&json!({ "time": "07:00", "label": " " })).unwrap(),
            json!({ "time": "07:00" })
        );
    }

    #[test]
    fn snooze_minutes_are_bounded() {
        assert_eq!(snooze_args(&json!({})).unwrap(), json!({}));
        assert_eq!(
            snooze_args(&json!({ "minutes": 10 })).unwrap(),
            json!({ "minutes": 10.0 })
        );
        assert!(snooze_args(&json!({ "minutes": 0 })).is_err());
        assert!(snooze_args(&json!({ "minutes": 45 })).is_err());
        assert!(snooze_args(&json!({ "minutes": "ten" })).is_err());
    }
}
