// The Apple Health export importer — the ONE path to health data that works on
// this platform today.
//
// WHY THIS AND NOTHING ELSE
// `HKHealthStore.isHealthDataAvailable()` returns FALSE on macOS 26.3. That was
// compiled and run natively, and it is a DEVICE CAPABILITY answer, not a
// permission one: signing the app and adding the entitlement would not change
// it, because this Mac has no HealthKit store to serve from. See
// docs/decisions/008 and src-tauri/tests/platform_health_home_wall.rs. So there
// is no live source to poll, no background sync to schedule, and nothing to
// pair with. What a person CAN do, today, unaided, is tap "Export All Health
// Data" on their iPhone and hand the resulting zip to Atlas. That is this file.
//
// THE TWO THINGS THAT DECIDE ITS SHAPE
//
// 1. THE FILE IS ENORMOUS. A few years of an Apple Watch is hundreds of
//    megabytes of XML and millions of `<Record>` elements — heart rate alone is
//    a sample every few seconds. So it is STREAMED: `ingest` below holds one
//    element at a time (xml.rs reuses a single buffer) plus one accumulator per
//    (day, metric, source), and never the document. Nothing here calls
//    `read_to_string`.
//
// 2. THE FILE IS USER-SUPPLIED INPUT, and "the user supplied it" is not the
//    same as "the user wrote it" — it arrives by AirDrop, email, or a download.
//    Every failure is a `HealthError`; nothing here panics, indexes blindly, or
//    recurses. That matters more than it looks: this is reachable from a control
//    worker, and a panic in one used to retire that worker for the life of the
//    process, so a single bad byte in a stranger's export could have taken the
//    whole tool surface down until the app was restarted.
//
// WHAT GETS STORED: DERIVED VALUES ONLY
// The widgets ask for "7h 12m, deep 1h 40m". That is six numbers; the night
// behind it is a few hundred interval samples. Aggregation happens HERE, in
// memory, and only the day's derived values reach SQLite — see the note above
// `health_metrics` in db_schema.sql for why that is a privacy decision as much
// as a storage one.
//
// THE DE-DUPLICATION RULE, WHICH IS THE SUBTLEST THING IN THIS FILE
// A person wearing a Watch and carrying an iPhone has BOTH devices writing step
// records for the same walk. Adding them up double-counts, and a step count
// that is silently 1.8x is worse than no step count — it is a plausible number
// that is wrong, which is the exact failure this product refuses. So for a
// CUMULATIVE metric the day's value is the largest single SOURCE's total, and
// the winning source is stored next to the value so the person can check it.
// For an INSTANTANEOUS metric (heart rate) two sources are not double-counting
// — they are two readings — so those are merged across sources instead.
// `the_watch_and_the_phone_do_not_add_up_to_two_peoples_steps` is that rule.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{Datelike, NaiveDate};
use sha2::{Digest, Sha256};

use super::xml::{Kind, Scanner, XmlLimits};
use super::zip;
use super::HealthError;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub xml: XmlLimits,
    /// `<Record>` elements read before the import gives up. 30 million is more
    /// than a decade of continuous Watch wear; past it the file is not an
    /// export of one person's health.
    pub max_records: u64,
    pub max_workouts: usize,
    /// Distinct (day, metric, source) accumulators held in memory. Each is ~64
    /// bytes, so this caps the importer's own footprint at a few hundred MB in
    /// the worst case and at a few MB for any real export (a decade × 14
    /// metrics × 4 devices is about 200k).
    pub max_buckets: usize,
    /// Distinct `sourceName` values interned. Beyond this, further names are
    /// pooled under the unknown source rather than growing the table.
    pub max_sources: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            xml: XmlLimits::default(),
            max_records: 30_000_000,
            max_workouts: 100_000,
            max_buckets: 4_000_000,
            max_sources: 4096,
        }
    }
}

/// Calendar years an export may cover. A date outside this is not a date this
/// person recorded, and accepting it would let one typo (or one crafted
/// element) create a bucket for the year 9999 and a "first day" a surface would
/// then render.
const MIN_YEAR: i32 = 1900;
const MAX_YEAR: i32 = 2200;

/// Longest single interval sample believed. Sleep and workout records carry a
/// start and an end; anything claiming more than a day is a broken record, not
/// a very long night.
const MAX_INTERVAL_MINUTES: f64 = 24.0 * 60.0;

// ---------------------------------------------------------------------------
// The metric vocabulary
// ---------------------------------------------------------------------------

/// How a day's samples become one number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stat {
    /// Cumulative: the day's total. De-duplicated across sources.
    Sum,
    /// Instantaneous: the day's mean, with the day's range in `low`/`high`.
    Avg,
    /// Minutes spent in a state, from interval samples.
    Duration,
}

impl Stat {
    pub fn as_str(self) -> &'static str {
        match self {
            Stat::Sum => "sum",
            Stat::Avg => "avg",
            Stat::Duration => "duration",
        }
    }
}

/// The physical dimension a record's `unit` attribute is read against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dim {
    Count,
    Distance,
    Energy,
    Time,
    Mass,
    Rate,
    Millis,
}

/// Convert `value` from the export's `unit` into the canonical unit for `dim`.
///
/// A UNIT THIS DOES NOT KNOW IS A REJECTION, NEVER AN ASSUMPTION. A US export
/// writes `mi` and `Cal` where a European one writes `km` and `kcal`; guessing
/// wrong by a factor of 1.6 produces a number that looks entirely reasonable on
/// a card and is not true.
fn to_canonical(dim: Dim, unit: &str, value: f64) -> Option<f64> {
    let factor = match (dim, unit) {
        (Dim::Count, "count") => 1.0,
        (Dim::Distance, "km") => 1.0,
        (Dim::Distance, "m") => 0.001,
        (Dim::Distance, "mi") => 1.609_344,
        (Dim::Distance, "ft") => 0.000_304_8,
        (Dim::Distance, "yd") => 0.000_914_4,
        (Dim::Energy, "kcal" | "Cal") => 1.0,
        (Dim::Energy, "cal") => 0.001,
        (Dim::Energy, "kJ") => 0.239_005_736,
        (Dim::Energy, "J") => 0.000_239_005_736,
        (Dim::Time, "min") => 1.0,
        (Dim::Time, "hr") => 60.0,
        (Dim::Time, "sec" | "s") => 1.0 / 60.0,
        (Dim::Mass, "kg") => 1.0,
        (Dim::Mass, "g") => 0.001,
        (Dim::Mass, "lb") => 0.453_592_37,
        (Dim::Mass, "st") => 6.350_293_18,
        (Dim::Rate, "count/min") => 1.0,
        (Dim::Millis, "ms") => 1.0,
        (Dim::Millis, "s") => 1000.0,
        _ => return None,
    };
    Some(value * factor)
}

struct MetricSpec {
    /// Apple's identifier. THE ONLY PLACE `HKQuantityTypeIdentifier…` strings
    /// appear — nothing downstream of `ingest` knows Apple's vocabulary.
    hk: &'static str,
    /// The name written to `health_metrics.metric`.
    metric: &'static str,
    stat: Stat,
    dim: Dim,
    unit: &'static str,
    /// Believable range for ONE SAMPLE in the canonical unit.
    ///
    /// Bounds are on the sample, not on the day's total, deliberately: a day
    /// total is a legitimate sum of many samples and there is no honest ceiling
    /// on it, whereas a single record claiming 900 million steps is a broken
    /// record. Rejecting the day would throw away real data to punish one bad
    /// element.
    min: f64,
    max: f64,
}

