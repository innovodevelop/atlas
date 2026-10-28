// The Focus screen's bridge to macOS Focus (Beta row 12).
//
// Atlas holds its OWN notifications while a focus session runs; that part is
// a gate in the webview (src/lib/focusGate.ts) and needs nothing from here.
// Turning on a SYSTEM Focus is another matter: macOS gives third-party apps no
// API to set Do Not Disturb or a Focus mode, but the user's own Shortcuts can
// ("Set Focus … On/Off"). So the Focus screen lets the user name a shortcut
// they made, and this module runs it through Apple's `shortcuts` command-line
// tool. Atlas never builds or edits a shortcut and never runs one the user did
// not name.
//
// The name is passed as its own argument to /usr/bin/shortcuts — never through
// a shell — and is checked first: no control characters, a sane length, and no
// leading '-', which the tool's argument parser would read as an option.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SHORTCUTS: &str = "/usr/bin/shortcuts";
/// A "Set Focus" shortcut finishes in well under a second; a shortcut that is
/// still running after this is waiting on something the user has to answer.
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

/// The shortcut name as the user typed or picked it, or why it cannot be one.
pub(crate) fn valid_shortcut_name(raw: &str) -> Result<&str, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Name the shortcut to run.".into());
    }
    if name.chars().count() > 120 {
        return Err("That shortcut name is longer than any Shortcuts allows.".into());
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("A shortcut name cannot contain line breaks or control characters.".into());
    }
    if name.starts_with('-') {
        return Err(
            "A shortcut name starting with '-' would be read as an option. Rename the shortcut."
                .into(),
        );
    }
    Ok(name)
}

/// The names of the user's shortcuts, so the Focus screen can offer a pick
/// list instead of making the user retype one exactly.
#[tauri::command(async)]
pub fn focus_shortcut_list() -> Result<Vec<String>, String> {
    let out = Command::new(SHORTCUTS)
        .arg("list")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("The Shortcuts tool is not available on this Mac ({e})."))?;
    if !out.status.success() {
        return Err("Shortcuts did not list your shortcuts.".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(500)
        .map(str::to_string)
        .collect())
}

/// Run the named shortcut and wait for it to finish (at most RUN_TIMEOUT).
#[tauri::command(async)]
pub fn focus_shortcut_run(name: String) -> Result<(), String> {
    let name = valid_shortcut_name(&name)?;
    let mut child = Command::new(SHORTCUTS)
        .arg("run")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("The Shortcuts tool is not available on this Mac ({e})."))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                // Shortcuts' own sentence ("Couldn't find shortcut …") is the
                // useful part; keep one short line of it.
                let mut msg = String::new();
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.by_ref().take(2_000).read_to_string(&mut msg);
                }
                let line = msg
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .unwrap_or("it stopped with an error");
                return Err(format!(
                    "The shortcut \u{201c}{name}\u{201d} did not run: {line}"
                ));
            }
            Ok(None) if started.elapsed() > RUN_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("The shortcut \u{201c}{name}\u{201d} was still running after 30 seconds, so Atlas stopped it."));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("Could not follow the shortcut ({e}).")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked_before_they_reach_the_tool() {
        assert_eq!(valid_shortcut_name("  Focus on ").unwrap(), "Focus on");
        assert_eq!(
            valid_shortcut_name("Arbejde – fokus").unwrap(),
            "Arbejde – fokus"
        );
        assert!(valid_shortcut_name("   ").is_err());
        assert!(valid_shortcut_name("--help").is_err());
        assert!(valid_shortcut_name("two\nlines").is_err());
        assert!(valid_shortcut_name(&"x".repeat(121)).is_err());
    }
}
