//! Placeholder contract for the local live-caption backend.
//!
//! The previous model implementation and assets were removed ahead of an ASR
//! redesign. The command-facing state types remain so the renderer and Tauri
//! command surface compile without retaining any model runtime dependency.

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

pub const ASR_SAMPLE_RATE_HZ: u32 = 16_000;

#[derive(Debug, Clone, Serialize)]
pub struct AsrModelStatus {
    pub loaded: bool,
    pub loading: bool,
    pub bundled: bool,
    pub path: Option<String>,
    pub active_session_id: Option<String>,
    pub queue_depth: usize,
    pub queue_capacity: usize,
    pub sample_rate_hz: u32,
    pub backend: &'static str,
    pub cpu_only: bool,
    pub speech_gate_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AsrAudioPushResult {
    pub accepted: bool,
    pub dropped_chunks: usize,
    pub queue_depth: usize,
}

/// Dependency-free placeholder retained until the ASR backend is redesigned.
pub struct AsrManager;

impl Default for AsrManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AsrManager {
    pub fn new() -> Self {
        Self
    }

    pub fn model_status(&self) -> AppResult<AsrModelStatus> {
        Ok(unavailable_status())
    }

    pub fn load_default_model(&self) -> AppResult<AsrModelStatus> {
        Err(backend_unavailable())
    }

    pub fn unload_model(&self) -> AppResult<AsrModelStatus> {
        Ok(unavailable_status())
    }

    pub fn start_session(&self, _app: AppHandle, _session_id: String) -> AppResult<AsrModelStatus> {
        Err(backend_unavailable())
    }

    pub fn stop_session(&self, _session_id: &str) -> AppResult<AsrModelStatus> {
        Ok(unavailable_status())
    }

    pub fn push_audio(
        &self,
        _session_id: &str,
        _start_ms: u64,
        _bytes: &[u8],
    ) -> AppResult<AsrAudioPushResult> {
        Ok(AsrAudioPushResult {
            accepted: false,
            dropped_chunks: 0,
            queue_depth: 0,
        })
    }

    pub fn stop_all(&self) {}
}

fn unavailable_status() -> AsrModelStatus {
    AsrModelStatus {
        loaded: false,
        loading: false,
        bundled: false,
        path: None,
        active_session_id: None,
        queue_depth: 0,
        queue_capacity: 0,
        sample_rate_hz: ASR_SAMPLE_RATE_HZ,
        backend: "unavailable",
        cpu_only: false,
        speech_gate_active: false,
    }
}

fn backend_unavailable() -> AppError {
    AppError::new(
        "asr_backend_unavailable",
        "本地字幕后端待重构，当前版本暂不可用",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_status_never_advertises_a_loaded_model() {
        let status = unavailable_status();
        assert!(!status.loaded);
        assert!(!status.loading);
        assert!(!status.bundled);
        assert_eq!(status.backend, "unavailable");
    }
}
