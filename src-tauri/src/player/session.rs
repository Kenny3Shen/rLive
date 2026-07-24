//! Pure player session lifecycle (epochs / tombstones / shutdown).
//!
//! No media I/O lives here so unit tests can exercise the shipped types without
//! loading libmpv or spawning processes.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, MutexGuard,
};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Orders native player work independently from asynchronous WebView IPC.
///
/// React cleanup can reach Rust before an already-issued open/fullscreen call.
/// Each room session gets an epoch; closing leaves a tombstone so late work is
/// a no-op.
pub struct PlayerLifecycle {
    inner: Mutex<PlayerLifecycleInner>,
    shutting_down: AtomicBool,
}

#[derive(Default, Debug, Clone)]
pub struct PlayerLifecycleInner {
    pub next_epoch: u64,
    pub closed_through: u64,
    pub active_epoch: Option<u64>,
    /// Media open generation bound to [`Self::active_epoch`] at activate time.
    ///
    /// Leave-room teardown must stop **this** generation, not
    /// `PlayerManager::latest_open_generation()` at close time — a concurrent
    /// `open()` can publish a newer gen before `finalize_open` activates it.
    pub active_generation: Option<u64>,
    pub shutting_down: bool,
}

impl PlayerLifecycleInner {
    pub fn begin(&mut self) -> AppResult<u64> {
        if self.shutting_down {
            return Err(AppError::new(
                "player_shutting_down",
                "cannot start the player while the app is closing",
            ));
        }
        self.next_epoch = self.next_epoch.checked_add(1).ok_or_else(|| {
            AppError::new(
                "player_epoch_exhausted",
                "player lifecycle counter exhausted",
            )
        })?;
        Ok(self.next_epoch)
    }

    pub fn accepts_open(&self, epoch: u64) -> bool {
        !self.shutting_down
            && epoch > self.closed_through
            && self.active_epoch.is_none_or(|active| active <= epoch)
    }

    pub fn accepts_current(&self, epoch: u64) -> bool {
        !self.shutting_down && epoch > self.closed_through && self.active_epoch == Some(epoch)
    }

    /// Bind `epoch` as the active session owning media generation `gen`.
    pub fn activate(&mut self, epoch: u64, gen: u64) {
        self.active_epoch = Some(epoch);
        self.active_generation = Some(gen);
    }

    /// Tombstone `epoch`. If it owned the active session, return the media
    /// generation that was bound at activate (to stop under the engine mutex).
    pub fn close(&mut self, epoch: u64) -> Option<u64> {
        self.closed_through = self.closed_through.max(epoch);
        if self.active_epoch.is_some_and(|active| active <= epoch) {
            self.active_epoch = None;
            return self.active_generation.take();
        }
        None
    }

    /// Tombstone every allocated epoch; return bound media gen if any.
    pub fn force_close(&mut self) -> Option<u64> {
        self.closed_through = self.closed_through.max(self.next_epoch);
        self.active_epoch = None;
        self.active_generation.take()
    }
}

impl Default for PlayerLifecycle {
    fn default() -> Self {
        Self {
            inner: Mutex::new(PlayerLifecycleInner::default()),
            shutting_down: AtomicBool::new(false),
        }
    }
}

