pub mod detect;
pub mod hooks;

use uuid::Uuid;

use crate::render::TerminalEvent;

/// Tracks shell integration state for command block detection.
/// Receives events from OSC 133 (FinalTerm protocol) sequences.
#[derive(Debug)]
pub struct ShellIntegration {
    /// Whether shell integration hooks are active
    pub active: bool,
    /// Current block ID (if a block is in progress)
    pub current_block_id: Option<String>,
    /// Current working directory
    pub cwd: String,
    /// Pending events to be sent to the frontend
    pending_events: Vec<TerminalEvent>,
}

impl ShellIntegration {
    pub fn new() -> Self {
        Self {
            active: false,
            cwd: String::new(),
            current_block_id: None,
            pending_events: Vec::new(),
        }
    }

    /// Called when OSC 133;A is received (prompt start).
    /// This marks the beginning of a new command block.
    pub fn prompt_start(&mut self, global_row: u64) {
        self.active = true;
        let id = Uuid::new_v4().to_string();
        self.current_block_id = Some(id.clone());
        self.pending_events.push(TerminalEvent::BlockStarted {
            id,
            cwd: self.cwd.clone(),
            global_row,
        });
    }

    /// Called when OSC 133;C is received (command output start).
    /// The command text has been identified and execution begins.
    pub fn command_start(&mut self, command: String, global_row: u64) {
        if let Some(id) = &self.current_block_id {
            self.pending_events.push(TerminalEvent::BlockCommand {
                id: id.clone(),
                command,
                global_row,
            });
        }
    }

    /// Called when OSC 133;D;<exit_code> is received (command finished).
    pub fn command_end(&mut self, exit_code: i32, global_row: u64) {
        if let Some(id) = self.current_block_id.take() {
            self.pending_events.push(TerminalEvent::BlockCompleted {
                id,
                exit_code,
                global_row,
            });
        }
    }

    /// Called when OSC 7 is received (working directory update).
    pub fn set_cwd(&mut self, path: String) {
        self.cwd = path.clone();
        self.pending_events
            .push(TerminalEvent::CwdChanged { path });
    }

    /// Check if there are pending events to send.
    #[allow(dead_code)]
    pub fn has_pending_events(&self) -> bool {
        !self.pending_events.is_empty()
    }

    /// Take all pending events, clearing the internal queue.
    pub fn take_pending_events(&mut self) -> Vec<TerminalEvent> {
        std::mem::take(&mut self.pending_events)
    }
}