/// Every Apple type Atlas derives a metric from.
///
/// SHORT ON PURPOSE. Each row is a claim that we know what Apple means by that
/// identifier and what unit string it arrives in, and the cost of being wrong is
/// a card that shows a confident wrong number. Types whose export encoding is
/// not certain from the documentation — blood oxygen (fraction or percent?),
/// body fat, VO2 max (`mL/min·kg`, with a middle dot) — are deliberately absent
/// rather than guessed at. Adding one means checking it against a real export.
static METRICS: &[MetricSpec] = &[
    MetricSpec { hk: "HKQuantityTypeIdentifierStepCount", metric: "steps", stat: Stat::Sum, dim: Dim::Count, unit: "count", min: 0.0, max: 100_000.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierDistanceWalkingRunning", metric: "distance_walking_running_km", stat: Stat::Sum, dim: Dim::Distance, unit: "km", min: 0.0, max: 500.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierDistanceCycling", metric: "distance_cycling_km", stat: Stat::Sum, dim: Dim::Distance, unit: "km", min: 0.0, max: 1_000.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierFlightsClimbed", metric: "flights_climbed", stat: Stat::Sum, dim: Dim::Count, unit: "count", min: 0.0, max: 10_000.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierActiveEnergyBurned", metric: "active_energy_kcal", stat: Stat::Sum, dim: Dim::Energy, unit: "kcal", min: 0.0, max: 20_000.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierBasalEnergyBurned", metric: "basal_energy_kcal", stat: Stat::Sum, dim: Dim::Energy, unit: "kcal", min: 0.0, max: 20_000.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierAppleExerciseTime", metric: "exercise_minutes", stat: Stat::Sum, dim: Dim::Time, unit: "min", min: 0.0, max: 1_440.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierAppleStandTime", metric: "stand_minutes", stat: Stat::Sum, dim: Dim::Time, unit: "min", min: 0.0, max: 1_440.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierHeartRate", metric: "heart_rate_bpm", stat: Stat::Avg, dim: Dim::Rate, unit: "count/min", min: 20.0, max: 300.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierRestingHeartRate", metric: "resting_heart_rate_bpm", stat: Stat::Avg, dim: Dim::Rate, unit: "count/min", min: 20.0, max: 200.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierWalkingHeartRateAverage", metric: "walking_heart_rate_bpm", stat: Stat::Avg, dim: Dim::Rate, unit: "count/min", min: 20.0, max: 250.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", metric: "heart_rate_variability_ms", stat: Stat::Avg, dim: Dim::Millis, unit: "ms", min: 1.0, max: 500.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierRespiratoryRate", metric: "respiratory_rate_bpm", stat: Stat::Avg, dim: Dim::Rate, unit: "count/min", min: 3.0, max: 60.0 },
    MetricSpec { hk: "HKQuantityTypeIdentifierBodyMass", metric: "body_mass_kg", stat: Stat::Avg, dim: Dim::Mass, unit: "kg", min: 2.0, max: 500.0 },
];

fn spec_for(hk: &str) -> Option<(usize, &'static MetricSpec)> {
    METRICS.iter().enumerate().find(|(_, s)| s.hk == hk)
}

/// The six sleep metrics, in the order `fold` emits them.
///
/// THE ORDER IS LOAD-BEARING: `fold` zips this list against a tuple of minutes,
/// so swapping two entries here would silently file deep sleep as REM.
/// `the_sleep_metrics_are_emitted_in_the_order_this_list_declares` is the guard.
pub const SLEEP_METRICS: &[&str] = &[
    "sleep_asleep_minutes",
    "sleep_core_minutes",
    "sleep_deep_minutes",
    "sleep_rem_minutes",
    "sleep_awake_minutes",
    "sleep_in_bed_minutes",
];

/// Every metric name a `MetricRow` can carry.
///
/// Published so the presentation table in store.rs can be proved complete
/// against it — a metric this importer can produce and that nothing knows how
/// to name would reach a card as a raw identifier.
pub fn emittable_metrics() -> Vec<&'static str> {
    METRICS
        .iter()
        .map(|s| s.metric)
        .chain(SLEEP_METRICS.iter().copied())
        .collect()
}

// --- sleep -----------------------------------------------------------------

const SLEEP_TYPE: &str = "HKCategoryTypeIdentifierSleepAnalysis";

/// The stages a sleep record can be in.
///
/// Both spellings are accepted because both ship: modern exports write the
/// symbol name, and older ones (and some third-party writers) write the raw
/// integer. An unrecognised value is REJECTED rather than folded into "asleep"
/// — a stage we cannot name is minutes we cannot honestly attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    InBed,
    AsleepUnspecified,
    Core,
    Deep,
    Rem,
    Awake,
}

fn stage_for(value: &str) -> Option<Stage> {
    let short = value
        .strip_prefix("HKCategoryValueSleepAnalysis")
        .unwrap_or(value);
    Some(match short {
        "InBed" | "0" => Stage::InBed,
        "Asleep" | "AsleepUnspecified" | "1" => Stage::AsleepUnspecified,
        "Awake" | "2" => Stage::Awake,
        "AsleepCore" | "3" => Stage::Core,
        "AsleepDeep" | "4" => Stage::Deep,
        "AsleepREM" | "5" => Stage::Rem,
        _ => return None,
    })
}

/// One night's minutes per stage, for one source.
#[derive(Debug, Default, Clone, Copy)]
struct Stages {
    in_bed: f64,
    unspecified: f64,
    core: f64,
    deep: f64,
    rem: f64,
    awake: f64,
    samples: u64,
}

impl Stages {
    fn asleep(&self) -> f64 {
        self.unspecified + self.core + self.deep + self.rem
    }

    fn add(&mut self, stage: Stage, minutes: f64) {
        match stage {
            Stage::InBed => self.in_bed += minutes,
            Stage::AsleepUnspecified => self.unspecified += minutes,
            Stage::Core => self.core += minutes,
            Stage::Deep => self.deep += minutes,
            Stage::Rem => self.rem += minutes,
            Stage::Awake => self.awake += minutes,
        }
        self.samples += 1;
    }
}

// ---------------------------------------------------------------------------
// What comes out
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct MetricRow {
    pub day: NaiveDate,
    pub metric: &'static str,
    pub value: f64,
    pub unit: &'static str,
    pub stat: Stat,
    pub sample_count: u64,
    /// The source the value came from. `None` when the export named none.
    pub source: Option<String>,
    pub low: Option<f64>,
    pub high: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkoutRow {
    pub external_id: String,
    pub activity: String,
    pub started_at: String,
    pub ended_at: String,
    pub day: NaiveDate,
    pub duration_min: f64,
    pub distance_km: Option<f64>,
    pub energy_kcal: Option<f64>,
    pub avg_heart_rate: Option<f64>,
    pub source: Option<String>,
}

/// Why records were not used, and how many of each.
///
/// A FIXED VOCABULARY, not free text taken from the file. These strings are
/// shown to the user and can reach the model, and the only safe way to describe
/// a hostile document is in words we wrote ourselves.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Rejections {
    pub unreadable_date: u64,
    pub unreadable_value: u64,
    pub out_of_range: u64,
    pub unknown_unit: u64,
    pub unknown_sleep_stage: u64,
    pub impossible_interval: u64,
}

impl Rejections {
    pub fn total(&self) -> u64 {
        self.unreadable_date
            + self.unreadable_value
            + self.out_of_range
            + self.unknown_unit
            + self.unknown_sleep_stage
            + self.impossible_interval
    }

