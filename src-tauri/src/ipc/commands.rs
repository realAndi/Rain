use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::AppState;
use crate::pty::reader::spawn_reader_thread;

/// Toggle macOS vibrancy effect on the main window.
/// When enabled, applies a frosted-glass blur of the desktop behind the window.
/// When disabled, clears vibrancy so the window is purely transparent.
#[tauri::command]
pub fn set_window_vibrancy(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial};

        let window = app
            .get_webview_window("main")
            .ok_or("Failed to get main window")?;

        if enabled {
            // UnderWindowBackground gives the most natural blur of desktop content.
            apply_vibrancy(
                &window,
                NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            )
            .map_err(|e| format!("Failed to apply vibrancy: {}", e))?;

            // Make sure the WKWebView isn't drawing its own opaque background
            // on top of the vibrancy layer.
            window
                .with_webview(|webview| unsafe {
                    let wk: *mut objc2::runtime::AnyObject = webview.inner().cast();
                    if !wk.is_null() {
                        let no = objc2_foundation::NSNumber::new_bool(false);
                        let key = objc2_foundation::NSString::from_str("drawsBackground");
                        let _: () =
                            objc2::msg_send![&*wk, setValue: &*no, forKey: &*key];
                    }
                })
                .ok();

            tracing::info!("Vibrancy enabled (UnderWindowBackground)");
        } else {
            let _ = clear_vibrancy(&window);
            tracing::info!("Vibrancy disabled");
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
    }

    Ok(())
}

/// Set background blur. The macOS NSVisualEffectView does not support a custom
/// blur radius — the blur amount is determined by the system material. This
/// command toggles vibrancy on/off: blur_radius > 0 enables it, 0 disables it.
#[tauri::command]
pub fn set_background_blur(app: AppHandle, blur_radius: u8) -> Result<(), String> {
    set_window_vibrancy(app, blur_radius > 0)
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

    // Start the reader thread
    let terminal_state = session.state();
    let handle = spawn_reader_thread(reader, terminal_state, app.clone(), session_id.clone());
    session.set_reader_handle(handle);

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

/// Resize a terminal session.
#[tauri::command]
pub fn resize_terminal(
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
        .map_err(|e| format!("Resize error: {}", e))
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
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    use tauri::Emitter;

    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let terminal_state = session.state();
    let mut ts = terminal_state.lock();

    // Mark everything dirty
    if ts.using_alt {
        if let Some(ref mut alt) = ts.alt_grid {
            alt.mark_all_dirty();
        }
    } else {
        ts.grid.mark_all_dirty();
    }

    // Generate and emit a full frame
    if let Some(frame) = ts.generate_render_frame() {
        drop(ts); // release lock before IPC
        let payload = crate::pty::reader::RenderFramePayload {
            session_id,
            frame,
        };
        let _ = app.emit("render-frame", &payload);
    }

    Ok(())
}
