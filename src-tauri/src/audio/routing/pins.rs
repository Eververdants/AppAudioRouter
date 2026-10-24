//! The two account books: which endpoint assignments this run wrote.
//!
//! Windows keeps a per-app endpoint assignment after the program that wrote it
//! is gone, and that assignment outranks a later change of the system default,
//! so every write [`super::endpoints`] makes has to be handed back again — on
//! stop, on exit, on the stale sweep and on the settings reset. This module is
//! the memory of who was pointed where.
//!
//! The books are three, not one, and they never merge: the route book (keyed by
//! pid, with a [`PinKind`] saying whether a live route, a handed-back program or
//! nothing at all owns the entry) and one feed book per half of a feed — the
//! source's render side and the target's capture side. A program can be routed
//! to a device *and* receive or carry a feed at the same time, so an entry lost
//! from one book is an assignment nothing can reach again.

use super::guard::entry_process_is_ours;

// ---------------------------------------------------------------------------
// Releasing an assignment again
// ---------------------------------------------------------------------------

/// What a release attempt left behind for one process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseOutcome {
    /// The process carries no assignment and follows the system default again.
    Released,
    /// The assignment is still there and points at this endpoint id.
    StillPinned(String),
    /// The audio service would not answer for this process.
    Unknown,
    /// This run never asked the service at all: a newer write claimed the
    /// program's slot while this release was still setting itself up, so the
    /// assignment the release was aimed at belongs to that writer now.
    ///
    /// Not a refusal to hand the assignment back and not a success either —
    /// nothing was cleared, and nothing may be written over the slot in apology.
    /// A caller that read this as "not confirmed clear" and fell back to pointing
    /// the program at the default would take the newer writer's route away, which
    /// is the exact failure the claim order exists to prevent; a caller that read
    /// it as "released" would forget a pin that is still standing.
    Superseded,
}

/// Why this run is holding an endpoint assignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinKind {
    /// A live route: the program is pointed at the devices the user chose.
    Route,
    /// The program's route was stopped, but Windows would not let the assignment
    /// go, so it was pointed at the current default device instead. Nothing is
    /// routing it — the entry is only here so that assignment stays ours to
    /// release later.
    ReturnedToDefault,
    /// Neither the release nor the fallback write landed, so this run no longer
    /// knows where the program is pointed and cannot move it. The entry stays
    /// for the same reason `ReturnedToDefault` does — the assignment is still
    /// ours — but it must not be read as a route, or nothing but an app restart
    /// could ever clear it.
    Abandoned,
}

/// A process this run has pointed at an explicit endpoint.
pub struct PinnedRoute {
    /// Executable name, so a relaunch of the same program can be found again.
    pub exe_name: String,
    /// Endpoint the process was pointed at.
    pub device_id: String,
    /// Whether a route of ours — as opposed to a handed-back program — owns it.
    pub kind: PinKind,
    /// The process's creation time when the entry was written — the same
    /// pid-recycling witness a [`FeedPin`] carries; 0 when it could not be read.
    pub creation_time: u64,
}

/// One feed endpoint this run pinned. Which of the two halves it is comes from
/// the book it lives in, not from a field: one pid can hold both at once, when
/// it receives one program's sound and feeds another's.
#[derive(Debug, Clone)]
pub struct FeedPin {
    /// Executable the pin speaks for, so a removal can find the memory rule.
    pub exe_name: String,
    /// The process's creation time when this pin was written. The pid is the
    /// only handle the release paths get, and the kernel hands pids to new
    /// processes — this is what tells the sweep that a pin's pid still names
    /// the process the pin speaks for.
    pub creation_time: u64,
}

impl FeedPin {
    fn new(pid: u32, exe_name: &str) -> Self {
        Self {
            exe_name: exe_name.to_string(),
            creation_time: crate::audio::process_creation_time(pid).unwrap_or(0),
        }
    }
}

