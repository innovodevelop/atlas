// The control port's policy core: what a tier may do, on which profile, and how
// often it may do it.
//
// Everything that DECIDES is a pure function of (tier, profile) or of (bucket,
// now_ms). No `AppHandle`, no database, no wall clock, no I/O. That is the same
// discipline auth.rs follows and for the same reason: this file is the answer to
// "may the brain touch the desktop", so it has to be exhaustively testable
// without booting an app, opening a socket, or sleeping.
//
// The only impure thing here is the process-wide rate limiter at the bottom,
// which is a `static` because the four control-port workers must share one
// budget. Its arithmetic is still pure — `Bucket::try_take` takes the clock as
// an argument — so the state is the only part that needs a lock.

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use super::{Profile, Tier};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// Why a call ended up in the approvals queue instead of running. The brain
/// narrates this to the user, so the two cases have to be distinguishable: one
/// is "this always needs a human", the other is "this needed a human and you
/// were not there".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalReason {
    /// The op is declared `Tier::Approval`. It never auto-runs, on any profile.
    DeclaredApprovalTier,
    /// An `Tier::Actuate` op arrived on `Profile::Background`.
    BackgroundProfileDowngrade,
}

impl ApprovalReason {
    /// Stable machine string. The brain branches on this, not on the prose.
    pub fn code(self) -> &'static str {
        match self {
            ApprovalReason::DeclaredApprovalTier => "approval_tier",
            ApprovalReason::BackgroundProfileDowngrade => "profile_downgrade",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            ApprovalReason::DeclaredApprovalTier => {
                "this operation always requires the user to confirm it"
            }
            ApprovalReason::BackgroundProfileDowngrade => {
                "this operation changes something outside the app and the request \
                 arrived on the background profile, where no human is present to ask"
            }
        }
    }
}

/// What the dispatcher does with one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Run it, write no audit row.
    ///
    /// READS ARE NOT AUDITED, ON PURPOSE. The read budget is 60/min and the
    /// proactive cycle spends most of it on weather, quotes and headlines. A
    /// trail that records those is not a trail — it is 86,400 rows a day of
    /// noise that buries the twenty rows anyone would ever want to look at, in
    /// the same table the approvals UI reads. Reads are already bounded by the
    /// registry (only allowlisted tables and columns, always scoped to the
    /// caller's own user_id), which is a stronger guarantee than logging them
    /// after the fact would be. This is a decision, not an oversight.
    Run,
    /// Run it, but write the `tool_calls` row BEFORE dispatch.
    RunAudited,
    /// Do not run it. File it in the approvals queue and answer immediately.
    Queue(ApprovalReason),
}

impl Decision {
    pub fn executes_now(self) -> bool {
        !matches!(self, Decision::Queue(_))
    }

    pub fn audited(self) -> bool {
        matches!(self, Decision::RunAudited)
    }
}

/// The whole tier x profile matrix, in one place.
///
/// THE PROFILE DOWNGRADE IS THE POINT OF THIS FUNCTION. `Profile::Background`
/// is the headless proactive scheduler: it wakes on a timer with no window
/// open, so there is nobody to answer a prompt. It must not be able to start
/// music at 3am, and it must not be able to mark somebody's mail as read while
/// they sleep — so every `Actuate` op it asks for becomes an approval instead
/// of an action.
///
/// NO SHIPPED CALLER CAN REACH THE `(Actuate, Background)` ARM TODAY, and saying
/// so is more useful than implying it is load-bearing. The only caller that sends
/// `profile: "background"` is the proactive digest (proactive.ts), and it also
/// passes `allowMutating: false`, which makes orchestrator.ts refuse every op in
/// `ATLAS_MUTATING_OPS` — music.play/pause/volume and both mail mutations — before
/// `control.call` is reached, and `buildAtlasTools` never declares them for that
/// context either. So the arm is defence in depth: it exists so that a future
/// background caller cannot actuate BY OMISSION, and so the guarantee does not
/// depend on a TypeScript filter continuing to be applied. The consequence to keep
/// in mind while reading the rest of this module is that the queue path is
/// exercised in practice only by `mail.*`, whose tier queues on both profiles.
///
/// This lives in Rust rather than in the brain's prompt because the brain reads
/// attacker-authored text. Mail bodies, calendar invites and web content all
/// flow into the same context window that decides which tool to call; a rule
/// that exists only as a sentence in a system prompt is a rule that a
/// sufficiently well-written mail body can argue with. A `match` cannot be
/// argued with.
pub fn decide(tier: Tier, profile: Profile) -> Decision {
    match (tier, profile) {
        // Reads run on both profiles. This is what the proactive cycle is for.
        (Tier::Read, _) => Decision::Run,

        // Writes touch the local SQLite file and nothing else: reversible, visible
        // in the app, and confined to this machine. They run on both profiles,
        // audited — the audit row is what makes "Atlas added a task overnight"
        // answerable instead of mysterious.
        (Tier::Write, _) => Decision::RunAudited,

        // Actuate is anything the user can observe from outside this app:
        // audio through the speakers, a remote mailbox's unread state, a
        // request to a third party. It needs a human in front of a window.
        (Tier::Actuate, Profile::Interactive) => Decision::RunAudited,
        (Tier::Actuate, Profile::Background) => {
            Decision::Queue(ApprovalReason::BackgroundProfileDowngrade)
        }

        // Approval NEVER auto-runs. Not on Interactive either: "a human is at
        // the keyboard" is not the same statement as "a human said yes to this".
        (Tier::Approval, _) => Decision::Queue(ApprovalReason::DeclaredApprovalTier),
    }
}

