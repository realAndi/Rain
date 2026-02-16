use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::AppState;
use crate::pty::reader::spawn_pty_threads;

/// Set the native window background blur radius on macOS via CoreGraphics SPI.
/// This directly controls the gaussian blur applied to desktop content behind the
/// window, giving pixel-level control over blur intensity. Radius 0 = no blur.
#[tauri::command]
pub fn set_window_blur_radius(app: AppHandle, radius: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or("Failed to get main window")?;

        window
            .with_webview(move |webview| unsafe {
                use objc2_app_kit::NSWindow;

                extern "C" {
                    fn CGSDefaultConnectionForThread() -> i32;
                    fn CGSSetWindowBackgroundBlurRadius(
                        cid: i32,
                        wid: i32,
                        radius: i32,
                    ) -> i32;
                }

                let ns_window_ptr: *mut NSWindow = webview.ns_window().cast();
                if !ns_window_ptr.is_null() {
                    let ns_window = &*ns_window_ptr;
                    let wid = ns_window.windowNumber() as i32;
                    let cid = CGSDefaultConnectionForThread();
                    CGSSetWindowBackgroundBlurRadius(cid, wid, radius as i32);
                }
            })
            .map_err(|e| format!("Failed to set blur radius: {}", e))?;

        tracing::info!("Window blur radius set to {}px", radius);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, radius);
    }

    Ok(())
}

/// Set the native window opacity (alpha value) on macOS.
/// This controls the entire window's transparency at the OS level,
/// making everything (text, UI, background) fade together.
#[tauri::command]
pub fn set_window_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or("Failed to get main window")?;

        let alpha = opacity.clamp(0.0, 1.0);

        window
            .with_webview(move |webview| unsafe {
                use objc2_app_kit::NSWindow;

                let ns_window_ptr: *mut NSWindow = webview.ns_window().cast();
                if !ns_window_ptr.is_null() {
                    let ns_window = &*ns_window_ptr;
                    ns_window.setAlphaValue(alpha);
                }
            })
            .map_err(|e| format!("Failed to set opacity: {}", e))?;

        tracing::info!("Window opacity set to {:.0}%", alpha * 100.0);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, opacity);
    }

    Ok(())
}

/// Set the macOS dock icon at runtime from a bundled resource.
#[tauri::command]
pub fn set_app_icon(app: AppHandle, icon_name: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::AnyThread;
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::{MainThreadMarker, NSString};

        let filename = match icon_name.as_str() {
            "default" => "icons/default-icon.png",
            "simple" => "icons/simple-icon.png",
            _ => return Err(format!("Unknown icon: {}", icon_name)),
        };

        let resource_path = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Resource dir error: {}", e))?
            .join(filename);

        unsafe {
            let mtm = MainThreadMarker::new_unchecked();
            let ns_path = NSString::from_str(resource_path.to_str().unwrap());
            let image = NSImage::initByReferencingFile(NSImage::alloc(), &ns_path);
            NSApplication::sharedApplication(mtm).setApplicationIconImage(image.as_deref());
        }

        tracing::info!("App icon set to '{}'", icon_name);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, icon_name);
    }

    Ok(())
}

/// Get the system hostname.
#[tauri::command]
pub fn get_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "localhost".to_string())
}

/// Create a new terminal session. Returns the session ID.
#[tauri::command]
pub fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: Option<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<String, String> {
    let rows = rows.unwrap_or(24);
    let cols = cols.unwrap_or(80);

    let session_id = Uuid::new_v4().to_string();

    let spawn_result = state
        .pty_manager
        .spawn_session(shell.as_deref(), cwd.as_deref(), rows, cols)
        .map_err(|e| format!("Failed to spawn session: {}", e))?;

    let mut session = spawn_result.session;
    let reader = spawn_result.reader;

    // Start parser/render threads (with shared writer for DSR/DA responses)
    let terminal_state = session.state();
    let writer = session.writer();
    let running = session.running();
    let handles = spawn_pty_threads(
        reader,
        terminal_state,
        writer,
        app.clone(),
        session_id.clone(),
        running,
    );
    session.set_thread_handles(handles.parser, handles.render_pump, handles.render_waker);

    tracing::info!("Created session {} ({}x{})", &session_id[..8], cols, rows);
    state.sessions.lock().insert(session_id.clone(), session);

    Ok(session_id)
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
    use tauri::Emitter;

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
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    session.request_full_redraw();

    Ok(())
}