/// The endpoint assignments this run wrote.
///
/// Windows keeps a per-app endpoint assignment after the program that wrote it
/// is gone, and that assignment outranks any later change of the system default
/// device — an app left pinned stops following the user's device switches, which
/// is exactly the complaint 2.1.1 answers. So every assignment this app writes
/// has to be released again: when its route stops, when the app quits, and when
/// the routed program is relaunched after having exited while pinned.
///
/// Tracking them is also what keeps the release honest: an assignment the user
/// made by hand in the volume mixer is none of our business and must survive.
#[derive(Default)]
pub struct PinnedRoutes {
    inner: std::sync::Mutex<std::collections::HashMap<u32, PinnedRoute>>,
    /// Feed endpoints, tracked apart from the route assignments because they
    /// own the *other* data flow: a program can be routed to a device and feed
    /// another program at the same time, and releasing one must not touch the
    /// other. The two flows get one book each for the same reason: the audio
    /// service addresses a program by pid on both, so a chain (`A` into `B`,
    /// `B` into `C`) writes `B`'s capture half and its render half, and one
    /// keyed by pid alone would lose whichever was pinned second. A lost pin is
    /// a write nothing can reach again — the endpoint stays set after the UI
    /// says the feed was removed.
    feed_sources: std::sync::Mutex<std::collections::HashMap<u32, FeedPin>>,
    feed_targets: std::sync::Mutex<std::collections::HashMap<u32, FeedPin>>,
}

impl PinnedRoutes {
    /// An empty book; entries arrive as assignments are written.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that this app pointed `pid` at `device_id` for a live route.
    pub fn mark(&self, pid: u32, exe_name: &str, device_id: &str) {
        self.insert(pid, exe_name, device_id, PinKind::Route);
    }

    /// Record that `pid` was handed back to the current default device, because
    /// Windows would not release the assignment its route left behind.
    pub fn mark_returned(&self, pid: u32, exe_name: &str, device_id: &str) {
        self.insert(pid, exe_name, device_id, PinKind::ReturnedToDefault);
    }