/// Run `run` only if the decision permits it. `None` means the call was queued.
///
/// This exists as a function rather than an `if` in the dispatcher so that the
/// "an approval-tier call performs no side effect" test exercises the SAME code
/// the dispatcher does, instead of a copy of it that could drift.
pub fn gate<T>(decision: Decision, run: impl FnOnce() -> T) -> Option<T> {
    if decision.executes_now() {
        Some(run())
    } else {
        None
    }
}

/// Risk label for the `approvals` row. The schema's CHECK constraint allows
/// low/medium/high/critical; nothing here emits `critical`, which is reserved
/// for a capability class that does not exist yet (irreversible or financial).
pub fn risk_level(tier: Tier) -> &'static str {
    match tier {
        Tier::Read => "low",
        Tier::Write => "medium",
        Tier::Actuate | Tier::Approval => "high",
    }
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/// Per-minute ceilings, per tier.
///
/// These are budgets for a MACHINE caller, not for a person. The proactive
/// cycle legitimately burns reads in bursts (weather + quotes + headlines +
/// four table reads is one cycle), so reads get room. Writes are an order of
/// magnitude rarer in any honest workload. Actuations are rarer still — ten
/// speaker/mailbox actions in a minute is already a caller that has stopped
/// making sense, and the point of the ceiling is that a runaway tool loop costs
/// the user ten surprises rather than ten thousand.
pub const READ_PER_MIN: u32 = 60;
pub const WRITE_PER_MIN: u32 = 20;
pub const ACTUATE_PER_MIN: u32 = 10;
/// Approval-tier calls do not act — but each one raises a card the user has to
/// answer, so an unbounded stream of them is a notification-fatigue attack that
/// ends with somebody clicking yes to make it stop. Same ceiling as actuation,
/// for the same reason.
pub const APPROVAL_PER_MIN: u32 = 10;

/// Thousandths of a token. The bucket refills in integer arithmetic so it can
/// be `const`-constructed (float arithmetic in `const fn` is a recent
/// stabilisation and this crate's toolchain floor is not worth raising for it)
/// and so refill can never drift the way repeated f64 accumulation does.
const MILLI: u64 = 1_000;
const MS_PER_MIN: u64 = 60_000;

/// One token bucket. `try_take` takes the clock as an argument: no `Instant`
/// inside, so every refill and exhaustion case is testable without sleeping.
#[derive(Debug, Clone, Copy)]
pub struct Bucket {
    per_min: u32,
    milli_tokens: u64,
    /// Monotonic milliseconds at the last refill. Monotonic, not wall clock:
    /// a caller must not be able to mint tokens by moving the system clock, and
    /// an NTP step backwards must not stall the port for an hour.
    last_ms: u64,
}

impl Bucket {
    pub const fn new(per_min: u32) -> Self {
        Self {
            per_min,
            // Start full. A caller's first request should not be throttled
            // because the process happened to have just launched.
            milli_tokens: per_min as u64 * MILLI,
            last_ms: 0,
        }
    }

    const fn capacity(&self) -> u64 {
        self.per_min as u64 * MILLI
    }

    /// Refill for elapsed time, then spend one token. `false` means throttled.
    pub fn try_take(&mut self, now_ms: u64) -> bool {
        self.refill(now_ms);
        if self.milli_tokens >= MILLI {
            self.milli_tokens -= MILLI;
            true
        } else {
            false
        }
    }

