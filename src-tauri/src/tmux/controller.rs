use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::pty::reader::{RenderFramePayload, SessionEndPayload};
use crate::terminal::TerminalState;

use super::parser::{self, TmuxNotification};
use super::state::TmuxState;

/// Per-pane terminal state and render infrastructure.
struct PaneState {
    state: Arc<Mutex<TerminalState>>,
    parser: vte::Parser,
    render_waker: SyncSender<()>,
}

/// Manages a tmux control mode connection.
///
/// Spawns `tmux -CC` and translates its structured notifications into
/// per-pane `TerminalState` updates, emitting render frames through the
/// same event pipeline as regular PTY sessions.
/// Shared terminal state + render waker for a tmux pane, accessible from IPC commands.
pub struct TmuxPaneHandle {
    pub state: Arc<Mutex<TerminalState>>,
    pub render_waker: SyncSender<()>,
}

pub struct TmuxController {
    /// PTY master handle (kept alive so the child doesn't get SIGHUP)
    _master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    /// PTY child process
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Writer to tmux's stdin for sending commands.
    writer: Option<Box<dyn Write + Send>>,
    /// Per-pane terminal state keyed by tmux pane ID.
    panes: HashMap<u32, PaneState>,
    /// Shared tmux state (sessions, windows, pane mapping).
    pub tmux_state: Arc<Mutex<TmuxState>>,
    /// Shared map of session_id -> pane handle for IPC access (request_full_redraw etc.)
    pub pane_handles: Arc<Mutex<HashMap<String, TmuxPaneHandle>>>,
    /// Reader thread handle.
    reader_handle: Option<std::thread::JoinHandle<()>>,
    /// Per-pane render pump thread handles.
    render_handles: Vec<std::thread::JoinHandle<()>>,
    /// Shared running flag.
    running: Arc<AtomicBool>,
    /// Tauri app handle for emitting events.
    app_handle: AppHandle,
}

/// Events emitted to the frontend for tmux lifecycle changes.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum TmuxEvent {
    /// tmux session is ready with initial state.
    Started {
        session_name: String,
        panes: Vec<TmuxPaneInfo>,
    },
    /// A pane was added.
    PaneAdded {
        pane_id: u32,
        session_id: String,
        window_id: u32,
    },
    /// A pane was removed.
    PaneRemoved { pane_id: u32, session_id: String },
    /// Window was added.
    WindowAdded { window_id: u32, name: String },
    /// Window was closed.
    WindowClosed {
        window_id: u32,
        removed_sessions: Vec<String>,
    },
    /// Window was renamed.
    WindowRenamed { window_id: u32, name: String },
    /// Layout changed for a window.
    LayoutChanged {
        window_id: u32,
        panes: Vec<TmuxPaneInfo>,
        layout_tree: TmuxLayoutTree,
    },
    /// tmux session was detached.
    Detached,
    /// tmux control mode ended.
    Ended,
}

/// Pane info sent to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TmuxPaneInfo {
    pub pane_id: u32,
    pub session_id: String,
    pub width: u16,
    pub height: u16,
}

/// Serializable layout tree sent to the frontend so it can rebuild its
/// split pane structure to match tmux's actual layout.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum TmuxLayoutTree {
    Leaf {
        pane_id: u32,
        session_id: String,
        width: u16,
        height: u16,
    },
    HSplit {
        children: Vec<TmuxLayoutTree>,
        width: u16,
        height: u16,
    },
    VSplit {
        children: Vec<TmuxLayoutTree>,
        width: u16,
        height: u16,
    },
}

/// Convert a parsed `LayoutNode` into a `TmuxLayoutTree`, attaching session IDs
/// from the tmux state registry.
fn layout_node_to_tree(
    node: &parser::LayoutNode,
    state: &parking_lot::MutexGuard<'_, super::state::TmuxState>,
) -> TmuxLayoutTree {
    match node {
        parser::LayoutNode::Leaf(geo) => {
            let pane_id = geo.pane_id.unwrap_or(0);
            let session_id = state
                .session_for_pane(pane_id)
                .unwrap_or("")
                .to_string();
            TmuxLayoutTree::Leaf {
                pane_id,
                session_id,
                width: geo.width,
                height: geo.height,
            }
        }
        parser::LayoutNode::HSplit {
            width,
            height,
            children,
        } => TmuxLayoutTree::HSplit {
            children: children
                .iter()
                .map(|c| layout_node_to_tree(c, state))
                .collect(),
            width: *width,
            height: *height,
        },
        parser::LayoutNode::VSplit {
            width,
            height,
            children,
        } => TmuxLayoutTree::VSplit {
            children: children
                .iter()
                .map(|c| layout_node_to_tree(c, state))
                .collect(),
            width: *width,
            height: *height,
        },
    }
}

