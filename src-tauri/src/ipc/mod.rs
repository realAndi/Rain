pub mod commands;
pub mod events;

use std::collections::HashMap;
use std::sync::atomic::AtomicU32;

use parking_lot::Mutex;

use crate::pty::Session;
use crate::tmux::TmuxController;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionTransferSpan {
    pub text: String,
    pub fg: serde_json::Value,
    pub bg: serde_json::Value,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionTransferLine {
    pub index: u32,
    pub spans: Vec<SessionTransferSpan>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionTransferSnapshot {
    pub id: String,
    pub command: String,
    pub lines: Vec<SessionTransferLine>,
    pub timestamp: u64,
    pub end_time: Option<u64>,
    pub cwd: String,
    pub failed: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionTransferActiveBlock {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub start_time: u64,
    pub output_start: u64,
    pub tmux_command: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionTransferState {
    pub cwd: String,
    pub shell_integration_active: bool,
    pub snapshots: Vec<SessionTransferSnapshot>,
    pub active_block: Option<SessionTransferActiveBlock>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TabTransferPaneNode {
    #[serde(rename_all = "camelCase")]
    Leaf { session_id: String },
    #[serde(rename_all = "camelCase")]
    Split {
        direction: String,
        ratio: f64,
        first: Box<TabTransferPaneNode>,
        second: Box<TabTransferPaneNode>,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabTransferPaneSession {
    pub session_id: String,
    pub state: SessionTransferState,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabTransferManifest {
    pub label: String,
    pub custom_label: Option<String>,
    pub cwd: String,
    pub pane_tree: TabTransferPaneNode,
    pub active_session_id: String,
    pub pane_sessions: Vec<TabTransferPaneSession>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TabTransferStatus {
    Staged,
    Prepared,
    Committed,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TabTransferEntry {
    pub manifest: TabTransferManifest,
    pub status: TabTransferStatus,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub prepared_for: Option<String>,
    pub ready_token: Option<String>,
}

/// Application-wide state managed by Tauri.
pub struct AppState {
    pub sessions: Mutex<HashMap<String, Session>>,
    pub session_transfer_state: Mutex<HashMap<String, SessionTransferState>>,
    pub tab_transfer_manifests: Mutex<HashMap<String, TabTransferEntry>>,
    pub pty_manager: crate::pty::PtyManager,
    pub tmux_controller: Mutex<Option<TmuxController>>,
    /// Counter for generating unique child window labels.
    pub window_counter: AtomicU32,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            session_transfer_state: Mutex::new(HashMap::new()),
            tab_transfer_manifests: Mutex::new(HashMap::new()),
            pty_manager: crate::pty::PtyManager::new(),
            tmux_controller: Mutex::new(None),
            window_counter: AtomicU32::new(0),
        }
    }
}