    /// (reason, count) for the reasons that actually happened.
    pub fn reasons(&self) -> Vec<(&'static str, u64)> {
        [
            ("unreadable date", self.unreadable_date),
            ("unreadable value", self.unreadable_value),
            ("value outside the possible range", self.out_of_range),
            ("a unit Atlas does not know", self.unknown_unit),
            ("an unrecognised sleep stage", self.unknown_sleep_stage),
            ("an interval longer than a day", self.impossible_interval),
        ]
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportReport {
    pub file_name: String,
    pub file_bytes: Option<u64>,
    /// The export's own `<ExportDate>` — when the data was true, which is not
    /// when the file was imported.
    pub export_date: Option<String>,
    pub records_read: u64,
    pub records_used: u64,
    /// Valid Apple records for a type Atlas derives nothing from. Not a
    /// failure — an export carries dozens of types no surface here asks for.
    pub records_ignored: u64,
    pub rejections: Rejections,
    pub workouts: usize,
    pub days: usize,
    pub first_day: Option<NaiveDate>,
    pub last_day: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Derived {
    pub metrics: Vec<MetricRow>,
    pub workouts: Vec<WorkoutRow>,
    pub report: ImportReport,
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Copy)]
struct Acc {
    count: u64,
    sum: f64,
    low: f64,
    high: f64,
}

impl Acc {
    fn add(&mut self, v: f64) {
        if self.count == 0 {
            self.low = v;
            self.high = v;
        } else {
            self.low = self.low.min(v);
            self.high = self.high.max(v);
        }
        self.count += 1;
        self.sum += v;
    }
}

/// Interned `sourceName` values. Index 0 is always the unnamed source, so a
/// record with no `sourceName` costs nothing and needs no `Option` in the key.
struct Sources {
    names: Vec<String>,
    index: HashMap<String, u32>,
    /// Set once the table is full. Reported, because after this point the
    /// de-duplication rule is working with pooled sources and the answer it
    /// gives is weaker than usual.
    saturated: bool,
}

impl Sources {
    fn new() -> Self {
        Self { names: vec![String::new()], index: HashMap::new(), saturated: false }
    }

    fn intern(&mut self, name: &str, max: usize) -> u32 {
        let name = name.trim();
        if name.is_empty() {
            return 0;
        }
        if let Some(ix) = self.index.get(name) {
            return *ix;
        }
        if self.names.len() >= max {
            self.saturated = true;
            return 0;
        }
        let ix = self.names.len() as u32;
        self.names.push(name.to_string());
        self.index.insert(name.to_string(), ix);
        ix
    }

    fn name(&self, ix: u32) -> Option<&str> {
        self.names.get(ix as usize).filter(|n| !n.is_empty()).map(String::as_str)
    }
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/// Read the export at `path` and return the derived values.
///
/// This is the whole importer's public surface: a path in, derived rows out,
/// nothing written. Persisting is `store::apply_import`'s job, so the parse can
/// be tested — and can fail — without touching the database. An import that
/// blows a limit half way leaves the previous import intact because it never
/// got as far as a transaction.
pub fn read_export(path: &Path, limits: Limits) -> Result<Derived, HealthError> {
    let mut stream = zip::open(path)?;
    let label = stream.label.clone();
    let bytes = stream.bytes;
    let mut derived = ingest(stream.reader(), limits)?;
    // AFTER the read, and not optional: a pipe that ended early looks exactly
    // like a smaller export. See `ExportStream::finish`.
    stream.finish()?;
    derived.report.file_name = label;
    derived.report.file_bytes = bytes;
    Ok(derived)
}

/// Parse an export document into derived daily values.
///
/// Separate from `read_export` so every test below can hand it bytes. Holds one
/// element, one accumulator table and one workout list — never the document.
pub fn ingest<R: Read>(src: R, limits: Limits) -> Result<Derived, HealthError> {
    let mut scanner = Scanner::new(src, limits.xml);
    let mut sources = Sources::new();
    // (day, metric index, source index) -> accumulator.
    let mut buckets: HashMap<(NaiveDate, u16, u32), Acc> = HashMap::new();
    let mut sleep: HashMap<(NaiveDate, u32), Stages> = HashMap::new();
    let mut workouts: Vec<WorkoutRow> = Vec::new();
    let mut pending: Option<PendingWorkout> = None;

    let mut export_date: Option<String> = None;
    let mut saw_root = false;
    let mut records_read = 0u64;
    let mut records_used = 0u64;
    let mut records_ignored = 0u64;
    let mut rejections = Rejections::default();

    while let Some(el) = scanner.next_element()? {
        let closing = el.kind == Some(Kind::Close);
        match el.name.as_str() {
            "HealthData" => saw_root = true,
            "ExportDate" if !closing => {
                if export_date.is_none() {
                    export_date = el.attr("value").map(str::to_string);
                }
            }
            "Record" if !closing => {
                records_read += 1;
                if records_read > limits.max_records {
                    return Err(HealthError::TooLarge(format!(
                        "this export has more than {} records — Atlas will not read a file that large",
                        limits.max_records
                    )));
                }
                let Some(kind) = el.attr("type") else {
                    rejections.unreadable_value += 1;
                    continue;
                };
                let source_ix = sources.intern(el.attr("sourceName").unwrap_or(""), limits.max_sources);

                if kind == SLEEP_TYPE {
                    match sleep_sample(el.attr("value"), el.attr("startDate"), el.attr("endDate")) {
                        Ok((day, stage, minutes)) => {
                            if sleep.len() >= limits.max_buckets && !sleep.contains_key(&(day, source_ix)) {
                                return Err(too_many_buckets(limits));
                            }
                            sleep.entry((day, source_ix)).or_default().add(stage, minutes);
                            records_used += 1;
                        }
                        Err(reason) => reason.count(&mut rejections),
                    }
                    continue;
                }

                let Some((ix, spec)) = spec_for(kind) else {
                    records_ignored += 1;
                    continue;
                };
                match quantity_sample(spec, el.attr("value"), el.attr("unit"), el.attr("startDate")) {
                    Ok((day, value)) => {
                        let key = (day, ix as u16, source_ix);
                        if buckets.len() >= limits.max_buckets && !buckets.contains_key(&key) {
                            return Err(too_many_buckets(limits));
                        }
                        buckets.entry(key).or_default().add(value);
                        records_used += 1;
                    }
                    Err(reason) => reason.count(&mut rejections),
                }
            }
            "Workout" => {
                if closing {
                    if let Some(p) = pending.take() {
                        workouts.push(p.finish());
                    }
                    continue;
                }
                // A self-closing `<Workout …/>` carries everything in its own
                // attributes; an open one may still be corrected by the
                // `<WorkoutStatistics>` children that follow.
                match PendingWorkout::start(el, &mut sources, limits.max_sources) {
                    Ok(p) => {
                        if workouts.len() >= limits.max_workouts {
                            return Err(HealthError::TooLarge(format!(
                                "this export has more than {} workouts",
                                limits.max_workouts
                            )));
                        }
                        if el.kind == Some(Kind::Empty) {
                            workouts.push(p.finish());
                        } else {
                            pending = Some(p);
                        }
                    }
                    Err(reason) => reason.count(&mut rejections),
                }
            }
            // Only a DIRECT child of the workout being assembled. The same
            // element name appears inside `<WorkoutRoute>`, where it describes
            // the route rather than the workout.
            "WorkoutStatistics" if !closing && el.parent() == Some("Workout") => {
                if let Some(p) = pending.as_mut() {
                    p.absorb(el);
                }
            }
            _ => {}
        }
    }
    // A `<Workout>` whose closing tag never arrived is impossible here: the
    // scanner refuses a document that ends with an element open.
    debug_assert!(pending.is_none());

    // THE WRONG FILE MUST NOT LOOK LIKE AN EMPTY LIFE. A text file, a PDF that
    // slipped past the magic-number check, or an empty download all parse to
    // "zero elements" without being malformed XML — and reporting that as a
    // successful import of nothing would leave the person staring at an empty
    // surface with no idea they picked the wrong thing. A real export always
    // has a `<HealthData>` root, even when it contains no records at all.
    if !saw_root {
        return Err(HealthError::Malformed(
            "this file has no <HealthData> in it, so it is not an Apple Health export. \
             Export yours from the Health app on iPhone: your profile picture, then \
             Export All Health Data."
                .to_string(),
        ));
    }

    let (metrics, days, first_day, last_day) = fold(&buckets, &sleep, &sources);
    Ok(Derived {
        report: ImportReport {
            file_name: String::new(),
            file_bytes: None,
            export_date,
            records_read,
            records_used,
            records_ignored,
            rejections,
            workouts: workouts.len(),
            days,
            first_day,
            last_day,
        },
        metrics,
        workouts,
    })
}

fn too_many_buckets(limits: Limits) -> HealthError {
    HealthError::TooLarge(format!(
        "this export covers more than {} day/metric/device combinations",
        limits.max_buckets
    ))
}

// ---------------------------------------------------------------------------
// One record
// ---------------------------------------------------------------------------

/// Why one record could not be used. An enum rather than a string so the caller
/// cannot accidentally put file-derived text into a counter name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reject {
    Date,
    Value,
    Range,
    Unit,
    SleepStage,
    Interval,
}

impl Reject {
    fn count(self, into: &mut Rejections) {
        match self {
            Reject::Date => into.unreadable_date += 1,
            Reject::Value => into.unreadable_value += 1,
            Reject::Range => into.out_of_range += 1,
            Reject::Unit => into.unknown_unit += 1,
            Reject::SleepStage => into.unknown_sleep_stage += 1,
            Reject::Interval => into.impossible_interval += 1,
        }
    }
}

/// Apple writes `2026-08-08 07:12:33 +0200` — a local wall clock plus the offset
/// it was taken in.
///
/// THE OFFSET IS THE POINT. Converting to UTC and bucketing there would split a
/// European evening across two days and move every night's sleep an hour, so the
/// day kept here is the LOCAL one: the day the person actually lived.
fn parse_at(raw: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let dt = chrono::DateTime::parse_from_str(raw.trim(), "%Y-%m-%d %H:%M:%S %z").ok()?;
    let year = dt.date_naive().year();
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) {
        return None;
    }
    Some(dt)
}

fn quantity_sample(
    spec: &MetricSpec,
    value: Option<&str>,
    unit: Option<&str>,
    start: Option<&str>,
) -> Result<(NaiveDate, f64), Reject> {
    // Attributed by START. A cumulative record is a short interval (Apple
    // buckets steps into a few minutes at a time), so the day it began in is
    // the day it belongs to.
    let day = start.and_then(parse_at).ok_or(Reject::Date)?.date_naive();
    let raw: f64 = value
        .ok_or(Reject::Value)?
        .trim()
        .parse()
        .map_err(|_| Reject::Value)?;
    // NaN and infinity parse successfully from "NaN" and "inf". Neither is a
    // measurement, and NaN in particular would poison a day's sum silently —
    // every comparison against it is false, so no range check would catch it
    // downstream.
    if !raw.is_finite() {
        return Err(Reject::Value);
    }
    let canonical = to_canonical(spec.dim, unit.unwrap_or("").trim(), raw).ok_or(Reject::Unit)?;
    if canonical < spec.min || canonical > spec.max {
        return Err(Reject::Range);
    }
    Ok((day, canonical))
}

fn sleep_sample(
    value: Option<&str>,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<(NaiveDate, Stage, f64), Reject> {
    let stage = stage_for(value.ok_or(Reject::SleepStage)?.trim()).ok_or(Reject::SleepStage)?;
    let from = start.and_then(parse_at).ok_or(Reject::Date)?;
    let to = end.and_then(parse_at).ok_or(Reject::Date)?;
    let minutes = (to - from).num_seconds() as f64 / 60.0;
    if minutes <= 0.0 || minutes > MAX_INTERVAL_MINUTES {
        return Err(Reject::Interval);
    }
    // ATTRIBUTED TO THE DAY IT ENDED IN. A night that starts at 23:40 on Friday
    // is Saturday's sleep — it is the night you wake up from, and it is the one
    // a "how did I sleep" card is asking about on Saturday morning. A nap ends
    // the same day it started, so the rule costs naps nothing.
    Ok((to.date_naive(), stage, minutes))
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

struct PendingWorkout {
    row: WorkoutRow,
    /// True when `duration_min` came from the workout's own attribute rather
    /// than from the start/end span, so a `<WorkoutStatistics>` cannot overwrite
    /// something the export stated outright.
    duration_declared: bool,
}

impl PendingWorkout {
    fn start(
        el: &super::xml::Element,
        sources: &mut Sources,
        max_sources: usize,
    ) -> Result<Self, Reject> {
        let from = el.attr("startDate").and_then(parse_at).ok_or(Reject::Date)?;
        let to = el.attr("endDate").and_then(parse_at).ok_or(Reject::Date)?;
        let span = (to - from).num_seconds() as f64 / 60.0;
        if span <= 0.0 || span > MAX_INTERVAL_MINUTES {
            return Err(Reject::Interval);
        }
        // Newer exports drop `duration` and put everything in
        // `<WorkoutStatistics>`, so the span is the fallback rather than the
        // other way round.
        let declared = number_with_unit(el.attr("duration"), el.attr("durationUnit"), Dim::Time)
            .filter(|d| *d > 0.0 && *d <= MAX_INTERVAL_MINUTES);
        let source_ix = sources.intern(el.attr("sourceName").unwrap_or(""), max_sources);
        let source = sources.name(source_ix).map(str::to_string);

        // The activity NAME, not a mapping table. `HKWorkoutActivityTypeHighIntensityIntervalTraining`
        // becomes `high_intensity_interval_training`; a type we have never heard
        // of becomes its own snake_case name rather than being dropped, because
        // the workout happened whether or not we recognise the sport.
        let activity = el
            .attr("workoutActivityType")
            .map(|t| snake_case(t.strip_prefix("HKWorkoutActivityType").unwrap_or(t)))
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| "other".to_string());

        let started_at = from.to_rfc3339();
        let ended_at = to.to_rfc3339();
        Ok(Self {
            row: WorkoutRow {
                // The export gives a workout no id, so identity is derived from
                // what it IS. Without this a second import of an overlapping
                // export duplicates every workout the person has ever done.
                external_id: workout_id(&activity, &started_at, &ended_at, source.as_deref()),
                activity,
                day: from.date_naive(),
                duration_min: declared.unwrap_or(span),
                distance_km: number_with_unit(
                    el.attr("totalDistance"),
                    el.attr("totalDistanceUnit"),
                    Dim::Distance,
                ),
                energy_kcal: number_with_unit(
                    el.attr("totalEnergyBurned"),
                    el.attr("totalEnergyBurnedUnit"),
                    Dim::Energy,
                ),
                avg_heart_rate: None,
                started_at,
                ended_at,
                source,
            },
            duration_declared: declared.is_some(),
        })
    }

    /// Take what a `<WorkoutStatistics>` child adds. Only fills gaps — a value
    /// the workout element stated itself is not second-guessed.
    fn absorb(&mut self, el: &super::xml::Element) {
        let unit = el.attr("unit");
        match el.attr("type").unwrap_or("") {
            "HKQuantityTypeIdentifierHeartRate" => {
                if self.row.avg_heart_rate.is_none() {
                    self.row.avg_heart_rate =
                        number_with_unit(el.attr("average"), unit, Dim::Rate)
                            .filter(|hr| (20.0..=300.0).contains(hr));
                }
            }
            "HKQuantityTypeIdentifierDistanceWalkingRunning"
            | "HKQuantityTypeIdentifierDistanceCycling"
            | "HKQuantityTypeIdentifierDistanceSwimming" => {
                if self.row.distance_km.is_none() {
                    self.row.distance_km = number_with_unit(el.attr("sum"), unit, Dim::Distance);
                }
            }
            "HKQuantityTypeIdentifierActiveEnergyBurned" => {
                if self.row.energy_kcal.is_none() {
                    self.row.energy_kcal = number_with_unit(el.attr("sum"), unit, Dim::Energy);
                }
            }
            _ => {}
        }
        let _ = self.duration_declared;
    }

    fn finish(self) -> WorkoutRow {
        self.row
    }
}

/// A number attribute plus its unit attribute, in canonical units. `None` for
/// anything missing, unparseable, non-finite, negative or in an unknown unit —
/// there is no default, because a workout with no recorded distance is not a
/// workout with a distance of zero.
fn number_with_unit(value: Option<&str>, unit: Option<&str>, dim: Dim) -> Option<f64> {
    let raw: f64 = value?.trim().parse().ok()?;
    if !raw.is_finite() || raw < 0.0 {
        return None;
    }
    to_canonical(dim, unit.unwrap_or("").trim(), raw)
}

fn workout_id(activity: &str, start: &str, end: &str, source: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    // The separator matters: without it `("run", "12")` and `("ru", "n12")`
    // hash the same, and two different workouts would collapse into one row.
    for part in [activity, start, end, source.unwrap_or("")] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn snake_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    out.trim_matches('_').to_string()
}

// ---------------------------------------------------------------------------
// Folding accumulators into rows
// ---------------------------------------------------------------------------

type Folded = (Vec<MetricRow>, usize, Option<NaiveDate>, Option<NaiveDate>);

fn fold(
    buckets: &HashMap<(NaiveDate, u16, u32), Acc>,
    sleep: &HashMap<(NaiveDate, u32), Stages>,
    sources: &Sources,
) -> Folded {
    let mut rows: Vec<MetricRow> = Vec::new();

    // --- quantities --------------------------------------------------------
    // Regrouped by (day, metric) so the per-source decision below can be made
    // with all of that day's sources in hand.
    let mut by_metric: HashMap<(NaiveDate, u16), Vec<(u32, Acc)>> = HashMap::new();
    for ((day, ix, source), acc) in buckets {
        by_metric.entry((*day, *ix)).or_default().push((*source, *acc));
    }

    for ((day, ix), mut per_source) in by_metric {
        let Some(spec) = METRICS.get(ix as usize) else { continue };
        match spec.stat {
            // THE DE-DUPLICATION RULE. See the module header: a Watch and a
            // phone both log the same walk, so the day's total is the largest
            // single source's total, not their sum.
            Stat::Sum => {
                per_source.sort_by(|a, b| {
                    b.1.sum
                        .partial_cmp(&a.1.sum)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        // Ties broken by source index so the winner is stable
                        // across runs; a HashMap's iteration order is not.
                        .then(a.0.cmp(&b.0))
                });
                let Some((source, acc)) = per_source.first() else { continue };
                rows.push(MetricRow {
                    day,
                    metric: spec.metric,
                    value: acc.sum,
                    unit: spec.unit,
                    stat: spec.stat,
                    sample_count: acc.count,
                    source: sources.name(*source).map(str::to_string),
                    low: None,
                    high: None,
                });
            }
            // Two devices reading a heart are not double-counting, so these are
            // merged: a count-weighted mean, and the day's true extremes.
            Stat::Avg => {
                let mut count = 0u64;
                let mut sum = 0.0f64;
                let mut low = f64::INFINITY;
                let mut high = f64::NEG_INFINITY;
                let mut best: Option<(u32, u64)> = None;
                for (source, acc) in &per_source {
                    if acc.count == 0 {
                        continue;
                    }
                    count += acc.count;
                    sum += acc.sum;
                    low = low.min(acc.low);
                    high = high.max(acc.high);
                    // `map_or`, not `is_none_or`: MSRV is 1.77.2, and
                    // `Option::is_none_or` is stable only from 1.82.
                    if best.map_or(true, |(_, n)| acc.count > n) {
                        best = Some((*source, acc.count));
                    }
                }
                if count == 0 {
                    continue;
                }
                rows.push(MetricRow {
                    day,
                    metric: spec.metric,
                    value: sum / count as f64,
                    unit: spec.unit,
                    stat: spec.stat,
                    sample_count: count,
                    // The source that contributed most of the readings. Named
                    // as the provenance of the average, not as its only author.
                    source: best.and_then(|(s, _)| sources.name(s)).map(str::to_string),
                    low: Some(low),
                    high: Some(high),
                });
            }
            Stat::Duration => {}
        }
    }

    // --- sleep -------------------------------------------------------------
    // ONE SOURCE WINS THE WHOLE NIGHT, rather than a per-stage maximum across
    // sources. A Watch and a ring both record the same night in incompatible
    // stage models; taking deep from one and REM from the other produces a
    // breakdown that no device ever reported and whose parts need not add up.
    let mut nights: HashMap<NaiveDate, (u32, Stages)> = HashMap::new();
    for ((day, source), stages) in sleep {
        let entry = nights.entry(*day).or_insert((*source, *stages));
        let better = stages.asleep() > entry.1.asleep()
            || (stages.asleep() == entry.1.asleep() && *source < entry.0);
        if better {
            *entry = (*source, *stages);
        }
    }
    for (day, (source, stages)) in nights {
        let name = sources.name(source).map(str::to_string);
        // Zipped against SLEEP_METRICS rather than written out as pairs: the
        // names and the order then have exactly one definition.
        for (metric, minutes) in SLEEP_METRICS.iter().copied().zip([
            stages.asleep(),
            stages.core,
            stages.deep,
            stages.rem,
            stages.awake,
            stages.in_bed,
        ]) {
            // A stage with no minutes is a stage the device did not report.
            // Writing a 0 would claim it measured zero deep sleep, which is a
            // different statement and the one a card would render as a fact.
            if minutes <= 0.0 {
                continue;
            }
            rows.push(MetricRow {
                day,
                metric,
                value: minutes,
                unit: "min",
                stat: Stat::Duration,
                sample_count: stages.samples,
                source: name.clone(),
                low: None,
                high: None,
            });
        }
    }

    rows.sort_by(|a, b| a.day.cmp(&b.day).then(a.metric.cmp(b.metric)));
    let first = rows.first().map(|r| r.day);
    let last = rows.last().map(|r| r.day);
    let mut days: Vec<NaiveDate> = rows.iter().map(|r| r.day).collect();
    days.dedup();
    (rows, days.len(), first, last)
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

/// The export file, as a `HealthSource`.
///
/// This is what makes the seam in companion.rs a real contract rather than a
/// hopeful trait: the ONE source that works implements it, so the shape a
/// future companion has to fit is a shape something already fits. It is also
/// what keeps the trait honest about DERIVED values — `pull` returns days, not
/// samples, because that is all this importer ever produces.
pub struct AppleExport {
    pub path: PathBuf,
    pub limits: Limits,
}

impl super::companion::HealthSource for AppleExport {
    fn kind(&self) -> &'static str {
        "apple_export"
    }

    fn pull(&self) -> Result<Derived, HealthError> {
        read_export(&self.path, self.limits)
    }
}

/// Read an export and write its derived values, in one transaction.
pub fn import_apple_export(
    conn: &mut rusqlite::Connection,
    user_id: &str,
    path: &Path,
) -> Result<ImportReport, HealthError> {
    use super::companion::HealthSource;
    let source = AppleExport { path: path.to_path_buf(), limits: Limits::default() };
    let derived = source.pull()?;
    super::store::apply_import(conn, user_id, source.kind(), &derived)?;
    Ok(derived.report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("a test date")
    }

    fn run(xml: &str) -> Derived {
        ingest(xml.as_bytes(), Limits::default()).expect("a readable export")
    }

    fn value_of(d: &Derived, on: &str, metric: &str) -> Option<f64> {
        d.metrics
            .iter()
            .find(|r| r.day == day(on) && r.metric == metric)
            .map(|r| r.value)
    }

    /// A hand-written export in the shape Apple writes: a DTD, an ExportDate,
    /// a Me element, a handful of records across two days, one night of staged
    /// sleep, and a workout.
    const FIXTURE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>
<!ATTLIST Record type CDATA #REQUIRED>
]>
<HealthData locale="da_DK">
 <ExportDate value="2026-08-08 09:15:00 +0200"/>
 <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Magnus' iPhone" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="812"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Magnus' iPhone" unit="count" startDate="2026-08-07 18:00:00 +0200" endDate="2026-08-07 18:20:00 +0200" value="2400"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Magnus' iPhone" unit="count" startDate="2026-08-08 08:00:00 +0200" endDate="2026-08-08 08:30:00 +0200" value="3100"/>
 <Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="Magnus' iPhone" unit="km" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="0.62"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Magnus' Apple Watch" unit="count/min" startDate="2026-08-07 07:01:00 +0200" endDate="2026-08-07 07:01:00 +0200" value="58"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Magnus' Apple Watch" unit="count/min" startDate="2026-08-07 07:02:00 +0200" endDate="2026-08-07 07:02:00 +0200" value="142"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Magnus' Apple Watch" unit="count/min" startDate="2026-08-07 07:03:00 +0200" endDate="2026-08-07 07:03:00 +0200" value="90"/>
 <Record type="HKQuantityTypeIdentifierDietaryCaffeine" sourceName="Coffee app" unit="mg" startDate="2026-08-07 08:00:00 +0200" endDate="2026-08-07 08:00:00 +0200" value="95"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Magnus' Apple Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-08-07 23:10:00 +0200" endDate="2026-08-08 03:00:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Magnus' Apple Watch" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-08-08 03:00:00 +0200" endDate="2026-08-08 04:40:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Magnus' Apple Watch" value="HKCategoryValueSleepAnalysisAsleepREM" startDate="2026-08-08 04:40:00 +0200" endDate="2026-08-08 06:22:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Magnus' Apple Watch" value="HKCategoryValueSleepAnalysisAwake" startDate="2026-08-08 06:22:00 +0200" endDate="2026-08-08 06:30:00 +0200"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="42.5" durationUnit="min" totalDistance="8.1" totalDistanceUnit="km" totalEnergyBurned="512" totalEnergyBurnedUnit="kcal" sourceName="Magnus' Apple Watch" startDate="2026-08-07 17:00:00 +0200" endDate="2026-08-07 17:42:30 +0200">
  <MetadataEntry key="HKWeatherTemperature" value="19 degF"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="151" unit="count/min"/>
  <WorkoutRoute sourceName="Magnus' Apple Watch" startDate="2026-08-07 17:00:00 +0200" endDate="2026-08-07 17:42:30 +0200">
   <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="999" unit="count/min"/>
  </WorkoutRoute>
 </Workout>
</HealthData>"#;

    // -----------------------------------------------------------------------
    // The derived values ARE what gets stored
    // -----------------------------------------------------------------------

    #[test]
    fn a_days_cumulative_records_become_one_total() {
        let d = run(FIXTURE);
        // 812 + 2400 on the 7th; the 8th's 3100 is a different day.
        assert_eq!(value_of(&d, "2026-08-07", "steps"), Some(3212.0));
        assert_eq!(value_of(&d, "2026-08-08", "steps"), Some(3100.0));
        let row = d
            .metrics
            .iter()
            .find(|r| r.day == day("2026-08-07") && r.metric == "steps")
            .expect("the 7th");
        assert_eq!(row.stat, Stat::Sum);
        assert_eq!(row.unit, "count");
        // Provenance travels with the number.
        assert_eq!(row.sample_count, 2);
        assert_eq!(row.source.as_deref(), Some("Magnus' iPhone"));
        // A cumulative metric has no daily range to report.
        assert_eq!(row.low, None);
        assert_eq!(row.high, None);
    }

    /// The widgets need "58–142, average 97", which is three numbers out of
    /// three samples — and the samples themselves are not kept.
    #[test]
    fn an_instantaneous_metric_becomes_an_average_and_a_range() {
        let d = run(FIXTURE);
        let hr = d
            .metrics
            .iter()
            .find(|r| r.metric == "heart_rate_bpm")
            .expect("heart rate");
        assert_eq!(hr.stat, Stat::Avg);
        assert!((hr.value - (58.0 + 142.0 + 90.0) / 3.0).abs() < 1e-9, "{}", hr.value);
        assert_eq!(hr.low, Some(58.0));
        assert_eq!(hr.high, Some(142.0));
        assert_eq!(hr.sample_count, 3);
    }

    /// The sentence the sleep card actually says: "7h 12m, deep 1h 40m".
    #[test]
    fn a_night_of_staged_sleep_becomes_the_numbers_the_card_shows() {
        let d = run(FIXTURE);
        // Core 23:10→03:00 = 230, deep 03:00→04:40 = 100, REM 04:40→06:22 = 102.
        assert_eq!(value_of(&d, "2026-08-08", "sleep_core_minutes"), Some(230.0));
        assert_eq!(value_of(&d, "2026-08-08", "sleep_deep_minutes"), Some(100.0));
        assert_eq!(value_of(&d, "2026-08-08", "sleep_rem_minutes"), Some(102.0));
        assert_eq!(value_of(&d, "2026-08-08", "sleep_awake_minutes"), Some(8.0));
        // 432 minutes = 7h 12m. Awake time is not asleep time.
        assert_eq!(value_of(&d, "2026-08-08", "sleep_asleep_minutes"), Some(432.0));
        // The night STARTED on the 7th and belongs to the 8th — the morning you
        // wake up into is the morning the card is asked about.
        assert_eq!(value_of(&d, "2026-08-07", "sleep_asleep_minutes"), None);
        // A stage the device never reported is absent, not zero.
        assert_eq!(value_of(&d, "2026-08-08", "sleep_in_bed_minutes"), None);
    }

    #[test]
    fn a_workout_keeps_its_summary_and_its_direct_heart_rate_statistic() {
        let d = run(FIXTURE);
        assert_eq!(d.workouts.len(), 1);
        let w = &d.workouts[0];
        assert_eq!(w.activity, "running");
        assert_eq!(w.duration_min, 42.5);
        assert_eq!(w.distance_km, Some(8.1));
        assert_eq!(w.energy_kcal, Some(512.0));
        assert_eq!(w.day, day("2026-08-07"));
        // 151 is the workout's own statistic. 999 is the one nested inside the
        // <WorkoutRoute>, which describes the route and is not this workout's
        // heart rate — binding it would have put a fabricated 999 bpm on a card.
        assert_eq!(w.avg_heart_rate, Some(151.0));
        assert!(!w.external_id.is_empty());
    }

    /// The `<WorkoutRoute>` case with nothing to hide behind.
    ///
    /// `a_workout_keeps_its_summary_and_its_direct_heart_rate_statistic` does
    /// NOT prove the parent check on its own: there the workout's own statistic
    /// arrives first and `absorb` only fills gaps, so the nested one is skipped
    /// either way. The failure the check actually prevents is this one — a
    /// workout with NO heart-rate statistic of its own, where the route's
    /// figure would be taken as the workout's and land on a card as a
    /// fabricated average.
    #[test]
    fn a_statistic_nested_in_a_route_is_never_taken_as_the_workouts_own() {
        let d = run(r#"<HealthData>
 <Workout workoutActivityType="HKWorkoutActivityTypeCycling" sourceName="Watch" startDate="2026-08-07 17:00:00 +0200" endDate="2026-08-07 17:30:00 +0200">
  <WorkoutRoute sourceName="Watch" startDate="2026-08-07 17:00:00 +0200" endDate="2026-08-07 17:30:00 +0200">
   <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="999" unit="count/min"/>
   <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceCycling" sum="404" unit="km"/>
  </WorkoutRoute>
 </Workout>
</HealthData>"#);
        let w = &d.workouts[0];
        // No statistic of its own, so no heart rate and no distance. Absent is
        // the honest answer; the route's numbers describe the route.
        assert_eq!(w.avg_heart_rate, None, "a route's statistic became the workout's");
        assert_eq!(w.distance_km, None, "a route's distance became the workout's");
        // The span is still real, because start and end are the workout's own.
        assert_eq!(w.duration_min, 30.0);
        assert_eq!(w.activity, "cycling");
    }

    /// Re-importing is the obvious next thing a person does. Identity has to be
    /// stable or the second import doubles their training history.
    #[test]
    fn the_same_workout_derives_the_same_id_twice_and_different_ones_apart() {
        let a = run(FIXTURE).workouts.remove(0);
        let b = run(FIXTURE).workouts.remove(0);
        assert_eq!(a.external_id, b.external_id);
        let other = workout_id("running", &a.started_at, &a.ended_at, Some("Someone else"));
        assert_ne!(a.external_id, other);
        // The separator: without it these two would hash identically.
        assert_ne!(workout_id("run", "12", "3", None), workout_id("ru", "n12", "3", None));
    }

    /// A type Atlas derives nothing from is not a failure — an export carries
    /// dozens. Counting them separately is what keeps "rejected" meaning
    /// "something was wrong".
    #[test]
    fn an_unknown_apple_type_is_ignored_not_rejected() {
        let d = run(FIXTURE);
        assert_eq!(d.report.records_ignored, 1, "the caffeine record");
        assert_eq!(d.report.rejections.total(), 0);
        assert_eq!(d.report.records_read, 12);
        assert_eq!(d.report.records_used, 11);
        assert_eq!(d.report.export_date.as_deref(), Some("2026-08-08 09:15:00 +0200"));
        assert_eq!(d.report.first_day, Some(day("2026-08-07")));
        assert_eq!(d.report.last_day, Some(day("2026-08-08")));
        assert_eq!(d.report.days, 2);
    }

    // -----------------------------------------------------------------------
    // The de-duplication rule
    // -----------------------------------------------------------------------

    /// The bug this rule exists to prevent: a Watch and a phone both log the
    /// same walk, and a naive sum reports nearly twice the steps actually taken
    /// — a plausible number that is wrong, which is worse than none.
    #[test]
    fn the_watch_and_the_phone_do_not_add_up_to_two_peoples_steps() {
        let d = run(r#"<HealthData>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="4000"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="4200"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Apple Watch" unit="count" startDate="2026-08-07 09:00:00 +0200" endDate="2026-08-07 09:10:00 +0200" value="1000"/>
</HealthData>"#);
        // The Watch's 5200, not 9200.
        assert_eq!(value_of(&d, "2026-08-07", "steps"), Some(5200.0));
        let row = d.metrics.iter().find(|r| r.metric == "steps").expect("steps");
        assert_eq!(row.source.as_deref(), Some("Apple Watch"));
    }

    /// The other half of the same rule: two sources reading a heart are two
    /// readings, not one reading counted twice.
    #[test]
    fn two_sources_of_heart_rate_are_merged_rather_than_deduplicated() {
        let d = run(r#"<HealthData>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:00:00 +0200" value="60"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-08-07 07:01:00 +0200" endDate="2026-08-07 07:01:00 +0200" value="80"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Chest strap" unit="count/min" startDate="2026-08-07 07:00:30 +0200" endDate="2026-08-07 07:00:30 +0200" value="160"/>
</HealthData>"#);
        let hr = d.metrics.iter().find(|r| r.metric == "heart_rate_bpm").expect("hr");
        assert_eq!(hr.sample_count, 3);
        assert!((hr.value - 100.0).abs() < 1e-9, "{}", hr.value);
        assert_eq!(hr.high, Some(160.0));
    }

    /// A ring and a Watch describe the same night in incompatible stage models.
    /// One source must win the WHOLE night or the parts stop adding up.
    #[test]
    fn one_source_wins_a_whole_night_rather_than_a_stage_at_a_time() {
        let d = run(r#"<HealthData>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-08-07 23:00:00 +0200" endDate="2026-08-08 06:00:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Ring" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-08-07 23:30:00 +0200" endDate="2026-08-08 01:00:00 +0200"/>
</HealthData>"#);
        // The Watch reported 420 asleep minutes, the ring 90. The Watch wins,
        // and the ring's deep-sleep figure does NOT get grafted on.
        assert_eq!(value_of(&d, "2026-08-08", "sleep_asleep_minutes"), Some(420.0));
        assert_eq!(value_of(&d, "2026-08-08", "sleep_deep_minutes"), None);
        assert_eq!(value_of(&d, "2026-08-08", "sleep_core_minutes"), Some(420.0));
    }

    // -----------------------------------------------------------------------
    // Hostile and broken input
    // -----------------------------------------------------------------------

    /// The case the task names: a record whose value is not a possible reading.
    /// It must be dropped, COUNTED, and must not contaminate the day's total.
    #[test]
    fn an_out_of_range_value_is_rejected_and_the_day_is_still_correct() {
        let d = run(r#"<HealthData>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="900"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 08:00:00 +0200" endDate="2026-08-07 08:10:00 +0200" value="999999999"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 09:00:00 +0200" endDate="2026-08-07 09:10:00 +0200" value="-500"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:00:00 +0200" value="4000"/>
</HealthData>"#);
        assert_eq!(value_of(&d, "2026-08-07", "steps"), Some(900.0));
        // A single impossible reading must not become the day's heart rate.
        assert_eq!(value_of(&d, "2026-08-07", "heart_rate_bpm"), None);
        assert_eq!(d.report.rejections.out_of_range, 3);
        assert_eq!(d.report.records_used, 1);
        assert_eq!(
            d.report.rejections.reasons(),
            vec![("value outside the possible range", 3)]
        );
    }

    /// NaN parses from text and then poisons everything it touches silently:
    /// every comparison against it is false, so a range check downstream would
    /// pass it, and one NaN makes a whole day's sum NaN.
    #[test]
    fn nan_and_infinity_never_enter_an_accumulator() {
        let d = run(r#"<HealthData>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="900"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 08:00:00 +0200" endDate="2026-08-07 08:10:00 +0200" value="NaN"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 09:00:00 +0200" endDate="2026-08-07 09:10:00 +0200" value="inf"/>
</HealthData>"#);
        assert_eq!(value_of(&d, "2026-08-07", "steps"), Some(900.0));
        assert_eq!(d.report.rejections.unreadable_value, 2);
    }

    /// A US export writes `mi` and `Cal`. Reading them as km and kcal would put
    /// a number on a card that is wrong by 1.6x and looks entirely normal.
    #[test]
    fn units_are_converted_and_an_unknown_one_is_refused_rather_than_assumed() {
        let d = run(r#"<HealthData>
 <Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="iPhone" unit="mi" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="1"/>
 <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="Watch" unit="Cal" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="240"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="stones" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:00:00 +0200" value="12"/>
</HealthData>"#);
        let km = value_of(&d, "2026-08-07", "distance_walking_running_km").expect("distance");
        assert!((km - 1.609_344).abs() < 1e-9, "{km}");
        assert_eq!(value_of(&d, "2026-08-07", "active_energy_kcal"), Some(240.0));
        // "stones" is not "st". Refused, not guessed.
        assert_eq!(value_of(&d, "2026-08-07", "body_mass_kg"), None);
        assert_eq!(d.report.rejections.unknown_unit, 1);
    }

    #[test]
    fn unreadable_dates_and_impossible_intervals_are_counted_not_crashed_on() {
        let d = run(r#"<HealthData>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="yesterday" endDate="2026-08-07 07:10:00 +0200" value="900"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="9999-08-07 07:00:00 +0200" endDate="9999-08-07 07:10:00 +0200" value="900"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-08-01 23:00:00 +0200" endDate="2026-08-07 06:00:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisDreaming" startDate="2026-08-07 23:00:00 +0200" endDate="2026-08-08 06:00:00 +0200"/>
</HealthData>"#);
        assert!(d.metrics.is_empty(), "{:?}", d.metrics);
        assert_eq!(d.report.rejections.unreadable_date, 2);
        assert_eq!(d.report.rejections.impossible_interval, 1, "six days is not a night");
        assert_eq!(d.report.rejections.unknown_sleep_stage, 1);
    }

    /// The task's named case. A person who exported a period with no data — or
    /// who has just set up a new phone — gets a real, well-formed export that
    /// contains nothing. That is a success with zero records, and the report has
    /// to say so plainly enough for a surface to show an honest empty state.
    #[test]
    fn an_empty_export_imports_nothing_and_says_nothing_was_there() {
        for empty in ["<HealthData/>", "<HealthData></HealthData>", "<HealthData locale=\"da_DK\"/>"] {
            let d = ingest(empty.as_bytes(), Limits::default())
                .unwrap_or_else(|e| panic!("{empty:?} should be readable, got {e}"));
            assert_eq!(d.report.records_read, 0);
            assert_eq!(d.report.records_used, 0);
            assert_eq!(d.report.days, 0);
            assert_eq!(d.report.first_day, None);
            assert!(d.metrics.is_empty());
            assert!(d.workouts.is_empty());
        }
    }

    /// The task's other named case, and the distinction that costs the most if
    /// it is missing: a file that is not an export at all must FAIL, not import
    /// zero records.
    ///
    /// An empty file and a text file both parse to "no elements" without being
    /// malformed XML. Reporting that as a successful import leaves the person
    /// looking at an empty health surface with nothing to tell them they picked
    /// the wrong file — indistinguishable from a real export of a quiet month.
    #[test]
    fn a_file_that_is_not_an_export_fails_rather_than_importing_nothing() {
        for wrong in ["", "   \n  ", "not xml at all, just prose", "<ClinicalDocument/>"] {
            let err = ingest(wrong.as_bytes(), Limits::default())
                .expect_err(&format!("{wrong:?} must not pass as an export"));
            assert!(err.to_string().contains("HealthData"), "{err}");
        }
    }

    /// A malformed file must produce an error the caller can show — never a
    /// partial import presented as a whole one, and never a panic (this runs
    /// inside a control worker, where a panic used to retire the worker).
    #[test]
    fn a_malformed_file_fails_cleanly_and_stores_nothing() {
        for broken in [
            "<HealthData><Record type=\"HKQuantityTypeIdentifierStepCount\"",
            "<HealthData><Record type=x/></HealthData>",
            "<HealthData></HealthDate>",
            "<HealthData><Record/>",
            "<HealthData><Record a=\"1\" a=\"2\"/></HealthData>",
        ] {
            let err = ingest(broken.as_bytes(), Limits::default())
                .expect_err(&format!("{broken:?} must not parse"));
            // The message is shown to a person, so it has to be a sentence.
            assert!(err.to_string().len() > 20, "{err}");
        }
    }

    /// The XXE guard, from the importer's side: the whole import fails rather
    /// than partially succeeding with an entity silently unresolved.
    #[test]
    fn an_export_carrying_an_entity_reference_is_refused_outright() {
        let err = ingest(
            r#"<!DOCTYPE HealthData [<!ENTITY x SYSTEM "file:///etc/passwd">]>
               <HealthData><Record type="HKQuantityTypeIdentifierStepCount" sourceName="&x;" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="1"/></HealthData>"#
                .as_bytes(),
            Limits::default(),
        )
        .expect_err("an entity reference must stop the import");
        assert!(matches!(err, HealthError::Malformed(_)), "{err:?}");
    }

    /// The ceilings are real: a file that would grow the accumulator table past
    /// the limit stops with a message instead of consuming memory until the
    /// process dies.
    #[test]
    fn the_accumulator_table_has_a_ceiling_that_stops_the_import() {
        let mut xml = String::from("<HealthData>");
        for d in 1..=28 {
            xml.push_str(&format!(
                "<Record type=\"HKQuantityTypeIdentifierStepCount\" sourceName=\"s{d}\" unit=\"count\" startDate=\"2026-02-{d:02} 07:00:00 +0200\" endDate=\"2026-02-{d:02} 07:10:00 +0200\" value=\"10\"/>"
            ));
        }
        xml.push_str("</HealthData>");
        let limits = Limits { max_buckets: 5, ..Limits::default() };
        let err = ingest(xml.as_bytes(), limits).expect_err("must stop");
        assert!(matches!(err, HealthError::TooLarge(_)), "{err:?}");
        // And the same file is fine under the real limit — otherwise this test
        // would pass for the wrong reason.
        assert_eq!(ingest(xml.as_bytes(), Limits::default()).expect("fine").metrics.len(), 28);
    }

    #[test]
    fn the_record_count_has_a_ceiling_too() {
        let limits = Limits { max_records: 2, ..Limits::default() };
        let err = ingest(FIXTURE.as_bytes(), limits).expect_err("must stop");
        assert!(matches!(err, HealthError::TooLarge(_)), "{err:?}");
    }

    #[test]
    fn activity_names_come_from_the_export_rather_than_a_mapping_table() {
        assert_eq!(snake_case("Running"), "running");
        assert_eq!(
            snake_case("HighIntensityIntervalTraining"),
            "high_intensity_interval_training"
        );
        assert_eq!(snake_case("SomeSportInventedIn2029"), "some_sport_invented_in2029");
        assert_eq!(snake_case(""), "");
    }

    /// Interning has a ceiling too, and hitting it must not lose records — it
    /// pools them, which weakens the de-duplication answer without dropping
    /// data.
    #[test]
    fn the_source_table_saturates_instead_of_growing_without_bound() {
        let mut sources = Sources::new();
        assert_eq!(sources.intern("", 4), 0);
        assert_eq!(sources.intern("a", 4), 1);
        assert_eq!(sources.intern("a", 4), 1);
        assert_eq!(sources.intern("b", 4), 2);
        assert_eq!(sources.intern("c", 4), 3);
        assert!(!sources.saturated);
        assert_eq!(sources.intern("d", 4), 0, "pooled once full");
        assert!(sources.saturated);
        assert_eq!(sources.name(0), None);
        assert_eq!(sources.name(1), Some("a"));
    }

    /// Every metric name reaching SQLite has to be one this table declares, and
    /// every declared name has to be unique — a duplicate would make the
    /// (day, metric) upsert overwrite one metric with another.
    #[test]
    fn the_metric_vocabulary_is_unique_and_well_formed() {
        let mut seen = std::collections::BTreeSet::new();
        for spec in METRICS {
            assert!(seen.insert(spec.metric), "duplicate metric {}", spec.metric);
            assert!(spec.hk.starts_with("HKQuantityTypeIdentifier"), "{}", spec.hk);
            assert!(spec.min < spec.max, "{} has an empty range", spec.metric);
            assert_ne!(spec.stat, Stat::Duration, "{} is not an interval metric", spec.metric);
            // The declared canonical unit must be one the converter accepts, or
            // every record of that metric is rejected as "unknown unit".
            assert!(
                to_canonical(spec.dim, spec.unit, 1.0) == Some(1.0),
                "{} declares the unit {} its own converter does not take as canonical",
                spec.metric,
                spec.unit
            );
        }
    }

    /// `fold` zips SLEEP_METRICS against a tuple of minutes, so the list's order
    /// decides which number is filed under which name. Swapping two entries
    /// would file deep sleep as REM — arithmetically consistent, completely
    /// wrong, and invisible to every other test here.
    #[test]
    fn the_sleep_metrics_are_emitted_in_the_order_this_list_declares() {
        assert_eq!(SLEEP_METRICS.len(), 6);
        // A night with ONE minute in each stage, so the value identifies which
        // stage it came from and no two can be confused.
        let d = run(r#"<HealthData>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="W" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-08-07 23:00:00 +0200" endDate="2026-08-07 23:01:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="W" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-08-07 23:01:00 +0200" endDate="2026-08-07 23:03:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="W" value="HKCategoryValueSleepAnalysisAsleepREM" startDate="2026-08-07 23:03:00 +0200" endDate="2026-08-07 23:06:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="W" value="HKCategoryValueSleepAnalysisAwake" startDate="2026-08-07 23:06:00 +0200" endDate="2026-08-07 23:10:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="W" value="HKCategoryValueSleepAnalysisInBed" startDate="2026-08-07 22:00:00 +0200" endDate="2026-08-07 22:05:00 +0200"/>
</HealthData>"#);
        assert_eq!(value_of(&d, "2026-08-07", "sleep_core_minutes"), Some(1.0));
        assert_eq!(value_of(&d, "2026-08-07", "sleep_deep_minutes"), Some(2.0));
        assert_eq!(value_of(&d, "2026-08-07", "sleep_rem_minutes"), Some(3.0));
        assert_eq!(value_of(&d, "2026-08-07", "sleep_awake_minutes"), Some(4.0));
        assert_eq!(value_of(&d, "2026-08-07", "sleep_in_bed_minutes"), Some(5.0));
        // Asleep is core + deep + REM, and excludes awake and in-bed.
        assert_eq!(value_of(&d, "2026-08-07", "sleep_asleep_minutes"), Some(6.0));
        // Every emitted name is one of the published ones.
        for row in &d.metrics {
            assert!(
                emittable_metrics().contains(&row.metric),
                "{} is emitted but not published",
                row.metric
            );
        }
    }

    /// Both spellings ship. An export written by an older iOS uses integers.
    #[test]
    fn both_spellings_of_a_sleep_stage_are_understood() {
        assert_eq!(stage_for("HKCategoryValueSleepAnalysisAsleepDeep"), Some(Stage::Deep));
        assert_eq!(stage_for("4"), Some(Stage::Deep));
        assert_eq!(stage_for("HKCategoryValueSleepAnalysisInBed"), Some(Stage::InBed));
        assert_eq!(stage_for("0"), Some(Stage::InBed));
        assert_eq!(stage_for("Asleep"), Some(Stage::AsleepUnspecified));
        assert_eq!(stage_for("HKCategoryValueSleepAnalysisNapping"), None);
        assert_eq!(stage_for("7"), None);
    }
}
