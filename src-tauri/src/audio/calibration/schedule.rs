//! What the pump writes next, and in what order.
//!
//! The run is one segment list in frames — settle, then per rep a gap, a burst
//! and a tail ([`build_schedule`]) — and the burst itself is a single rendered
//! sine wave ([`render_tone_frames`]) that every rep replays. Nothing here touches
//! a device: these are the numbers that decide what the measurement sounds like,
//! which is why the bounds that only shape a sequence (lead, tail, gap, pitch,
//! amplitude, fade, write-ahead padding) live in this file and not with the I/O.
//!
//! The gaps are drawn per rep from [`GapRng`] so the rhythm cannot be
//! anticipated, and the lead/tail bounds are the clamps a caller-supplied value
//! is forced through before it reaches [`super::player`].

use super::TONE_BURST_MS;

/// Hard bounds for caller-supplied lead and tail: short enough to keep the
/// pace snappy and the gaps obviously audible, long enough that a burst is
/// never clipped and the rhythm cannot be guessed from a constant.
pub(super) const LEAD_MS_MIN: usize = 100;
pub(super) const LEAD_MS_MAX: usize = 2_000;
pub(super) const TAIL_MS_MIN: usize = 100;
pub(super) const TAIL_MS_MAX: usize = 2_000;
/// Pitch of the burst: comfortably audible on every consumer device.
const TONE_HZ: f32 = 880.0;
/// Peak amplitude of the burst: clearly audible without startle, and quiet
/// enough that it rides on top of whatever a routed program is playing.
const TONE_AMPLITUDE: f32 = 0.3;
/// Cosine ramp at each end of the burst, so it never clicks.
const TONE_FADE_MS: usize = 20;
/// Gap between bursts, drawn per rep from this span: a fixed rhythm invites
/// anticipating the burst, and an anticipated press biases the measurement.
const GAP_MIN_MS: usize = 500;
const GAP_MAX_MS: usize = 1_200;
/// Buffer level the pump keeps. The marker-to-audible offset includes whatever
/// silence sat ahead of the burst when it was written; keeping that level fixed
/// makes the offset a per-device constant, which is all the arithmetic needs.
pub(super) const PADDING_TARGET_MS: usize = 50;

/// What the pump writes next, in frames.
pub(super) enum Segment {
    Silence(usize),
    Tone(usize),
}

/// A deterministic small PRNG for the gap lengths. Randomness here only has to
/// defeat rhythm-guessing, not an adversary; seeding from the clock keeps the
/// module free of a `rand` dependency.
struct GapRng(u64);

impl GapRng {
    fn next(&mut self) -> usize {
        // xorshift64*, fine for jitter.
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        let scaled = (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33) as usize;
        GAP_MIN_MS + scaled % (GAP_MAX_MS - GAP_MIN_MS + 1)
    }
}

/// The whole run as one segment list, in frames: settle, then per rep a gap,
/// a burst, and a tail that lets the burst finish audibly.
pub(super) fn build_schedule(
    sample_rate: u32,
    reps: usize,
    lead_ms: usize,
    tail_ms: usize,
) -> Vec<Segment> {
    let frames = |ms: usize| ms * sample_rate as usize / 1000;
    let mut rng = GapRng(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64 | 1)
            .unwrap_or(0x9E37_79B9_7F4A_7C15),
    );
    let mut segments = vec![Segment::Silence(frames(lead_ms))];
    for _ in 0..reps {
        segments.push(Segment::Silence(frames(rng.next())));
        segments.push(Segment::Tone(frames(TONE_BURST_MS)));
        segments.push(Segment::Silence(frames(tail_ms)));
    }
    segments
}

pub(super) fn segment_len(segment: &Segment) -> usize {
    match segment {
        Segment::Silence(total) | Segment::Tone(total) => *total,
    }
}

/// The length of the first burst, which is what `render_tone_frames` filled.
/// Every burst in the schedule is the same length.
pub(super) fn burst_frames(schedule: &[Segment]) -> usize {
    // One lead segment, then per rep (gap, tone, tail): the first tone sits at
    // index 1 + 0 * 3 + 1.
    match schedule.get(2) {
        Some(Segment::Tone(total)) => *total,
        _ => 0,
    }
}

/// The burst as interleaved float32 frames: a sine with cosine ramps at both
/// ends, identical on every channel.
pub(super) fn render_tone_frames(
    total_frames: usize,
    sample_rate: u32,
    channels: usize,
) -> Vec<f32> {
    let fade_frames = (TONE_FADE_MS * sample_rate as usize / 1000).max(1);
    let mut samples = Vec::with_capacity(total_frames * channels);
    let mut phase = 0.0f32;
    let step = core::f32::consts::TAU * TONE_HZ / sample_rate as f32;
    for frame in 0..total_frames {
        let env_in = if frame < fade_frames {
            0.5 - 0.5 * (core::f32::consts::PI * frame as f32 / fade_frames as f32).cos()
        } else {
            1.0
        };
        let to_end = total_frames - frame;
        let env_out = if to_end <= fade_frames {
            0.5 - 0.5 * (core::f32::consts::PI * to_end as f32 / fade_frames as f32).cos()
        } else {
            1.0
        };
        let value = TONE_AMPLITUDE * env_in * env_out * phase.sin();
        phase += step;
        for _ in 0..channels {
            samples.push(value);
        }
    }
    samples
}