    fn refill(&mut self, now_ms: u64) {
        let elapsed = now_ms.saturating_sub(self.last_ms);
        let gained = elapsed
            .saturating_mul(self.per_min as u64)
            .saturating_mul(MILLI)
            / MS_PER_MIN;
        if gained == 0 {
            // ADVANCING `last_ms` HERE WOULD BE THE BUG. With a 10/min bucket a
            // millisecond is worth a sixth of a millitoken, which truncates to
            // zero; a caller polling every millisecond would throw away every
            // remainder and the bucket would never refill at all. Leave the
            // clock where it is until it is worth something.
            return;
        }
        self.milli_tokens = (self.milli_tokens + gained).min(self.capacity());
        // Advance only by the time actually converted into tokens, so the
        // truncated remainder stays owed to the caller rather than evaporating.
        let converted_ms = gained * MS_PER_MIN / (self.per_min as u64 * MILLI);
        self.last_ms = self.last_ms.saturating_add(converted_ms);
    }

    /// Milliseconds until one whole token is available. Only meaningful right
    /// after a `false` from `try_take`; rounded up, so a caller that waits
    /// exactly this long succeeds rather than missing by a millisecond.
    pub fn retry_after_ms(&self) -> u64 {
        let missing = MILLI.saturating_sub(self.milli_tokens);
        if missing == 0 {
            return 0;
        }
        let per_ms_numerator = self.per_min as u64 * MILLI;
        (missing * MS_PER_MIN).div_ceil(per_ms_numerator)
    }

    #[cfg(test)]
    fn milli_tokens(&self) -> u64 {
        self.milli_tokens
    }
}

/// One bucket per tier. Tiers do not share a budget: a write-heavy minute must
/// not be able to starve the reads the assistant needs to answer a question,
/// and — more importantly — a caller must not be able to exhaust the actuation
/// ceiling cheaply by spending it on reads.
#[derive(Debug)]
pub struct Limiter {
    read: Bucket,
    write: Bucket,
    actuate: Bucket,
    approval: Bucket,
}

impl Limiter {
    pub const fn new() -> Self {
        Self {
            read: Bucket::new(READ_PER_MIN),
            write: Bucket::new(WRITE_PER_MIN),
            actuate: Bucket::new(ACTUATE_PER_MIN),
            approval: Bucket::new(APPROVAL_PER_MIN),
        }
    }

    fn bucket_mut(&mut self, tier: Tier) -> &mut Bucket {
        match tier {
            Tier::Read => &mut self.read,
            Tier::Write => &mut self.write,
            Tier::Actuate => &mut self.actuate,
            Tier::Approval => &mut self.approval,
        }
    }

    /// `Err(retry_after_ms)` when throttled.
    ///
    /// Charged against the op's DECLARED tier, not the tier it was downgraded
    /// to. Otherwise a caller could spend the cheap approval budget by asking
    /// for actuations on the background profile, and the actuate ceiling would
    /// only ever apply to the callers that were behaving.
    pub fn check(&mut self, tier: Tier, now_ms: u64) -> Result<(), u64> {
        let bucket = self.bucket_mut(tier);
        if bucket.try_take(now_ms) {
            Ok(())
        } else {
            Err(bucket.retry_after_ms())
        }
    }
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new()
    }
}

/// The process-wide budget, shared by all four control-port workers.
///
/// A `Mutex` and not atomics: a bucket is two coupled fields (level and refill
/// clock) that have to move together, and any per-field atomic scheme lets two
/// workers interleave a refill and hand out the same token twice — which is
/// exactly the case the ceiling exists to prevent. The critical section is a
/// handful of integer operations with no allocation and no I/O, so four
/// threads contending on it is not a throughput question.
static LIMITER: Mutex<Limiter> = Mutex::new(Limiter::new());

/// Milliseconds since the first call, from a monotonic source. Shared with the
/// approvals queue in mod.rs so both age things against the same clock.
pub fn monotonic_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Spend one token for `tier`. `Err(retry_after_ms)` means throttled.
pub fn check_rate(tier: Tier) -> Result<(), u64> {
    let now = monotonic_ms();
    // A poisoned limiter means some other thread panicked while holding a lock
    // over four integers. Recovering the inner state is right: there is no
    // invariant a panic could have broken here, and the alternatives are both
    // wrong — unwrapping turns one panic into a permanently dead control port,
    // and treating the error as "allow" removes the ceiling exactly when
    // something has already gone wrong.
    let mut limiter = LIMITER.lock().unwrap_or_else(|e| e.into_inner());
    limiter.check(tier, now)
}

