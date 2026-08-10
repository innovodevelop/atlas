// Who else is running right now.
//
// Atlas.app and Lighthouse.app are two bundles over ONE database (see
// appdata.rs). Every remaining hazard of that arrangement reduces to the same
// question: is this row / this port / this sidecar owned by a process that
// still exists, or by a launch that is over? "Before this process started" used
// to be treated as an answer, and it stopped being one the moment a second
// bundle could open the same file.
//
// So each launch publishes a small file naming itself and keeps its timestamp
// fresh; a launch that stops beating stops counting. Two things read it:
//
//   • the startup audit sweep, which may only close rows that predate EVERY
//     live instance (control/audit.rs);
//   • the sidecar claim, which elects exactly one instance to spawn the voice
//     gateway and the brain, so the fixed ports 4820/4830 have one binder and
//     the single SQLite file has one brain writing to it (lib.rs).
//
// A HEARTBEAT, NOT A PID CHECK. Checking whether a pid exists needs libc or a
// `ps` fork, and pids are reused; a timestamp the owner refreshes costs one
// small write every 15 seconds and needs no dependency. Its weakness is a
// window: for up to STALE_AFTER_SECS after a crash, the dead launch still looks
// alive. Every consumer here is written so that erring in that direction is the
// safe one — the sweep closes nothing rather than closing something live, and
// the sidecar claim waits rather than double-binding.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};

/// How often a live instance refreshes its file.
const HEARTBEAT_SECS: u64 = 15;

/// How long a file may go unrefreshed before its instance is presumed gone.
/// Six missed beats: generous enough that a machine under heavy load is never
/// mistaken for a dead one, short enough that a relaunch after a crash is not
/// blocked for long.
const STALE_AFTER_SECS: i64 = 90;

/// How long before an unrefreshed file is deleted rather than merely ignored.
/// Far beyond STALE_AFTER_SECS on purpose: deleting the file of a process that
/// is alive but wedged would make its rows sweepable.
const GC_AFTER_SECS: i64 = 3_600;

const INSTANCES_DIR: &str = "instances";
const SIDECAR_CLAIM: &str = "sidecars.json";

static RUN_ID: OnceLock<String> = OnceLock::new();
static STARTED_AT: OnceLock<String> = OnceLock::new();
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// This launch's identity. Stable for the life of the process, and unrelated to
/// the pid so a reused pid can never be mistaken for a live instance.
pub fn run_id() -> &'static str {
    RUN_ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

pub fn started_at() -> &'static str {
    STARTED_AT.get_or_init(crate::control::audit::now_iso)
}

fn instances_dir() -> Option<&'static Path> {
    DIR.get().map(PathBuf::as_path)
}

fn claim_path() -> Option<PathBuf> {
    DIR.get().map(|d| d.parent().unwrap_or(d).join(SIDECAR_CLAIM))
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/// Announce this launch, and keep announcing it.
///
/// Must run before `control::start`, because the reconciliation thread that
/// function spawns asks who is live. Everything here is local file I/O on a
/// directory we already own — no Keychain, no network — so it is safe on the
/// setup thread.
pub fn register(shared_dir: &Path) {
    let dir = shared_dir.join(INSTANCES_DIR);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!(
            "[instance] cannot create {}: {e}; this launch will not be visible to another \
             instance and will assume it is the only one running",
            dir.display()
        );
        return;
    }
    let _ = DIR.set(dir);
    gc();
    beat();

    let spawned = std::thread::Builder::new()
        .name("atlas-instance-heartbeat".to_string())
        .spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(HEARTBEAT_SECS));
            beat();
        });
    if let Err(e) = spawned {
        // Without a heartbeat this launch goes stale in STALE_AFTER_SECS and a
        // later instance may sweep rows we are still working on. Loud, because
        // nothing else will notice.
        log::warn!("[instance] heartbeat thread not started: {e}");
    }
}

