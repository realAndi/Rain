use std::io::Write;
use std::sync::mpsc::SyncSender;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{Child, MasterPty, PtySize};

use crate::terminal::TerminalState;

/// Shared writer handle so both the Session (keyboard input) and the reader
/// thread (DSR/DA responses) can write to the PTY.
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// A live terminal session tying together the PTY, writer, and terminal state.
pub struct Session {
    /// Master PTY handle for resize operations
    master: Box<dyn MasterPty + Send>,
    /// Child process (shell)
    child: Box<dyn Child + Send + Sync>,
    /// Writer for sending input to the shell
    writer: SharedWriter,
    /// Shared terminal state (accessed by reader thread and IPC commands)
    pub state: Arc<Mutex<TerminalState>>,
    /// Shared run flag for parser/render threads.
    running: Arc<AtomicBool>,
    /// Wake channel for render-pump thread.
    render_waker: Option<SyncSender<()>>,
    /// Parser thread handle
    parser_handle: Option<std::thread::JoinHandle<()>>,
    /// Render-pump thread handle
    render_handle: Option<std::thread::JoinHandle<()>>,
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
            writer: Arc::new(Mutex::new(writer)),
            state,
            running: Arc::new(AtomicBool::new(true)),
            render_waker: None,
            parser_handle: None,
            render_handle: None,
        }
    }

    /// Get a reference to the shared terminal state.
    pub fn state(&self) -> Arc<Mutex<TerminalState>> {
        Arc::clone(&self.state)
    }

    /// Get a clone of the shared writer handle.
    pub fn writer(&self) -> SharedWriter {
        Arc::clone(&self.writer)
    }

    /// Get the shared running flag for PTY worker threads.
    pub fn running(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.running)
    }

    /// Signal render-pump that terminal state may have changed.
    pub fn notify_render(&self) {
        if let Some(waker) = &self.render_waker {
            let _ = waker.try_send(());
        }
    }

    /// Request a full redraw through the render pump.
    pub fn request_full_redraw(&self) {
        let mut ts = self.state.lock();
        if ts.using_alt {
            if let Some(ref mut alt) = ts.alt_grid {
                alt.mark_all_dirty();
            }
        } else {
            ts.grid.mark_all_dirty();
        }
        drop(ts);
        self.notify_render();
    }

    /// Write input bytes to the shell via the PTY.
    pub fn write_input(&self, data: &[u8]) -> Result<(), std::io::Error> {
        let mut writer = self.writer.lock();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    /// Resize the terminal.
    ///
    /// Resizes the internal grid state *before* the PTY so the reader thread
    /// always processes incoming data against the correct dimensions. The PTY
    /// resize delivers SIGWINCH to the child, which may respond immediately.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<(), Box<dyn std::error::Error>> {
        let mut state = self.state.lock();
        state.resize(rows, cols);
        // Resize PTY while holding the lock — parser cannot process bytes
        // from old dimensions against the new grid.
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        drop(state);
        self.notify_render();
        Ok(())
    }

    /// Set parser and render-pump thread handles.
    pub fn set_thread_handles(
        &mut self,
        parser: std::thread::JoinHandle<()>,
        render: std::thread::JoinHandle<()>,
        render_waker: SyncSender<()>,
    ) {
        self.parser_handle = Some(parser);
        self.render_handle = Some(render);
        self.render_waker = Some(render_waker);
    }

    /// Kill the session: terminate the child process.
    pub fn kill(&mut self) {
        self.running.store(false, Ordering::Release);
        self.notify_render();
        let _ = self.child.kill();

        if let Some(handle) = self.parser_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.render_handle.take() {
            let _ = handle.join();
        }
        self.render_waker = None;
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