/// Parse a `list-windows` response line:
/// `@<window_id> <window_name> <window_layout>`.
fn parse_window_listing_line(line: &str) -> Option<(u32, String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let first_space = trimmed.find(' ')?;
    let window_part = &trimmed[..first_space];
    let rest = trimmed[first_space + 1..].trim();
    if rest.is_empty() {
        return None;
    }

    let last_space = rest.rfind(' ')?;
    let name = rest[..last_space].trim().to_string();
    let layout = rest[last_space + 1..].trim().to_string();
    if layout.is_empty() {
        return None;
    }

    let window_id = window_part.trim_start_matches('@').parse::<u32>().ok()?;
    Some((window_id, name, layout))
}

/// Process tmux command-response lines from `list-windows`.
fn process_initial_windows_response(
    lines: &[String],
    tmux_state: &Arc<Mutex<TmuxState>>,
    notify_tx: &Sender<ReaderAction>,
) -> bool {
    let mut parsed_any = false;

    for line in lines {
        if let Some((window_id, name, layout)) = parse_window_listing_line(line) {
            parsed_any = true;
            {
                let mut state = tmux_state.lock();
                state.set_window(window_id, name);
            }
            let _ = notify_tx.send(ReaderAction::LayoutChange { window_id, layout });
        }
    }

    if parsed_any {
        let _ = notify_tx.send(ReaderAction::EmitStarted);
    }

    parsed_any
}