impl PlayerLifecycle {
    pub fn lock(&self) -> MutexGuard<'_, PlayerLifecycleInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    /// Non-blocking shutdown gate for CloseRequested / Exit.
    ///
    /// Always sets the atomic first. Epoch bookkeeping is best-effort via
    /// `try_lock` so a command holding the mutex cannot freeze app exit.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        match self.inner.try_lock() {
            Ok(mut lifecycle) => {
                lifecycle.shutting_down = true;
                lifecycle.force_close();
            }
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                let mut lifecycle = poisoned.into_inner();
                lifecycle.shutting_down = true;
                lifecycle.force_close();
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                tracing::warn!(
                    "player lifecycle lock busy during shutdown; atomic tombstone only"
                );
            }
        }
    }

    pub fn debug_snapshot(&self) -> PlayerLifecycleSnapshot {
        let shutting_down = self.is_shutting_down();
        match self.inner.try_lock() {
            Ok(lifecycle) => PlayerLifecycleSnapshot {
                shutting_down_atomic: shutting_down,
                shutting_down_inner: lifecycle.shutting_down,
                next_epoch: lifecycle.next_epoch,
                closed_through: lifecycle.closed_through,
                active_epoch: lifecycle.active_epoch,
                lock: "ok",
            },
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                let lifecycle = poisoned.into_inner();
                PlayerLifecycleSnapshot {
                    shutting_down_atomic: shutting_down,
                    shutting_down_inner: lifecycle.shutting_down,
                    next_epoch: lifecycle.next_epoch,
                    closed_through: lifecycle.closed_through,
                    active_epoch: lifecycle.active_epoch,
                    lock: "poisoned",
                }
            }
            Err(std::sync::TryLockError::WouldBlock) => PlayerLifecycleSnapshot {
                shutting_down_atomic: shutting_down,
                shutting_down_inner: shutting_down,
                next_epoch: 0,
                closed_through: 0,
                active_epoch: None,
                lock: "busy",
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerLifecycleSnapshot {
    pub shutting_down_atomic: bool,
    pub shutting_down_inner: bool,
    pub next_epoch: u64,
    pub closed_through: u64,
    pub active_epoch: Option<u64>,
    pub lock: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn closing_a_session_blocks_its_late_open() {
        let mut lifecycle = PlayerLifecycleInner::default();
        let epoch = lifecycle.begin().unwrap();
        assert!(lifecycle.accepts_open(epoch));
        lifecycle.activate(epoch, 1);
        assert_eq!(lifecycle.close(epoch), Some(1));
        assert!(!lifecycle.accepts_open(epoch));
        assert!(!lifecycle.accepts_current(epoch));
        assert!(lifecycle.active_generation.is_none());
    }

    #[test]
    fn stale_cleanup_cannot_stop_a_newer_player() {
        let mut lifecycle = PlayerLifecycleInner::default();
        let first = lifecycle.begin().unwrap();
        lifecycle.activate(first, 10);
        let second = lifecycle.begin().unwrap();
        lifecycle.activate(second, 20);

        assert_eq!(lifecycle.close(first), None);
        assert_eq!(lifecycle.active_epoch, Some(second));
        assert_eq!(lifecycle.active_generation, Some(20));
        assert!(lifecycle.accepts_current(second));
        assert_eq!(lifecycle.close(second), Some(20));
    }

    #[test]
    fn force_close_allows_the_next_allocated_session_only() {
        let mut lifecycle = PlayerLifecycleInner::default();
        let first = lifecycle.begin().unwrap();
        lifecycle.activate(first, 7);
        assert_eq!(lifecycle.force_close(), Some(7));

        assert!(!lifecycle.accepts_open(first));
        let second = lifecycle.begin().unwrap();
        assert!(lifecycle.accepts_open(second));
    }

    #[test]
    fn close_returns_bound_generation_not_later_global() {
        let mut lifecycle = PlayerLifecycleInner::default();
        let e1 = lifecycle.begin().unwrap();
        // Bound gen 1 to e1 even if a concurrent open later publishes gen 99.
        lifecycle.activate(e1, 1);
        assert_eq!(lifecycle.close(e1), Some(1));
    }

    #[test]
    fn shutdown_recovers_poisoned_lifecycle_mutex() {
        let lifecycle = Arc::new(PlayerLifecycle::default());
        let poisoner = Arc::clone(&lifecycle);
        let _ = thread::spawn(move || {
            let _guard = poisoner.lock();
            panic!("intentional poison for shutdown recovery");
        })
        .join();

        lifecycle.shutdown();
        assert!(lifecycle.is_shutting_down());
        let snap = lifecycle.debug_snapshot();
        assert!(snap.shutting_down_atomic);
        assert!(snap.lock == "ok" || snap.lock == "poisoned");
    }

    #[test]
    fn shutdown_does_not_block_when_lock_is_held() {
        let lifecycle = Arc::new(PlayerLifecycle::default());
        let barrier = Arc::new(Barrier::new(2));
        let holder = Arc::clone(&lifecycle);
        let barrier_holder = Arc::clone(&barrier);
        let thread = thread::spawn(move || {
            let _guard = holder.lock();
            barrier_holder.wait();
            thread::sleep(Duration::from_millis(80));
        });

        barrier.wait();
        let started = Instant::now();
        lifecycle.shutdown();
        assert!(
            started.elapsed() < Duration::from_millis(30),
            "shutdown must return immediately while the mutex is held"
        );
        assert!(lifecycle.is_shutting_down());
        thread.join().unwrap();
    }
}
