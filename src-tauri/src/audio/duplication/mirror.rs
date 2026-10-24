//! One mirror device with its frame ring buffer.
//!
//! [`MirrorChannel`] is the whole boundary between the capture thread (the only
//! writer, see [`super::capture`]) and the render thread that owns this device
//! (the only reader, see [`super::pump`]): raw capture-format bytes, always whole
//! frames, capped so a slow-to-open endpoint cannot hoard stale audio.
//!
//! Everything else on the channel is a knob or a wake: the delay and the share
//! are live-adjustable atomics the manager pushes to, `enabled` is how a failed
//! mirror stops mattering without taking the engine down, and [`MirrorChannel::wake`]
//! is the token a packet leaves for a render thread parked on a quiet source.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::Thread;

/// One mirror device with its frame ring buffer.
pub(super) struct MirrorChannel {
    pub(super) device_id: String,
    /// True when this channel is the programme's audio being played into the
    /// feed carrier — the sending half of a feed — rather than a device of the
    /// route. A tap has no delay and no share of the group's loudness: it is a
    /// wire into another programme, not somewhere a person is listening, so no
    /// group arithmetic may include it and no route report may name it.
    pub(super) feed_tap: bool,
    /// Raw capture-format bytes, always a whole number of frames.
    pub(super) ring: Mutex<VecDeque<u8>>,
    /// Ring capacity in bytes (base latency + max delay + margin).
    pub(super) capacity: usize,
    /// Extra software delay for this mirror in milliseconds, measured against
    /// the app's audio as captured — the same unit for every device, with no
    /// device singled out as the reference. Only the difference to the earliest
    /// device of the group is realizable (see `group_min_delay_ms`), so a value
    /// below that reference just keeps the mirror at the base latency.
    /// Live-adjustable.
    pub(super) delay_ms: AtomicI32,
    /// This device's share (0–100) of the group's loudest device. The render
    /// side scales its frames by `own / max`, so 100 leaves the audio as the
    /// app produced it; only attenuation is realizable, which is why the
    /// loudest device of the group is the reference. Live-adjustable.
    pub(super) volume_percent: AtomicU32,
    /// Cleared when the device fails to open or errors out; pushes and pops
    /// become no-ops so the remaining mirrors keep playing.
    pub(super) enabled: AtomicBool,
    /// How many times this mirror's render loop has woken up. Diagnostic: it is
    /// what lets an idle engine's cost in scheduler wakeups be attributed to a
    /// route at all (see `capture_main`).
    pub(super) wakeups: AtomicU64,
    /// The endpoint's own stream latency in milliseconds, asked of the render
    /// client once it is initialized. Zero until then, and zero if the query
    /// fails, which the reporting side reads as "not measured" rather than as
    /// "no latency" — a started stream is never free. This is the part of the
    /// total that belongs to the device rather than to this engine, and it is
    /// where a hardware codec or a Bluetooth link adds on top without saying so.
    pub(super) stream_latency_ms: AtomicU32,
    /// The render thread that owns this mirror, published for as long as it
    /// runs so the capture side can wake it out of an idle park. `None` until
    /// that thread reaches its render loop, and a wake for a thread that is not
    /// parked is what `Thread::unpark` already handles: it leaves a token that
    /// the next park consumes instead of blocking.
    pub(super) worker: Mutex<Option<Thread>>,
}

impl MirrorChannel {
    /// Current buffered amount in bytes.
    pub(super) fn buffered_bytes(&self) -> usize {
        self.ring.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Drop the oldest `frames` frames. The ring always holds whole frames,
    /// so the remainder stays frame-aligned.
    pub(super) fn drop_oldest(&self, frames: usize, block_align: usize) {
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        let drop = (frames * block_align).min(ring.len());
        ring.drain(..drop);
    }

    /// Insert `frames` frames of silence at the front of the ring, clamped to
    /// the ring's free capacity. This raises the mirror's pipeline to its
    /// latency target — e.g. right after its delay compensation was increased
    /// or latency sync was enabled — so the larger target takes effect
    /// immediately instead of being silently unreachable (a full device buffer
    /// plus real-time capture inflow never fills the gap on its own).
    pub(super) fn prepend_silence(&self, frames: usize, block_align: usize) {
        if frames == 0 || !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        let headroom = self.capacity.saturating_sub(ring.len());
        let bytes = (frames * block_align).min(headroom - headroom % block_align);
        if bytes == 0 {
            return;
        }
        // Resize with zeros appended, then rotate them to the front: one
        // allocation instead of a per-byte push_front.
        let old_len = ring.len();
        ring.resize(old_len + bytes, 0);
        ring.rotate_right(bytes);
    }

    /// Enqueue one capture chunk, capping the ring (whole frames only) so a
    /// slow-to-open device cannot accumulate unbounded stale audio before the
    /// synchronized start; the render side trims toward the latency target.
    pub(super) fn push(&self, chunk: &[u8], block_align: usize) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        ring.extend(chunk);
        let excess = ring.len().saturating_sub(self.capacity);
        if excess > 0 {
            let aligned = excess - excess % block_align;
            ring.drain(..aligned);
        }
    }

    /// Wake the render thread owning this mirror if it is parked waiting for
    /// its source to come back. Cheap and safe to call unconditionally, which
    /// is what the capture side does with every packet it pushes.
    pub(super) fn wake(&self) {
        if let Some(thread) = self
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            thread.unpark();
        }
    }

    /// Take at most `max_frames` frames of audio for one render cycle into
    /// `out`, the render thread's own scratch buffer — the cycle runs about a
    /// hundred times a second, and a fresh allocation each time is one the
    /// audio thread does not need to make.
    pub(super) fn pop(&self, max_frames: usize, block_align: usize, out: &mut Vec<u8>) {
        out.clear();
        if max_frames == 0 || !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        let take = ring.len().min(max_frames * block_align);
        let aligned = take - take % block_align;
        out.extend(ring.drain(..aligned));
    }
}