/// Refresh this launch's file. Written to a temp name and renamed over the top,
/// so a reader never sees half a record.
fn beat() {
    let Some(dir) = instances_dir() else { return };
    let record = json!({
        "run_id": run_id(),
        "pid": std::process::id(),
        "started_at": started_at(),
        "heartbeat": crate::control::audit::now_iso(),
    })
    .to_string();
    let dest = dir.join(format!("{}.json", run_id()));
    if let Err(e) = write_atomic(&dest, &record) {
        log::warn!("[instance] heartbeat write failed: {e}");
    }
}

/// Remove this launch's file at exit, so nothing waits STALE_AFTER_SECS to
/// notice a clean shutdown.
pub fn unregister() {
    if let Some(dir) = instances_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{}.json", run_id())));
    }
}

fn read_records() -> Vec<(PathBuf, Value)> {
    let Some(dir) = instances_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let text = std::fs::read_to_string(e.path()).ok()?;
            Some((e.path(), serde_json::from_str::<Value>(&text).ok()?))
        })
        .collect()
}

/// Delete records nobody could still be behind. Unparseable files are left
/// alone unless they are older than the same window — a file we cannot read is
/// not evidence that its process is gone.
fn gc() {
    let Some(dir) = instances_dir() else { return };
    let now = crate::control::audit::now_iso();
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let record = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let beat = record
            .as_ref()
            .and_then(|r| r.get("heartbeat"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let expired = match beat {
            Some(b) => !is_live(&b, &now, GC_AFTER_SECS),
            // Unreadable: fall back to the file's own mtime.
            None => entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() as i64 > GC_AFTER_SECS),
        };
        if expired {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// `started_at` of every OTHER live instance.
pub fn other_live_starts() -> Vec<String> {
    let now = crate::control::audit::now_iso();
    read_records()
        .into_iter()
        .filter_map(|(_, r)| {
            let id = r.get("run_id")?.as_str()?;
            if id == run_id() {
                return None;
            }
            let beat = r.get("heartbeat").and_then(Value::as_str).unwrap_or("");
            if !is_live(beat, &now, STALE_AFTER_SECS) {
                return None;
            }
            Some(r.get("started_at").and_then(Value::as_str).unwrap_or("").to_string())
        })
        .collect()
}

pub fn is_run_live(target: &str) -> bool {
    if target == run_id() {
        return true;
    }
    let now = crate::control::audit::now_iso();
    read_records().into_iter().any(|(_, r)| {
        r.get("run_id").and_then(Value::as_str) == Some(target)
            && is_live(r.get("heartbeat").and_then(Value::as_str).unwrap_or(""), &now, STALE_AFTER_SECS)
    })
}

// ---------------------------------------------------------------------------
// The two pure decisions
// ---------------------------------------------------------------------------

/// Is a heartbeat recent enough that its instance must be assumed alive?
///
/// A heartbeat that cannot be parsed counts as LIVE. That is the conservative
/// direction for every caller: the sweep then closes nothing rather than
/// closing another process' in-flight approvals, and the sidecar claim waits
/// rather than binding a port somebody else holds. Unreadable records are
/// removed by `gc` on age, not by guessing they are dead.
pub fn is_live(heartbeat: &str, now: &str, stale_after_secs: i64) -> bool {
    let (Ok(beat), Ok(now)) = (
        chrono::DateTime::parse_from_rfc3339(heartbeat),
        chrono::DateTime::parse_from_rfc3339(now),
    ) else {
        return true;
    };
    (now - beat).num_seconds() <= stale_after_secs
}

/// The oldest moment any live instance started.
///
/// This is the whole fix for the audit sweep. A row created BEFORE this instant
/// predates every process that currently exists, so no running Atlas is working
/// on it and closing it is safe. A row created after it might belong to a live
/// instance, and is left alone.
///
/// Lexicographic min is chronological here for the same reason the sweep's own
/// comparison is: every writer emits the fixed-width UTC format `now_iso`
/// produces. A malformed or empty `started_at` therefore sorts BELOW every real
/// timestamp and yields a cutoff that sweeps nothing — the safe failure.
pub fn sweep_cutoff(own_started_at: &str, other_live_starts: &[String]) -> String {
    other_live_starts
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(own_started_at))
        .min()
        .unwrap_or(own_started_at)
        .to_string()
}

/// `sweep_cutoff` against the live registry.
///
/// With no registry at all — the directory could not be created — this returns
/// the caller's own cutoff, i.e. exactly the old single-instance behaviour. That
/// is not a hole: registration failing means this launch is invisible to others
/// AND others are invisible to it, and a second instance would have hit the same
/// failure on the same directory, so there is nothing to be wrong about.
pub fn effective_sweep_cutoff(own_cutoff: &str) -> String {
    if instances_dir().is_none() {
        return own_cutoff.to_string();
    }
    let others = other_live_starts();
    let cutoff = sweep_cutoff(own_cutoff, &others);
    if cutoff != own_cutoff {
        log::info!(
            "[control] {} other live instance(s); the sweep only closes rows older than {cutoff}",
            others.len()
        );
    }
    cutoff
}

// ---------------------------------------------------------------------------
// Sidecar ownership
// ---------------------------------------------------------------------------

/// Where the voice gateway and the brain are, and the token that opens them.
pub struct SidecarClaim {
    pub run_id: String,
    pub voice_port: u16,
    pub brain_port: u16,
    pub token: String,
}

pub enum Sidecars {
    /// Nobody else had them: spawn them, and be the one that reaps them.
    Owner,
    /// A live instance already runs them. Use its ports and its token; do not
    /// spawn a second pair.
    Adopted(SidecarClaim),
}

/// Elect the single instance that runs the sidecars.
///
/// WHY REUSE RATHER THAN A SECOND PAIR ON NEGOTIATED PORTS. Ports are the
/// visible half of the problem and the smaller one. The brain writes to the
/// SAME SQLite file now, so two brains means two writers plus two proactive
/// schedulers running the same digest cycle — duplicated background inference,
/// billed twice, writing overlapping memories. Two voice gateways means two
/// processes holding a microphone and two answers spoken over each other. Only
/// one of each should exist per machine regardless of how many windows are open,
/// which makes ownership — not port negotiation — the right primitive.
///
/// THE TOKEN IS WRITTEN TO DISK, and that is a real reduction in secrecy: today
/// it exists only in process memory and in the webview. It is written 0600, into
/// the directory that already holds `atlas.db` — so anything that can read the
/// claim can already read the user's mail mirror, notes and memories directly,
/// which is strictly more than the sidecars would hand it. The control token,
/// which grants desktop ACTUATION, is deliberately not in here and stays
/// per-process.
pub fn claim_sidecars(token: &str, voice_port: u16, brain_port: u16) -> Sidecars {
    let Some(path) = claim_path() else {
        // No shared directory: we cannot coordinate, so behave exactly as the
        // single-instance build did.
        return Sidecars::Owner;
    };
    let record = json!({
        "run_id": run_id(),
        "pid": std::process::id(),
        "voice_port": voice_port,
        "brain_port": brain_port,
        "token": token,
    })
    .to_string();

    elect(&path, &record, is_run_live)
}

/// The election itself, with the path, the record and the liveness oracle
/// passed in so it can be driven from a test without a shared app directory or
/// a second process.
///
/// EVERY REMOVAL IS FOLLOWED BY ANOTHER PUBLISH, and that is the whole shape of
/// this loop. It used to be `for _ in 0..2`, whose second pass could remove a
/// dead or unreadable claim and then fall out of the loop into
/// `Sidecars::Owner` HOLDING NO CLAIM — after which a later instance found no
/// file, published successfully, and became Owner as well. Two owners is two
/// brains writing one SQLite file, two `ProactiveScheduler`s running the same
/// digest, and two processes on the microphone: precisely what this function
/// exists to prevent. An unclaimed Owner is also invisible to
/// `sidecar_claim_is`, so it reports its own live sidecars as not running.
///
/// So: the only routes to `Owner` are a publish that SUCCEEDED, or a claim file
/// the OS will not let us use at all.
fn elect(path: &Path, record: &str, live: impl Fn(&str) -> bool) -> Sidecars {
    elect_with(path, record, live, publish_create_only)
}

/// `publish` is injected so a test can script the race this loop exists for:
/// the file reappearing between our removal and our next create attempt. That
/// is not reproducible from the filesystem alone in a single-threaded test, and
/// it is the exact sequence the old two-pass version got wrong.
fn elect_with(
    path: &Path,
    record: &str,
    live: impl Fn(&str) -> bool,
    mut publish: impl FnMut(&Path, &str) -> std::io::Result<bool>,
) -> Sidecars {
    let mut removals = 0;
    loop {
        match publish(path, record) {
            Ok(true) => return Sidecars::Owner,
            Ok(false) => {}
            Err(e) => {
                log::warn!("[sidecars] claim file unusable ({e}); spawning our own sidecars");
                return Sidecars::Owner;
            }
        }
        match read_claim(path) {
            Some(claim) if live(&claim.run_id) => {
                log::info!(
                    "[sidecars] instance {} already runs the sidecars (voice {}, brain {}); adopting them",
                    claim.run_id, claim.voice_port, claim.brain_port
                );
                return Sidecars::Adopted(claim);
            }
            other => {
                if removals >= 3 {
                    // Three times we removed a claim we could not adopt and
                    // three times somebody recreated it before our next
                    // publish. That is a live peer racing us, so ADOPT rather
                    // than spawn a second set — the 20s re-ask in lib.rs takes
                    // the sidecars over if that peer turns out to be dying.
                    log::warn!("[sidecars] lost the claim race repeatedly; adopting what is there");
                    return match read_claim(path) {
                        Some(claim) => Sidecars::Adopted(claim),
                        // Only reachable by having just failed to CREATE the
                        // file, which means something holds it. Owning is the
                        // remaining answer and the one that leaves the user
                        // with a working app.
                        None => Sidecars::Owner,
                    };
                }
                match other {
                    Some(claim) => log::info!(
                        "[sidecars] claim held by dead instance {}; taking over",
                        claim.run_id
                    ),
                    None => log::warn!("[sidecars] unreadable claim file; taking over"),
                }
                removals += 1;
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn read_claim(path: &Path) -> Option<SidecarClaim> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    Some(SidecarClaim {
        run_id: v.get("run_id")?.as_str()?.to_string(),
        voice_port: u16::try_from(v.get("voice_port")?.as_u64()?).ok()?,
        brain_port: u16::try_from(v.get("brain_port")?.as_u64()?).ok()?,
        token: v.get("token")?.as_str()?.to_string(),
    })
}

/// Is the claim still ours / still the one we adopted? Cheap enough to ask on
/// every `*_info` poll: one small read, no directory walk.
pub fn sidecar_claim_is(owner_run_id: &str) -> bool {
    claim_path()
        .as_deref()
        .and_then(read_claim)
        .is_some_and(|c| c.run_id == owner_run_id)
}

/// Give the ports back at exit — but only if they are still ours. Removing
/// somebody else's claim would leave a second instance's live sidecars
/// unowned and invite a third to bind their ports.
pub fn release_sidecars() {
    let Some(path) = claim_path() else { return };
    if read_claim(&path).is_some_and(|c| c.run_id == run_id()) {
        let _ = std::fs::remove_file(&path);
    }
}

// ---------------------------------------------------------------------------
// File primitives
// ---------------------------------------------------------------------------

fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

fn tmp_beside(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{name}.{}.tmp", std::process::id()))
}

/// Replace `path` wholesale. Readers see either the old record or the new one,
/// never half of one.
fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = tmp_beside(path);
    open_private(&tmp)?.write_all(contents.as_bytes())?;
    std::fs::rename(&tmp, path)
}

/// Create `path` with `contents` only if it does not exist, atomically.
/// `Ok(true)` means this caller created it.
///
/// `hard_link` rather than `rename`: rename overwrites, which is exactly what a
/// claim must never do — the existing file may name a live owner whose sidecars
/// are running.
fn publish_create_only(path: &Path, contents: &str) -> std::io::Result<bool> {
    let tmp = tmp_beside(path);
    open_private(&tmp)?.write_all(contents.as_bytes())?;
    let linked = std::fs::hard_link(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-08-08T13:00:00.000Z";

    #[test]
    fn a_recent_heartbeat_is_live_and_an_old_one_is_not() {
        assert!(is_live("2026-08-08T12:59:31.000Z", NOW, 90));
        assert!(is_live("2026-08-08T12:58:30.000Z", NOW, 90), "exactly at the bound");
        assert!(!is_live("2026-08-08T12:58:29.000Z", NOW, 90));
    }

    /// A clock that jumped backwards, or a record written by a future launch,
    /// must not be read as "long dead".
    #[test]
    fn a_heartbeat_from_the_future_is_live() {
        assert!(is_live("2026-08-08T13:05:00.000Z", NOW, 90));
    }

    /// The conservative direction, stated as a test because it is the one that
    /// keeps a garbled record from getting another instance's approvals expired.
    #[test]
    fn an_unparseable_heartbeat_counts_as_live() {
        assert!(is_live("", NOW, 90));
        assert!(is_live("yesterday", NOW, 90));
        assert!(is_live("2026-08-08 12:00:00", NOW, 90));
    }

    #[test]
    fn with_nobody_else_running_the_cutoff_is_our_own() {
        assert_eq!(sweep_cutoff(NOW, &[]), NOW);
    }

    /// The fix. An instance that started before us pulls the cutoff back to ITS
    /// start, so nothing it has written since can be swept.
    #[test]
    fn an_older_live_instance_pulls_the_cutoff_back_to_its_own_start() {
        let others = vec!["2026-08-08T12:00:00.000Z".to_string()];
        assert_eq!(sweep_cutoff(NOW, &others), "2026-08-08T12:00:00.000Z");
    }

    #[test]
    fn the_oldest_live_instance_wins_not_the_first_listed() {
        let others = vec![
            "2026-08-08T12:40:00.000Z".to_string(),
            "2026-08-08T09:15:00.000Z".to_string(),
            "2026-08-08T12:55:00.000Z".to_string(),
        ];
        assert_eq!(sweep_cutoff(NOW, &others), "2026-08-08T09:15:00.000Z");
    }

    /// A live instance that started AFTER us cannot push the cutoff forward —
    /// that would sweep rows older than it, which is the bug in the other
    /// direction.
    #[test]
    fn a_younger_live_instance_never_moves_the_cutoff_forward() {
        let others = vec!["2026-08-08T13:30:00.000Z".to_string()];
        assert_eq!(sweep_cutoff(NOW, &others), NOW);
    }

    /// A record whose `started_at` is missing or garbage sorts below every real
    /// timestamp, so the cutoff sweeps nothing. Losing a sweep is recoverable;
    /// expiring a live approval is not.
    #[test]
    fn a_record_with_no_start_time_makes_the_sweep_a_no_op() {
        let others = vec![String::new()];
        assert_eq!(sweep_cutoff(NOW, &others), "");
    }

    // --- file primitives ---------------------------------------------------

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("atlas-instance-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The election primitive: exactly one caller may create the claim, and the
    /// loser must not have overwritten the winner's record.
    #[test]
    fn only_the_first_publisher_creates_the_claim() {
        let dir = temp_dir("claim");
        let path = dir.join(SIDECAR_CLAIM);
        assert!(publish_create_only(&path, "first").unwrap());
        assert!(!publish_create_only(&path, "second").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- the election ------------------------------------------------------

    fn record_for(run: &str) -> String {
        json!({ "run_id": run, "pid": 1, "voice_port": 4820, "brain_port": 4830, "token": "t" })
            .to_string()
    }

    /// THE INVARIANT, stated as a test: an instance that answers `Owner` is
    /// holding the claim. It is the whole point of the file — a second owner
    /// is a second brain on the same SQLite database.
    ///
    /// The case that used to break it is the last one: the previous owner
    /// quits between our failed publish and our read, so `read_claim` sees
    /// nothing, the old two-pass loop removed a file that was already gone and
    /// fell out of the loop into `Owner` WITHOUT publishing. The next instance
    /// then found a free claim slot and became Owner too.
    #[test]
    fn answering_owner_always_means_the_claim_is_held() {
        let dir = temp_dir("elect");
        let path = dir.join(SIDECAR_CLAIM);

        // (a) empty slot: we take it, and the file is ours afterwards.
        assert!(matches!(elect(&path, &record_for("me"), |_| false), Sidecars::Owner));
        assert_eq!(read_claim(&path).unwrap().run_id, "me");

        // (b) a LIVE peer holds it: adopt, do not take over.
        std::fs::remove_file(&path).unwrap();
        publish_create_only(&path, &record_for("peer")).unwrap();
        match elect(&path, &record_for("me"), |r| r == "peer") {
            Sidecars::Adopted(c) => assert_eq!(c.run_id, "peer"),
            Sidecars::Owner => panic!("adopted a live peer's sidecars as our own"),
        }

        // (c) a DEAD peer holds it: take over — and end up holding the claim.
        assert!(matches!(elect(&path, &record_for("me"), |_| false), Sidecars::Owner));
        assert_eq!(read_claim(&path).unwrap().run_id, "me", "took over without claiming");

        // (d) THE REGRESSION: an unreadable claim, i.e. a torn or half-written
        //     file. The loop must remove it and publish again, not fall
        //     through.
        std::fs::write(&path, "{ not json").unwrap();
        assert!(matches!(elect(&path, &record_for("me"), |_| false), Sidecars::Owner));
        assert_eq!(
            read_claim(&path).map(|c| c.run_id).as_deref(),
            Some("me"),
            "answered Owner while holding no claim — a later instance would own them too"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// THE REGRESSION, scripted. The old loop was `for _ in 0..2`, and its
    /// second pass could remove a claim it could not adopt and then fall
    /// straight out of the loop into `Owner` WITHOUT ever publishing again.
    /// That instance owns the sidecars while holding nothing, so the next
    /// launch finds a free slot and owns them too: two brains on one SQLite
    /// file, two `ProactiveScheduler`s, two processes on the microphone.
    ///
    /// The sequence needs the file to reappear between our removal and our
    /// next create — a race the filesystem alone will not reproduce in one
    /// thread — so `publish` is scripted: it refuses twice, as a peer racing
    /// us would, then succeeds. The assertion is not on the return value
    /// (`Owner` is the right answer here); it is that a SUCCESSFUL PUBLISH
    /// happened before it. Under the old loop, `attempts` stopped at 2 and no
    /// publish ever succeeded.
    #[test]
    fn owner_is_never_answered_without_a_publish_that_succeeded() {
        let dir = temp_dir("elect-race");
        let path = dir.join(SIDECAR_CLAIM);
        std::fs::write(&path, record_for("ghost")).unwrap();

        let mut attempts = 0;
        let mut published = false;
        let outcome = elect_with(&path, &record_for("me"), |_| false, |p, r| {
            attempts += 1;
            if attempts <= 2 {
                // The peer got there first — twice.
                std::fs::write(p, record_for("ghost")).unwrap();
                return Ok(false);
            }
            published = publish_create_only(p, r)?;
            Ok(published)
        });

        assert!(matches!(outcome, Sidecars::Owner));
        assert!(
            published,
            "answered Owner after {attempts} publish attempts, none of which created the claim — \
             a later instance would find the slot free and own the sidecars as well"
        );
        assert_eq!(read_claim(&path).map(|c| c.run_id).as_deref(), Some("me"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_atomic_write_replaces_the_whole_record() {
        let dir = temp_dir("atomic");
        let path = dir.join("a.json");
        write_atomic(&path, "one").unwrap();
        write_atomic(&path, "two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        std::fs::remove_dir_all(&dir).ok();
    }
}
