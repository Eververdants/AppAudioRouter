//! The engine's unit tests, one file per topic, over the three fixtures in
//! [`builders`].
//!
//! Everything here is the arithmetic and the handshake — formats, gains, group
//! references, ring bookkeeping, the idle rule and the in-flight-start registry.
//! What needs a real endpoint (activation, the device session, the event wire) is
//! not mockable from here and is walked by the acceptance checklist in
//! `docs/agents/acceptance.md`; a mock of `IAudioClient` would only prove the mock
//! agrees with itself.
mod builders;
mod delays;
mod gain;
mod latency;
mod measurement;
mod mirror_buffer;
mod parking;
mod sample_format;
mod start_stop;
mod volumes;