impl TmuxController {
    /// Start a new tmux control mode connection.
    ///
    /// `args` is the raw argument string from the user's tmux command
    /// (e.g. "", "new-session", "attach -t main").
    pub fn start(app_handle: AppHandle, args: &str) -> Result<Self, String> {
        let tmux_path = which_tmux().ok_or_else(|| {
            if cfg!(windows) {
                "tmux is not available on this system. Install tmux via MSYS2, Git Bash, or Scoop.".to_string()
            } else {
                "tmux is not installed".to_string()
            }
        })?;

        // tmux -CC needs a real PTY (tty), not piped stdio.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY for tmux: {}", e))?;

        let mut cmd = CommandBuilder::new(&tmux_path);
        cmd.arg("-CC");

        // Parse args to determine subcommand
        let trimmed = args.trim();
        if trimmed.is_empty() {
            cmd.arg("new-session");
        } else {
            for arg in shell_split(trimmed) {
                cmd.arg(arg);
            }
        }

        // Set environment so shells inside tmux get Rain's hooks
        cmd.env("RAIN_TERMINAL", "1");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Rain");

        // Create a shell init directory so shells inside tmux panes load
        // Rain's hooks (prompt suppression, OSC 133/7). This is the same
        // mechanism used by the regular PTY manager in pty/mod.rs.
        let detected_shell = crate::shell::detect::detect_shell();
        let shell_name = crate::shell::detect::shell_name(&detected_shell);
        if let Some(init_cmd) = crate::shell::hooks::shell_init_command(shell_name) {
            cmd.env("RAIN_SHELL_INIT", &init_cmd);

            if shell_name == "zsh" {
                let dir = std::env::temp_dir().join(format!(
                    "rain-tmux-zsh-{}",
                    Uuid::new_v4()
                ));
                let _ = std::fs::create_dir_all(&dir);

                let zshrc = r#"
if [ -n "$RAIN_ORIG_ZDOTDIR" ] && [ -f "$RAIN_ORIG_ZDOTDIR/.zshrc" ]; then
  source "$RAIN_ORIG_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi

if [ -n "$RAIN_SHELL_INIT" ]; then
  eval "$RAIN_SHELL_INIT"
fi
"#;
                let zprofile = r#"
if [ -n "$RAIN_ORIG_ZDOTDIR" ] && [ -f "$RAIN_ORIG_ZDOTDIR/.zprofile" ]; then
  source "$RAIN_ORIG_ZDOTDIR/.zprofile"
elif [ -f "$HOME/.zprofile" ]; then
  source "$HOME/.zprofile"
fi
"#;
                let _ = std::fs::write(dir.join(".zshrc"), zshrc);
                let _ = std::fs::write(dir.join(".zprofile"), zprofile);

                // Preserve the user's original ZDOTDIR so the wrapper can source it
                if let Ok(orig) = std::env::var("ZDOTDIR") {
                    if !orig.is_empty() {
                        cmd.env("RAIN_ORIG_ZDOTDIR", orig);
                    }
                }
                cmd.env("ZDOTDIR", &dir);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn tmux: {}", e))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

        tracing::info!("tmux -CC process spawned in PTY, pid={:?}", child.process_id());

        let running = Arc::new(AtomicBool::new(true));
        let tmux_state = Arc::new(Mutex::new(TmuxState::new()));
        let pane_handles: Arc<Mutex<HashMap<String, TmuxPaneHandle>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let mut controller = Self {
            _master: Some(pair.master),
            child: Some(child),
            writer: Some(Box::new(writer)),
            panes: HashMap::new(),
            tmux_state: Arc::clone(&tmux_state),
            pane_handles: Arc::clone(&pane_handles),
            reader_handle: None,
            render_handles: Vec::new(),
            running: Arc::clone(&running),
            app_handle: app_handle.clone(),
        };

        // Spawn reader thread
        let reader_running = Arc::clone(&running);
        let reader_state = Arc::clone(&tmux_state);
        let reader_app = app_handle.clone();

        // Channel for the reader thread to send notifications that need
        // pane state creation (which must happen on the controller's side).
        let (notify_tx, notify_rx) = std::sync::mpsc::channel::<ReaderAction>();

        let reader_handle = std::thread::Builder::new()
            .name("tmux-reader".to_string())
            .spawn(move || {
                tracing::info!("tmux reader thread started, reading control mode output...");
                let reader = BufReader::new(reader);
                let mut response_block: Option<(u64, Vec<String>)> = None;
                let mut initial_bootstrapped = false;
                for line in reader.lines() {
                    if !reader_running.load(Ordering::Acquire) {
                        break;
                    }
                    let line = match line {
                        Ok(l) => l,
                        Err(e) => {
                            tracing::warn!("tmux reader error: {}", e);
                            break;
                        }
                    };

                    if line.is_empty() {
                        continue;
                    }

                    tracing::info!("tmux-cc raw: {}", &line[..line.len().min(200)]);

                    let notification = parser::parse_notification(&line);
                    match notification {
                        TmuxNotification::Begin { number } => {
                            response_block = Some((number, Vec::new()));
                        }
                        TmuxNotification::End { number } => {
                            if let Some((block_number, lines)) = response_block.take() {
                                if block_number == number && !initial_bootstrapped {
                                    initial_bootstrapped = process_initial_windows_response(
                                        &lines,
                                        &reader_state,
                                        &notify_tx,
                                    );
                                }
                            }
                        }
                        TmuxNotification::Error { .. } => {
                            // Drop any partially buffered response block on command error.
                            response_block = None;
                        }
                        TmuxNotification::Output { pane_id, data } => {
                            let _ = notify_tx.send(ReaderAction::PaneOutput { pane_id, data });
                        }
                        TmuxNotification::LayoutChange {
                            window_id,
                            layout,
                        } => {
                            let _ = notify_tx.send(ReaderAction::LayoutChange {
                                window_id,
                                layout,
                            });
                        }
                        TmuxNotification::WindowAdd { window_id } => {
                            let mut state = reader_state.lock();
                            state.set_window(window_id, format!("window-{}", window_id));
                            drop(state);
                            let _ = reader_app.emit(
                                "tmux-event",
                                &TmuxEvent::WindowAdded {
                                    window_id,
                                    name: format!("window-{}", window_id),
                                },
                            );
                        }
                        TmuxNotification::WindowClose { window_id } => {
                            let mut state = reader_state.lock();
                            let removed = state.remove_window(window_id);
                            drop(state);
                            let _ = reader_app.emit(
                                "tmux-event",
                                &TmuxEvent::WindowClosed {
                                    window_id,
                                    removed_sessions: removed,
                                },
                            );
                        }
                        TmuxNotification::WindowRenamed { window_id, name } => {
                            let mut state = reader_state.lock();
                            state.set_window(window_id, name.clone());
                            drop(state);
                            let _ = reader_app.emit(
                                "tmux-event",
                                &TmuxEvent::WindowRenamed { window_id, name },
                            );
                        }
                        TmuxNotification::SessionChanged { session_id, name } => {
                            let mut state = reader_state.lock();
                            state.session = Some(super::state::TmuxSessionInfo {
                                id: session_id,
                                name: name.clone(),
                            });
                            drop(state);
                        }
                        TmuxNotification::Exit { reason } => {
                            tracing::info!("tmux control mode exited: {}", reason);
                            if reason.contains("detach") {
                                let _ = reader_app.emit("tmux-event", &TmuxEvent::Detached);
                            } else {
                                let _ = reader_app.emit("tmux-event", &TmuxEvent::Ended);
                            }
                            reader_running.store(false, Ordering::Release);
                            break;
                        }
                        TmuxNotification::Unknown(raw) => {
                            if let Some((_, lines)) = response_block.as_mut() {
                                lines.push(raw);
                            } else {
                                tracing::debug!("tmux raw line: {}", raw);
                            }
                        }
                        _ => {
                            tracing::debug!("tmux notification: {:?}", notification);
                        }
                    }
                }

                tracing::info!("tmux reader thread exiting");
                reader_running.store(false, Ordering::Release);
                let _ = reader_app.emit("tmux-event", &TmuxEvent::Ended);
            })
            .map_err(|e| format!("Failed to spawn tmux reader thread: {}", e))?;

        controller.reader_handle = Some(reader_handle);

        // Spawn a processing thread that handles actions from the reader.
        // This creates pane states on demand and feeds output to VTE parsers.
        let proc_running = Arc::clone(&running);
        let proc_state = Arc::clone(&tmux_state);
        let proc_handles = Arc::clone(&pane_handles);
        let proc_app = app_handle;

        let proc_handle = std::thread::Builder::new()
            .name("tmux-processor".to_string())
            .spawn(move || {
                // Per-pane state lives here, owned by this thread.
                let mut pane_states: HashMap<u32, PaneProcessorState> = HashMap::new();

                while proc_running.load(Ordering::Acquire) {
                    let action = match notify_rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(a) => a,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };

                    match action {
                        ReaderAction::PaneOutput { pane_id, data } => {
                            let target_window = {
                                let state = proc_state.lock();
                                state
                                    .window_for_pane(pane_id)
                                    .or(state.active_window)
                                    .unwrap_or(0)
                            };
                            let pstate = pane_states.entry(pane_id).or_insert_with(|| {
                                create_pane_processor(
                                    pane_id,
                                    24,
                                    80,
                                    target_window,
                                    &proc_app,
                                    &proc_state,
                                    &proc_handles,
                                    &proc_running,
                                )
                            });

                            let mut ts = pstate.terminal_state.lock();
                            for &byte in &data {
                                pstate.vte_parser.advance(&mut *ts, byte);
                            }

                            // Flush DSR/DA responses (no writer in control mode,
                            // but keep the queue drained to avoid unbounded growth).
                            let _ = ts.take_pending_responses();
                            drop(ts);

                            // Wake the render pump
                            let _ = pstate.render_waker.try_send(());
                        }
                        ReaderAction::LayoutChange {
                            window_id,
                            layout,
                        } => {
                            if let Some(tree) = parser::parse_layout(&layout) {
                                let geometries = parser::collect_leaf_panes(&tree);

                                // Ensure all panes in the layout have processor state
                                let mut pane_infos = Vec::new();
                                for geo in &geometries {
                                    if let Some(pid) = geo.pane_id {
                                        let pstate =
                                            pane_states.entry(pid).or_insert_with(|| {
                                                create_pane_processor(
                                                    pid,
                                                    geo.height,
                                                    geo.width,
                                                    window_id,
                                                    &proc_app,
                                                    &proc_state,
                                                    &proc_handles,
                                                    &proc_running,
                                                )
                                            });

                                        // Resize if geometry changed
                                        let mut ts = pstate.terminal_state.lock();
                                        // Only resize if dimensions actually differ
                                        if geo.width > 0 && geo.height > 0 {
                                            ts.resize(geo.height, geo.width);
                                        }
                                        drop(ts);

                                        let sid = proc_state
                                            .lock()
                                            .session_for_pane(pid)
                                            .unwrap_or("")
                                            .to_string();

                                        pane_infos.push(TmuxPaneInfo {
                                            pane_id: pid,
                                            session_id: sid,
                                            width: geo.width,
                                            height: geo.height,
                                        });
                                    }
                                }

                                let mut state = proc_state.lock();
                                state.update_layout(window_id, layout, geometries);

                                // Build the full layout tree with session IDs attached
                                let layout_tree = layout_node_to_tree(&tree, &state);
                                drop(state);

                                let _ = proc_app.emit(
                                    "tmux-event",
                                    &TmuxEvent::LayoutChanged {
                                        window_id,
                                        panes: pane_infos,
                                        layout_tree,
                                    },
                                );
                            }
                        }
                        ReaderAction::EmitStarted => {
                            let state = proc_state.lock();
                            let session_name = state
                                .session
                                .as_ref()
                                .map(|s| s.name.clone())
                                .unwrap_or_else(|| "tmux".to_string());
                            let panes = state
                                .windows
                                .values()
                                .flat_map(|window| window.panes.iter())
                                .map(|pane| TmuxPaneInfo {
                                    pane_id: pane.id,
                                    session_id: pane.session_id.clone(),
                                    width: pane.width,
                                    height: pane.height,
                                })
                                .collect::<Vec<_>>();
                            drop(state);

                            let _ = proc_app.emit(
                                "tmux-event",
                                &TmuxEvent::Started { session_name, panes },
                            );
                        }
                    }
                }

                // Drop shared handles first so render threads can exit recv() cleanly.
                proc_handles.lock().clear();
                for (_, mut pane_state) in pane_states.drain() {
                    drop(pane_state.render_waker);
                    if let Some(handle) = pane_state.render_handle.take() {
                        let _ = handle.join();
                    }
                }
            })
            .map_err(|e| format!("Failed to spawn tmux processor thread: {}", e))?;

        controller.render_handles.push(proc_handle);

        // Query initial state: list windows and their layouts
        controller.send_command("list-windows -F '#{window_id} #{window_name} #{window_layout}'")?;

        Ok(controller)
    }

    /// Send a tmux command through the control mode connection.
    pub fn send_command(&mut self, cmd: &str) -> Result<(), String> {
        if let Some(ref mut writer) = self.writer {
            writeln!(writer, "{}", cmd)
                .map_err(|e| format!("Failed to send tmux command: {}", e))?;
            writer
                .flush()
                .map_err(|e| format!("Failed to flush tmux stdin: {}", e))?;
            Ok(())
        } else {
            Err("tmux stdin not available".to_string())
        }
    }

    /// Send keystrokes to a specific pane.
    pub fn send_keys(&mut self, pane_id: u32, data: &[u8]) -> Result<(), String> {
        // Use send-keys with hex encoding for each byte
        let hex_keys: Vec<String> = data.iter().map(|b| format!("0x{:02x}", b)).collect();
        let cmd = format!("send-keys -t %{} {}", pane_id, hex_keys.join(" "));
        self.send_command(&cmd)
    }

    /// Create a new window in the tmux session.
    pub fn new_window(&mut self) -> Result<(), String> {
        self.send_command("new-window")
    }

    /// Split a pane (or active pane if target is None).
    pub fn split_pane(&mut self, horizontal: bool, target_pane: Option<u32>) -> Result<(), String> {
        let axis = if horizontal { "-h" } else { "-v" };
        if let Some(pane_id) = target_pane {
            self.send_command(&format!("split-window {} -t %{}", axis, pane_id))
        } else {
            self.send_command(&format!("split-window {}", axis))
        }
    }

    /// Close a specific pane.
    pub fn close_pane(&mut self, pane_id: u32) -> Result<(), String> {
        self.send_command(&format!("kill-pane -t %{}", pane_id))
    }

    /// Resize a pane to specific dimensions.
    pub fn resize_pane(&mut self, pane_id: u32, width: u16, height: u16) -> Result<(), String> {
        self.send_command(&format!(
            "resize-pane -t %{} -x {} -y {}",
            pane_id, width, height
        ))
    }

    /// Select (focus) a specific pane.
    pub fn select_pane(&mut self, pane_id: u32) -> Result<(), String> {
        self.send_command(&format!("select-pane -t %{}", pane_id))
    }

    /// Detach from the tmux session.
    pub fn detach(&mut self) -> Result<(), String> {
        self.send_command("detach-client")
    }

    /// Check if the controller is still running.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    /// Shut down the controller and clean up.
    pub fn shutdown(&mut self) {
        self.running.store(false, Ordering::Release);

        // Try graceful detach first
        let _ = self.detach();

        // Kill the child process if still alive
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
        }
        self.child = None;
        self.writer = None;
        // Drop the master PTY so the reader thread gets EOF
        self._master = None;
        // Drop shared pane handles so render channels can close.
        self.pane_handles.lock().clear();

        // Join threads
        if let Some(handle) = self.reader_handle.take() {
            let _ = handle.join();
        }
        for handle in self.render_handles.drain(..) {
            let _ = handle.join();
        }

        // Clean up pane states
        let state = self.tmux_state.lock();
        let _sessions = state.all_pane_ids();
        drop(state);
    }
}

