// Local proactive scheduler (Phase 4) — the on-device replacement for the
// pg_cron trigger that used to drive `atlas-daily-digest`.
//
// A single background thread wakes every TICK and POSTs /proactive/cycle to
// the brain sidecar on 127.0.0.1, authenticated by the shared SIDECAR_TOKEN.
// The Rust side is deliberately dumb: all judgement (cooldown, learning
// on/off, user resolution, insight quality, cost caps) lives in the brain —
// the brain refuses early re-runs, so ticking more often than the digest
// interval is harmless.
//
// Plain std::thread + blocking ureq (the house HTTP style — see datafetch.rs)
// instead of a tokio task: the app's tokio features don't include `time`, and
// an mpsc `recv_timeout` doubles as an interruptible sleep, so `stop()` wakes
// the thread immediately at app exit instead of waiting out the tick.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Duration;

/// First tick waits this long so the brain sidecar has booted and app startup
/// is never competing with a digest run.
const STARTUP_DELAY: Duration = Duration::from_secs(120);
/// Wake interval. The brain enforces the real digest cadence (default 12h);
/// a modest tick just bounds how stale a due run can get.
const TICK: Duration = Duration::from_secs(30 * 60);
/// One cheap-tier completion — generous ceiling so a slow run can't pile up
/// concurrent requests (the next tick is 30 min away regardless).
const HTTP_TIMEOUT: Duration = Duration::from_secs(180);

pub struct ProactiveScheduler {
    stop_tx: Mutex<Option<Sender<()>>>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl ProactiveScheduler {
    /// Spawn the scheduler thread. Never blocks: spawning is instant and the
    /// thread itself sleeps before its first request.
    pub fn spawn(token: String, brain_port: u16) -> Self {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let handle = std::thread::Builder::new()
            .name("proactive-scheduler".into())
            .spawn(move || {
                let url = format!("http://127.0.0.1:{brain_port}/proactive/cycle");
                let mut wait = STARTUP_DELAY;
                loop {
                    match stop_rx.recv_timeout(wait) {
                        // Sender dropped/signalled: app is exiting.
                        Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    wait = TICK;
                    // The brain may not be up yet (dev mode, slow boot) — any
                    // failure just means "try again next tick", never a panic.
                    // No JWT here: the brain resolves the local user itself
                    // (see proactive.ts's scheduler fallback).
                    match ureq::post(&url)
                        .timeout(HTTP_TIMEOUT)
                        .set("x-sidecar-token", &token)
                        .set("Content-Type", "application/json")
                        .send_string("{}")
                    {
                        Ok(res) => {
                            let body = res.into_string().unwrap_or_default();
                            eprintln!("[atlas] proactive cycle: {}", body.trim());
                        }
                        Err(e) => eprintln!("[atlas] proactive cycle skipped (brain unreachable?): {e}"),
                    }
                }
            })
            .expect("spawn proactive-scheduler thread");
        Self {
            stop_tx: Mutex::new(Some(stop_tx)),
            handle: Mutex::new(Some(handle)),
        }
    }

    /// Signal the thread to exit. Wakes an idle sleep immediately; a thread
    /// mid-request is not joined (join could block up to HTTP_TIMEOUT and the
    /// process teardown reaps it anyway — same spirit as the sidecar kills).
    pub fn stop(&self) {
        if let Ok(mut tx) = self.stop_tx.lock() {
            tx.take(); // dropping the Sender disconnects recv_timeout
        }
        if let Ok(mut handle) = self.handle.lock() {
            if let Some(h) = handle.take() {
                if h.is_finished() {
                    let _ = h.join();
                    eprintln!("[atlas] proactive scheduler stopped");
                }
            }
        }
    }
}
