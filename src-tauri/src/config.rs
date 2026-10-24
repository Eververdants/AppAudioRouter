//! Route configuration persistence.
//!
//! Every on-disk setting lives under `app_data_dir` in one JSON file per
//! concern, and each concern is one submodule here. `file_io` holds the atomic
//! read and write helpers all of them share; `route_memory`
//! (`route-memory.json`, exe -> ordered device ids), `delays`
//! (`device-delays.json`), `device_volumes` (`device-volumes.json`, a mirror's
//! share), `source_volumes` (`source-volumes.json`, a program's own level),
//! `primary_volumes` (`primary-volumes.json`, a program's session volume),
//! `feed_memory` (`feed-memory.json`), `feed_carrier` (`feed-carrier.json`) and
//! `app_settings` (`app-settings.json`) are the stores.
//!
//! Each submodule keeps the same shape: the `XxxMap` serde type, the `XxxConfig`
//! wrapper holding a `Mutex<XxxConfigInner>`, its load/get/set/clear methods and
//! the tests of what it stores.
//!
//! The constants below stay **declared here** rather than beside the store that
//! owns them: `src/lib/types.test.ts` reads this exact file path and regex-matches
//! each `const NAME = value` to pin one half of every TS↔Rust literal pair, so
//! moving one leaves a frontend test with no counterpart. Submodules import them
//! from this module.

mod app_settings;
mod delays;
mod device_volumes;
mod feed_carrier;
mod feed_memory;
mod file_io;
mod primary_volumes;
mod route_memory;
mod source_volumes;

// The types the rest of the crate names, re-exported so they keep resolving as
// `config::Xxx`. Each submodule still holds its own `XxxMap` serde type; nothing
// outside `config` ever names those, so they are not re-exported here (a `pub use`
// nothing references is an `unused_imports` warning in a binary crate) and stay
// reachable as `config::route_memory::RouteMap` for anything inside this module.
pub use self::app_settings::AppSettings;
pub use self::delays::DelayConfig;
pub use self::device_volumes::VolumeConfig;
pub use self::feed_carrier::{FeedCarrier, FeedCarrierConfig};
pub use self::feed_memory::FeedConfig;
pub(crate) use self::file_io::persist_json;
pub use self::primary_volumes::PrimaryVolumeConfig;
pub use self::route_memory::{DeviceList, RouteConfig};
pub use self::source_volumes::SourceVolumeConfig;

/// Hard ceiling for one device's delay compensation (±10 s).
///
/// Not a setting any more — the configurable range was removed — but a rail the
/// engine's memory budget needs: the duplication engine sizes its ring buffers
/// for the worst case it allows (largest positive delay plus the largest group
/// shift), so this bound is what keeps a stray keystroke in the delay field from
/// asking a mirror to buffer minutes of audio. Real-world compensation never
/// leaves three-figure territory; this is ten times that.
pub const DELAY_MAX_MS: i32 = 10_000;

/// Ceiling for a program's own level, as a percentage of what that program
/// produced.
///
/// A *device* volume may only attenuate, because a device has a hardware volume
/// above the software one that can be turned up. A program's audio has nothing
/// above it, so raising a quiet program to its neighbours means amplifying it —
/// the one thing this file allows that `device-volumes.json` does not. The
/// ceiling is what stops that being a blank cheque: past roughly +12 dB a
/// program's noise floor comes up along with its signal.
pub const SOURCE_VOLUME_MAX: u32 = 400;

/// The level at which a program's audio is left exactly as the program produced
/// it. Never persisted, so clearing a value round-trips back to the same neutral
/// number the frontend assumes.
pub const SOURCE_VOLUME_NEUTRAL: u32 = 100;

/// Lower bound of a routed program's session volume, as a percent.
///
/// The session volume is the one lever that reaches the primary device's
/// loudness, and the engine compensates the copies by dividing their gain by
/// it — so it can never reach zero: at 0 the captured stream is true silence
/// and no gain can give the copies their loudness back. 5 % keeps that
/// compensation at ×20 and the "the copies are unaffected" promise honest all
/// the way down. The frontend's `PRIMARY_VOLUME_MIN` is the same literal; the
/// two are not bound together by anything but this note.
pub const PRIMARY_VOLUME_MIN_PERCENT: u32 = 5;
