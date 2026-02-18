use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{Child, MasterPty, PtySize};

use crate::terminal::TerminalState;

/// Shared writer handle so both the Session (keyboard input) and the reader
/// thread (DSR/DA responses) can write to the PTY.
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Shared slot for the child process exit code. The parser thread writes it
/// when it detects EOF; the render-pump thread reads it when emitting the
/// `session-ended` event.
pub type SharedExitCode = Arc<Mutex<Option<i32>>>;

/// Shared child handle so the parser thread can call `try_wait()` after EOF.
pub type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;

/// A live terminal session tying together the PTY, writer, and terminal state.
pub struct Session {
    /// Master PTY handle for resize operations (Option so it can be dropped before thread join)
    master: Option<Box<dyn MasterPty + Send>>,
    /// Child process (shell)
    child: SharedChild,
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
    /// Temp directory used for shell init files; cleaned up on kill.
    temp_dir: Option<std::path::PathBuf>,
    /// Shared exit code slot written by the parser thread on EOF.
    exit_code: SharedExitCode,
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
            master: Some(master),
            child: Arc::new(Mutex::new(child)),
            writer: Arc::new(Mutex::new(writer)),
            state,
            running: Arc::new(AtomicBool::new(true)),
            render_waker: None,
            parser_handle: None,
            render_handle: None,
            temp_dir: None,
            exit_code: Arc::new(Mutex::new(None)),
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

    /// Get the shared exit code slot for reader/render threads.
    pub fn exit_code(&self) -> SharedExitCode {
        Arc::clone(&self.exit_code)
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
        self.master
            .as_ref()
            .ok_or("PTY master already closed")?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        drop(state);
        self.notify_render();
        Ok(())
    }

    /// Set the temp directory path for shell init files.
    /// Will be deleted (best-effort) when the session is killed.
    pub fn set_temp_dir(&mut self, path: std::path::PathBuf) {
        self.temp_dir = Some(path);
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

    /// Kill the session: gracefully terminate the child process.
    ///
    /// Sends SIGHUP first (via portable-pty `kill()`), waits up to 200ms for
    /// the process to exit, then force-kills with SIGKILL if still alive.
    /// Also attempts to kill the entire process group for thorough cleanup.
    pub fn kill(&mut self) {
        self.running.store(false, Ordering::Release);
        self.notify_render();

        {
            let mut child = self.child.lock();

            // Capture pid before sending any signals
            let pid = child.process_id();

            // Step 1: Send SIGHUP (portable-pty's kill() sends SIGHUP on Unix)
            let _ = child.kill();

            // Step 2: Wait up to 200ms for graceful exit
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
            let mut exited = false;
            while std::time::Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    exited = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }

            // Step 3: Force kill if still alive
            if !exited {
                if let Some(raw_pid) = pid {
                    // Try to kill the entire process group first
                    #[cfg(unix)]
                    {
                        unsafe {
                            // Kill process group (negative pid)
                            libc::kill(-(raw_pid as i32), libc::SIGKILL);
                            // Also kill the process directly in case it changed groups
                            libc::kill(raw_pid as i32, libc::SIGKILL);
                        }
                    }
                }
                // Also try direct kill via wait (which reaps the process)
                let _ = child.try_wait();
            }
        }

        // Close the PTY master fd so the parser thread's read returns EOF
        // and unblocks, preventing indefinite join hangs.
        drop(self.master.take());

        if let Some(handle) = self.parser_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.render_handle.take() {
            let _ = handle.join();
        }
        self.render_waker = None;

        // Best-effort cleanup of temp shell init directory
        if let Some(dir) = self.temp_dir.take() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Check if the child process has exited.
    #[allow(dead_code)]
    pub fn try_wait(&self) -> Option<portable_pty::ExitStatus> {
        self.child.lock().try_wait().ok().flatten()
    }

    /// Get a shared reference to the child process for use by reader threads.
    pub fn child(&self) -> SharedChild {
        Arc::clone(&self.child)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}
