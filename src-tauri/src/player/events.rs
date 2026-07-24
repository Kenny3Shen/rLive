//! Native player media lifecycle events (Simple Live mediaError / mediaEnd).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Emitted on the Tauri event bus as `player_event`.
#[derive(Debug, Clone, Serialize)]
pub struct PlayerEvent {
    /// Player lifecycle epoch that owned the media when emitted.
    pub epoch: u64,
    /// Media open generation bound at activate time.
    pub generation: u64,
    /// `playing` | `paused` | `idle` | `eof` | `error`
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PlayerEvent {
    pub fn new(epoch: u64, generation: u64, kind: &str, message: Option<String>) -> Self {
        Self {
            epoch,
            generation,
            kind: kind.to_string(),
            message,
        }
    }
}

struct EventContext {
    app: AppHandle,
    epoch: u64,
    generation: u64,
}

static EVENT_CONTEXT: Mutex<Option<EventContext>> = Mutex::new(None);

/// Bind the active player session so libmpv observer threads can emit tagged events.
pub fn bind_session(app: AppHandle, epoch: u64, generation: u64) {
    if let Ok(mut guard) = EVENT_CONTEXT.lock() {
        *guard = Some(EventContext {
            app,
            epoch,
            generation,
        });
    }
}

/// Update epoch/generation while keeping the existing AppHandle (load / rebind).
pub fn rebind_ids(epoch: u64, generation: u64) {
    if let Ok(mut guard) = EVENT_CONTEXT.lock() {
        if let Some(ctx) = guard.as_mut() {
            ctx.epoch = epoch;
            ctx.generation = generation;
        }
    }
}

pub fn clear_session() {
    if let Ok(mut guard) = EVENT_CONTEXT.lock() {
        *guard = None;
    }
}

/// Emit `player_event` for the currently bound session (no-op if unbound).
pub fn emit(kind: &str, message: Option<String>) {
    let ctx = match EVENT_CONTEXT.lock() {
        Ok(guard) => guard.as_ref().map(|c| {
            (
                c.app.clone(),
                c.epoch,
                c.generation,
            )
        }),
        Err(_) => None,
    };
    let Some((app, epoch, generation)) = ctx else {
        return;
    };
    let _ = app.emit(
        "player_event",
        PlayerEvent::new(epoch, generation, kind, message),
    );
}

/// Emit only if the bound generation still matches (stale observer threads).
pub fn emit_for_generation(generation: u64, kind: &str, message: Option<String>) {
    let ctx = match EVENT_CONTEXT.lock() {
        Ok(guard) => guard.as_ref().and_then(|c| {
            if c.generation == generation {
                Some((c.app.clone(), c.epoch, c.generation))
            } else {
                None
            }
        }),
        Err(_) => None,
    };
    let Some((app, epoch, generation)) = ctx else {
        return;
    };
    let _ = app.emit(
        "player_event",
        PlayerEvent::new(epoch, generation, kind, message),
    );
}