impl Drop for TmuxController {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Actions sent from the reader thread to the processor thread.
enum ReaderAction {
    PaneOutput { pane_id: u32, data: Vec<u8> },
    LayoutChange { window_id: u32, layout: String },
    EmitStarted,
}

/// Per-pane state owned by the processor thread.
struct PaneProcessorState {
    terminal_state: Arc<Mutex<TerminalState>>,
    vte_parser: vte::Parser,
    render_waker: SyncSender<()>,
    render_handle: Option<std::thread::JoinHandle<()>>,
}

/// Create a pane processor with its own TerminalState and render pump thread.
fn create_pane_processor(
    pane_id: u32,
    rows: u16,
    cols: u16,
    window_id: u32,
    app: &AppHandle,
    tmux_state: &Arc<Mutex<TmuxState>>,
    pane_handles: &Arc<Mutex<HashMap<String, TmuxPaneHandle>>>,
    running: &Arc<AtomicBool>,
) -> PaneProcessorState {
    let session_id = Uuid::new_v4().to_string();
    let terminal_state = Arc::new(Mutex::new(TerminalState::new(rows, cols)));

    // Register in tmux state
    {
        let mut state = tmux_state.lock();
        state.register_pane(pane_id, session_id.clone(), cols, rows);
    }

    // Emit pane-added event so the frontend can create a store for it
    let _ = app.emit(
        "tmux-event",
        &TmuxEvent::PaneAdded {
            pane_id,
            session_id: session_id.clone(),
            window_id,
        },
    );

    let (render_waker, render_rx) = sync_channel::<()>(1);

    // Store a shared handle so IPC commands (like request_full_redraw) can access this pane
    {
        let mut handles = pane_handles.lock();
        handles.insert(
            session_id.clone(),
            TmuxPaneHandle {
                state: Arc::clone(&terminal_state),
                render_waker: render_waker.clone(),
            },
        );
    }

    // Spawn render pump thread for this pane
    let render_state = Arc::clone(&terminal_state);
    let render_app = app.clone();
    let render_session = session_id;
    let render_running = Arc::clone(running);
    let render_retry_waker = render_waker.clone();

    let render_handle = std::thread::Builder::new()
        .name(format!("tmux-render-{}", pane_id))
        .spawn(move || {
            const FRAME_TICK: Duration = Duration::from_millis(16);
            let mut last_emit = Instant::now() - FRAME_TICK;

            while render_running.load(Ordering::Acquire) {
                if render_rx.recv().is_err() {
                    break;
                }
                if !render_running.load(Ordering::Acquire) {
                    break;
                }

                let elapsed = last_emit.elapsed();
                if elapsed < FRAME_TICK {
                    std::thread::sleep(FRAME_TICK - elapsed);
                }

                // Coalesce bursty notifications
                while render_rx.try_recv().is_ok() {}

                let mut emitted = false;
                if let Some(mut state) = render_state.try_lock() {
                    let snapshot = state.take_render_snapshot();
                    drop(state);
                    if let Some(snapshot) = snapshot {
                        let frame = snapshot.into_frame();
                        let payload = RenderFramePayload {
                            session_id: render_session.clone(),
                            frame,
                        };
                        let _ = render_app.emit("render-frame", &payload);
                        emitted = true;
                    }
                } else {
                    let _ = render_retry_waker.try_send(());
                    continue;
                }

                if emitted {
                    last_emit = Instant::now();
                }
            }

            // Final drain
            let mut state = render_state.lock();
            let snapshot = state.take_render_snapshot();
            drop(state);
            if let Some(snapshot) = snapshot {
                let frame = snapshot.into_frame();
                let payload = RenderFramePayload {
                    session_id: render_session.clone(),
                    frame,
                };
                let _ = render_app.emit("render-frame", &payload);
            }

            let _ = render_app.emit(
                "session-ended",
                &SessionEndPayload {
                    session_id: render_session,
                    exit_code: None,
                },
            );
        })
        .expect("Failed to spawn tmux pane render thread");

    PaneProcessorState {
        terminal_state,
        vte_parser: vte::Parser::new(),
        render_waker,
        render_handle: Some(render_handle),
    }
}

/// Find the tmux binary on the system.
fn which_tmux() -> Option<String> {
    #[cfg(unix)]
    {
        let common_paths = [
            "/opt/homebrew/bin/tmux",
            "/usr/local/bin/tmux",
            "/usr/bin/tmux",
        ];

        for path in &common_paths {
            if std::path::Path::new(path).exists() {
                return Some(path.to_string());
            }
        }

        std::process::Command::new("which")
            .arg("tmux")
            .output()
            .ok()
            .and_then(|out| {
                if out.status.success() {
                    String::from_utf8(out.stdout)
                        .ok()
                        .map(|s| s.trim().to_string())
                } else {
                    None
                }
            })
    }

    #[cfg(windows)]
    {
        // Look for a native tmux.exe (MSYS2, Git Bash, Cygwin, scoop, etc.)
        if let Some(path) = std::process::Command::new("where.exe")
            .arg("tmux")
            .output()
            .ok()
            .and_then(|out| {
                if out.status.success() {
                    String::from_utf8(out.stdout)
                        .ok()
                        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
                        .filter(|s| !s.is_empty())
                } else {
                    None
                }
            })
        {
            return Some(path);
        }

        // tmux requires a Unix PTY layer; native Windows support is rare.
        // WSL has tmux but bridging control-mode across the WSL/Win boundary
        // is not yet supported.
        tracing::debug!("tmux not found on Windows PATH");
        None
    }
}

/// List available tmux sessions.
pub fn list_tmux_sessions() -> Result<Vec<TmuxSessionListing>, String> {
    let tmux_path = which_tmux().ok_or_else(|| {
        if cfg!(windows) {
            "tmux is not available on this system. Install tmux via MSYS2, Git Bash, or Scoop.".to_string()
        } else {
            "tmux is not installed".to_string()
        }
    })?;

    let output = std::process::Command::new(&tmux_path)
        .args(["list-sessions", "-F", "#{session_id}:#{session_name}:#{session_windows}:#{session_attached}"])
        .output()
        .map_err(|e| format!("Failed to run tmux list-sessions: {}", e))?;

    if !output.status.success() {
        // No server running or no sessions
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut sessions = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(4, ':').collect();
        if parts.len() >= 4 {
            sessions.push(TmuxSessionListing {
                id: parts[0].trim_start_matches('$').to_string(),
                name: parts[1].to_string(),
                windows: parts[2].parse().unwrap_or(0),
                attached: parts[3] == "1",
            });
        }
    }

    Ok(sessions)
}

/// A tmux session listing entry.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TmuxSessionListing {
    pub id: String,
    pub name: String,
    pub windows: u32,
    pub attached: bool,
}

