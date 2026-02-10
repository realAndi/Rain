pub mod commands;
pub mod events;

use std::collections::HashMap;

use parking_lot::Mutex;

use crate::pty::Session;

/// Application-wide state managed by Tauri.
pub struct AppState {
    pub sessions: Mutex<HashMap<String, Session>>,
    pub pty_manager: crate::pty::PtyManager,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pty_manager: crate::pty::PtyManager::new(),
        }
    }
}
