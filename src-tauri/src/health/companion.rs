// The iOS companion — the seam, and nothing behind it.
//
// THIS FILE IS A STUB AND IT IS MEANT TO STAY ONE FOR NOW. It exists so the
// shape of the second health source is written down in Rust rather than in
// somebody's head, and so the surface can say "there is a second way to get
// health data and it does not exist yet" instead of quietly showing one source.
//
// WHY NOTHING IS IMPLEMENTED
// A companion needs a pairing protocol — discovery on the LAN, a key exchange
// the user can verify, and an authenticated channel. Every part of that is
// unbuildable AND unverifiable in this repo today: there is no iOS app to pair
// with, so nothing here could be run end to end even once, and the failure mode
// of untested pairing crypto is not "it does not work" but "it works and is not
// secure". Shipping a hand-rolled key exchange that has never completed a
// handshake would be worse than shipping none. The design is written up in
// docs/decisions/009 so it does not have to be re-derived, and the code lands
// when there is an app on the other end to prove it against.
//
// `pull()` RETURNS AN ERROR, NOT AN EMPTY RESULT. That is the same decision the
// smart-home companion made and for the same reason: an empty `Vec` of health
// days is indistinguishable from "this person has no health data", which is a
// statement about their life rather than about our software.

use serde_json::{json, Value};

use super::import::Derived;
use super::HealthError;

/// The contract a health source owes.
///
/// One trait, two implementations — `AppleExport` (import.rs, the one that
/// works) and `Companion` below. It is deliberately shaped around DERIVED
/// values, not samples: a companion that streamed raw HealthKit samples over
/// the network would be moving exactly the data this product promises to keep
/// on the device. The phone aggregates; only daily summaries cross.
pub trait HealthSource {
    /// The identifier in `health_sync_state.source_kind`.
    fn kind(&self) -> &'static str;
    /// Derived days and workouts, or why not.
    fn pull(&self) -> Result<Derived, HealthError>;
}

pub struct Companion;

impl HealthSource for Companion {
    fn kind(&self) -> &'static str {
        "ios_companion"
    }

    fn pull(&self) -> Result<Derived, HealthError> {
        Err(HealthError::Unavailable(UNAVAILABLE.to_string()))
    }
}

const UNAVAILABLE: &str =
    "Atlas has no iPhone companion yet, so it cannot read your Health data directly. \
     Import an export from the Health app instead.";

/// The row the Sources screen shows for the companion.
///
/// Synthesised on every read rather than written to `health_sync_state`,
/// because it is not a state: it is a fact about the platform that is true on
/// every machine and cannot change until an app ships. A row in the table would
/// imply something happened.
pub fn source_entry() -> Value {
    json!({
        // Through the trait, so the id on the screen, the `source_kind` the
        // schema's CHECK constraint accepts, and the seam's own name are one
        // string rather than three that happen to match today.
        "id": Companion.kind(),
        "name": "iPhone companion",
        "kind": "ios_companion",
        "state": "unavailable",
        "detail": UNAVAILABLE,
        "enabled": false,
        // Not a "coming soon" badge: the reason is a platform finding somebody
        // verified by running code, and it is written down where it can be
        // re-checked rather than believed.
        "reason": "macOS has no HealthKit data store (docs/decisions/008); a companion \
                   needs a pairing protocol that has no app to pair with yet \
                   (docs/decisions/009).",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one behaviour this file has, and the one that matters: it refuses
    /// rather than returning an empty result. "You have no health data" and
    /// "Atlas cannot read your health data" are different sentences, and only
    /// one of them is true.
    #[test]
    fn the_companion_refuses_rather_than_reporting_an_empty_life() {
        let err = Companion.pull().expect_err("a stub must not succeed");
        assert!(matches!(err, HealthError::Unavailable(_)), "{err:?}");
        assert!(err.to_string().contains("Health app"), "{err}");
    }

    #[test]
    fn the_source_row_explains_itself_rather_than_just_being_off() {
        let row = source_entry();
        assert_eq!(row["state"], json!("unavailable"));
        assert_eq!(row["enabled"], json!(false));
        assert!(row["reason"].as_str().expect("a reason").contains("008"));
        assert_eq!(Companion.kind(), "ios_companion");
    }
}
