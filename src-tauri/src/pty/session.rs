use std::io::Write;
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{Child, MasterPty, PtySize};

use crate::terminal::TerminalState;

/// A live terminal session tying together the PTY, writer, and terminal state.
pub struct Session {
    /// Master PTY handle for resize operations
    master: Box<dyn MasterPty + Send>,
    /// Child process (shell)
    child: Box<dyn Child + Send + Sync>,
    /// Writer for sending input to the shell
    writer: Mutex<Box<dyn Write + Send>>,
    /// Shared terminal state (accessed by reader thread and IPC commands)
    pub state: Arc<Mutex<TerminalState>>,
    /// Reader thread handle
    reader_handle: Option<std::thread::JoinHandle<()>>,
}

impl Session {
    pub fn new(
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        writer: Box<dyn Write + Send>,
        rows: u16,
        cols: u16,
    ) -> Self {
        let state = Arc::new(Mutex::new(TerminalState::new(rows, cols)));

        Self {
            master,
            child,
            writer: Mutex::new(writer),
            state,
            reader_handle: None,
        }
    }

    /// Get a reference to the shared terminal state.
    pub fn state(&self) -> Arc<Mutex<TerminalState>> {
        Arc::clone(&self.state)
    }

    /// Write input bytes to the shell via the PTY.
    pub fn write_input(&self, data: &[u8]) -> Result<(), std::io::Error> {
        let mut writer = self.writer.lock();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    /// Resize the terminal.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), Box<dyn std::error::Error>> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        self.state.lock().resize(rows, cols);
        Ok(())
    }

    /// Set the reader thread handle.
    pub fn set_reader_handle(&mut self, handle: std::thread::JoinHandle<()>) {
        self.reader_handle = Some(handle);
    }

    /// Kill the session: terminate the child process.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }

    /// Check if the child process has exited.
    #[allow(dead_code)]
    pub fn try_wait(&mut self) -> Option<portable_pty::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}