/// Basic shell-like argument splitting (handles quotes).
fn shell_split(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut escape_next = false;

    for c in input.chars() {
        if escape_next {
            current.push(c);
            escape_next = false;
            continue;
        }

        match c {
            '\\' if !in_single_quote => escape_next = true,
            '\'' if !in_double_quote => in_single_quote = !in_single_quote,
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            ' ' | '\t' if !in_single_quote && !in_double_quote => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(c),
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_window_listing_line_parses_basic_fields() {
        let parsed = parse_window_listing_line("@1 main 80x24,0,0,0").expect("line should parse");
        assert_eq!(parsed.0, 1);
        assert_eq!(parsed.1, "main");
        assert_eq!(parsed.2, "80x24,0,0,0");
    }

    #[test]
    fn parse_window_listing_line_supports_spaces_in_window_name() {
        let parsed =
            parse_window_listing_line("@12 dev workspace 211x54,0,0,9").expect("line should parse");
        assert_eq!(parsed.0, 12);
        assert_eq!(parsed.1, "dev workspace");
        assert_eq!(parsed.2, "211x54,0,0,9");
    }

    #[test]
    fn process_initial_windows_response_emits_layout_actions_and_started() {
        let tmux_state = Arc::new(Mutex::new(TmuxState::new()));
        let (tx, rx) = std::sync::mpsc::channel::<ReaderAction>();
        let lines = vec![
            "@1 main 80x24,0,0,0".to_string(),
            "@2 build pane 120x40,0,0,1".to_string(),
        ];

        let parsed = process_initial_windows_response(&lines, &tmux_state, &tx);
        assert!(parsed);

        match rx.recv().expect("first action should exist") {
            ReaderAction::LayoutChange { window_id, layout } => {
                assert_eq!(window_id, 1);
                assert_eq!(layout, "80x24,0,0,0");
            }
            _ => panic!("expected first layout-change action"),
        }
        match rx.recv().expect("second action should exist") {
            ReaderAction::LayoutChange { window_id, layout } => {
                assert_eq!(window_id, 2);
                assert_eq!(layout, "120x40,0,0,1");
            }
            _ => panic!("expected second layout-change action"),
        }
        match rx.recv().expect("third action should exist") {
            ReaderAction::EmitStarted => {}
            _ => panic!("expected emit-started action"),
        }

        let state = tmux_state.lock();
        assert_eq!(state.windows.get(&1).map(|w| w.name.as_str()), Some("main"));
        assert_eq!(
            state.windows.get(&2).map(|w| w.name.as_str()),
            Some("build pane")
        );
    }

    #[test]
    fn shell_split_simple_args() {
        assert_eq!(shell_split("new-session"), vec!["new-session"]);
        assert_eq!(
            shell_split("attach -t main"),
            vec!["attach", "-t", "main"]
        );
    }

    #[test]
    fn shell_split_double_quoted() {
        assert_eq!(
            shell_split(r#"new-session -s "my session""#),
            vec!["new-session", "-s", "my session"]
        );
    }

    #[test]
    fn shell_split_single_quoted() {
        assert_eq!(
            shell_split("new-session -s 'my session'"),
            vec!["new-session", "-s", "my session"]
        );
    }

    #[test]
    fn shell_split_escaped_space() {
        assert_eq!(
            shell_split(r"new-session -s my\ session"),
            vec!["new-session", "-s", "my session"]
        );
    }

    #[test]
    fn shell_split_empty_string() {
        let result: Vec<String> = shell_split("");
        assert!(result.is_empty());
    }

    #[test]
    fn shell_split_only_whitespace() {
        let result: Vec<String> = shell_split("   \t  ");
        assert!(result.is_empty());
    }

    #[test]
    fn shell_split_mixed_quotes() {
        assert_eq!(
            shell_split(r#"send-keys -t %0 "hello 'world'""#),
            vec!["send-keys", "-t", "%0", "hello 'world'"]
        );
    }

    #[test]
    fn shell_split_backslash_in_double_quotes() {
        assert_eq!(
            shell_split(r#""path\\to\\file""#),
            vec![r"path\to\file"]
        );
    }

    #[test]
    fn parse_window_listing_line_rejects_empty() {
        assert!(parse_window_listing_line("").is_none());
        assert!(parse_window_listing_line("   ").is_none());
    }

    #[test]
    fn parse_window_listing_line_rejects_missing_layout() {
        assert!(parse_window_listing_line("@1").is_none());
        assert!(parse_window_listing_line("@1 main").is_none());
    }
}
