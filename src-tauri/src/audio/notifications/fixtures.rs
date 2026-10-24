//! Builders shared by the tests of this module's pieces.
//!
//! `absence` and `walk` both judge sets of endpoint ids, and a test that reads
//! `set(&["a", "b"])` says what it means; the same helper declared twice drifts
//! the first time one of them needs a third shape.

use std::collections::HashSet;

/// A device set from a list of ids.
pub(super) fn set(ids: &[&str]) -> HashSet<String> {
    ids.iter().map(|id| (*id).to_string()).collect()
}
