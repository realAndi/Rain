use std::collections::HashMap;

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::ipc::AppState;
use crate::pty::reader::spawn_pty_threads;

/// Result of creating a new terminal session.
#[derive(serde::Serialize, Clone)]
pub struct CreateSessionResult {
    pub session_id: String,
    /// True when Rain itself is running inside an existing tmux session.
    pub inside_tmux: bool,
}

/// Create a new terminal session. Returns the session ID and env info.
#[tauri::command]
pub fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: Option<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    env: Option<HashMap<String, String>>,
    tmux_mode: Option<String>,
) -> Result<CreateSessionResult, String> {
    let rows = rows.unwrap_or(24);
    let cols = cols.unwrap_or(80);

    let session_id = Uuid::new_v4().to_string();

    let spawn_result = state
        .pty_manager
        .spawn_session(
            shell.as_deref(),
            cwd.as_deref(),
            rows,
            cols,
            env.as_ref(),
            tmux_mode.as_deref(),
        )
        .map_err(|e| format!("Failed to spawn session: {}", e))?;

    let mut session = spawn_result.session;
    let reader = spawn_result.reader;

    // Start parser/render threads (with shared writer for DSR/DA responses)
    let terminal_state = session.state();
    let writer = session.writer();
    let child = session.child();
    let exit_code = session.exit_code();
    let running = session.running();
    let handles = spawn_pty_threads(
        reader,
        terminal_state,
        writer,
        child,
        exit_code,
        app.clone(),
        session_id.clone(),
        running,
    );
    session.set_thread_handles(handles.parser, handles.render_pump, handles.render_waker);

    tracing::info!("Created session {} ({}x{})", &session_id[..8], cols, rows);
    state.sessions.lock().insert(session_id.clone(), session);

    // Detect if Rain is running inside an existing tmux session
    let inside_tmux = std::env::var("TMUX").is_ok();

    Ok(CreateSessionResult {
        session_id,
        inside_tmux,
    })
}

/// Write input bytes to a terminal session (keyboard input).
#[tauri::command]
pub fn write_input(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    session
        .write_input(&data)
        .map_err(|e| format!("Write error: {}", e))
}

/// Lightweight acknowledgment sent after a resize (no line data).
#[derive(serde::Serialize, Clone)]
pub struct ResizeAckPayload {
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
    pub frame_seq: u64,
    pub resize_epoch: u64,
}

/// Resize a terminal session.
///
/// Resizes the grid and PTY, then emits a lightweight `resize-ack` event so the
/// frontend can confirm the new viewport dimensions. No render frame is emitted
/// here -- the reader thread will emit a proper frame when the child process
/// responds to SIGWINCH with actual content changes.
#[tauri::command]
pub fn resize_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    session
        .resize(rows, cols)
        .map_err(|e| format!("Resize error: {}", e))?;

    // Send lightweight ack with new dimensions (no line data).
    // The reader thread handles frame emission when content actually changes.
    let terminal_state = session.state();
    let ts = terminal_state.lock();
    let payload = ResizeAckPayload {
        session_id,
        rows,
        cols,
        frame_seq: ts.frame_seq(),
        resize_epoch: ts.resize_epoch(),
    };
    drop(ts);
    tracing::debug!(
        session = %&payload.session_id[..8],
        rows = payload.rows,
        cols = payload.cols,
        frame_seq = payload.frame_seq,
        resize_epoch = payload.resize_epoch,
        "Emitting resize-ack"
    );
    let _ = app.emit("resize-ack", &payload);

    Ok(())
}

/// Destroy a terminal session.
#[tauri::command]
pub fn destroy_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.session_transfer_state.lock().remove(&session_id);
    let mut sessions = state.sessions.lock();
    if let Some(mut session) = sessions.remove(&session_id) {
        session.kill();
        tracing::info!("Destroyed session {}", &session_id[..8]);
        Ok(())
    } else {
        Err(format!("Session not found: {}", session_id))
    }
}

/// Get the text content of terminal output for a row range.
#[tauri::command]
pub fn get_block_output(
    state: State<'_, AppState>,
    session_id: String,
    start_row: usize,
    end_row: usize,
) -> Result<String, String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let terminal_state = session.state();
    let ts = terminal_state.lock();
    Ok(ts.get_text_range(start_row, end_row))
}

/// Force a full redraw. Marks all visible grid lines as dirty and generates
/// a complete render frame. Used when the frontend connects and needs to
/// catch up with terminal state that was rendered while it wasn't listening.
#[tauri::command]
pub fn request_full_redraw(
    _app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Check regular PTY sessions first
    {
        let sessions = state.sessions.lock();
        if let Some(session) = sessions.get(&session_id) {
            session.request_full_redraw();
            return Ok(());
        }
    }

    // Check tmux pane handles
    {
        let ctrl = state.tmux_controller.lock();
        if let Some(ref controller) = *ctrl {
            let handles = controller.pane_handles.lock();
            if let Some(handle) = handles.get(&session_id) {
                let mut ts = handle.state.lock();
                if ts.using_alt {
                    if let Some(ref mut alt) = ts.alt_grid {
                        alt.mark_all_dirty();
                    }
                } else {
                    ts.grid.mark_all_dirty();
                }
                drop(ts);
                let _ = handle.render_waker.try_send(());
                return Ok(());
            }
        }
    }

    Err(format!("Session not found: {}", session_id))
}
