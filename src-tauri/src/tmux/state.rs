use std::collections::HashMap;

/// A single tmux pane within a window.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TmuxPane {
    pub id: u32,
    pub width: u16,
    pub height: u16,
    /// The Rain session ID assigned to this pane's terminal state.
    pub session_id: String,
}

/// A tmux window (equivalent to a Rain tab).
#[derive(Debug, Clone, serde::Serialize)]
pub struct TmuxWindow {
    pub id: u32,
    pub name: String,
    pub panes: Vec<TmuxPane>,
    /// Raw tmux layout string for pane geometry reconstruction.
    pub layout: String,
}

/// Full tmux session state as tracked by the controller.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TmuxSessionInfo {
    pub id: u32,
    pub name: String,
}

/// Tracks the full state of a tmux control mode connection.
pub struct TmuxState {
    /// The tmux session we're attached to.
    pub session: Option<TmuxSessionInfo>,
    /// Windows keyed by tmux window ID.
    pub windows: HashMap<u32, TmuxWindow>,
    /// Pane ID -> Rain session ID mapping for output routing.
    pub pane_sessions: HashMap<u32, String>,
    /// Active window ID.
    pub active_window: Option<u32>,
}

impl TmuxState {
    pub fn new() -> Self {
        Self {
            session: None,
            windows: HashMap::new(),
            pane_sessions: HashMap::new(),
            active_window: None,
        }
    }

    /// Register a pane and assign it a Rain session ID.
    pub fn register_pane(&mut self, pane_id: u32, session_id: String, _width: u16, _height: u16) {
        self.pane_sessions.insert(pane_id, session_id.clone());

        // Find the window containing this pane and update it.
        // If not found, it will be added when the window's layout is set.
        for window in self.windows.values_mut() {
            if let Some(pane) = window.panes.iter_mut().find(|p| p.id == pane_id) {
                pane.session_id = session_id;
                return;
            }
        }
    }

    /// Get the Rain session ID for a given tmux pane ID.
    pub fn session_for_pane(&self, pane_id: u32) -> Option<&str> {
        self.pane_sessions.get(&pane_id).map(|s| s.as_str())
    }

    /// Find which window currently owns a pane.
    pub fn window_for_pane(&self, pane_id: u32) -> Option<u32> {
        self.windows.iter().find_map(|(window_id, window)| {
            if window.panes.iter().any(|pane| pane.id == pane_id) {
                Some(*window_id)
            } else {
                None
            }
        })
    }

    /// Add or update a window.
    pub fn set_window(&mut self, id: u32, name: String) {
        self.windows
            .entry(id)
            .and_modify(|w| w.name = name.clone())
            .or_insert_with(|| TmuxWindow {
                id,
                name,
                panes: Vec::new(),
                layout: String::new(),
            });
    }

    /// Remove a window and return its pane session IDs for cleanup.
    pub fn remove_window(&mut self, id: u32) -> Vec<String> {
        let mut removed_sessions = Vec::new();
        if let Some(window) = self.windows.remove(&id) {
            for pane in &window.panes {
                if let Some(sid) = self.pane_sessions.remove(&pane.id) {
                    removed_sessions.push(sid);
                }
            }
        }
        removed_sessions
    }

    /// Update a window's layout and rebuild its pane list from the layout tree.
    pub fn update_layout(
        &mut self,
        window_id: u32,
        layout: String,
        pane_geometries: Vec<super::parser::PaneGeometry>,
    ) {
        self.active_window = Some(window_id);
        let window = self
            .windows
            .entry(window_id)
            .or_insert_with(|| TmuxWindow {
                id: window_id,
                name: format!("window-{}", window_id),
                panes: Vec::new(),
                layout: String::new(),
            });
        window.layout = layout;

        // Reconcile: add new panes, update sizes of existing ones.
        let existing: HashMap<u32, String> = window
            .panes
            .iter()
            .map(|p| (p.id, p.session_id.clone()))
            .collect();

        let mut new_panes = Vec::new();
        for geo in &pane_geometries {
            if let Some(pane_id) = geo.pane_id {
                let session_id = existing
                    .get(&pane_id)
                    .cloned()
                    .or_else(|| self.pane_sessions.get(&pane_id).cloned())
                    .unwrap_or_default();
                new_panes.push(TmuxPane {
                    id: pane_id,
                    width: geo.width,
                    height: geo.height,
                    session_id,
                });
            }
        }

        window.panes = new_panes;
    }

    /// Get all pane IDs that have been registered.
    pub fn all_pane_ids(&self) -> Vec<u32> {
        self.pane_sessions.keys().copied().collect()
    }

    /// Clean up all state. Returns all Rain session IDs for cleanup.
    pub fn clear(&mut self) -> Vec<String> {
        let sessions: Vec<String> = self.pane_sessions.values().cloned().collect();
        self.windows.clear();
        self.pane_sessions.clear();
        self.session = None;
        self.active_window = None;
        sessions
    }
}