/// Per-minute ceiling for a tier, for error messages and capability reporting.
pub fn limit_for(tier: Tier) -> u32 {
    match tier {
        Tier::Read => READ_PER_MIN,
        Tier::Write => WRITE_PER_MIN,
        Tier::Actuate => ACTUATE_PER_MIN,
        Tier::Approval => APPROVAL_PER_MIN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TIERS: [Tier; 4] = [Tier::Read, Tier::Write, Tier::Actuate, Tier::Approval];
    const PROFILES: [Profile; 2] = [Profile::Interactive, Profile::Background];

    // --- the gate matrix ---------------------------------------------------

    /// Every cell, written out. If somebody changes `decide`, this is the test
    /// that makes them say so out loud.
    #[test]
    fn gate_matrix_is_exhaustive_and_exact() {
        let expected = [
            ((Tier::Read, Profile::Interactive), Decision::Run),
            ((Tier::Read, Profile::Background), Decision::Run),
            ((Tier::Write, Profile::Interactive), Decision::RunAudited),
            ((Tier::Write, Profile::Background), Decision::RunAudited),
            ((Tier::Actuate, Profile::Interactive), Decision::RunAudited),
            (
                (Tier::Actuate, Profile::Background),
                Decision::Queue(ApprovalReason::BackgroundProfileDowngrade),
            ),
            (
                (Tier::Approval, Profile::Interactive),
                Decision::Queue(ApprovalReason::DeclaredApprovalTier),
            ),
            (
                (Tier::Approval, Profile::Background),
                Decision::Queue(ApprovalReason::DeclaredApprovalTier),
            ),
        ];
        // The table above must cover the whole space, not a convenient subset.
        assert_eq!(expected.len(), TIERS.len() * PROFILES.len());
        for ((tier, profile), want) in expected {
            assert_eq!(
                decide(tier, profile),
                want,
                "{:?} on {:?}",
                tier,
                profile
            );
        }
    }

    #[test]
    fn approval_tier_never_auto_runs_on_any_profile() {
        for profile in PROFILES {
            assert!(!decide(Tier::Approval, profile).executes_now());
        }
    }

    #[test]
    fn actuate_runs_only_on_the_interactive_profile() {
        assert!(decide(Tier::Actuate, Profile::Interactive).executes_now());
        assert!(!decide(Tier::Actuate, Profile::Background).executes_now());
    }

    /// The invariant the dispatcher relies on: it writes the `running` audit row
    /// before calling `gate`, so anything marked audited MUST actually run —
    /// otherwise the row is stranded in `running` forever.
    #[test]
    fn nothing_is_audited_that_does_not_execute() {
        for tier in TIERS {
            for profile in PROFILES {
                let d = decide(tier, profile);
                assert!(
                    !d.audited() || d.executes_now(),
                    "{tier:?}/{profile:?} would write a running row for a call that never runs"
                );
            }
        }
    }

    #[test]
    fn reads_are_deliberately_not_audited() {
        for profile in PROFILES {
            assert!(!decide(Tier::Read, profile).audited());
        }
    }

    /// The headline property: a queued call performs NO side effect. The
    /// counter stands in for whatever the op would have done.
    #[test]
    fn queued_calls_never_touch_the_runner() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        let mut expected_calls = 0;
        for tier in TIERS {
            for profile in PROFILES {
                let decision = decide(tier, profile);
                let out = gate(decision, || {
                    CALLS.fetch_add(1, Ordering::SeqCst);
                    "ran"
                });
                match decision {
                    Decision::Queue(_) => assert_eq!(out, None, "{tier:?}/{profile:?} ran anyway"),
                    _ => {
                        expected_calls += 1;
                        assert_eq!(out, Some("ran"), "{tier:?}/{profile:?} did not run");
                    }
                }
                assert_eq!(
                    CALLS.load(Ordering::SeqCst),
                    expected_calls,
                    "side-effect count wrong after {tier:?}/{profile:?}"
                );
            }
        }
        // Read x2, Write x2, Actuate/Interactive: five of the eight cells run.
        assert_eq!(CALLS.load(Ordering::SeqCst), 5);
    }

    #[test]
    fn approval_reasons_are_distinguishable_on_the_wire() {
        assert_eq!(
            ApprovalReason::DeclaredApprovalTier.code(),
            "approval_tier"
        );
        assert_eq!(
            ApprovalReason::BackgroundProfileDowngrade.code(),
            "profile_downgrade"
        );
        assert_ne!(
            ApprovalReason::DeclaredApprovalTier.code(),
            ApprovalReason::BackgroundProfileDowngrade.code()
        );
    }

    #[test]
    fn risk_levels_match_the_schema_check_constraint() {
        let allowed = ["low", "medium", "high", "critical"];
        for tier in TIERS {
            assert!(
                allowed.contains(&risk_level(tier)),
                "{tier:?} produces a risk_level the approvals CHECK would reject"
            );
        }
        assert_eq!(risk_level(Tier::Read), "low");
        assert_eq!(risk_level(Tier::Write), "medium");
        assert_eq!(risk_level(Tier::Actuate), "high");
        assert_eq!(risk_level(Tier::Approval), "high");
    }

    // --- buckets -----------------------------------------------------------

    #[test]
    fn bucket_starts_full_and_exhausts_at_the_ceiling() {
        let mut b = Bucket::new(10);
        for i in 0..10 {
            assert!(b.try_take(0), "token {i} should have been available");
        }
        assert!(!b.try_take(0), "an 11th call in the same instant must throttle");
    }

    #[test]
    fn bucket_refills_at_the_declared_rate() {
        let mut b = Bucket::new(60); // one token per second
        for _ in 0..60 {
            assert!(b.try_take(0));
        }
        assert!(!b.try_take(0));
        // Half a second buys nothing whole.
        assert!(!b.try_take(500));
        // A full second buys exactly one.
        assert!(b.try_take(1_000));
        assert!(!b.try_take(1_000));
    }

    /// The remainder-loss bug this bucket is written to avoid: polling faster
    /// than one token's worth of time must not reset the refill clock.
    #[test]
    fn frequent_polling_does_not_starve_the_bucket() {
        let mut b = Bucket::new(10); // one token per 6s
        for _ in 0..10 {
            assert!(b.try_take(0));
        }
        // Hammer it every millisecond for six seconds.
        for ms in 1..6_000 {
            assert!(!b.try_take(ms), "granted a token early at {ms}ms");
        }
        assert!(b.try_take(6_000), "the token owed at 6s never arrived");
    }

    #[test]
    fn bucket_never_accumulates_more_than_its_capacity() {
        let mut b = Bucket::new(10);
        for _ in 0..10 {
            assert!(b.try_take(0));
        }
        // An hour idle must not bank an hour's worth of actuations.
        assert!(b.try_take(3_600_000));
        let mut granted = 1;
        while b.try_take(3_600_000) {
            granted += 1;
            assert!(granted <= 10, "banked more than one minute of budget");
        }
        assert_eq!(granted, 10);
    }

    #[test]
    fn retry_after_is_rounded_up_and_is_actually_enough() {
        let mut b = Bucket::new(10); // one token per 6s
        for _ in 0..10 {
            assert!(b.try_take(0));
        }
        assert!(!b.try_take(0));
        let wait = b.retry_after_ms();
        assert_eq!(wait, 6_000);
        assert!(b.try_take(wait), "waiting the advertised time was not enough");
    }

    #[test]
    fn retry_after_shrinks_as_the_bucket_refills() {
        let mut b = Bucket::new(10);
        for _ in 0..10 {
            assert!(b.try_take(0));
        }
        assert!(!b.try_take(0));
        let full_wait = b.retry_after_ms();
        assert!(!b.try_take(3_000));
        let partial_wait = b.retry_after_ms();
        assert!(
            partial_wait < full_wait,
            "waiting half the interval bought nothing: {partial_wait} vs {full_wait}"
        );
        assert!(b.milli_tokens() > 0);
    }

    // --- limiter -----------------------------------------------------------

    #[test]
    fn each_tier_has_its_own_budget() {
        let mut l = Limiter::new();
        for _ in 0..ACTUATE_PER_MIN {
            assert!(l.check(Tier::Actuate, 0).is_ok());
        }
        assert!(l.check(Tier::Actuate, 0).is_err(), "actuate should be spent");
        // Spending the actuate budget must not have touched the others.
        assert!(l.check(Tier::Read, 0).is_ok());
        assert!(l.check(Tier::Write, 0).is_ok());
        assert!(l.check(Tier::Approval, 0).is_ok());
    }

    #[test]
    fn limiter_reports_a_usable_backoff() {
        let mut l = Limiter::new();
        for _ in 0..WRITE_PER_MIN {
            assert!(l.check(Tier::Write, 0).is_ok());
        }
        let Err(retry) = l.check(Tier::Write, 0) else {
            panic!("write budget should be spent");
        };
        assert!(retry > 0);
        assert!(l.check(Tier::Write, retry).is_ok());
    }

    #[test]
    fn declared_ceilings_are_the_ones_reported() {
        assert_eq!(limit_for(Tier::Read), 60);
        assert_eq!(limit_for(Tier::Write), 20);
        assert_eq!(limit_for(Tier::Actuate), 10);
        assert_eq!(limit_for(Tier::Approval), 10);
    }
}