    /// Downgrade `pid`'s entry: this run has lost control of that assignment —
    /// the release was refused and the fallback write failed after it — so the
    /// program sits on some endpoint and nothing here can move it any more.
    ///
    /// The entry stays, because that assignment is still ours and app exit has
    /// to walk it, but its kind must come off `Route`. Left standing it hides
    /// the program from the settings page's reset, which excludes every
    /// executable with a live route, *and* from the stale sweep, which only
    /// releases pids that have gone away — while the board shows no route for
    /// the user to stop. Restarting this app would be the only way out, which is
    /// the dead end 2.1.1 exists to close.
    pub fn mark_abandoned(&self, pid: u32) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(route) = inner.get_mut(&pid) {
            route.kind = PinKind::Abandoned;
        }
    }

    fn insert(&self, pid: u32, exe_name: &str, device_id: &str, kind: PinKind) {
        let creation_time = crate::audio::process_creation_time(pid).unwrap_or(0);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.insert(
            pid,
            PinnedRoute {
                exe_name: exe_name.to_string(),
                device_id: device_id.to_string(),
                kind,
                creation_time,
            },
        );
    }

    /// Forget `pid`; its assignment is gone.
    pub fn forget(&self, pid: u32) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.remove(&pid);
    }

    /// The executable name recorded for `pid`, if this run pinned it.
    pub fn exe_name_of(&self, pid: u32) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.get(&pid).map(|route| route.exe_name.clone())
    }

    /// The endpoint recorded for `pid`, if this run pinned it.
    pub fn device_of(&self, pid: u32) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.get(&pid).map(|route| route.device_id.clone())
    }

    /// Whether a live route of ours other than `pid`'s serves `exe_name`.
    ///
    /// The assignment Windows keeps is stored per executable, so while one
    /// live route holds it, no other process of the same program may release
    /// it — the release would reach the route's primary endpoint all the same.
    ///
    /// "Live" carries the same witness [`is_routed`] uses: a route whose process
    /// exited stays on the book until a sweep reaches it, and an answer built on
    /// that entry would keep `stop_route` from ever handing the assignment back
    /// and a suspended feed from ever resuming. The other direction — a live
    /// sibling read as dead — is what would take a running route's endpoint away,
    /// so the judgement is the process's own exit code and creation time rather
    /// than the presence of an entry (or, for an entry written without a
    /// creation time, its executable name — see [`entry_process_is_ours`]), and
    /// only entries naming this executable are asked: one `OpenProcess` per
    /// sibling, not one per page of the book.
    pub fn exe_routed_elsewhere(&self, pid: u32, exe_name: &str) -> bool {
        // Snapshot the candidates under the lock and judge them outside of it:
        // `process_is_running` opens a process, and no other path in this crate
        // does system calls while a route book is held.
        let candidates: Vec<(u32, u64, String)> = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .iter()
                .filter(|(other, route)| {
                    **other != pid
                        && route.kind == PinKind::Route
                        && route.exe_name.eq_ignore_ascii_case(exe_name)
                })
                .map(|(other, route)| (*other, route.creation_time, route.exe_name.clone()))
                .collect()
        };
        candidates
            .iter()
            .any(|(other, created, exe)| entry_process_is_ours(*other, *created, exe))
    }

    /// The PIDs this book records as routes, whether or not their process still
    /// runs — the kind of the entry, with no liveness witness.
    ///
    /// Exactly one question needs this shape and cannot use [`is_routed`]: the
    /// stale sweep asks whether the entry it is about to drop *was* a route, so
    /// that it can say the executable's render slot came free and resume the
    /// feeds waiting on it. The entry it asks about names a process with no
    /// session right now, so a witnessed answer would come back `no` every time
    /// and no feed would ever resume. Anything else asking "is this routed"
    /// wants [`is_routed`], and nothing else should read this list.
    pub fn routed_pids(&self) -> Vec<u32> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .iter()
            .filter(|(_, route)| route.kind == PinKind::Route)
            .map(|(pid, _)| *pid)
            .collect()
    }

    /// Whether `pid`'s render slot is held by a live device route of ours.
    ///
    /// This is the question a feed asks before writing the carrier over a
    /// program's output. An entry that is not a route is not an answer either:
    /// nothing is being mirrored, and no later `stop_route` will ever resume
    /// what is recorded as waiting for it.
    ///
    /// The entry must also still speak for the process it was written for: a
    /// route whose program exited stays on the book until a sweep reaches it,
    /// and the kernel recycles pids — answering "routed" for a stranger would
    /// suspend every feed set up through that process, with nothing left that
    /// would ever resume it. The bookkeeping itself is left standing either
    /// way; only the answer changes.
    pub fn is_routed(&self, pid: u32) -> bool {
        // Same shape as `exe_routed_elsewhere`: snapshot under the lock,
        // open the process outside of it.
        let entry = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .get(&pid)
                .map(|route| (route.kind, route.exe_name.clone(), route.creation_time))
        };
        entry.is_some_and(|(kind, exe, created)| {
            kind == PinKind::Route && entry_process_is_ours(pid, created, &exe)
        })
    }

    /// Take the pinned PIDs and a copy of the entries, for a sweep that will
    /// decide which of them to put back.
    pub fn snapshot(&self) -> Vec<(u32, String, String)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .iter()
            .map(|(pid, route)| (*pid, route.exe_name.clone(), route.device_id.clone()))
            .collect()
    }

    /// Take every pinned PID, leaving the registry empty. Used on shutdown,
    /// where nothing will retry afterwards.
    pub fn take_all(&self) -> Vec<u32> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut all: Vec<u32> = inner.keys().copied().collect();
        inner.clear();
        drop(inner);
        // Feed pins are ours to hand back too — on shutdown the release walks
        // both data flows anyway, so their PIDs ride the same list. Each book
        // is emptied in turn so no path here ever holds two of them at once.
        for pids in self.take_feed_books() {
            for pid in pids {
                if !all.contains(&pid) {
                    all.push(pid);
                }
            }
        }
        all
    }

    /// Drain both feed books, handing back the PIDs each held. Sources first,
    /// then targets — the order every method here takes them, which is what
    /// keeps the two locks from ever being held at the same time.
    fn take_feed_books(&self) -> [Vec<u32>; 2] {
        fn drain(book: &std::sync::Mutex<std::collections::HashMap<u32, FeedPin>>) -> Vec<u32> {
            let mut book = book.lock().unwrap_or_else(|e| e.into_inner());
            let pids: Vec<u32> = book.keys().copied().collect();
            book.clear();
            pids
        }
        [drain(&self.feed_sources), drain(&self.feed_targets)]
    }

    // ------------------------------------------------------------- feed pins

    /// Record that `pid` is a feed source: its audio is being carried into the
    /// feed carrier, so a removal and a route stop both have a handle on it.
    ///
    /// The endpoint itself is not recorded: the carrier is one configured pair,
    /// and the tap is rebuilt from that configuration whenever the engine that
    /// carries it is restarted.
    pub fn mark_feed(&self, pid: u32, exe_name: &str) {
        let mut book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.insert(pid, FeedPin::new(pid, exe_name));
    }

    /// Record that this app pointed `pid`'s *capture* endpoint at the carrier —
    /// the receiving half of a feed.
    pub fn mark_feed_capture(&self, pid: u32, exe_name: &str) {
        let mut book = self.feed_targets.lock().unwrap_or_else(|e| e.into_inner());
        book.insert(pid, FeedPin::new(pid, exe_name));
    }

    /// The executable name a feed source pin was recorded under, if any.
    pub fn feed_source_exe_of(&self, pid: u32) -> Option<String> {
        let book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.get(&pid).map(|pin| pin.exe_name.clone())
    }

    /// The executable name a feed capture pin was recorded under, if any.
    pub fn feed_capture_exe_of(&self, pid: u32) -> Option<String> {
        let book = self.feed_targets.lock().unwrap_or_else(|e| e.into_inner());
        book.get(&pid).map(|pin| pin.exe_name.clone())
    }

    /// Whether a feed source (render half) pin exists for `pid`.
    pub fn feed_source_of(&self, pid: u32) -> Option<String> {
        self.feed_source_exe_of(pid)
    }

    /// Whether a feed capture pin exists for `pid`.
    pub fn feed_capture_of(&self, pid: u32) -> Option<String> {
        self.feed_capture_exe_of(pid)
    }

    /// Forget a feed source pin.
    pub fn forget_feed_source(&self, pid: u32) {
        let mut book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.remove(&pid);
    }

    /// Forget a feed capture pin.
    pub fn forget_feed_capture(&self, pid: u32) {
        let mut book = self.feed_targets.lock().unwrap_or_else(|e| e.into_inner());
        book.remove(&pid);
    }

    /// Every feed source (render half) pin whose process still runs, as
    /// `(pid, exe_name)`.
    ///
    /// A pin whose program is gone is not offered: its caller writes an endpoint
    /// *through* the pid it names, so a recycled pid would have some other
    /// program pointed at the carrier. The pin itself stays on the book — the
    /// sweep drops it once the process table says so — so nothing is left out
    /// here that a later path still needs.
    pub fn feed_source_pins(&self) -> Vec<(u32, String)> {
        // Judged outside the book lock, like every other liveness question here.
        let candidates: Vec<(u32, u64, String)> = {
            let book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
            book.iter()
                .map(|(pid, pin)| (*pid, pin.creation_time, pin.exe_name.clone()))
                .collect()
        };
        candidates
            .into_iter()
            .filter(|(pid, created, exe)| entry_process_is_ours(*pid, *created, exe))
            .map(|(pid, _, exe)| (pid, exe))
            .collect()
    }

    /// Forget every feed pin whose program is gone. The endpoints those pins
    /// named died with the process, and the rule stays in the feed memory —
    /// that one is the user's, not the process's — so the sweep drops only the
    /// pin.
    ///
    /// "Gone" is the process, not the session list. A program in a long
    /// silence owns no render session at all — a recorder receiving a feed may
    /// never own one — so the session enumeration the sweep already walked is
    /// the wrong witness: dropping on it would strand the assignments the pin
    /// is the only handle to, since `remove_feed_target` refuses to release
    /// without a pin and so would app exit. The process table decides instead,
    /// with the creation time the pin recorded guarding against a recycled pid
    /// (and its executable name standing in when that time was never read).
    pub fn forget_dead_feed_pins(&self) {
        for book in [&self.feed_sources, &self.feed_targets] {
            let mut book = book.lock().unwrap_or_else(|e| e.into_inner());
            book.retain(|pid, pin| entry_process_is_ours(*pid, pin.creation_time, &pin.exe_name));
        }
    }
}

#[cfg(test)]
mod tests;
