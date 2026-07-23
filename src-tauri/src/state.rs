use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::player::PlayerManager;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub player: PlayerManager,
}

impl AppState {
    pub fn init() -> AppResult<Self> {
        let path = db_path()?;
        let conn = Db::open(&path)?;
        Ok(Self {
            db: Mutex::new(conn),
            player: PlayerManager::new(),
        })
    }

    /// In-memory state for unit tests.
    #[cfg(test)]
    pub fn init_in_memory() -> AppResult<Self> {
        let conn = crate::db::schema::open_in_memory()?;
        Ok(Self {
            db: Mutex::new(conn),
            player: PlayerManager::new(),
        })
    }
}

fn db_path() -> AppResult<PathBuf> {
    if let Some(data_dir) = dirs::data_dir() {
        let dir = data_dir.join("rlive");
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::new("db_io_error", format!("create data dir {}: {e}", dir.display()))
        })?;
        Ok(dir.join("rlive.db"))
    } else {
        // Fallback when platform has no data dir (rare); also useful in constrained envs.
        Ok(PathBuf::from("./rlive.db"))
    }
}
